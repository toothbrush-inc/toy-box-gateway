import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra, RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  openVault,
  ProfileBoundsError,
  PROFILE_CONNECTION_ID,
  PROFILE_MAX_FIELDS,
  PROFILE_MAX_FILE_BYTES,
  PROFILE_MAX_VALUE_LENGTH,
  VaultError,
} from "@local/vault";

import { AuditWriter, type AuditEntry } from "./audit.js";
import { ChildManager, type ChildEgress, type TransportFactory } from "./children.js";
import type { CapabilitySpec, GatewayConfig } from "./config.js";
import {
  EgressServer,
  loadEgressSpecs,
  loadGoogleOAuthCreds,
  newEgressToken,
  type GoogleOAuthCreds,
} from "./egress.js";
import { resolveGatewayHome } from "./home.js";
import { evaluatePolicy } from "./policy.js";
import { parsePrefixedName, ToolRegistry } from "./registry.js";
import { redactErrorMessage } from "./redact.js";
import { buildGatewayStatus } from "./status.js";

export const GATEWAY_VERSION = "0.4.0";

type CallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const GATEWAY_STATUS_TOOL: Tool = {
  name: "gateway_status",
  description:
    "Gateway health: mounted capabilities, their tools, policy denials, manifest warnings, and vault grants.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const GATEWAY_RECONNECT_TOOL: Tool = {
  name: "gateway_reconnect",
  description: "Respawn and remount one capability by id after it crashed or was fixed.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string", description: "Capability id from gateway_status" },
    },
    required: ["capability"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const GATEWAY_GET_PROFILE_TOOL: Tool = {
  name: "gateway_get_profile",
  description:
    "The user's profile: small shared facts (units, timezone, ...) capabilities read per-field with grants. Owner view — full, plain values.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const GATEWAY_SET_PROFILE_TOOL: Tool = {
  name: "gateway_set_profile",
  description:
    "Set or delete profile fields (merge semantics). Field names are lowercase tokens; values are short strings. Canonical fields: units (imperial|metric), timezone (IANA), home_lat, home_lon, birthday, locale.",
  inputSchema: {
    type: "object",
    properties: {
      fields: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Fields to set or update",
      },
      delete: {
        type: "array",
        items: { type: "string" },
        description: "Field names to remove",
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** Who is calling, for audit attribution. Populated by the HTTP layer. */
export interface CallIdentity {
  sessionId?: string;
  clientId?: string;
  user?: string;
}

export interface GatewayOptions {
  config: GatewayConfig;
  transportFactory?: TransportFactory;
  audit?: AuditWriter;
  env?: NodeJS.ProcessEnv;
  version?: string;
  log?: (line: string) => void;
}

/** Process-lifetime state: children, registry, audit, egress. One per gateway. */
export interface GatewayCore {
  children: ChildManager;
  audit: AuditWriter;
  egress: EgressServer;
  egressTokenFor(capabilityId: string): string | undefined;
  listTools(): Tool[];
  callTool(
    request: CallToolRequest,
    extra: CallExtra,
    identity: CallIdentity,
  ): Promise<CallToolResult>;
  attachSession(session: GatewaySession): void;
  detachSession(session: GatewaySession): void;
  close(): Promise<void>;
}

/** One MCP connection: a dedicated Server delegating into the shared core. */
export interface GatewaySession {
  server: Server;
  identity: CallIdentity;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Compatibility shape for the stdio path: a core plus exactly one session. */
export interface Gateway {
  server: Server;
  children: ChildManager;
  audit: AuditWriter;
  egress: EgressServer;
  egressTokenFor(capabilityId: string): string | undefined;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(code: string, message: string): CallToolResult {
  const payload = { ok: false, error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

/** Best-effort: pull the typed error code out of a child's {ok:false} result. */
function childErrorCode(result: CallToolResult): string | undefined {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(first.text) as { ok?: unknown; error?: { code?: unknown } };
    if (parsed.ok === false && typeof parsed.error?.code === "string") {
      return parsed.error.code;
    }
  } catch {
    // Not JSON; no code to record.
  }
  return undefined;
}

function identityFields(identity: CallIdentity): Partial<AuditEntry> {
  return {
    ...(identity.sessionId === undefined ? {} : { session_id: identity.sessionId }),
    ...(identity.clientId === undefined ? {} : { client_id: identity.clientId }),
    ...(identity.user === undefined ? {} : { user: identity.user }),
  };
}

export async function createGatewayCore(options: GatewayOptions): Promise<GatewayCore> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const version = options.version ?? GATEWAY_VERSION;
  const config = options.config;
  const specs = new Map<string, CapabilitySpec>(
    config.capabilities.map((capability) => [capability.id, capability]),
  );
  const audit =
    options.audit ??
    new AuditWriter({
      dir: config.audit.dir ?? join(resolveGatewayHome(undefined, env), "audit"),
      maxBytes: config.audit.maxBytes,
      keepFiles: config.audit.keepFiles,
    });
  const registry = new ToolRegistry();
  const sessions = new Set<GatewaySession>();

  const egressSpecs = loadEgressSpecs(config.capabilities, log);
  const tokenByCapability = new Map<string, string>(
    config.capabilities.map((capability) => [capability.id, newEgressToken()]),
  );
  const capabilityByToken = new Map<string, string>(
    [...tokenByCapability].map(([capability, token]) => [token, capability]),
  );
  let oauth: { google: GoogleOAuthCreds } | undefined;
  if (config.oauth?.google !== undefined) {
    oauth = { google: loadGoogleOAuthCreds(config.oauth.google) };
  }
  const egressServer = new EgressServer({
    tokens: capabilityByToken,
    specs: egressSpecs,
    env,
    audit,
    log,
    ...(oauth === undefined ? {} : { oauth }),
    ...(config.commons === undefined ? {} : { commonsDir: config.commons.dir }),
  });
  const egressUrl = await egressServer.listen();

  function rebuild(): void {
    const connected = children
      .list()
      .filter((child) => child.state === "connected")
      .map((child) => ({ id: child.id, tools: child.tools }));
    for (const warning of registry.rebuild(connected, specs)) {
      log(`[gateway] ${warning}`);
    }
  }

  const childOptions: ConstructorParameters<typeof ChildManager>[1] = {
    env,
    log,
    version,
    egressFor: (capabilityId: string): ChildEgress | undefined => {
      const token = tokenByCapability.get(capabilityId);
      return token === undefined ? undefined : { url: egressUrl, token };
    },
    onToolsChanged: () => {
      rebuild();
      for (const session of sessions) {
        void session.server.sendToolListChanged().catch(() => undefined);
      }
    },
  };
  if (options.transportFactory !== undefined) {
    childOptions.transportFactory = options.transportFactory;
  }
  const children = new ChildManager(config.capabilities, childOptions);

  const core: GatewayCore = {
    children,
    audit,
    egress: egressServer,
    egressTokenFor: (capabilityId) => tokenByCapability.get(capabilityId),
    listTools: () => [
      ...registry.listTools(),
      GATEWAY_STATUS_TOOL,
      GATEWAY_RECONNECT_TOOL,
      GATEWAY_GET_PROFILE_TOOL,
      GATEWAY_SET_PROFILE_TOOL,
    ],
    attachSession: (session) => sessions.add(session),
    detachSession: (session) => sessions.delete(session),
    async close(): Promise<void> {
      for (const session of [...sessions]) {
        sessions.delete(session);
        await session.server.close().catch(() => undefined);
      }
      await children.close();
      await egressServer.close();
    },

    async callTool(request, extra, identity): Promise<CallToolResult> {
      const startedAt = Date.now();
      const name = request.params.name;

      const record = (entry: Omit<AuditEntry, "ts" | "duration_ms">): void => {
        audit.record({
          ts: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          ...identityFields(identity),
          ...entry,
        });
      };

      if (request.params.task !== undefined) {
        record({
          capability: parsePrefixedName(name)?.capabilityId ?? "gateway",
          tool: name,
          outcome: "error",
          error_code: "task_not_supported",
        });
        throw new McpError(ErrorCode.InvalidParams, "task-based execution is not supported");
      }

      if (name === GATEWAY_STATUS_TOOL.name) {
        const status = buildGatewayStatus(
          children.list(),
          specs,
          (capabilityId) => registry.deniedTools(capabilityId),
          env,
          (capabilityId) => {
            const entries = egressSpecs.get(capabilityId)?.egress ?? [];
            return {
              enabled: entries.length > 0,
              hosts: [...new Set(entries.flatMap((entry) => entry.hosts))],
            };
          },
          (capabilityId) => {
            const info = egressSpecs.get(capabilityId);
            const declaresProfile =
              info?.connections.some(
                (need) => `${need.provider}:${need.slot}` === PROFILE_CONNECTION_ID,
              ) ?? false;
            let profile: { fields: string[]; granted: string[] } | null = null;
            if (info !== undefined && declaresProfile) {
              let granted: string[] = [];
              try {
                const row = openVault({ env })
                  .listGrants(capabilityId)
                  .find((grant) => grant.connectionId === PROFILE_CONNECTION_ID);
                if (row !== undefined) {
                  granted = info.profileFields.filter(
                    (field) => row.actions.length === 0 || row.actions.includes(field),
                  );
                }
              } catch {
                granted = [];
              }
              profile = { fields: info.profileFields, granted };
            }
            return {
              profile,
              commons: (info?.data?.commons ?? []).map((entry) => entry.dataset),
            };
          },
          config.commons?.dir,
        );
        record({ capability: "gateway", tool: name, outcome: "ok" });
        return jsonResult(status);
      }

      if (name === GATEWAY_GET_PROFILE_TOOL.name) {
        const fields = openVault({ env }).getProfile();
        record({ capability: "gateway", tool: name, outcome: "ok" });
        return jsonResult({
          ok: true,
          data: {
            fields,
            count: Object.keys(fields).length,
            limits: {
              max_fields: PROFILE_MAX_FIELDS,
              max_value_length: PROFILE_MAX_VALUE_LENGTH,
              max_file_bytes: PROFILE_MAX_FILE_BYTES,
            },
          },
        });
      }

      if (name === GATEWAY_SET_PROFILE_TOOL.name) {
        const args = request.params.arguments ?? {};
        const toSet = args["fields"];
        const toDelete = args["delete"];
        const setEntries =
          typeof toSet === "object" && toSet !== null && !Array.isArray(toSet)
            ? Object.entries(toSet).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              )
            : [];
        const deleteNames = Array.isArray(toDelete)
          ? toDelete.filter((field): field is string => typeof field === "string")
          : [];
        if (setEntries.length === 0 && deleteNames.length === 0) {
          record({ capability: "gateway", tool: name, outcome: "error", error_code: "invalid_profile_field" });
          return errorResult("invalid_profile_field", "pass fields to set and/or field names to delete");
        }
        const touched = [...setEntries.map(([field]) => field), ...deleteNames];
        try {
          const vault = openVault({ env });
          if (setEntries.length > 0) {
            vault.putProfile(Object.fromEntries(setEntries));
          }
          for (const field of deleteNames) {
            vault.deleteProfileField(field);
          }
          record({ capability: "gateway", tool: name, outcome: "ok", fields: touched });
          return jsonResult({ ok: true, data: { fields: vault.getProfile() } });
        } catch (error) {
          const code = error instanceof ProfileBoundsError ? "profile_bounds" : "invalid_profile_field";
          const message =
            error instanceof VaultError || error instanceof Error ? error.message : String(error);
          record({ capability: "gateway", tool: name, outcome: "error", error_code: code, fields: touched });
          return errorResult(code, message);
        }
      }

      if (name === GATEWAY_RECONNECT_TOOL.name) {
        const target = request.params.arguments?.["capability"];
        if (typeof target !== "string" || specs.get(target) === undefined) {
          record({ capability: "gateway", tool: name, outcome: "error", error_code: "unknown_capability" });
          return errorResult(
            "unknown_capability",
            `Pass a configured capability id: ${[...specs.keys()].join(", ")}`,
          );
        }
        const mounted = await children.reconnect(target);
        if (mounted.state === "connected") {
          record({ capability: "gateway", tool: name, outcome: "ok" });
          return jsonResult({ ok: true, data: { capability: target, state: mounted.state } });
        }
        record({ capability: "gateway", tool: name, outcome: "error", error_code: "reconnect_failed" });
        return errorResult(
          "reconnect_failed",
          `capability '${target}' failed to reconnect: ${mounted.lastError ?? "unknown error"}`,
        );
      }

      const parsed = parsePrefixedName(name);
      const spec = parsed === null ? undefined : specs.get(parsed.capabilityId);
      if (parsed === null || spec === undefined) {
        record({ capability: parsed?.capabilityId ?? "gateway", tool: name, outcome: "error", error_code: "unknown_tool" });
        return errorResult(
          "unknown_tool",
          `Unknown tool '${name}'. Tools are named <capability>__<tool>; list tools or call gateway_status.`,
        );
      }

      const mounted = children.get(parsed.capabilityId);
      if (mounted === undefined || mounted.state !== "connected" || mounted.client === null) {
        record({ capability: parsed.capabilityId, tool: parsed.toolName, outcome: "error", error_code: "capability_offline" });
        return errorResult(
          "capability_offline",
          `capability '${parsed.capabilityId}' is not connected; call gateway_reconnect with capability=${parsed.capabilityId}`,
        );
      }

      const decision = evaluatePolicy(spec, parsed.toolName);
      if (!decision.allowed) {
        record({
          capability: parsed.capabilityId,
          tool: parsed.toolName,
          outcome: "denied",
          denied_by: "policy",
        });
        return errorResult("denied_by_policy", decision.message);
      }

      const entry = registry.resolve(name);
      if (entry === null) {
        record({ capability: parsed.capabilityId, tool: parsed.toolName, outcome: "error", error_code: "unknown_tool" });
        return errorResult(
          "unknown_tool",
          `capability '${parsed.capabilityId}' has no tool '${parsed.toolName}'`,
        );
      }
      if (entry.tool.execution?.taskSupport === "required") {
        record({ capability: parsed.capabilityId, tool: parsed.toolName, outcome: "error", error_code: "task_not_supported" });
        return errorResult(
          "task_not_supported",
          `tool '${parsed.toolName}' requires task-based execution, which the gateway does not support`,
        );
      }

      const callOptions: RequestOptions = { signal: extra.signal, resetTimeoutOnProgress: true };
      const upstreamToken = extra._meta?.progressToken;
      if (upstreamToken !== undefined) {
        callOptions.onprogress = (progress) => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: { ...progress, progressToken: upstreamToken },
          });
        };
      }

      try {
        const callParams: { name: string; arguments?: Record<string, unknown> } = {
          name: parsed.toolName,
        };
        if (request.params.arguments !== undefined) {
          callParams.arguments = request.params.arguments;
        }
        const result = (await mounted.client.callTool(
          callParams,
          CallToolResultSchema,
          callOptions,
        )) as CallToolResult;
        if (result.isError === true) {
          const code = childErrorCode(result);
          record({
            capability: parsed.capabilityId,
            tool: parsed.toolName,
            outcome: "error",
            ...(code === undefined ? {} : { error_code: code }),
          });
        } else {
          record({ capability: parsed.capabilityId, tool: parsed.toolName, outcome: "ok" });
        }
        return result;
      } catch (error) {
        const message = redactErrorMessage(error instanceof Error ? error.message : String(error));
        record({
          capability: parsed.capabilityId,
          tool: parsed.toolName,
          outcome: "error",
          error_code: "call_failed",
          error: message,
        });
        return errorResult("call_failed", `calling '${name}' failed: ${message}`);
      }
    },
  };

  await children.start();
  rebuild();

  return core;
}

export function createGatewaySession(core: GatewayCore, identity: CallIdentity = {}): GatewaySession {
  const server = new Server(
    { name: "capability-gateway", version: GATEWAY_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Gateway over local capability MCP servers. Tools are namespaced as " +
        "<capability>__<tool>. Results are typed JSON ({ok,data} | {ok:false,error}). " +
        "Use gateway_status for health and gateway_reconnect to revive a crashed capability.",
    },
  );

  const session: GatewaySession = {
    server,
    identity,
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
      core.attachSession(session);
    },
    async close(): Promise<void> {
      core.detachSession(session);
      await server.close();
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: core.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    core.callTool(request, extra, session.identity),
  );

  return session;
}

/** Stdio-compatible wrapper: one core, one session, one close. */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const core = await createGatewayCore(options);
  const session = createGatewaySession(core);
  return {
    server: session.server,
    children: core.children,
    audit: core.audit,
    egress: core.egress,
    egressTokenFor: (capabilityId) => core.egressTokenFor(capabilityId),
    async connect(transport: Transport): Promise<void> {
      await session.connect(transport);
    },
    async close(): Promise<void> {
      await session.close();
      await core.close();
    },
  };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra, RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
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
import {
  ChildManager,
  type ChildEgress,
  type ChildState,
  type TransportFactory,
} from "./children.js";
import { readCapabilityVersion, type CapabilitySpec, type GatewayConfig, type StoreCopy } from "./config.js";
import {
  EgressServer,
  loadEgressSpecs,
  loadGoogleOAuthCreds,
  newEgressToken,
  type GoogleOAuthCreds,
} from "./egress.js";
import { resolveGatewayHome } from "./home.js";
import { CALL_NONCE_META_KEY, CallScopeRegistry } from "./call-scope.js";
import { evaluatePolicy } from "./policy.js";
import { parsePrefixedName, ToolRegistry } from "./registry.js";
import { redactErrorMessage } from "./redact.js";
import { buildGatewayStatus } from "./status.js";
import { resolveStoreEntries, type StoreEntry } from "./store-copy.js";
import { viewUri } from "./views/model.js";
import { renderCardJson } from "./views/render.js";
import { ViewsService } from "./views/service.js";
import {
  LIST_VIEWS_TOOL,
  PIN_VIEW_TOOL,
  PREVIEW_VIEW_TOOL,
  RUN_VIEW_TOOL,
  UNPIN_VIEW_TOOL,
} from "./views/tools.js";

export const GATEWAY_VERSION = "0.7.0";

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

const GATEWAY_GRANT_TOOL: Tool = {
  name: "gateway_grant",
  description:
    "Grant a capability access to a connection (e.g. its declared profile fields). Actions default to what the capability's manifest declares for that connection.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string", description: "Configured capability id" },
      connection: { type: "string", description: "Connection id, e.g. profile:default or purpleair:default" },
      actions: { type: "array", items: { type: "string" }, description: "Override the manifest's declared actions" },
    },
    required: ["capability", "connection"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const GATEWAY_REVOKE_GRANT_TOOL: Tool = {
  name: "gateway_revoke_grant",
  description: "Revoke one capability's grant for one connection. Takes effect on the next call; data is never deleted.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      connection: { type: "string" },
    },
    required: ["capability", "connection"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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

/** A capability as the home index sees it: is it up, and what can it do? */
export interface CapabilitySummary {
  id: string;
  state: ChildState;
  lastError: string | null;
  /** Post-policy: denied tools are absent, as they are from tools/list. */
  tools: { name: string; description: string }[];
  /** Resolved storefront words (manifest `store`, overridden by config `web`). */
  store: StoreCopy;
  /** Where the app's web UI is; absent for an agent-only capability. */
  web?: { path: string };
}

/** Process-lifetime state: children, registry, audit, egress. One per gateway. */
export interface GatewayCore {
  children: ChildManager;
  audit: AuditWriter;
  egress: EgressServer;
  views?: ViewsService;
  egressTokenFor(capabilityId: string): string | undefined;
  listTools(): Tool[];
  /** Mounted capabilities with the tools policy actually exposes — what the
   * home index renders. Deliberately lighter than buildGatewayStatus. */
  listCapabilities(): CapabilitySummary[];
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
  /** view:// URIs this session subscribed to (present when views are enabled). */
  resourceSubscriptions?: ReadonlySet<string>;
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

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
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
  const storeEntries = resolveStoreEntries(config.capabilities, log);
  // Provenance: each capability's self-reported package.json version, read
  // once here and stamped into status and audit rows.
  const versionByCapability = new Map<string, string>();
  for (const capability of config.capabilities) {
    const capabilityVersion = readCapabilityVersion(capability);
    if (capabilityVersion !== null) {
      versionByCapability.set(capability.id, capabilityVersion);
    }
  }
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
  // The single peer-call enforcement seam: producer mounted + tool policy,
  // Resolves a nonce back to its caller; only the broker, in this process,
  // can do so, which is why a capability never holds an identity itself.
  const callScope = new CallScopeRegistry();

  // used by both the broker's POST /call route and the views executor.
  const callPeer = async (
    producer: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number; user?: string },
  ): Promise<CallToolResult> => {
    const producerSpec = specs.get(producer);
    const mounted = children.get(producer);
    if (
      producerSpec === undefined ||
      mounted === undefined ||
      mounted.state !== "connected" ||
      mounted.client === null
    ) {
      throw codedError(`capability '${producer}' is not mounted or not connected`, "call_not_mounted");
    }
    const decision = evaluatePolicy(producerSpec, tool);
    if (!decision.allowed) {
      throw codedError(decision.message, "denied_by_policy");
    }
    const callOptions: RequestOptions = {};
    if (opts?.timeoutMs !== undefined) {
      callOptions.timeout = opts.timeoutMs;
    }
    const peerParams: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    } = { name: tool, arguments: args };
    const peerNonce = callScope.mint(opts?.user);
    if (peerNonce !== undefined) {
      peerParams._meta = { [CALL_NONCE_META_KEY]: peerNonce };
    }
    try {
      return (await mounted.client.callTool(
        peerParams,
        CallToolResultSchema,
        callOptions,
      )) as CallToolResult;
    } finally {
      callScope.release(peerNonce);
    }
  };

  const egressServer = new EgressServer({
    tokens: capabilityByToken,
    specs: egressSpecs,
    env,
    audit,
    log,
    ...(oauth === undefined ? {} : { oauth }),
    ...(config.commons === undefined ? {} : { commonsDir: config.commons.dir }),
    versionOf: (capabilityId) => versionByCapability.get(capabilityId) ?? null,
    resolveCall: (nonce) => callScope.resolve(nonce),
    callPeer,
  });
  const egressUrl = await egressServer.listen();

  let views: ViewsService | undefined;
  if (config.views.enabled) {
    views = new ViewsService({
      dir: config.views.dir ?? join(resolveGatewayHome(undefined, env), "views"),
      config: config.views,
      env,
      audit,
      callPeer,
      versionOf: (capabilityId) => versionByCapability.get(capabilityId) ?? null,
      queryToolsOf: (capabilityId) => egressSpecs.get(capabilityId)?.queryTools,
      isConfigured: (capabilityId) => specs.has(capabilityId),
      ...(config.serve === undefined ? {} : { publicUrl: config.serve.publicUrl }),
      notify: {
        resourceListChanged: () => {
          for (const session of sessions) {
            void session.server.sendResourceListChanged().catch(() => undefined);
          }
        },
        resourceUpdated: (uri) => {
          for (const session of sessions) {
            if (session.resourceSubscriptions?.has(uri) === true) {
              void session.server.sendResourceUpdated({ uri }).catch(() => undefined);
            }
          }
        },
      },
      log,
    });
  }

  function rebuild(): void {
    const connected = children
      .list()
      .filter((child) => child.state === "connected")
      .map((child) => ({ id: child.id, tools: child.tools }));
    for (const warning of registry.rebuild(connected, specs)) {
      log(`[gateway] ${warning}`);
    }
  }

  // Data-dir provisioning: manifests declare their ledgers' env vars; the
  // gateway provisions <dataDir>/<id>/ and injects the paths, so config
  // entries no longer repeat every app env var. spec.env still overrides.
  const provisionedEnv = new Map<string, Record<string, string>>();
  if (config.dataDir !== undefined) {
    for (const [capabilityId, info] of egressSpecs) {
      const ledgers = (info.data?.private ?? []).filter((entry) => entry.env !== undefined);
      if (ledgers.length === 0) {
        continue;
      }
      const dir = join(config.dataDir, capabilityId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      provisionedEnv.set(
        capabilityId,
        Object.fromEntries(
          ledgers.map((entry) => [entry.env, join(dir, entry.file ?? `${entry.name}.json`)]),
        ) as Record<string, string>,
      );
    }
  }

  const childOptions: ConstructorParameters<typeof ChildManager>[1] = {
    env,
    log,
    version,
    extraEnvFor: (capabilityId: string) => provisionedEnv.get(capabilityId),
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
    ...(views === undefined ? {} : { views }),
    egressTokenFor: (capabilityId) => tokenByCapability.get(capabilityId),
    listCapabilities: () => {
      // Tools come from the registry, not the child, so anything hidden by
      // allowTools/denyTools stays hidden here too.
      const byCapability = new Map<string, { name: string; description: string }[]>();
      for (const tool of registry.listTools()) {
        const parsed = parsePrefixedName(tool.name);
        if (parsed === null) {
          continue;
        }
        const list = byCapability.get(parsed.capabilityId) ?? [];
        list.push({ name: parsed.toolName, description: tool.description ?? "" });
        byCapability.set(parsed.capabilityId, list);
      }
      return children.list().map((child) => {
        const entry = storeEntries.get(child.id);
        return {
          id: child.id,
          state: child.state,
          lastError: child.lastError,
          tools: byCapability.get(child.id) ?? [],
          store: entry?.copy ?? { label: child.id },
          ...(entry?.path === undefined ? {} : { web: { path: entry.path } }),
        };
      });
    },
    listTools: () => [
      ...registry.listTools(),
      GATEWAY_STATUS_TOOL,
      GATEWAY_RECONNECT_TOOL,
      GATEWAY_GET_PROFILE_TOOL,
      GATEWAY_SET_PROFILE_TOOL,
      GATEWAY_GRANT_TOOL,
      GATEWAY_REVOKE_GRANT_TOOL,
      ...(views === undefined
        ? []
        : [PREVIEW_VIEW_TOOL, PIN_VIEW_TOOL, RUN_VIEW_TOOL, LIST_VIEWS_TOOL, UNPIN_VIEW_TOOL]),
    ],
    attachSession: (session) => sessions.add(session),
    detachSession: (session) => sessions.delete(session),
    async close(): Promise<void> {
      views?.close();
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
        const version = versionByCapability.get(entry.capability);
        audit.record({
          ts: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          ...identityFields(identity),
          ...(version === undefined ? {} : { capability_version: version }),
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
            const peers = [...(info?.peerCalls ?? new Map<string, string[]>())].map(
              ([producerId, tools]) => {
                let granted = false;
                try {
                  granted = openVault({ env, grantMode: "explicit" }).checkGrant({
                    capability: capabilityId,
                    connectionId: `capability:${producerId}`,
                  });
                } catch {
                  granted = false;
                }
                return { capability: producerId, tools, granted };
              },
            );
            return {
              profile,
              commons: (info?.data?.commons ?? []).map((entry) => entry.dataset),
              peers,
            };
          },
          config.commons?.dir,
          (capabilityId) => versionByCapability.get(capabilityId) ?? null,
          (capabilityId) => storeEntries.get(capabilityId),
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

      if (name === GATEWAY_GRANT_TOOL.name || name === GATEWAY_REVOKE_GRANT_TOOL.name) {
        const args = request.params.arguments ?? {};
        const capability = args["capability"];
        const connection = args["connection"];
        if (
          typeof capability !== "string" ||
          specs.get(capability) === undefined ||
          typeof connection !== "string" ||
          !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/u.test(connection)
        ) {
          record({ capability: "gateway", tool: name, outcome: "error", error_code: "invalid_grant_request" });
          return errorResult(
            "invalid_grant_request",
            `pass a configured capability id (${[...specs.keys()].join(", ")}) and a connection id like profile:default`,
          );
        }
        if (name === GATEWAY_REVOKE_GRANT_TOOL.name) {
          const removed = openVault({ env }).revokeGrant(capability, connection);
          record({ capability: "gateway", tool: name, outcome: "ok", fields: [connection] });
          return jsonResult({ ok: true, data: { capability, connection, revoked: removed } });
        }
        const declared = egressSpecs
          .get(capability)
          ?.connections.find((need) => `${need.provider}:${need.slot}` === connection);
        const rawActions = args["actions"];
        const actions = Array.isArray(rawActions)
          ? rawActions.filter((action): action is string => typeof action === "string")
          : declared?.actions ?? [];
        const grant = openVault({ env }).putGrant({ capability, connectionId: connection, actions });
        record({ capability: "gateway", tool: name, outcome: "ok", fields: [connection] });
        return jsonResult({
          ok: true,
          data: {
            grant: { id: grant.id, capability: grant.capability, connectionId: grant.connectionId, actions: grant.actions },
            ...(declared === undefined
              ? { note: `capability '${capability}' does not declare ${connection} in its manifest; granted anyway` }
              : {}),
          },
        });
      }

      if (
        name === PREVIEW_VIEW_TOOL.name ||
        name === PIN_VIEW_TOOL.name ||
        name === RUN_VIEW_TOOL.name ||
        name === LIST_VIEWS_TOOL.name ||
        name === UNPIN_VIEW_TOOL.name
      ) {
        if (views === undefined) {
          record({ capability: "gateway", tool: name, outcome: "error", error_code: "views_disabled" });
          return errorResult("views_disabled", "views are disabled in the gateway config");
        }
        const viewsService = views;
        const args = request.params.arguments ?? {};

        if (name === LIST_VIEWS_TOOL.name) {
          const list = viewsService.list().map((spec) => {
            const snapshot = viewsService.getSnapshot(spec.id);
            const url = viewsService.urlFor(spec.id);
            return {
              id: spec.id,
              title: spec.title,
              sensitivity: spec.sensitivity,
              refresh: spec.refresh,
              updatedAt: spec.updatedAt,
              lastRun: snapshot?.startedAt ?? null,
              lastOk: snapshot?.ok ?? null,
              ...(url === undefined ? {} : { url }),
            };
          });
          record({ capability: "gateway", tool: name, outcome: "ok" });
          return jsonResult({ ok: true, data: { views: list } });
        }

        if (name === PREVIEW_VIEW_TOOL.name) {
          const result = await viewsService.preview(args["view"]);
          if (!result.ok) {
            record({ capability: "gateway", tool: name, outcome: "error", error_code: result.code });
            return errorResult(result.code, result.message);
          }
          const { preview } = result;
          const url = viewsService.previewUrlFor(preview.token);
          const handle = {
            token: preview.token,
            ...(url === undefined ? {} : { url }),
            expiresAt: preview.expiresAt,
          };
          if (!preview.snapshot.ok) {
            record({
              capability: "gateway",
              tool: name,
              outcome: "error",
              error_code: "preview_failed",
              fields: [preview.spec.id],
            });
            const payload = {
              ok: false,
              error: {
                code: "preview_failed",
                message: "the view's dry run failed; nothing was pinned — fix and preview again",
              },
              ...(preview.snapshot.error === undefined ? {} : { detail: preview.snapshot.error }),
              ...(preview.snapshot.queryErrors === undefined ? {} : { queryErrors: preview.snapshot.queryErrors }),
              preview: handle,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
              isError: true,
            };
          }
          record({ capability: "gateway", tool: name, outcome: "ok", fields: [preview.spec.id] });
          return jsonResult({
            ok: true,
            data: { preview: handle, card: renderCardJson(preview.spec, preview.snapshot) },
          });
        }

        if (name === PIN_VIEW_TOOL.name) {
          const result = await viewsService.pin(args["view"]);
          if (!result.ok) {
            record({ capability: "gateway", tool: name, outcome: "error", error_code: result.code });
            const payload = {
              ok: false,
              error: { code: result.code, message: result.message },
              ...(result.error === undefined ? {} : { detail: result.error }),
              ...(result.queryErrors === undefined ? {} : { queryErrors: result.queryErrors }),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
              isError: true,
            };
          }
          record({ capability: "gateway", tool: name, outcome: "ok", fields: [result.spec.id] });
          const pinnedUrl = viewsService.urlFor(result.spec.id);
          const payload = {
            ok: true,
            data: {
              view: {
                id: result.spec.id,
                title: result.spec.title,
                sensitivity: result.spec.sensitivity,
                refresh: result.spec.refresh,
                updatedAt: result.spec.updatedAt,
                ...(pinnedUrl === undefined ? {} : { url: pinnedUrl }),
              },
              snapshot: result.snapshot,
            },
          };
          return {
            content: [
              { type: "text", text: JSON.stringify(payload) },
              {
                type: "resource_link",
                uri: viewUri(result.spec.id),
                name: result.spec.id,
                title: result.spec.title,
                mimeType: "application/json",
              },
            ],
            structuredContent: payload,
          };
        }

        const id = typeof args["id"] === "string" ? args["id"] : "";

        if (name === UNPIN_VIEW_TOOL.name) {
          if (!viewsService.unpin(id)) {
            record({ capability: "gateway", tool: name, outcome: "error", error_code: "unknown_view" });
            return errorResult("unknown_view", `no pinned view '${id}'; call list_views`);
          }
          record({ capability: "gateway", tool: name, outcome: "ok", fields: [id] });
          return jsonResult({ ok: true, data: { id, unpinned: true } });
        }

        const spec = viewsService.get(id);
        const snapshot =
          spec === undefined
            ? undefined
            : args["refresh"] === true
              ? await viewsService.run(id, { force: true })
              : await viewsService.getFresh(id);
        if (spec === undefined || snapshot === undefined) {
          record({ capability: "gateway", tool: name, outcome: "error", error_code: "unknown_view" });
          return errorResult("unknown_view", `no pinned view '${id}'; call list_views`);
        }
        record({ capability: "gateway", tool: name, outcome: "ok", fields: [id] });
        const payload = { ok: true, data: renderCardJson(spec, snapshot) };
        return {
          content: [
            { type: "text", text: JSON.stringify(payload) },
            {
              type: "resource_link",
              uri: viewUri(id),
              name: id,
              title: spec.title,
              mimeType: "application/json",
            },
          ],
          structuredContent: payload,
        };
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

      const callNonce = callScope.mint(identity.user);
      try {
        const callParams: {
          name: string;
          arguments?: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        } = {
          name: parsed.toolName,
        };
        if (request.params.arguments !== undefined) {
          callParams.arguments = request.params.arguments;
        }
        // Opaque to the child; the broker resolves it back to this caller.
        if (callNonce !== undefined) {
          callParams._meta = { [CALL_NONCE_META_KEY]: callNonce };
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
      } finally {
        callScope.release(callNonce);
      }
    },
  };

  await children.start();
  rebuild();
  views?.init();

  return core;
}

/** The agent's index of what is mounted: one line per app, in the app's own
 * words (manifest `store`, overridden by config), so an assistant can tell a
 * person what is here without calling a tool first. */
export function appIndex(capabilities: readonly CapabilitySummary[]): string {
  if (capabilities.length === 0) {
    return "";
  }
  const lines = capabilities.map((cap) => {
    const tagline = cap.store.tagline === undefined ? "" : `: ${cap.store.tagline}`;
    return `${cap.id} (${cap.store.label})${tagline}`;
  });
  return ` Apps: ${lines.join("; ")}.`;
}

export function createGatewaySession(core: GatewayCore, identity: CallIdentity = {}): GatewaySession {
  const views = core.views;
  const server = new Server(
    { name: "capability-gateway", version: GATEWAY_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        ...(views === undefined ? {} : { resources: { subscribe: true, listChanged: true } }),
      },
      instructions:
        "Gateway over local capability MCP servers. Tools are namespaced as " +
        "<capability>__<tool>. Results are typed JSON ({ok,data} | {ok:false,error}). " +
        "Use gateway_status for health and gateway_reconnect to revive a crashed capability." +
        appIndex(core.listCapabilities()) +
        (views === undefined
          ? ""
          : " Pinned views are served as view://<id> resources; author them with " +
            "preview_view (renders to a short-lived URL, persists nothing) and pin_view " +
            "(dry-run proves before persisting), then run_view/list_views/unpin_view. " +
            "Token thrift for views: check each bound query tool's caps (row/hour limits, payload " +
            "size) before designing a transform; draft the transform in a local file and smoke-test " +
            "it under node:vm with only JSON+Math (1 s budget) before previewing; preview_view/pin_view " +
            "take the whole transform inline and return the full card model, so batch edits, keep " +
            "preview rounds few, and never echo the transform back into the conversation. Edits to a " +
            "capability's source reach this gateway only after that capability is restarted/redeployed."),
    },
  );

  const subscriptions = new Set<string>();
  const session: GatewaySession = {
    server,
    identity,
    ...(views === undefined ? {} : { resourceSubscriptions: subscriptions }),
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

  if (views !== undefined) {
    const RESOURCE_NOT_FOUND = -32002 as ErrorCode;
    const knownUri = (uri: string): boolean =>
      views.list().some((spec) => viewUri(spec.id) === uri);
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: views.listResources(),
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const contents = await views.readResource(request.params.uri);
      if (contents === undefined) {
        throw new McpError(RESOURCE_NOT_FOUND, `resource not found: ${request.params.uri}`);
      }
      return { contents: [contents] };
    });
    server.setRequestHandler(SubscribeRequestSchema, (request) => {
      if (!knownUri(request.params.uri)) {
        throw new McpError(RESOURCE_NOT_FOUND, `resource not found: ${request.params.uri}`);
      }
      subscriptions.add(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      subscriptions.delete(request.params.uri);
      return {};
    });
  }

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

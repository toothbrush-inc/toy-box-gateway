import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { AuditWriter, type AuditEntry } from "./audit.js";
import { ChildManager, type TransportFactory } from "./children.js";
import type { CapabilitySpec, GatewayConfig } from "./config.js";
import { resolveGatewayHome } from "./home.js";
import { evaluatePolicy } from "./policy.js";
import { parsePrefixedName, ToolRegistry } from "./registry.js";
import { redactErrorMessage } from "./redact.js";
import { buildGatewayStatus } from "./status.js";

export const GATEWAY_VERSION = "0.1.0";

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

export interface GatewayOptions {
  config: GatewayConfig;
  transportFactory?: TransportFactory;
  audit?: AuditWriter;
  env?: NodeJS.ProcessEnv;
  version?: string;
  log?: (line: string) => void;
}

export interface Gateway {
  server: Server;
  children: ChildManager;
  audit: AuditWriter;
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

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
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
  let upstreamConnected = false;

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
    onToolsChanged: () => {
      rebuild();
      if (upstreamConnected) {
        void server.sendToolListChanged();
      }
    },
  };
  if (options.transportFactory !== undefined) {
    childOptions.transportFactory = options.transportFactory;
  }
  const children = new ChildManager(config.capabilities, childOptions);

  const server = new Server(
    { name: "capability-gateway", version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Gateway over local capability MCP servers. Tools are namespaced as " +
        "<capability>__<tool>. Results are typed JSON ({ok,data} | {ok:false,error}). " +
        "Use gateway_status for health and gateway_reconnect to revive a crashed capability.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...registry.listTools(), GATEWAY_STATUS_TOOL, GATEWAY_RECONNECT_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const startedAt = Date.now();
    const name = request.params.name;

    const record = (entry: Omit<AuditEntry, "ts" | "duration_ms">): void => {
      audit.record({
        ts: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
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
      );
      record({ capability: "gateway", tool: name, outcome: "ok" });
      return jsonResult(status);
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
  });

  await children.start();
  rebuild();

  return {
    server,
    children,
    audit,
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
      upstreamConnected = true;
    },
    async close(): Promise<void> {
      upstreamConnected = false;
      await children.close();
      await server.close();
    },
  };
}

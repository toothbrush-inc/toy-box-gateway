// Executes one view: bound queries through the peer-call enforcement path
// (per-tool grants as consumer `view-<id>` — or `preview-<id>` for a
// preview — producer policy via callPeer), then the sandboxed transform, then
// CardModel validation. Every query is audited like a /call row; snapshots
// carry per-query provenance.

import type { AuditWriter } from "../audit.js";
import type { PeerToolResult } from "../egress.js";
import { redactErrorMessage } from "../redact.js";
import { parsePrefixedName } from "../registry.js";
import {
  CardModelSchema,
  viewCapabilityId,
  type QueryProvenance,
  type ViewSnapshot,
  type ViewSpec,
} from "./model.js";
import { runTransform, TransformError } from "./sandbox.js";

export type CallPeerFn = (
  producer: string,
  tool: string,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<PeerToolResult>;

export interface ExecutorDeps {
  checkGrant: (viewCapability: string, producer: string, tool: string) => boolean;
  callPeer: CallPeerFn;
  versionOf: (capabilityId: string) => string | null;
  audit: AuditWriter;
}

export interface ExecutorOptions {
  queryTimeoutMs: number;
  transformTimeoutMs: number;
  /** Identity to run as — passed to checkGrant and stamped on audit rows.
   * Defaults to the view's grant-consumer id `view-<id>`. */
  consumer?: string;
}

export async function executeView(
  spec: ViewSpec,
  deps: ExecutorDeps,
  options: ExecutorOptions,
): Promise<ViewSnapshot> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const viewCap = options.consumer ?? viewCapabilityId(spec.id);
  const input: Record<string, unknown> = {};
  const provenance: QueryProvenance[] = [];

  const finish = (partial: Omit<ViewSnapshot, "viewId" | "startedAt" | "durationMs">): ViewSnapshot => ({
    viewId: spec.id,
    startedAt,
    durationMs: Date.now() - startedMs,
    ...partial,
  });

  for (const query of spec.queries) {
    const parsed = parsePrefixedName(query.tool);
    if (parsed === null) {
      return finish({
        ok: false,
        error: { kind: "query", message: `query '${query.key}' has an unparseable tool name` },
      });
    }
    const { capabilityId: producer, toolName } = parsed;
    const queryStarted = Date.now();
    const record = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      const producerVersion = deps.versionOf(producer);
      deps.audit.record({
        ts: new Date().toISOString(),
        capability: viewCap,
        tool: `call:${producer}__${toolName}`,
        outcome,
        duration_ms: Date.now() - queryStarted,
        user: spec.owner,
        target: producer,
        ...(producerVersion === null ? {} : { target_version: producerVersion }),
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
      });
    };
    const failQuery = (
      outcome: "denied" | "error",
      code: string,
      message: string,
    ): ViewSnapshot => {
      record(outcome, code);
      return finish({
        ok: false,
        error: { kind: "query", message: `query '${query.key}' failed: ${message}` },
        queryErrors: { [query.key]: { code, message } },
        ...(provenance.length === 0 ? {} : { provenance }),
      });
    };

    if (!deps.checkGrant(viewCap, producer, toolName)) {
      return failQuery(
        "denied",
        "grant_missing",
        `view '${spec.id}' has no grant for capability:${producer} (tool ${toolName}); re-pin the view to re-consent`,
      );
    }
    let result: PeerToolResult;
    try {
      result = await deps.callPeer(producer, toolName, query.arguments, {
        timeoutMs: options.queryTimeoutMs,
      });
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code;
      return failQuery(
        "error",
        typeof rawCode === "string" ? rawCode : "call_failed",
        redactErrorMessage(error instanceof Error ? error.message : String(error)),
      );
    }
    const payload = extractPayload(result);
    if (result.isError === true) {
      const envelope = payload as { error?: { code?: unknown; message?: unknown } } | null;
      const code =
        typeof envelope?.error?.code === "string" ? envelope.error.code : "peer_error";
      const message =
        typeof envelope?.error?.message === "string"
          ? redactErrorMessage(envelope.error.message)
          : "producer tool returned an error";
      return failQuery("error", code, message);
    }
    if (payload === null) {
      return failQuery("error", "untyped_result", "producer tool returned no typed payload");
    }
    record("ok");
    input[query.key] = payload;
    provenance.push({
      key: query.key,
      capability: producer,
      version: deps.versionOf(producer),
      ts: new Date().toISOString(),
    });
  }

  let transformed: unknown;
  try {
    transformed = runTransform(spec.transform, input, options.transformTimeoutMs);
  } catch (error) {
    const message =
      error instanceof TransformError
        ? `${error.kind}: ${error.message}`
        : redactErrorMessage(error instanceof Error ? error.message : String(error));
    return finish({ ok: false, error: { kind: "transform", message }, provenance });
  }

  const model = CardModelSchema.safeParse(transformed);
  if (!model.success) {
    const issues = model.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return finish({
      ok: false,
      error: { kind: "model", message: `transform output is not a valid CardModel: ${issues}` },
      provenance,
    });
  }

  return finish({ ok: true, model: model.data, provenance });
}

function extractPayload(result: PeerToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return null;
    }
  }
  return null;
}

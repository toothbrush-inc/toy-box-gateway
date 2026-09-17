// The views orchestrator: pin = compile + prove (dry-run before persist),
// preview = compile + prove, persist nothing (a short-lived URL instead),
// refresh = scheduler + refresh-on-read backstop, serve = snapshots only.
// Each pinned view consumes producers as grant-consumer `view-<id>` through
// the peer-call machinery; pinning writes the grants (the pin IS the
// consent), unpinning revokes them. A preview runs once as `preview-<id>`
// under an in-memory allow-set derived from the very spec it was asked to
// render (the same declared-query-tool check a pin passes) — the
// authenticated call is the consent and there is nothing to revoke after.

import { openVault, type GrantRecord } from "@dvd-toy-box/vault";

import type { AuditWriter } from "../audit.js";
import type { ViewsConfig } from "../config.js";
import { parsePrefixedName } from "../registry.js";
import { executeView, type CallPeerFn, type ExecutorDeps } from "./executor.js";
import {
  previewCapabilityId,
  previewPath,
  viewCapabilityId,
  viewPath,
  ViewSpecInputSchema,
  viewUri,
  type ViewSnapshot,
  type ViewSpec,
  type ViewSpecInput,
} from "./model.js";
import { PreviewStore, type ViewPreview } from "./previews.js";
import { renderCardJson } from "./render.js";
import { ViewScheduler } from "./scheduler.js";
import { ViewStore } from "./store.js";

export interface ViewNotifier {
  resourceUpdated(uri: string): void;
  resourceListChanged(): void;
}

export interface ViewResource {
  uri: string;
  name: string;
  title: string;
  description?: string;
  mimeType: "application/json";
  annotations?: { audience: ("user" | "assistant")[]; lastModified?: string };
}

export type PinResult =
  | { ok: true; spec: ViewSpec; snapshot: ViewSnapshot }
  | {
      ok: false;
      code: string;
      message: string;
      error?: ViewSnapshot["error"];
      queryErrors?: ViewSnapshot["queryErrors"];
    };

/** A preview either compiles and runs (the snapshot may still be a failed
 * render — that is what the preview shows) or is refused before running. */
export type PreviewResult =
  | { ok: true; preview: ViewPreview }
  | { ok: false; code: string; message: string };

/** A parsed spec with its owner settled (see `compile`). */
type CompiledSpec = Omit<ViewSpecInput, "owner"> & { owner: string };

type CompileResult =
  | { ok: true; spec: CompiledSpec; toolsByProducer: Map<string, Set<string>> }
  | { ok: false; code: string; message: string };

type ExecutionMode =
  | { kind: "pinned" }
  | { kind: "preview"; allowed: ReadonlyMap<string, ReadonlySet<string>> };

const MAX_LIVE_PREVIEWS = 32;

export interface ViewsServiceOptions {
  dir: string;
  config: ViewsConfig;
  env: NodeJS.ProcessEnv;
  audit: AuditWriter;
  callPeer: CallPeerFn;
  versionOf: (capabilityId: string) => string | null;
  /** The producer's manifest tools.query list (undefined = none declared). */
  queryToolsOf: (producerId: string) => string[] | undefined;
  isConfigured: (producerId: string) => boolean;
  notify: ViewNotifier;
  log: (line: string) => void;
  /** The serve surface's public origin; when set, tool results carry browser URLs. */
  publicUrl?: string;
}

export class ViewsService {
  private readonly store: ViewStore;
  private readonly previews: PreviewStore;
  private readonly scheduler: ViewScheduler;
  private readonly pinning = new Set<string>();
  private readonly inflight = new Map<string, Promise<ViewSnapshot>>();
  private readonly publicUrl: string | undefined;

  constructor(private readonly options: ViewsServiceOptions) {
    this.store = new ViewStore(options.dir, options.log);
    this.previews = new PreviewStore({ ttlMs: options.config.previewTtlMs, max: MAX_LIVE_PREVIEWS });
    this.scheduler = new ViewScheduler(async (id) => {
      await this.run(id, { force: true });
    }, options.log);
    this.publicUrl = options.publicUrl?.replace(/\/+$/u, "");
  }

  init(): void {
    for (const spec of this.store.list()) {
      if (spec.refresh.intervalMs !== null) {
        this.scheduler.start(spec.id, spec.refresh.intervalMs);
      }
    }
  }

  list(actor?: string): ViewSpec[] {
    return this.store.list().filter((spec) => this.canRead(spec, actor));
  }

  canRead(spec: ViewSpec, actor?: string): boolean {
    return actor === undefined || spec.owner === actor || spec.sensitivity === "shareable";
  }

  get(id: string, actor?: string): ViewSpec | undefined {
    const spec = this.store.get(id);
    return spec !== undefined && this.canRead(spec, actor) ? spec : undefined;
  }

  getSnapshot(id: string): ViewSnapshot | undefined {
    return this.store.getSnapshot(id);
  }

  /** Browser URL of a pinned view (undefined when not serving HTTP). */
  urlFor(id: string): string | undefined {
    return this.publicUrl === undefined ? undefined : `${this.publicUrl}${viewPath(id)}`;
  }

  /** Browser URL of a live preview (undefined when not serving HTTP). */
  previewUrlFor(token: string): string | undefined {
    return this.publicUrl === undefined ? undefined : `${this.publicUrl}${previewPath(token)}`;
  }

  /** `actor` is the signed-in caller when there is one; it becomes the
   * view's owner regardless of what the input says. */
  async pin(input: unknown, actor?: string): Promise<PinResult> {
    const compiled = this.compile(input, actor);
    if (!compiled.ok) {
      return compiled;
    }
    const { spec } = compiled;
    if (this.pinning.has(spec.id)) return { ok: false, code: "view_busy", message: "view is being updated; retry" };
    this.pinning.add(spec.id);
    try { return await this.pinCompiled(compiled, actor); }
    finally { this.pinning.delete(spec.id); }
  }

  private async pinCompiled(compiled: Extract<CompileResult, { ok: true }>, actor?: string): Promise<PinResult> {
    const { spec, toolsByProducer } = compiled;
    const existing = this.store.get(spec.id);
    if (existing !== undefined && actor !== undefined && existing.owner !== actor) {
      return { ok: false, code: "view_forbidden", message: "only the owner may replace this view" };
    }
    if (existing === undefined && this.store.list().length >= this.options.config.maxViews) {
      return {
        ok: false,
        code: "too_many_views",
        message: `the gateway caps pinned views at ${String(this.options.config.maxViews)}; unpin one first`,
      };
    }

    // Grants: the pin is the consent act. Swap old grants for new; restore on
    // dry-run refusal so a failed pin leaves no residue.
    const viewCap = viewCapabilityId(spec.id);
    const vault = openVault({ env: this.options.env });
    const previous: GrantRecord[] = vault.listGrants(viewCap);
    for (const grant of previous) {
      vault.revokeGrant(viewCap, grant.connectionId);
    }
    for (const [producer, tools] of toolsByProducer) {
      vault.putGrant({
        capability: viewCap,
        connectionId: `capability:${producer}`,
        actions: [...tools],
      });
    }

    const full = this.stamp(spec, existing);
    const snapshot = await this.execute(full, { kind: "pinned" });
    if (!snapshot.ok) {
      for (const [producer] of toolsByProducer) {
        vault.revokeGrant(viewCap, `capability:${producer}`);
      }
      for (const grant of previous) {
        vault.putGrant({
          capability: viewCap,
          connectionId: grant.connectionId,
          actions: grant.actions,
        });
      }
      return {
        ok: false,
        code: "pin_failed",
        message: "the view's dry run failed; nothing was pinned — fix and re-pin",
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(snapshot.queryErrors === undefined ? {} : { queryErrors: snapshot.queryErrors }),
      };
    }

    this.store.put(full);
    this.store.putSnapshot(snapshot);
    if (full.refresh.intervalMs !== null) {
      this.scheduler.start(full.id, full.refresh.intervalMs);
    } else {
      this.scheduler.stop(full.id);
    }
    this.options.notify.resourceListChanged();
    this.options.notify.resourceUpdated(viewUri(full.id));
    return { ok: true, spec: full, snapshot };
  }

  /** Compile + run once, persist nothing: the result lives at a token for
   * `previewTtlMs`. The same input pins unchanged. */
  async preview(input: unknown, actor?: string): Promise<PreviewResult> {
    const compiled = this.compile(input, actor);
    if (!compiled.ok) {
      return compiled;
    }
    const full = this.stamp(compiled.spec, this.store.get(compiled.spec.id));
    const snapshot = await this.execute(full, { kind: "preview", allowed: compiled.toolsByProducer });
    return { ok: true, preview: this.previews.put(full, snapshot) };
  }

  /** A live preview by token (undefined once expired or never issued). */
  getPreview(token: string, actor?: string): ViewPreview | undefined {
    const preview = this.previews.get(token);
    return preview !== undefined && this.canRead(preview.spec, actor) ? preview : undefined;
  }

  unpin(id: string, actor?: string): boolean {
    const spec = this.store.get(id);
    if (this.pinning.has(id) || (actor !== undefined && spec?.owner !== actor)) return false;
    this.scheduler.stop(id);
    const existed = this.store.delete(id);
    if (existed) {
      const viewCap = viewCapabilityId(id);
      const vault = openVault({ env: this.options.env });
      for (const grant of vault.listGrants(viewCap)) {
        vault.revokeGrant(viewCap, grant.connectionId);
      }
      this.options.notify.resourceListChanged();
    }
    return existed;
  }

  /** Single-flight execution; persists the snapshot and notifies subscribers. */
  async run(id: string, opts: { force?: boolean } = {}): Promise<ViewSnapshot | undefined> {
    const spec = this.store.get(id);
    if (spec === undefined) {
      return undefined;
    }
    if (opts.force !== true) {
      return this.getFresh(id);
    }
    const running = this.inflight.get(id);
    if (running !== undefined) {
      return running;
    }
    const promise = this.execute(spec, { kind: "pinned" })
      .then((snapshot) => {
        this.store.putSnapshot(snapshot);
        this.options.notify.resourceUpdated(viewUri(id));
        return snapshot;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  /** Refresh-on-read backstop: serve the snapshot unless missing or stale. */
  async getFresh(id: string): Promise<ViewSnapshot | undefined> {
    const spec = this.store.get(id);
    if (spec === undefined) {
      return undefined;
    }
    const snapshot = this.store.getSnapshot(id);
    const stale =
      snapshot === undefined ||
      (spec.refresh.intervalMs !== null &&
        Date.now() - Date.parse(snapshot.startedAt) > spec.refresh.intervalMs);
    if (!stale) {
      return snapshot;
    }
    return this.run(id, { force: true });
  }

  listResources(actor?: string): ViewResource[] {
    return this.list(actor).map((spec) => {
      const snapshot = this.store.getSnapshot(spec.id);
      return {
        uri: viewUri(spec.id),
        name: spec.id,
        title: spec.title,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        mimeType: "application/json" as const,
        annotations: {
          audience: ["user", "assistant"] as ("user" | "assistant")[],
          ...(snapshot === undefined ? {} : { lastModified: snapshot.startedAt }),
        },
      };
    });
  }

  async readResource(
    uri: string,
    actor?: string,
  ): Promise<{ uri: string; mimeType: "application/json"; text: string } | undefined> {
    const spec = this.list(actor).find((candidate) => viewUri(candidate.id) === uri);
    if (spec === undefined) {
      return undefined;
    }
    const snapshot = await this.getFresh(spec.id);
    if (snapshot === undefined) {
      return undefined;
    }
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(renderCardJson(spec, snapshot)),
    };
  }

  close(): void {
    this.scheduler.stopAll();
    this.previews.clear();
  }

  /** Parse the input and prove every bound tool is a configured producer's
   * declared QUERY tool — a glance must never fire a mutation. Shared by pin
   * and preview so a preview that passes is a pin that passes. */
  private compile(input: unknown, actor?: string): CompileResult {
    const parsed = ViewSpecInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, code: "invalid_view", message: issues };
    }
    // The owner is who the view reads as: its queries reach the broker
    // under this identity and get that user's profile and tokens. So it is
    // never taken from the client when a signed-in caller is known — a view
    // author could otherwise name any other user. A local stdio gateway has
    // no sign-in and takes the field as written.
    const owner = actor ?? parsed.data.owner;
    if (owner === undefined) {
      return {
        ok: false,
        code: "invalid_view",
        message: "owner: required when the gateway has no signed-in identity",
      };
    }
    const spec: CompiledSpec = { ...parsed.data, owner };
    const toolsByProducer = new Map<string, Set<string>>();
    for (const query of spec.queries) {
      const name = parsePrefixedName(query.tool);
      if (name === null) {
        return { ok: false, code: "invalid_view", message: `query '${query.key}': bad tool name` };
      }
      const { capabilityId: producer, toolName } = name;
      if (!this.options.isConfigured(producer)) {
        return {
          ok: false,
          code: "unknown_capability",
          message: `query '${query.key}' targets '${producer}', which is not a configured capability`,
        };
      }
      const queryTools = this.options.queryToolsOf(producer) ?? [];
      if (!queryTools.includes(toolName)) {
        return {
          ok: false,
          code: "not_query_tool",
          message:
            `query '${query.key}': '${toolName}' is not in '${producer}''s manifest tools.query — ` +
            "views bind only annotated side-effect-free query tools",
        };
      }
      const set = toolsByProducer.get(producer) ?? new Set<string>();
      set.add(toolName);
      toolsByProducer.set(producer, set);
    }
    return { ok: true, spec, toolsByProducer };
  }

  private stamp(spec: CompiledSpec, existing: ViewSpec | undefined): ViewSpec {
    const now = new Date().toISOString();
    return { ...spec, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }

  private execute(spec: ViewSpec, mode: ExecutionMode): Promise<ViewSnapshot> {
    const checkGrant: ExecutorDeps["checkGrant"] =
      mode.kind === "pinned"
        ? (viewCapability, producer, tool) =>
            openVault({ env: this.options.env, grantMode: "explicit" }).checkGrant({
              capability: viewCapability,
              connectionId: `capability:${producer}`,
              action: tool,
            })
        : (_consumer, producer, tool) => mode.allowed.get(producer)?.has(tool) === true;
    return executeView(
      spec,
      {
        checkGrant,
        callPeer: this.options.callPeer,
        versionOf: this.options.versionOf,
        audit: this.options.audit,
      },
      {
        queryTimeoutMs: this.options.config.queryTimeoutMs,
        transformTimeoutMs: this.options.config.transformTimeoutMs,
        ...(mode.kind === "preview" ? { consumer: previewCapabilityId(spec.id) } : {}),
      },
    );
  }
}

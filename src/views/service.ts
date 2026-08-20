// The views orchestrator: pin = compile + prove (dry-run before persist),
// refresh = scheduler + refresh-on-read backstop, serve = snapshots only.
// Each view consumes producers as grant-consumer `view-<id>` through the
// peer-call machinery; pinning writes the grants (the pin IS the consent),
// unpinning revokes them.

import { openVault, type GrantRecord } from "@local/vault";

import type { AuditWriter } from "../audit.js";
import type { ViewsConfig } from "../config.js";
import { parsePrefixedName } from "../registry.js";
import { executeView, type CallPeerFn } from "./executor.js";
import {
  viewCapabilityId,
  ViewSpecInputSchema,
  viewUri,
  type ViewSnapshot,
  type ViewSpec,
} from "./model.js";
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
}

export class ViewsService {
  private readonly store: ViewStore;
  private readonly scheduler: ViewScheduler;
  private readonly inflight = new Map<string, Promise<ViewSnapshot>>();

  constructor(private readonly options: ViewsServiceOptions) {
    this.store = new ViewStore(options.dir, options.log);
    this.scheduler = new ViewScheduler(async (id) => {
      await this.run(id, { force: true });
    }, options.log);
  }

  init(): void {
    for (const spec of this.store.list()) {
      if (spec.refresh.intervalMs !== null) {
        this.scheduler.start(spec.id, spec.refresh.intervalMs);
      }
    }
  }

  list(): ViewSpec[] {
    return this.store.list();
  }

  get(id: string): ViewSpec | undefined {
    return this.store.get(id);
  }

  getSnapshot(id: string): ViewSnapshot | undefined {
    return this.store.getSnapshot(id);
  }

  async pin(input: unknown): Promise<PinResult> {
    const parsed = ViewSpecInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, code: "invalid_view", message: issues };
    }
    const spec = parsed.data;
    const existing = this.store.get(spec.id);
    if (existing === undefined && this.store.list().length >= this.options.config.maxViews) {
      return {
        ok: false,
        code: "too_many_views",
        message: `the gateway caps pinned views at ${String(this.options.config.maxViews)}; unpin one first`,
      };
    }

    // Every bound tool must be a configured producer's declared QUERY tool —
    // a glance must never fire a mutation.
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

    const now = new Date().toISOString();
    const full: ViewSpec = {
      ...spec,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const snapshot = await this.execute(full);
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

  unpin(id: string): boolean {
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
    const promise = this.execute(spec)
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

  listResources(): ViewResource[] {
    return this.store.list().map((spec) => {
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
  ): Promise<{ uri: string; mimeType: "application/json"; text: string } | undefined> {
    const spec = this.store.list().find((candidate) => viewUri(candidate.id) === uri);
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
  }

  private execute(spec: ViewSpec): Promise<ViewSnapshot> {
    return executeView(
      spec,
      {
        checkGrant: (viewCapability, producer, tool) =>
          openVault({ env: this.options.env, grantMode: "explicit" }).checkGrant({
            capability: viewCapability,
            connectionId: `capability:${producer}`,
            action: tool,
          }),
        callPeer: this.options.callPeer,
        versionOf: this.options.versionOf,
        audit: this.options.audit,
      },
      {
        queryTimeoutMs: this.options.config.queryTimeoutMs,
        transformTimeoutMs: this.options.config.transformTimeoutMs,
      },
    );
  }
}

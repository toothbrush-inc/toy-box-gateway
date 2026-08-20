// Persistence for pinned views: <dir>/views.json (the registry) and
// <dir>/snapshots/<id>.json (latest render). Atomic writes mirroring the
// vault's convention: dirs 0700, tmp file 0600, rename.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  ViewSnapshotSchema,
  ViewSpecSchema,
  type ViewSnapshot,
  type ViewSpec,
} from "./model.js";

const REGISTRY_FILE = "views.json";

export class ViewStore {
  private readonly views = new Map<string, ViewSpec>();

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.load();
  }

  list(): ViewSpec[] {
    return [...this.views.values()];
  }

  get(id: string): ViewSpec | undefined {
    return this.views.get(id);
  }

  put(spec: ViewSpec): void {
    this.views.set(spec.id, spec);
    this.persist();
  }

  delete(id: string): boolean {
    const existed = this.views.delete(id);
    if (existed) {
      this.persist();
      rmSync(this.snapshotPath(id), { force: true });
    }
    return existed;
  }

  getSnapshot(id: string): ViewSnapshot | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.snapshotPath(id), "utf8");
    } catch {
      return undefined;
    }
    const parsed = ViewSnapshotSchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data : undefined;
  }

  putSnapshot(snapshot: ViewSnapshot): void {
    writeFileAtomic(this.snapshotPath(snapshot.viewId), JSON.stringify(snapshot, null, 2));
  }

  private snapshotPath(id: string): string {
    return join(this.dir, "snapshots", `${id}.json`);
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, REGISTRY_FILE), "utf8");
    } catch {
      return;
    }
    const parsed = safeJson(raw) as { views?: unknown } | null;
    if (parsed === null || !Array.isArray(parsed.views)) {
      this.log(`[gateway] views registry at ${this.dir} is malformed; starting empty`);
      return;
    }
    for (const entry of parsed.views) {
      const spec = ViewSpecSchema.safeParse(entry);
      if (spec.success) {
        this.views.set(spec.data.id, spec.data);
      } else {
        this.log(`[gateway] skipping invalid view entry in ${REGISTRY_FILE}`);
      }
    }
  }

  private persist(): void {
    writeFileAtomic(
      join(this.dir, REGISTRY_FILE),
      JSON.stringify({ version: 1, views: this.list() }, null, 2),
    );
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

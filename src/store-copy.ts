// Where the words for an app come from. Each capability's capability.json
// may carry a `store` block (the app's own name, tagline, highlights, web
// path, repo); the gateway config's `web` block overrides any field for this
// deployment. The resolved result feeds the store page, gateway_status, and
// the MCP server's instructions, so every surface says the same thing.

import { readFileSync } from "node:fs";

import { ManifestStoreSchema, type CapabilitySpec, type ManifestStore, type StoreCopy } from "./config.js";

/** One capability's resolved storefront words, plus where its web UI is. */
export interface StoreEntry {
  copy: StoreCopy;
  /** Absent for an agent-only capability: tools, no page, no tile. */
  path?: string | undefined;
}

/** Warn-only: a missing or malformed block never blocks mounting. */
export function readManifestStore(
  spec: CapabilitySpec,
  log: (line: string) => void,
): ManifestStore | undefined {
  if (spec.manifestPath === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(spec.manifestPath, "utf8"));
  } catch {
    return undefined; // status.ts already reports an unreadable manifest
  }
  if (typeof raw !== "object" || raw === null || !("store" in raw) || raw.store === undefined) {
    return undefined;
  }
  const parsed = ManifestStoreSchema.safeParse(raw.store);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` (${issue.path.join(".")}: ${issue.message})`;
    log(`[${spec.id}] manifest store block ignored${where}`);
    return undefined;
  }
  return parsed.data;
}

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

function defined<T extends object>(value: Loose<T>): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Config over manifest, per field. `label` falls back to the manifest's
 * `name`, then to the capitalised id, so a group always has a name. */
export function resolveStoreEntry(
  spec: CapabilitySpec,
  manifest: ManifestStore | undefined,
  log: (line: string) => void,
): StoreEntry {
  const fromManifest: Partial<StoreCopy> =
    manifest === undefined
      ? {}
      : defined<StoreCopy>({
          label: manifest.name,
          tagline: manifest.tagline,
          description: manifest.description,
          highlights: manifest.highlights,
          badge: manifest.badge,
          accent: manifest.accent,
          repo: manifest.repo,
          dataUse: manifest.dataUse,
        });
  const { path: configPath, ...fromConfig } = spec.web ?? {};
  const merged: Partial<StoreCopy> = { ...fromManifest, ...defined<StoreCopy>(fromConfig) };
  const copy: StoreCopy = {
    ...merged,
    label: merged.label ?? spec.id.charAt(0).toUpperCase() + spec.id.slice(1),
  };
  const path = configPath ?? manifest?.web?.path;
  if (path === undefined && Object.keys(defined<StoreCopy>(fromConfig)).length > 0) {
    log(
      `[${spec.id}] web block has copy but no path (and the manifest declares none); the app gets no tile`,
    );
  }
  return { copy, ...(path === undefined ? {} : { path }) };
}

export function resolveStoreEntries(
  specs: readonly CapabilitySpec[],
  log: (line: string) => void,
): Map<string, StoreEntry> {
  return new Map(specs.map((spec) => [spec.id, resolveStoreEntry(spec, readManifestStore(spec, log), log)]));
}

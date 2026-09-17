import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CapabilitySpecSchema } from "../src/config.js";
import { readManifestStore, resolveStoreEntry } from "../src/store-copy.js";

function manifestWith(store: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "store-copy-"));
  const path = join(dir, "capability.json");
  writeFileSync(path, JSON.stringify({ id: "weather", connections: [], store }));
  return path;
}

const STORE = {
  name: "Weather",
  tagline: "Know which forecast to trust.",
  description: "Three forecasts side by side.",
  highlights: ["Air quality near you"],
  accent: "sky",
  web: { path: "/weather" },
  repo: "https://github.com/example/weather-compare",
};

describe("store copy resolution", () => {
  it("takes the tile from the manifest when the config says nothing", () => {
    const spec = CapabilitySpecSchema.parse({ id: "weather", command: "x", manifestPath: manifestWith(STORE) });
    const lines: string[] = [];
    const entry = resolveStoreEntry(spec, readManifestStore(spec, (l) => lines.push(l)), (l) => lines.push(l));
    expect(entry).toEqual({
      copy: {
        label: "Weather",
        tagline: "Know which forecast to trust.",
        description: "Three forecasts side by side.",
        highlights: ["Air quality near you"],
        accent: "sky",
        repo: "https://github.com/example/weather-compare",
      },
      path: "/weather",
    });
    expect(lines).toEqual([]);
  });

  it("lets the config override per field, including the path", () => {
    const spec = CapabilitySpecSchema.parse({
      id: "weather",
      command: "x",
      manifestPath: manifestWith(STORE),
      web: { path: "/wx", tagline: "Hosted words win.", badge: "beta" },
    });
    const entry = resolveStoreEntry(spec, readManifestStore(spec, () => undefined), () => undefined);
    expect(entry.path).toBe("/wx");
    expect(entry.copy).toMatchObject({
      label: "Weather",
      tagline: "Hosted words win.",
      description: "Three forecasts side by side.",
      badge: "beta",
    });
  });

  it("is agent-only without a path from either side, and says so when copy was given", () => {
    const { web: _web, ...noPath } = STORE;
    const quiet = CapabilitySpecSchema.parse({ id: "calsync", command: "x", manifestPath: manifestWith({ ...noPath, name: "calsync" }) });
    const lines: string[] = [];
    const entry = resolveStoreEntry(quiet, readManifestStore(quiet, (l) => lines.push(l)), (l) => lines.push(l));
    expect(entry.path).toBeUndefined();
    expect(entry.copy.label).toBe("calsync");
    expect(lines).toEqual([]);

    const loud = CapabilitySpecSchema.parse({ id: "calsync", command: "x", web: { tagline: "words" } });
    resolveStoreEntry(loud, undefined, (l) => lines.push(l));
    expect(lines).toEqual(["[calsync] web block has copy but no path (and the manifest declares none); the app gets no tile"]);
  });

  it("falls back to the capitalised id and ignores a malformed block with a warning", () => {
    const bare = CapabilitySpecSchema.parse({ id: "fitness", command: "x" });
    expect(resolveStoreEntry(bare, undefined, () => undefined)).toEqual({ copy: { label: "Fitness" } });

    const bad = CapabilitySpecSchema.parse({
      id: "weather",
      command: "x",
      manifestPath: manifestWith({ name: "Weather", accent: "teal" }),
    });
    const lines: string[] = [];
    expect(readManifestStore(bad, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[weather\] manifest store block ignored \(accent: /u);
  });
});

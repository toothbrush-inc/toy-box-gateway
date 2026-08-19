import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditWriter, type AuditEntry } from "../src/audit.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function auditDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-audit-"));
  dirs.push(dir);
  return join(dir, "audit");
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-08-18T22:00:00.000Z",
    capability: "weather",
    tool: "get_status",
    outcome: "ok",
    duration_ms: 12,
    ...overrides,
  };
}

describe("AuditWriter", () => {
  it("appends one parseable JSON line per call with exactly the entry fields", () => {
    const writer = new AuditWriter({ dir: auditDir() });
    writer.record(entry());
    writer.record(entry({ outcome: "denied", denied_by: "policy", tool: "sync_now" }));
    writer.record(entry({ outcome: "error", error_code: "grant_missing" }));

    const lines = readFileSync(writer.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toEqual(entry());
    expect(parsed[1]?.["denied_by"]).toBe("policy");
    expect(parsed[2]?.["error_code"]).toBe("grant_missing");
    for (const row of parsed) {
      expect(row).not.toHaveProperty("arguments");
      expect(row).not.toHaveProperty("result");
    }
  });

  it("rotates at maxBytes and prunes beyond keepFiles", () => {
    const dir = auditDir();
    const writer = new AuditWriter({ dir, maxBytes: 200, keepFiles: 1 });
    for (let index = 0; index < 12; index += 1) {
      writer.record(entry({ duration_ms: index }));
    }
    const files = readdirSync(dir).sort();
    const rotated = files.filter((name) => name.startsWith("audit-"));
    expect(files).toContain("audit.jsonl");
    expect(rotated.length).toBe(1);
  });
});

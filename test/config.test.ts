import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CapabilitySpecSchema, GatewayConfigSchema, loadGatewayConfig, resolveConfigPath } from "../src/config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
  dirs.push(dir);
  return dir;
}

const validCapability = { id: "weather", command: "node", args: ["mcp/server.mjs"] };

describe("GatewayConfigSchema", () => {
  it("applies defaults for args and audit", () => {
    const parsed = GatewayConfigSchema.parse({ capabilities: [{ id: "weather", command: "node" }] });
    expect(parsed.capabilities[0]?.args).toEqual([]);
    expect(parsed.audit).toEqual({ maxBytes: 5 * 1024 * 1024, keepFiles: 5 });
    expect(parsed.links).toEqual([]);
  });

  it("parses sibling app links", () => {
    const parsed = GatewayConfigSchema.parse({
      capabilities: [{ id: "weather", command: "node" }],
      links: [{ href: "https://mail.example.com", label: "MailFeed" }],
    });
    expect(parsed.links).toEqual([{ href: "https://mail.example.com", label: "MailFeed" }]);
  });

  it("parses secretsAccess and oauth, requiring manifestPath for broker mode", () => {
    expect(() =>
      GatewayConfigSchema.parse({
        capabilities: [{ id: "weather", command: "node", secretsAccess: "broker" }],
      }),
    ).toThrow(/requires manifestPath/);

    const parsed = GatewayConfigSchema.parse({
      capabilities: [
        { id: "weather", command: "node", manifestPath: "/x/capability.json", secretsAccess: "broker" },
      ],
      oauth: { google: { envFile: "/x/.env" } },
    });
    expect(parsed.capabilities[0]?.secretsAccess).toBe("broker");
    expect(parsed.oauth?.google).toEqual({
      envFile: "/x/.env",
      clientIdVar: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretVar: "GOOGLE_OAUTH_CLIENT_SECRET",
    });
  });

  it("lets web.path be a path here or an https URL on a sibling host", () => {
    const base = { id: "cal", command: "node" };
    expect(CapabilitySpecSchema.parse({ ...base, web: { path: "/cal" } }).web?.path).toBe("/cal");
    expect(
      CapabilitySpecSchema.parse({ ...base, web: { path: "https://cal.example.test" } }).web?.path,
    ).toBe("https://cal.example.test");
    expect(() => CapabilitySpecSchema.parse({ ...base, web: { path: "http://cal.example.test" } })).toThrow();
    expect(() => CapabilitySpecSchema.parse({ ...base, web: { path: "cal" } })).toThrow();
    expect(() => CapabilitySpecSchema.parse({ ...base, web: { path: "javascript:alert(1)" } })).toThrow();
  });

  it("rejects duplicate ids, the prefix separator, and the reserved id", () => {
    expect(() =>
      GatewayConfigSchema.parse({ capabilities: [validCapability, validCapability] }),
    ).toThrow(/unique/);
    expect(() =>
      GatewayConfigSchema.parse({ capabilities: [{ id: "wea__ther", command: "node" }] }),
    ).toThrow(/__/);
    expect(() =>
      GatewayConfigSchema.parse({ capabilities: [{ id: "gateway", command: "node" }] }),
    ).toThrow(/reserved/);
  });
});

describe("loadGatewayConfig", () => {
  it("parses the shipped example config", () => {
    const config = loadGatewayConfig(resolve(import.meta.dirname, "../gateway.config.example.json"));
    expect(config.capabilities.map((cap) => cap.id)).toEqual(["calsync", "weather", "fitness"]);
    expect(config.capabilities[0]?.denyTools).toEqual(["sync_now"]);
    expect(config.audit.maxBytes).toBe(5242880);
  });

  it("fails actionably on unreadable files, bad JSON, and schema violations", () => {
    const dir = tempDir();
    expect(() => loadGatewayConfig(join(dir, "missing.json"))).toThrow(/Unable to read/);

    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{nope");
    expect(() => loadGatewayConfig(badJson)).toThrow(/not valid JSON/);

    const badSchema = join(dir, "schema.json");
    writeFileSync(badSchema, JSON.stringify({ capabilities: [] }));
    expect(() => loadGatewayConfig(badSchema)).toThrow(/invalid/);
  });
});

describe("resolveConfigPath", () => {
  it("prefers --config, then GATEWAY_CONFIG, then ./gateway.config.json", () => {
    const dir = tempDir();
    expect(resolveConfigPath(["--config", "a.json"], {}, dir)).toBe(join(dir, "a.json"));
    expect(resolveConfigPath(["--config=b.json"], {}, dir)).toBe(join(dir, "b.json"));
    expect(resolveConfigPath([], { GATEWAY_CONFIG: "c.json" }, dir)).toBe(join(dir, "c.json"));

    writeFileSync(join(dir, "gateway.config.json"), "{}");
    expect(resolveConfigPath([], {}, dir)).toBe(join(dir, "gateway.config.json"));
  });

  it("throws an actionable error when nothing resolves", () => {
    const dir = tempDir();
    expect(() => resolveConfigPath([], {}, dir)).toThrow(/--config/);
    expect(() => resolveConfigPath(["--config"], {}, dir)).toThrow(/requires a path/);
  });
});

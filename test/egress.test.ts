import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openVault } from "@local/vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditWriter, type AuditEntry } from "../src/audit.js";
import {
  EgressServer,
  loadEgressSpecs,
  loadGoogleOAuthCreds,
  newEgressToken,
  type CapabilityEgressInfo,
} from "../src/egress.js";

const dirs: string[] = [];
const servers: EgressServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-egress-"));
  dirs.push(dir);
  return dir;
}

const WEATHER_INFO: CapabilityEgressInfo = {
  egress: [
    {
      provider: "purpleair",
      slot: "default",
      hosts: ["api.purpleair.com"],
      attach: { kind: "header", name: "X-API-Key" },
    },
    {
      provider: "open_meteo",
      slot: "default",
      hosts: ["api.open-meteo.com", "air-quality-api.open-meteo.com"],
      attach: { kind: "query", name: "apikey" },
      hostRewrite: { "api.open-meteo.com": "customer-api.open-meteo.com" },
    },
  ],
  connections: [
    { provider: "purpleair", slot: "default", optional: true },
    { provider: "open_meteo", slot: "default", optional: true },
  ],
};

const CALSYNC_INFO: CapabilityEgressInfo = {
  egress: [],
  connections: [{ provider: "google", slot: "personal", optional: false }],
};

interface Harness {
  url: string;
  audit: AuditWriter;
  auditPath: string;
  vaultHome: string;
  env: NodeJS.ProcessEnv;
  upstream: ReturnType<typeof vi.fn>;
  seedVault: ReturnType<typeof openVault>;
}

async function startBroker(
  options: {
    oauth?: { google: { clientId: string; clientSecret: string } };
    upstream?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  } = {},
): Promise<Harness> {
  const dir = tempDir();
  const vaultHome = join(dir, "vault");
  const env = { VAULT_HOME: vaultHome, VAULT_SECRETS_BACKEND: "file" } as NodeJS.ProcessEnv;
  const seedVault = openVault({ home: vaultHome, backend: "file" });
  const audit = new AuditWriter({ dir: join(dir, "audit") });
  const upstream = vi.fn(
    options.upstream ??
      (() => new Response(JSON.stringify({ fine: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
  const server = new EgressServer({
    tokens: new Map([
      ["tok-weather", "weather"],
      ["tok-calsync", "calsync"],
    ]),
    specs: new Map([
      ["weather", WEATHER_INFO],
      ["calsync", CALSYNC_INFO],
    ]),
    env,
    audit,
    log: () => undefined,
    ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    fetchImpl: upstream as unknown as typeof fetch,
  });
  servers.push(server);
  const url = await server.listen();
  return { url, audit, auditPath: audit.path, vaultHome, env, upstream, seedVault };
}

async function call(
  harness: Harness,
  path: "/fetch" | "/token",
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function lastAudit(harness: Harness): AuditEntry {
  const lines = readFileSync(harness.auditPath, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as AuditEntry;
}

function errorCode(json: Record<string, unknown>): unknown {
  return (json["error"] as { code?: unknown } | undefined)?.code;
}

async function seedPurpleair(harness: Harness, secret = "pa-secret-key"): Promise<void> {
  await harness.seedVault.putSecret({ provider: "purpleair", slot: "default", kind: "apikey", secret });
  harness.seedVault.putGrant({ capability: "weather", connectionId: "purpleair:default", actions: ["read"] });
}

describe("EgressServer /fetch", () => {
  it("rejects missing or unknown bearer tokens", async () => {
    const harness = await startBroker();
    const missing = await call(harness, "/fetch", null, {});
    expect(missing.status).toBe(401);
    const wrong = await call(harness, "/fetch", "nope", {});
    expect(wrong.status).toBe(401);
    expect(errorCode(wrong.json)).toBe("egress_unauthorized");
  });

  it("denies undeclared providers, missing grants, and disallowed hosts", async () => {
    const harness = await startBroker();
    const undeclared = await call(harness, "/fetch", "tok-weather", {
      provider: "google",
      url: "https://api.purpleair.com/x",
    });
    expect(undeclared.status).toBe(403);
    expect(errorCode(undeclared.json)).toBe("egress_denied");

    const ungranted = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(ungranted.status).toBe(403);
    expect(errorCode(ungranted.json)).toBe("grant_missing");
    expect(lastAudit(harness)).toMatchObject({
      capability: "weather",
      tool: "egress:purpleair",
      outcome: "denied",
      denied_by: "egress",
      error_code: "grant_missing",
      host: "api.purpleair.com",
    });

    await seedPurpleair(harness);
    for (const url of [
      "https://evil.example.com/v1",
      "http://api.purpleair.com/v1",
      "https://user:pw@api.purpleair.com/v1",
      "https://api.purpleair.com:8443/v1",
    ]) {
      const denied = await call(harness, "/fetch", "tok-weather", { provider: "purpleair", url });
      expect(denied.status).toBe(403);
      expect(errorCode(denied.json)).toBe("egress_host_denied");
    }
    expect(harness.upstream).not.toHaveBeenCalled();
  });

  it("revokes access mid-session without a restart", async () => {
    const harness = await startBroker();
    await seedPurpleair(harness);
    const before = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(before.status).toBe(200);

    harness.seedVault.revokeGrant("weather", "purpleair:default");
    const after = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(after.status).toBe(403);
    expect(errorCode(after.json)).toBe("grant_missing");
  });

  it("attaches header credentials (broker wins) and scrubs the secret from bodies", async () => {
    const harness = await startBroker({
      upstream: () => new Response("body with pa-secret-key inside", { status: 200 }),
    });
    await seedPurpleair(harness);
    const result = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
      headers: { "x-api-key": "spoofed", "User-Agent": "weather-compare/1.0", Cookie: "no" },
    });
    expect(result.status).toBe(200);
    expect(result.json["status"]).toBe(200);
    expect(result.json["body"]).toBe("body with [redacted] inside");

    const [url, init] = harness.upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.purpleair.com/v1/sensors/1");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("pa-secret-key");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe("weather-compare/1.0");
    expect(headers["Cookie"]).toBeUndefined();
    expect(JSON.stringify(readFileSync(harness.auditPath, "utf8"))).not.toContain("pa-secret-key");
  });

  it("applies query attachment with host rewrite, and passes through keyless", async () => {
    const harness = await startBroker();
    await harness.seedVault.putSecret({ provider: "open_meteo", slot: "default", kind: "apikey", secret: "om-key" });
    harness.seedVault.putGrant({ capability: "weather", connectionId: "open_meteo:default", actions: ["read"] });

    const keyed = await call(harness, "/fetch", "tok-weather", {
      provider: "open_meteo",
      url: "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2",
    });
    expect(keyed.status).toBe(200);
    const keyedUrl = harness.upstream.mock.calls[0]?.[0] as string;
    expect(keyedUrl).toContain("customer-api.open-meteo.com");
    expect(keyedUrl).toContain("apikey=om-key");
    expect(lastAudit(harness)).toMatchObject({ outcome: "ok", host: "api.open-meteo.com" });

    // air-quality host has no rewrite entry: keyed but same host
    await call(harness, "/fetch", "tok-weather", {
      provider: "open_meteo",
      url: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1",
    });
    expect(harness.upstream.mock.calls[1]?.[0]).toContain("air-quality-api.open-meteo.com");

    await harness.seedVault.revoke("open_meteo:default");
    harness.seedVault.putGrant({ capability: "weather", connectionId: "open_meteo:default", actions: ["read"] });
    const keyless = await call(harness, "/fetch", "tok-weather", {
      provider: "open_meteo",
      url: "https://api.open-meteo.com/v1/forecast?latitude=1",
    });
    expect(keyless.status).toBe(200);
    const keylessUrl = harness.upstream.mock.calls[2]?.[0] as string;
    expect(keylessUrl).toContain("api.open-meteo.com");
    expect(keylessUrl).not.toContain("customer-");
    expect(keylessUrl).not.toContain("apikey");
  });

  it("returns upstream failures as data and rejects non-GET methods", async () => {
    const harness = await startBroker({
      upstream: () => new Response("not found", { status: 404 }),
    });
    await seedPurpleair(harness);
    const notFound = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/999",
    });
    expect(notFound.status).toBe(200);
    expect(notFound.json["status"]).toBe(404);
    expect(notFound.json["body"]).toBe("not found");

    const post = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
      method: "POST",
    });
    expect(post.status).toBe(405);
    expect(errorCode(post.json)).toBe("egress_method_not_allowed");
  });
});

describe("EgressServer /token", () => {
  async function seedGoogle(harness: Harness): Promise<void> {
    await harness.seedVault.putSecret({
      provider: "google",
      slot: "personal",
      kind: "oauth",
      secret: "1//refresh-token",
    });
    harness.seedVault.putGrant({
      capability: "calsync",
      connectionId: "google:personal",
      actions: ["read", "write"],
    });
  }

  const googleOk = (url: string): Response | null => {
    if (url !== "https://oauth2.googleapis.com/token") {
      return null;
    }
    return new Response(JSON.stringify({ access_token: "ya29.short-lived", expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  it("exchanges refresh tokens for access tokens and caches them", async () => {
    const harness = await startBroker({
      oauth: { google: { clientId: "cid", clientSecret: "csecret" } },
      upstream: (url) => googleOk(url) ?? new Response("nope", { status: 500 }),
    });
    await seedGoogle(harness);

    const first = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(first.status).toBe(200);
    expect(first.json["access_token"]).toBe("ya29.short-lived");
    expect(typeof first.json["expires_at"]).toBe("string");

    const [, init] = harness.upstream.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("1//refresh-token");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");

    const second = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(second.json["access_token"]).toBe("ya29.short-lived");
    expect(harness.upstream).toHaveBeenCalledTimes(1);

    const raw = readFileSync(harness.auditPath, "utf8");
    expect(raw).toContain('"token:google"');
    expect(raw).not.toContain("ya29.short-lived");
    expect(raw).not.toContain("1//refresh-token");
  });

  it("maps invalid_grant to token_revoked and enforces declaration, grants, kind, config", async () => {
    const revokedHarness = await startBroker({
      oauth: { google: { clientId: "cid", clientSecret: "csecret" } },
      upstream: () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    await revokedHarness.seedVault.putSecret({ provider: "google", slot: "personal", kind: "oauth", secret: "1//dead" });
    revokedHarness.seedVault.putGrant({ capability: "calsync", connectionId: "google:personal" });
    const revoked = await call(revokedHarness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(revoked.status).toBe(403);
    expect(errorCode(revoked.json)).toBe("token_revoked");

    const harness = await startBroker({ oauth: { google: { clientId: "c", clientSecret: "s" } } });
    const undeclared = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "work" });
    expect(errorCode(undeclared.json)).toBe("egress_denied");

    const ungranted = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(errorCode(ungranted.json)).toBe("grant_missing");

    await harness.seedVault.putSecret({ provider: "google", slot: "personal", kind: "apikey", secret: "x" });
    harness.seedVault.putGrant({ capability: "calsync", connectionId: "google:personal" });
    const wrongKind = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(errorCode(wrongKind.json)).toBe("wrong_connection_kind");

    const noOauth = await startBroker();
    const unconfigured = await call(noOauth, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(unconfigured.status).toBe(503);
    expect(errorCode(unconfigured.json)).toBe("oauth_not_configured");
  });
});

describe("egress helpers", () => {
  it("loads egress specs from a real manifest file, warn-only on failure", () => {
    const dir = tempDir();
    const manifestPath = join(dir, "capability.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "weather",
        connections: [
          {
            provider: "purpleair",
            slot: "default",
            optional: true,
            egress: { hosts: ["api.purpleair.com"], attach: { kind: "header", name: "X-API-Key" } },
          },
        ],
      }),
    );
    const warnings: string[] = [];
    const specs = loadEgressSpecs(
      [
        { id: "weather", command: "x", args: [], manifestPath },
        { id: "broken", command: "x", args: [], manifestPath: join(dir, "missing.json") },
      ],
      (line) => warnings.push(line),
    );
    expect(specs.get("weather")?.egress[0]).toMatchObject({ provider: "purpleair", hosts: ["api.purpleair.com"] });
    expect(specs.get("broken")).toEqual({ egress: [], connections: [] });
    expect(warnings.some((line) => line.includes("broken"))).toBe(true);
  });

  it("reads oauth client credentials from an env file", () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    writeFileSync(envFile, '# comment\nGOOGLE_OAUTH_CLIENT_ID="my-id"\nGOOGLE_OAUTH_CLIENT_SECRET=my-secret\n');
    expect(
      loadGoogleOAuthCreds({
        envFile,
        clientIdVar: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretVar: "GOOGLE_OAUTH_CLIENT_SECRET",
      }),
    ).toEqual({ clientId: "my-id", clientSecret: "my-secret" });
    expect(() =>
      loadGoogleOAuthCreds({ envFile, clientIdVar: "NOPE", clientSecretVar: "ALSO_NOPE" }),
    ).toThrow(/does not define/);
  });

  it("generates distinct 64-hex egress tokens", () => {
    const a = newEgressToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newEgressToken()).not.toBe(a);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileProfileStore, identitySlug, openVault } from "@dvd-toy-box/vault";
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
  profileFields: [],
  peerCalls: new Map(),
  queryTools: [],
};

const CALSYNC_INFO: CapabilityEgressInfo = {
  egress: [],
  connections: [{ provider: "google", slot: "personal", optional: false }],
  profileFields: [],
  peerCalls: new Map(),
  queryTools: [],
};

const FITNESS_INFO: CapabilityEgressInfo = {
  egress: [],
  connections: [
    { provider: "profile", slot: "default", optional: true, actions: ["units", "timezone"] },
  ],
  profileFields: ["units", "timezone"],
  data: { commons: [{ dataset: "exercise-catalog" }] },
  peerCalls: new Map(),
  queryTools: ["get_workout_stats"],
};

const COACH_INFO: CapabilityEgressInfo = {
  egress: [],
  connections: [
    { provider: "capability", slot: "fitness", optional: true, actions: ["get_workout_stats"] },
  ],
  profileFields: [],
  peerCalls: new Map([["fitness", ["get_workout_stats"]]]),
  queryTools: [],
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
    commonsDir?: string;
    callPeer?: (
      producer: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>;
    versionOf?: (capabilityId: string) => string | null;
    resolveCall?: (nonce: string | undefined) => string | undefined;
    usersDir?: string;
    credentialUsers?: Record<string, string[]>;
    fetchTimeoutMs?: number;
    maxResponseBytes?: number;
    maxConcurrentFetches?: number;
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
      ["tok-fitness", "fitness"],
      ["tok-coach", "coach"],
    ]),
    specs: new Map([
      ["weather", WEATHER_INFO],
      ["calsync", CALSYNC_INFO],
      ["fitness", FITNESS_INFO],
      ["coach", COACH_INFO],
    ]),
    env,
    audit,
    log: () => undefined,
    ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    ...(options.commonsDir === undefined ? {} : { commonsDir: options.commonsDir }),
    ...(options.callPeer === undefined ? {} : { callPeer: options.callPeer }),
    ...(options.versionOf === undefined ? {} : { versionOf: options.versionOf }),
    ...(options.resolveCall === undefined ? {} : { resolveCall: options.resolveCall }),
    ...(options.usersDir === undefined ? {} : { usersDir: options.usersDir }),
    ...options,
    fetchImpl: upstream as unknown as typeof fetch,
  });
  servers.push(server);
  const url = await server.listen();
  return { url, audit, auditPath: audit.path, vaultHome, env, upstream, seedVault };
}

async function call(
  harness: Harness,
  path: "/fetch" | "/token" | "/profile" | "/commons" | "/call",
  token: string | null,
  body: unknown,
  nonce?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(nonce === undefined ? {} : { "X-Vault-Call": nonce }),
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

describe("EgressServer /profile per user", () => {
  const NONCES: Record<string, string> = {
    "n-alice": "alice@example.com",
    "n-sam": "sam@example.com",
    "n-view": "viewer",
  };

  async function startWithUsers(): Promise<{ harness: Harness; usersDir: string }> {
    const usersDir = join(tempDir(), "users");
    const harness = await startBroker({
      usersDir,
      resolveCall: (nonce) => (nonce === undefined ? undefined : NONCES[nonce]),
    });
    harness.seedVault.putProfile({ units: "imperial" });
    harness.seedVault.putGrant({
      capability: "fitness",
      connectionId: "profile:default",
      actions: ["units", "timezone"],
    });
    return { harness, usersDir };
  }

  function seedUser(usersDir: string, slug: string, fields: Record<string, string>): void {
    new FileProfileStore(join(usersDir, slug, "profile.json")).write(fields);
  }

  it("serves the caller their own profile, not the shared one", async () => {
    const { harness, usersDir } = await startWithUsers();
    seedUser(usersDir, "iff8d9819fc0e12bf0d24892e45987e24", { units: "metric" });
    const result = await call(harness, "/profile", "tok-fitness", { fields: ["units"] }, "n-alice");
    expect(result.status).toBe(200);
    expect(result.json["fields"]).toEqual({ units: "metric" });
  });

  // The point of the whole change: two people, one process, one profile each.
  it("keeps two users' profiles apart", async () => {
    const { harness, usersDir } = await startWithUsers();
    seedUser(usersDir, "iff8d9819fc0e12bf0d24892e45987e24", { units: "metric" });
    seedUser(usersDir, "icd25a6171969f2a3c6e35c7667e3908e", {
      units: "imperial",
      timezone: "Europe/Berlin",
    });
    const [alice, sam] = await Promise.all([
      call(harness, "/profile", "tok-fitness", { fields: ["units", "timezone"] }, "n-alice"),
      call(harness, "/profile", "tok-fitness", { fields: ["units", "timezone"] }, "n-sam"),
    ]);
    expect(alice.json["fields"]).toEqual({ units: "metric" });
    expect(sam.json["fields"]).toEqual({ units: "imperial", timezone: "Europe/Berlin" });
  });

  it("falls back to the shared profile without a nonce, and for an unknown one", async () => {
    const { harness, usersDir } = await startWithUsers();
    seedUser(usersDir, "iff8d9819fc0e12bf0d24892e45987e24", { units: "metric" });
    const bare = await call(harness, "/profile", "tok-fitness", { fields: ["units"] });
    const stale = await call(harness, "/profile", "tok-fitness", { fields: ["units"] }, "n-expired");
    expect(bare.json["fields"]).toEqual({ units: "imperial" });
    expect(stale.json["fields"]).toEqual({ units: "imperial" });
  });

  it("reads an unslugged owner, so pinned views keep resolving", async () => {
    const { harness, usersDir } = await startWithUsers();
    seedUser(usersDir, "viewer", { units: "metric" });
    const result = await call(harness, "/profile", "tok-fitness", { fields: ["units"] }, "n-view");
    expect(result.json["fields"]).toEqual({ units: "metric" });
  });

  it("attributes the broker row to the caller, still without values", async () => {
    const { harness, usersDir } = await startWithUsers();
    seedUser(usersDir, "icd25a6171969f2a3c6e35c7667e3908e", { units: "metric" });
    await call(harness, "/profile", "tok-fitness", { fields: ["units"] }, "n-sam");
    expect(lastAudit(harness)).toMatchObject({
      capability: "fitness",
      tool: "profile:read",
      outcome: "ok",
      user: "sam@example.com",
    });
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("metric");
  });
});

describe("EgressServer /profile", () => {
  async function seedProfileGrant(harness: Harness): Promise<void> {
    harness.seedVault.putProfile({ units: "metric" });
    harness.seedVault.putGrant({
      capability: "fitness",
      connectionId: "profile:default",
      actions: ["units", "timezone"],
    });
    await Promise.resolve();
  }

  it("serves granted fields, omits unset ones, and audits names only", async () => {
    const harness = await startBroker();
    await seedProfileGrant(harness);
    const result = await call(harness, "/profile", "tok-fitness", {
      fields: ["units", "timezone"],
    });
    expect(result.status).toBe(200);
    expect(result.json["fields"]).toEqual({ units: "metric" });
    const entry = lastAudit(harness);
    expect(entry).toMatchObject({
      capability: "fitness",
      tool: "profile:read",
      outcome: "ok",
      fields: ["units", "timezone"],
    });
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("metric");
  });

  it("denies undeclared fields, undeclared capabilities, and missing grants", async () => {
    const harness = await startBroker();
    await seedProfileGrant(harness);

    const undeclaredField = await call(harness, "/profile", "tok-fitness", {
      fields: ["birthday"],
    });
    expect(undeclaredField.status).toBe(403);
    expect(errorCode(undeclaredField.json)).toBe("egress_denied");

    const noProfileConnection = await call(harness, "/profile", "tok-weather", {
      fields: ["units"],
    });
    expect(errorCode(noProfileConnection.json)).toBe("egress_denied");

    harness.seedVault.revokeGrant("fitness", "profile:default");
    const revoked = await call(harness, "/profile", "tok-fitness", {
      fields: ["units", "timezone"],
    });
    expect(revoked.status).toBe(403);
    expect(errorCode(revoked.json)).toBe("grant_missing");
    expect((revoked.json["error"] as { message: string }).message).toContain("units, timezone");

    const badBody = await call(harness, "/profile", "tok-fitness", { fields: [] });
    expect(badBody.status).toBe(400);
  });

  it("hard-denies profile through /fetch", async () => {
    const harness = await startBroker();
    const result = await call(harness, "/fetch", "tok-fitness", {
      provider: "profile",
      url: "https://api.example.com/x",
    });
    expect(result.status).toBe(403);
    expect(errorCode(result.json)).toBe("egress_denied");
  });
});

describe("EgressServer /commons", () => {
  function commonsDir(harness: Harness): string {
    const dir = join(harness.vaultHome, "..", "commons");
    return dir;
  }

  async function startWithCatalog(): Promise<{ harness: Harness; dir: string }> {
    const harness0 = await startBroker();
    const dir = commonsDir(harness0);
    await Promise.resolve();
    return { harness: harness0, dir };
  }

  it("serves declared datasets, keys, and audits reads", async () => {
    const { harness, dir } = await startWithCatalog();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "exercise-catalog.json"),
      JSON.stringify({ running: { category: "cardio" }, rowing: { category: "cardio" } }),
    );
    const withDir = await startBroker({ commonsDir: dir });

    const all = await call(withDir, "/commons", "tok-fitness", { dataset: "exercise-catalog" });
    expect(all.status).toBe(200);
    expect(all.json["data"]).toMatchObject({ running: { category: "cardio" } });

    const keyed = await call(withDir, "/commons", "tok-fitness", {
      dataset: "exercise-catalog",
      key: "rowing",
    });
    expect(keyed.json["data"]).toEqual({ category: "cardio" });
    expect(lastAudit(withDir)).toMatchObject({ tool: "commons:exercise-catalog", outcome: "ok" });

    const missingKey = await call(withDir, "/commons", "tok-fitness", {
      dataset: "exercise-catalog",
      key: "nope",
    });
    expect(errorCode(missingKey.json)).toBe("commons_key_not_found");

    const undeclared = await call(withDir, "/commons", "tok-weather", {
      dataset: "exercise-catalog",
    });
    expect(errorCode(undeclared.json)).toBe("egress_denied");

    void harness;
  });

  it("reports unconfigured and missing datasets distinctly", async () => {
    const noDir = await startBroker();
    const unconfigured = await call(noDir, "/commons", "tok-fitness", {
      dataset: "exercise-catalog",
    });
    expect(unconfigured.status).toBe(503);
    expect(errorCode(unconfigured.json)).toBe("commons_not_configured");

    const emptyDir = await startBroker({ commonsDir: commonsDir(noDir) });
    const missing = await call(emptyDir, "/commons", "tok-fitness", {
      dataset: "exercise-catalog",
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing.json)).toBe("commons_not_found");
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

  it("mints tenant-scoped instances of declared slots, isolated per tenant", async () => {
    const harness = await startBroker({
      oauth: { google: { clientId: "cid", clientSecret: "csecret" } },
      upstream: (url, init) => {
        if (url !== "https://oauth2.googleapis.com/token") {
          return new Response("nope", { status: 500 });
        }
        const form = new URLSearchParams((init?.body as string) ?? "");
        const token = form.get("refresh_token") === "1//acme" ? "ya29.acme" : "ya29.default";
        return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await seedGoogle(harness);
    await harness.seedVault.putSecret({
      provider: "google",
      slot: "acme_personal",
      kind: "oauth",
      secret: "1//acme",
    });
    harness.seedVault.putGrant({
      capability: "calsync",
      connectionId: "google:acme_personal",
      actions: ["read", "write"],
    });

    const tenant = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "acme_personal" });
    expect(tenant.status).toBe(200);
    expect(tenant.json["access_token"]).toBe("ya29.acme");
    expect(lastAudit(harness)).toMatchObject({ tool: "token:google", outcome: "ok", slot: "acme_personal" });

    const base = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "personal" });
    expect(base.json["access_token"]).toBe("ya29.default");

    const again = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "acme_personal" });
    expect(again.json["access_token"]).toBe("ya29.acme");
    expect(harness.upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps tenant slots explicit: unonboarded tenants get grant_missing, non-instances egress_denied", async () => {
    const harness = await startBroker({ oauth: { google: { clientId: "c", clientSecret: "s" } } });

    const unonboarded = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "acme_personal" });
    expect(unonboarded.status).toBe(403);
    expect(errorCode(unonboarded.json)).toBe("grant_missing");

    const wrongRole = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "acme_gmail" });
    expect(errorCode(wrongRole.json)).toBe("egress_denied");

    const badTenant = await call(harness, "/token", "tok-calsync", { provider: "google", slot: "9acme_personal" });
    expect(errorCode(badTenant.json)).toBe("egress_denied");
  });
});

describe("EgressServer /call", () => {
  const FITNESS_RESULT = {
    content: [
      { type: "text", text: JSON.stringify({ ok: true, data: { total_workouts: 3 } }) },
    ],
    structuredContent: { ok: true, data: { total_workouts: 3 } },
  };

  function grantCoach(harness: Harness): void {
    harness.seedVault.putGrant({
      capability: "coach",
      connectionId: "capability:fitness",
      actions: ["get_workout_stats"],
    });
  }

  it("routes granted peer calls with provenance and versioned audit rows", async () => {
    const callPeer = vi.fn(async () => FITNESS_RESULT);
    const harness = await startBroker({
      callPeer,
      versionOf: (id) => (id === "fitness" ? "0.2.0" : id === "coach" ? "0.1.0" : null),
    });
    grantCoach(harness);
    const okCall = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "get_workout_stats",
      args: { days: 7 },
    });
    expect(okCall.status).toBe(200);
    expect(okCall.json["result"]).toEqual({ ok: true, data: { total_workouts: 3 } });
    expect(okCall.json["provenance"]).toMatchObject({ capability: "fitness", version: "0.2.0" });
    expect(callPeer).toHaveBeenCalledWith("fitness", "get_workout_stats", { days: 7 });
    expect(lastAudit(harness)).toMatchObject({
      capability: "coach",
      capability_version: "0.1.0",
      tool: "call:fitness__get_workout_stats",
      outcome: "ok",
      target: "fitness",
      target_version: "0.2.0",
    });
    const auditText = readFileSync(harness.auditPath, "utf8");
    expect(auditText).not.toContain("total_workouts");
    expect(auditText).not.toContain('"days"');
  });

  it("denies undeclared peers and tools, missing grants, self-calls, unmounted producers", async () => {
    const harness = await startBroker({
      callPeer: async () => {
        throw Object.assign(new Error("producer offline"), { code: "call_not_mounted" });
      },
    });
    const undeclared = await call(harness, "/call", "tok-weather", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(undeclared.status).toBe(403);
    expect(errorCode(undeclared.json)).toBe("egress_denied");

    const badTool = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "log_workout",
    });
    expect(badTool.status).toBe(403);
    expect(errorCode(badTool.json)).toBe("egress_denied");

    const ungranted = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(ungranted.status).toBe(403);
    expect(errorCode(ungranted.json)).toBe("grant_missing");
    expect(lastAudit(harness)).toMatchObject({
      capability: "coach",
      outcome: "denied",
      denied_by: "egress",
      error_code: "grant_missing",
      target: "fitness",
    });

    const self = await call(harness, "/call", "tok-fitness", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(self.status).toBe(403);
    expect(errorCode(self.json)).toBe("egress_denied");

    grantCoach(harness);
    const unmounted = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(unmounted.status).toBe(503);
    expect(errorCode(unmounted.json)).toBe("call_not_mounted");
  });

  it("passes producer typed errors through as 200 and honors mid-session revocation", async () => {
    const producerError = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: { code: "unknown_exercise", message: "nope" } }),
        },
      ],
      isError: true,
    };
    const harness = await startBroker({ callPeer: async () => producerError });
    grantCoach(harness);
    const errCall = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(errCall.status).toBe(200);
    expect((errCall.json["result"] as { ok: boolean }).ok).toBe(false);
    expect(lastAudit(harness)).toMatchObject({ outcome: "error", error_code: "unknown_exercise" });

    harness.seedVault.revokeGrant("coach", "capability:fitness");
    const revoked = await call(harness, "/call", "tok-coach", {
      capability: "fitness",
      tool: "get_workout_stats",
    });
    expect(revoked.status).toBe(403);
    expect(errorCode(revoked.json)).toBe("grant_missing");
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
          { provider: "capability", slot: "fitness", optional: true, actions: ["get_workout_stats"] },
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
    expect(specs.get("weather")?.peerCalls.get("fitness")).toEqual(["get_workout_stats"]);
    expect(specs.get("weather")?.egress.some((entry) => entry.provider === "capability")).toBe(false);
    expect(specs.get("broken")).toEqual({
      egress: [],
      connections: [],
      profileFields: [],
      peerCalls: new Map(),
      queryTools: [],
    });
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

describe("EgressServer /fetch hardening", () => {
  it("answers a redirect instead of following it, so the key never leaves the allowlist", async () => {
    const harness = await startBroker({
      upstream: () =>
        new Response("", { status: 302, headers: { Location: "https://collector.evil.example/" } }),
    });
    await seedPurpleair(harness);
    const result = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(result.status).toBe(200);
    expect(result.json["status"]).toBe(302);
    // one request, with the fetch told not to follow
    expect(harness.upstream).toHaveBeenCalledTimes(1);
    const [, init] = harness.upstream.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("survives an upstream body that cannot be read, and keeps serving", async () => {
    const harness = await startBroker({
      upstream: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("terminated"));
            },
          }),
          { status: 200 },
        ),
    });
    await seedPurpleair(harness);
    const broken = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(broken.status).toBe(502);
    expect(errorCode(broken.json)).toBe("upstream_unreachable");
    expect(lastAudit(harness)).toMatchObject({ outcome: "error", error_code: "upstream_unreachable" });

    harness.upstream.mockImplementation(() => new Response("fine", { status: 200 }));
    const next = await call(harness, "/fetch", "tok-weather", {
      provider: "purpleair",
      url: "https://api.purpleair.com/v1/sensors/1",
    });
    expect(next.status).toBe(200);
    expect(next.json["body"]).toBe("fine");
  });
});

describe("hosted credential ownership and upstream budgets", () => {
  it("checks the nonce user before serving any slot, including cached tokens", async () => {
    const harness = await startBroker({
      oauth: { google: { clientId: "id", clientSecret: "secret" } },
      credentialUsers: { "purpleair:default": ["alice"], "google:personal": ["alice"] },
      resolveCall: (nonce) => nonce === "a" ? "alice" : nonce === "b" ? "bob" : undefined,
      upstream: () => new Response(JSON.stringify({ access_token: "ya29.allowed", expires_in: 3600 })),
    });
    await harness.seedVault.putSecret({ provider: "purpleair", slot: "default", kind: "apikey", secret: "key" });
    harness.seedVault.putGrant({ capability: "weather", connectionId: "purpleair:default", actions: ["read"] });
    await harness.seedVault.putSecret({ provider: "google", slot: "personal", kind: "oauth", secret: "refresh" });
    harness.seedVault.putGrant({ capability: "calsync", connectionId: "google:personal" });
    for (const [path, token, body] of [
      ["/fetch", "tok-weather", { provider: "purpleair", url: "https://api.purpleair.com/v1" }],
      ["/token", "tok-calsync", { provider: "google", slot: "personal" }],
    ] as const) {
      expect((await call(harness, path, token, body, "a")).status).toBe(200);
      for (const nonce of ["b", "forged", undefined]) {
        const refused = await call(harness, path, token, body, nonce);
        expect(refused.status).toBe(403);
        expect(errorCode(refused.json)).toBe("credential_denied");
      }
    }
    expect(harness.upstream).toHaveBeenCalledTimes(2);
  });

  it("serves a person's own tenant slot with no credentialUsers entry, and nobody else's", async () => {
    const alice = "alice@example.com";
    const bob = "bob@example.com";
    const aliceSlot = `${identitySlug(alice) as string}_personal`;
    const bobSlot = `${identitySlug(bob) as string}_personal`;
    const harness = await startBroker({
      oauth: { google: { clientId: "id", clientSecret: "secret" } },
      credentialUsers: {},
      resolveCall: (nonce) => nonce === "a" ? alice : nonce === "b" ? bob : undefined,
      upstream: () => new Response(JSON.stringify({ access_token: "ya29.own", expires_in: 3600 })),
    });
    for (const slot of [aliceSlot, bobSlot, "personal"]) {
      await harness.seedVault.putSecret({ provider: "google", slot, kind: "oauth", secret: `refresh-${slot}` });
      harness.seedVault.putGrant({ capability: "calsync", connectionId: `google:${slot}` });
    }
    const own = await call(harness, "/token", "tok-calsync", { provider: "google", slot: aliceSlot }, "a");
    expect(own.status).toBe(200);
    for (const [slot, nonce] of [
      [bobSlot, "a"],
      [aliceSlot, "b"],
      ["personal", "a"],
      [aliceSlot, undefined],
    ] as const) {
      const refused = await call(harness, "/token", "tok-calsync", { provider: "google", slot }, nonce);
      expect(refused.status).toBe(403);
      expect(errorCode(refused.json)).toBe("credential_denied");
    }
    expect(harness.upstream).toHaveBeenCalledTimes(1);
  });

  it("caps body bytes, concurrent requests and the total upstream duration", async () => {
    let signal: AbortSignal | null | undefined;
    const harness = await startBroker({
      maxResponseBytes: 8, fetchTimeoutMs: 80, maxConcurrentFetches: 1,
      upstream: (_url, init) => { signal = init?.signal; return new Promise<Response>(() => undefined); },
    });
    harness.seedVault.putGrant({ capability: "weather", connectionId: "purpleair:default", actions: ["read"] });
    const body = { provider: "purpleair", url: "https://api.purpleair.com/v1" };
    const pending = call(harness, "/fetch", "tok-weather", body);
    await vi.waitFor(() => expect(harness.upstream).toHaveBeenCalledOnce());
    expect((await call(harness, "/fetch", "tok-weather", body)).status).toBe(429);
    expect((await pending).status).toBe(502);
    expect(signal?.aborted).toBe(true);
    harness.upstream.mockImplementation(() => new Response("0123456789"));
    expect((await call(harness, "/fetch", "tok-weather", body)).status).toBe(502);
    harness.upstream.mockImplementation(() => new Response("ok"));
    expect((await call(harness, "/fetch", "tok-weather", body)).status).toBe(200);
  });
});

it("does not fall back to the operator profile on an unscoped hosted request", async () => {
  const harness = await startBroker({ credentialUsers: {} });
  harness.seedVault.putGrant({ capability: "fitness", connectionId: "profile:default", actions: ["units"] });
  const response = await call(harness, "/profile", "tok-fitness", { fields: ["units"] });
  expect(response.status).toBe(403);
  expect(errorCode(response.json)).toBe("call_scope_required");
});

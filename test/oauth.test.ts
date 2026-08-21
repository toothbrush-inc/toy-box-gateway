import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditWriter } from "../src/audit.js";
import { GatewayConfigSchema, type GatewayConfig } from "../src/config.js";
import { createGatewayCore, type GatewayCore } from "../src/gateway.js";
import { signJwt, verifyJwt } from "../src/http/oauth/jwt.js";
import { GatewayOAuthProvider } from "../src/http/oauth/provider.js";
import { OAuthDiskStore } from "../src/http/oauth/store.js";
import { startHttpGateway, type HttpGateway } from "../src/http/server.js";
import { startFakeWeather } from "./fakes.js";

const cleanups: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-oauth-"));
  dirs.push(dir);
  return dir;
}

describe("hs256 jwt", () => {
  it("round-trips, rejects tampering, expiry, and wrong audience", () => {
    const key = randomBytes(32);
    const token = signJwt(key, { iss: "https://gw", aud: "mcp", sub: "dvd@x.com", expiresInSec: 60 });
    expect(verifyJwt(key, token, { iss: "https://gw", aud: "mcp" })?.sub).toBe("dvd@x.com");
    expect(verifyJwt(key, token, { iss: "https://gw", aud: "session" })).toBeNull();
    expect(verifyJwt(randomBytes(32), token, { iss: "https://gw", aud: "mcp" })).toBeNull();
    expect(verifyJwt(key, `${token}x`, { iss: "https://gw", aud: "mcp" })).toBeNull();
    const expired = signJwt(key, { iss: "https://gw", aud: "mcp", sub: "x", expiresInSec: -10 });
    expect(verifyJwt(key, expired, { iss: "https://gw", aud: "mcp" })).toBeNull();
  });
});

// ---- fake Google: /token returns an unsigned id_token with a chosen email --

interface FakeGoogle {
  endpoints: { authUrl: string; tokenUrl: string };
  setEmail(email: string): void;
  close(): Promise<void>;
}

async function startFakeGoogle(): Promise<FakeGoogle> {
  let email = "dvd@thephotobase.com";
  const server: Server = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/token")) {
      const payload = Buffer.from(
        JSON.stringify({ email, email_verified: true }),
        "utf8",
      ).toString("base64url");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id_token: `h.${payload}.s` }));
      return;
    }
    response.writeHead(200);
    response.end("fake google auth page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    endpoints: { authUrl: `${base}/auth`, tokenUrl: `${base}/token` },
    setEmail: (value) => {
      email = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface OAuthHarness {
  url: string;
  provider: GatewayOAuthProvider;
  google: FakeGoogle;
  core: GatewayCore;
  http: HttpGateway;
}

async function startHarness(): Promise<OAuthHarness> {
  const dir = tempDir();
  const fake = await startFakeWeather();
  const manifestPath = join(dir, "capability.json");
  writeFileSync(manifestPath, JSON.stringify({ id: "weather", connections: [], tools: { query: ["echo"] } }));
  const google = await startFakeGoogle();
  cleanups.push(() => google.close());

  const config: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      capabilities: [{ id: "weather", command: "unused", manifestPath }],
      views: { dir: join(dir, "views") },
      serve: {
        port: 0,
        host: "127.0.0.1",
        publicUrl: "http://127.0.0.1",
        auth: { stage: "static" },
      },
    }),
    configPath: join(dir, "gateway.config.json"),
  };
  const audit = new AuditWriter({ dir: join(dir, "audit") });
  const core = await createGatewayCore({
    config,
    audit,
    env: { VAULT_HOME: join(dir, "vault"), VAULT_SECRETS_BACKEND: "file" } as NodeJS.ProcessEnv,
    log: () => undefined,
    transportFactory: () => fake.transport,
  });
  const serve = config.serve;
  if (serve === undefined) {
    throw new Error("serve config missing");
  }
  const provider = new GatewayOAuthProvider({
    issuerUrl: serve.publicUrl,
    store: new OAuthDiskStore(join(dir, "oauth")),
    signingKey: randomBytes(32),
    allowedEmails: ["dvd@thephotobase.com"],
    google: { clientId: "login-client", clientSecret: "login-secret" },
    googleEndpoints: google.endpoints,
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 86_400,
    scopesSupported: ["mcp"],
    log: () => undefined,
  });
  const http = await startHttpGateway({
    core,
    serve,
    verifier: provider,
    oauth: provider,
    log: () => undefined,
  });
  cleanups.push(async () => {
    await http.close();
    await core.close();
  });
  return { url: `http://127.0.0.1:${String(http.port)}`, provider, google, core, http };
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(url: string): Promise<{ client_id: string; client_secret: string }> {
  const response = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:9999/cb"],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "test client",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret: string };
}

/** Runs authorize -> google callback; returns the redirect back to the client. */
async function loginThrough(
  url: string,
  clientId: string,
  challenge: string,
): Promise<URL> {
  const authorize = await fetch(
    `${url}/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/cb")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=client-state`,
    { redirect: "manual" },
  );
  expect(authorize.status).toBe(302);
  const googleUrl = new URL(authorize.headers.get("location") ?? "");
  const gstate = googleUrl.searchParams.get("state") ?? "";
  const callback = await fetch(`${url}/auth/google/callback?state=${gstate}&code=fake-code`, {
    redirect: "manual",
  });
  expect(callback.status).toBe(302);
  return new URL(callback.headers.get("location") ?? "");
}

describe("oauth authorization server", () => {
  it("serves metadata and completes the full DCR + PKCE + refresh flow", async () => {
    const harness = await startHarness();

    const metadata = await fetch(`${harness.url}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    const meta = (await metadata.json()) as Record<string, string>;
    expect(meta["authorization_endpoint"]).toContain("/authorize");
    expect(meta["token_endpoint"]).toContain("/token");
    expect(meta["registration_endpoint"]).toContain("/register");

    const client = await registerClient(harness.url);
    const { verifier, challenge } = pkcePair();
    const back = await loginThrough(harness.url, client.client_id, challenge);
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:9999/cb");
    expect(back.searchParams.get("state")).toBe("client-state");
    const code = back.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const tokenResponse = await fetch(`${harness.url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: "http://127.0.0.1:9999/cb",
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };

    // the minted access token authenticates API surfaces
    const authed = await fetch(`${harness.url}/views`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(authed.status).toBe(200);
    const unauthed = await fetch(`${harness.url}/views`);
    expect(unauthed.status).toBe(401);

    // refresh rotates; replaying the OLD refresh token kills the family
    const refresh = async (token: string): Promise<Response> =>
      fetch(`${harness.url}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        }).toString(),
      });
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const nextTokens = (await rotated.json()) as { refresh_token: string };

    const reuse = await refresh(tokens.refresh_token);
    expect(reuse.status).toBe(400);
    const familyDead = await refresh(nextTokens.refresh_token);
    expect(familyDead.status).toBe(400);
  });

  it("rejects accounts that are not on allowedEmails", async () => {
    const harness = await startHarness();
    harness.google.setEmail("intruder@example.com");
    const client = await registerClient(harness.url);
    const { challenge } = pkcePair();
    const back = await loginThrough(harness.url, client.client_id, challenge);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("issues browser sessions that unlock the views surface", async () => {
    const harness = await startHarness();

    // unauthenticated browser -> login redirect
    const browserHit = await fetch(`${harness.url}/views/anything`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(browserHit.status).toBe(302);
    expect(browserHit.headers.get("location")).toContain("/login?next=");

    const login = await fetch(`${harness.url}/login?next=/views`, { redirect: "manual" });
    expect(login.status).toBe(302);
    const gstate = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await fetch(`${harness.url}/auth/google/callback?state=${gstate}&code=ok`, {
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/views");
    const setCookie = callback.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gw_session=");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0] ?? "";

    const withCookie = await fetch(`${harness.url}/views`, { headers: { Cookie: cookie } });
    expect(withCookie.status).toBe(200);

    const verifyOk = await fetch(`${harness.url}/session/verify`, { headers: { Cookie: cookie } });
    expect(verifyOk.status).toBe(204);
    const verifyMissing = await fetch(`${harness.url}/session/verify`);
    expect(verifyMissing.status).toBe(401);
    const verifyBrowser = await fetch(`${harness.url}/session/verify`, {
      headers: { Accept: "text/html", "X-Forwarded-Uri": "/dashboard" },
      redirect: "manual",
    });
    expect(verifyBrowser.status).toBe(302);
    expect(verifyBrowser.headers.get("location")).toContain("next=%2Fdashboard");
  });

  it("persists clients and refresh families across a store reload", async () => {
    const dir = tempDir();
    const store = new OAuthDiskStore(dir);
    store.putClient({ client_id: "abc", redirect_uris: ["http://x/cb"] } as never);
    store.putRefresh("tok1", {
      family: "fam1",
      clientId: "abc",
      email: "dvd@thephotobase.com",
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 1000,
    });
    const reloaded = new OAuthDiskStore(dir);
    expect(reloaded.getClient("abc")?.client_id).toBe("abc");
    expect(reloaded.getRefresh("tok1")?.family).toBe("fam1");
    reloaded.revokeFamily("fam1");
    expect(new OAuthDiskStore(dir).getRefresh("tok1")?.revoked).toBe(true);
    expect(readFileSync(join(dir, "refresh.json"), "utf8")).not.toContain("client_secret");
  });
});

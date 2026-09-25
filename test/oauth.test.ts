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
import { AccessStore } from "../src/http/oauth/access.js";
import { GatewayOAuthProvider, safeNext } from "../src/http/oauth/provider.js";
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
  let email = "alice@example.com";
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
  /** Present when the harness was started with a waiting list. */
  access?: AccessStore;
  /** Where the OAuth store (and the waiting list) lives, and what signs tokens. */
  oauthDir: string;
  signingKey: Buffer;
}

async function startHarness(
  serveExtra: Record<string, unknown> = {},
  extra: { waitlist?: boolean; storeName?: string } = {},
): Promise<OAuthHarness> {
  const dir = tempDir();
  const oauthDir = join(dir, "oauth");
  const signingKey = randomBytes(32);
  const access = extra.waitlist === true ? new AccessStore(oauthDir, ["alice@example.com"]) : undefined;
  const fake = await startFakeWeather();
  const manifestPath = join(dir, "capability.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "weather",
      connections: [],
      tools: { query: ["echo"] },
      // A hosted page and a source link, so the store page has both an
      // "Open" to lock and a repo link to leave alone.
      store: {
        name: "Weather",
        tagline: "Know which forecast to trust.",
        web: { path: "https://weather.example" },
        repo: "https://github.com/example/weather",
      },
    }),
  );
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
        ...serveExtra,
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
    store: new OAuthDiskStore(oauthDir),
    signingKey,
    allowedEmails: ["alice@example.com"],
    ...(access === undefined ? {} : { access }),
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
    ...(extra.storeName === undefined ? {} : { store: { name: extra.storeName } }),
    log: () => undefined,
  });
  cleanups.push(async () => {
    await http.close();
    await core.close();
  });
  return {
    url: `http://127.0.0.1:${String(http.port)}`,
    provider,
    google,
    core,
    http,
    oauthDir,
    signingKey,
    ...(access === undefined ? {} : { access }),
  };
}

/** A browser login as `email`: /login -> fake Google -> callback. */
async function browserLogin(url: string, google: FakeGoogle, email: string, next = "/"): Promise<Response> {
  google.setEmail(email);
  const login = await fetch(`${url}/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  const gstate = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
  return fetch(`${url}/auth/google/callback?state=${gstate}&code=ok`, { redirect: "manual" });
}

async function joinWaitlist(url: string, token: string): Promise<Response> {
  return fetch(`${url}/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "manual",
  });
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

/** Runs authorize -> google callback. An allowed account lands on the
 * consent page (200, with a one-time token in the form); a refused one is
 * sent straight back to the client with an error. */
async function reachConsent(
  url: string,
  clientId: string,
  challenge: string,
  redirectUri = "http://127.0.0.1:9999/cb",
): Promise<{ status: number; location: string | null; html: string; token: string }> {
  const authorize = await fetch(
    `${url}/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=client-state`,
    { redirect: "manual" },
  );
  expect(authorize.status).toBe(302);
  const googleUrl = new URL(authorize.headers.get("location") ?? "");
  const gstate = googleUrl.searchParams.get("state") ?? "";
  const callback = await fetch(`${url}/auth/google/callback?state=${gstate}&code=fake-code`, {
    redirect: "manual",
  });
  const html = callback.status === 200 ? await callback.text() : "";
  const token = /name="token" value="([^"]+)"/u.exec(html)?.[1] ?? "";
  return { status: callback.status, location: callback.headers.get("location"), html, token };
}

async function answerConsent(url: string, token: string, decision: "allow" | "deny"): Promise<Response> {
  return fetch(`${url}/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, decision }).toString(),
    redirect: "manual",
  });
}

/** authorize -> google -> consent (allowed); returns the redirect back to the client. */
async function loginThrough(url: string, clientId: string, challenge: string): Promise<URL> {
  const consent = await reachConsent(url, clientId, challenge);
  if (consent.status === 302) {
    return new URL(consent.location ?? "");
  }
  expect(consent.status).toBe(200);
  expect(consent.token).not.toBe("");
  const answer = await answerConsent(url, consent.token, "allow");
  expect(answer.status).toBe(303);
  return new URL(answer.headers.get("location") ?? "");
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
    const consent = await reachConsent(harness.url, client.client_id, challenge);
    // no consent page for a refused account: straight back to the client
    expect(consent.status).toBe(302);
    const back = new URL(consent.location ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("asks before a code goes anywhere: the page names the client and the destination, and only Allow mints one", async () => {
    const harness = await startHarness();
    // Registration is open, so this is the attack: a client anyone made,
    // pointing at a host the person has never heard of.
    const registered = await fetch(`${harness.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        client_name: "Totally Legit Assistant",
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const { challenge } = pkcePair();

    const consent = await reachConsent(harness.url, client.client_id, challenge, "https://evil.example/cb");
    expect(consent.status).toBe(200);
    expect(consent.location).toBeNull();
    expect(consent.html).toContain("Totally Legit Assistant");
    expect(consent.html).toContain("https://evil.example");
    expect(consent.html).toContain("alice@example.com");
    expect(consent.token).not.toBe("");

    // Deny: the client hears access_denied and never sees a code.
    const denied = await answerConsent(harness.url, consent.token, "deny");
    expect(denied.status).toBe(303);
    const back = new URL(denied.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe("https://evil.example/cb");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
    expect(back.searchParams.get("code")).toBeNull();

    // The token was single use: a second answer, even Allow, is refused.
    const replay = await answerConsent(harness.url, consent.token, "allow");
    expect(replay.status).toBe(400);
    // And a made-up token gets nothing either.
    const forged = await answerConsent(harness.url, "0".repeat(48), "allow");
    expect(forged.status).toBe(400);

    // A fresh round, allowed this time, does carry a code.
    const again = await reachConsent(harness.url, client.client_id, challenge, "https://evil.example/cb");
    const allowed = await answerConsent(harness.url, again.token, "allow");
    expect(allowed.status).toBe(303);
    const withCode = new URL(allowed.headers.get("location") ?? "");
    expect(withCode.searchParams.get("code")).not.toBeNull();
    expect(withCode.searchParams.get("state")).toBe("client-state");
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
    // The identity Caddy copies onto the fronted app's request.
    expect(verifyOk.headers.get("x-forwarded-user")).toBe("alice@example.com");
    const verifyMissing = await fetch(`${harness.url}/session/verify`);
    expect(verifyMissing.status).toBe(401);
    expect(verifyMissing.headers.get("x-forwarded-user")).toBeNull();
    const verifyBrowser = await fetch(`${harness.url}/session/verify`, {
      headers: { Accept: "text/html", "X-Forwarded-Uri": "/dashboard" },
      redirect: "manual",
    });
    expect(verifyBrowser.status).toBe(302);
    expect(verifyBrowser.headers.get("location")).toContain("next=%2Fdashboard");
  });

  it("keeps the post-login destination on this origin", async () => {
    const harness = await startHarness();
    // `/\\evil.example` reads as `//evil.example` in a browser: an open
    // redirect dressed as a path. Both spellings fall back to the store page.
    for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example", "evil"]) {
      const login = await fetch(`${harness.url}/login?next=${encodeURIComponent(bad)}`, {
        redirect: "manual",
      });
      const gstate = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const callback = await fetch(`${harness.url}/auth/google/callback?state=${gstate}&code=ok`, {
        redirect: "manual",
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/");
    }
    const logout = await fetch(`${harness.url}/logout`, { redirect: "manual" });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/");
  });

  it("scopes the session cookie to the domain when asked, and clears both on logout", async () => {
    const harness = await startHarness({ sessionCookieDomain: "127.0.0.1" });
    const login = await fetch(`${harness.url}/login?next=/`, { redirect: "manual" });
    const gstate = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await fetch(`${harness.url}/auth/google/callback?state=${gstate}&code=ok`, {
      redirect: "manual",
    });
    const setCookie = callback.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Domain=127.0.0.1");
    const logout = await fetch(`${harness.url}/logout`, { redirect: "manual" });
    const cleared = logout.headers.getSetCookie();
    expect(cleared.some((c) => c.includes("Domain=127.0.0.1"))).toBe(true);
    expect(cleared.some((c) => !c.includes("Domain="))).toBe(true);
  });

  it("sends a browser on a sibling host to this host's login and back", async () => {
    // A real hostname: WHATWG URL parsing treats `x.127.0.0.1` as a bad IPv4.
    const harness = await startHarness({
      publicUrl: "https://gw.example.test",
      allowedHosts: ["127.0.0.1"],
    });
    // Caddy's forward_auth on cal.<host> forwards the original host and uri.
    const verify = await fetch(`${harness.url}/session/verify`, {
      headers: { Accept: "text/html", "X-Forwarded-Host": "cal.gw.example.test", "X-Forwarded-Uri": "/?x=1" },
      redirect: "manual",
    });
    expect(verify.status).toBe(302);
    const login = new URL(verify.headers.get("location") ?? "");
    expect(login.origin + login.pathname).toBe("https://gw.example.test/login");
    expect(login.searchParams.get("next")).toBe("https://cal.gw.example.test/?x=1");

    const roundTrip = async (next: string): Promise<string | null> => {
      const start = await fetch(`${harness.url}/login?next=${encodeURIComponent(next)}`, {
        redirect: "manual",
      });
      const gstate = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const callback = await fetch(`${harness.url}/auth/google/callback?state=${gstate}&code=ok`, {
        redirect: "manual",
      });
      return callback.headers.get("location");
    };
    // The destination survives only because it is this site, over https.
    expect(await roundTrip("https://cal.gw.example.test/?x=1")).toBe("https://cal.gw.example.test/?x=1");
    expect(await roundTrip("https://gw.example.test/weather")).toBe("https://gw.example.test/weather");
    for (const bad of [
      "https://evil.example/",
      "http://cal.gw.example.test/",
      "https://gw.example.test.evil.example/",
      "https://user:pw@cal.gw.example.test/",
    ]) {
      expect(await roundTrip(bad)).toBe("/");
    }
  });

  it("persists clients and refresh families across a store reload", async () => {
    const dir = tempDir();
    const store = new OAuthDiskStore(dir);
    store.putClient({ client_id: "abc", redirect_uris: ["http://x/cb"] } as never);
    store.putRefresh("tok1", {
      family: "fam1",
      clientId: "abc",
      email: "alice@example.com",
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

it("rechecks allowedEmails for access, refresh and browser sessions and persists logout revocation", async () => {
  const dir = tempDir();
  const signingKey = randomBytes(32);
  const opts = {
    issuerUrl: "https://gw.example.com", signingKey,
    google: { clientId: "id", clientSecret: "secret" },
    accessTokenTtlSec: 3600, refreshTokenTtlSec: 86400,
    scopesSupported: ["mcp"], log: () => undefined,
  };
  const store = new OAuthDiskStore(dir);
  const before = new GatewayOAuthProvider({ ...opts, store, allowedEmails: ["alice@example.com"] });
  const cookie = signJwt(signingKey, { iss: opts.issuerUrl, aud: "session", sub: "alice@example.com", expiresInSec: 3600 });
  const access = signJwt(signingKey, { iss: opts.issuerUrl, aud: "mcp", sub: "alice@example.com", client_id: "client", expiresInSec: 3600 });
  store.putRefresh("refresh", { family: "family", clientId: "client", email: "alice@example.com", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  expect(before.verifySessionCookie(cookie)).toBe("alice@example.com");
  expect((await before.verifyAccessToken(access)).extra?.["user"]).toBe("alice@example.com");
  const removed = new GatewayOAuthProvider({ ...opts, store, allowedEmails: [] });
  expect(() => removed.verifyAccessToken(access)).toThrow();
  expect(removed.verifySessionCookie(cookie)).toBeNull();
  expect(() => removed.exchangeRefreshToken({ client_id: "client", redirect_uris: ["https://client.example/cb"] }, "refresh")).toThrow();
  expect(store.getRefresh("refresh")?.revoked).toBe(true);
  before.revokeSessionCookie(cookie);
  const restarted = new GatewayOAuthProvider({ ...opts, store: new OAuthDiskStore(dir), allowedEmails: ["alice@example.com"] });
  expect(restarted.verifySessionCookie(cookie)).toBeNull();
});

it("invalidates a browser token on logout, including a copied cookie", async () => {
  const harness = await startHarness();
  const login = await fetch(`${harness.url}/login`, { redirect: "manual" });
  const state = new URL(login.headers.get("location")!).searchParams.get("state");
  const callback = await fetch(`${harness.url}/auth/google/callback?state=${state}&code=ok`, { redirect: "manual" });
  const cookie = callback.headers.get("set-cookie")!.split(";")[0]!;
  expect((await fetch(`${harness.url}/session/verify`, { headers: { Cookie: cookie } })).status).toBe(204);
  await fetch(`${harness.url}/logout`, { headers: { Cookie: cookie }, redirect: "manual" });
  expect((await fetch(`${harness.url}/session/verify`, { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await fetch(harness.url, { headers: { Cookie: "gw_session=%zz" } })).status).toBe(200);
});


it("rejects redirect parser control-character and backslash tricks", () => {
  for (const value of ["/\t/evil.example", "/\r/evil.example", "/\n/evil.example", "/\\evil.example", "//evil.example", "https://evil.example"]) {
    expect(safeNext(value, "gw.example.com")).toBeUndefined();
  }
  expect(safeNext("/views?x=1", "gw.example.com")).toBe("/views?x=1");
});

describe("waiting list", () => {
  /** The cookie the callback hands an uninvited browser. */
  function waitlistCookie(response: Response): string {
    const raw = response.headers.getSetCookie().find((c) => c.startsWith("gw_waitlist=")) ?? "";
    return raw.split(";")[0] ?? "";
  }

  async function storePage(url: string, cookie: string): Promise<string> {
    const page = await fetch(url, { headers: { Accept: "text/html", Cookie: cookie } });
    expect(page.status).toBe(200);
    return page.text();
  }

  it("sends an uninvited browser to the store page with a banner, the hosted apps locked and the source links live", async () => {
    const harness = await startHarness({}, { waitlist: true, storeName: "Toys" });
    const access = harness.access!;

    const refused = await browserLogin(harness.url, harness.google, "Guest@Example.com", "/views");
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe("/");
    expect(refused.headers.getSetCookie().some((c) => c.startsWith("gw_session="))).toBe(false);
    const cookie = waitlistCookie(refused);
    expect(cookie).toContain("gw_waitlist=");

    const html = await storePage(harness.url, cookie);
    expect(html).toContain("Toys is in a limited preview");
    expect(html).toContain("guest@example.com");
    expect(html).toContain("Join the waitlist");
    expect(html).toContain("· waitlist</span>");
    expect(html).not.toContain('href="https://weather.example"');
    expect(html).toContain('href="https://github.com/example/weather"');
    expect(html).toContain('href="/logout"');
    const token = /name="token" value="([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(access.listWaitlist()).toEqual([]);

    // The JSON twin says the same, minus the token.
    const json = (await (await fetch(harness.url, { headers: { Cookie: cookie } })).json()) as {
      data: { waitlist?: Record<string, unknown>; apps: { href?: string }[] };
    };
    expect(json.data.waitlist).toEqual({ email: "guest@example.com", status: "offer" });

    // Nothing behind forward_auth opens on the waitlist cookie.
    expect((await fetch(`${harness.url}/session/verify`, { headers: { Cookie: cookie } })).status).toBe(401);

    const joined = await joinWaitlist(harness.url, token);
    expect(joined.status).toBe(303);
    expect(joined.headers.get("location")).toBe("/");
    expect(access.listWaitlist().map((entry) => entry.email)).toEqual(["guest@example.com"]);
    expect(access.isAllowed("guest@example.com")).toBe(false);

    const waiting = await storePage(harness.url, cookie);
    expect(waiting).toContain("</strong> is on the waitlist as of");
    expect(waiting).not.toContain('name="token"');
    expect(waiting).toContain("· waitlist</span>");

    // Asking again keeps the first place; a fresh sign-in lands on the same
    // banner with a fresh cookie.
    const first = access.waitlistEntry("guest@example.com");
    expect((await joinWaitlist(harness.url, token)).status).toBe(303);
    expect(access.waitlistEntry("guest@example.com")).toEqual(first);
    const again = await browserLogin(harness.url, harness.google, "guest@example.com");
    expect(again.status).toBe(302);
    expect(await storePage(harness.url, waitlistCookie(again))).toContain("</strong> is on the waitlist as of");

    // Sign out forgets the address: back to the public page.
    const logout = await fetch(`${harness.url}/logout`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(logout.headers.getSetCookie().some((c) => c.startsWith("gw_waitlist=") && c.includes("Expires="))).toBe(true);
    const anonymous = await storePage(harness.url, "");
    expect(anonymous).not.toContain('class="notice');
    expect(anonymous).toContain('href="https://weather.example"');
  });

  it("lets an invitation through on the next sign-in, and a withdrawn one out on the next check", async () => {
    const harness = await startHarness({}, { waitlist: true });
    const access = harness.access!;
    const refused = await browserLogin(harness.url, harness.google, "guest@example.com");
    const cookie = waitlistCookie(refused);
    await joinWaitlist(harness.url, /^gw_waitlist=(.*)$/u.exec(cookie)?.[1] ?? "");
    expect(access.listWaitlist()).toHaveLength(1);

    // Invited from "another process": a second store on the same files.
    const cli = new AccessStore(harness.oauthDir, ["alice@example.com"]);
    expect(cli.invite("guest@example.com")).toEqual({ status: "invited", fromWaitlist: true });

    // The banner turns into the way in, and the cookie is cleared.
    const invited = await fetch(harness.url, { headers: { Accept: "text/html", Cookie: cookie } });
    const html = await invited.text();
    expect(html).toContain("You're in!");
    expect(html).not.toContain("· waitlist</span>");
    expect(invited.headers.getSetCookie().some((c) => c.startsWith("gw_waitlist=") && c.includes("Expires="))).toBe(true);

    const login = await browserLogin(harness.url, harness.google, "guest@example.com", "/views");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/views");
    const session = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(session).toContain("gw_session=");
    const verify = await fetch(`${harness.url}/session/verify`, { headers: { Cookie: session } });
    expect(verify.status).toBe(204);
    expect(verify.headers.get("x-forwarded-user")).toBe("guest@example.com");
    // A session beats a leftover waitlist cookie.
    expect(await storePage(harness.url, `${session}; ${cookie}`)).not.toContain('class="notice');

    expect(cli.uninvite("guest@example.com")).toBe("removed");
    expect((await fetch(`${harness.url}/session/verify`, { headers: { Cookie: session } })).status).toBe(401);
    expect((await browserLogin(harness.url, harness.google, "guest@example.com")).headers.get("location")).toBe("/");
  });

  it("refuses a join without a live token, and one for an account already in", async () => {
    const harness = await startHarness({}, { waitlist: true });
    const issuer = harness.url.replace(/:\d+$/u, "");
    expect((await joinWaitlist(harness.url, "")).status).toBe(400);
    expect((await joinWaitlist(harness.url, "not.a.token")).status).toBe(400);
    const stale = signJwt(harness.signingKey, { iss: issuer, aud: "waitlist", sub: "guest@example.com", expiresInSec: -1 });
    expect((await joinWaitlist(harness.url, stale)).status).toBe(400);
    // A session token is not a waitlist token, whatever it says — in the
    // form or as the cookie.
    const session = signJwt(harness.signingKey, { iss: issuer, aud: "session", sub: "guest@example.com", expiresInSec: 600 });
    expect((await joinWaitlist(harness.url, session)).status).toBe(400);
    const page = await fetch(harness.url, { headers: { Accept: "text/html", Cookie: `gw_waitlist=${session}` } });
    expect(await page.text()).not.toContain('class="notice');

    const refused = await browserLogin(harness.url, harness.google, "guest@example.com");
    const token = /^gw_waitlist=(.*)$/u.exec(waitlistCookie(refused))?.[1] ?? "";
    harness.access!.invite("guest@example.com");
    const late = await joinWaitlist(harness.url, token);
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("already invited");
    expect(harness.access!.listWaitlist()).toEqual([]);
  });

  it("tells an MCP client where the waiting list is, and keeps the old refusal without one", async () => {
    const withList = await startHarness({}, { waitlist: true });
    withList.google.setEmail("guest@example.com");
    const client = await registerClient(withList.url);
    const consent = await reachConsent(withList.url, client.client_id, pkcePair().challenge);
    expect(consent.status).toBe(302);
    const back = new URL(consent.location ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toContain("waiting list");
    expect(withList.access!.listWaitlist()).toEqual([]);

    const without = await startHarness();
    const refused = await browserLogin(without.url, without.google, "guest@example.com");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("not allowed");
    expect((await joinWaitlist(without.url, "anything")).status).toBe(400);
    // A forged waitlist cookie means nothing to a gateway without a list.
    const forged = signJwt(without.signingKey, { iss: without.url.replace(/:\d+$/u, ""), aud: "waitlist", sub: "guest@example.com", expiresInSec: 600 });
    const page = await fetch(without.url, { headers: { Accept: "text/html", Cookie: `gw_waitlist=${forged}` } });
    expect(await page.text()).not.toContain('class="notice');
  });
});

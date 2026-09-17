import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openVault } from "@dvd-toy-box/vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityEgressInfo } from "../src/egress.js";
import { GoogleConnectFlow } from "../src/http/connect.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CALSYNC_INFO: CapabilityEgressInfo = {
  egress: [],
  connections: [
    { provider: "google", slot: "personal", optional: false, actions: ["read", "write"] },
    { provider: "google", slot: "work", optional: false, actions: ["read", "write"] },
  ],
  profileFields: [],
  peerCalls: new Map(),
  queryTools: [],
};

function makeFlow(options: {
  upstream?: (url: string, init?: RequestInit) => Response;
  now?: () => number;
}): { flow: GoogleConnectFlow; vaultHome: string; upstream: ReturnType<typeof vi.fn> } {
  const dir = mkdtempSync(join(tmpdir(), "gateway-connect-"));
  dirs.push(dir);
  const vaultHome = join(dir, "vault");
  const upstream = vi.fn(
    options.upstream ??
      (() =>
        new Response(JSON.stringify({ refresh_token: "1//fresh", access_token: "ya29.x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })),
  );
  const flow = new GoogleConnectFlow({
    publicUrl: "https://gw.example.com/",
    creds: { clientId: "cid", clientSecret: "csecret" },
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    specs: new Map([["calsync", CALSYNC_INFO]]),
    env: { VAULT_HOME: vaultHome, VAULT_SECRETS_BACKEND: "file" } as NodeJS.ProcessEnv,
    log: () => undefined,
    fetchImpl: upstream as unknown as typeof fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { flow, vaultHome, upstream };
}

function stateOf(redirectTo: string): string {
  const state = new URL(redirectTo).searchParams.get("state");
  expect(state).toBeTruthy();
  return state ?? "";
}

describe("GoogleConnectFlow", () => {
  it("rejects malformed and unmatched slots up front", () => {
    const { flow } = makeFlow({});
    expect(flow.start(undefined)).toMatchObject({ ok: false });
    expect(flow.start("Not A Slot")).toMatchObject({ ok: false });
    const unmatched = flow.start("acme_gmail");
    expect(unmatched.ok).toBe(false);
    if (!unmatched.ok) {
      expect(unmatched.message).toContain("acme_gmail");
    }
  });

  it("builds an offline-consent authorize URL with PKCE and single-use state", async () => {
    const { flow, upstream } = makeFlow({});
    const started = flow.start("acme_personal");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const url = new URL(started.redirectTo);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://gw.example.com/auth/google/connect/callback",
    );
    expect(url.searchParams.get("client_id")).toBe("cid");

    const state = stateOf(started.redirectTo);
    const first = await flow.handleCallback({ state, code: "auth-code" });
    expect(first.ok).toBe(true);
    const replay = await flow.handleCallback({ state, code: "auth-code" });
    expect(replay).toMatchObject({ ok: false });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("stores the refresh token under the slot and grants every declaring capability", async () => {
    const { flow, vaultHome, upstream } = makeFlow({});
    const started = flow.start("acme_personal");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const result = await flow.handleCallback({ state: stateOf(started.redirectTo), code: "auth-code" });
    expect(result).toMatchObject({
      ok: true,
      slot: "acme_personal",
      granted: [{ capability: "calsync", actions: ["read", "write"] }],
    });

    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("client_secret")).toBe("csecret");
    expect(form.get("code_verifier")).toBeTruthy();

    const vault = openVault({ home: vaultHome, backend: "file" });
    expect(await vault.getSecret("google:acme_personal")).toBe("1//fresh");
    expect((await vault.status("google:acme_personal")).kind).toBe("oauth");
    expect(
      vault.checkGrant({ capability: "calsync", connectionId: "google:acme_personal", action: "write" }),
    ).toBe(true);
  });

  it("carries a same-site return destination through consent, and drops any other", async () => {
    const { flow } = makeFlow({});
    const started = flow.start("acme_personal", "https://cal.gw.example.com/?x=1");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const done = await flow.handleCallback({ state: stateOf(started.redirectTo), code: "auth-code" });
    expect(done).toMatchObject({ ok: true, next: "https://cal.gw.example.com/?x=1" });

    // A cancelled consent still knows where home is.
    const again = flow.start("acme_personal", "/somewhere");
    if (!again.ok) {
      return;
    }
    const denied = await flow.handleCallback({ state: stateOf(again.redirectTo), error: "access_denied" });
    expect(denied).toMatchObject({ ok: false, next: "/somewhere" });

    for (const bad of ["https://evil.example/", "http://cal.gw.example.com/", "//evil.example", 42]) {
      const s = flow.start("acme_personal", bad);
      if (!s.ok) {
        return;
      }
      const r = await flow.handleCallback({ state: stateOf(s.redirectTo), code: "auth-code" });
      expect(r.ok).toBe(true);
      expect((r as { next?: string }).next).toBeUndefined();
    }
  });

  it("connects base role slots too, not only tenant instances", async () => {
    const { flow, vaultHome } = makeFlow({});
    const started = flow.start("work");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const result = await flow.handleCallback({ state: stateOf(started.redirectTo), code: "c" });
    expect(result).toMatchObject({ ok: true, slot: "work" });
    const vault = openVault({ home: vaultHome, backend: "file" });
    expect(await vault.getSecret("google:work")).toBe("1//fresh");
  });

  it("fails crisply on expiry, provider errors, and a missing refresh token", async () => {
    let clock = 1_000_000;
    const expiring = makeFlow({ now: () => clock });
    const started = expiring.flow.start("acme_personal");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    clock += 11 * 60_000;
    const expired = await expiring.flow.handleCallback({
      state: stateOf(started.redirectTo),
      code: "c",
    });
    expect(expired).toMatchObject({ ok: false });

    const { flow } = makeFlow({
      upstream: () =>
        new Response(JSON.stringify({ access_token: "ya29.x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const denied = await flow.handleCallback({ state: "whatever", error: "access_denied" });
    expect(denied).toMatchObject({ ok: false });

    const noRefresh = flow.start("acme_personal");
    expect(noRefresh.ok).toBe(true);
    if (!noRefresh.ok) {
      return;
    }
    const missing = await flow.handleCallback({ state: stateOf(noRefresh.redirectTo), code: "c" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain("refresh token");
    }
  });
});

it("binds connect state to the signed-in user", async () => {
  const { flow, upstream } = makeFlow({});
  const started = flow.start("personal", "/", "alice");
  if (!started.ok) throw new Error(started.message);
  expect((await flow.handleCallback({ state: stateOf(started.redirectTo), code: "ok" }, "bob")).ok).toBe(false);
  expect(upstream).not.toHaveBeenCalled();
});

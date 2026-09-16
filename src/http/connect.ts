// Onboarding for brokered Google connections: a session-gated consent flow
// that stores the resulting refresh token in the vault under the requested
// slot — tenant instances (`acme_personal`) included — and grants every
// capability whose manifest declares the matched role. The secret never
// transits a tool argument or a form; it goes Google -> this process -> vault.
//
// Must use the same OAuth client as the broker's /token exchange (the
// egress `oauth.google` creds): a refresh token only redeems against the
// client that minted it.

import { createHash, randomBytes } from "node:crypto";

import { connectionId, openVault, type Vault } from "@local/vault";

import { safeNext } from "./oauth/provider.js";

import {
  slotMatchesDeclared,
  type CapabilityEgressInfo,
  type GoogleOAuthCreds,
} from "../egress.js";

const DEFAULT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 32;
const SLOT_TOKEN = /^[a-z][a-z0-9_-]*$/u;

export interface GoogleConnectFlowOptions {
  publicUrl: string;
  creds: GoogleOAuthCreds;
  scopes: readonly string[];
  specs: ReadonlyMap<string, CapabilityEgressInfo>;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface GrantTarget {
  capability: string;
  actions: string[];
}

export type ConnectStart =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string };

export type ConnectResult =
  | { ok: true; slot: string; granted: GrantTarget[]; next?: string | undefined }
  | { ok: false; message: string; next?: string | undefined };

interface PendingConnect {
  slot: string;
  verifier: string;
  expiresAtMs: number;
  /** Where to send the person afterwards (the app that started this). */
  next?: string | undefined;
}

export class GoogleConnectFlow {
  private readonly pending = new Map<string, PendingConnect>();
  private readonly vault: Vault;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleConnectFlowOptions) {
    this.vault = openVault({ env: options.env });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get redirectUri(): string {
    return `${this.options.publicUrl.replace(/\/+$/u, "")}/auth/google/connect/callback`;
  }

  /** Which capabilities a stored `google:<slot>` connection would be granted
   * to, via the declared role the slot instantiates. Empty when no mounted
   * capability declares a matching google connection. */
  targetsFor(slot: string): GrantTarget[] {
    const targets: GrantTarget[] = [];
    for (const [capability, info] of this.options.specs) {
      for (const need of info.connections) {
        if (need.provider === "google" && slotMatchesDeclared(need.slot, slot)) {
          targets.push({ capability, actions: [...(need.actions ?? [])] });
        }
      }
    }
    return targets;
  }

  /**
   * `next`, when given, is where the person goes after consent — the setup
   * page that sent them, so they can see the connection land. It must be on
   * this site (a path, or https on this host or a subdomain of it); anything
   * else is dropped and the plain notice page shows instead.
   */
  start(rawSlot: unknown, rawNext?: unknown): ConnectStart {
    const slot = typeof rawSlot === "string" ? rawSlot.trim().toLowerCase() : "";
    const next =
      typeof rawNext === "string" ? safeNext(rawNext, new URL(this.options.publicUrl).hostname) : undefined;
    if (slot === "" || !SLOT_TOKEN.test(slot)) {
      return {
        ok: false,
        message:
          "pass ?slot=<role> or ?slot=<tenant>_<role> (lowercase letters, digits, '_', '-')",
      };
    }
    if (this.targetsFor(slot).length === 0) {
      return {
        ok: false,
        message: `no capability declares a google connection matching slot '${slot}'`,
      };
    }
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      return { ok: false, message: "too many pending connects; try again in a few minutes" };
    }
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, {
      slot,
      verifier,
      expiresAtMs: this.now() + STATE_TTL_MS,
      ...(next === undefined ? {} : { next }),
    });
    const url = new URL(this.options.authorizeUrl ?? DEFAULT_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.options.creds.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: this.options.scopes.join(" "),
      // offline + consent is what makes Google return a refresh token; the
      // broker mints everything after this from that one credential.
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { ok: true, redirectTo: url.toString() };
  }

  async handleCallback(query: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<ConnectResult> {
    const entry = query.state === undefined ? undefined : this.pending.get(query.state);
    if (query.state !== undefined) {
      this.pending.delete(query.state);
    }
    const next = entry?.next;
    if (query.error !== undefined) {
      return { ok: false, message: `Google returned an error: ${query.error}`, next };
    }
    if (entry === undefined || entry.expiresAtMs <= this.now()) {
      return { ok: false, message: "unknown or expired connect attempt; start over" };
    }
    if (query.code === undefined || query.code === "") {
      return { ok: false, message: "Google returned no authorization code", next };
    }

    let exchange: Response;
    try {
      exchange = await this.fetchImpl(this.options.tokenUrl ?? DEFAULT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        cache: "no-store",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: query.code,
          code_verifier: entry.verifier,
          client_id: this.options.creds.clientId,
          client_secret: this.options.creds.clientSecret,
          redirect_uri: this.redirectUri,
        }).toString(),
      });
    } catch {
      return { ok: false, message: "the token exchange with Google failed; try again", next };
    }
    let payload: { refresh_token?: unknown } = {};
    try {
      payload = (await exchange.json()) as typeof payload;
    } catch {
      // handled by the shape check below
    }
    if (!exchange.ok || typeof payload.refresh_token !== "string" || payload.refresh_token === "") {
      return {
        ok: false,
        message: exchange.ok
          ? "Google returned no refresh token; remove this app's prior grant at myaccount.google.com/permissions and try again"
          : `token exchange returned HTTP ${String(exchange.status)}`,
        next,
      };
    }

    const granted = this.targetsFor(entry.slot);
    if (granted.length === 0) {
      return {
        ok: false,
        message: `no capability declares a google connection matching slot '${entry.slot}' anymore`,
        next,
      };
    }
    await this.vault.putSecret({
      provider: "google",
      slot: entry.slot,
      kind: "oauth",
      secret: payload.refresh_token,
      scopes: [...this.options.scopes],
    });
    const connection = connectionId("google", entry.slot);
    for (const target of granted) {
      this.vault.putGrant({
        capability: target.capability,
        connectionId: connection,
        ...(target.actions.length === 0 ? {} : { actions: target.actions }),
      });
    }
    this.options.log(
      `[gateway] connect: stored ${connection} and granted ${granted
        .map((target) => target.capability)
        .join(", ")}`,
    );
    return { ok: true, slot: entry.slot, granted, next };
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAtMs <= now) {
        this.pending.delete(state);
      }
    }
  }
}

// The gateway as OAuth authorization server (stage 2). Google is only the
// identity check inside authorize(): the gateway redirects there, verifies
// the returned email against allowedEmails, and mints its OWN tokens — HS256
// JWT access tokens plus rotating refresh tokens with family revocation
// (replaying a rotated token kills its whole family). The same Google login
// also backs browser sessions (a cookie) for the views/dashboard surfaces.

import { randomBytes, randomUUID } from "node:crypto";

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  DEFAULT_GOOGLE_ENDPOINTS,
  exchangeGoogleCode,
  googleLoginUrl,
  type GoogleEndpoints,
  type GoogleLoginCreds,
} from "./google.js";
import { signJwt, verifyJwt } from "./jwt.js";
import type { OAuthDiskStore } from "./store.js";

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
/** Anyone can start a login, so the pending map is bounded: past this many
 * in-flight attempts the oldest is dropped (its user starts over). */
const MAX_PENDING = 5000;

/**
 * A post-login destination must stay on this site. A relative path needs a
 * single leading slash: a second slash OR a backslash is refused because
 * browsers read `/\evil.example` as `//evil.example`, a protocol-relative
 * URL, an open redirect dressed as a path. An absolute URL is allowed only
 * for this host or a subdomain of it, over https: a fronted app on
 * cal.<host> sends people here to sign in and wants them back.
 */
export function safeNext(next: string, publicHost: string): string | undefined {
  if (/[\u0000-\u0020\u007f\\]/u.test(next)) {
    return undefined;
  }
  if (/^\/(?![/\\])/u.test(next)) {
    return next;
  }
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const site = publicHost.toLowerCase();
  return host === site || host.endsWith(`.${site}`) ? url.toString() : undefined;
}
export const SESSION_COOKIE = "gw_session";

type Pending =
  | {
      kind: "mcp";
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state?: string;
      scopes: string[];
      resource?: string;
      expiresAt: number;
    }
  | { kind: "browser"; next: string; expiresAt: number };

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  email: string;
  resource?: string;
  expiresAt: number;
}

/** An MCP authorization that Google has confirmed and the person has not
 * yet answered: everything needed to mint the code once they allow it. */
interface ConsentRecord extends CodeRecord {
  state?: string;
}

/** What the consent page shows: who is asking, as whom, and where the
 * code will be sent. */
export interface ConsentPrompt {
  token: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  email: string;
  scopes: string[];
}

export interface GatewayOAuthProviderOptions {
  issuerUrl: string;
  store: OAuthDiskStore;
  signingKey: Buffer;
  allowedEmails: readonly string[];
  google: GoogleLoginCreds;
  googleEndpoints?: GoogleEndpoints;
  fetchImpl?: typeof fetch;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  sessionTtlSec?: number;
  scopesSupported: string[];
  log: (line: string) => void;
}

export type GoogleCallbackResult =
  | {
      kind: "redirect";
      redirectTo: string;
      /** Present for browser logins: the session cookie value to set. */
      sessionCookie?: string;
    }
  /** An MCP client is asking: show the person the consent page. */
  | { kind: "consent"; consent: ConsentPrompt };

export class GatewayOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly issuer: string;
  private readonly endpoints: GoogleEndpoints;
  private readonly allowed: Set<string>;

  constructor(private readonly options: GatewayOAuthProviderOptions) {
    this.issuer = options.issuerUrl.replace(/\/+$/u, "");
    this.endpoints = options.googleEndpoints ?? DEFAULT_GOOGLE_ENDPOINTS;
    this.allowed = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.options.store;
    return {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: (client) => {
        store.putClient(client as OAuthClientInformationFull);
        return client as OAuthClientInformationFull;
      },
    };
  }

  private googleRedirectUri(): string {
    return `${this.issuer}/auth/google/callback`;
  }

  private newState(entry: Pending): string {
    this.prune();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.pending.delete(oldest);
    }
    const state = randomBytes(24).toString("hex");
    this.pending.set(state, entry);
    return state;
  }

  authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const entry: Pending = {
      kind: "mcp",
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? this.options.scopesSupported,
      expiresAt: Date.now() + PENDING_TTL_MS,
      ...(params.state === undefined ? {} : { state: params.state }),
      ...(params.resource === undefined ? {} : { resource: params.resource.href }),
    };
    const state = this.newState(entry);
    res.redirect(googleLoginUrl(this.endpoints, this.options.google, this.googleRedirectUri(), state));
    return Promise.resolve();
  }

  /** Starts a browser (cookie) login; `next` must be a relative path. */
  startBrowserLogin(next: string): string {
    const destination = safeNext(next, new URL(this.issuer).hostname) ?? "/";
    const state = this.newState({ kind: "browser", next: destination, expiresAt: Date.now() + PENDING_TTL_MS });
    return googleLoginUrl(this.endpoints, this.options.google, this.googleRedirectUri(), state);
  }

  async handleGoogleCallback(query: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<GoogleCallbackResult> {
    this.prune();
    const entry = query.state === undefined ? undefined : this.pending.get(query.state);
    if (entry === undefined || entry.expiresAt < Date.now()) {
      throw new Error("login attempt is unknown or expired; start over");
    }
    this.pending.delete(query.state ?? "");

    const clientRedirect = (params: Record<string, string>): string => {
      if (entry.kind !== "mcp") {
        throw new Error("unreachable");
      }
      const url = new URL(entry.redirectUri);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      if (entry.state !== undefined) {
        url.searchParams.set("state", entry.state);
      }
      return url.toString();
    };

    if (query.error !== undefined || query.code === undefined) {
      if (entry.kind === "mcp") {
        return { kind: "redirect", redirectTo: clientRedirect({ error: "access_denied" }) };
      }
      throw new Error("google login was cancelled");
    }

    const identity = await exchangeGoogleCode(
      this.endpoints,
      this.options.google,
      query.code,
      this.googleRedirectUri(),
      this.options.fetchImpl ?? fetch,
    );
    if (!identity.emailVerified || !this.allowed.has(identity.email)) {
      this.options.log(`[gateway] oauth login rejected for ${identity.email} (not on allowedEmails)`);
      if (entry.kind === "mcp") {
        return {
          kind: "redirect",
          redirectTo: clientRedirect({
            error: "access_denied",
            error_description: "this account is not allowed on this gateway",
          }),
        };
      }
      throw new Error("this account is not allowed on this gateway");
    }

    if (entry.kind === "browser") {
      const cookie = signJwt(this.options.signingKey, {
        iss: this.issuer,
        aud: "session",
        sub: identity.email,
        expiresInSec: this.options.sessionTtlSec ?? 7 * 86_400,
      });
      return { kind: "redirect", redirectTo: entry.next, sessionCookie: cookie };
    }

    // Google confirmed who is here. Before a code goes anywhere the person
    // sees which client asked and where the code will be sent: registration
    // is open, so without this step any redirect_uri could collect a code
    // for whoever clicked a link — one account picker, no questions asked.
    if (this.consents.size >= MAX_PENDING) throw new Error("too many pending consents; try again later");
    const token = randomBytes(24).toString("hex");
    this.consents.set(token, {
      clientId: entry.clientId,
      redirectUri: entry.redirectUri,
      codeChallenge: entry.codeChallenge,
      scopes: entry.scopes,
      email: identity.email,
      expiresAt: Date.now() + CONSENT_TTL_MS,
      ...(entry.state === undefined ? {} : { state: entry.state }),
      ...(entry.resource === undefined ? {} : { resource: entry.resource }),
    });
    const client = this.options.store.getClient(entry.clientId);
    return {
      kind: "consent",
      consent: {
        token,
        clientId: entry.clientId,
        ...(client?.client_name === undefined ? {} : { clientName: client.client_name }),
        redirectUri: entry.redirectUri,
        email: identity.email,
        scopes: entry.scopes,
      },
    };
  }

  /** The person's answer to the consent page. Allow mints the code the
   * client is waiting for; deny sends it `access_denied`. The token is
   * single use either way. */
  completeConsent(token: string | undefined, decision: "allow" | "deny"): { redirectTo: string } {
    this.prune();
    const record = token === undefined ? undefined : this.consents.get(token);
    if (record === undefined || record.expiresAt < Date.now()) {
      throw new Error("this sign-in has expired; start over from your client");
    }
    this.consents.delete(token ?? "");
    const url = new URL(record.redirectUri);
    if (record.state !== undefined) {
      url.searchParams.set("state", record.state);
    }
    if (decision !== "allow") {
      url.searchParams.set("error", "access_denied");
      return { redirectTo: url.toString() };
    }
    if (this.codes.size >= MAX_PENDING) throw new Error("too many pending authorizations; try again later");
    const code = randomBytes(24).toString("hex");
    this.codes.set(code, {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      scopes: record.scopes,
      email: record.email,
      expiresAt: Date.now() + CODE_TTL_MS,
      ...(record.resource === undefined ? {} : { resource: record.resource }),
    });
    url.searchParams.set("code", code);
    return { redirectTo: url.toString() };
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (record === undefined || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("authorization code is unknown or expired");
    }
    return Promise.resolve(record.codeChallenge);
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (record === undefined || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("authorization code is unknown or expired");
    }
    this.codes.delete(authorizationCode);
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return Promise.resolve(this.issueTokens(client.client_id, record.email, record.scopes, randomUUID()));
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const store = this.options.store;
    const record = store.getRefresh(refreshToken);
    const now = Math.floor(Date.now() / 1000);
    if (record === undefined || record.clientId !== client.client_id || record.expiresAt <= now) {
      throw new InvalidGrantError("refresh token is unknown or expired");
    }
    if (!this.allowed.has(record.email)) {
      store.revokeFamily(record.family);
      throw new InvalidGrantError("account is no longer allowed");
    }
    if (record.revoked === true) {
      throw new InvalidGrantError("refresh token was revoked");
    }
    if (record.rotatedTo !== undefined) {
      const killed = store.revokeFamily(record.family);
      this.options.log(
        `[gateway] refresh token REUSE detected for client ${client.client_id}; revoked family (${String(killed)} tokens)`,
      );
      throw new InvalidGrantError("refresh token reuse detected; the token family was revoked");
    }
    const tokens = this.issueTokens(record.clientId, record.email, record.scopes, record.family);
    record.rotatedTo = tokens.refresh_token ?? "";
    store.putRefresh(refreshToken, record);
    return Promise.resolve(tokens);
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = verifyJwt(this.options.signingKey, token, { iss: this.issuer, aud: "mcp" });
    if (payload === null || !this.allowed.has(payload.sub)) {
      throw new InvalidTokenError("access token is invalid or expired");
    }
    const scope = typeof payload["scope"] === "string" ? payload["scope"] : "";
    return Promise.resolve({
      token,
      clientId: typeof payload["client_id"] === "string" ? payload["client_id"] : "unknown",
      scopes: scope.split(" ").filter(Boolean),
      expiresAt: payload.exp,
      extra: { user: payload.sub },
    });
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.options.store.getRefresh(request.token);
    if (record !== undefined && record.clientId === client.client_id) {
      this.options.store.revokeFamily(record.family);
    }
    return Promise.resolve();
  }

  /** Browser-session check for the store page and the Caddy forward_auth endpoint. */
  verifySessionCookie(value: string | undefined): string | null {
    if (value === undefined || value === "") {
      return null;
    }
    const payload = verifyJwt(this.options.signingKey, value, { iss: this.issuer, aud: "session" });
    return payload === null || !this.allowed.has(payload.sub) ||
      this.options.store.isSessionRevoked(payload.jti) ? null : payload.sub;
  }

  revokeSessionCookie(value: string | undefined): void {
    if (value === undefined) return;
    const payload = verifyJwt(this.options.signingKey, value, { iss: this.issuer, aud: "session" });
    if (payload !== null) this.options.store.revokeSession(payload.jti, payload.exp);
  }

  private issueTokens(clientId: string, email: string, scopes: string[], family: string): OAuthTokens {
    if (!this.allowed.has(email)) throw new InvalidGrantError("account is no longer allowed");
    const accessTtl = this.options.accessTokenTtlSec;
    const accessToken = signJwt(this.options.signingKey, {
      iss: this.issuer,
      aud: "mcp",
      sub: email,
      client_id: clientId,
      scope: scopes.join(" "),
      expiresInSec: accessTtl,
    });
    const refreshToken = randomBytes(32).toString("hex");
    this.options.store.putRefresh(refreshToken, {
      family,
      clientId,
      email,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + this.options.refreshTokenTtlSec,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: accessTtl,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt < now) {
        this.pending.delete(key);
      }
    }
    for (const [key, record] of this.codes) {
      if (record.expiresAt < now) {
        this.codes.delete(key);
      }
    }
    for (const [key, record] of this.consents) {
      if (record.expiresAt < now) {
        this.consents.delete(key);
      }
    }
  }
}

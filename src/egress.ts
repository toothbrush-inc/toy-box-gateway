// The egress broker: a localhost HTTP service that attaches credentials to
// outbound requests (allowlisted hosts only) and exchanges OAuth refresh
// tokens for short-lived access tokens. Children authenticate with a
// per-capability bearer token handed to them via env; secrets never appear in
// requests, responses are scrubbed, and every call is audited (hosts, never
// full URLs).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import {
  CAPABILITY_PROVIDER,
  connectionId,
  FileProfileStore,
  openVault,
  resolveVaultHome,
  parseCapabilityManifest,
  PROFILE_CONNECTION_ID,
  PROFILE_MAX_FIELDS,
  PROFILE_PROVIDER,
  type ManifestConnectionNeed,
  type ManifestData,
  type ProfileStore,
  type Vault,
} from "@dvd-toy-box/vault";

import type { AuditEntry, AuditWriter } from "./audit.js";
import { userSlug } from "./call-scope.js";
import type { CapabilitySpec } from "./config.js";
import { redactErrorMessage } from "./redact.js";

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const MAX_INFLIGHT_PEER_CALLS = 8;

export interface EgressProviderSpec {
  provider: string;
  slot: string;
  hosts: string[];
  attach: { kind: "header" | "query"; name: string };
  hostRewrite?: Record<string, string>;
}

export interface CapabilityEgressInfo {
  egress: EgressProviderSpec[];
  connections: ManifestConnectionNeed[];
  data?: ManifestData;
  /** Declared profile fields (the actions of the profile:default connection). */
  profileFields: string[];
  /** Declared peer calls: producer capability id -> tools this capability may invoke. */
  peerCalls: Map<string, string[]>;
  /** This capability's own manifest tools.query (side-effect-free tools). */
  queryTools: string[];
}

export function newEgressToken(): string {
  return randomBytes(32).toString("hex");
}

const SLOT_TOKEN = /^[a-z][a-z0-9_-]*$/u;

/**
 * A requested slot matches a declared one exactly, or as a tenant-scoped
 * instance `<tenant>_<declared>` (calsync's tokenSlot contract). The manifest
 * declares the roles; the vault grants the instances — a tenant slot still
 * needs its own connection and grant, so accepting the shape here grants
 * nothing by itself.
 */
export function slotMatchesDeclared(declared: string, requested: string): boolean {
  if (requested === declared) {
    return true;
  }
  if (!requested.endsWith(`_${declared}`)) {
    return false;
  }
  return SLOT_TOKEN.test(requested.slice(0, -(declared.length + 1)));
}

/** Warn-only: a capability without a parseable manifest gets an empty entry. */
export function loadEgressSpecs(
  specs: readonly CapabilitySpec[],
  log: (line: string) => void,
): Map<string, CapabilityEgressInfo> {
  const out = new Map<string, CapabilityEgressInfo>();
  for (const spec of specs) {
    const info: CapabilityEgressInfo = {
      egress: [],
      connections: [],
      profileFields: [],
      peerCalls: new Map(),
      queryTools: [],
    };
    out.set(spec.id, info);
    if (spec.manifestPath === undefined) {
      continue;
    }
    try {
      const manifest = parseCapabilityManifest(
        JSON.parse(readFileSync(spec.manifestPath, "utf8")),
      );
      info.connections = manifest.connections;
      if (manifest.data !== undefined) {
        info.data = manifest.data;
      }
      info.queryTools = [...(manifest.tools?.query ?? [])];
      for (const need of manifest.connections) {
        if (need.provider === PROFILE_PROVIDER) {
          info.profileFields = [...(need.actions ?? [])];
          if (need.egress !== undefined) {
            log(
              `[gateway] ${spec.id}: ignoring egress spec on the profile connection (profile is never proxied)`,
            );
          }
          continue;
        }
        if (need.provider === CAPABILITY_PROVIDER) {
          info.peerCalls.set(need.slot, [...(need.actions ?? [])]);
          if (need.egress !== undefined) {
            log(
              `[gateway] ${spec.id}: ignoring egress spec on the capability:${need.slot} connection (peer calls are never proxied)`,
            );
          }
          continue;
        }
        if (need.egress !== undefined) {
          const entry: EgressProviderSpec = {
            provider: need.provider,
            slot: need.slot,
            hosts: need.egress.hosts,
            attach: need.egress.attach,
          };
          if (need.egress.hostRewrite !== undefined) {
            entry.hostRewrite = need.egress.hostRewrite;
          }
          info.egress.push(entry);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`[gateway] egress specs unavailable for ${spec.id}: ${redactErrorMessage(reason)}`);
    }
  }
  return out;
}

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
}

export function loadGoogleOAuthCreds(config: {
  envFile: string;
  clientIdVar: string;
  clientSecretVar: string;
}): GoogleOAuthCreds {
  const parsed = parseEnvFile(readFileSync(config.envFile, "utf8"));
  const clientId = parsed[config.clientIdVar];
  const clientSecret = parsed[config.clientSecretVar];
  if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") {
    throw new Error(
      `oauth env file ${config.envFile} does not define ${config.clientIdVar} and ${config.clientSecretVar}`,
    );
  }
  return { clientId, clientSecret };
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Structural view of an MCP CallToolResult, kept SDK-free on this side. */
export interface PeerToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

export interface EgressServerOptions {
  tokens: Map<string, string>;
  specs: Map<string, CapabilityEgressInfo>;
  env: NodeJS.ProcessEnv;
  audit: AuditWriter;
  log: (line: string) => void;
  oauth?: { google: GoogleOAuthCreds };
  commonsDir?: string;
  googleTokenUrl?: string;
  fetchImpl?: typeof fetch;
  /** Capability package.json version read at mount; null when unknown. */
  versionOf?: (capabilityId: string) => string | null;
  /** Resolves a call nonce back to the user it was minted for. Only the
   * gateway can do this, which is what makes the nonce unforgeable. */
  resolveCall?: (nonce: string | undefined) => string | undefined;
  /** Root for per-user data; defaults to a `users` dir beside the vault. */
  usersDir?: string;
  /** Routes a granted peer call to the mounted producer. Throws coded errors
   * (call_not_mounted, denied_by_policy, call_failed). */
  callPeer?: (
    producer: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number; user?: string },
  ) => Promise<PeerToolResult>;
}

interface Denial {
  status: number;
  code: string;
  message: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class EgressServer {
  private readonly server: HttpServer;
  private readonly vault: Vault;
  private readonly fetchImpl: typeof fetch;
  private readonly googleTokenUrl: string;
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly inflightCalls = new Map<string, number>();
  private readonly userProfiles = new Map<string, ProfileStore>();
  private readonly usersDir: string;
  private urlValue: string | null = null;

  constructor(private readonly options: EgressServerOptions) {
    this.vault = openVault({ env: options.env, grantMode: "explicit" });
    this.usersDir =
      options.usersDir ?? join(dirname(resolveVaultHome(undefined, options.env)), "users");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.googleTokenUrl = options.googleTokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get url(): string | null {
    return this.urlValue;
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("egress server failed to bind");
    }
    this.urlValue = `http://127.0.0.1:${String(address.port)}`;
    return this.urlValue;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = `${request.method ?? ""} ${request.url ?? ""}`;
    const known = ["POST /fetch", "POST /token", "POST /profile", "POST /commons", "POST /call"];
    if (!known.includes(route)) {
      reply(response, 404, { ok: false, error: { code: "egress_not_found", message: "unknown endpoint" } });
      return;
    }
    const capability = this.authenticate(request);
    if (capability === null) {
      reply(response, 401, {
        ok: false,
        error: { code: "egress_unauthorized", message: "missing or invalid egress token" },
      });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      reply(response, 400, {
        ok: false,
        error: { code: "egress_bad_request", message: "body must be a JSON object" },
      });
      return;
    }
    // The child echoes the nonce the gateway gave it; only we can resolve it,
    // so a capability cannot claim to be someone else by setting a header.
    const raw = request.headers["x-vault-call"];
    const nonce = typeof raw === "string" ? raw : undefined;
    const user = this.options.resolveCall?.(nonce);
    if (route === "POST /fetch") {
      await this.handleFetch(capability, body, response, user);
    } else if (route === "POST /token") {
      await this.handleToken(capability, body, response, user);
    } else if (route === "POST /profile") {
      await this.handleProfile(capability, body, response, user);
    } else if (route === "POST /call") {
      await this.handleCall(capability, body, response, user);
    } else {
      this.handleCommons(capability, body, response, user);
    }
  }

  /**
   * That user's own profile, or the shared one when the call arrives without
   * an identity — a capability run standalone, or the collector on its timer.
   * Grants stay on the shared vault: the operator grants a capability a field
   * once, and each user supplies their own value for it.
   */
  private profileFor(user: string | undefined): Record<string, string> {
    const slug = user === undefined ? null : userSlug(user);
    if (slug === null) {
      return this.vault.getProfile();
    }
    let store = this.userProfiles.get(slug);
    if (store === undefined) {
      store = new FileProfileStore(join(this.usersDir, slug, "profile.json"));
      this.userProfiles.set(slug, store);
    }
    return store.read();
  }

  /** Injects capability_version (when known) into every audit row. */
  private record(entry: AuditEntry): void {
    const version = this.options.versionOf?.(entry.capability) ?? null;
    this.options.audit.record(
      version === null ? entry : { ...entry, capability_version: version },
    );
  }

  private authenticate(request: IncomingMessage): string | null {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) {
      return null;
    }
    const presented = sha256(header.slice("Bearer ".length));
    for (const [token, capability] of this.options.tokens) {
      if (timingSafeEqual(presented, sha256(token))) {
        return capability;
      }
    }
    return null;
  }

  private async handleFetch(
    capability: string,
    body: Record<string, unknown>,
    response: ServerResponse,
    user: string | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    const provider = typeof body["provider"] === "string" ? body["provider"] : "";
    const requestedHost = hostnameOf(typeof body["url"] === "string" ? body["url"] : "");
    const audit = (outcome: "ok" | "denied" | "error", extras: { denied?: true; error_code?: string } = {}): void => {
      this.record({
        ts: new Date().toISOString(),
        capability,
        ...(user === undefined ? {} : { user }),
        tool: `egress:${provider === "" ? "unknown" : provider}`,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(extras.denied === true ? { denied_by: "egress" as const } : {}),
        ...(extras.error_code === undefined ? {} : { error_code: extras.error_code }),
        ...(requestedHost === null ? {} : { host: requestedHost }),
      });
    };
    const deny = (denial: Denial): void => {
      audit(denial.status === 502 ? "error" : "denied", {
        ...(denial.status === 502 ? {} : { denied: true as const }),
        error_code: denial.code,
      });
      reply(response, denial.status, { ok: false, error: { code: denial.code, message: denial.message } });
    };

    const method = body["method"];
    if (method !== undefined && method !== "GET") {
      deny({ status: 405, code: "egress_method_not_allowed", message: "only GET egress is supported" });
      return;
    }
    if (provider === PROFILE_PROVIDER) {
      deny({
        status: 403,
        code: "egress_denied",
        message: "the profile is never proxied through /fetch; use /profile",
      });
      return;
    }
    const slot = typeof body["slot"] === "string" && body["slot"] !== "" ? body["slot"] : "default";
    const rawUrl = typeof body["url"] === "string" ? body["url"] : "";
    if (provider === "" || rawUrl === "") {
      deny({ status: 400, code: "egress_bad_request", message: "provider and url are required" });
      return;
    }
    const entry = this.options.specs
      .get(capability)
      ?.egress.find((candidate) => candidate.provider === provider && candidate.slot === slot);
    if (entry === undefined) {
      deny({
        status: 403,
        code: "egress_denied",
        message: `capability '${capability}' does not declare egress for ${provider}:${slot}`,
      });
      return;
    }
    const connection = connectionId(provider, slot);
    if (!this.vault.checkGrant({ capability, connectionId: connection, action: "read" })) {
      deny({
        status: 403,
        code: "grant_missing",
        message: `capability '${capability}' has no grant for ${connection} (action read); grant the connection and retry`,
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      deny({ status: 400, code: "egress_bad_request", message: "url is not a valid URL" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !entry.hosts.includes(url.hostname)
    ) {
      deny({
        status: 403,
        code: "egress_host_denied",
        message: `host '${url.hostname}' is not on the egress allowlist for ${provider}:${slot}`,
      });
      return;
    }

    const headers = filterHeaders(body["headers"]);
    const secret = await this.vault.getSecret(connection);
    if (secret !== null) {
      const rewritten = entry.hostRewrite?.[url.hostname];
      if (rewritten !== undefined) {
        url.hostname = rewritten;
      }
      if (entry.attach.kind === "header") {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === entry.attach.name.toLowerCase()) {
            delete headers[key];
          }
        }
        headers[entry.attach.name] = secret;
      } else {
        url.searchParams.set(entry.attach.name, secret);
      }
    }

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(url.toString(), { headers, cache: "no-store" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deny({
        status: 502,
        code: "upstream_unreachable",
        message: `upstream request failed: ${redactErrorMessage(reason)}`,
      });
      return;
    }
    let text = await upstream.text();
    if (secret !== null) {
      text = text.replaceAll(secret, "[redacted]");
    }
    audit("ok");
    reply(response, 200, {
      ok: true,
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      body: text,
    });
  }

  private async handleToken(
    capability: string,
    body: Record<string, unknown>,
    response: ServerResponse,
    user: string | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    const provider = typeof body["provider"] === "string" ? body["provider"] : "";
    const slot = typeof body["slot"] === "string" && body["slot"] !== "" ? body["slot"] : "default";
    const audit = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      this.record({
        ts: new Date().toISOString(),
        capability,
        ...(user === undefined ? {} : { user }),
        tool: `token:${provider === "" ? "unknown" : provider}`,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        host: hostnameOf(this.googleTokenUrl) ?? "oauth2.googleapis.com",
        slot,
      });
    };
    const deny = (denial: Denial): void => {
      audit(denial.status >= 500 ? "error" : "denied", denial.code);
      reply(response, denial.status, { ok: false, error: { code: denial.code, message: denial.message } });
    };

    if (provider !== "google" || this.options.oauth?.google === undefined) {
      deny({
        status: 503,
        code: "oauth_not_configured",
        message: `token exchange is not configured for provider '${provider === "" ? "unknown" : provider}'`,
      });
      return;
    }
    const declared = this.options.specs
      .get(capability)
      ?.connections.some(
        (need) => need.provider === provider && slotMatchesDeclared(need.slot, slot),
      );
    if (declared !== true) {
      deny({
        status: 403,
        code: "egress_denied",
        message: `capability '${capability}' does not declare connection ${provider}:${slot} (or a role it instantiates)`,
      });
      return;
    }
    const connection = connectionId(provider, slot);
    if (!this.vault.checkGrant({ capability, connectionId: connection })) {
      deny({
        status: 403,
        code: "grant_missing",
        message: `capability '${capability}' has no grant for ${connection}; grant the connection and retry`,
      });
      return;
    }
    const view = await this.vault.status(connection);
    if (view.kind !== "oauth") {
      deny({
        status: 403,
        code: "wrong_connection_kind",
        message: `${connection} is not an oauth connection`,
      });
      return;
    }
    const refreshToken = await this.vault.getSecret(connection);
    if (refreshToken === null) {
      deny({
        status: 403,
        code: "not_connected",
        message: `${connection} has no stored credential; run the capability's connect flow`,
      });
      return;
    }

    const cached = this.tokenCache.get(connection);
    if (cached !== undefined && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      audit("ok");
      reply(response, 200, {
        ok: true,
        access_token: cached.accessToken,
        expires_at: new Date(cached.expiresAtMs).toISOString(),
      });
      return;
    }

    let exchange: Response;
    try {
      exchange = await this.fetchImpl(this.googleTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        cache: "no-store",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.options.oauth.google.clientId,
          client_secret: this.options.oauth.google.clientSecret,
        }).toString(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deny({
        status: 502,
        code: "token_exchange_failed",
        message: `token exchange failed: ${redactErrorMessage(reason)}`,
      });
      return;
    }
    let payload: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
    try {
      payload = (await exchange.json()) as typeof payload;
    } catch {
      // handled below by status/shape checks
    }
    if (payload.error === "invalid_grant") {
      deny({
        status: 403,
        code: "token_revoked",
        message: `${connection}'s refresh token was revoked or expired; re-run the capability's connect flow`,
      });
      return;
    }
    if (!exchange.ok || typeof payload.access_token !== "string") {
      deny({
        status: 502,
        code: "token_exchange_failed",
        message: `token endpoint returned HTTP ${String(exchange.status)}`,
      });
      return;
    }
    const expiresInSeconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    this.tokenCache.set(connection, { accessToken: payload.access_token, expiresAtMs });
    audit("ok");
    reply(response, 200, {
      ok: true,
      access_token: payload.access_token,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
  }

  private async handleProfile(
    capability: string,
    body: Record<string, unknown>,
    response: ServerResponse,
    user: string | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    const rawFields = body["fields"];
    const requested = Array.isArray(rawFields)
      ? rawFields.filter((field): field is string => typeof field === "string")
      : [];
    const audit = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      this.record({
        ts: new Date().toISOString(),
        capability,
        ...(user === undefined ? {} : { user }),
        tool: "profile:read",
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        ...(requested.length === 0 ? {} : { fields: requested }),
      });
    };
    const deny = (status: number, code: string, message: string): void => {
      audit(status >= 500 ? "error" : "denied", code);
      reply(response, status, { ok: false, error: { code, message } });
    };

    if (
      !Array.isArray(rawFields) ||
      requested.length === 0 ||
      requested.length !== rawFields.length ||
      requested.length > PROFILE_MAX_FIELDS ||
      requested.some((field) => field.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(field))
    ) {
      deny(400, "egress_bad_request", "fields must be a non-empty array of profile field tokens");
      return;
    }
    const info = this.options.specs.get(capability);
    const declares = info?.connections.some(
      (need) => connectionId(need.provider, need.slot) === PROFILE_CONNECTION_ID,
    );
    if (info === undefined || declares !== true) {
      deny(
        403,
        "egress_denied",
        `capability '${capability}' does not declare connection ${PROFILE_CONNECTION_ID}`,
      );
      return;
    }
    const undeclared = requested.filter((field) => !info.profileFields.includes(field));
    if (undeclared.length > 0) {
      deny(
        403,
        "egress_denied",
        `capability '${capability}' does not declare profile fields: ${undeclared.join(", ")}`,
      );
      return;
    }
    const denied = requested.filter(
      (field) =>
        !this.vault.checkGrant({
          capability,
          connectionId: PROFILE_CONNECTION_ID,
          action: field,
        }),
    );
    if (denied.length > 0) {
      deny(
        403,
        "grant_missing",
        `capability '${capability}' has no profile grant for fields: ${denied.join(", ")}; grant ${PROFILE_CONNECTION_ID} and retry`,
      );
      return;
    }
    const stored = this.profileFor(user);
    const fields: Record<string, string> = {};
    for (const field of requested) {
      const value = stored[field];
      if (value !== undefined) {
        fields[field] = value;
      }
    }
    audit("ok");
    reply(response, 200, { ok: true, fields });
  }

  private async handleCall(
    capability: string,
    body: Record<string, unknown>,
    response: ServerResponse,
    user: string | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    const producer = typeof body["capability"] === "string" ? body["capability"] : "";
    const tool = typeof body["tool"] === "string" ? body["tool"] : "";
    const audit = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      const producerVersion = producer === "" ? null : this.options.versionOf?.(producer) ?? null;
      this.record({
        ts: new Date().toISOString(),
        capability,
        ...(user === undefined ? {} : { user }),
        tool: `call:${producer === "" ? "unknown" : producer}__${tool === "" ? "unknown" : tool}`,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        ...(producer === "" ? {} : { target: producer }),
        ...(producerVersion === null ? {} : { target_version: producerVersion }),
      });
    };
    const deny = (status: number, code: string, message: string): void => {
      audit(status >= 500 ? "error" : "denied", code);
      reply(response, status, { ok: false, error: { code, message } });
    };

    const rawArgs = body["args"];
    const args =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    if (
      producer === "" ||
      !/^[a-z][a-z0-9_-]*$/u.test(producer) ||
      tool === "" ||
      !/^[a-z][a-z0-9_]*$/u.test(tool)
    ) {
      deny(400, "egress_bad_request", "capability and tool are required tokens");
      return;
    }
    if (producer === capability) {
      deny(403, "egress_denied", `capability '${capability}' cannot call itself through the broker`);
      return;
    }
    const declaredTools = this.options.specs.get(capability)?.peerCalls.get(producer);
    if (declaredTools === undefined) {
      deny(
        403,
        "egress_denied",
        `capability '${capability}' does not declare connection capability:${producer}`,
      );
      return;
    }
    if (!declaredTools.includes(tool)) {
      deny(
        403,
        "egress_denied",
        `capability '${capability}' does not declare tool '${tool}' on capability:${producer}`,
      );
      return;
    }
    const connection = connectionId(CAPABILITY_PROVIDER, producer);
    if (!this.vault.checkGrant({ capability, connectionId: connection, action: tool })) {
      deny(
        403,
        "grant_missing",
        `capability '${capability}' has no grant for ${connection} (tool ${tool}); grant it and retry`,
      );
      return;
    }
    if (this.options.callPeer === undefined) {
      deny(503, "call_not_configured", "the broker has no peer-call route configured");
      return;
    }
    const inflight = this.inflightCalls.get(capability) ?? 0;
    if (inflight >= MAX_INFLIGHT_PEER_CALLS) {
      deny(429, "call_busy", `capability '${capability}' has too many peer calls in flight`);
      return;
    }
    this.inflightCalls.set(capability, inflight + 1);
    let result: PeerToolResult;
    try {
      // Unidentified callers keep the original shape; only a resolved caller
      // adds opts, so a standalone peer call is unchanged.
      result =
        user === undefined
          ? await this.options.callPeer(producer, tool, args)
          : await this.options.callPeer(producer, tool, args, { user });
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code;
      const code = typeof rawCode === "string" ? rawCode : "call_failed";
      const status = code === "call_not_mounted" ? 503 : code === "denied_by_policy" ? 403 : 502;
      deny(
        status,
        code === "denied_by_policy" ? "egress_denied" : code,
        redactErrorMessage(error instanceof Error ? error.message : String(error)),
      );
      return;
    } finally {
      const current = this.inflightCalls.get(capability) ?? 1;
      if (current <= 1) {
        this.inflightCalls.delete(capability);
      } else {
        this.inflightCalls.set(capability, current - 1);
      }
    }
    const payload = extractToolPayload(result);
    if (result.isError === true) {
      const envelopeCode = (payload as { error?: { code?: unknown } } | null)?.error?.code;
      audit("error", typeof envelopeCode === "string" ? envelopeCode : "peer_error");
    } else {
      audit("ok");
    }
    reply(response, 200, {
      ok: true,
      result: payload,
      provenance: {
        capability: producer,
        version: this.options.versionOf?.(producer) ?? null,
        ts: new Date().toISOString(),
      },
    });
  }

  private handleCommons(
    capability: string,
    body: Record<string, unknown>,
    response: ServerResponse,
    user: string | undefined,
  ): void {
    const startedAt = Date.now();
    const dataset = typeof body["dataset"] === "string" ? body["dataset"] : "";
    const key = typeof body["key"] === "string" ? body["key"] : undefined;
    const audit = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      this.record({
        ts: new Date().toISOString(),
        capability,
        ...(user === undefined ? {} : { user }),
        tool: `commons:${dataset === "" ? "unknown" : dataset}`,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        ...(key === undefined ? {} : { fields: [key] }),
      });
    };
    const deny = (status: number, code: string, message: string): void => {
      audit(status >= 500 ? "error" : "denied", code);
      reply(response, status, { ok: false, error: { code, message } });
    };

    if (dataset === "" || !/^[a-z][a-z0-9_-]*$/u.test(dataset) || (key !== undefined && key.length > 128)) {
      deny(400, "egress_bad_request", "dataset must be a token; key at most 128 chars");
      return;
    }
    const declared = this.options.specs
      .get(capability)
      ?.data?.commons?.some((entry) => entry.dataset === dataset);
    if (declared !== true) {
      deny(
        403,
        "egress_denied",
        `capability '${capability}' does not declare commons dataset '${dataset}'`,
      );
      return;
    }
    if (this.options.commonsDir === undefined) {
      deny(503, "commons_not_configured", "the gateway has no commons directory configured");
      return;
    }
    let text: string;
    try {
      text = readFileSync(join(this.options.commonsDir, `${dataset}.json`), "utf8");
    } catch {
      deny(404, "commons_not_found", `commons dataset '${dataset}' is not available`);
      return;
    }
    if (text.length > 1024 * 1024) {
      deny(500, "commons_error", `commons dataset '${dataset}' exceeds the 1MB limit`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      deny(500, "commons_error", `commons dataset '${dataset}' is not valid JSON`);
      return;
    }
    if (key !== undefined) {
      const entry =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)[key]
          : undefined;
      if (entry === undefined) {
        deny(404, "commons_key_not_found", `commons dataset '${dataset}' has no entry '${key}'`);
        return;
      }
      data = entry;
    }
    audit("ok");
    reply(response, 200, { ok: true, dataset, data });
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Producer tool result -> transportable payload: structuredContent, else the
 * first text block (parsed as JSON when possible). */
function extractToolPayload(result: PeerToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return first.text;
    }
  }
  return null;
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(text);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function filterHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== "string") {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "host" || lower === "cookie") {
      continue;
    }
    out[key] = header;
  }
  return out;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("body must be an object");
  }
  return parsed as Record<string, unknown>;
}

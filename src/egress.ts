// The egress broker: a localhost HTTP service that attaches credentials to
// outbound requests (allowlisted hosts only) and exchanges OAuth refresh
// tokens for short-lived access tokens. Children authenticate with a
// per-capability bearer token handed to them via env; secrets never appear in
// requests, responses are scrubbed, and every call is audited (hosts, never
// full URLs).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import {
  connectionId,
  openVault,
  parseCapabilityManifest,
  type ManifestConnectionNeed,
  type Vault,
} from "@local/vault";

import type { AuditWriter } from "./audit.js";
import type { CapabilitySpec } from "./config.js";
import { redactErrorMessage } from "./redact.js";

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

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
}

export function newEgressToken(): string {
  return randomBytes(32).toString("hex");
}

/** Warn-only: a capability without a parseable manifest gets an empty entry. */
export function loadEgressSpecs(
  specs: readonly CapabilitySpec[],
  log: (line: string) => void,
): Map<string, CapabilityEgressInfo> {
  const out = new Map<string, CapabilityEgressInfo>();
  for (const spec of specs) {
    const info: CapabilityEgressInfo = { egress: [], connections: [] };
    out.set(spec.id, info);
    if (spec.manifestPath === undefined) {
      continue;
    }
    try {
      const manifest = parseCapabilityManifest(
        JSON.parse(readFileSync(spec.manifestPath, "utf8")),
      );
      info.connections = manifest.connections;
      for (const need of manifest.connections) {
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

export interface EgressServerOptions {
  tokens: Map<string, string>;
  specs: Map<string, CapabilityEgressInfo>;
  env: NodeJS.ProcessEnv;
  audit: AuditWriter;
  log: (line: string) => void;
  oauth?: { google: GoogleOAuthCreds };
  googleTokenUrl?: string;
  fetchImpl?: typeof fetch;
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
  private urlValue: string | null = null;

  constructor(private readonly options: EgressServerOptions) {
    this.vault = openVault({ env: options.env, grantMode: "explicit" });
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
    if (route !== "POST /fetch" && route !== "POST /token") {
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
    if (route === "POST /fetch") {
      await this.handleFetch(capability, body, response);
    } else {
      await this.handleToken(capability, body, response);
    }
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
  ): Promise<void> {
    const startedAt = Date.now();
    const provider = typeof body["provider"] === "string" ? body["provider"] : "";
    const requestedHost = hostnameOf(typeof body["url"] === "string" ? body["url"] : "");
    const audit = (outcome: "ok" | "denied" | "error", extras: { denied?: true; error_code?: string } = {}): void => {
      this.options.audit.record({
        ts: new Date().toISOString(),
        capability,
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
  ): Promise<void> {
    const startedAt = Date.now();
    const provider = typeof body["provider"] === "string" ? body["provider"] : "";
    const slot = typeof body["slot"] === "string" && body["slot"] !== "" ? body["slot"] : "default";
    const audit = (outcome: "ok" | "denied" | "error", errorCode?: string): void => {
      this.options.audit.record({
        ts: new Date().toISOString(),
        capability,
        tool: `token:${provider === "" ? "unknown" : provider}`,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(outcome === "denied" ? { denied_by: "egress" as const } : {}),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        host: hostnameOf(this.googleTokenUrl) ?? "oauth2.googleapis.com",
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
      ?.connections.some((need) => need.provider === provider && need.slot === slot);
    if (declared !== true) {
      deny({
        status: 403,
        code: "egress_denied",
        message: `capability '${capability}' does not declare connection ${provider}:${slot}`,
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
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
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

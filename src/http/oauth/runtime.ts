// Builds the serve-mode auth runtime from config: stage 1 (static bearer
// tokens) or stage 2 (the gateway's own OAuth AS with Google login). The
// signing key is created on first boot if absent — 32 random bytes, 0600.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import { parseBearerTokens, type ServeConfig } from "../../config.js";
import { staticTokenVerifier } from "../auth-static.js";
import { AccessStore } from "./access.js";
import { GatewayOAuthProvider } from "./provider.js";
import { OAuthDiskStore } from "./store.js";

export interface ServeAuthRuntime {
  verifier: OAuthTokenVerifier;
  /** Present in stage 2: mounts the AS router + login/session routes. */
  provider?: GatewayOAuthProvider;
  /** Present in stage 2: invitations and the waiting list on disk. */
  access?: AccessStore;
  description: string;
}

export function buildServeAuth(
  serve: ServeConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): ServeAuthRuntime {
  if (serve.auth.stage === "static") {
    const tokens = parseBearerTokens(env[serve.auth.tokensEnv]);
    if (tokens.size === 0) {
      throw new Error(
        `no bearer tokens in $${serve.auth.tokensEnv} (format: label:token[,label2:token2])`,
      );
    }
    return {
      verifier: staticTokenVerifier(tokens, serve.publicUrl),
      description: `${String(tokens.size)} static bearer token(s)`,
    };
  }

  const oauth = serve.auth.oauth;
  const clientId = env[oauth.google.clientIdVar];
  const clientSecret = env[oauth.google.clientSecretVar];
  if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") {
    throw new Error(
      `oauth login requires $${oauth.google.clientIdVar} and $${oauth.google.clientSecretVar}`,
    );
  }
  const access = accessStoreFor(oauth);
  const provider = new GatewayOAuthProvider({
    issuerUrl: serve.publicUrl,
    store: new OAuthDiskStore(oauth.storeDir),
    signingKey: loadOrCreateKey(oauth.signingKeyFile, log),
    allowedEmails: oauth.allowedEmails,
    access,
    google: { clientId, clientSecret },
    accessTokenTtlSec: oauth.accessTokenTtlSec,
    refreshTokenTtlSec: oauth.refreshTokenTtlSec,
    scopesSupported: oauth.scopesSupported,
    log,
  });
  const invited = access.listInvited().length;
  return {
    verifier: provider,
    provider,
    access,
    description:
      `oauth AS (google login; allowed: ${oauth.allowedEmails.join(", ")}` +
      `${invited === 0 ? "" : ` + ${String(invited)} invited`}; others may join the waiting list)`,
  };
}

/** The same files the `waitlist` CLI reads and writes, so an invitation
 * from the command line is what the running gateway checks next. */
export function accessStoreFor(oauth: {
  storeDir: string;
  allowedEmails: readonly string[];
}): AccessStore {
  return new AccessStore(oauth.storeDir, oauth.allowedEmails);
}

function loadOrCreateKey(path: string, log: (line: string) => void): Buffer {
  try {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    if (key.length >= 32) {
      return key;
    }
    throw new Error(`signing key at ${path} is too short (need 32 bytes of hex)`);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${key.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  log(`[gateway] generated a new token signing key at ${path}`);
  return key;
}

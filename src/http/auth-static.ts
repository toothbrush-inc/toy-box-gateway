// Stage-1 auth: a fixed set of bearer tokens from the environment. The
// verifier shape is identical to the stage-2 OAuth provider, so swapping
// stages never touches the endpoint wiring.

import { createHash, timingSafeEqual } from "node:crypto";

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const TEN_YEARS_SEC = 10 * 365 * 86_400;

export function staticTokenVerifier(
  tokens: ReadonlyMap<string, string>,
  publicUrl: string,
): OAuthTokenVerifier {
  const entries = [...tokens].map(([token, label]) => ({ hash: sha256(token), label }));
  const resource = new URL(`${publicUrl.replace(/\/+$/u, "")}/mcp`);
  return {
    verifyAccessToken(token: string): Promise<AuthInfo> {
      const presented = sha256(token);
      for (const entry of entries) {
        if (timingSafeEqual(presented, entry.hash)) {
          return Promise.resolve({
            token,
            clientId: `static:${entry.label}`,
            scopes: ["mcp"],
            // The SDK middleware hard-requires a numeric expiry in SECONDS.
            expiresAt: Math.floor(Date.now() / 1000) + TEN_YEARS_SEC,
            resource,
            extra: { user: entry.label, method: "static" },
          });
        }
      }
      return Promise.reject(new InvalidTokenError("unknown bearer token"));
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

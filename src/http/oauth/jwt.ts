// Minimal HS256 JWT: sign + verify with a shared key file, timing-safe,
// zero dependencies. Payloads carry iss/aud/sub/exp/iat/jti plus extras.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  jti: string;
  [key: string]: unknown;
}

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function signJwt(
  key: Buffer,
  claims: { iss: string; aud: string; sub: string; expiresInSec: number } & Record<string, unknown>,
): string {
  const { expiresInSec, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    ...rest,
    iss: claims.iss,
    aud: claims.aud,
    sub: claims.sub,
    iat: now,
    exp: now + expiresInSec,
    jti: randomBytes(16).toString("hex"),
  };
  const body = `${HEADER}.${base64url(JSON.stringify(payload))}`;
  return `${body}.${hmac(key, body)}`;
}

/** Returns the payload iff the signature, expiry, issuer, and audience hold. */
export function verifyJwt(key: Buffer, token: string, expect: { iss: string; aud: string }): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) {
    return null;
  }
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(hmac(key, body));
  const presented = Buffer.from(parts[2] ?? "");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return null;
  }
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1000) ||
    payload.iss !== expect.iss ||
    payload.aud !== expect.aud ||
    typeof payload.sub !== "string"
  ) {
    return null;
  }
  return payload;
}

function hmac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

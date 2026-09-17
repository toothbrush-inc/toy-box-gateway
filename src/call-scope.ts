// Per-call identity for shared capability processes.
//
// One child serves every user, so "who is this call for?" cannot be spawn-time
// env. The gateway mints a single-use nonce per tool call, hands it to the
// child in `_meta`, and resolves it when the child comes back to the broker.
// The capability only ever holds the nonce — it never learns an identity and
// so cannot name a user it was not given.

import { createHash, randomBytes } from "node:crypto";

/** Key the nonce travels under in a forwarded call's `_meta`. Must match
 * CALL_NONCE_META_KEY in @dvd-toy-box/vault/kit — it is the wire contract. */
export const CALL_NONCE_META_KEY = "callNonce";

/** Bounds the registry if a caller ever fails to release (it releases in a
 * finally, so this is a backstop against a leak, not normal operation). */
const MAX_LIVE = 10_000;

export class CallScopeRegistry {
  private readonly byNonce = new Map<string, string>();

  /** Returns undefined for an unidentified caller, which keeps the broker on
   * its shared-profile fallback rather than inventing an identity. */
  mint(user: string | undefined): string | undefined {
    if (user === undefined || user.trim() === "") {
      return undefined;
    }
    if (this.byNonce.size >= MAX_LIVE) {
      const oldest = this.byNonce.keys().next();
      if (!oldest.done) {
        this.byNonce.delete(oldest.value);
      }
    }
    const nonce = randomBytes(16).toString("hex");
    this.byNonce.set(nonce, user.trim());
    return nonce;
  }

  resolve(nonce: string | undefined): string | undefined {
    return nonce === undefined ? undefined : this.byNonce.get(nonce);
  }

  release(nonce: string | undefined): void {
    if (nonce !== undefined) {
      this.byNonce.delete(nonce);
    }
  }

  get size(): number {
    return this.byNonce.size;
  }
}

/**
 * Path-safe name for a user's own data. Emails use the same stable hash as
 * calsync's `tenantForIdentity` (`i` + first 32 hex chars of SHA-256 of the
 * lowercased address), so punctuation no longer collides and brokered
 * calsync tenants align with gateway profile dirs. A bare owner like the
 * `"dvd"` on existing pinned views is sanitised and passed through, so views
 * keep resolving.
 *
 * Returns null when nothing usable survives sanitising — the caller then falls
 * back to the shared profile instead of writing to a surprising path.
 */
export function userSlug(user: string): string | null {
  const normalized = user.trim().toLowerCase();
  if (normalized === "") {
    return null;
  }
  if (normalized.includes("@")) {
    const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
    return `i${digest.slice(0, 32)}`;
  }
  const slug = normalized
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return slug === "" ? null : slug;
}

/**
 * Former punctuation slug (`owner@example.com` -> `owner_at_example_com`).
 * Kept so profile lookup can find pre-hash directories during migration.
 */
export function legacyUserSlug(user: string): string | null {
  const slug = user
    .trim()
    .toLowerCase()
    .replace(/@/gu, "_at_")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return slug === "" ? null : slug;
}

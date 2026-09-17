// Per-call identity for shared capability processes.
//
// One child serves every user, so "who is this call for?" cannot be spawn-time
// env. The gateway mints a single-use nonce per tool call, hands it to the
// child in `_meta`, and resolves it when the child comes back to the broker.
// The capability only ever holds the nonce — it never learns an identity and
// so cannot name a user it was not given.

import { randomBytes } from "node:crypto";

import { identitySlug as userSlug, legacyUserSlug } from "@dvd-toy-box/vault";

export { userSlug, legacyUserSlug };

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

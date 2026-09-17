import { describe, expect, it } from "vitest";

import { CallScopeRegistry, legacyUserSlug, userSlug } from "../src/call-scope.js";

describe("CallScopeRegistry", () => {
  it("mints a resolvable nonce and releases it", () => {
    const scope = new CallScopeRegistry();
    const nonce = scope.mint("owner@example.com");
    expect(nonce).toBeDefined();
    expect(scope.resolve(nonce)).toBe("owner@example.com");
    scope.release(nonce);
    expect(scope.resolve(nonce)).toBeUndefined();
  });

  it("mints nothing for an unidentified caller", () => {
    const scope = new CallScopeRegistry();
    expect(scope.mint(undefined)).toBeUndefined();
    expect(scope.mint("   ")).toBeUndefined();
    expect(scope.size).toBe(0);
  });

  it("gives concurrent callers distinct nonces", () => {
    const scope = new CallScopeRegistry();
    const a = scope.mint("a@example.com");
    const b = scope.mint("b@example.com");
    expect(a).not.toBe(b);
    expect(scope.resolve(a)).toBe("a@example.com");
    expect(scope.resolve(b)).toBe("b@example.com");
  });

  it("does not resolve an unknown nonce", () => {
    const scope = new CallScopeRegistry();
    expect(scope.resolve("never-minted")).toBeUndefined();
    expect(scope.resolve(undefined)).toBeUndefined();
  });
});

describe("userSlug", () => {
  it("hashes emails the same way calsync tenants do", () => {
    expect(userSlug("owner@example.com")).toBe("ic8cd3c6427301eaf6665bccacd65ddb6");
    expect(userSlug("Ana.B@Example.com")).toBe("i4248cc593102d6944c982776b98b8d40");
    expect(userSlug("ana-b@example.com")).toBe("i8b5313038e8fbab2a34a2f8ae58801b3");
    expect(userSlug("Ana.B@Example.com")).not.toBe(userSlug("ana-b@example.com"));
  });

  it("passes a bare view owner through, so pinned views keep resolving", () => {
    expect(userSlug("dvd")).toBe("dvd");
  });

  it("normalises case and trims", () => {
    expect(userSlug("  OWNER@Example.com ")).toBe("ic8cd3c6427301eaf6665bccacd65ddb6");
  });

  it("never escapes its directory for bare owners", () => {
    expect(userSlug("../../etc/passwd")).toBe("etc_passwd");
    expect(userSlug("a/../b")).toBe("a_b");
  });

  it("returns null when nothing usable survives", () => {
    expect(userSlug("")).toBeNull();
    expect(userSlug("///")).toBeNull();
  });

  it("keeps the legacy punctuation slug for migration lookups", () => {
    expect(legacyUserSlug("owner@example.com")).toBe("owner_at_example_com");
    expect(legacyUserSlug("a.reader@example.com")).toBe("a_reader_at_example_com");
    expect(legacyUserSlug("alice@example.com")).toBe("alice_at_example_com");
  });
});

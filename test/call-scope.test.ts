import { describe, expect, it } from "vitest";

import { CallScopeRegistry, userMayUseSlot, userSlug } from "../src/call-scope.js";

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
});

describe("userMayUseSlot", () => {
  const alice = "alice@example.com";
  const bob = "bob@example.com";
  const aliceTenant = userSlug(alice) as string;
  const bobTenant = userSlug(bob) as string;

  it("lets a signed-in person use their own tenant-scoped slots with no config", () => {
    expect(userMayUseSlot(alice, "google", `${aliceTenant}_personal`, {})).toBe(true);
    expect(userMayUseSlot(alice, "google", `${aliceTenant}_work`, {})).toBe(true);
  });

  it("never reaches another person's tenant", () => {
    expect(userMayUseSlot(alice, "google", `${bobTenant}_personal`, {})).toBe(false);
    expect(userMayUseSlot(bob, "google", `${aliceTenant}_work`, {})).toBe(false);
  });

  it("keeps bare and shared slots explicit-only", () => {
    expect(userMayUseSlot(alice, "google", "personal", {})).toBe(false);
    expect(userMayUseSlot(alice, "purpleair", "default", {})).toBe(false);
    expect(userMayUseSlot(alice, "google", "personal", { "google:personal": [alice] })).toBe(true);
    expect(userMayUseSlot(bob, "google", "personal", { "google:personal": [alice] })).toBe(false);
    expect(userMayUseSlot(alice, "purpleair", "default", { "purpleair:default": [alice, bob] })).toBe(true);
  });

  it("refuses an unidentified caller and malformed slots", () => {
    expect(userMayUseSlot(undefined, "google", `${aliceTenant}_personal`, {})).toBe(false);
    expect(userMayUseSlot(alice, "google", aliceTenant, {})).toBe(false);
    expect(userMayUseSlot(alice, "google", `${aliceTenant}_`, {})).toBe(false);
    expect(userMayUseSlot(alice, "google", `_${aliceTenant}`, {})).toBe(false);
  });

  it("splits at the last underscore, so a bare owner cannot claim a longer tenant", () => {
    // Bare (non-email) owners slug with underscores; "a" must not own "a_b"'s slots.
    expect(userMayUseSlot("a", "google", "a_b_personal", {})).toBe(false);
    expect(userMayUseSlot("a.b", "google", "a_b_personal", {})).toBe(true);
    expect(userMayUseSlot("a", "google", "a_personal", {})).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { CallScopeRegistry, userSlug } from "../src/call-scope.js";

describe("CallScopeRegistry", () => {
  it("mints a resolvable nonce and releases it", () => {
    const scope = new CallScopeRegistry();
    const nonce = scope.mint("dvd@thephotobase.com");
    expect(nonce).toBeDefined();
    expect(scope.resolve(nonce)).toBe("dvd@thephotobase.com");
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
  it("makes an email path-safe", () => {
    expect(userSlug("dvd@thephotobase.com")).toBe("dvd_at_thephotobase_com");
    expect(userSlug("d.dryjanski@gmail.com")).toBe("d_dryjanski_at_gmail_com");
  });

  it("passes a bare view owner through, so pinned views keep resolving", () => {
    expect(userSlug("dvd")).toBe("dvd");
  });

  it("normalises case and trims", () => {
    expect(userSlug("  DVD@ThePhotobase.com ")).toBe("dvd_at_thephotobase_com");
  });

  it("never escapes its directory", () => {
    expect(userSlug("../../etc/passwd")).toBe("etc_passwd");
    expect(userSlug("a/../b")).toBe("a_b");
  });

  it("returns null when nothing usable survives", () => {
    expect(userSlug("")).toBeNull();
    expect(userSlug("///")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "../src/policy.js";

describe("evaluatePolicy", () => {
  it("allows everything when no lists are configured", () => {
    expect(evaluatePolicy({ id: "weather" }, "collect_now")).toEqual({ allowed: true });
  });

  it("denies tools on the deny list, and deny wins over allow", () => {
    const spec = { id: "calsync", allowTools: ["sync_now"], denyTools: ["sync_now"] };
    const decision = evaluatePolicy(spec, "sync_now");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain("sync_now");
      expect(decision.message).toContain("calsync");
      expect(decision.message).toContain("gateway config");
    }
  });

  it("treats a present allow list as exhaustive", () => {
    const spec = { id: "weather", allowTools: ["get_status"] };
    expect(evaluatePolicy(spec, "get_status").allowed).toBe(true);
    expect(evaluatePolicy(spec, "collect_now").allowed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { redactErrorMessage } from "../src/redact.js";

describe("redactErrorMessage", () => {
  it("scrubs token-shaped substrings", () => {
    const cases: Array<[string, string]> = [
      ["auth failed for ya29.a0AbCdEf-ghi", "ya29."],
      ["refresh 1//0gAbCdEfGh123 rejected", "1//"],
      ["stripe key sk_live_4eC39HqLyjWDarjtT1zdp7dc leaked", "sk_live_"],
      ["header Authorization: Bearer eyJhbGciOi failed", "eyJhbGciOi"],
      ["api_key=SUPERSECRET was invalid", "SUPERSECRET"],
      ["opaque AbCdEfGhIjKlMnOpQrStUvWxYz012345 blob", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ];
    for (const [input, secret] of cases) {
      const out = redactErrorMessage(input);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    }
  });

  it("leaves ordinary messages readable", () => {
    expect(redactErrorMessage("capability weather is offline")).toBe(
      "capability weather is offline",
    );
  });

  it("truncates long messages", () => {
    const out = redactErrorMessage("the child failed ".repeat(100), 300);
    expect(out.length).toBe(300);
    expect(out.endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { buildChildEnv } from "../src/children.js";

describe("buildChildEnv", () => {
  it("injects the egress endpoint, broker-only mode, and a non-overridable grant mode", () => {
    const env = buildChildEnv(
      {
        id: "weather",
        command: "node",
        args: [],
        manifestPath: "/x/capability.json",
        secretsAccess: "broker",
        env: { VAULT_GRANT_MODE: "auto", FOO: "bar" },
      },
      { VAULT_HOME: "/vault", VAULT_SECRETS_BACKEND: "file" },
      { url: "http://127.0.0.1:1", token: "tok" },
    );
    expect(env).toEqual({
      FOO: "bar",
      VAULT_HOME: "/vault",
      VAULT_SECRETS_BACKEND: "file",
      VAULT_EGRESS_URL: "http://127.0.0.1:1",
      VAULT_EGRESS_TOKEN: "tok",
      VAULT_GRANT_MODE: "explicit",
      VAULT_SECRETS_ACCESS: "broker",
    });
  });

  it("omits egress and broker mode when not configured", () => {
    expect(buildChildEnv({ id: "w", command: "n", args: [] }, {})).toEqual({
      VAULT_GRANT_MODE: "explicit",
    });
  });
});

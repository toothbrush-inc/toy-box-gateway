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

  it("merges provisioned env under spec.env (spec wins)", () => {
    const env = buildChildEnv(
      { id: "books", command: "n", args: [], env: { BOOKS_DB: "/custom/books.json" } },
      {},
      undefined,
      { BOOKS_DB: "/data/books/books.json", BOOKS_GAPS: "/data/books/gaps.json" },
    );
    expect(env["BOOKS_DB"]).toBe("/custom/books.json");
    expect(env["BOOKS_GAPS"]).toBe("/data/books/gaps.json");
  });
});

it("closes an initialized child when tools/list fails, including after reconnect", async () => {
  const { ChildManager } = await import("../src/children.js");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const { vi } = await import("vitest");
  const transports = await Promise.all(Array.from({ length: 2 }, async () => {
    const server = new Server({ name: "broken", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => { throw new Error("list failed"); });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    return { clientSide, close: vi.spyOn(clientSide, "close"), server };
  }));
  let index = 0;
  const manager = new ChildManager([{ id: "broken", command: "unused", args: [] }], {
    transportFactory: () => transports[index++]!.clientSide,
    onToolsChanged: () => undefined, log: () => undefined,
  });
  try {
    await manager.start();
    expect(manager.get("broken")?.state).toBe("failed");
    expect(transports[0]!.close).toHaveBeenCalled();
    await manager.reconnect("broken");
    expect(transports[1]!.close).toHaveBeenCalled();
  } finally {
    await manager.close();
    await Promise.all(transports.map(({ server }) => server.close()));
  }
});

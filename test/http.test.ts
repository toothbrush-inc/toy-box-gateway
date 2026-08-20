import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { AuditWriter, type AuditEntry } from "../src/audit.js";
import { GatewayConfigSchema, parseBearerTokens, type GatewayConfig } from "../src/config.js";
import { createGatewayCore, type GatewayCore } from "../src/gateway.js";
import { staticTokenVerifier } from "../src/http/auth-static.js";
import { startHttpGateway, type HttpGateway } from "../src/http/server.js";
import { startFakeWeather } from "./fakes.js";

const cleanups: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface HttpHarness {
  url: string;
  auditPath: string;
  core: GatewayCore;
  http: HttpGateway;
}

async function startHarness(): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-http-"));
  dirs.push(dir);
  const fake = await startFakeWeather();
  const config: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      capabilities: [{ id: "weather", command: "unused" }],
      serve: {
        port: 0,
        host: "127.0.0.1",
        publicUrl: "http://127.0.0.1",
        auth: { stage: "static" },
      },
    }),
    configPath: join(dir, "gateway.config.json"),
  };
  const audit = new AuditWriter({ dir: join(dir, "audit") });
  const core = await createGatewayCore({
    config,
    audit,
    env: { VAULT_HOME: join(dir, "vault"), VAULT_SECRETS_BACKEND: "file" } as NodeJS.ProcessEnv,
    log: () => undefined,
    transportFactory: () => fake.transport,
  });
  const serve = config.serve;
  if (serve === undefined) {
    throw new Error("serve config missing");
  }
  const tokens = parseBearerTokens("dev:secret-token-1,other:secret-token-2");
  const http = await startHttpGateway({
    core,
    serve,
    verifier: staticTokenVerifier(tokens, serve.publicUrl),
    log: () => undefined,
  });
  cleanups.push(async () => {
    await http.close();
    await core.close();
  });
  return { url: `http://127.0.0.1:${String(http.port)}`, auditPath: audit.path, core, http };
}

// The SDK transport classes type optional fields with explicit `| undefined`,
// which exactOptionalPropertyTypes rejects against the Transport interface.
type ClientTransportArg = Parameters<Client["connect"]>[0];

function connectedClient(
  harness: HttpHarness,
  token: string,
): { client: Client; transport: StreamableHTTPClientTransport; connect: () => Promise<void> } {
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
  });
  return {
    client,
    transport,
    connect: () => client.connect(transport as unknown as ClientTransportArg),
  };
}

describe("http gateway", () => {
  it("rejects unauthenticated requests with 401 and WWW-Authenticate", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("serves independent authenticated sessions with audited identity", async () => {
    const harness = await startHarness();
    const first = connectedClient(harness, "secret-token-1");
    await first.connect();
    const second = connectedClient(harness, "secret-token-2");
    await second.connect();

    const names = (await first.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("weather__echo");
    expect(names).toContain("gateway_status");

    const result = await first.client.callTool(
      { name: "weather__echo", arguments: { text: "over-http" } },
      CallToolResultSchema,
    );
    expect(result.structuredContent).toEqual({ ok: true, data: { echoed: "over-http" } });

    const other = await second.client.callTool(
      { name: "weather__echo", arguments: { text: "second-session" } },
      CallToolResultSchema,
    );
    expect(other.structuredContent).toEqual({ ok: true, data: { echoed: "second-session" } });

    const entries = readFileSync(harness.auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEntry)
      .filter((entry) => entry.tool === "echo");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ client_id: "static:dev", user: "dev" });
    expect(entries[1]).toMatchObject({ client_id: "static:other", user: "other" });
    expect(typeof entries[0]?.session_id).toBe("string");
    expect(entries[0]?.session_id).not.toBe(entries[1]?.session_id);
  });

  it("binds sessions to the initializing client and 403s other tokens", async () => {
    const harness = await startHarness();
    const first = connectedClient(harness, "secret-token-1");
    await first.connect();
    const sessionId = first.transport.sessionId;
    expect(typeof sessionId).toBe("string");

    const stolen = await fetch(`${harness.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer secret-token-2",
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(stolen.status).toBe(403);
  });

  it("terminates sessions on DELETE and 404s afterwards", async () => {
    const harness = await startHarness();
    const first = connectedClient(harness, "secret-token-1");
    await first.connect();
    const sessionId = first.transport.sessionId ?? "";

    await first.transport.terminateSession();

    const afterwards = await fetch(`${harness.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer secret-token-1",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(afterwards.status).toBe(404);
  });
});

describe("parseBearerTokens", () => {
  it("parses labeled, bare, and multiple tokens", () => {
    const parsed = parseBearerTokens("claude:abc, def ,x:  ghi ");
    expect(parsed.get("abc")).toBe("claude");
    expect(parsed.get("def")).toBe("default");
    expect(parsed.get("ghi")).toBe("x");
    expect(parseBearerTokens(undefined).size).toBe(0);
  });
});

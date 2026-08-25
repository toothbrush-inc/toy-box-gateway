import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function startHarness(
  options: { web?: { path: string; label: string; description?: string } } = {},
): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-http-"));
  dirs.push(dir);
  const fake = await startFakeWeather();
  const manifestPath = join(dir, "capability.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ id: "weather", connections: [], tools: { query: ["echo"] } }),
  );
  const config: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      capabilities: [
        {
          id: "weather",
          command: "unused",
          manifestPath,
          ...(options.web === undefined ? {} : { web: options.web }),
        },
      ],
      views: { dir: join(dir, "views") },
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

describe("http views surface", () => {
  const CARD_VIEW = {
    id: "morning",
    title: "Morning echo",
    owner: "dvd",
    sensitivity: "shareable",
    queries: [{ key: "e", tool: "weather__echo", arguments: { text: "hey <world>" } }],
    transform:
      "(input) => ({ title: 'Morning', sections: [{ kind: 'text', text: input.e.data.echoed }] })",
    refresh: { intervalMs: null },
  };

  it("serves bearer-authed HTML and JSON cards", async () => {
    const harness = await startHarness();
    const views = harness.core.views;
    expect(views).toBeDefined();
    const pinned = await views?.pin(CARD_VIEW);
    expect(pinned?.ok).toBe(true);

    const unauthorized = await fetch(`${harness.url}/views`);
    expect(unauthorized.status).toBe(401);

    const headers = { Authorization: "Bearer secret-token-1" };
    const index = await fetch(`${harness.url}/views`, { headers });
    expect(index.status).toBe(200);
    const list = (await index.json()) as { data: { views: { id: string }[] } };
    expect(list.data.views[0]?.id).toBe("morning");

    const html = await fetch(`${harness.url}/views/morning`, { headers });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const page = await html.text();
    expect(page).toContain("Morning");
    expect(page).toContain("hey &lt;world&gt;");
    expect(page).not.toContain("<script");

    const json = await fetch(`${harness.url}/views/morning.json`, { headers });
    expect(json.status).toBe(200);
    const card = (await json.json()) as { ok: boolean; model: { title: string } };
    expect(card.ok).toBe(true);
    expect(card.model.title).toBe("Morning");

    // browsers get an HTML index; API clients keep JSON
    const indexHtml = await fetch(`${harness.url}/views`, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(indexHtml.headers.get("content-type")).toContain("text/html");
    const indexPage = await indexHtml.text();
    expect(indexPage).toContain("Morning echo");
    expect(indexPage).toContain('href="/views/morning"');

    const missing = await fetch(`${harness.url}/views/nope`, { headers });
    expect(missing.status).toBe(404);
  });

  it("serves previews at their token until they expire", async () => {
    const harness = await startHarness();
    const views = harness.core.views;
    expect(views).toBeDefined();
    const previewed = await views?.preview(CARD_VIEW);
    expect(previewed?.ok).toBe(true);
    const token = previewed?.ok === true ? previewed.preview.token : "";
    expect(views?.previewUrlFor(token)).toBe(`http://127.0.0.1/views/preview/${token}`);
    expect(views?.urlFor("morning")).toBe("http://127.0.0.1/views/morning");

    const unauthorized = await fetch(`${harness.url}/views/preview/${token}`);
    expect(unauthorized.status).toBe(401);

    const headers = { Authorization: "Bearer secret-token-1" };
    const html = await fetch(`${harness.url}/views/preview/${token}`, { headers });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("cache-control")).toBe("no-store");
    const page = await html.text();
    expect(page).toContain("<strong>Preview</strong>");
    expect(page).toContain("hey &lt;world&gt;");
    expect(page).not.toContain("<script");

    const json = await fetch(`${harness.url}/views/preview/${token}.json`, { headers });
    expect(json.status).toBe(200);
    const card = (await json.json()) as { ok: boolean; model: { title: string }; preview: { token: string } };
    expect(card.ok).toBe(true);
    expect(card.model.title).toBe("Morning");
    expect(card.preview.token).toBe(token);

    // nothing was pinned
    const list = await fetch(`${harness.url}/views`, { headers });
    expect(((await list.json()) as { data: { views: unknown[] } }).data.views).toHaveLength(0);

    const gone = await fetch(`${harness.url}/views/preview/nope`, { headers });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe("unknown_preview");
    const goneHtml = await fetch(`${harness.url}/views/preview/nope`, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(goneHtml.status).toBe(404);
    expect(await goneHtml.text()).toContain("Preview expired");
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

describe("home index", () => {
  async function getHome(
    harness: HttpHarness,
    accept: string,
    token: string | null = "secret-token-1",
  ): Promise<Response> {
    return await fetch(`${harness.url}/`, {
      headers: {
        accept,
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
    });
  }

  it("lists an agent-only capability with what it can do", async () => {
    const harness = await startHarness();
    const response = await getHome(harness, "text/html");
    expect(response.status).toBe(200);
    const html = await response.text();
    // The point of the page: a capability with no web UI is still discoverable,
    // and says what it can do rather than merely existing.
    expect(html).toContain("weather");
    expect(html).toContain("agent-only");
    expect(html).toContain("echo");
    expect(html).toContain("Echoes input");
  });

  it("links a capability that declares a web UI", async () => {
    const harness = await startHarness({
      web: { path: "/weather", label: "Weather", description: "Forecasts and history" },
    });
    const html = await (await getHome(harness, "text/html")).text();
    expect(html).toContain('href="/weather"');
    expect(html).toContain("Weather");
    expect(html).toContain("Forecasts and history");
    expect(html).not.toContain("agent-only");
  });

  it("serves the same facts as JSON", async () => {
    const harness = await startHarness({ web: { path: "/weather", label: "Weather" } });
    const response = await getHome(harness, "application/json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        capabilities: { id: string; state: string; tools: { name: string }[]; web?: { path: string } }[];
        mcpUrl: string;
      };
    };
    expect(body.ok).toBe(true);
    const weather = body.data.capabilities.find((cap) => cap.id === "weather");
    expect(weather?.state).toBe("connected");
    expect(weather?.web?.path).toBe("/weather");
    expect(weather?.tools.map((tool) => tool.name)).toContain("echo");
    expect(body.data.mcpUrl).toBe("http://127.0.0.1/mcp");
  });

  it("points at the MCP endpoint so the agent-only half is reachable", async () => {
    const harness = await startHarness();
    const html = await (await getHome(harness, "text/html")).text();
    expect(html).toContain("http://127.0.0.1/mcp");
  });

  it("is not readable without auth", async () => {
    const harness = await startHarness();
    expect((await getHome(harness, "text/html", null)).status).toBe(401);
  });

  it("answers an unknown path with a themed 404, not the index", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.url}/nope`, {
      headers: { accept: "text/html", Authorization: "Bearer secret-token-1" },
    });
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Not found");
    expect(html).not.toContain("agent-only");
  });
});

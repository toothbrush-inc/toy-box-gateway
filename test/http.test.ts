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
  options: {
    manifestStore?: Record<string, unknown>;
    web?: {
      path?: string;
      label?: string;
      tagline?: string;
      description?: string;
      highlights?: string[];
      badge?: string;
      accent?: "sky" | "leaf" | "marigold" | "plum" | "clay" | "slate";
    };
    links?: { href: string; label: string; description?: string; repo?: string }[];
    store?: {
      name?: string;
      headline?: string;
      lede?: string;
      contact?: { email: string; byline?: string };
    };
    owners?: string[];
    sameClient?: boolean;
  } = {},
): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-http-"));
  dirs.push(dir);
  const fake = await startFakeWeather();
  const manifestPath = join(dir, "capability.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "weather",
      connections: [],
      tools: { query: ["echo"] },
      ...(options.manifestStore === undefined ? {} : { store: options.manifestStore }),
    }),
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
      ...(options.links === undefined ? {} : { links: options.links }),
      ...(options.store === undefined ? {} : { store: options.store }),
      serve: {
        port: 0,
        host: "127.0.0.1",
        publicUrl: "http://127.0.0.1",
        auth: { stage: "static" },
        ...(options.owners === undefined ? {} : { owners: options.owners }),
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
    verifier: options.sameClient ? {
      async verifyAccessToken(token) {
        const auth = await staticTokenVerifier(tokens, serve.publicUrl).verifyAccessToken(token);
        return { ...auth, clientId: "shared-client" };
      },
    } : staticTokenVerifier(tokens, serve.publicUrl),
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.store === undefined ? {} : { store: options.store }),
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

describe("store page", () => {
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

  it("is public, and the anonymous page is the catalogue only", async () => {
    const harness = await startHarness({
      web: { path: "/weather", label: "Weather", tagline: "Which forecast to trust" },
    });
    const response = await getHome(harness, "text/html", null);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-powered-by")).toBeNull();
    const html = await response.text();
    expect(html).toContain('href="/weather"');
    expect(html).toContain("Which forecast to trust");
    expect(html).toContain("http://127.0.0.1/mcp");
    // What is mounted underneath is not for anonymous readers.
    expect(html).not.toContain("echo");
    expect(html).not.toContain("Echoes input");
    expect(html).not.toContain("not connected");
  });

  it("shows a signed-in viewer what each capability can do", async () => {
    const harness = await startHarness({ web: { path: "/weather", label: "Weather" } });
    const html = await (await getHome(harness, "text/html")).text();
    expect(html).toContain("echo");
    expect(html).toContain("Echoes input");
    expect(html).toContain("Sign out");
  });

  it("renders the copy for a tile: tagline, reasons, badge", async () => {
    const harness = await startHarness({
      web: {
        path: "/weather",
        label: "Weather",
        tagline: "Know which forecast to trust.",
        description: "Three sources side by side.",
        highlights: ["Air quality from a sensor near you", "A heads-up when tomorrow is odd"],
        badge: "new",
        accent: "sky",
      },
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).toContain("Know which forecast to trust.");
    expect(html).toContain("Three sources side by side.");
    expect(html).toContain("<li>Air quality from a sensor near you</li>");
    expect(html).toContain('<span class="badge">new</span>');
    expect(html).toContain("tile--sky");
    expect(html).toContain("Open Weather");
    // The paragraph and highlights fold behind a native toggle so the card
    // stays short; the tagline, chips and actions sit outside the fold.
    expect(html).toContain(
      '<details class="tile-more"><summary>More about Weather</summary><div class="tile-body"><p class="tile-desc">Three sources side by side.</p><ul class="tile-points">',
    );
    expect(html).toMatch(/<\/details><ul class="chips">/u);
  });

  it("omits the tile fold when there is nothing to fold", async () => {
    const harness = await startHarness({
      web: { path: "/weather", label: "Weather", tagline: "Know which forecast to trust." },
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).toContain("Know which forecast to trust.");
    expect(html).not.toContain("<details");
  });

  it("builds the tile from the manifest's store block, with config overriding per field", async () => {
    const manifestStore = {
      name: "Weather",
      tagline: "Know which forecast to trust.",
      description: "Three forecasts side by side.",
      highlights: ["Air quality from a sensor near you"],
      accent: "sky",
      web: { path: "/weather" },
      repo: "https://github.com/davidd8/weather-compare",
    };
    const fromManifest = await startHarness({ manifestStore });
    const html = await (await getHome(fromManifest, "text/html", null)).text();
    expect(html).toContain('href="/weather"');
    expect(html).toContain("Open Weather");
    expect(html).toContain("Know which forecast to trust.");
    expect(html).toContain("<li>Air quality from a sensor near you</li>");
    expect(html).toContain("tile--sky");
    const json = (await (await getHome(fromManifest, "application/json", null)).json()) as {
      data: { apps: Record<string, unknown>[] };
    };
    expect(json.data.apps[0]).toEqual({
      href: "/weather",
      kind: "app",
      label: "Weather",
      tagline: "Know which forecast to trust.",
      description: "Three forecasts side by side.",
      highlights: ["Air quality from a sensor near you"],
      accent: "sky",
      repo: "https://github.com/davidd8/weather-compare",
    });

    const overridden = await startHarness({
      manifestStore,
      web: { path: "/wx", tagline: "Hosted words.", badge: "beta" },
    });
    const html2 = await (await getHome(overridden, "text/html", null)).text();
    expect(html2).toContain('href="/wx"');
    expect(html2).toContain("Open Weather");
    expect(html2).toContain("Hosted words.");
    expect(html2).not.toContain("Know which forecast to trust.");
    expect(html2).toContain("Three forecasts side by side.");
    expect(html2).toContain('<span class="badge">beta</span>');
  });

  it("shows how each app can be used: chips, a repo link, and a tile for an agent-only app", async () => {
    const harness = await startHarness({
      manifestStore: {
        name: "calsync",
        tagline: "Two calendars. One schedule.",
        repo: "https://github.com/davidd8/calsync",
      },
      links: [
        {
          href: "https://mail.example.com",
          label: "MailFeed",
          description: "Reading feed from your inbox",
          repo: "https://github.com/toothbrush-inc/mailfeed",
        },
      ],
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    // The agent-only capability gets a tile that points at the assistant section.
    expect(html).toContain("Two calendars. One schedule.");
    expect(html).toContain('<a class="tile-cta" href="#assistant">Use from your assistant</a>');
    expect(html).not.toContain("Open calsync");
    expect(html).toContain('<section class="sec sec--agent" id="assistant">');
    // Chips say what each tile is, and the repo link says where to get it.
    const calsyncTile = html.slice(html.indexOf("Two calendars"), html.indexOf("MailFeed"));
    expect(calsyncTile).toContain('<ul class="chips"><li>Works with your assistant</li><li>Open source</li></ul>');
    expect(calsyncTile).toContain('href="https://github.com/davidd8/calsync" rel="noopener">Run it yourself</a>');
    const mailTile = html.slice(html.indexOf("MailFeed"));
    expect(mailTile).toContain('<ul class="chips"><li>Web app</li><li>Open source</li></ul>');
    expect(mailTile).toContain('<a class="tile-cta" href="https://mail.example.com">Open MailFeed</a>');

    const json = (await (await getHome(harness, "application/json", null)).json()) as {
      data: { apps: Record<string, unknown>[] };
    };
    expect(json.data.apps.map((app) => [app["kind"], app["href"], app["repo"]])).toEqual([
      ["app", undefined, "https://github.com/davidd8/calsync"],
      ["link", "https://mail.example.com", "https://github.com/toothbrush-inc/mailfeed"],
    ]);
  });

  it("stays quiet about a repo when a tile has none, and about tools when a link has none", async () => {
    const harness = await startHarness({
      web: { path: "/weather", label: "Weather" },
      links: [{ href: "https://mail.example.com", label: "MailFeed" }],
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).not.toContain("Run it yourself");
    expect(html).toContain('<ul class="chips"><li>Web app</li><li>Works with your assistant</li></ul>');
    expect(html).toContain('<ul class="chips"><li>Web app</li></ul>');
  });

  it("names a signed-in tool group from the manifest even when the app has no page", async () => {
    const harness = await startHarness({ manifestStore: { name: "Wx Tools" } });
    const anon = await (await getHome(harness, "text/html", null)).text();
    expect(anon).not.toContain("Wx Tools");
    expect(anon).toContain("No apps are listed yet");
    const signedIn = await (await getHome(harness, "text/html")).text();
    expect(signedIn).toContain("Wx Tools");
    expect(signedIn).toContain("echo");
    // The tool list folds behind the heading, which keeps the count.
    expect(signedIn).toContain(
      '<details class="tool-group"><summary><h3 class="tool-group-name">Wx Tools <span class="health health--ok">4 tools</span></h3></summary><ul class="tools">',
    );
  });

  it("links a sibling app that is not a mounted capability", async () => {
    const harness = await startHarness({
      links: [
        {
          href: "https://mail.example.com",
          label: "MailFeed",
          description: "Reading feed from your inbox",
        },
      ],
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).toContain('href="https://mail.example.com"');
    expect(html).toContain("MailFeed");
    expect(html).toContain("Reading feed from your inbox");
  });

  it("uses the store block for the words above the tiles and the contact section", async () => {
    const harness = await startHarness({
      store: {
        name: "Toys",
        headline: "Little apps for the family.",
        lede: "Sign in once.",
        contact: { email: "hi@example.com", byline: "Built by D" },
      },
    });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).toContain("<title>Toys</title>");
    expect(html).toContain('class="wordmark" href="/">Toys</a>');
    expect(html).toContain("Little apps for the family.");
    expect(html).toContain("Sign in once.");
    // The buttons are mailto links with the subject prefilled.
    expect(html).toContain('href="mailto:hi@example.com?subject=App%20idea%20for%20Toys">Suggest an app</a>');
    expect(html).toContain('href="mailto:hi@example.com?subject=Hello%20from%20Toys">Say hello</a>');
    expect(html).toContain('<a href="mailto:hi@example.com">hi@example.com</a>');
    expect(html).toContain("Built by D");
    expect(html).toContain(`<span>© ${String(new Date().getFullYear())} Toys</span>`);
  });

  it("shows no subtext when the store block sets a headline without a lede", async () => {
    const harness = await startHarness({ store: { name: "Toy Box", headline: "Daily apps to improve your day" } });
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).toContain('<h1 class="headline">Daily apps to improve your day</h1></header>');
    expect(html).not.toContain('class="lede"');
    expect(html).toContain("<span>© ");
    expect(html).not.toContain("<span>127.0.0.1</span>");
  });

  it("hides the contact section when no contact is configured", async () => {
    const harness = await startHarness();
    const html = await (await getHome(harness, "text/html", null)).text();
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Suggest an app");
  });

  it("serves the same facts as JSON, scoped to the viewer", async () => {
    const harness = await startHarness({ web: { path: "/weather", label: "Weather" } });
    type Body = {
      ok: boolean;
      data: {
        apps: { href: string; label: string }[];
        mcpUrl: string;
        viewer?: { email: string };
        capabilities?: { id: string; state: string; tools: { name: string }[] }[];
      };
    };
    const anonymous = (await (await getHome(harness, "application/json", null)).json()) as Body;
    expect(anonymous.ok).toBe(true);
    expect(anonymous.data.apps.map((app) => app.href)).toEqual(["/weather"]);
    expect(anonymous.data.mcpUrl).toBe("http://127.0.0.1/mcp");
    expect(anonymous.data.capabilities).toBeUndefined();
    expect(anonymous.data.viewer).toBeUndefined();

    const signedIn = (await (await getHome(harness, "application/json")).json()) as Body;
    const weather = signedIn.data.capabilities?.find((cap) => cap.id === "weather");
    expect(weather?.state).toBe("connected");
    expect(weather?.tools.map((tool) => tool.name)).toContain("echo");
  });

  it("refuses a bad bearer token rather than falling back to anonymous", async () => {
    const harness = await startHarness();
    expect((await getHome(harness, "text/html", "not-a-token")).status).toBe(401);
  });

  it("answers an unknown path with a themed 404, not the store page", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.url}/nope`, {
      headers: { accept: "text/html", Authorization: "Bearer secret-token-1" },
    });
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Not found");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Open Weather");
  });
});

const OWNER_TOOLS = [
  "gateway_get_profile",
  "gateway_set_profile",
  "gateway_grant",
  "gateway_revoke_grant",
  "gateway_reconnect",
];

describe("owner-only tools over http", () => {
  it("hides and refuses the management tools for everyone but configured owners", async () => {
    const harness = await startHarness({ owners: ["dev"] });
    const owner = connectedClient(harness, "secret-token-1");
    await owner.connect();
    const other = connectedClient(harness, "secret-token-2");
    await other.connect();

    const ownerNames = (await owner.client.listTools()).tools.map((tool) => tool.name);
    expect(ownerNames).toEqual(expect.arrayContaining(OWNER_TOOLS));
    const otherNames = (await other.client.listTools()).tools.map((tool) => tool.name);
    for (const name of OWNER_TOOLS) {
      expect(otherNames).not.toContain(name);
    }
    expect(otherNames).toContain("gateway_status");
    expect(otherNames).toContain("weather__echo");

    // Hidden is not enough: a call by name is refused and audited.
    const refused = await other.client.callTool(
      { name: "gateway_revoke_grant", arguments: { capability: "weather", connection: "purpleair:default" } },
      CallToolResultSchema,
    );
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe("owner_only");
    const row = readFileSync(harness.auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEntry)
      .find((entry) => entry.tool === "gateway_revoke_grant");
    expect(row).toMatchObject({ outcome: "denied", denied_by: "policy", error_code: "owner_only", user: "other" });

    const allowed = await owner.client.callTool({ name: "gateway_get_profile", arguments: {} }, CallToolResultSchema);
    expect(allowed.isError).not.toBe(true);
  });

  it("gives nobody the management tools when no owners are configured", async () => {
    const harness = await startHarness();
    const dev = connectedClient(harness, "secret-token-1");
    await dev.connect();
    const names = (await dev.client.listTools()).tools.map((tool) => tool.name);
    for (const name of OWNER_TOOLS) {
      expect(names).not.toContain(name);
    }
    const refused = await dev.client.callTool({ name: "gateway_get_profile", arguments: {} }, CallToolResultSchema);
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe("owner_only");
  });
});

describe("view owner over http", () => {
  it("stamps the signed-in user as the owner whatever the client wrote", async () => {
    const harness = await startHarness();
    const dev = connectedClient(harness, "secret-token-1");
    await dev.connect();
    const view = {
      id: "mine",
      title: "Mine",
      owner: "victim@example.com",
      sensitivity: "shareable",
      queries: [{ key: "e", tool: "weather__echo", arguments: { text: "hi" } }],
      transform: "(input) => ({ title: 'Mine', sections: [{ kind: 'text', text: input.e.data.echoed }] })",
      refresh: { intervalMs: null },
    };
    const pinned = await dev.client.callTool({ name: "pin_view", arguments: { view } }, CallToolResultSchema);
    expect((pinned.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(harness.core.views?.get("mine")?.owner).toBe("dev");
    const rows = readFileSync(harness.auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEntry);
    expect(rows.find((entry) => entry.tool === "call:weather__echo")).toMatchObject({
      capability: "view-mine",
      user: "dev",
    });

    // The field is optional over http: the sign-in is the owner.
    const { owner: _ignored, ...withoutOwner } = view;
    const previewed = await dev.client.callTool(
      { name: "preview_view", arguments: { view: { ...withoutOwner, id: "mine2" } } },
      CallToolResultSchema,
    );
    expect((previewed.structuredContent as { ok: boolean }).ok).toBe(true);
  });
});

it("keeps private views, previews and MCP resources with their owner", async () => {
  const harness = await startHarness();
  const alice = connectedClient(harness, "secret-token-1");
  const bob = connectedClient(harness, "secret-token-2");
  await alice.connect(); await bob.connect();
  const view = {
    id: "private", title: "Private", sensitivity: "private",
    queries: [{ key: "e", tool: "weather__echo", arguments: { text: "secret" } }],
    transform: "input => ({ title: 'Private', sections: [{ kind: 'text', text: input.e.data.echoed }] })",
    refresh: { intervalMs: null },
  };
  const pin = await alice.client.callTool({ name: "pin_view", arguments: { view } }, CallToolResultSchema);
  expect(pin.isError).not.toBe(true);
  expect((await bob.client.listResources()).resources).toHaveLength(0);
  await expect(bob.client.readResource({ uri: "view://private" })).rejects.toThrow();
  await expect(bob.client.subscribeResource({ uri: "view://private" })).rejects.toThrow();
  for (const name of ["run_view", "unpin_view"]) {
    expect((await bob.client.callTool({ name, arguments: { id: "private" } }, CallToolResultSchema)).isError).toBe(true);
  }
  expect((await bob.client.callTool({ name: "pin_view", arguments: { view } }, CallToolResultSchema)).isError).toBe(true);
  const headers = { Authorization: "Bearer secret-token-2" };
  expect((await fetch(`${harness.url}/views/private.json`, { headers })).status).toBe(404);
  const list = await fetch(`${harness.url}/views`, { headers });
  expect(await list.text()).not.toContain('"private"');
  const preview = await harness.core.views!.preview({ ...view, owner: "dev" }, "dev");
  if (!preview.ok) throw new Error(preview.message);
  expect((await fetch(`${harness.url}/views/preview/${preview.preview.token}`, { headers })).status).toBe(404);
  expect((await fetch(`${harness.url}/views/private.json`, { headers: { Authorization: "Bearer secret-token-1" } })).status).toBe(200);
  const shared = await alice.client.callTool({ name: "pin_view", arguments: { view: { ...view, sensitivity: "shareable" } } }, CallToolResultSchema);
  expect(shared.isError).not.toBe(true);
  expect((await bob.client.listResources()).resources).toHaveLength(1);
  expect((await bob.client.callTool({ name: "unpin_view", arguments: { id: "private" } }, CallToolResultSchema)).isError).toBe(true);
});

it("binds MCP sessions to the user even when the OAuth client is shared", async () => {
  const harness = await startHarness({ sameClient: true });
  const alice = connectedClient(harness, "secret-token-1");
  await alice.connect();
  const response = await fetch(`${harness.url}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-token-2", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": alice.transport.sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect(response.status).toBe(403);
});

it("serves CSP, frame and referrer protections and tolerates malformed cookies", async () => {
  const harness = await startHarness();
  const response = await fetch(harness.url, { headers: { Cookie: "gw_session=%zz" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
});

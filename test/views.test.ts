import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openVault } from "@local/vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditWriter, type AuditEntry } from "../src/audit.js";
import { GatewayConfigSchema, type GatewayConfig } from "../src/config.js";
import { createGateway, type Gateway } from "../src/gateway.js";
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

interface Harness {
  gateway: Gateway;
  client: Client;
  auditPath: string;
  env: NodeJS.ProcessEnv;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-views-"));
  dirs.push(dir);
  const env = {
    VAULT_HOME: join(dir, "vault"),
    VAULT_SECRETS_BACKEND: "file",
  } as NodeJS.ProcessEnv;

  // The fake weather manifest annotates `echo` as a query tool; boom is not.
  const manifestPath = join(dir, "capability.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ id: "weather", connections: [], tools: { query: ["echo"] } }),
  );

  const fake = await startFakeWeather();
  const config: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      capabilities: [{ id: "weather", command: "unused", manifestPath }],
      views: { dir: join(dir, "views") },
    }),
    configPath: join(dir, "gateway.config.json"),
  };
  const audit = new AuditWriter({ dir: join(dir, "audit") });
  const gateway = await createGateway({
    config,
    audit,
    env,
    log: () => undefined,
    transportFactory: (): Transport => fake.transport,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([client.connect(clientSide), gateway.connect(serverSide)]);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
  });
  return { gateway, client, auditPath: audit.path, env };
}

const GOOD_VIEW = {
  id: "morning",
  title: "Morning echo",
  owner: "dvd",
  sensitivity: "shareable",
  queries: [{ key: "e", tool: "weather__echo", arguments: { text: "hello" } }],
  transform:
    "(input) => ({ title: 'Morning', sections: [{ kind: 'text', text: input.e.data.echoed }] })",
  refresh: { intervalMs: null },
};

async function callJson(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await harness.client.callTool({ name, arguments: args }, CallToolResultSchema);
  return result.structuredContent as Record<string, unknown>;
}

function audits(harness: Harness): AuditEntry[] {
  return readFileSync(harness.auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("views through the gateway", () => {
  it("pin proves, persists, grants, and serves; unpin revokes", async () => {
    const harness = await startHarness();
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["pin_view", "run_view", "list_views", "unpin_view"]),
    );

    const pinned = await callJson(harness, "pin_view", { view: GOOD_VIEW });
    expect(pinned["ok"]).toBe(true);
    const snapshot = (pinned["data"] as { snapshot: { ok: boolean; model: { sections: unknown[] }; provenance: unknown[] } }).snapshot;
    expect(snapshot.ok).toBe(true);
    expect(snapshot.model.sections[0]).toEqual({ kind: "text", text: "hello" });
    expect(snapshot.provenance[0]).toMatchObject({ key: "e", capability: "weather" });

    // pin wrote the view's grant (the pin IS the consent)
    const grants = openVault({ env: harness.env }).listGrants("view-morning");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ connectionId: "capability:weather", actions: ["echo"] });

    // audited like /call rows, attributed to the view and its owner
    expect(audits(harness).find((row) => row.tool === "call:weather__echo")).toMatchObject({
      capability: "view-morning",
      outcome: "ok",
      user: "dvd",
      target: "weather",
    });
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("hello");

    const listed = await callJson(harness, "list_views", {});
    expect((listed["data"] as { views: unknown[] }).views).toHaveLength(1);

    const run = await callJson(harness, "run_view", { id: "morning" });
    expect((run["data"] as { ok: boolean }).ok).toBe(true);

    const unpinned = await callJson(harness, "unpin_view", { id: "morning" });
    expect(unpinned["ok"]).toBe(true);
    expect(openVault({ env: harness.env }).listGrants("view-morning")).toHaveLength(0);
    expect((((await callJson(harness, "list_views", {}))["data"]) as { views: unknown[] }).views).toHaveLength(0);
  });

  it("refuses bad pins with no residue: non-query tools, unknown producers, broken transforms", async () => {
    const harness = await startHarness();

    const notQuery = await callJson(harness, "pin_view", {
      view: { ...GOOD_VIEW, queries: [{ key: "b", tool: "weather__boom" }] },
    });
    expect((notQuery["error"] as { code: string }).code).toBe("not_query_tool");

    const unknownProducer = await callJson(harness, "pin_view", {
      view: { ...GOOD_VIEW, queries: [{ key: "x", tool: "nonesuch__echo" }] },
    });
    expect((unknownProducer["error"] as { code: string }).code).toBe("unknown_capability");

    const brokenTransform = await callJson(harness, "pin_view", {
      view: { ...GOOD_VIEW, transform: "(input) => { throw new Error('nope'); }" },
    });
    expect((brokenTransform["error"] as { code: string }).code).toBe("pin_failed");
    expect((brokenTransform["detail"] as { kind: string }).kind).toBe("transform");

    // nothing persisted, no grants left behind
    expect((((await callJson(harness, "list_views", {}))["data"]) as { views: unknown[] }).views).toHaveLength(0);
    expect(openVault({ env: harness.env }).listGrants("view-morning")).toHaveLength(0);
  });

  it("revocation mid-session degrades the view to an error snapshot", async () => {
    const harness = await startHarness();
    await callJson(harness, "pin_view", { view: GOOD_VIEW });
    openVault({ env: harness.env }).revokeGrant("view-morning", "capability:weather");

    const run = await callJson(harness, "run_view", { id: "morning", refresh: true });
    const data = run["data"] as {
      ok: boolean;
      error: { kind: string };
      queryErrors: Record<string, { code: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.error.kind).toBe("query");
    expect(data.queryErrors["e"]?.code).toBe("grant_missing");
  });

  it("exposes views as subscribable view:// resources", async () => {
    const harness = await startHarness();
    await callJson(harness, "pin_view", { view: GOOD_VIEW });

    const resources = await harness.client.listResources();
    expect(resources.resources[0]).toMatchObject({ uri: "view://morning", name: "morning" });

    const read = await harness.client.readResource({ uri: "view://morning" });
    const card = JSON.parse((read.contents[0] as { text: string }).text) as {
      ok: boolean;
      model: { title: string };
    };
    expect(card.ok).toBe(true);
    expect(card.model.title).toBe("Morning");

    const updated: string[] = [];
    harness.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updated.push(notification.params.uri);
    });
    await harness.client.subscribeResource({ uri: "view://morning" });
    await callJson(harness, "run_view", { id: "morning", refresh: true });
    await vi.waitFor(() => {
      expect(updated).toContain("view://morning");
    });

    await expect(harness.client.readResource({ uri: "view://nope" })).rejects.toThrow(/not found/);
  });
});

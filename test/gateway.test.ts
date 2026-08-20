import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openVault } from "@local/vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditWriter, type AuditEntry } from "../src/audit.js";
import { GatewayConfigSchema, type GatewayConfig } from "../src/config.js";
import { createGateway, type Gateway } from "../src/gateway.js";
import { PLANTED_CHILD_SECRET, startFakeWeather, type FakeCapability } from "./fakes.js";

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
  fake: FakeCapability;
  auditPath: string;
  vaultHome: string;
  setFakeTransport(transport: Transport): void;
}

async function startHarness(options: { denyTools?: string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-int-"));
  dirs.push(dir);
  const vaultHome = join(dir, "vault");
  const env = {
    VAULT_HOME: vaultHome,
    VAULT_SECRETS_BACKEND: "file",
  } as NodeJS.ProcessEnv;

  const fake = await startFakeWeather();
  const transports = new Map<string, Transport>([["weather", fake.transport]]);

  const config: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      capabilities: [
        {
          id: "weather",
          command: "unused",
          ...(options.denyTools === undefined ? {} : { denyTools: options.denyTools }),
        },
      ],
    }),
    configPath: join(dir, "gateway.config.json"),
  };
  const audit = new AuditWriter({ dir: join(dir, "audit") });
  const gateway = await createGateway({
    config,
    audit,
    env,
    log: () => undefined,
    transportFactory: (spec) => {
      const transport = transports.get(spec.id);
      if (transport === undefined) {
        throw new Error(`no fake transport for ${spec.id}`);
      }
      return transport;
    },
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([client.connect(clientSide), gateway.connect(serverSide)]);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
  });

  return {
    gateway,
    client,
    fake,
    auditPath: audit.path,
    vaultHome,
    setFakeTransport: (transport) => transports.set("weather", transport),
  };
}

function readAudit(path: string): AuditEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("gateway", () => {
  it("lists prefixed child tools with schemas intact, plus the meta tools", async () => {
    const harness = await startHarness();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "weather__echo",
        "weather__boom",
        "weather__progress",
        "weather__wait",
        "gateway_status",
        "gateway_reconnect",
        "gateway_get_profile",
        "gateway_set_profile",
      ]),
    );
    expect(names).toHaveLength(8);
    const echo = listed.tools.find((tool) => tool.name === "weather__echo");
    expect(echo?.description).toBe("Echoes input");
    expect(echo?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("forwards calls, returns results verbatim, and audits with original names", async () => {
    const harness = await startHarness();
    const result = await harness.client.callTool(
      { name: "weather__echo", arguments: { text: "PLANTED-ARGUMENT-hi" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true, data: { echoed: "PLANTED-ARGUMENT-hi" } });

    const entries = readAudit(harness.auditPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ capability: "weather", tool: "echo", outcome: "ok" });
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("PLANTED-ARGUMENT");
  });

  it("hides denied tools, blocks their calls, and audits the denial", async () => {
    const harness = await startHarness({ denyTools: ["boom"] });
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("weather__boom");

    const result = await harness.client.callTool({ name: "weather__boom" }, CallToolResultSchema);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "denied_by_policy" },
    });

    const entries = readAudit(harness.auditPath);
    expect(entries[0]).toMatchObject({
      capability: "weather",
      tool: "boom",
      outcome: "denied",
      denied_by: "policy",
    });
  });

  it("passes child isError results through and audits only the error code", async () => {
    const harness = await startHarness();
    const result = await harness.client.callTool({ name: "weather__boom" }, CallToolResultSchema);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "grant_missing" } });

    const entries = readAudit(harness.auditPath);
    expect(entries[0]).toMatchObject({ outcome: "error", error_code: "grant_missing" });
    const rawAudit = readFileSync(harness.auditPath, "utf8");
    expect(rawAudit).not.toContain(PLANTED_CHILD_SECRET);
    expect(rawAudit).not.toContain("not granted");
  });

  it("bridges progress notifications with the upstream token", async () => {
    const harness = await startHarness();
    const progresses: number[] = [];
    await harness.client.callTool(
      { name: "weather__progress", arguments: { steps: 3 } },
      CallToolResultSchema,
      { onprogress: (progress) => progresses.push(progress.progress) },
    );
    await vi.waitFor(() => {
      expect(progresses).toEqual([1, 2, 3]);
    });
  });

  it("propagates cancellation to the child handler", async () => {
    const harness = await startHarness();
    const controller = new AbortController();
    const pending = harness.client.callTool({ name: "weather__wait" }, CallToolResultSchema, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(harness.fake.state.aborts).toBe(1);
    });
  });

  it("rejects task-augmented calls before they reach a child", async () => {
    const harness = await startHarness();
    await expect(
      harness.client.request(
        {
          method: "tools/call",
          params: { name: "weather__echo", arguments: { text: "x" }, task: { ttl: 60_000 } },
        },
        CallToolResultSchema,
      ),
    ).rejects.toThrow(McpError);
  });

  it("returns unknown_tool for unroutable names", async () => {
    const harness = await startHarness();
    const noSeparator = await harness.client.callTool({ name: "nope" }, CallToolResultSchema);
    expect(noSeparator.structuredContent).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    const missing = await harness.client.callTool({ name: "weather__nope" }, CallToolResultSchema);
    expect(missing.structuredContent).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  it("reports status including vault grants and policy denials", async () => {
    const harness = await startHarness({ denyTools: ["boom"] });
    openVault({ home: harness.vaultHome, backend: "file" }).putGrant({
      capability: "weather",
      connectionId: "purpleair:default",
      actions: ["read"],
    });

    const status = await harness.client.callTool({ name: "gateway_status" }, CallToolResultSchema);
    const data = (status.structuredContent as { data: { capabilities: unknown[] } }).data;
    expect(data.capabilities[0]).toMatchObject({
      id: "weather",
      state: "connected",
      tools: 3,
      tools_denied_by_policy: ["boom"],
      grants: [
        { id: "weather:purpleair:default", connectionId: "purpleair:default", actions: ["read"] },
      ],
      egress: { enabled: false, hosts: [] },
    });
  });

  it("marks a dead child offline, drops its tools, and revives it via gateway_reconnect", async () => {
    const harness = await startHarness();
    await harness.fake.server.close();

    await vi.waitFor(async () => {
      const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("weather__echo");
    });

    const offline = await harness.client.callTool({ name: "weather__echo", arguments: { text: "x" } }, CallToolResultSchema);
    expect(offline.structuredContent).toMatchObject({
      ok: false,
      error: { code: "capability_offline" },
    });

    const replacement = await startFakeWeather();
    harness.setFakeTransport(replacement.transport);
    const reconnect = await harness.client.callTool(
      { name: "gateway_reconnect", arguments: { capability: "weather" } },
      CallToolResultSchema,
    );
    expect(reconnect.structuredContent).toMatchObject({
      ok: true,
      data: { capability: "weather", state: "connected" },
    });

    const revived = await harness.client.callTool(
      { name: "weather__echo", arguments: { text: "back" } },
      CallToolResultSchema,
    );
    expect(revived.structuredContent).toEqual({ ok: true, data: { echoed: "back" } });
  });
});

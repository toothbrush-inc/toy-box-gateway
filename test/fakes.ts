import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export const PLANTED_CHILD_SECRET = "sk_live_LEAKME1234567890";

export interface FakeCapability {
  server: McpServer;
  /** Client-side end of the linked pair, for the gateway to mount. */
  transport: Transport;
  state: { aborts: number };
}

/** In-process stand-in for a capability MCP server, already connected. */
export async function startFakeWeather(): Promise<FakeCapability> {
  const state = { aborts: 0 };
  const server = new McpServer({ name: "weather", version: "0.0.1" });

  server.registerTool(
    "echo",
    { description: "Echoes input", inputSchema: { text: z.string() } },
    ({ text }) => {
      const payload = { ok: true, data: { echoed: text } };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool("boom", { description: "Fails like an ungranted fetch" }, () => {
    const payload = {
      ok: false,
      error: {
        code: "grant_missing",
        message: `weather is not granted purpleair:default; key ${PLANTED_CHILD_SECRET}`,
      },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  });

  server.registerTool(
    "progress",
    { description: "Sends progress ticks", inputSchema: { steps: z.number() } },
    async ({ steps }, extra) => {
      for (let tick = 1; tick <= steps; tick += 1) {
        const token = extra._meta?.progressToken;
        if (token !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: tick, total: steps },
          });
        }
      }
      return { content: [{ type: "text" as const, text: "done" }] };
    },
  );

  server.registerTool("wait", { description: "Hangs until cancelled" }, async (extra) => {
    await new Promise<void>((resolve) => {
      if (extra.signal.aborted) {
        resolve();
        return;
      }
      extra.signal.addEventListener("abort", () => {
        state.aborts += 1;
        resolve();
      });
    });
    return { content: [{ type: "text" as const, text: "aborted" }], isError: true };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return { server, transport: clientSide, state };
}

#!/usr/bin/env node
// Stdio MCP gateway entry. stdout is the MCP wire; all diagnostics go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig, resolveConfigPath } from "./config.js";
import { createGateway, GATEWAY_VERSION } from "./gateway.js";

async function main(argv: readonly string[]): Promise<void> {
  const args = argv.filter((arg) => arg !== "run");
  if (args.includes("--version")) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return;
  }
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: capability-gateway [run] [--config <path>]\n" +
        "Config resolution: --config, then GATEWAY_CONFIG, then ./gateway.config.json.\n",
    );
    return;
  }

  const configPath = resolveConfigPath(args, process.env);
  const config = loadGatewayConfig(configPath);
  const gateway = await createGateway({ config, version: GATEWAY_VERSION });

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void gateway
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.connect(new StdioServerTransport());
  process.stderr.write(
    `capability-gateway: listening on stdio (config ${configPath}, ` +
      `${String(config.capabilities.length)} capabilities)\n`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`capability-gateway: ${message}\n`);
  process.exit(1);
});

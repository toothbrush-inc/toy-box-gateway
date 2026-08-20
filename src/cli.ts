#!/usr/bin/env node
// Gateway entry. `run` (default): stdio MCP server — stdout is the MCP wire.
// `serve`: public Streamable-HTTP endpoint. All diagnostics go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig, parseBearerTokens, resolveConfigPath } from "./config.js";
import { createGateway, createGatewayCore, GATEWAY_VERSION } from "./gateway.js";
import { staticTokenVerifier } from "./http/auth-static.js";
import { startHttpGateway } from "./http/server.js";

function onShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runStdio(args: readonly string[]): Promise<void> {
  const configPath = resolveConfigPath(args, process.env);
  const config = loadGatewayConfig(configPath);
  const gateway = await createGateway({ config, version: GATEWAY_VERSION });
  onShutdown(() => gateway.close());
  await gateway.connect(new StdioServerTransport());
  process.stderr.write(
    `capability-gateway: listening on stdio (config ${configPath}, ` +
      `${String(config.capabilities.length)} capabilities)\n`,
  );
}

async function runServe(args: readonly string[]): Promise<void> {
  const configPath = resolveConfigPath(args, process.env);
  const config = loadGatewayConfig(configPath);
  const serve = config.serve;
  if (serve === undefined) {
    throw new Error(`config at ${configPath} has no "serve" block (required for capability-gateway serve)`);
  }
  if (serve.auth.stage !== "static") {
    throw new Error('serve.auth.stage "oauth" is not implemented yet; use "static"');
  }
  const tokens = parseBearerTokens(process.env[serve.auth.tokensEnv]);
  if (tokens.size === 0) {
    throw new Error(
      `no bearer tokens in $${serve.auth.tokensEnv} (format: label:token[,label2:token2])`,
    );
  }
  const core = await createGatewayCore({ config, version: GATEWAY_VERSION });
  const http = await startHttpGateway({
    core,
    serve,
    verifier: staticTokenVerifier(tokens, serve.publicUrl),
  });
  onShutdown(async () => {
    await http.close();
    await core.close();
  });
  process.stderr.write(
    `capability-gateway: serving ${serve.publicUrl}/mcp with ${String(tokens.size)} bearer token(s), ` +
      `${String(config.capabilities.length)} capabilities\n`,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--version")) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return;
  }
  if (argv.includes("--help")) {
    process.stdout.write(
      "Usage: capability-gateway [run|serve] [--config <path>]\n" +
        "  run    stdio MCP server (default)\n" +
        "  serve  public Streamable-HTTP MCP endpoint (requires config.serve)\n" +
        "Config resolution: --config, then GATEWAY_CONFIG, then ./gateway.config.json.\n",
    );
    return;
  }
  const [first, ...rest] = argv;
  if (first === "serve") {
    await runServe(rest);
    return;
  }
  await runStdio(first === "run" ? rest : argv);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`capability-gateway: ${message}\n`);
  process.exit(1);
});

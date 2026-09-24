#!/usr/bin/env node
// Gateway entry. `run` (default): stdio MCP server — stdout is the MCP wire.
// `serve`: public Streamable-HTTP endpoint. All diagnostics go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig, resolveConfigPath } from "./config.js";
import { loadEgressSpecs, loadGoogleOAuthCreds } from "./egress.js";
import { createGateway, createGatewayCore, GATEWAY_VERSION } from "./gateway.js";
import { GoogleConnectFlow } from "./http/connect.js";
import { accessStoreFor, buildServeAuth } from "./http/oauth/runtime.js";
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
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const auth = buildServeAuth(serve, process.env, log);
  const core = await createGatewayCore({ config, version: GATEWAY_VERSION });
  // The connect flow reuses the broker's Google client on purpose: a refresh
  // token only redeems against the client that minted it.
  let connect: GoogleConnectFlow | undefined;
  if (config.oauth?.google?.connect !== undefined) {
    connect = new GoogleConnectFlow({
      publicUrl: serve.publicUrl,
      creds: loadGoogleOAuthCreds(config.oauth.google),
      scopes: config.oauth.google.connect.scopes,
      specs: loadEgressSpecs(config.capabilities, log),
      env: process.env,
      log,
    });
  }
  const http = await startHttpGateway({
    core,
    serve,
    verifier: auth.verifier,
    ...(config.links.length === 0 ? {} : { links: config.links }),
    ...(config.store === undefined ? {} : { store: config.store }),
    ...(auth.provider === undefined ? {} : { oauth: auth.provider }),
    ...(connect === undefined ? {} : { connect }),
  });
  onShutdown(async () => {
    await http.close();
    await core.close();
  });
  process.stderr.write(
    `capability-gateway: serving ${serve.publicUrl}/mcp with ${auth.description}, ` +
      `${String(config.capabilities.length)} capabilities\n`,
  );
}

/**
 * `waitlist [list|invite <email>|uninvite <email>|remove <email>]`: the
 * people who signed in before being invited, and the invitations that let
 * them in. Works on the files the running gateway re-reads, so nothing
 * here needs a restart.
 */
function runWaitlist(args: readonly string[]): void {
  const configPath = resolveConfigPath(args, process.env);
  const config = loadGatewayConfig(configPath);
  const auth = config.serve?.auth;
  if (auth === undefined || auth.stage !== "oauth") {
    throw new Error(`config at ${configPath} has no oauth login (serve.auth.stage: "oauth"), so nobody can wait`);
  }
  const access = accessStoreFor(auth.oauth);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--config");
  const [action = "list", email] = positional;
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const need = (): string => {
    if (email === undefined || !email.includes("@")) {
      throw new Error(`waitlist ${action} needs an email address`);
    }
    return email;
  };
  switch (action) {
    case "list": {
      const waiting = access.listWaitlist();
      const invited = access.listInvited();
      out(waiting.length === 0 ? "waiting: nobody" : "waiting:");
      for (const entry of waiting) {
        out(`  ${entry.requestedAt}  ${entry.email}`);
      }
      out(invited.length === 0 ? "invited: nobody beyond allowedEmails" : "invited:");
      for (const entry of invited) {
        out(`  ${entry.invitedAt}  ${entry.email}`);
      }
      return;
    }
    case "invite": {
      const result = access.invite(need());
      out(
        result.status === "invited"
          ? `invited ${email ?? ""}${result.fromWaitlist ? " (was waiting)" : ""}; their next sign-in opens the apps`
          : `${email ?? ""} is already allowed`,
      );
      return;
    }
    case "uninvite": {
      const result = access.uninvite(need());
      if (result === "seed") {
        throw new Error(`${email ?? ""} is in allowedEmails in the config; remove it there`);
      }
      out(result === "removed" ? `uninvited ${email ?? ""}; their sessions and tokens stop on the next check` : `${email ?? ""} was not invited`);
      return;
    }
    case "remove": {
      out(access.removeFromWaitlist(need()) ? `removed ${email ?? ""} from the waiting list` : `${email ?? ""} is not waiting`);
      return;
    }
    default:
      throw new Error(`unknown waitlist action "${action}" (list, invite, uninvite, remove)`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--version")) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return;
  }
  if (argv.includes("--help")) {
    process.stdout.write(
      "Usage: capability-gateway [run|serve|waitlist] [--config <path>]\n" +
        "  run       stdio MCP server (default)\n" +
        "  serve     public Streamable-HTTP MCP endpoint (requires config.serve)\n" +
        "  waitlist  [list|invite <email>|uninvite <email>|remove <email>] (oauth login only)\n" +
        "Config resolution: --config, then GATEWAY_CONFIG, then ./gateway.config.json.\n",
    );
    return;
  }
  const [first, ...rest] = argv;
  if (first === "serve") {
    await runServe(rest);
    return;
  }
  if (first === "waitlist") {
    runWaitlist(rest);
    return;
  }
  await runStdio(first === "run" ? rest : argv);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`capability-gateway: ${message}\n`);
  process.exit(1);
});

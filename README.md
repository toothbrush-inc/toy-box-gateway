# @local/capability-gateway

One local **stdio MCP server** that mounts your capability MCP servers
(CalSync, weather-compare, and anything that follows the
[capability contract](https://github.com/davidd8/local-vault/blob/main/CAPABILITY.md))
as child processes and re-exposes their tools to the agent under prefixed
names — with grant enforcement, tool policy, and an audit log.

The gateway is an **optional local composer**. Per the contract's standalone
rule, every capability keeps working on its own with only
[`@local/vault`](https://github.com/davidd8/local-vault); the gateway is
strictly additive. It never touches secrets itself — children still read them
from the vault in-process.

What mounting through the gateway adds:

- **One endpoint.** The agent configures one MCP server and gets every
  capability's tools as `<capability>__<tool>` (`weather__get_forecast`,
  `calsync__preview_sync`), plus `gateway_status` and `gateway_reconnect`.
- **Enforced grants.** Children are spawned with `VAULT_GRANT_MODE=explicit`,
  so the vault's grant rows — written when you connect a provider — are
  actually checked on every secret read. A present-but-ungranted secret fails
  with the capability's own actionable `grant_missing` error.
- **Tool policy.** Per-capability `allowTools` / `denyTools` in the gateway
  config; deny wins; denied tools are hidden from listings and blocked at call
  time with a message naming the config to edit.
- **Audit log.** Append-only JSONL at
  `<gateway home>/audit/audit.jsonl` (macOS:
  `~/Library/Application Support/capability-gateway`; override with
  `GATEWAY_HOME` or `audit.dir`). One line per call: timestamp, capability,
  tool, outcome (`ok` | `error` | `denied`), duration, and a typed error code
  when there is one. **Tool arguments and results are never written**;
  gateway-originated error text is token-scrubbed first. Size-based rotation.

## Install and run

```sh
npm install github:davidd8/capability-gateway
capability-gateway --config /path/to/gateway.config.json
```

Or from a checkout: `npm install && npm run build && node dist/cli.js --config …`.

Config resolution: `--config <path>` → `GATEWAY_CONFIG` env →
`./gateway.config.json`. See
[`gateway.config.example.json`](gateway.config.example.json):

```json
{
  "capabilities": [
    {
      "id": "calsync",
      "command": "node",
      "args": ["apps/cli/dist/cli.js", "mcp"],
      "cwd": "/path/to/calsync",
      "manifestPath": "/path/to/calsync/apps/cli/capability.json",
      "denyTools": ["sync_now"]
    },
    {
      "id": "weather",
      "command": "node",
      "args": ["mcp/server.mjs"],
      "cwd": "/path/to/weather-compare",
      "manifestPath": "/path/to/weather-compare/capability.json"
    }
  ]
}
```

Notes:

- calsync loads its `.env` from `cwd`, so point `cwd` at the calsync checkout
  and build it first (`npm run build`).
- `manifestPath` is optional and warn-only: `gateway_status` reports manifest
  id mismatches and required connections that have no grant row, but a
  capability is never blocked from mounting (optional connections make missing
  grants legitimate).
- Both reference capabilities already register their grant rows when you
  connect a provider, so explicit mode works without extra setup. If a call
  fails with `grant_missing`, reconnect that provider (or re-run `calsync
  auth <role>`).

Client config (Cursor / Claude Desktop), same shape as any stdio MCP server:

```json
{
  "mcpServers": {
    "capabilities": {
      "command": "capability-gateway",
      "args": ["--config", "/absolute/path/gateway.config.json"]
    }
  }
}
```

## Behavior details

- Tool results pass through verbatim — typed JSON `{ok, data}` /
  `{ok: false, error: {code, message}}`, `structuredContent` included. Child
  progress notifications are re-emitted upstream (long calls like
  `calsync__preview_sync` keep their progress), and cancelling a call at the
  agent cancels it in the child.
- A crashed capability's tools disappear from listings (`tools/list_changed`),
  its calls return `capability_offline`, and `gateway_reconnect` respawns it.
  The gateway never auto-respawns.
- Config errors, child stderr, and mount failures go to the gateway's stderr,
  prefixed `[<capability>]`.

## Egress broker

The gateway also runs a localhost **egress broker** and hands each child its
endpoint via `VAULT_EGRESS_URL` + a per-capability `VAULT_EGRESS_TOKEN`:

- **`POST /fetch`** — credentialed GET on the capability's behalf. The broker
  validates the capability's manifest `egress` declaration (host allowlist),
  checks the grant on every call (revocation takes effect immediately),
  attaches the credential (header or query param, with optional public→keyed
  host rewrite like Open-Meteo's customer hosts), scrubs the secret from the
  response body, and audits `egress:<provider>` with the requested host —
  never full URLs. Upstream non-2xx comes back as data; broker denials are
  coded (`grant_missing`, `egress_host_denied`, …).
- **`POST /token`** — OAuth token exchange: the broker holds the durable
  refresh token (and the OAuth client credentials, read at startup from the
  env file named in the gateway config's `oauth.google` block) and hands the
  capability a short-lived access token, cached until just before expiry. A
  child never sees the refresh token; a leaked access token dies within the
  hour. `invalid_grant` maps to an actionable `token_revoked`.
- **`secretsAccess: "broker"`** per capability spawns the child with
  `VAULT_SECRETS_ACCESS=broker`, making fetch-path vault reads throw so a
  code path that bypasses the broker fails loudly. Masked status reads keep
  working.

This is the hosted-security seam: locally the boundary is cooperative (a
process under your OS user could still read the vault); hosted, the same
capability code runs in a sandbox whose only network path is the broker.

## Future (not built)

Rate limits per grant; calsync's internal adoption of `/token` (a
BrokeredAuthClient for googleapis — until then calsync reads its refresh
token in-process under explicit grants); non-GET egress and streaming bodies;
OS sandboxing; hosted mode with an install/grant UI. See
[local-vault FUTURE.md](https://github.com/davidd8/local-vault/blob/main/FUTURE.md).

## Development

```sh
npm test
npm run typecheck
npm run build
```

Tests use the MCP SDK's in-memory transports with fake capability servers —
no sibling repos or child processes required.

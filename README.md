# Capability Gateway

**One sign-in, one place, and every app also works from your AI assistant.**

`@local/capability-gateway` is two things. For a person, it is a small store
of hand-built apps: open one in the browser, or add one address to Claude or
Cursor and every app becomes a set of tools in chat, with no keys to copy. For
a developer, it is an open-source **MCP gateway**: one stdio (or public HTTP)
MCP server that mounts capability MCP servers as child processes, re-exposes
their tools under prefixed names, holds the keys so the apps never do, checks
a grant on every call, and keeps an audit log of who used what.

The gateway is strictly additive. Every capability that follows the
[capability contract](https://github.com/davidd8/local-vault/blob/main/CAPABILITY.md)
keeps working on its own with only
[`@local/vault`](https://github.com/davidd8/local-vault); mounting it here
adds one endpoint, enforced grants, tool policy, a brokered network path, and
the logbook.

## Why this matters

Without a gateway, every capability you install gets a copy of your keys. The
weather app holds your PurpleAir key; the calendar app holds a token with
permanent access to your Google calendars. Trusting an app means trusting it
completely — and "revoking access" means hoping the app respects your wishes.

Under the gateway, apps don't hold keys. They hold something more like a hotel
room card:

- **The card only opens your door.** When an app wants data, it asks the front
  desk (the broker) to make the call. The desk checks that this app is allowed
  to use this account and that it's calling the real service — not somewhere
  sketchy — and only then attaches your key. The app never sees it. A
  compromised app can't steal the key or point it anywhere else.
- **Cancelling the card works instantly.** Revoke an app's grant and its very
  next request is refused — no restarts, no wondering whether it kept a copy.
  There is no copy.
- **For Google, apps get a visitor badge, not the master key.** Instead of a
  forever-token, an app gets an access token that expires within the hour; the
  refresh token stays in the desk's safe. A leaked badge dies quickly and
  can't mint more of itself.
- **There's a logbook at the desk.** Every credential use is recorded — which
  app, which service, when, allowed or refused — without ever recording your
  data or your keys. "What has this app been doing with my accounts?" has an
  answer.

The payoff is what it makes possible: installing capabilities *other people
wrote*. The worst-case cost of trying a new app drops from "it had my keys" to
"it had a visitor badge, briefly, for one door — and I have the logbook."
Day to day you notice almost nothing: same tools, same answers. Hosted, the
same design becomes a hard boundary — the sandbox makes the broker an app's
only door to the outside world.

## Two ways to use it


| Use the hosted store | Run it yourself |
|---|---|
| Open `https://toys.thephotobase.com`, sign in with Google, and open any app. Add `https://toys.thephotobase.com/mcp` as an MCP server in Claude or Claude Code and sign in when it asks; the tools show up in chat with no key to copy. | This repo, MIT licensed. `npm install`, write your own `gateway.config.json`, point it at the capabilities on your disk, and run it as a stdio MCP server or a public HTTP endpoint. |
| Keys and refresh tokens live with the broker, never in an app. Every credential use is in the logbook. | Your machine holds the vault. The same broker, grants, policy and audit log run locally, under your OS user. |
| Run by one person, for people they know. It may become a paid service; there is no pricing today. | Free, and every app listed on the store is open source too. |

## How it works

1. `gateway.config.json` lists the capabilities to mount: a command, a working
   directory, and the path to each one's `capability.json` manifest.
2. The gateway spawns each capability as a child process and connects to it
   over stdio MCP. Children run with `VAULT_GRANT_MODE=explicit`, so the
   vault's grant rows are checked on every secret read.
3. Every child tool is re-exposed to the agent as `<capability>__<tool>`
   (`weather__get_forecast`, `calsync__preview_sync`), after the per-capability
   `allowTools` / `denyTools` policy. `gateway_status` and `gateway_reconnect`
   come from the gateway itself.
4. Credentialed requests go through the gateway's egress broker. It attaches
   a key only for hosts the capability's manifest allowlists, and for Google
   hands out short-lived access tokens while keeping the refresh token.
   Details in [docs/broker.md](docs/broker.md).
5. Every call, fetch and token mint is checked against the grant rows, so
   revoking a grant takes effect on the very next request.
6. One audit row per call lands in an append-only JSONL log: timestamp,
   capability, tool, outcome, duration, and an error code when there is one.
   Arguments and results are never written.

For an agent, the gateway is one MCP server. Client config for Cursor or
Claude Desktop, the same shape as any stdio MCP server:

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

In serve mode the same gateway is a public Streamable-HTTP endpoint at
`<publicUrl>/mcp` with a sign-in, and `/` becomes the store page. See
[docs/store.md](docs/store.md).

## Quick start

```sh
npm install github:davidd8/capability-gateway
capability-gateway --config /path/to/gateway.config.json
```

Or from a checkout: `npm install && npm run build && node dist/cli.js --config …`.

Config resolution: `--config <path>` → `GATEWAY_CONFIG` env →
`./gateway.config.json`. A minimal config mounts two capabilities; see
[`gateway.config.example.json`](gateway.config.example.json) for a complete
one and [docs/config.md](docs/config.md) for every field:

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
- `capability-gateway serve` needs a `serve` block in the config (public URL,
  port, and a sign-in stage). `capability-gateway --help` lists both modes.

## What is in the box

- [docs/broker.md](docs/broker.md): the egress broker. `/fetch` for
  credentialed requests to allowlisted hosts, `/token` for short-lived Google
  access tokens with tenant slots and the onboarding consent flow, `/call` for
  grant-gated calls between capabilities, and `secretsAccess: "broker"`.
- [docs/store.md](docs/store.md): the public store page at `/`, what the
  anonymous and signed-in views show, and where each tile's words come from
  (the app's manifest `store` block, overridable from config).
- [docs/views.md](docs/views.md): pinned views. Cards authored in
  conversation, compiled once, served deterministically with no model in the
  path.
- [docs/config.md](docs/config.md): the `gateway.config.json` reference, every
  block and default.
- [docs/behavior.md](docs/behavior.md): how results, progress, cancellation,
  crashes and logging behave, plus what is not built yet.

## Development

```sh
npm test
npm run typecheck
npm run build
```

Tests use the MCP SDK's in-memory transports with fake capability servers —
no sibling repos or child processes required.

## License

MIT. See [LICENSE](LICENSE).

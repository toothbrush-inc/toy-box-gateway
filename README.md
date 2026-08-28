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

## Why this matters (the user's view)

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

  **Tenant slots**: a requested slot may be a declared one verbatim
  (`personal`) or a tenant-scoped instance of it (`acme_personal` — the
  `<tenant>_<role>` shape calsync's `tokenSlot` emits). The manifest declares
  the roles; the vault grants the instances: a tenant slot still needs its
  own `google:<tenant>_<role>` connection and grant, so an unonboarded tenant
  gets a crisp `grant_missing`, never a silent success. Token-mint audit rows
  carry the slot, so per-tenant mints stay attributable.

  **Onboarding** (`oauth.google.connect` in the config): with
  `connect: { scopes: [...] }` set, the serve process mounts a session-gated
  consent flow at `/auth/google/connect?slot=<slot>` (requires the stage-2
  browser session). It runs the Google consent with `access_type=offline` +
  PKCE using the broker's own OAuth client — the one that will redeem the
  refresh token — stores the result in the vault under `google:<slot>`, and
  grants every capability whose manifest declares the matched role, with that
  role's declared actions. Register
  `<publicUrl>/auth/google/connect/callback` as a redirect URI on that
  client once. The secret never transits a tool argument or a form field.
- **`POST /call`** — grant-gated peer capability calls: a consumer capability
  that declares `{provider: "capability", slot: "<producer>", actions:
  [tools...]}` may invoke those producer tools through the broker. The broker
  checks the declaration and the per-tool grant on every call (revocation is
  immediate), enforces the producer's tool policy, routes to the mounted
  child, and stamps **provenance** (`{capability, version, ts}` — the
  producer's package.json version read at mount) into the response. Audit rows
  are `call:<producer>__<tool>` with both sides' versions — never args or
  results. Self-calls are denied and concurrent calls per consumer are capped.
- **`secretsAccess: "broker"`** per capability spawns the child with
  `VAULT_SECRETS_ACCESS=broker`, making fetch-path vault reads throw so a
  code path that bypasses the broker fails loudly. Masked status reads keep
  working.

This is the hosted-security seam: locally the boundary is cooperative (a
process under your OS user could still read the vault); hosted, the same
capability code runs in a sandbox whose only network path is the broker.

## Views (converse → tune → pin → glance)

A **view** is a pinned, compiled artifact authored in conversation: up to 8
bound queries (producer QUERY tools with frozen arguments) + a pure sync JS
transform `(input) => CardModel` the agent writes once + a refresh policy.
**Serving is deterministic — no LLM in the path**: identical output every
render, milliseconds, zero tokens.

- **Preview before pin.** `preview_view` takes the same input as `pin_view`,
  runs it once, and returns the card JSON plus a short-lived URL
  (`/views/preview/<token>`, ~10 min, same sign-in as `/views`) the person
  opens on their phone while the agent tunes the transform. Nothing persists —
  no grants, no refresh, no entry in the index; the run is audited as
  `preview-<id>`. A failed run still gets a URL (the error card) plus the
  structured errors. When it looks right, `pin_view` with the identical view.
- **Pin = compile + prove.** `pin_view` dry-runs end to end and refuses on any
  failure (nothing persists); the refusal carries the transform/query errors
  so the agent iterates in conversation. A view that exists has rendered, and
  the pin result carries its URL.
- **Views ride the peer-call machinery.** Each view is grant-consumer
  `view-<id>`: pinning writes the per-tool grants (the pin IS the consent),
  unpinning revokes them, and mid-session revocation degrades the card to an
  error render. Views bind only tools the producer's manifest annotates as
  `tools.query` (side-effect-free) — a glance can never fire a mutation.
- **Provenance.** Snapshots and cards record which producer at which version
  supplied each query (`fitness@0.1.0`), and every query lands in the audit
  as a `call:` row attributed to `view-<id>` and the owner — never values.
- **Transform sandbox.** `node:vm`, only `JSON` and `Math` in scope, 1s
  budget, sync-only; a cooperative local boundary (hosted upgrades to
  isolates). The bounded CardModel (stats / keyValues / list / table / text /
  spark / bars / progress, with hard size caps) keeps cards card-sized.
- **The model says what the data means; the gateway owns the look.** A
  transform never writes markup or CSS — it emits a CardModel with the few
  words that carry meaning (a stat's signed `delta` and `tone`, a `progress`
  goal, a section `title`), and one renderer (`src/views/theme.ts` +
  `src/views/sections.ts`) turns every view into the same design: warm
  surfaces, serif titles over sans figures, one accent for marks, fixed
  status colors, dark mode by OS preference, phone-first. Adding a word to
  the vocabulary is one schema entry plus one renderer — the registry type
  forces the pair. Golden HTML under `test/__golden__/` locks the design.
- **Refresh.** A background interval per view plus a refresh-on-read backstop
  (a stale snapshot re-runs before serving); single-flight per view.
- **Surfaces.** MCP resources `view://<id>` (list/read/subscribe — agents see
  your cards too) and, in serve mode, bearer-authed `GET /views` (a browser
  gets the card grid — every view at a glance; API clients get JSON),
  `GET /views/<id>` (self-contained HTML, no scripts), `GET /views/<id>.json`,
  and `GET /views/preview/<token>[.json]` for live previews.
- Meta tools: `preview_view`, `pin_view`, `run_view`, `list_views`,
  `unpin_view`. Config block `views` (default-enabled): `{enabled, dir,
  maxViews, queryTimeoutMs, transformTimeoutMs, previewTtlMs}`.

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

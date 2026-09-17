Part of the [capability-gateway docs](../README.md#what-is-in-the-box). Back to [README](../README.md).

# Configuration reference

`gateway.config.json` is one JSON object. The gateway finds it by
`--config <path>`, then the `GATEWAY_CONFIG` env var, then
`./gateway.config.json`. The schema lives in `src/config.ts` (zod); this page
is the human reading of it. Where the two disagree, `src/config.ts` wins.
[`gateway.config.example.json`](../gateway.config.example.json) is a complete
worked example.

Top-level blocks:

| Block | Required | What it is |
|---|---|---|
| `capabilities` | yes | The MCP servers to mount, one entry each |
| `audit` | no | Audit log location and rotation |
| `commons` | no | Directory of shared datasets for capabilities |
| `dataDir` | no | Where private ledgers are provisioned from manifests |
| `views` | no | The pinned-views feature |
| `oauth` | no | The broker's own Google OAuth client and the connect flow |
| `serve` | serve mode only | The public HTTP endpoint |
| `links` | no | Sibling web apps on the store page |
| `store` | no | The words above the store tiles and the contact section |

## `capabilities[]`

One entry per mounted capability. Ids must be unique.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Lowercase token (`^[a-z][a-z0-9_-]*$`), no `__`, and not `gateway` (reserved). Becomes the tool prefix: `<id>__<tool>`. |
| `command` | string | The executable to spawn. |
| `args` | string[] | Default `[]`. |
| `cwd` | string | Working directory for the child. calsync loads its `.env` from here. |
| `env` | object | Extra environment for the child. The gateway adds every `VAULT_*` variable itself. |
| `allowTools` | string[] | If set, only these tool names are exposed. |
| `denyTools` | string[] | Tools hidden from listings and blocked at call time. Deny wins over allow. |
| `manifestPath` | string | Path to the capability's `capability.json`. Optional and warn-only for mounting, but required for `secretsAccess: "broker"` (the egress specs live in the manifest) and for reading the manifest's `store` block. |
| `secretsAccess` | `"broker"` | Spawns the child with `VAULT_SECRETS_ACCESS=broker` so any fetch-path vault read throws. See [broker.md](broker.md). |
| `web` | object | Where this capability's own web UI lives and the words for its store tile. See below. |

### `capabilities[].web`

The gateway cannot infer where an app's dashboard is: it is a separate
service, not the MCP child mounted here. `web` says where it is and what the
tile should say. Capabilities without a web UI are agent-only: their tools
show on the store page once someone has signed in.

| Field | Type | Notes |
|---|---|---|
| `path` | string | Absolute path under the store domain (`/weather`). Overrides the manifest's `store.web.path`. |
| `label` | string ≤60 | The tile name. The same field is `name` in the manifest's `store` block. |
| `tagline` | string ≤120 | One line under the name: what it does for you. |
| `description` | string ≤600 | A short paragraph on why it is valuable. |
| `highlights` | string[] ≤4 × ≤120 | Concrete reasons, one line each. |
| `badge` | string ≤20 | A short status word on the tile ("beta", "new"). |
| `accent` | enum | `sky`, `leaf`, `marigold`, `plum`, `clay` or `slate`. Unset tiles cycle through the palette in order. |

Every field here overrides the same field in the manifest's `store` block,
field by field. [store.md](store.md#where-the-words-come-from) has the
resolution rules and the manifest schema.

## `audit`

| Field | Type | Default |
|---|---|---|
| `dir` | string | `<gateway home>/audit` (macOS: `~/Library/Application Support/capability-gateway`; override the home with `GATEWAY_HOME`) |
| `maxBytes` | integer | 5 MiB (5242880). Size-based rotation. |
| `keepFiles` | integer ≥0 | 5 |

One JSONL line per call: timestamp, capability, tool, outcome, duration, and
a typed error code when there is one. Tool arguments and results are never
written.

## `commons`

`{ "dir": "<path>" }`. A directory of shared datasets that capabilities
declare under `data.commons` in their manifests and read through the broker
when mounted (see the capability contract, §9).

## `dataDir`

A directory in which the gateway provisions `<dataDir>/<id>/` for each
capability whose manifest declares private ledgers with an `env` name, and
injects those paths as env vars. Config entries no longer need to repeat every
app's ledger path; `capabilities[].env` still overrides.

## `views`

Default-enabled. See [views.md](views.md).

| Field | Type | Default |
|---|---|---|
| `enabled` | boolean | `true` |
| `dir` | string | `<gateway home>/views` |
| `maxViews` | integer ≤200 | 50 |
| `queryTimeoutMs` | integer | 30000 |
| `transformTimeoutMs` | integer ≤10000 | 1000 |
| `previewTtlMs` | integer, 1000 to 3600000 | 600000 (10 min) |

## `oauth.google`

The broker's own OAuth client: the one that redeems refresh tokens on a
capability's behalf. See [broker.md](broker.md).

| Field | Type | Notes |
|---|---|---|
| `envFile` | string | Env file the client id and secret are read from at startup. |
| `clientIdVar` | string | Default `GOOGLE_OAUTH_CLIENT_ID`. |
| `clientSecretVar` | string | Default `GOOGLE_OAUTH_CLIENT_SECRET`. |
| `connect.scopes` | string[] | When set, mounts the session-gated consent flow at `/auth/google/connect?slot=<slot>`. The scopes are what the consent asks Google for; set them to what the granted capabilities need. Register `<publicUrl>/auth/google/connect/callback` as a redirect URI on the client once. |

## `serve`

Required for `capability-gateway serve`; ignored by `run` (the stdio MCP
server).

| Field | Type | Default |
|---|---|---|
| `port` | integer | 8800 |
| `host` | string | `127.0.0.1` |
| `publicUrl` | URL | required; the hostname is also the store's default wordmark |
| `allowedHosts` | string[] | unset (the `publicUrl` hostname) |
| `sessionCookieDomain` | string | unset (host-only cookie; see trust warning below) |
| `credentialUsers` | object mapping `provider:slot` to user-id arrays | `{}`; bare and shared slots are denied until listed, a person's own `<tenant>_<role>` slots are always theirs |
| `owners` | string[] | `[]`: over HTTP, nobody gets the management tools |
| `allowedOrigins` | string[] | `["https://claude.ai", "https://claude.com"]` |
| `session.ttlMs` | integer | 8 hours |
| `session.maxSessions` | integer | 20 |
| `session.keepAliveMs` | integer | 15000 |
| `session.maxEventsPerSession` | integer | 500 |
| `auth` | object | one of the two stages below |

**Owners.** `gateway_reconnect`, the profile tools and the grant tools act
on the shared vault and on children every user shares, so over HTTP only
the users listed in `owners` see or may call them: the email under the
`oauth` stage, the token label under `static`. Everyone else gets
`owner_only`. The stdio gateway has one user, who is always the owner.

`auth.stage: "static"`: bearer tokens read from the env var named by
`tokensEnv` (default `GATEWAY_BEARER_TOKENS`).

`auth.stage: "oauth"`: Google sign-in for browsers plus MCP OAuth for agents.
MCP clients register themselves, so after Google confirms who is signing in
the gateway shows a consent page naming the client and the address the
code will be sent to; only an explicit Allow mints the code. A client
registered by someone else, pointing at their own host, gets nothing
without that click.

| Field | Type | Default |
|---|---|---|
| `oauth.google.clientIdVar` | string | `GATEWAY_GOOGLE_LOGIN_CLIENT_ID` |
| `oauth.google.clientSecretVar` | string | `GATEWAY_GOOGLE_LOGIN_CLIENT_SECRET` |
| `oauth.allowedEmails` | string[] | required, at least one |
| `oauth.signingKeyFile` | string | required |
| `oauth.storeDir` | string | required |
| `oauth.accessTokenTtlSec` | integer | 3600 |
| `oauth.refreshTokenTtlSec` | integer | 30 days |
| `oauth.scopesSupported` | string[] | `["mcp"]` |

This is the sign-in the store page, `/views`, and the connect flow all share.
The login client here is separate from `oauth.google` above, which is the
broker's client for capability tokens.

**A sibling host behind the same sign-in.** An app on `cal.<host>` can sit
behind the proxy's `forward_auth` too: set `sessionCookieDomain` to the
public hostname (the session cookie is then sent to every subdomain), add
the sibling to `allowedHosts` (the proxy's auth sub-request carries that
host), and have the route copy `X-Forwarded-User` to the app.
`/session/verify` sends a signed-out browser on a sibling host to this
host's `/login` with an absolute way back, and the login flow accepts an
https destination only on this host or a subdomain of it. Point a tile at
such an app with `capabilities[].web.path` set to its https URL.

## `links[]`

Sibling web apps that are not mounted capabilities but belong on the store
page. Each entry takes `href` (a full URL) plus the same copy fields as
`capabilities[].web`: `label`, `tagline`, `description`, `highlights`,
`badge`, `accent`. These have no manifest, so config is their only source.

## `store`

The words above the tiles. Everything is optional; the page falls back to the
public hostname and generic copy.

| Field | Type | Notes |
|---|---|---|
| `name` | string ≤60 | Wordmark. Defaults to the hostname of `serve.publicUrl`. |
| `headline` | string ≤160 | The big line. |
| `lede` | string ≤400 | The paragraph under it. |
| `contact.email` | email | Powers the "Suggest an app" and "Say hello" buttons. Omit `contact` to hide the section. |
| `contact.byline` | string ≤120 | Who the person is, in a few words ("Built by David"). Shown in the footer. |

### Hosted credential access

`serve.credentialUsers` explicitly assigns access to each connection in the
shared vault. The broker resolves the call nonce to the signed-in user and
checks this list before reading a secret or serving a cached token. Existing
capability declarations and grants are still required.

Tenant-scoped slots are self-serve: `<tenant>_<role>` belongs to the person
whose identity slug (`identitySlug(email)` from `@dvd-toy-box/vault`, the
same id calsync names tenants with) is `<tenant>`, so a store sign-in can
connect and use its own slots through `/auth/google/connect?slot=…` and the
broker with no entry here, and can never reach another person's. Bare slots
(`personal`, `default`) and shared keys have no tenant and are handed out
only by this list. For example:

```json
{
  "serve": {
    "owners": ["alice@example.com"],
    "credentialUsers": {
      "google:alice_personal": ["alice@example.com"],
      "purpleair:default": ["alice@example.com", "bob@example.com"]
    }
  }
}
```

This is a partial config example. Unlisted connections and calls without a
valid user nonce are denied by `/fetch` and `/token` in hosted mode. Configure
all required slots when upgrading, including intentionally shared API keys.
Hosted profile and peer-call requests also require a valid user nonce; they
never fall back to the operator profile. The Google connect route uses the same mapping and binds its pending state to
the user who started it. Stdio mode keeps its local shared-vault behavior.

Removing an email from `allowedEmails` and restarting the gateway invalidates
that user's access tokens, refresh tokens and browser cookies. Logout revokes
the presented browser token on disk, including copies of it, until expiry.

**Cookie domain trust:** keep `sessionCookieDomain` unset unless every sibling
host is trusted. Domain cookies reach sibling hosts before gateway code can
intervene. On trusted sibling proxies, remove the Cookie header before
forwarding to the app after `forward_auth`; only forward `X-Forwarded-User`.
Logout cannot undo a cookie stolen and used before revocation.

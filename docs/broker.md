Part of the [capability-gateway docs](../README.md#what-is-in-the-box). Back to [README](../README.md).

# Egress broker

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

  **Identity → tenant / profile id**: use `tenantForIdentity` /
  `identitySlug` from `@dvd-toy-box/vault` (the gateway re-exports the latter
  as `userSlug`). Emails map to `i` + the first 32 hex characters of SHA-256
  of the lowercased address — shared with calsync auto tenants and broker
  slot prefixes. Distinct addresses that only differ in punctuation no longer
  collide. Pre-hash profile directories (`owner_at_example_com`) are still read
  as a migration fallback via `legacyUserSlug`. Existing calsync
  punctuation-slug tenants and their broker slots (`<slug>_personal`) need
  `CALSYNC_WEB_IDENTITY_TENANTS` overrides or a rename before dropping the
  override map — changing the hash function alone does not move vault grants.

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
  Add `&next=<url>` and the person is sent back there after consent (with
  `?connected=<slot>` appended), or, if it failed, the failure page links
  back. `next` must be a path or an https URL on this host or a subdomain;
  anything else is ignored and the plain notice page shows.

This is the hosted-security seam: locally the boundary is cooperative (a
process under your OS user could still read the vault); hosted, the same
capability code runs in a sandbox whose only network path is the broker.

### Security limits

The broker never follows upstream redirects. `/fetch` and token exchanges
have a 30-second total deadline, a 2 MiB decoded response limit, and a shared
cap of eight in-flight upstream operations. Overflow returns 429; timeouts,
malformed bodies and oversized responses return a controlled 502. Every
request handler also catches unexpected storage/validation failures.
Hosted credential access additionally requires the nonce-resolved user to
own the slot: their own `<tenant>_<role>` slots (tenant = their identity
slug) or an entry in `serve.credentialUsers["provider:slot"]`. Hosted `/profile` and `/call`
also reject missing or invalid user nonces; see [config.md](config.md).
Forwarded MCP calls have a 60-second total budget which progress messages
cannot extend; peer calls may use a shorter requested timeout.

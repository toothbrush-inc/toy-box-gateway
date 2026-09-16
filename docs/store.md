Part of the [capability-gateway docs](../README.md#what-is-in-the-box). Back to [README](../README.md).

# The store page (`/`)

In serve mode the root is a **public** landing page: every mounted
capability that has a page or a pitch, and every sibling app (`links`), as a
tile, with a name (`label`), a `tagline`, a `description`, up to four
`highlights`, an optional `badge` ("beta") and an `accent` colour. The words
come from the app's manifest, the gateway config, or both; see
[Where the words come from](#where-the-words-come-from) below.

Under the copy, each tile says how the app can be used, as small chips:
**Web app** when it has a page, **Works with your assistant** when it is a
mounted capability (so its tools come through the MCP address), and **Open
source** when it has a `repo`. The primary action is "Open <name>" for an
app with a page, or "Use from your assistant" (a jump to the assistant
section) for an agent-only capability; a `repo` adds a "Run it yourself"
link beside it. When every tile has a `repo`, the hero adds one line saying
so: every app here is open source, use it here or run it yourself. Above the
tiles, the `store` block sets the wordmark (defaults to the public hostname),
`headline`, `lede`, and `contact.email`, which powers the "Suggest an app" /
"Say hello" buttons (omit `contact` to hide that section).

What the anonymous reader gets is the catalogue and the MCP address, and
nothing about the running system. A **signed-in** viewer — browser session
or API bearer — also sees what is mounted: each capability's tools (so an
agent-only capability is discoverable) and its health. `Accept: text/html`
renders the page; anything else gets the same facts as JSON, scoped the same
way. A bad bearer token is refused, not downgraded to anonymous.


## Where the words come from

Every tile is a small piece of copy: a name, a tagline, a paragraph, up to
four highlights, a badge, and an accent colour. Those words can come from two
places, and the gateway merges them.

1. **The app's own manifest.** A capability's `capability.json` may carry a
   `store` block. The gateway reads it from the `manifestPath` in the config
   and uses it as the default copy for that app's tile, for the signed-in
   tools list, and for `gateway_status`. This is the canonical home for the
   words: the same tagline opens the app's README, and the app repo owns it.
2. **The gateway config.** The capability's `web` block in
   `gateway.config.json` overrides any field from the manifest. Use it for
   hosted-specific wording (a different badge, a shorter tagline) or to
   provide the path when the manifest has none.

`links` entries (sibling apps that are not mounted capabilities, MailFeed
being the first) have no manifest, so their words are config-only.

The manifest block, exactly:

```jsonc
"store": {
  "name": "Weather",                       // required, ≤60; becomes the tile label
  "tagline": "…",                          // ≤120, one line under the name
  "description": "…",                      // ≤600, a short paragraph on why it is valuable
  "highlights": ["…"],                     // ≤4 lines, ≤120 each
  "badge": "beta",                         // ≤20, optional status word
  "accent": "sky",                         // sky | leaf | marigold | plum | clay | slate
  "web": { "path": "/weather" },           // where the app's web UI is mounted under the store domain; omit for agent-only
  "repo": "https://github.com/…"           // the open-source repo; shown to readers as "run it yourself"
}
```

Resolution rules:

- **Path.** Config `web.path` wins over manifest `store.web.path`. A
  capability with no path from either source is agent-only: it still gets a
  tile when it has a `tagline` (the normal shape for a manifest `store` block
  without `web`), with "Use from your assistant" as its action, and its tools
  show on the signed-in page under its name. A capability with neither a path
  nor a tagline stays off the public page. A config `web` block that carries
  copy but no path, with no path in the manifest either, gets a warning on
  stderr.
- **Every other field** is config-over-manifest, per field. A config `web`
  block that sets only `badge: "beta"` keeps the manifest's name, tagline,
  description and highlights and adds the badge.
- **Naming.** The manifest calls it `name`; the config calls it `label`.
  They are the same field.

The resolved block is what every surface sees: the HTML tile, the JSON form of
`/` (any `Accept` other than `text/html`), the per-capability `store` entry in
the MCP `gateway_status` tool, and the MCP server's `instructions`, which list
every mounted app as `id (name): tagline` so an assistant can say what is here
before calling a tool. Change the words in one place and all of them follow.

See [config.md](config.md) for the `web`, `links` and `store` config blocks.

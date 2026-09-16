Part of the [capability-gateway docs](../README.md#what-is-in-the-box). Back to [README](../README.md).

# Views (converse → tune → pin → glance)

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

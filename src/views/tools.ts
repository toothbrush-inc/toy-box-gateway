// The five view meta-tools. Descriptions teach the authoring loop: the agent
// converses, writes the transform once, previews (a URL the human opens),
// tunes, pins; serving is deterministic.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const QUERY_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", description: "Unique key; the transform reads input.<key>" },
    tool: {
      type: "string",
      description:
        "Prefixed producer QUERY tool (<capability>__<tool>); must be in the producer's manifest tools.query",
    },
    arguments: { type: "object", description: "Frozen arguments (bound at pin time)" },
  },
  required: ["key", "tool"],
} as const;

const VIEW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable token id (lowercase)" },
    title: { type: "string" },
    description: { type: "string" },
    owner: {
      type: "string",
      description:
        "Who the view reads as (audit attribution). Over HTTP the signed-in user is used and this is ignored; a local stdio gateway requires it",
    },
    sensitivity: { type: "string", enum: ["private", "shareable"] },
    queries: { type: "array", items: QUERY_SCHEMA, minItems: 1, maxItems: 8 },
    transform: {
      type: "string",
      description: "Pure sync JS: (input) => CardModel; input.<key> holds each query's typed payload",
    },
    refresh: {
      type: "object",
      properties: {
        intervalMs: {
          type: ["integer", "null"],
          description: "Refresh interval (>=5000) or null for on-demand only",
        },
      },
      required: ["intervalMs"],
    },
  },
  required: ["id", "title", "sensitivity", "queries", "transform", "refresh"],
} as const;

const CARD_MODEL_GRAMMAR =
  "CardModel = {title, subtitle?, updatedAt?, sections:[≤12]}; every section may carry title?. " +
  "Sections: stats{items:[{label,value,delta?,tone?,hint?}]} (delta is a signed string like '+12%'; tone says if that is good) · " +
  "keyValues{items:[{key,value}]} · list{items:[string|{text,tone?}]} · " +
  "table{columns:[string|{label,align?:'left'|'right'}],rows:[[string]]} · text{text} · " +
  "spark{label?,unit?,points:[number]} · bars{unit?,items:[{label,value≥0}]} · " +
  "progress{items:[{label,value,max,min?,display?,tone?}]}. tone ∈ good|warn|bad|neutral. " +
  "Say what the data MEANS (delta, tone, goal); the gateway owns the look — the same card renders on /views and /views/<id>.";

export const PREVIEW_VIEW_TOOL: Tool = {
  name: "preview_view",
  description:
    "Render a view WITHOUT pinning it: same input as pin_view. Validates, runs the bound queries and the transform once, " +
    "and returns the card JSON plus a short-lived browser URL (data.preview.url, ~10 min, signed-in like /views) " +
    "— hand that URL to the person so they can look at the card and say what to change. " +
    "Nothing persists: no grants, no refresh, no entry in /views. " +
    "A failed run returns preview_failed with the transform/query errors (and the URL of the error card). " +
    "Iterate here, but sparingly: every call carries the whole transform and returns the full card model, " +
    "so test the transform locally first and batch edits. When it looks right, call pin_view with the identical view. " +
    CARD_MODEL_GRAMMAR,
  inputSchema: {
    type: "object",
    properties: { view: VIEW_INPUT_SCHEMA },
    required: ["view"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const PIN_VIEW_TOOL: Tool = {
  name: "pin_view",
  description:
    "Pin a compiled view: bound queries + a pure sync JS transform `(input) => CardModel` + a refresh policy. " +
    "The pin dry-runs end to end and REFUSES on any failure (nothing persists) — fix and re-pin. " +
    "Pinning writes the view's grants (consent); unpinning revokes them. The result carries the card's URL (data.view.url). " +
    "Prefer preview_view first to iterate on the look. " +
    "Transform sees only JSON and Math, 1s budget. " +
    CARD_MODEL_GRAMMAR,
  inputSchema: {
    type: "object",
    properties: { view: VIEW_INPUT_SCHEMA },
    required: ["view"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const RUN_VIEW_TOOL: Tool = {
  name: "run_view",
  description:
    "Render a pinned view. Serves the cached snapshot unless stale; pass refresh: true to force re-execution.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      refresh: { type: "boolean" },
    },
    required: ["id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const LIST_VIEWS_TOOL: Tool = {
  name: "list_views",
  description: "List pinned views with their refresh policy and last-run state.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export const UNPIN_VIEW_TOOL: Tool = {
  name: "unpin_view",
  description: "Unpin a view: stops refresh, deletes the spec and snapshot, revokes its grants.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

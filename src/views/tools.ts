// The four view meta-tools. Descriptions teach the authoring loop: the agent
// converses, writes the transform once, pins; serving is deterministic.

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

export const PIN_VIEW_TOOL: Tool = {
  name: "pin_view",
  description:
    "Pin a compiled view: bound queries + a pure sync JS transform `(input) => CardModel` + a refresh policy. " +
    "The pin dry-runs end to end and REFUSES on any failure (nothing persists) — fix and re-pin. " +
    "Pinning writes the view's grants (consent); unpinning revokes them. " +
    "CardModel sections: stats, keyValues, list, table, text, spark. Transform sees only JSON and Math, 1s budget.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stable token id (lowercase)" },
          title: { type: "string" },
          description: { type: "string" },
          owner: { type: "string", description: "Who pinned it (audit attribution)" },
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
        required: ["id", "title", "owner", "sensitivity", "queries", "transform", "refresh"],
      },
    },
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

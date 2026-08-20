// Compiled views: pinned artifacts authored in conversation — bound queries +
// a transform written once + a refresh policy. Serving is deterministic (no
// LLM in the path). These schemas are the contract; CardModel is bounded so
// cards stay card-sized.

import { z } from "zod";

import { parsePrefixedName } from "../registry.js";

const TOKEN = /^[a-z][a-z0-9_-]*$/;
const isoDate = z.iso.datetime({ offset: true });

export const ViewQuerySchema = z.object({
  key: z.string().regex(TOKEN).max(32),
  tool: z
    .string()
    .min(3)
    .max(128)
    .refine(
      (tool) => parsePrefixedName(tool) !== null,
      "tool must be a prefixed capability tool (<capability>__<tool>); gateway meta-tools cannot be queried",
    ),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const RefreshSchema = z.object({
  intervalMs: z.union([z.number().int().min(5_000).max(86_400_000), z.null()]),
});

export const SENSITIVITIES = ["private", "shareable"] as const;

// What pin_view accepts (the server stamps timestamps).
export const ViewSpecInputSchema = z.object({
  id: z.string().regex(TOKEN).max(64),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  owner: z.string().min(1).max(120),
  sensitivity: z.enum(SENSITIVITIES),
  queries: z
    .array(ViewQuerySchema)
    .min(1)
    .max(8)
    .refine(
      (queries) => new Set(queries.map((query) => query.key)).size === queries.length,
      "query keys must be unique",
    ),
  transform: z.string().min(1).max(32_768),
  refresh: RefreshSchema,
});

export const ViewSpecSchema = ViewSpecInputSchema.extend({
  createdAt: isoDate,
  updatedAt: isoDate,
});

// --- CardModel: bounded so cards stay card-sized ---
const label = z.string().min(1).max(80);
const cell = z.string().max(200);

export const CardSectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stats"),
    items: z
      .array(
        z.object({
          label,
          value: z.string().max(120),
          hint: z.string().max(120).optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.object({
    kind: z.literal("keyValues"),
    items: z.array(z.object({ key: label, value: z.string().max(300) })).min(1).max(24),
  }),
  z.object({
    kind: z.literal("list"),
    items: z.array(z.string().min(1).max(300)).min(1).max(50),
  }),
  z
    .object({
      kind: z.literal("table"),
      columns: z.array(label).min(1).max(8),
      rows: z.array(z.array(cell)).max(50),
    })
    .refine(
      (section) => section.rows.every((row) => row.length === section.columns.length),
      "each row must match columns length",
    ),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4_000) }),
  z.object({
    kind: z.literal("spark"),
    label: label.optional(),
    points: z.array(z.number().finite()).min(2).max(200),
  }),
]);

export const CardModelSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  updatedAt: isoDate.optional(),
  sections: z.array(CardSectionSchema).min(1).max(12),
});

/** Which producer (and version) each query's data came from. */
export const QueryProvenanceSchema = z.object({
  key: z.string(),
  capability: z.string(),
  version: z.union([z.string(), z.null()]),
  ts: isoDate,
});

export const ViewSnapshotSchema = z.object({
  viewId: z.string(),
  ok: z.boolean(),
  model: CardModelSchema.optional(),
  error: z
    .object({
      kind: z.enum(["query", "transform", "model"]),
      message: z.string(),
    })
    .optional(),
  queryErrors: z
    .record(z.string(), z.object({ code: z.string().optional(), message: z.string() }))
    .optional(),
  provenance: z.array(QueryProvenanceSchema).optional(),
  startedAt: isoDate,
  durationMs: z.number().int().nonnegative(),
});

export type ViewQuery = z.infer<typeof ViewQuerySchema>;
export type ViewSpecInput = z.infer<typeof ViewSpecInputSchema>;
export type ViewSpec = z.infer<typeof ViewSpecSchema>;
export type CardSection = z.infer<typeof CardSectionSchema>;
export type CardModel = z.infer<typeof CardModelSchema>;
export type QueryProvenance = z.infer<typeof QueryProvenanceSchema>;
export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;

export function viewUri(id: string): string {
  return `view://${id}`;
}

/** The grant-consumer identity a view runs as (rides the peer-call machinery). */
export function viewCapabilityId(id: string): string {
  return `view-${id}`;
}

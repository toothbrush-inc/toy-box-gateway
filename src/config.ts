import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const TOKEN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_ID = "gateway";

export const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP_FILES = 5;

/** Named tints for store tiles — each app gets its own colour block. */
export const STORE_ACCENTS = ["sky", "leaf", "marigold", "plum", "clay", "slate"] as const;
export type StoreAccent = (typeof STORE_ACCENTS)[number];

/** The words the public store page uses for one app. `label` is the only
 * required field; the rest is what makes a tile worth reading — the pitch,
 * the reasons it is valuable, and a badge such as "beta". */
const StoreCopyShape = {
  label: z.string().min(1).max(60),
  /** One line under the name: what it does for you. */
  tagline: z.string().min(1).max(120).optional(),
  /** A short paragraph on why it is valuable. */
  description: z.string().min(1).max(600).optional(),
  /** Up to four concrete reasons, one line each. */
  highlights: z.array(z.string().min(1).max(120)).max(4).optional(),
  /** A short status word shown on the tile ("beta", "new"). */
  badge: z.string().min(1).max(20).optional(),
  accent: z.enum(STORE_ACCENTS).optional(),
  /** The open-source repository, for readers who want to run it themselves. */
  repo: z.string().url().optional(),
} as const;

export const StoreCopySchema = z.object(StoreCopyShape);
export type StoreCopy = z.infer<typeof StoreCopySchema>;

/** Where "Open" goes: a path on this host, or, for an app on a sibling host
 * (cal.<domain>), a full https URL. */
const WEB_PATH = z
  .string()
  .regex(
    /^(\/[A-Za-z0-9/_-]*|https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>]*)?)$/u,
    "web.path must be an absolute path or an https URL",
  );

/** The `store` block of a capability.json: the app's own storefront words.
 * Parsed here from the raw manifest (not through @local/vault) so a gateway
 * built against an older vault still reads it. Same limits as the contract. */
export const ManifestStoreSchema = z.object({
  name: z.string().min(1).max(60),
  tagline: StoreCopyShape.tagline,
  description: StoreCopyShape.description,
  highlights: StoreCopyShape.highlights,
  badge: StoreCopyShape.badge,
  accent: StoreCopyShape.accent,
  web: z.object({ path: WEB_PATH }).optional(),
  repo: StoreCopyShape.repo,
});
export type ManifestStore = z.infer<typeof ManifestStoreSchema>;

export const CapabilitySpecSchema = z.object({
  id: z
    .string()
    .regex(TOKEN, "id must be a lowercase identifier")
    .refine((id) => !id.includes("__"), "id must not contain '__' (the tool prefix separator)")
    .refine((id) => id !== RESERVED_ID, `id '${RESERVED_ID}' is reserved for the gateway itself`),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  allowTools: z.array(z.string().min(1)).optional(),
  denyTools: z.array(z.string().min(1)).optional(),
  manifestPath: z.string().min(1).optional(),
  secretsAccess: z.enum(["broker"]).optional(),
  /** This deployment's overrides for the app's storefront words. The
   * defaults come from the manifest's `store` block (name, tagline, ...,
   * `web.path`); every field here wins over the manifest's, per field. A
   * capability with no `path` from either source is agent-only: no tile, but
   * its tools show on the store page once someone has signed in. */
  web: z
    .object({
      path: WEB_PATH.optional(),
      ...StoreCopySchema.partial().shape,
    })
    .optional(),
}).refine((spec) => spec.secretsAccess === undefined || spec.manifestPath !== undefined, {
  message: 'secretsAccess: "broker" requires manifestPath (the egress specs live in the manifest)',
});

export const GatewayConfigSchema = z.object({
  capabilities: z
    .array(CapabilitySpecSchema)
    .min(1)
    .refine(
      (caps) => new Set(caps.map((cap) => cap.id)).size === caps.length,
      "capability ids must be unique",
    ),
  audit: z
    .object({
      dir: z.string().min(1).optional(),
      maxBytes: z.number().int().positive().default(DEFAULT_AUDIT_MAX_BYTES),
      keepFiles: z.number().int().min(0).default(DEFAULT_AUDIT_KEEP_FILES),
    })
    .default({ maxBytes: DEFAULT_AUDIT_MAX_BYTES, keepFiles: DEFAULT_AUDIT_KEEP_FILES }),
  commons: z.object({ dir: z.string().min(1) }).optional(),
  dataDir: z.string().min(1).optional(),
  views: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().min(1).optional(),
      maxViews: z.number().int().positive().max(200).default(50),
      queryTimeoutMs: z.number().int().positive().default(30_000),
      transformTimeoutMs: z.number().int().positive().max(10_000).default(1_000),
      /** How long a preview_view render stays at its URL. */
      previewTtlMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
    })
    .default({
      enabled: true,
      maxViews: 50,
      queryTimeoutMs: 30_000,
      transformTimeoutMs: 1_000,
      previewTtlMs: 600_000,
    }),
  oauth: z
    .object({
      google: z
        .object({
          envFile: z.string().min(1),
          clientIdVar: z.string().min(1).default("GOOGLE_OAUTH_CLIENT_ID"),
          clientSecretVar: z.string().min(1).default("GOOGLE_OAUTH_CLIENT_SECRET"),
          /** Enables the session-gated consent flow at /auth/google/connect,
           * which stores refresh tokens in the vault under the requested slot
           * (tenant instances included) and grants every capability declaring
           * the matched role. Scopes are what the consent asks Google for —
           * set them to what the granted capabilities actually need. The
           * client above must have `<publicUrl>/auth/google/connect/callback`
           * registered as a redirect URI. */
          connect: z
            .object({
              scopes: z.array(z.string().min(1)).min(1),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  serve: z
    .object({
      port: z.number().int().nonnegative().default(8800),
      host: z.string().min(1).default("127.0.0.1"),
      publicUrl: z.string().url(),
      allowedHosts: z.array(z.string().min(1)).optional(),
      /** Share the browser session cookie with sibling hosts: set to the
       * public hostname and it is sent to every subdomain too, so a
       * `forward_auth` on cal.<host> sees the same sign-in. Off by default
       * (host-only cookie). Pair it with `allowedHosts` listing those hosts. */
      sessionCookieDomain: z.string().min(1).optional(),
      allowedOrigins: z
        .array(z.string().min(1))
        .default(["https://claude.ai", "https://claude.com"]),
      session: z
        .object({
          ttlMs: z.number().int().positive().default(8 * 3600_000),
          maxSessions: z.number().int().positive().default(20),
          keepAliveMs: z.number().int().default(15_000),
          maxEventsPerSession: z.number().int().positive().default(500),
        })
        .default({
          ttlMs: 8 * 3600_000,
          maxSessions: 20,
          keepAliveMs: 15_000,
          maxEventsPerSession: 500,
        }),
      auth: z.discriminatedUnion("stage", [
        z.object({
          stage: z.literal("static"),
          tokensEnv: z.string().min(1).default("GATEWAY_BEARER_TOKENS"),
        }),
        z.object({
          stage: z.literal("oauth"),
          oauth: z.object({
            google: z.object({
              clientIdVar: z.string().min(1).default("GATEWAY_GOOGLE_LOGIN_CLIENT_ID"),
              clientSecretVar: z.string().min(1).default("GATEWAY_GOOGLE_LOGIN_CLIENT_SECRET"),
            }),
            allowedEmails: z.array(z.string().email()).min(1),
            signingKeyFile: z.string().min(1),
            storeDir: z.string().min(1),
            accessTokenTtlSec: z.number().int().positive().default(3600),
            refreshTokenTtlSec: z.number().int().positive().default(30 * 86_400),
            scopesSupported: z.array(z.string().min(1)).default(["mcp"]),
          }),
        }),
      ]),
    })
    .optional(),
  /** Sibling web apps that are not mounted capabilities — they still belong
   * on the store page (MailFeed on mail.$GW_DOMAIN is the first of these). */
  links: z
    .array(
      z.object({
        href: z.string().url(),
        ...StoreCopyShape,
      }),
    )
    .default([]),
  /** The public store page: the words above the tiles and how to reach the
   * person behind it. Everything is optional; the page falls back to the
   * public URL's hostname and generic copy. */
  store: z
    .object({
      /** Wordmark. Defaults to the hostname of serve.publicUrl. */
      name: z.string().min(1).max(60).optional(),
      headline: z.string().min(1).max(160).optional(),
      lede: z.string().min(1).max(400).optional(),
      /** Where "suggest an app" and "say hello" go. Omit to hide the section. */
      contact: z
        .object({
          email: z.string().email(),
          /** Who the person is, in a few words ("Built by David"). */
          byline: z.string().min(1).max(120).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ServeConfig = NonNullable<z.infer<typeof GatewayConfigSchema>["serve"]>;
export type ViewsConfig = z.infer<typeof GatewayConfigSchema>["views"];
export type GatewayLink = z.infer<typeof GatewayConfigSchema>["links"][number];
export type StoreConfig = NonNullable<z.infer<typeof GatewayConfigSchema>["store"]>;

/** Parses "label:token,label2:token2" (or a bare token => label "default"). */
export function parseBearerTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  if (raw === undefined) {
    return tokens;
  }
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator > 0) {
      tokens.set(trimmed.slice(separator + 1).trim(), trimmed.slice(0, separator).trim());
    } else {
      tokens.set(trimmed, "default");
    }
  }
  return tokens;
}

/**
 * Best-effort read of the capability's package.json version at its cwd, for
 * provenance in status and audit. Self-reported locally; hosted deploys bind
 * capability@version to an image digest for real attestation.
 */
export function readCapabilityVersion(spec: CapabilitySpec): string | null {
  if (spec.cwd === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(resolve(spec.cwd, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : null;
  } catch {
    return null;
  }
}

export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema> & { configPath: string };

export function resolveConfigPath(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error("--config requires a path argument");
      }
      return resolve(cwd, value);
    }
    if (arg !== undefined && arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.trim() === "") {
        throw new Error("--config requires a path argument");
      }
      return resolve(cwd, value);
    }
  }
  const fromEnv = env["GATEWAY_CONFIG"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolve(cwd, fromEnv);
  }
  const fallback = resolve(cwd, "gateway.config.json");
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(
    "No gateway config found. Pass --config <path>, set GATEWAY_CONFIG, " +
      "or create gateway.config.json in the working directory " +
      "(see gateway.config.example.json).",
  );
}

export function loadGatewayConfig(path: string): GatewayConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read gateway config at ${path}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gateway config at ${path} is not valid JSON`);
  }
  const result = GatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Gateway config at ${path} is invalid: ${issues}`);
  }
  return { ...result.data, configPath: path };
}

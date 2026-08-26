import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const TOKEN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_ID = "gateway";

export const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP_FILES = 5;

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
  /** Where this capability's own web UI lives, when it has one. The gateway
   * cannot infer this: a dashboard is a separate service, not the MCP child
   * mounted here. Capabilities without it still appear on the index — as
   * agent-only, with their tools. */
  web: z
    .object({
      path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u, "web.path must be an absolute path"),
      label: z.string().min(1).max(60),
      description: z.string().min(1).max(200).optional(),
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
   * on the home index (MailFeed on mail.$GW_DOMAIN is the first of these). */
  links: z
    .array(
      z.object({
        href: z.string().url(),
        label: z.string().min(1).max(60),
        description: z.string().min(1).max(200).optional(),
      }),
    )
    .default([]),
});

export type ServeConfig = NonNullable<z.infer<typeof GatewayConfigSchema>["serve"]>;
export type ViewsConfig = z.infer<typeof GatewayConfigSchema>["views"];
export type GatewayLink = z.infer<typeof GatewayConfigSchema>["links"][number];

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

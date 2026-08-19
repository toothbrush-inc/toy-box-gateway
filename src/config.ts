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
});

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

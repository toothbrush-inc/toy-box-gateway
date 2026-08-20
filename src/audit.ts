import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { DEFAULT_AUDIT_KEEP_FILES, DEFAULT_AUDIT_MAX_BYTES } from "./config.js";

export type AuditOutcome = "ok" | "error" | "denied";

/**
 * One line per tool call or egress request. Tool arguments, result contents,
 * and full URLs never appear here — the writer accepts only this shape,
 * `host` is a bare hostname, and `error` carries only gateway/transport-
 * originated messages after redaction.
 */
export interface AuditEntry {
  ts: string;
  capability: string;
  tool: string;
  outcome: AuditOutcome;
  duration_ms: number;
  denied_by?: "policy" | "egress";
  error_code?: string;
  error?: string;
  host?: string;
  session_id?: string;
  client_id?: string;
  user?: string;
  /** Profile field names or commons keys — NAMES only, never values. */
  fields?: string[];
  /** `capability`'s package.json version as read at mount (self-reported). */
  capability_version?: string;
  /** Peer-call rows (tool `call:<producer>__<tool>`): the producer and its version. */
  target?: string;
  target_version?: string;
}

export interface AuditWriterOptions {
  dir: string;
  maxBytes?: number;
  keepFiles?: number;
}

const AUDIT_FILE = "audit.jsonl";

export class AuditWriter {
  readonly path: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly keepFiles: number;

  constructor(options: AuditWriterOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
    this.keepFiles = options.keepFiles ?? DEFAULT_AUDIT_KEEP_FILES;
    this.path = join(this.dir, AUDIT_FILE);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  record(entry: AuditEntry): void {
    this.rotateIfNeeded();
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 14);
    let target = join(this.dir, `audit-${stamp}.jsonl`);
    let counter = 1;
    while (existsSync(target)) {
      target = join(this.dir, `audit-${stamp}-${String(counter)}.jsonl`);
      counter += 1;
    }
    renameSync(this.path, target);
    this.prune();
  }

  private prune(): void {
    const rotated = readdirSync(this.dir)
      .filter((name) => name.startsWith("audit-") && name.endsWith(".jsonl"))
      .sort();
    const excess = rotated.length - this.keepFiles;
    for (let index = 0; index < excess; index += 1) {
      const name = rotated[index];
      if (name !== undefined) {
        unlinkSync(join(this.dir, name));
      }
    }
  }
}

// Session registry for the HTTP endpoint: binds each MCP session to the
// auth identity that initialized it, sweeps idle sessions, and caps the total.

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { GatewaySession } from "../gateway.js";

export interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  session: GatewaySession;
  authKey: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionManagerOptions {
  ttlMs: number;
  maxSessions: number;
  log: (line: string) => void;
  now?: () => number;
}

const SWEEP_INTERVAL_MS = 60_000;
const EVICTION_IDLE_MS = 60_000;

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: SessionManagerOptions) {
    this.sweeper = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  get size(): number {
    return this.records.size;
  }

  get(id: string, authKey: string): SessionRecord | "forbidden" | undefined {
    const record = this.records.get(id);
    if (record === undefined) {
      return undefined;
    }
    if (record.authKey !== authKey) {
      return "forbidden";
    }
    record.lastSeenAt = this.now();
    return record;
  }

  register(id: string, record: Omit<SessionRecord, "createdAt" | "lastSeenAt">): void {
    const timestamp = this.now();
    this.records.set(id, { ...record, createdAt: timestamp, lastSeenAt: timestamp });
  }

  /** True when a new session may be created; evicts one idle LRU session at the cap. */
  canCreate(): boolean {
    if (this.records.size < this.options.maxSessions) {
      return true;
    }
    const idleCutoff = this.now() - EVICTION_IDLE_MS;
    let oldest: { id: string; lastSeenAt: number } | null = null;
    for (const [id, record] of this.records) {
      if (record.lastSeenAt <= idleCutoff && (oldest === null || record.lastSeenAt < oldest.lastSeenAt)) {
        oldest = { id, lastSeenAt: record.lastSeenAt };
      }
    }
    if (oldest === null) {
      return false;
    }
    this.options.log(`[gateway] evicting idle session ${oldest.id}`);
    void this.remove(oldest.id);
    return true;
  }

  async remove(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) {
      return;
    }
    this.records.delete(id);
    await record.session.close().catch(() => undefined);
    await record.transport.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const id of [...this.records.keys()]) {
      await this.remove(id);
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.options.ttlMs;
    for (const [id, record] of [...this.records]) {
      if (record.lastSeenAt < cutoff) {
        this.options.log(`[gateway] closing expired session ${id}`);
        void this.remove(id);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

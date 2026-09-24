// Who may sign in, and who is waiting to. `allowedEmails` in the config is
// the seed: the operator's own accounts, always in. On top of it sit two
// files in the OAuth store dir, both keyed by lower-cased email:
//
//   invited.json   people let in after the config was written
//   waitlist.json  people who signed in, were not invited, and asked to be
//
// Both are re-read whenever they change on disk, so `capability-gateway
// waitlist invite` from another process takes effect on the person's next
// request — no restart, and no edit to the config. A dropped invitation
// bites the same way: every session check and token refresh asks here.
//
// Two processes may write the same file (the gateway recording a join, the
// CLI inviting). Each write is a fresh read-modify-write through an atomic
// rename, so the worst case is one lost join within the same millisecond,
// and the person can press the button again.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WaitlistEntry {
  email: string;
  requestedAt: string;
}

export interface InvitedEntry {
  email: string;
  invitedAt: string;
}

interface FileCache<T> {
  name: string;
  mtimeMs: number | undefined;
  rows: Map<string, T>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AccessStore {
  private readonly seed: ReadonlySet<string>;
  private readonly invited: FileCache<{ invitedAt: string }> = {
    name: "invited.json",
    mtimeMs: undefined,
    rows: new Map(),
  };
  private readonly waitlist: FileCache<{ requestedAt: string }> = {
    name: "waitlist.json",
    mtimeMs: undefined,
    rows: new Map(),
  };

  constructor(
    private readonly dir: string,
    seed: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.seed = new Set(seed.map(normalizeEmail));
  }

  /** The seed list or an invitation. Re-reads the invitations when the file changed. */
  isAllowed(email: string): boolean {
    const key = normalizeEmail(email);
    if (this.seed.has(key)) {
      return true;
    }
    this.refresh(this.invited);
    return this.invited.rows.has(key);
  }

  isSeed(email: string): boolean {
    return this.seed.has(normalizeEmail(email));
  }

  /** Records the request, or returns the one already there: asking twice
   * keeps the original place. */
  join(email: string): WaitlistEntry {
    const key = normalizeEmail(email);
    this.refresh(this.waitlist);
    const existing = this.waitlist.rows.get(key);
    if (existing !== undefined) {
      return { email: key, ...existing };
    }
    const row = { requestedAt: this.now().toISOString() };
    this.waitlist.rows.set(key, row);
    this.persist(this.waitlist);
    return { email: key, ...row };
  }

  waitlistEntry(email: string): WaitlistEntry | undefined {
    this.refresh(this.waitlist);
    const row = this.waitlist.rows.get(normalizeEmail(email));
    return row === undefined ? undefined : { email: normalizeEmail(email), ...row };
  }

  /** Oldest request first: the order people asked in. */
  listWaitlist(): WaitlistEntry[] {
    this.refresh(this.waitlist);
    return [...this.waitlist.rows]
      .map(([email, row]) => ({ email, ...row }))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.email.localeCompare(b.email));
  }

  removeFromWaitlist(email: string): boolean {
    this.refresh(this.waitlist);
    const removed = this.waitlist.rows.delete(normalizeEmail(email));
    if (removed) {
      this.persist(this.waitlist);
    }
    return removed;
  }

  /**
   * Lets a person in, and takes them off the waiting list if they were on
   * it. `already` when nothing changed: a seed address, or one invited
   * before.
   */
  invite(email: string): { status: "invited" | "already"; fromWaitlist: boolean } {
    const key = normalizeEmail(email);
    if (this.seed.has(key)) {
      return { status: "already", fromWaitlist: false };
    }
    this.refresh(this.invited);
    const fromWaitlist = this.removeFromWaitlist(key);
    if (this.invited.rows.has(key)) {
      return { status: "already", fromWaitlist };
    }
    this.invited.rows.set(key, { invitedAt: this.now().toISOString() });
    this.persist(this.invited);
    return { status: "invited", fromWaitlist };
  }

  /** Withdraws an invitation. A seed address cannot be withdrawn here: it
   * lives in the config, and this must not look like it worked. */
  uninvite(email: string): "removed" | "absent" | "seed" {
    const key = normalizeEmail(email);
    if (this.seed.has(key)) {
      return "seed";
    }
    this.refresh(this.invited);
    if (!this.invited.rows.delete(key)) {
      return "absent";
    }
    this.persist(this.invited);
    return "removed";
  }

  listInvited(): InvitedEntry[] {
    this.refresh(this.invited);
    return [...this.invited.rows]
      .map(([email, row]) => ({ email, ...row }))
      .sort((a, b) => a.invitedAt.localeCompare(b.invitedAt) || a.email.localeCompare(b.email));
  }

  /** Re-reads a file when its mtime moved (or it appeared, or went away). */
  private refresh<T>(cache: FileCache<T>): void {
    const path = join(this.dir, cache.name);
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    if (mtimeMs === cache.mtimeMs && (mtimeMs !== undefined || cache.rows.size === 0)) {
      return;
    }
    cache.mtimeMs = mtimeMs;
    cache.rows = new Map();
    if (mtimeMs === undefined) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [email, row] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof row === "object" && row !== null) {
            cache.rows.set(normalizeEmail(email), row as T);
          }
        }
      }
    } catch {
      // Malformed: treated as empty until the next write replaces it.
    }
  }

  private persist<T>(cache: FileCache<T>): void {
    const path = join(this.dir, cache.name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache.rows), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, path);
    try {
      cache.mtimeMs = statSync(path).mtimeMs;
    } catch {
      cache.mtimeMs = undefined;
    }
  }
}

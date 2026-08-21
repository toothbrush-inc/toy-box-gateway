// Disk persistence for the OAuth AS: registered DCR clients and rotating
// refresh-token families. Authorization codes and pending Google logins are
// deliberately in-memory (10-minute artifacts; a restart just fails the
// handshake in progress). Atomic writes, dirs 0700, files 0600.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface RefreshRecord {
  /** Family id: every rotation stays in the family; reuse kills the family. */
  family: string;
  clientId: string;
  email: string;
  scopes: string[];
  expiresAt: number;
  /** Set when rotated: presenting this token again is reuse (theft signal). */
  rotatedTo?: string;
  revoked?: boolean;
}

export class OAuthDiskStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private refresh = new Map<string, RefreshRecord>();

  constructor(private readonly dir: string) {
    this.clients = new Map(Object.entries(this.load("clients.json")));
    this.refresh = new Map(Object.entries(this.load("refresh.json")));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  putClient(client: OAuthClientInformationFull): void {
    this.clients.set(client.client_id, client);
    this.persist("clients.json", this.clients);
  }

  getRefresh(token: string): RefreshRecord | undefined {
    return this.refresh.get(token);
  }

  putRefresh(token: string, record: RefreshRecord): void {
    this.refresh.set(token, record);
    this.prune();
    this.persist("refresh.json", this.refresh);
  }

  /** Marks every token in the family revoked (rotation-reuse or explicit revoke). */
  revokeFamily(family: string): number {
    let count = 0;
    for (const record of this.refresh.values()) {
      if (record.family === family && record.revoked !== true) {
        record.revoked = true;
        count += 1;
      }
    }
    if (count > 0) {
      this.persist("refresh.json", this.refresh);
    }
    return count;
  }

  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [token, record] of this.refresh) {
      if (record.expiresAt <= now) {
        this.refresh.delete(token);
      }
    }
  }

  private load(name: string): Record<string, never> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, never>;
      }
    } catch {
      // absent or malformed => start empty
    }
    return {};
  }

  private persist(name: string, map: Map<string, unknown>): void {
    const path = join(this.dir, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, path);
  }
}

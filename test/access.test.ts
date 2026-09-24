import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccessStore } from "../src/http/oauth/access.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-access-"));
  dirs.push(dir);
  return dir;
}

function ticking(start = Date.parse("2026-09-24T10:00:00.000Z")): () => Date {
  let now = start;
  return () => new Date((now += 1000));
}

describe("AccessStore", () => {
  it("always allows the seed, never lists it, and refuses to uninvite it", () => {
    const store = new AccessStore(tempDir(), ["Owner@Example.com"]);
    expect(store.isAllowed("owner@example.com")).toBe(true);
    expect(store.isAllowed("OWNER@example.com")).toBe(true);
    expect(store.isAllowed("guest@example.com")).toBe(false);
    expect(store.invite("owner@example.com")).toEqual({ status: "already", fromWaitlist: false });
    expect(store.uninvite("owner@example.com")).toBe("seed");
    expect(store.listInvited()).toEqual([]);
  });

  it("keeps a first-come waiting list and turns a request into an invitation", () => {
    const store = new AccessStore(tempDir(), ["owner@example.com"], ticking());
    const first = store.join("Ana@Example.com");
    store.join("bo@example.com");
    expect(store.join("ana@example.com")).toEqual(first);
    expect(store.listWaitlist().map((entry) => entry.email)).toEqual(["ana@example.com", "bo@example.com"]);
    expect(store.waitlistEntry("ana@example.com")).toEqual(first);
    expect(store.isAllowed("ana@example.com")).toBe(false);

    expect(store.invite("ana@example.com")).toEqual({ status: "invited", fromWaitlist: true });
    expect(store.invite("ana@example.com")).toEqual({ status: "already", fromWaitlist: false });
    expect(store.isAllowed("ana@example.com")).toBe(true);
    expect(store.listWaitlist().map((entry) => entry.email)).toEqual(["bo@example.com"]);
    expect(store.listInvited().map((entry) => entry.email)).toEqual(["ana@example.com"]);

    expect(store.uninvite("ana@example.com")).toBe("removed");
    expect(store.uninvite("ana@example.com")).toBe("absent");
    expect(store.isAllowed("ana@example.com")).toBe(false);
    expect(store.removeFromWaitlist("bo@example.com")).toBe(true);
    expect(store.removeFromWaitlist("bo@example.com")).toBe(false);
  });

  it("sees what another process wrote, without a restart", () => {
    const dir = tempDir();
    const gateway = new AccessStore(dir, ["owner@example.com"]);
    expect(gateway.isAllowed("ana@example.com")).toBe(false);

    // The CLI in another process: same directory, its own instance.
    const cli = new AccessStore(dir, ["owner@example.com"]);
    cli.invite("ana@example.com");
    expect(gateway.isAllowed("ana@example.com")).toBe(true);

    gateway.join("bo@example.com");
    expect(cli.listWaitlist().map((entry) => entry.email)).toEqual(["bo@example.com"]);

    cli.uninvite("ana@example.com");
    expect(gateway.isAllowed("ana@example.com")).toBe(false);

    // A hand-deleted file reads as empty, not as the last thing seen.
    rmSync(join(dir, "waitlist.json"));
    expect(cli.listWaitlist()).toEqual([]);
  });

  it("writes private files atomically and survives a malformed one", () => {
    const dir = tempDir();
    const store = new AccessStore(dir, []);
    store.invite("ana@example.com");
    const path = join(dir, "invited.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object)).toEqual(["ana@example.com"]);

    writeFileSync(path, "{not json");
    expect(store.isAllowed("ana@example.com")).toBe(false);
    expect(store.invite("bo@example.com").status).toBe("invited");
    expect(store.listInvited().map((entry) => entry.email)).toEqual(["bo@example.com"]);
  });
});

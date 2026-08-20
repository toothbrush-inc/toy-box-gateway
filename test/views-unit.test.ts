import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditWriter } from "../src/audit.js";
import { executeView } from "../src/views/executor.js";
import {
  CardModelSchema,
  ViewSpecInputSchema,
  ViewSpecSchema,
  type ViewSpec,
} from "../src/views/model.js";
import { renderCardHtml, renderCardJson } from "../src/views/render.js";
import { runTransform, TransformError } from "../src/views/sandbox.js";
import { ViewStore } from "../src/views/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "views-"));
  dirs.push(dir);
  return dir;
}

const GOOD_INPUT = {
  id: "morning",
  title: "Morning",
  owner: "dvd",
  sensitivity: "shareable",
  queries: [{ key: "w", tool: "weather__echo", arguments: { text: "hi" } }],
  transform: "(input) => input",
  refresh: { intervalMs: 60_000 },
};

describe("view model schemas", () => {
  it("accepts a valid spec and rejects bad ones", () => {
    expect(ViewSpecInputSchema.safeParse(GOOD_INPUT).success).toBe(true);
    // meta tools (no __ prefix) can never be queried — the recursion guard
    expect(
      ViewSpecInputSchema.safeParse({
        ...GOOD_INPUT,
        queries: [{ key: "x", tool: "gateway_status" }],
      }).success,
    ).toBe(false);
    expect(
      ViewSpecInputSchema.safeParse({
        ...GOOD_INPUT,
        queries: [
          { key: "a", tool: "weather__echo" },
          { key: "a", tool: "weather__echo" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ViewSpecInputSchema.safeParse({ ...GOOD_INPUT, refresh: { intervalMs: 1000 } }).success,
    ).toBe(false);
  });

  it("bounds the CardModel", () => {
    const stats = { kind: "stats", items: [{ label: "L", value: "V" }] };
    expect(CardModelSchema.safeParse({ title: "T", sections: [stats] }).success).toBe(true);
    expect(
      CardModelSchema.safeParse({ title: "T", sections: Array.from({ length: 13 }, () => stats) })
        .success,
    ).toBe(false);
    expect(
      CardModelSchema.safeParse({
        title: "T",
        sections: [{ kind: "table", columns: ["a", "b"], rows: [["only-one"]] }],
      }).success,
    ).toBe(false);
  });
});

describe("transform sandbox", () => {
  it("runs pure transforms with isolation, kills runaways, types failures", () => {
    const input = { n: { value: 1 } };
    expect(runTransform("(input) => ({ doubled: input.n.value * 2 })", input, 500)).toEqual({
      doubled: 2,
    });
    // caller's input object is never mutated (structuredClone in)
    runTransform("(input) => { input.n.value = 99; return {}; }", input, 500);
    expect(input.n.value).toBe(1);

    expect(() => runTransform("not valid js((", {}, 500)).toThrow(TransformError);
    try {
      runTransform("(input) => { while (true) {} }", {}, 100);
      expect.unreachable();
    } catch (error) {
      expect((error as TransformError).kind).toBe("timeout");
    }
    try {
      runTransform("(input) => { throw new Error('boom'); }", {}, 500);
      expect.unreachable();
    } catch (error) {
      expect((error as TransformError).kind).toBe("runtime");
    }
    // no process/require in scope
    try {
      runTransform("(input) => process.env", {}, 500);
      expect.unreachable();
    } catch (error) {
      expect((error as TransformError).kind).toBe("runtime");
    }
    // async transforms are rejected (a Promise cannot structuredClone)
    try {
      runTransform("async (input) => ({})", {}, 500);
      expect.unreachable();
    } catch (error) {
      expect((error as TransformError).kind).toBe("result");
    }
  });
});

function fullSpec(overrides: Partial<ViewSpec> = {}): ViewSpec {
  return ViewSpecSchema.parse({
    ...GOOD_INPUT,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  });
}

describe("view store", () => {
  it("round-trips specs and snapshots, survives corruption, deletes cleanly", () => {
    const dir = tempDir();
    const store = new ViewStore(dir);
    const spec = fullSpec();
    store.put(spec);
    store.putSnapshot({
      viewId: "morning",
      ok: true,
      model: { title: "T", sections: [{ kind: "text", text: "hello" }] },
      startedAt: "2026-08-20T10:00:00.000Z",
      durationMs: 5,
    });

    const reloaded = new ViewStore(dir);
    expect(reloaded.get("morning")?.title).toBe("Morning");
    expect(reloaded.getSnapshot("morning")?.ok).toBe(true);

    expect(reloaded.delete("morning")).toBe(true);
    expect(new ViewStore(dir).list()).toEqual([]);
    expect(new ViewStore(dir).getSnapshot("morning")).toBeUndefined();

    writeFileSync(join(dir, "views.json"), "{corrupt", "utf8");
    expect(new ViewStore(dir).list()).toEqual([]);
  });
});

describe("renderers", () => {
  it("renders deterministic, escaped HTML and JSON, including error cards", () => {
    const spec = fullSpec({ title: "A <b>sneaky</b> title" });
    const ok = {
      viewId: "morning",
      ok: true,
      model: {
        title: "Card <script>alert(1)</script>",
        sections: [
          { kind: "stats" as const, items: [{ label: "Runs", value: "3" }] },
          { kind: "spark" as const, points: [1, 5, 2] },
        ],
      },
      provenance: [
        { key: "w", capability: "fitness", version: "0.2.0", ts: "2026-08-20T10:00:00.000Z" },
      ],
      startedAt: "2026-08-20T10:00:00.000Z",
      durationMs: 7,
    };
    const html = renderCardHtml(spec, ok);
    expect(html).toBe(renderCardHtml(spec, ok));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("fitness@0.2.0");
    expect(html).toContain("<polyline");

    const failed = {
      viewId: "morning",
      ok: false,
      error: { kind: "transform" as const, message: "boom" },
      startedAt: "2026-08-20T10:00:00.000Z",
      durationMs: 2,
    };
    const errorHtml = renderCardHtml(spec, failed);
    expect(errorHtml).toContain("view failed (transform)");
    expect(errorHtml).toContain("sneaky");

    const json = renderCardJson(spec, ok);
    expect(json["ok"]).toBe(true);
    expect((json["view"] as { id: string }).id).toBe("morning");
  });
});

describe("executor", () => {
  function auditTo(dir: string): AuditWriter {
    return new AuditWriter({ dir: join(dir, "audit") });
  }

  it("keys inputs, stamps provenance, and audits like /call rows", async () => {
    const dir = tempDir();
    const audit = auditTo(dir);
    const callPeer = vi.fn(async () => ({
      structuredContent: { ok: true, data: { echoed: "hi" } },
    }));
    const snapshot = await executeView(
      fullSpec({
        transform:
          "(input) => ({ title: 'T', sections: [{ kind: 'text', text: input.w.data.echoed }] })",
      }),
      { checkGrant: () => true, callPeer, versionOf: () => "0.0.1", audit },
      { queryTimeoutMs: 5_000, transformTimeoutMs: 500 },
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.model?.sections[0]).toEqual({ kind: "text", text: "hi" });
    expect(snapshot.provenance).toEqual([
      expect.objectContaining({ key: "w", capability: "weather", version: "0.0.1" }),
    ]);
    expect(callPeer).toHaveBeenCalledWith("weather", "echo", { text: "hi" }, { timeoutMs: 5_000 });
    const rows = readFileSync(audit.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows[0]).toMatchObject({
      capability: "view-morning",
      tool: "call:weather__echo",
      outcome: "ok",
      user: "dvd",
      target: "weather",
      target_version: "0.0.1",
    });
    expect(readFileSync(audit.path, "utf8")).not.toContain('"hi"');
  });

  it("fails typed on grant denial, producer errors, and bad transforms", async () => {
    const dir = tempDir();
    const audit = auditTo(dir);
    const denied = await executeView(
      fullSpec(),
      {
        checkGrant: () => false,
        callPeer: vi.fn(),
        versionOf: () => null,
        audit,
      },
      { queryTimeoutMs: 5_000, transformTimeoutMs: 500 },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.kind).toBe("query");
    expect(denied.queryErrors?.["w"]?.code).toBe("grant_missing");

    const producerError = await executeView(
      fullSpec(),
      {
        checkGrant: () => true,
        callPeer: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ ok: false, error: { code: "nope", message: "x" } }) },
          ],
          isError: true,
        }),
        versionOf: () => null,
        audit,
      },
      { queryTimeoutMs: 5_000, transformTimeoutMs: 500 },
    );
    expect(producerError.queryErrors?.["w"]?.code).toBe("nope");

    const badModel = await executeView(
      fullSpec({ transform: "(input) => ({ nonsense: true })" }),
      {
        checkGrant: () => true,
        callPeer: async () => ({ structuredContent: { ok: true, data: {} } }),
        versionOf: () => null,
        audit,
      },
      { queryTimeoutMs: 5_000, transformTimeoutMs: 500 },
    );
    expect(badModel.ok).toBe(false);
    expect(badModel.error?.kind).toBe("model");
  });
});

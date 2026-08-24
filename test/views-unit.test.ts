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
import { PreviewStore } from "../src/views/previews.js";
import {
  renderCardHtml,
  renderCardJson,
  renderNoticeHtml,
  renderPreviewHtml,
  renderPreviewJson,
} from "../src/views/render.js";
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
    // the meaning words: delta/tone on stats, toned list items, column specs,
    // bars and progress — bounded like everything else
    expect(
      CardModelSchema.safeParse({
        title: "T",
        sections: [
          { kind: "stats", title: "S", items: [{ label: "L", value: "V", delta: "+1", tone: "good" }] },
          { kind: "list", items: ["a", { text: "b", tone: "warn" }] },
          { kind: "table", columns: [{ label: "n", align: "right" }], rows: [["1"]] },
          { kind: "bars", unit: "km", items: [{ label: "Mon", value: 1 }, { label: "Tue", value: 0 }] },
          { kind: "progress", items: [{ label: "Goal", value: 4, max: 5, tone: "good" }] },
        ],
      }).success,
    ).toBe(true);
    expect(
      CardModelSchema.safeParse({ title: "T", sections: [{ kind: "stats", items: [{ label: "L", value: "V", tone: "great" }] }] })
        .success,
    ).toBe(false);
    expect(
      CardModelSchema.safeParse({ title: "T", sections: [{ kind: "bars", items: [{ label: "only", value: 1 }] }] }).success,
    ).toBe(false);
    expect(
      CardModelSchema.safeParse({ title: "T", sections: [{ kind: "progress", items: [{ label: "G", value: 1, max: 0 }] }] })
        .success,
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
    expect(html).not.toContain("<script");

    // every vocabulary word renders, and meaning drives markup not color alone
    const rich = renderCardHtml(spec, {
      ...ok,
      model: {
        title: "Rich",
        sections: [
          { kind: "stats", items: [{ label: "Pace", value: "5:19", delta: "-4s", tone: "good" }] },
          { kind: "list", items: [{ text: "Gusty", tone: "warn" }] },
          { kind: "table", columns: ["Day", "km"], rows: [["Mon", "9.8"], ["Tue", "6"]] },
          { kind: "bars", items: [{ label: "A", value: 2 }, { label: "B", value: 5 }] },
          { kind: "progress", items: [{ label: "Goal", value: 4, max: 5, display: "4 of 5" }] },
        ],
      },
    });
    expect(rich).toContain("▼ 4s");
    expect(rich).toContain('class="d d--good"');
    expect(rich).toContain('class="t-warn"');
    expect(rich).toContain('<th class="num">km</th>'); // detected numeric column
    expect(rich).toContain('style="height:78.0%"'); // the peak bar
    expect(rich).toContain('style="width:80.0%"');
    expect(rich).toContain("4 of 5");

    const failed = {
      viewId: "morning",
      ok: false,
      error: { kind: "transform" as const, message: "boom" },
      startedAt: "2026-08-20T10:00:00.000Z",
      durationMs: 2,
    };
    const errorHtml = renderCardHtml(spec, failed);
    expect(errorHtml).toContain("view failed:");
    expect(errorHtml).toContain('class="chip chip--bad">transform</span>');
    expect(errorHtml).toContain("card--error");
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
    expect(callPeer).toHaveBeenCalledWith("weather", "echo", { text: "hi" }, { timeoutMs: 5_000, user: "dvd" });
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

describe("previews", () => {
  const spec: ViewSpec = ViewSpecSchema.parse({
    id: "draft",
    title: "Draft card",
    owner: "dvd",
    sensitivity: "private",
    queries: [{ key: "a", tool: "weather__echo", arguments: {} }],
    transform: "(input) => input",
    refresh: { intervalMs: 60_000 },
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
  });
  const snapshot = {
    viewId: "draft",
    ok: true,
    model: { title: "Draft", sections: [{ kind: "text" as const, text: "hello <there>" }] },
    startedAt: "2026-08-21T10:00:01.000Z",
    durationMs: 12,
  };

  it("holds previews at unguessable tokens until they expire, evicting the oldest past the cap", () => {
    let now = Date.parse("2026-08-21T10:00:00.000Z");
    const store = new PreviewStore({ ttlMs: 1_000, max: 2, now: () => now });
    const first = store.put(spec, snapshot);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.expiresAt).toBe("2026-08-21T10:00:01.000Z");
    expect(store.get(first.token)?.spec.id).toBe("draft");
    expect(store.get("nope")).toBeUndefined();

    const second = store.put(spec, snapshot);
    expect(second.token).not.toBe(first.token);
    const third = store.put(spec, snapshot);
    expect(store.get(first.token)).toBeUndefined(); // evicted: cap is 2
    expect(store.get(second.token)).toBeDefined();
    expect(store.size).toBe(2);

    now += 1_000; // at the boundary previews are gone
    expect(store.get(third.token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("renders the preview page as the same card in a dashed frame with a notice", () => {
    const preview = {
      token: "tok_preview",
      spec,
      snapshot,
      createdAt: "2026-08-21T10:00:01.000Z",
      expiresAt: "2026-08-21T10:10:01.000Z",
    };
    const html = renderPreviewHtml(preview);
    expect(html).toBe(renderPreviewHtml(preview));
    expect(html).toContain('class="card card--preview"');
    expect(html).toContain("<strong>Preview</strong> — not pinned");
    expect(html).toContain("Expires Aug 21, 10:10 UTC");
    expect(html).toContain("preview · draft");
    expect(html).toContain("hello &lt;there&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tok_preview"); // the token stays in the URL, not the page

    const json = renderPreviewJson(preview);
    expect(json["preview"]).toEqual({
      token: "tok_preview",
      createdAt: "2026-08-21T10:00:01.000Z",
      expiresAt: "2026-08-21T10:10:01.000Z",
    });
    expect((json["model"] as { title: string }).title).toBe("Draft");

    const notice = renderNoticeHtml("Preview expired", "Gone <now>.");
    expect(notice).toContain("<h1>Preview expired</h1>");
    expect(notice).toContain("Gone &lt;now&gt;.");
  });
});

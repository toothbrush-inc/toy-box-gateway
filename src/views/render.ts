// Deterministic renderers: same spec + snapshot => byte-identical output.
// The HTML card is fully self-contained — one inline style block, no scripts,
// no external assets. Error snapshots render an error card, never a 500.

import type { CardSection, ViewSnapshot, ViewSpec } from "./model.js";

export function renderCardJson(spec: ViewSpec, snapshot: ViewSnapshot): Record<string, unknown> {
  return {
    view: {
      id: spec.id,
      title: spec.title,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      sensitivity: spec.sensitivity,
      refresh: spec.refresh,
      updatedAt: spec.updatedAt,
    },
    ok: snapshot.ok,
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.queryErrors === undefined ? {} : { queryErrors: snapshot.queryErrors }),
    ...(snapshot.provenance === undefined ? {} : { provenance: snapshot.provenance }),
    renderedFrom: { startedAt: snapshot.startedAt, durationMs: snapshot.durationMs },
  };
}

const STYLE = [
  "body{margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b}",
  ".card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}",
  "h1{font-size:18px;margin:0 0 2px}",
  ".sub{color:#71717a;font-size:13px;margin:0 0 14px}",
  ".sec{margin:14px 0}",
  ".stats{display:flex;flex-wrap:wrap;gap:16px}",
  ".stat .v{font-size:22px;font-weight:600}",
  ".stat .l{font-size:12px;color:#71717a}",
  ".stat .h{font-size:11px;color:#a1a1aa}",
  "table{border-collapse:collapse;width:100%;font-size:13px}",
  "th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #f0f0f1}",
  "th{color:#71717a;font-weight:500}",
  "ul{margin:0;padding-left:20px;font-size:14px}",
  ".kv{font-size:14px}.kv b{font-weight:600}",
  ".txt{font-size:14px;white-space:pre-wrap}",
  ".err{color:#b91c1c;font-size:14px}",
  ".meta{color:#a1a1aa;font-size:11px;margin-top:16px}",
].join("");

export function renderCardHtml(spec: ViewSpec, snapshot: ViewSnapshot): string {
  const model = snapshot.model;
  const body =
    snapshot.ok && model !== undefined
      ? [
          `<h1>${esc(model.title)}</h1>`,
          model.subtitle === undefined ? "" : `<p class="sub">${esc(model.subtitle)}</p>`,
          ...model.sections.map((section) => renderSection(section)),
        ].join("")
      : [
          `<h1>${esc(spec.title)}</h1>`,
          `<p class="err">view failed (${esc(snapshot.error?.kind ?? "unknown")}): ${esc(snapshot.error?.message ?? "no details")}</p>`,
        ].join("");
  const provenance = (snapshot.provenance ?? [])
    .map((entry) => `${entry.capability}${entry.version === null ? "" : `@${entry.version}`}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(", ");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(spec.title)}</title><style>${STYLE}</style></head><body>`,
    `<div class="card">${body}`,
    `<p class="meta">rendered ${esc(snapshot.startedAt)} in ${String(snapshot.durationMs)}ms${provenance === "" ? "" : ` · from ${esc(provenance)}`}</p>`,
    "</div></body></html>",
  ].join("");
}

function renderSection(section: CardSection): string {
  switch (section.kind) {
    case "stats":
      return `<div class="sec stats">${section.items
        .map(
          (item) =>
            `<div class="stat"><div class="v">${esc(item.value)}</div><div class="l">${esc(item.label)}</div>${item.hint === undefined ? "" : `<div class="h">${esc(item.hint)}</div>`}</div>`,
        )
        .join("")}</div>`;
    case "keyValues":
      return `<div class="sec kv">${section.items
        .map((item) => `<div><b>${esc(item.key)}</b>: ${esc(item.value)}</div>`)
        .join("")}</div>`;
    case "list":
      return `<ul class="sec">${section.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
    case "table":
      return `<table class="sec"><thead><tr>${section.columns
        .map((column) => `<th>${esc(column)}</th>`)
        .join("")}</tr></thead><tbody>${section.rows
        .map((row) => `<tr>${row.map((value) => `<td>${esc(value)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "text":
      return `<div class="sec txt">${esc(section.text)}</div>`;
    case "spark": {
      const points = section.points;
      const min = Math.min(...points);
      const max = Math.max(...points);
      const span = max - min || 1;
      const coords = points
        .map((point, index) => {
          const x = (index / (points.length - 1)) * 200;
          const y = 40 - ((point - min) / span) * 36 - 2;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      return `<div class="sec">${section.label === undefined ? "" : `<div class="l" style="font-size:12px;color:#71717a">${esc(section.label)}</div>`}<svg width="200" height="40" viewBox="0 0 200 40" role="img"><polyline fill="none" stroke="#2563eb" stroke-width="1.5" points="${coords}"/></svg></div>`;
    }
  }
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Deterministic renderers: same spec + snapshot => byte-identical output.
// One card renderer serves both the single-view page and the index grid; the
// stylesheet (theme.ts) and the section registry (sections.ts) own the look.
// Pages are fully self-contained — inline style, no scripts, no external
// assets. Error snapshots render an error card, never a 500.

import type { CardModel, CardSection, ViewSnapshot, ViewSpec } from "./model.js";
import { renderSection } from "./sections.js";
import { esc, formatInterval, formatTimestamp } from "./text.js";
import { THEME_CSS } from "./theme.js";

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

export interface CardOptions {
  /** Wrap the card in a link (the index grid). */
  href?: string;
  /** Stagger index for the load animation (the index grid). */
  index?: number;
  /** Show only the leading sections (the index grid); the link leads to the full card. */
  compact?: boolean;
  /** Heading level for the card title: h1 on its own page, h2 inside the index. */
  heading?: "h1" | "h2";
}

/** One card. The snapshot may be missing (never run), failed, or ok. */
export function renderCard(spec: ViewSpec, snapshot: ViewSnapshot | undefined, options: CardOptions = {}): string {
  const model = snapshot !== undefined && snapshot.ok ? snapshot.model : undefined;
  const status = snapshot === undefined ? "none" : snapshot.ok ? "ok" : "bad";
  const statusLabel = status === "none" ? "not run yet" : status === "ok" ? "healthy" : "failing";
  const heading = options.heading ?? "h1";

  const title = model?.title ?? spec.title;
  const subtitle = model?.subtitle ?? spec.description;
  // Kicker: the pinned name (when the model headlines differently), the
  // sensitivity, the cadence — the card's byline.
  const kicker =
    `<div class="kicker"><span class="status status--${status}" role="img" aria-label="${statusLabel}"></span>` +
    `${title === spec.title ? "" : `<span class="name">${esc(spec.title)}</span>`}` +
    `<span class="chip chip--${esc(spec.sensitivity)}">${esc(spec.sensitivity)}</span>` +
    `<span>${esc(formatInterval(spec.refresh.intervalMs))}</span></div>`;
  const head =
    `<header class="card-head">${kicker}<${heading} class="card-title">${esc(title)}</${heading}>` +
    `${subtitle === undefined || subtitle === "" ? "" : `<p class="card-sub">${esc(subtitle)}</p>`}</header>`;

  let body: string;
  if (model !== undefined) {
    const shown = options.compact === true ? compactSections(model) : model.sections;
    const hidden = model.sections.length - shown.length;
    body =
      shown.map((section) => renderSection(section)).join("") +
      (hidden === 0 ? "" : `<p class="more">+${String(hidden)} more ${hidden === 1 ? "section" : "sections"} →</p>`);
  } else if (snapshot === undefined) {
    body = `<p class="empty">Not run yet — the first render appears here.</p>`;
  } else {
    body = renderError(snapshot);
  }

  const classes = ["card"];
  if (status === "bad") {
    classes.push("card--error");
  }
  const style = options.index === undefined ? "" : ` style="--i:${String(options.index)}"`;
  const article =
    `<article class="${classes.join(" ")}"${style}>${head}<div class="card-body">${body}</div>` +
    `${renderFooter(snapshot)}</article>`;
  return options.href === undefined ? article : `<a class="card-link" href="${esc(options.href)}">${article}</a>`;
}

function renderError(snapshot: ViewSnapshot): string {
  const kind = snapshot.error?.kind ?? "unknown";
  const message = snapshot.error?.message ?? "no details";
  const queries = Object.entries(snapshot.queryErrors ?? {});
  const list =
    queries.length === 0
      ? ""
      : `<ul class="err-q">${queries
          .map(
            ([key, error]) =>
              `<li><code>${esc(key)}</code> ${esc(error.message)}${error.code === undefined ? "" : ` <code>${esc(error.code)}</code>`}</li>`,
          )
          .join("")}</ul>`;
  return (
    `<p class="err"><span class="chip chip--bad">${esc(kind)}</span> view failed: <code>${esc(message)}</code></p>` +
    list
  );
}

function renderFooter(snapshot: ViewSnapshot | undefined): string {
  if (snapshot === undefined) {
    return "";
  }
  const provenance = (snapshot.provenance ?? [])
    .map((entry) => `${entry.capability}${entry.version === null ? "" : `@${entry.version}`}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(", ");
  const from = provenance === "" ? "" : `from ${esc(provenance)}`;
  const rendered = `rendered ${esc(formatTimestamp(snapshot.startedAt))} · ${String(snapshot.durationMs)} ms`;
  return `<footer class="card-foot"><span>${from}</span><span>${rendered}</span></footer>`;
}

/** The index keeps cards glanceable: leading sections up to a height budget,
 * always cut at a section boundary (never mid-table), the rest summarized. */
const COMPACT_BUDGET = 14;

function compactSections(model: CardModel): CardModel["sections"] {
  const shown: CardModel["sections"] = [];
  let spent = 0;
  for (const section of model.sections) {
    const cost = sectionCost(section);
    if (shown.length > 0 && spent + cost > COMPACT_BUDGET) {
      break;
    }
    shown.push(section);
    spent += cost;
  }
  return shown;
}

function sectionCost(section: CardSection): number {
  switch (section.kind) {
    case "stats":
      return 3;
    case "spark":
    case "bars":
      return 4;
    case "progress":
      return 1 + section.items.length;
    case "table":
      return 1 + section.rows.length / 2;
    case "list":
    case "keyValues":
      return 1 + section.items.length / 2;
    case "text":
      return 1 + Math.ceil(section.text.length / 120);
  }
}

function page(title: string, body: string, pageClass: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">` +
    `<title>${esc(title)}</title><style>${THEME_CSS}</style></head>` +
    `<body><main class="page ${pageClass}">${body}</main></body></html>`
  );
}

export function renderCardHtml(spec: ViewSpec, snapshot: ViewSnapshot): string {
  const nav = `<nav class="top"><a href="/views">← All views</a><span class="id">${esc(spec.id)}</span></nav>`;
  return page(spec.title, nav + renderCard(spec, snapshot, { heading: "h1" }), "page--single");
}

export interface ViewIndexEntry {
  spec: ViewSpec;
  snapshot: ViewSnapshot | undefined;
}

/** The signed-in browser's landing page: one bookmark, every card, at a glance. */
export function renderViewsIndexHtml(entries: readonly ViewIndexEntry[]): string {
  const failing = entries.filter((entry) => entry.snapshot !== undefined && !entry.snapshot.ok).length;
  const summary =
    entries.length === 0
      ? "nothing pinned"
      : `${String(entries.length)} pinned${failing === 0 ? "" : ` · ${String(failing)} failing`}`;
  const masthead = `<header class="masthead"><h1>Views</h1><p>${esc(summary)}</p></header>`;
  const body =
    entries.length === 0
      ? `<p class="empty">No views pinned yet. Ask your agent to pin one — it compiles the card once, then this page serves it forever.</p>`
      : `<section class="grid">${entries
          .map((entry, index) =>
            renderCard(entry.spec, entry.snapshot, {
              href: `/views/${entry.spec.id}`,
              index,
              compact: true,
              heading: "h2",
            }),
          )
          .join("")}</section>`;
  return page("Views", masthead + body, "page--index");
}

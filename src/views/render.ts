// Deterministic renderers: same spec + snapshot => byte-identical output.
// One card renderer serves both the single-view page and the index grid; the
// stylesheet (theme.ts) and the section registry (sections.ts) own the look.
// Pages are fully self-contained — inline style, no scripts, no external
// assets. Error snapshots render an error card, never a 500.

import { viewPath, type CardModel, type CardSection, type ViewSnapshot, type ViewSpec } from "./model.js";
import type { ViewPreview } from "./previews.js";
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
  /** A preview render: dashed frame, nothing else changes. */
  preview?: boolean;
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
  if (options.preview === true) {
    classes.push("card--preview");
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

const INDEX_NAV = `<a href="/views">← All views</a>`;

export function renderCardHtml(spec: ViewSpec, snapshot: ViewSnapshot): string {
  const nav = `<nav class="top">${INDEX_NAV}<span class="id">${esc(spec.id)}</span></nav>`;
  return page(spec.title, nav + renderCard(spec, snapshot, { heading: "h1" }), "page--single");
}

/** The look-before-you-pin page: the same card in a dashed frame, with a
 * notice saying it is not pinned and when it expires. */
export function renderPreviewHtml(preview: ViewPreview): string {
  const { spec, snapshot } = preview;
  const nav = `<nav class="top">${INDEX_NAV}<span class="id">preview · ${esc(spec.id)}</span></nav>`;
  const notice =
    `<p class="notice"><strong>Preview</strong> — not pinned: nothing refreshes and no grants were written. ` +
    `Expires ${esc(formatTimestamp(preview.expiresAt))}. Like it? Tell your agent to pin it.</p>`;
  return page(
    `Preview · ${spec.title}`,
    nav + notice + renderCard(spec, snapshot, { heading: "h1", preview: true }),
    "page--single",
  );
}

export function renderPreviewJson(preview: ViewPreview): Record<string, unknown> {
  return {
    ...renderCardJson(preview.spec, preview.snapshot),
    preview: { token: preview.token, createdAt: preview.createdAt, expiresAt: preview.expiresAt },
  };
}

/** A plain message page in the same dress (expired preview, and the like). */
export function renderNoticeHtml(title: string, message: string): string {
  const nav = `<nav class="top">${INDEX_NAV}</nav>`;
  const body = `<header class="masthead"><h1>${esc(title)}</h1></header><p class="empty">${esc(message)}</p>`;
  return page(title, nav + body, "page--single");
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
              href: viewPath(entry.spec.id),
              index,
              compact: true,
              heading: "h2",
            }),
          )
          .join("")}</section>`;
  return page("Views", masthead + body, "page--index");
}

// ------------------------------------------------------------------- home --

/** Shape the home index needs. Declared structurally rather than imported from
 * gateway.ts, which imports this module — CapabilitySummary satisfies it. */
export interface HomeCapability {
  id: string;
  state: "connected" | "failed" | "closed";
  lastError: string | null;
  tools: readonly { name: string; description: string }[];
  web?: { path: string; label: string; description?: string | undefined } | undefined;
}

export interface HomeLink {
  href: string;
  label: string;
  description?: string | undefined;
}

export interface HomeModel {
  capabilities: readonly HomeCapability[];
  /** Sibling web apps that are not mounted capabilities. */
  links?: readonly HomeLink[] | undefined;
  /** Absent when views are disabled in config. */
  views?: { count: number; failing: number } | undefined;
  /** Public MCP endpoint, when the gateway knows its own public URL. */
  mcpUrl?: string | undefined;
}

/** One sentence, or a hard trim — tool descriptions are written for agents and
 * run long; the index is for skimming. */
function firstSentence(text: string, max = 120): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/\.\s|\.$/u);
  const one = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function appCard(href: string, kicker: string, title: string, sub: string, index: number): string {
  return (
    `<a class="card-link" href="${esc(href)}">` +
    `<article class="card" style="--i:${String(index)}">` +
    `<header class="card-head">` +
    `<div class="kicker"><span class="status status--ok" role="img" aria-label="available"></span>` +
    `<span>${esc(kicker)}</span></div>` +
    `<h3 class="card-title">${esc(title)}</h3>` +
    (sub === "" ? "" : `<p class="card-sub">${esc(sub)}</p>`) +
    `</header></article></a>`
  );
}

function capabilityCard(cap: HomeCapability, index: number): string {
  const up = cap.state === "connected";
  const status = up ? "ok" : "bad";
  const label = up
    ? `${String(cap.tools.length)} ${cap.tools.length === 1 ? "tool" : "tools"}`
    : cap.state;
  const kicker =
    `<div class="kicker"><span class="status status--${status}" role="img" aria-label="${esc(cap.state)}"></span>` +
    `<span>${esc(label)}</span>` +
    (cap.web === undefined ? `<span class="chip">agent-only</span>` : `<span class="chip">web</span>`) +
    `</div>`;
  let body: string;
  if (!up) {
    body = `<p class="empty">Not connected${cap.lastError === null ? "" : ` — ${esc(cap.lastError)}`}</p>`;
  } else if (cap.tools.length === 0) {
    body = `<p class="empty">No tools exposed.</p>`;
  } else {
    body =
      `<ul class="list">` +
      cap.tools
        .map(
          (tool) =>
            `<li><span class="name">${esc(tool.name)}</span>` +
            (tool.description === ""
              ? ""
              : ` <span class="trim">${esc(firstSentence(tool.description))}</span>`) +
            `</li>`,
        )
        .join("") +
      `</ul>`;
  }
  const classes = up ? "card" : "card card--error";
  return (
    `<article class="${classes}" style="--i:${String(index)}">` +
    `<header class="card-head">${kicker}<h3 class="card-title">${esc(cap.id)}</h3></header>` +
    body +
    `</article>`
  );
}

/**
 * The front door: what this platform is and what it can do. Apps you can open
 * are links; capabilities without a web UI still appear, with their tools, so
 * an agent-only capability is discoverable rather than invisible. Capability
 * cards are derived from what is mounted; `links` covers sibling apps that
 * live elsewhere (a different subdomain) and so cannot be inferred.
 */
export function renderHomeHtml(model: HomeModel): string {
  const connected = model.capabilities.filter((cap) => cap.state === "connected");
  const toolCount = connected.reduce((sum, cap) => sum + cap.tools.length, 0);
  const down = model.capabilities.length - connected.length;
  const summary =
    `${String(model.capabilities.length)} ${model.capabilities.length === 1 ? "capability" : "capabilities"}` +
    ` · ${String(toolCount)} tools` +
    (down === 0 ? "" : ` · ${String(down)} down`);
  const masthead = `<header class="masthead"><h1>Apps</h1><p>${esc(summary)}</p></header>`;

  const apps: string[] = [];
  for (const cap of model.capabilities) {
    if (cap.web !== undefined) {
      apps.push(
        appCard(cap.web.path, "dashboard", cap.web.label, cap.web.description ?? "", apps.length),
      );
    }
  }
  for (const link of model.links ?? []) {
    apps.push(appCard(link.href, "app", link.label, link.description ?? "", apps.length));
  }
  if (model.views !== undefined) {
    const sub =
      model.views.count === 0
        ? "Nothing pinned yet"
        : `${String(model.views.count)} pinned${model.views.failing === 0 ? "" : ` · ${String(model.views.failing)} failing`}`;
    apps.push(appCard("/views", "views", "Views", sub, apps.length));
  }
  const appsSection =
    apps.length === 0
      ? ""
      : `<section class="sec"><h2 class="sec-title">Open</h2><div class="grid">${apps.join("")}</div></section>`;

  const capsSection =
    model.capabilities.length === 0
      ? `<p class="empty">No capabilities are mounted.</p>`
      : `<section class="sec"><h2 class="sec-title">What this platform can do</h2>` +
        `<div class="grid">${model.capabilities
          .map((cap, index) => capabilityCard(cap, index))
          .join("")}</div></section>`;

  const agentSection =
    model.mcpUrl === undefined
      ? ""
      : `<section class="sec"><h2 class="sec-title">Connect an agent</h2>` +
        `<p class="notice">Every tool above is reachable over MCP at ` +
        `<strong>${esc(model.mcpUrl)}</strong> — add it as an MCP server and sign in; ` +
        `no token to copy.</p></section>`;

  return page("Apps", masthead + appsSection + capsSection + agentSection, "page--index");
}

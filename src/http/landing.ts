// The store page at `/`: public, server-rendered, self-contained (inline
// style, no scripts, no external assets). Anyone can read what the apps are
// and why they are worth opening; only a signed-in viewer sees what is
// mounted underneath — tool lists and capability health — so the anonymous
// page never describes the running system, only the catalogue.

import { STORE_ACCENTS, type StoreAccent, type StoreConfig, type StoreCopy } from "../config.js";
import { esc } from "../views/text.js";

/** One tile. The copy is the app's resolved store words (manifest `store`
 * block, config overrides); `href` is where "Open" goes. A capability with
 * words but no web path is agent-only: it still gets a tile, whose call to
 * action points at the assistant section instead of a page. */
export interface StoreApp extends StoreCopy {
  /** "app" is a mounted capability (tools for the assistant, and a page
   * under this domain when `href` is set); "link" is a sibling web app on
   * its own host, with no tools here. */
  kind: "app" | "link";
  href?: string | undefined;
}

/** Shape the signed-in half needs. Declared structurally rather than
 * imported from gateway.ts — CapabilitySummary satisfies it. */
export interface StoreCapability {
  id: string;
  state: "connected" | "failed" | "closed";
  lastError: string | null;
  tools: readonly { name: string; description: string }[];
  /** Resolved words: the manifest's `store` block, overridden by config. */
  store: StoreCopy;
  web?: { path: string } | undefined;
}

export interface StoreViewer {
  email: string;
}

/**
 * A browser that signed in as someone not invited. The page is the same
 * catalogue everyone sees, with a banner saying so and the hosted apps'
 * "Open" links locked; the source links stay live, since running an app
 * yourself needs no invitation. "offer" carries the one-time token that
 * lets this browser ask; "waiting" says when it did; "invited" is the
 * moment the invitation came through — one sign-in away from the apps.
 */
export interface StoreWaitlist {
  email: string;
  status: "offer" | "waiting" | "invited";
  token?: string | undefined;
  requestedAt?: string | undefined;
  /** Where the join form posts. */
  action: string;
  /** Where "Sign in" goes once invited. */
  signInPath: string;
}

export interface StoreModel {
  /** Hostname of the public URL — the wordmark when `store.name` is unset. */
  host: string;
  store?: StoreConfig | undefined;
  apps: readonly StoreApp[];
  /** Public MCP endpoint, when the gateway knows its own public URL. */
  mcpUrl?: string | undefined;
  /** Present when the request carried a valid session or bearer token. */
  viewer?: StoreViewer | undefined;
  /** Signed-in only: what is mounted, with tools and health. */
  capabilities?: readonly StoreCapability[] | undefined;
  /** Where the top-right "Sign in" goes; absent when there is no login. */
  signInPath?: string | undefined;
  /** Present for a signed-in-but-not-invited browser; never with `viewer`. */
  waitlist?: StoreWaitlist | undefined;
}

/** The JSON twin of the page: the same facts, for the same viewer. */
export function storeJson(model: StoreModel): Record<string, unknown> {
  return {
    ...(model.store === undefined ? {} : { store: model.store }),
    apps: model.apps,
    ...(model.mcpUrl === undefined ? {} : { mcpUrl: model.mcpUrl }),
    ...(model.viewer === undefined ? {} : { viewer: model.viewer }),
    ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
    ...(model.waitlist === undefined
      ? {}
      : {
          waitlist: {
            email: model.waitlist.email,
            status: model.waitlist.status,
            ...(model.waitlist.requestedAt === undefined ? {} : { requestedAt: model.waitlist.requestedAt }),
          },
        }),
  };
}

/** One sentence, or a hard trim — tool descriptions are written for agents
 * and run long; the page is for skimming. */
function firstSentence(text: string, max = 120): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/\.\s|\.$/u);
  const one = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function accentFor(app: StoreApp, index: number): StoreAccent {
  return app.accent ?? STORE_ACCENTS[index % STORE_ACCENTS.length] ?? "sky";
}

/** The small facts under the copy: how you can use this app. */
function chips(app: StoreApp): string {
  const items: string[] = [];
  if (app.href !== undefined) {
    items.push("Web app");
  }
  if (app.kind === "app") {
    items.push("Works with your assistant");
  }
  if (app.repo !== undefined) {
    items.push("Open source");
  }
  return `<ul class="chips">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

/** Primary action: open the page, or, for an agent-only app, go to the
 * assistant section. Secondary: the source repo, for running it yourself. */
function actions(app: StoreApp, model: StoreModel): string {
  // Not invited: the hosted apps are behind the same sign-in that just
  // said no, so the link would only bounce them back here. Locked, not
  // hidden — the tile still says the app exists and has a page.
  const locked = model.waitlist !== undefined && model.waitlist.status !== "invited";
  const primary =
    app.href !== undefined
      ? locked
        ? `<span class="tile-cta tile-cta--locked">Open ${esc(app.label)} · invite only</span>`
        : `<a class="tile-cta" href="${esc(app.href)}">Open ${esc(app.label)}</a>`
      : model.mcpUrl !== undefined
        ? `<a class="tile-cta" href="#assistant">Use from your assistant</a>`
        : `<span class="tile-cta">Use from your assistant</span>`;
  const repo =
    app.repo === undefined
      ? ""
      : `<a class="tile-repo" href="${esc(app.repo)}" rel="noopener">Run it yourself</a>`;
  return `<div class="tile-actions">${primary}${repo}</div>`;
}

/** The long half of a tile — the paragraph and the highlights — folded
 * behind a "More" toggle so the card stays short, above all on a phone
 * where the tiles stack. A native `<details>` does it without a script,
 * which the page has none of by design; the tagline, chips and actions
 * stay visible, so the fold hides nothing needed to choose an app. */
function tileMore(app: StoreApp): string {
  const description = app.description === undefined ? "" : `<p class="tile-desc">${esc(app.description)}</p>`;
  const points =
    app.highlights === undefined || app.highlights.length === 0
      ? ""
      : `<ul class="tile-points">${app.highlights.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  if (description === "" && points === "") {
    return "";
  }
  return (
    `<details class="tile-more"><summary>More about ${esc(app.label)}</summary>` +
    `<div class="tile-body">${description}${points}</div></details>`
  );
}

function tile(app: StoreApp, index: number, model: StoreModel): string {
  const badge = app.badge === undefined ? "" : `<span class="badge">${esc(app.badge)}</span>`;
  const tagline = app.tagline === undefined ? "" : `<p class="tile-tag">${esc(app.tagline)}</p>`;
  return (
    `<article class="tile tile--${accentFor(app, index)}" style="--i:${String(index)}">` +
    `<div class="tile-head"><h3 class="tile-name">${esc(app.label)}</h3>${badge}</div>` +
    tagline +
    tileMore(app) +
    chips(app) +
    actions(app, model) +
    `</article>`
  );
}

function agentSection(model: StoreModel): string {
  if (model.mcpUrl === undefined) {
    return "";
  }
  const signedIn = model.capabilities !== undefined;
  const intro = signedIn
    ? `<p class="sec-lede">Every app here is also a set of tools your assistant can call. Add the address below as an MCP server in Claude or Claude Code, sign in with the same Google account, and the tools show up in chat. No key to copy.</p>`
    : `<p class="sec-lede">Every app here is also a set of tools your assistant can call. Add the address below as an MCP server in Claude or Claude Code and sign in when it asks. Sign in here to see what each app can do.</p>`;
  const url = `<pre class="url"><code>${esc(model.mcpUrl)}</code></pre>`;
  return `<section class="sec sec--agent" id="assistant"><h2 class="sec-title">Works with your assistant</h2>${intro}${url}${toolsBlock(model)}</section>`;
}

function toolsBlock(model: StoreModel): string {
  const caps = model.capabilities;
  if (caps === undefined) {
    return "";
  }
  if (caps.length === 0) {
    return `<p class="quiet">Nothing is mounted right now.</p>`;
  }
  const groups = caps
    .map((cap) => {
      const name = cap.store.label;
      const up = cap.state === "connected";
      const health = up
        ? `<span class="health health--ok">${String(cap.tools.length)} ${cap.tools.length === 1 ? "tool" : "tools"}</span>`
        : `<span class="health health--bad">not connected${cap.lastError === null ? "" : `: ${esc(cap.lastError)}`}</span>`;
      const heading = `<h3 class="tool-group-name">${esc(name)} ${health}</h3>`;
      if (!up) {
        return `<div class="tool-group">${heading}</div>`;
      }
      if (cap.tools.length === 0) {
        return `<div class="tool-group">${heading}<p class="quiet">No tools exposed.</p></div>`;
      }
      // The list folds behind the heading: the count in the heading is the
      // at-a-glance fact, and a dozen tool names per app would otherwise
      // run the page long, above all on a phone.
      const list = `<ul class="tools">${cap.tools
        .map(
          (tool) =>
            `<li><code>${esc(tool.name)}</code>` +
            (tool.description === "" ? "" : `<span>${esc(firstSentence(tool.description))}</span>`) +
            `</li>`,
        )
        .join("")}</ul>`;
      return `<details class="tool-group"><summary>${heading}</summary>${list}</details>`;
    })
    .join("");
  return `<div class="tool-groups">${groups}</div>`;
}

/** A mailto link with the subject prefilled. */
function mailto(to: string, subject: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}`;
}

function contactSection(model: StoreModel): string {
  const contact = model.store?.contact;
  if (contact === undefined) {
    return "";
  }
  const name = model.store?.name ?? model.host;
  const suggest = mailto(contact.email, `App idea for ${name}`);
  const hello = mailto(contact.email, `Hello from ${name}`);
  return (
    `<section class="sec sec--contact"><h2 class="sec-title">Want something built?</h2>` +
    `<p class="sec-lede">Every app here started as a chore somebody kept doing by hand. If you have one of those, describe it in a paragraph. Bug reports, questions and hellos are welcome too.</p>` +
    `<p class="actions"><a class="btn btn--solid" href="${esc(suggest)}">Suggest an app</a>` +
    `<a class="btn" href="${esc(hello)}">Say hello</a></p>` +
    `<p class="contact-address">Or write to <a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a></p>` +
    `</section>`
  );
}

/** The strip under the top bar for a browser that is not invited (yet). */
function waitlistBanner(model: StoreModel): string {
  const wait = model.waitlist;
  if (wait === undefined) {
    return "";
  }
  const name = model.store?.name ?? model.host;
  const who = `<strong>${esc(wait.email)}</strong>`;
  switch (wait.status) {
    case "invited":
      return (
        `<aside class="notice notice--invited" role="status">` +
        `<p class="notice-text"><strong>You are in.</strong> ${who} was invited — sign in again and the apps open.</p>` +
        `<a class="btn btn--solid btn--small" href="${esc(wait.signInPath)}">Sign in</a></aside>`
      );
    case "waiting":
      return (
        `<aside class="notice notice--waiting" role="status">` +
        `<p class="notice-text"><strong>${esc(name)} is in a limited preview.</strong> ${who} is on the waiting list` +
        (wait.requestedAt === undefined ? "" : ` since ${esc(formatDay(wait.requestedAt))}`) +
        `. Once you are invited, signing in here opens the apps. Until then, every app can still be run from its source.</p></aside>`
      );
    case "offer":
      return (
        `<aside class="notice notice--offer" role="status">` +
        `<p class="notice-text"><strong>${esc(name)} is in a limited preview.</strong> Only invited accounts can open the apps here, ` +
        `and ${who} is not one of them yet. Join the waiting list to be let in as places open up — nothing is kept beyond your address and when you asked.</p>` +
        `<form method="post" action="${esc(wait.action)}" class="notice-form">` +
        `<input type="hidden" name="token" value="${esc(wait.token ?? "")}">` +
        `<button type="submit" class="btn btn--solid btn--small">Join the waiting list</button></form></aside>`
      );
  }
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function topBar(model: StoreModel): string {
  const name = model.store?.name ?? model.host;
  let account = "";
  if (model.viewer !== undefined) {
    account = `<span class="who">${esc(model.viewer.email)}</span><a class="btn btn--small" href="/logout">Sign out</a>`;
  } else if (model.waitlist !== undefined) {
    // Signed in as far as Google is concerned, not as far as the apps are:
    // the address is shown so "not you?" has an answer, and Sign out
    // forgets it.
    account = `<span class="who">${esc(model.waitlist.email)}</span><a class="btn btn--small" href="/logout">Sign out</a>`;
  } else if (model.signInPath !== undefined) {
    account = `<a class="btn btn--small" href="${esc(model.signInPath)}">Sign in</a>`;
  }
  return `<nav class="bar"><a class="wordmark" href="/">${esc(name)}</a><span class="bar-right">${account}</span></nav>`;
}

/**
 * The store page. Tiles come from each capability's resolved store words
 * (its manifest `store` block, overridden by the config `web` block) plus
 * config `links`; the signed-in half is derived from what is actually mounted.
 */
export function renderStoreHtml(model: StoreModel): string {
  const name = model.store?.name ?? model.host;
  const headline = model.store?.headline ?? "Small apps, made by hand, for people I know.";
  // The lede is optional: a headline that stands on its own gets no subtext.
  const lede = model.store?.lede === undefined ? "" : `<p class="lede">${esc(model.store.lede)}</p>`;
  const hero = `<header class="hero"><h1 class="headline">${esc(headline)}</h1>${lede}</header>`;
  const tiles =
    model.apps.length === 0
      ? `<p class="quiet">No apps are listed yet. The first one is on its way.</p>`
      : `<section class="tiles" aria-label="Apps">${model.apps.map((app, index) => tile(app, index, model)).join("")}</section>`;
  const byline = model.store?.contact?.byline;
  const year = String(new Date().getFullYear());
  const footer = `<footer class="foot"><span>${esc(byline ?? name)}</span><span>© ${year} ${esc(name)}</span></footer>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="description" content="${esc(headline)}">` +
    `<title>${esc(name)}</title><style>${STORE_CSS}</style></head>` +
    `<body><main class="store">${topBar(model)}${waitlistBanner(model)}${hero}${tiles}${agentSection(model)}${contactSection(model)}${footer}</main></body></html>`
  );
}

// The store's own stylesheet. It shares the platform's voice (paper, ink,
// a serif for display) but spends its one bold move on the tiles: every app
// is a solid block of its own colour, like a row of painted wooden bricks.
// Everything around the tiles stays quiet.
export const STORE_CSS = `
:root{color-scheme:light dark;
--page:#f4f2ec;--surface:#fffdf8;--ink:#1b1a17;--ink-2:#4f4d47;--muted:#7d7b74;--hair:#dedbd2;--link:#1f4fd6;
--sky:#d7e6ff;--sky-deep:#163d8a;
--leaf:#d9efd4;--leaf-deep:#1f5a2a;
--marigold:#fde6b6;--marigold-deep:#6b4300;
--plum:#ead8f3;--plum-deep:#532a6b;
--clay:#f7dcce;--clay-deep:#7a3b24;
--slate:#dfe4e8;--slate-deep:#2f3f4d;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
--sans:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--page:#131311;--surface:#1c1c1a;--ink:#f1efe8;--ink-2:#c5c2b8;--muted:#8f8d85;--hair:#2e2e2b;--link:#8fb0ff;
--sky:#17325e;--sky-deep:#d7e6ff;
--leaf:#1c3d24;--leaf-deep:#d9efd4;
--marigold:#4d3407;--marigold-deep:#fde6b6;
--plum:#3d2250;--plum-deep:#ead8f3;
--clay:#4f2a1d;--clay-deep:#f7dcce;
--slate:#26323c;--slate-deep:#dfe4e8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--link)}
.store{max-width:1120px;margin:0 auto;padding:20px 20px 56px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px}
.wordmark{font:500 20px/1 var(--serif);color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.bar-right{display:flex;align-items:center;gap:12px;font-size:14px;color:var(--muted)}
.who{max-width:36ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{display:inline-block;white-space:nowrap;padding:9px 16px;border:1.5px solid var(--ink);border-radius:999px;color:var(--ink);font-size:15px;font-weight:500;text-decoration:none;line-height:1.2;background:transparent}
.btn:hover{background:var(--ink);color:var(--page)}
.btn--solid{background:var(--ink);color:var(--page)}
.btn--solid:hover{opacity:.88}
.btn--small{padding:6px 12px;font-size:13.5px}
.btn:focus-visible,.tile-cta:focus-visible,.wordmark:focus-visible{outline:3px solid var(--link);outline-offset:3px}
.notice{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:18px;padding:16px 20px;border-radius:16px;background:var(--marigold);color:var(--ink);border:1px solid color-mix(in srgb,var(--marigold-deep),transparent 70%)}
.notice--invited{background:var(--leaf);border-color:color-mix(in srgb,var(--leaf-deep),transparent 70%)}
.notice-text{margin:0;flex:1 1 40ch;font-size:15.5px;line-height:1.5;text-wrap:pretty}
.notice-form{margin:0}
.notice .btn{border-color:var(--ink)}
.tile-cta--locked{color:var(--ink-2);font-weight:500;cursor:default}
.hero{padding:64px 0 40px;max-width:760px}
.headline{margin:0;font:400 clamp(40px,6.4vw,68px)/1.02 var(--serif);letter-spacing:-.022em;text-wrap:balance}
.lede{margin:22px 0 0;font-size:19px;line-height:1.5;color:var(--ink-2);max-width:52ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;align-items:stretch}
.tile{position:relative;display:flex;flex-direction:column;gap:12px;padding:26px 26px 24px;border-radius:22px;background:var(--tint);color:var(--ink);animation:rise .55s cubic-bezier(.2,.7,.2,1) backwards;animation-delay:calc(var(--i,0)*70ms)}
.tile:hover{background:color-mix(in srgb,var(--tint),var(--ink) 5%)}
.tile--sky{--tint:var(--sky);--deep:var(--sky-deep)}
.tile--leaf{--tint:var(--leaf);--deep:var(--leaf-deep)}
.tile--marigold{--tint:var(--marigold);--deep:var(--marigold-deep)}
.tile--plum{--tint:var(--plum);--deep:var(--plum-deep)}
.tile--clay{--tint:var(--clay);--deep:var(--clay-deep)}
.tile--slate{--tint:var(--slate);--deep:var(--slate-deep)}
.tile-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.tile-name{margin:0;font:400 34px/1.05 var(--serif);letter-spacing:-.015em}
.badge{flex:none;padding:3px 9px;border-radius:999px;background:var(--deep);color:var(--tint);font-size:12px;font-weight:600;line-height:1.4}
.tile-tag{margin:0;font-size:19px;line-height:1.35;font-weight:500;color:var(--deep);text-wrap:pretty}
.tile-desc{margin:0;font-size:15.5px;line-height:1.55;color:var(--ink-2);text-wrap:pretty}
.tile-more{position:relative;z-index:1;margin:0}
.tile-more summary,.tool-group summary{cursor:pointer;list-style:none;user-select:none;-webkit-user-select:none}
.tile-more summary::-webkit-details-marker,.tool-group summary::-webkit-details-marker{display:none}
.tile-more summary{display:inline-flex;align-items:center;gap:8px;padding:2px 0;color:var(--deep);font-size:14px;font-weight:600;line-height:1.4}
.tile-more summary::after,.tool-group summary::after{content:"";flex:none;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);transition:transform .2s}
.tile-more[open] summary::after,.tool-group[open] summary::after{transform:translateY(1px) rotate(-135deg)}
.tile-more summary:focus-visible,.tool-group summary:focus-visible{outline:3px solid var(--link);outline-offset:3px;border-radius:4px}
.tile-body{display:grid;gap:10px;margin-top:10px}
.tile-points{margin:0;padding:0 0 0 18px;font-size:15px;line-height:1.5;color:var(--ink)}
.tile-points li{margin:4px 0}
.tile-points li::marker{color:var(--deep)}
.chips{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.chips li{padding:3px 10px;border:1px solid color-mix(in srgb,var(--deep),transparent 65%);border-radius:999px;color:var(--deep);font-size:12.5px;font-weight:500;line-height:1.4}
.tile-actions{margin-top:auto;padding-top:12px;display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tile-cta{color:var(--deep);font-weight:600;font-size:16px;text-decoration:none;text-underline-offset:4px}
a.tile-cta::after{content:"";position:absolute;inset:0;border-radius:22px}
.tile:hover a.tile-cta{text-decoration:underline}
.tile-repo{position:relative;z-index:1;color:var(--ink-2);font-size:14px;font-weight:500;text-decoration:underline;text-underline-offset:4px;text-decoration-color:color-mix(in srgb,var(--ink-2),transparent 50%)}
.tile-repo:hover{color:var(--deep);text-decoration-color:currentColor}
.tile-repo::after{content:" ↗";font-size:12px}
.contact-address{margin:14px 0 0;font-size:14.5px;color:var(--muted)}
.contact-address a{color:var(--ink-2)}
.sec{margin-top:64px;padding-top:28px;border-top:1px solid var(--hair);max-width:760px}
.sec-title{margin:0;font:400 30px/1.15 var(--serif);letter-spacing:-.015em}
.sec-lede{margin:12px 0 0;font-size:17px;line-height:1.55;color:var(--ink-2);max-width:60ch;text-wrap:pretty}
.url{margin:18px 0 0;padding:14px 18px;border-radius:12px;background:var(--surface);border:1px solid var(--hair);font:15px/1.4 var(--mono);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.url code{font:inherit}
.tool-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px 32px;margin-top:26px}
.tool-group summary{display:flex;align-items:center;gap:10px;padding:2px 0}
.tool-group summary h3{flex:1}
.tool-group[open] summary{margin-bottom:8px}
.tool-group-name{margin:0;font:600 15px/1.3 var(--sans);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.health{font-size:12.5px;font-weight:500;color:var(--muted)}
.health--bad{color:#b23b3b}
@media (prefers-color-scheme:dark){.health--bad{color:#f08c8c}}
.tools{list-style:none;margin:0;padding:0;font-size:14px;line-height:1.45}
.tools li{padding:7px 0;border-top:1px solid var(--hair);display:grid;gap:2px}
.tools code{font:13px var(--mono);color:var(--ink)}
.tools span{color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:22px 0 0}
.quiet{margin:14px 0 0;color:var(--muted)}
.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:72px;padding-top:18px;border-top:1px solid var(--hair);font-size:13.5px;color:var(--muted)}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.tile{animation:none}}
@media (max-width:520px){.store{padding:14px 16px 40px}.notice{padding:14px 16px;border-radius:14px}.notice .btn{flex:1 1 auto;text-align:center}.who{max-width:18ch}.hero{padding:40px 0 28px}.lede{font-size:17px;margin-top:16px}.tiles{gap:12px}.tile{padding:20px 18px 18px;border-radius:18px;gap:10px}a.tile-cta::after{border-radius:18px}.tile-name{font-size:28px}.tile-tag{font-size:17px}.sec{margin-top:48px}.sec-title{font-size:26px}.sec-lede{font-size:16px}.url{padding:12px 14px;font-size:14px}.actions .btn{flex:1 1 auto;text-align:center}.foot{margin-top:56px}}
`.trim();

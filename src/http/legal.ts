// The privacy policy and terms at `/privacy` and `/terms`: public,
// server-rendered, in the store's dress. The text is written from what the
// gateway actually does — Google sign-in, the waiting list, tokens for
// assistants, credentials brokered for connected accounts, the audit log —
// plus what each app says about itself (`dataUse`) and the facts only the
// operator can supply (`store.legal`). Nothing here is boilerplate the
// gateway cannot vouch for: a claim that is not true of this code base is
// not made.

import type { StoreConfig } from "../config.js";
import { esc } from "../views/text.js";
import { STORE_CSS, type StoreApp } from "./landing.js";

export interface LegalModel {
  host: string;
  store: StoreConfig & { legal: NonNullable<StoreConfig["legal"]> };
  apps: readonly StoreApp[];
  /** Present when the gateway has a login (stage 2). */
  hasLogin: boolean;
  /** The Google scopes the connect flow asks for; empty when there is none. */
  connectScopes: readonly string[];
  mcpUrl?: string | undefined;
}

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";

/** Plain words for the scopes the connect flow may ask Google for. Unknown
 * scopes are shown as written: better an honest URL than a guess. */
const SCOPE_WORDS: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.events": "read and edit events on the calendars you connect",
  "https://www.googleapis.com/auth/calendar.events.readonly": "read events on the calendars you connect",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly": "see the list of your calendars",
  "https://www.googleapis.com/auth/calendar.readonly": "read your calendars and their events",
  "https://www.googleapis.com/auth/calendar": "read and edit your calendars and their events",
  "https://www.googleapis.com/auth/gmail.readonly": "read your Gmail messages",
  "https://www.googleapis.com/auth/drive.readonly": "read your Google Drive files",
};

function scopeWords(scope: string): string {
  return SCOPE_WORDS[scope] ?? scope;
}

function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function page(model: LegalModel, title: string, body: string): string {
  const name = model.store.name ?? model.host;
  const contact = model.store.contact?.email;
  const year = String(new Date().getFullYear());
  const nav = `<nav class="bar"><a class="wordmark" href="/">${esc(name)}</a><span class="bar-right"><a class="btn btn--small" href="/">All apps</a></span></nav>`;
  const foot =
    `<footer class="foot"><span><a href="${PRIVACY_PATH}">Privacy</a> · <a href="${TERMS_PATH}">Terms</a>` +
    (contact === undefined ? "" : ` · <a href="mailto:${esc(contact)}">${esc(contact)}</a>`) +
    `</span><span>© ${year} ${esc(model.store.legal.operator)}</span></footer>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<title>${esc(title)} · ${esc(name)}</title><style>${STORE_CSS}${PROSE_CSS}</style></head>` +
    `<body><main class="store">${nav}<article class="prose">${body}</article>${foot}</main></body></html>`
  );
}

function section(heading: string, ...paragraphs: string[]): string {
  return `<section><h2>${esc(heading)}</h2>${paragraphs.join("")}</section>`;
}

function p(html: string): string {
  return `<p>${html}</p>`;
}

function list(items: readonly string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function contactLine(model: LegalModel): string {
  const email = model.store.contact?.email;
  return email === undefined
    ? `Write to ${esc(model.store.legal.operator)} through the store page.`
    : `Write to <a href="mailto:${esc(email)}">${esc(email)}</a>.`;
}

export function renderPrivacyHtml(model: LegalModel): string {
  const name = esc(model.store.name ?? model.host);
  const operator = esc(model.store.legal.operator);
  const hosted = model.apps.filter((app) => app.kind === "app");
  const siblings = model.apps.filter((app) => app.kind === "link");

  const intro =
    `<header class="masthead"><h1>Privacy</h1><p>How ${name} handles what it learns about you. Effective ${esc(formatDate(model.store.legal.updated))}.</p></header>` +
    // The operator's name may end in a period ("Inc."), so it never ends a sentence.
    p(`${name} at <strong>${esc(model.host)}</strong> is run by ${operator}, and this page covers the site and the apps hosted on it. ` +
      (siblings.length === 0
        ? ""
        : `Sites linked from the store that live at their own address (${siblings.map((app) => esc(app.label)).join(", ")}) are separate services with their own terms and privacy pages.`));

  const signIn = model.hasLogin
    ? section(
        "Signing in",
        p(`You sign in with your Google account. From that sign-in ${name} receives your <strong>email address</strong> and whether Google has verified it — nothing else from your account. The address is how the site knows who you are: it decides whether you are invited, and it names the data each app keeps for you.`),
        p(`What is kept: the list of invited addresses; the waiting list, if you asked to join it (your address and when you asked); and a signed session cookie so you stay signed in.`),
        list([
          `<code>gw_session</code> — keeps you signed in for up to 7 days. Signing out revokes it.`,
          `<code>gw_waitlist</code> — set only if you signed in without an invitation; it lets the store page recognise you and show your place on the waiting list for up to 30 days. Signing out clears it.`,
        ]),
        p(`There are no advertising or analytics cookies, and no third-party trackers.`),
      )
    : section("Signing in", p(`${name} has no sign-in of its own; access is by tokens the operator issues.`));

  const assistant =
    model.mcpUrl === undefined
      ? ""
      : section(
          "Using the apps from an assistant",
          p(`Every app is also a set of tools an AI assistant can call through <code>${esc(model.mcpUrl)}</code>. When you connect an assistant, it registers itself with the site and you sign in with Google as above. ${name} then asks you, on a page that names the assistant and where the sign-in code will be sent, whether to allow it. Nothing is issued until you say yes.`),
          p(`The assistant receives tokens that act as you here. Short-lived access tokens expire within an hour; a refresh token, kept on the server, lets the assistant renew them for up to 30 days. Revoking an assistant, signing out, or losing your invitation stops those tokens working.`),
        );

  const scopes = model.connectScopes;
  const connected = section(
    "Connecting your accounts",
    p(`Some apps work on data that lives in another service — your Google Calendar, for instance. When an app asks, you connect that account at the provider, which shows you exactly what is requested and lets you refuse.`),
    scopes.length === 0
      ? ""
      : p(`The Google permissions ${name} may ask for are:`) + list(scopes.map((scope) => esc(scopeWords(scope)))),
    p(`The credential the provider hands back (a refresh token, or an API key you typed) is stored on ${name}'s server in a restricted store. Apps never see it: when one needs to reach the provider, the site mints a short-lived token for that request and hands over only that. You can disconnect at any time from the provider's account settings (for Google, at <a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>) or by asking us; the stored credential is then removed.`),
    p(`${operator}'s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. Data from your Google account is used only to provide the app feature you connected it for, is never used for advertising, and is never sold.`),
  );

  const apps = section(
    "What each app keeps",
    p(`Each app keeps only what its own feature needs. In the apps' own words:`),
    hosted.length === 0
      ? p(`No apps are hosted here yet.`)
      : list(
          hosted.map(
            (app) =>
              `<strong>${esc(app.label)}</strong>` +
              (app.dataUse === undefined
                ? ` — keeps whatever its feature needs; ask us for specifics.`
                : ` — ${esc(app.dataUse)}`),
          ),
        ),
  );

  const logs = section(
    "Logs",
    p(`The server keeps two kinds of log, both for keeping the site running and safe:`),
    list([
      `An <strong>audit log</strong> of tool calls made through the site: which app and tool, on whose behalf, when, and whether it succeeded. It never contains the arguments or the results of a call.`,
      `<strong>Server logs</strong> of errors and of sign-ins that were refused (including the address that tried).`,
    ]),
    p(`Logs rotate automatically and are kept for a limited time.`),
  );

  const sharing = section(
    "Who else sees your data",
    p(`${operator} does not sell your data, does not use it for advertising, and does not share it except:`),
    list([
      `with the providers the site is built on — the server runs on Google Cloud in the United States;`,
      `with the services an app calls on your behalf, as described above, and only to the extent that feature needs;`,
      `if the law requires it.`,
    ]),
  );

  const retention = section(
    "Keeping and deleting",
    p(`Your sign-in data lasts while you are invited. Waiting-list requests are removed when you are invited or when you ask. Connected-account credentials are removed when you disconnect. Data an app keeps for you is deleted when you ask us to remove you, along with your invitation.`),
    p(`To see what is kept about you, to correct it, or to have it deleted, ${contactLine(model)}`),
  );

  const security = section(
    "Security",
    p(`Everything travels over HTTPS. Credentials and tokens are stored on the server with restricted access, and the code that runs this site is open source, so how it handles your data can be read rather than taken on trust. No system is perfectly secure; if you believe something has gone wrong, tell us and we will look.`),
  );

  const children = section(
    "Children",
    p(`${name} is not directed at children under 13, and ${operator} does not knowingly collect information from them.`),
  );

  const changes = section(
    "Changes",
    p(`When this page changes, the date at the top changes with it. A change that matters to how your data is handled is announced on the store page.`),
  );

  const contact = section("Contact", p(contactLine(model)));

  return page(model, "Privacy", intro + signIn + assistant + connected + apps + logs + sharing + retention + security + children + changes + contact);
}

export function renderTermsHtml(model: LegalModel): string {
  const name = esc(model.store.name ?? model.host);
  const operator = esc(model.store.legal.operator);
  const jurisdiction = model.store.legal.jurisdiction;

  const intro =
    `<header class="masthead"><h1>Terms of use</h1><p>The agreement between you and ${operator} for using ${name}. Effective ${esc(formatDate(model.store.legal.updated))}.</p></header>` +
    p(`By signing in to ${name} at <strong>${esc(model.host)}</strong>, or by using any app hosted on it, you agree to these terms. If you do not agree, do not use the site.`);

  const service = section(
    "The service",
    p(`${name} is a small collection of apps, offered as a <strong>preview</strong> by invitation. Apps may be added, changed, paused or withdrawn at any time, and the whole site may be taken down. There is no promise of availability, of keeping any feature, or of keeping your data if the site closes — though ${operator} will try to give notice.`),
    p(`The service is free. If that ever changes, you will be told before anything is charged.`),
  );

  const account = section(
    "Your account",
    p(`You sign in with a Google account that is yours. You are responsible for what is done from it here, and for keeping it secure. Invitations are personal: do not lend your sign-in to someone else. ${operator} may withdraw an invitation, or suspend an account, at any time and for any reason, including no reason at all.`),
  );

  const use = section(
    "Acceptable use",
    p(`Use the apps as they are meant to be used. In particular, do not:`),
    list([
      `try to reach data, accounts or parts of the site that are not yours;`,
      `probe, overload, or interfere with the site or the services it calls;`,
      `use the site to break the law or the terms of a service you connect to it (such as Google's);`,
      `resell, or offer the site to others as a service of your own.`,
    ]),
  );

  const data = section(
    "Your data",
    p(`What you put into the apps, and what they read from accounts you connect, remains yours. You give ${operator} permission to process it as far as needed to run the apps for you and to keep the site working, as described on the <a href="${PRIVACY_PATH}">privacy page</a>. ${operator} claims no other rights in it.`),
    p(`The apps' own code is open source, under the licence each repository states. These terms cover the hosted service, not the code.`),
  );

  const thirdParty = section(
    "Other services",
    p(`The apps rely on services run by others — Google, and the data sources each app names. Those services have their own terms, which apply to your use of them through ${name}. ${operator} is not responsible for what they do, for their availability, or for the accuracy of what they provide.`),
  );

  const warranty = section(
    "No warranty",
    p(`${name} is provided <strong>as is</strong>, without warranties of any kind, express or implied, including fitness for a particular purpose. What the apps show — a forecast, a calendar, a summary — may be wrong, late, or missing. Do not rely on it for anything where an error would cause harm.`),
  );

  const liability = section(
    "Limitation of liability",
    p(`To the fullest extent the law allows, ${operator} is not liable for any indirect, incidental, special or consequential loss, or for lost data, profits or opportunities, arising from your use of ${name} or inability to use it. In any case, ${operator}'s total liability to you for anything related to the site is limited to the greater of US$50 and the amount you paid to use it in the twelve months before the claim.`),
    p(`Some places do not allow parts of this limitation; where that is so, it applies only as far as the law allows.`),
  );

  const termination = section(
    "Ending things",
    p(`You can stop at any time: sign out, disconnect your accounts, and ask to be removed. ${operator} may end or suspend your access at any time. Sections that by their nature should survive — your data, no warranty, limitation of liability — do.`),
  );

  const changes = section(
    "Changes to these terms",
    p(`These terms may change. The date at the top says when they last did. A change that matters is announced on the store page, and using the site after it means you accept the new terms.`),
  );

  const law =
    jurisdiction === undefined
      ? ""
      : section(
          "Governing law",
          p(`These terms are governed by the laws of ${esc(jurisdiction)}, without regard to its conflict-of-law rules, and any dispute is heard by the courts there.`),
        );

  const contact = section("Contact", p(contactLine(model)));

  return page(model, "Terms", intro + service + account + use + data + thirdParty + warranty + liability + termination + changes + law + contact);
}

/** Reading layout for the two pages, on top of the store's stylesheet. */
const PROSE_CSS = `
.prose{max-width:720px;padding:40px 0 8px}
.prose .masthead{margin:0 0 28px}
.prose h1{margin:0;font:400 clamp(36px,5.6vw,52px)/1.05 var(--serif);letter-spacing:-.02em}
.prose .masthead p{margin:14px 0 0;font-size:17px;color:var(--ink-2)}
.prose h2{margin:36px 0 10px;font:400 26px/1.2 var(--serif);letter-spacing:-.012em}
.prose p{margin:0 0 14px;font-size:16.5px;line-height:1.6;color:var(--ink);text-wrap:pretty}
.prose ul{margin:0 0 14px;padding-left:22px}
.prose li{margin:6px 0;font-size:16px;line-height:1.55}
.prose li::marker{color:var(--muted)}
.prose code{font:14px var(--mono);padding:1px 6px;border-radius:6px;background:var(--surface);border:1px solid var(--hair)}
.prose a{color:var(--link);text-underline-offset:3px}
.foot a{color:var(--muted)}
@media (max-width:520px){.prose{padding-top:28px}.prose h2{margin-top:30px;font-size:23px}.prose p,.prose li{font-size:15.5px}}
`.trim();

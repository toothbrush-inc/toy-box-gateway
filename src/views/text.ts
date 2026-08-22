// Text helpers shared by the renderers. Everything here is deterministic —
// no locale, no local timezone — so the same snapshot always renders the
// same bytes.

export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Compact, locale-free: 1,284 · 12.9K · 4.2M · 32.4 · 3.46 · –. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  const abs = Math.abs(value);
  if (abs >= 1e6) {
    return `${trimZeros((value / 1e6).toFixed(1))}M`;
  }
  if (abs >= 1e4) {
    return `${trimZeros((value / 1e3).toFixed(1))}K`;
  }
  if (Number.isInteger(value)) {
    return groupThousands(String(value));
  }
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return groupThousands(trimZeros(value.toFixed(decimals)));
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function groupThousands(text: string): string {
  const [whole, fraction] = text.split(".");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 21, 08:42 UTC" — UTC on purpose: no script runs in a card to localize. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()] ?? "?"} ${String(date.getUTCDate())}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function formatInterval(intervalMs: number | null): string {
  if (intervalMs === null) {
    return "on demand";
  }
  if (intervalMs < 3_600_000) {
    return `every ${String(Math.round(intervalMs / 60_000))} min`;
  }
  const hours = intervalMs / 3_600_000;
  return `every ${trimZeros(hours.toFixed(1))} h`;
}

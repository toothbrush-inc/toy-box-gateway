// Section renderers — the registry that pairs every CardModel word with its
// markup. The mapped type makes the pairing total: add a kind to
// CardSectionSchema and this file fails to compile until it can draw it.
// Every renderer is pure (section => string), escapes everything, and emits
// no scripts; numbers are formatted locale-free so output is byte-stable.

import type { CardSection, Tone } from "./model.js";
import { esc, formatNumber } from "./text.js";

type SectionOf<K extends CardSection["kind"]> = Extract<CardSection, { kind: K }>;
type SectionRenderers = { [K in CardSection["kind"]]: (section: SectionOf<K>) => string };

export const SECTION_RENDERERS: SectionRenderers = {
  stats: renderStats,
  keyValues: renderKeyValues,
  list: renderList,
  table: renderTable,
  text: renderText,
  spark: renderSpark,
  bars: renderBars,
  progress: renderProgress,
};

export function renderSection(section: CardSection): string {
  const render = SECTION_RENDERERS[section.kind] as (section: CardSection) => string;
  const heading = section.title === undefined ? "" : `<h2 class="sec-title">${esc(section.title)}</h2>`;
  return `<section class="sec sec--${section.kind}">${heading}${render(section)}</section>`;
}

// --- stats: label · big figure · signed delta (tone says if up is good) · hint

function renderStats(section: SectionOf<"stats">): string {
  const items = section.items.map((item) => {
    const tone: Tone = item.tone ?? "neutral";
    const delta = item.delta === undefined ? "" : `<div class="d d--${tone}">${deltaText(item.delta)}</div>`;
    const hint = item.hint === undefined ? "" : `<div class="h">${esc(item.hint)}</div>`;
    return `<div class="stat"><div class="l">${esc(item.label)}</div><div class="v">${esc(item.value)}</div>${delta}${hint}</div>`;
  });
  return `<div class="stats">${items.join("")}</div>`;
}

/** "+12%" → "▲ 12%", "−3 bpm" → "▼ 3 bpm": the glyph carries direction so color never does alone. */
function deltaText(delta: string): string {
  const trimmed = delta.trim();
  const sign = trimmed.charAt(0);
  if (sign === "+") {
    return `▲ ${esc(trimmed.slice(1).trim())}`;
  }
  if (sign === "-" || sign === "−") {
    return `▼ ${esc(trimmed.slice(1).trim())}`;
  }
  return esc(trimmed);
}

// --- keyValues: an aligned definition grid

function renderKeyValues(section: SectionOf<"keyValues">): string {
  const items = section.items.map((item) => `<dt>${esc(item.key)}</dt><dd>${esc(item.value)}</dd>`);
  return `<dl class="kv">${items.join("")}</dl>`;
}

// --- list: plain lines, or toned lines with a status dot

function renderList(section: SectionOf<"list">): string {
  const items = section.items.map((item) => {
    if (typeof item === "string") {
      return `<li>${esc(item)}</li>`;
    }
    const cls = item.tone === undefined ? "" : ` class="t-${item.tone}"`;
    return `<li${cls}>${esc(item.text)}</li>`;
  });
  return `<ul class="list">${items.join("")}</ul>`;
}

// --- table: numeric columns (declared or detected) right-align in tabular figures

const NUMERIC_CELL = /^[+\-−$€£]?\s?\d[\d,.]*\s?(%|[°a-zµ/]{1,5})?$/i;

function renderTable(section: SectionOf<"table">): string {
  const columns = section.columns.map((column, index) => {
    const label = typeof column === "string" ? column : column.label;
    const declared = typeof column === "string" ? undefined : column.align;
    const detected =
      section.rows.length > 0 &&
      section.rows.every((row) => {
        const value = row[index] ?? "";
        return value === "" || NUMERIC_CELL.test(value);
      });
    return { label, numeric: declared === undefined ? detected : declared === "right" };
  });
  const head = columns
    .map((column) => `<th${column.numeric ? ' class="num"' : ""}>${esc(column.label)}</th>`)
    .join("");
  const rows = section.rows
    .map(
      (row) =>
        `<tr>${row
          .map((value, index) => {
            const classes = [columns[index]?.numeric === true ? "num" : "", value.length > 24 ? "wrap" : ""]
              .filter(Boolean)
              .join(" ");
            return `<td${classes === "" ? "" : ` class="${classes}"`}>${esc(value)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- text

function renderText(section: SectionOf<"text">): string {
  return `<p class="txt">${esc(section.text)}</p>`;
}

// --- spark: 2px line over a 12% wash, endpoint dot with a surface ring,
// latest value in the head, low/high in the foot. preserveAspectRatio="none"
// lets the plot fill any width; non-scaling strokes keep the marks true-pixel.

const SPARK_W = 240;
const SPARK_H = 64;
const SPARK_PAD = 3;

function renderSpark(section: SectionOf<"spark">): string {
  const points = section.points;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const plotH = SPARK_H - SPARK_PAD * 2;
  const coords = points.map((point, index) => {
    const x = SPARK_PAD + (index / (points.length - 1)) * (SPARK_W - SPARK_PAD * 2);
    const y = SPARK_PAD + (1 - (point - min) / span) * plotH;
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  const baseline = (SPARK_H - SPARK_PAD).toFixed(2);
  const area = `${first[0].toFixed(2)},${baseline} ${line} ${last[0].toFixed(2)},${baseline}`;
  const end = `${last[0].toFixed(2)},${last[1].toFixed(2)}`;
  const unit = section.unit === undefined ? "" : ` ${esc(section.unit)}`;
  const latest = points[points.length - 1] ?? 0;
  const head =
    `<div class="spark-head"><span>${section.label === undefined ? "" : esc(section.label)}</span>` +
    `<b>${esc(formatNumber(latest))}${unit}</b></div>`;
  const svg =
    `<svg viewBox="0 0 ${String(SPARK_W)} ${String(SPARK_H)}" preserveAspectRatio="none" role="img" aria-label="${esc(section.label ?? "trend")}">` +
    `<polygon fill="var(--accent)" fill-opacity=".12" points="${area}"/>` +
    `<polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${line}"/>` +
    `<polyline fill="none" stroke="var(--surface)" stroke-width="12" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${end} ${end}"/>` +
    `<polyline fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${end} ${end}"/>` +
    `</svg>`;
  const foot =
    `<div class="spark-foot"><span>low ${esc(formatNumber(min))}${unit}</span>` +
    `<span>high ${esc(formatNumber(max))}${unit}</span></div>`;
  return `<div class="spark">${head}${svg}${foot}</div>`;
}

// --- bars: ≤24px columns from one baseline, 4px rounded caps, values on the
// caps when there are few (else only the peak), labels thinned the same way.

function renderBars(section: SectionOf<"bars">): string {
  const items = section.items;
  const count = items.length;
  const peak = Math.max(...items.map((item) => item.value));
  const peakIndex = items.findIndex((item) => item.value === peak);
  const dense = count > 8;
  const columns = items.map((item, index) => {
    const height = peak > 0 ? (item.value / peak) * 78 : 0;
    const showValue = !dense || index === peakIndex;
    const value = showValue ? `<span class="bar-val">${esc(formatNumber(item.value))}</span>` : "";
    return `<div class="bar-col">${value}<div class="bar" style="height:${height.toFixed(1)}%"></div></div>`;
  });
  // Few bars: a label under each. Dense: the two ends only, so labels never
  // fight the column width (the peak already carries its value on the cap).
  const first = items[0];
  const last = items[count - 1];
  const labels = dense
    ? `<div class="bar-labs bar-labs--ends"><span>${esc(first?.label ?? "")}</span><span>${esc(last?.label ?? "")}</span></div>`
    : `<div class="bar-labs">${items.map((item) => `<span class="bar-lab">${esc(item.label)}</span>`).join("")}</div>`;
  const unit = section.unit === undefined ? "" : `<div class="bar-unit">${esc(section.unit)}</div>`;
  return `<div class="bars">${columns.join("")}</div>${labels}${unit}`;
}

// --- progress: meters whose fill carries the tone; track is a lighter step
// of the same ramp so state reads across the whole bar.

function renderProgress(section: SectionOf<"progress">): string {
  const meters = section.items.map((item) => {
    const min = item.min ?? 0;
    const ratio = (item.value - min) / (item.max - min);
    const pct = Math.min(100, Math.max(0, ratio * 100));
    const tone = item.tone === undefined ? "" : ` meter--${item.tone}`;
    const display = item.display ?? `${formatNumber(item.value)} / ${formatNumber(item.max)}`;
    return (
      `<div class="meter${tone}"><div class="meter-head"><span class="ml">${esc(item.label)}</span>` +
      `<span class="mv">${esc(display)}</span></div>` +
      `<div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div></div>`
    );
  });
  return meters.join("");
}

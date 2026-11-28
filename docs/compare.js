// Compare tab (#/compare).
//
// One list of up to 10 resorts, each with a season ("Niseko 26-27", "Kiroro 25-26"), shared
// by both modes. One time range at the top applies to every resort: the whole season, or
// from one month to another (e.g. December - January), taken from each resort's own season.
// Graph mode: one line per resort, seasons lined up by date (1 Dec of every season sits at
//   the same place). Choose the data point and "As a percentage".
// Side-by-side mode: one column per resort. Sections (Overview, Lifts, Runs, Snow,
//   Temperatures) open and close for every column at once.
// "+ Compare" on a resort's Historical page adds that resort and season, and moves the time
// range to the larger period: a season always makes it "whole season"; a month (a week or day
// counts as its month) widens the month range. Choices are kept in the visitor's browser.
// Loaded before app.js; uses history.js helpers.

"use strict";

const MAX_ITEMS = 10;
// Reference categorical palette (validated for colour-blind separation, light and dark).
// Lines 9 and 10 reuse the first two colours, dashed.
const SERIES_LIGHT = ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#008a17", "#6a4ce2", "#ec4647"];
const SERIES_DARK = ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#0aac23", "#9887ef", "#eb6263"];

const METRICS = {
  lifts: { label: "Lifts open", unit: "lifts", pctOf: "of all lifts" },
  runs: { label: "Runs open", unit: "runs", pctOf: "of all runs" },
  depth: { label: "Snow depth", unit: "cm", pctOf: "of the period's maximum" },
  snow: { label: "New snow", unit: "cm", pctOf: "of the period's snowiest day" },
  base: { label: "Base temperature (daily mean)", unit: "°C", pctOf: "of the period's range of daily means" },
  summit: { label: "Summit temperature (daily mean)", unit: "°C", pctOf: "of the period's range of daily means" },
};
const SECTIONS = ["overview", "lifts", "runs", "snow", "temps"];
const SECTION_LABEL = { overview: "Overview", lifts: "Lifts", runs: "Runs", snow: "Snow", temps: "Temperatures" };

let compareGraph = null;
let pendingHistoryCarry = null; // "Go to day" from the compare graph opens the day with lifts/runs expanded

// ------------------------------------------------------------------ saved choices

/** Compare works in seasons and months: a week or day becomes its month. */
function compareUnitOf(unit, value) {
  return unit === "week" || unit === "day" ? { unit: "month", value: monthOfPeriod(unit, value) } : { unit, value };
}
function compareItemLabel(unit, value) {
  const c = compareUnitOf(unit, value);
  return periodLabel(c.unit, c.value);
}

/** Season months as month numbers in season order, e.g. [11, 12, 1, 2, 3, 4, 5]. */
function seasonMonthNums() {
  return seasonMonths("2001-02").map(ym => Number(ym.slice(5)));
}
function monthName(n) {
  return MONTH_NAMES[n - 1].replace(/^./, c => c.toUpperCase());
}
/** The time range for every resort: {kind: "season"} or {kind: "months", from, to}. */
function normRange(r) {
  const nums = seasonMonthNums();
  if (r?.kind !== "months") return { kind: "season" };
  const from = nums.includes(Number(r.from)) ? Number(r.from) : nums[1] ?? nums[0];
  let to = nums.includes(Number(r.to)) ? Number(r.to) : from;
  if (nums.indexOf(to) < nums.indexOf(from)) to = from;
  return { kind: "months", from, to };
}
/** The range's first and last date in one resort's season. */
function rangeIn(season, range) {
  const months = seasonMonths(season);
  if (range.kind !== "months") return [`${months[0]}-01`, monthEnd(months[months.length - 1])];
  const pick = n => months.find(m => Number(m.slice(5)) === n);
  return [`${pick(range.from)}-01`, monthEnd(pick(range.to))];
}
function rangeText(range) {
  if (range.kind !== "months") return "Whole season";
  return range.from === range.to ? monthName(range.from) : `${monthName(range.from)} – ${monthName(range.to)}`;
}
/** "Season 2026-27" or "Dec 2026 – Jan 2027" for one resort. */
function rangeLabel(season, range) {
  if (range.kind !== "months") return `Season ${season}`;
  const [start, end] = rangeIn(season, range);
  const a = periodLabel("month", start.slice(0, 7)), b = periodLabel("month", end.slice(0, 7));
  return a === b ? a : `${a} – ${b}`;
}

/** Saved choices: {mode, items: [{id, season}], range, graph: {metric, pct}, side: {open}}.
 *  `defaults`: on the very first visit start with two resorts (pinned ones first). */
function compareState({ defaults = true } = {}) {
  let raw;
  try { raw = JSON.parse(localStorage.getItem("compare")); } catch { raw = null; }
  const s = raw && typeof raw === "object" ? raw : {};
  const ids = resortIds();
  const latest = availableSeasons()[0];
  let items = Array.isArray(s.items) ? s.items : null;
  if (!items) {
    // oldest format kept graph lines and side-by-side columns apart: merge them
    items = [...(s.side?.columns || []), ...(s.graph?.lines || []).map(l => ({ id: l.id, season: l.season }))];
    if (!s.range && s.graph?.range) s.range = s.graph.range;
    if (!raw && defaults && latest) {
      items = [...pins.list(), ...ids].filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).map(id => ({ id, season: latest }));
    }
  }
  // a previous version gave every resort its own season or month: keep the season, and the
  // range from the largest period (any season -> whole season, otherwise the months' span)
  const own = items.filter(it => it?.unit && it.value).map(it => compareUnitOf(it.unit, it.value));
  if (own.length && !s.range) {
    const nums = seasonMonthNums();
    const months = own.filter(c => c.unit === "month").map(c => Number(c.value.slice(5))).sort((a, b) => nums.indexOf(a) - nums.indexOf(b));
    s.range = own.some(c => c.unit === "season") || !months.length
      ? { kind: "season" } : { kind: "months", from: months[0], to: months[months.length - 1] };
  }
  s.items = items
    .map(it => it?.unit && it.value ? { id: it.id, season: seasonOf(periodRange(it.unit, it.value)[0]) } : it)
    .filter(it => it && ids.includes(it.id) && /^\d{4}-\d{2}$/.test(it.season || ""))
    .map(it => ({ id: it.id, season: it.season }))
    .slice(0, MAX_ITEMS);
  s.range = normRange(s.range);
  s.mode = s.mode === "side" ? "side" : "graph";
  s.graph = { metric: METRICS[s.graph?.metric] ? s.graph.metric : "lifts", pct: !!s.graph?.pct };
  s.side = { open: Array.isArray(s.side?.open) ? s.side.open : ["overview", "lifts"] };
  return s;
}
function saveCompare(s) {
  try { localStorage.setItem("compare", JSON.stringify(s)); } catch { /* ignore */ }
}

/** Add a resort and its season (from a Historical page) and follow the larger period:
 *  a season sets the range to whole season; a month widens a month range (or starts one when
 *  Compare was empty). Returns "added", "exists" or "full". */
function addToCompare(id, unit, value) {
  const s = compareState({ defaults: false });
  const c = compareUnitOf(unit, value);
  const season = c.unit === "season" ? c.value : seasonOf(`${c.value}-15`);
  if (s.items.some(x => x.id === id && x.season === season)) return "exists";
  if (s.items.length >= MAX_ITEMS) return "full";
  const wasEmpty = !s.items.length;
  s.items.push({ id, season });
  if (c.unit === "season") s.range = { kind: "season" };
  else {
    const m = Number(c.value.slice(5));
    if (wasEmpty) s.range = { kind: "months", from: m, to: m };
    else if (s.range.kind === "months") {
      const nums = seasonMonthNums();
      const span = [s.range.from, s.range.to, m].sort((a, b) => nums.indexOf(a) - nums.indexOf(b));
      s.range = { kind: "months", from: span[0], to: span[2] };
    }
  }
  saveCompare(s);
  return "added";
}

// ------------------------------------------------------------------ "+ Compare": animation and badge

/** How many resorts were added since the Compare tab was last opened (shown on the tab). */
function compareNewCount() {
  try { return Number(localStorage.getItem("compareNew")) || 0; } catch { return 0; }
}
function setCompareNewCount(n) {
  try { n ? localStorage.setItem("compareNew", String(n)) : localStorage.removeItem("compareNew"); } catch { /* ignore */ }
}
function showCompareBadge(pop = false) {
  const tab = document.querySelector('.tabs a[data-tab="compare"]');
  if (!tab) return;
  const n = compareNewCount();
  let badge = tab.querySelector(".tab-badge");
  if (!n) {
    badge?.remove();
    tab.removeAttribute("aria-label");
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    badge.setAttribute("aria-hidden", "true");
    tab.append(badge);
  }
  badge.textContent = n > 99 ? "99+" : String(n);
  tab.setAttribute("aria-label", `Compare (${n} newly added)`);
  if (pop) {
    badge.classList.remove("pop");
    void badge.offsetWidth; // restart the animation
    badge.classList.add("pop");
  }
}
/** Opening the Compare tab clears the count. */
function compareSeen() {
  setCompareNewCount(0);
  showCompareBadge();
}

/** The resort's name lifts off the page title and swoops up into the Compare tab. */
function flyToCompare(fromEl, text, done) {
  const tab = document.querySelector('.tabs a[data-tab="compare"]');
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!fromEl || !tab || reduce || !Element.prototype.animate) { done(); return; }
  const from = fromEl.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "fly-ghost";
  ghost.textContent = text;
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  document.body.append(ghost);
  const g = ghost.getBoundingClientRect(), to = tab.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (g.left + g.width / 2);
  const dy = to.top + to.height / 2 - (g.top + g.height / 2);
  const anim = ghost.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx * 0.15}px, ${dy * 0.55}px) scale(0.8)`, opacity: 1, offset: 0.4 },
    { transform: `translate(${dx * 0.7}px, ${dy * 1.05}px) scale(0.45)`, opacity: 0.9, offset: 0.8 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.15)`, opacity: 0 },
  ], { duration: 800, easing: "cubic-bezier(.45, 0, .25, 1)" });
  anim.onfinish = anim.oncancel = () => { ghost.remove(); done(); };
}

function addToCompareWithAnimation(id, unit, value, titleEl, button) {
  const name = state.index.resorts[id].name;
  const result = addToCompare(id, unit, value);
  if (result === "exists") {
    const c = compareUnitOf(unit, value);
    toast(`${name} ${c.unit === "season" ? c.value : seasonOf(`${c.value}-15`)} is already in Compare.`);
    return;
  }
  if (result === "full") { toast(`Compare holds up to ${MAX_ITEMS} resorts. Remove one there first.`); return; }
  setCompareNewCount(compareNewCount() + 1);
  if (button) {
    button.textContent = "✓ Added";
    button.disabled = true;
    setTimeout(() => { if (button.isConnected) { button.textContent = "+ Compare"; button.disabled = false; } }, 1600);
  }
  flyToCompare(titleEl, name, () => showCompareBadge(true));
}

function shortName(id) {
  const words = state.index.resorts[id].name.split(" ");
  return ["Hakuba", "Sapporo"].includes(words[0]) ? words.slice(0, 2).join(" ") : words[0];
}
function seasonShort(label) {
  return label.slice(2);
}
function seriesColor(i) {
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return (dark ? SERIES_DARK : SERIES_LIGHT)[i % 8];
}

function resortOptions(selected) {
  let html = "";
  for (const [region, ids] of regions()) {
    html += `<optgroup label="${esc(region)}">${ids.map(id =>
      `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(state.index.resorts[id].name)}</option>`).join("")}</optgroup>`;
  }
  return html;
}
// ------------------------------------------------------------------ graph mode

/** Put a date from any season on a common reference season (2001-02), so seasons line up. */
function refDate(iso) {
  // seasons run July-June: July-December -> 2001, January-June -> 2002 (29 Feb -> 28 Feb)
  const year = Number(iso.slice(5, 7)) >= 7 ? 2001 : 2002;
  const md = iso.slice(5) === "02-29" ? "02-28" : iso.slice(5);
  return `${year}-${md}`;
}

/** The x range on the reference season. */
function graphRange(range) {
  const months = seasonMonths("2001-02");
  if (range.kind === "months") {
    const from = months.find(m => Number(m.slice(5)) === Number(range.from)) || months[0];
    let to = months.find(m => Number(m.slice(5)) === Number(range.to)) || months[months.length - 1];
    if (to < from) to = from;
    return [`${from}-01`, monthEnd(to)];
  }
  return [`${months[0]}-01`, monthEnd(months[months.length - 1])];
}

async function seriesFor(it, range, metric, pct, i) {
  const [pStart, pEnd] = rangeIn(it.season, range);
  const recs = await recordsInRange(it.id, pStart, pEnd);
  const ok = recs.filter(x => x.r.ok);
  const source = snowSource(recs);
  let value;
  if (metric === "lifts") value = r => r.ok ? (pct ? (r.lifts.length ? (r.lifts_open / r.lifts.length) * 100 : null) : r.lifts_open) : null;
  else if (metric === "runs") value = r => r.ok && r.runs?.length ? (pct ? (r.runs_open / r.runs.length) * 100 : r.runs_open) : null;
  else if (metric === "depth") {
    const max = Math.max(0, ...ok.map(x => x.r.snow_depth_cm ?? 0));
    value = r => r.ok && r.snow_depth_cm != null ? (pct ? (max ? (r.snow_depth_cm / max) * 100 : null) : r.snow_depth_cm) : null;
  } else if (metric === "snow") {
    const max = Math.max(0, ...recs.map(x => snowAmount(x.r, source) ?? 0));
    value = r => { const a = snowAmount(r, source); return a == null ? null : pct ? (max ? (a / max) * 100 : null) : a; };
  } else {
    const means = recs.map(x => x.r.temps?.kind === "final" ? x.r.temps[metric]?.mean_c : null).filter(v => v != null);
    const lo = Math.min(...means), hi = Math.max(...means);
    value = r => {
      const v = r.temps?.kind === "final" ? r.temps[metric]?.mean_c : null;
      if (v == null) return null;
      return pct ? (hi > lo ? ((v - lo) / (hi - lo)) * 100 : null) : v;
    };
  }
  const points = [];
  for (const x of recs) {
    const v = value(x.r);
    if (v != null) points.push({ date: refDate(x.date), actualDate: x.date, value: Math.round(v * 10) / 10, r: x.r });
  }
  return {
    key: `${i}`, id: it.id,
    label: `${state.index.resorts[it.id].name} ${seasonShort(it.season)}`,
    short: `${shortName(it.id)} ${seasonShort(it.season)}`,
    color: seriesColor(i), dashed: i >= 8, points,
  };
}

function lineKey(s) {
  return `<svg width="18" height="8" aria-hidden="true"><line x1="1" x2="17" y1="4" y2="4" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="4 3"' : ""}/></svg>`;
}

function graphDetails(metric, pct) {
  const m = METRICS[metric];
  const fmt = v => pct ? `${Math.round(v)}%` : (metric === "base" || metric === "summit") ? `${deg(v)} °C` : `${v} ${m.unit}`;
  return (date, rows) => {
    const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
    return `<div class="tip-date"><strong>${esc(day)}</strong> · ${esc(m.label)}${pct ? ` (% ${esc(m.pctOf)})` : ""}</div>
      ${rows.map(r => `<div class="tip-series">${lineKey(r.series)}<strong>${esc(fmt(r.point.value))}</strong>
        <span class="muted">${esc(r.series.short)}</span></div>`).join("")}`;
  };
}

async function drawCompareGraph(s) {
  const host = view.querySelector(".cmp-graph");
  if (!host) return;
  compareGraph?.destroy();
  compareGraph = null;
  const { metric, pct } = s.graph;
  const lines = s.items;
  if (!lines.length) { host.innerHTML = `<p class="muted">Add a resort to start comparing.</p>`; return; }
  host.innerHTML = `<p class="muted small">Loading…</p>`;
  const series = await Promise.all(lines.map((l, i) => seriesFor(l, s.range, metric, pct, i)));
  if (!view.querySelector(".cmp-graph")) return; // navigated away
  const [start, end] = graphRange(s.range);
  const m = METRICS[metric];
  host.innerHTML = `<p class="muted small graph-caption">${esc(m.label)}${pct ? ` as a percentage ${esc(m.pctOf)}` : ""}.
    Seasons are lined up by date. Hover or click for each line's value; "Go to day" opens that resort's day.</p><div class="graph-host"></div>`;
  compareGraph = createGraph(host.querySelector(".graph-host"), {
    start, end, series, yLabel: m.label, ySuffix: pct ? "%" : "",
    integer: !pct && (metric === "lifts" || metric === "runs"),
    yMax: pct ? 100 : undefined,
    details: graphDetails(metric, pct),
    onGoToDay: (key, point) => {
      const sr = series.find(x => x.key === key);
      if (metric === "lifts" || metric === "runs") pendingHistoryCarry = { expanded: metric, view: "day", day: point.actualDate };
      location.hash = `#/history/${sr.id}/day/${point.actualDate}`;
    },
  });
}

function graphModeHtml(s) {
  const g = s.graph;
  return `
    <div class="cmp-controls">
      <label class="cmp-field">Data point
        <select data-g="metric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}"${k === g.metric ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
      </label>
      <label class="cmp-check"><input type="checkbox" data-g="pct"${g.pct ? " checked" : ""}> As a percentage
        <span class="muted small">(${esc(METRICS[g.metric].pctOf)})</span></label>
    </div>
    <div class="cmp-lines">
      ${s.items.map((it, i) => `
        <div class="cmp-line" data-item="${i}">
          ${lineKey({ color: seriesColor(i), dashed: i >= 8 })}
          ${resortSelectHtml(it)}${seasonSelectHtml(it)}${removeButton(i)}
        </div>`).join("")}
      ${addItemButton(s)}
    </div>
    <div class="cmp-graph card"></div>`;
}

// ------------------------------------------------------------------ time range (every resort) and the shared list

/** Season / Months toggle at the top: applies to every resort, in both modes. */
function rangeControlsHtml(s) {
  const r = s.range;
  const nums = seasonMonthNums();
  const opts = sel => nums.map(n => `<option value="${n}"${n === sel ? " selected" : ""}>${monthName(n)}</option>`).join("");
  return `
    <div class="cmp-range-bar">
      <span class="cmp-range-title">Time range</span>
      <div class="seg" role="radiogroup" aria-label="Time range">
        <button type="button" role="radio" class="seg-btn${r.kind === "season" ? " is-active" : ""}" aria-checked="${r.kind === "season"}" data-range="season">Season</button>
        <button type="button" role="radio" class="seg-btn${r.kind === "months" ? " is-active" : ""}" aria-checked="${r.kind === "months"}" data-range="months">Month</button>
      </div>
      ${r.kind === "months" ? `
        <div class="cmp-range">
          <select data-range-from aria-label="From">${opts(r.from)}</select>
          <span class="muted">to</span>
          <select data-range-to aria-label="To">${opts(r.to)}</select>
        </div>` : ""}
      <span class="muted small">${r.kind === "season" ? "Each resort's whole season." : `${esc(rangeText(r))} of each resort's season.`}</span>
    </div>`;
}

function resortSelectHtml(it) {
  return `<select data-item-id aria-label="Resort">${resortOptions(it.id)}</select>`;
}
function seasonSelectHtml(it) {
  const seasons = availableSeasons();
  if (!seasons.includes(it.season)) seasons.push(it.season);
  return `<select data-item-season aria-label="Season">${seasons.map(l =>
    `<option value="${l}"${l === it.season ? " selected" : ""}>${seasonShort(l)}${state.index.seasons[l]?.demo ? " (demo)" : ""}</option>`).join("")}</select>`;
}
function removeButton(i) {
  return `<button type="button" class="link-button" data-remove-item="${i}" aria-label="Remove">✕</button>`;
}
function wireCompareControls(s, save) {
  view.querySelectorAll("[data-range]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.range === s.range.kind) return;
    const nums = seasonMonthNums();
    s.range = b.dataset.range === "months" ? normRange({ kind: "months", from: nums[1], to: nums[2] }) : { kind: "season" };
    save();
  }));
  view.querySelector("[data-range-from]")?.addEventListener("change", e => {
    s.range = normRange({ ...s.range, from: Number(e.target.value) });
    save();
  });
  view.querySelector("[data-range-to]")?.addEventListener("change", e => {
    const nums = seasonMonthNums(), to = Number(e.target.value);
    // choosing an end before the start moves the start back to it
    s.range = normRange(nums.indexOf(to) < nums.indexOf(s.range.from) ? { kind: "months", from: to, to } : { ...s.range, to });
    save();
  });
  view.querySelectorAll("[data-item]").forEach(el => {
    const it = s.items[Number(el.dataset.item)];
    el.querySelector("[data-item-id]").addEventListener("change", e => { it.id = e.target.value; save(); });
    el.querySelector("[data-item-season]").addEventListener("change", e => { it.season = e.target.value; save(); });
  });
  view.querySelectorAll("[data-remove-item]").forEach(b => b.addEventListener("click", () => {
    s.items.splice(Number(b.dataset.removeItem), 1);
    save();
  }));
  view.querySelector("[data-add-item]")?.addEventListener("click", () => {
    // same season as the last one, with the next resort not already shown for it
    const season = s.items[s.items.length - 1]?.season || availableSeasons()[0];
    const used = new Set(s.items.filter(x => x.season === season).map(x => x.id));
    s.items.push({ id: resortIds().find(id => !used.has(id)) || resortIds()[0], season });
    save();
  });
}
function addItemButton(s, extraClass = "") {
  return s.items.length < MAX_ITEMS
    ? `<button type="button" class="button button-secondary ${extraClass}" data-add-item>+ Add resort</button>`
    : `<span class="muted small">Up to ${MAX_ITEMS} resorts.</span>`;
}

// ------------------------------------------------------------------ side-by-side mode

async function columnData(it, range) {
  const [start, end] = rangeIn(it.season, range);
  const months = range.kind === "months";
  const c = {
    id: it.id,
    unit: months ? "month" : "season",
    value: months ? start.slice(0, 7) : it.season,
    word: months ? (range.from === range.to ? "month" : "period") : "season",
  };
  const [recs, facts] = await Promise.all([recordsInRange(it.id, start, end), seasonFacts(it.id, it.season)]);
  return { c, start, end, recs, facts };
}

function sectionCell(key, d) {
  const { c, recs, facts, end } = d;
  const ok = recs.filter(x => x.r.ok);
  const word = c.word || UNIT_LABEL[c.unit].toLowerCase();
  const ongoing = todayIso() <= end;
  const ns = nightSkiing(c.id, d.start);
  if (key === "overview") {
    const dd = iso => esc(formatDay(iso));
    return `<dl class="cmp-dl">
      <dt>Recorded days</dt><dd>${recs.length}</dd>
      <dt>Opening day</dt><dd>${facts.open ? dd(facts.open) : facts.over ? NA : "not yet"}</dd>
      <dt>Closing day</dt><dd>${facts.close ? dd(facts.close) : facts.over ? NA : "not yet"}</dd>
      <dt>First snow</dt><dd>${facts.firstSnow ? dd(facts.firstSnow) : NA}</dd>
      <dt>Last snow</dt><dd>${facts.lastSnow ? dd(facts.lastSnow) : NA}</dd>
      <dt>Night skiing</dt><dd>${ns ? esc(nightDescription(ns)) : NA}</dd>
    </dl>`;
  }
  if (!ok.length) return `<p class="muted">No data in this ${word}.</p>`;
  const latest = ok[ok.length - 1].r;
  if (key === "lifts") {
    if (c.unit === "day") {
      return `<div class="cmp-big">${latest.lifts_open} <small>/ ${latest.lifts.length} open</small></div>
        <div class="muted small">${liftTypeTotalsHtml(latest.lifts, true)}</div>${liftsTable(latest.lifts, false, ns)}`;
    }
    const items = itemsOverPeriod(ok, "lifts", l => l.status === "open");
    const opened = items.filter(x => x.days.some(dd => dd.open)).length;
    return `<div class="cmp-big">${opened} <small>/ ${items.length} opened</small></div>
      <div class="muted small">${liftTypeTotalsHtml(items.map(x => x.item))}</div>
      <ul class="cmp-list">${items.map(({ item: l, days }) => {
        const st = periodStatus(days, c.unit, ongoing);
        return `<li><span>${esc(l.name_en)}${isNightLift(ns, l) ? nightIcon(ns, "Night skiing lift") : ""}</span><span class="badge s-${st.cls === "partial" ? "partial" : st.cls}">${esc(st.text)}</span></li>`;
      }).join("")}</ul>`;
  }
  if (key === "runs") {
    const withRuns = ok.filter(x => x.r.runs?.length);
    if (!withRuns.length) return `<p class="muted">Not published by the resort.</p>`;
    if (c.unit === "day") {
      return `<div class="cmp-big">${latest.runs_open} <small>/ ${latest.runs.length} open</small></div>
        <div>${runsHtml(latest)}</div>${runsTable(latest.runs, false, latest.lifts_open)}`;
    }
    const items = itemsOverPeriod(withRuns, "runs", r => r.status === "open" || r.status === "partial");
    const openedNames = new Set(items.filter(x => x.days.some(dd => dd.open)).map(x => x.item.name));
    const runs = items.map(x => x.item);
    return `<div class="cmp-big">${openedNames.size} <small>/ ${runs.length} opened</small></div>
      <div>${gradeCirclesHtml(runs, g => runs.filter(r => gradeOf(r.level) === g && openedNames.has(r.name)).length, `opened this ${word}`)}</div>
      <ul class="cmp-list">${items.map(({ item: x, days }) => {
        const st = periodStatus(days, c.unit, ongoing);
        return `<li><span>${esc(x.name_en)}</span><span class="badge s-${st.cls === "partial" ? "partial" : st.cls}">${esc(st.text)}</span></li>`;
      }).join("")}</ul>`;
  }
  if (key === "snow") {
    const depths = meanRecords(ok, c.unit).filter(x => x.r.snow_depth_cm != null).map(x => x.r.snow_depth_cm);
    const allDepths = ok.filter(x => x.r.snow_depth_cm != null).map(x => x.r.snow_depth_cm);
    const source = snowSource(recs);
    const amounts = recs.map(x => snowAmount(x.r, source)).filter(v => v != null);
    const snowDays = recs.filter(x => isSnowDay(x.r)).length;
    const m = mean(depths);
    return `<dl class="cmp-dl">
      <dt>${c.unit === "day" ? "Snow depth" : `Mean snow depth${c.unit === "season" ? ` (${meanMonthsLabel()})` : ""}`}</dt><dd>${m != null ? `${Math.round(m)} cm` : NA}</dd>
      <dt>Deepest</dt><dd>${allDepths.length ? `${Math.max(...allDepths)} cm` : NA}</dd>
      <dt>New snow, total</dt><dd>${amounts.length ? `${Math.round(amounts.reduce((a, b) => a + b, 0))} cm` : NA}</dd>
      <dt>Days it snowed</dt><dd>${snowDays} of ${recs.length} recorded</dd>
      <dt>Source</dt><dd class="muted small">${source === "resort" ? "resort's reports" : "weather model"}</dd>
    </dl>`;
  }
  // temperatures
  const rows = ["base", "summit"].map(level => {
    const info = state.index.resorts[c.id];
    const finals = meanRecords(recs, c.unit).filter(x => x.r.temps?.kind === "final" && x.r.temps[level]?.mean_c != null);
    const means = finals.map(x => x.r.temps[level].mean_c);
    const t = latest.temps?.[level];
    const elev = info.elevation_m?.[level] ? ` (${Number(info.elevation_m[level]).toLocaleString("en-GB")} m)` : "";
    if (c.unit === "day") {
      return `<dt>${level === "base" ? "Base" : "Summit"}${elev}</dt><dd>${t ? `${deg(t.min_c)} / ${deg(t.max_c)} °C${t.mean_c != null ? ` · mean ${deg(t.mean_c)}` : ""}` : NA}</dd>`;
    }
    return `<dt>${level === "base" ? "Base" : "Summit"}${elev}</dt><dd>${means.length
      ? `mean ${deg(mean(means))} °C <span class="muted small">(coldest day ${deg(Math.min(...means))}, warmest ${deg(Math.max(...means))})</span>` : NA}</dd>`;
  });
  return `<dl class="cmp-dl">${rows.join("")}</dl>`;
}

function columnHead(it, i, range) {
  const [start] = rangeIn(it.season, range);
  const href = range.kind === "months" ? `#/history/${esc(it.id)}/month/${start.slice(0, 7)}` : `#/history/${esc(it.id)}/season/${it.season}`;
  return `
    <div class="cmp-col-head" data-item="${i}">
      <div class="cmp-col-top">${lineKey({ color: seriesColor(i), dashed: i >= 8 })}${resortSelectHtml(it)}${removeButton(i)}</div>
      ${seasonSelectHtml(it)}
      <span class="muted small">${esc(rangeLabel(it.season, range))}</span>
      <a class="small" href="${href}">Open in Historical ›</a>
    </div>`;
}

async function sideModeHtml(s) {
  const items = s.items;
  if (!items.length) return `<p class="muted">Add a resort to start comparing.</p>${addItemButton(s, "cmp-add")}`;
  const data = await Promise.all(items.map(it => columnData(it, s.range)));
  const style = `style="--cols:${items.length}"`;
  return `
    <div class="cmp-side-scroll">
      <div class="cmp-grid cmp-heads" ${style}>${items.map((it, i) => columnHead(it, i, s.range)).join("")}</div>
      ${SECTIONS.map(key => `
        <details class="cmp-section" data-section="${key}"${s.side.open.includes(key) ? " open" : ""}>
          <summary>${SECTION_LABEL[key]}</summary>
          <div class="cmp-grid" ${style}>${data.map(d => `<div class="cmp-cell">${sectionCell(key, d)}</div>`).join("")}</div>
        </details>`).join("")}
    </div>
    ${addItemButton(s, "cmp-add")}`;
}

// ------------------------------------------------------------------ page

async function renderCompare() {
  compareGraph?.destroy();
  compareGraph = null;
  const s = compareState();
  saveCompare(s); // keep the first visit's starting resorts
  const head = `
    ${IS_DEMO ? `<div class="demo-banner">Demo mode: season 2025-26 is made-up data for testing.</div>` : ""}
    <h1 class="page-title">Compare</h1>
    <div class="seg cmp-mode" role="radiogroup" aria-label="Mode">
      <button type="button" role="radio" class="seg-btn${s.mode === "graph" ? " is-active" : ""}" aria-checked="${s.mode === "graph"}" data-mode="graph">Graph</button>
      <button type="button" role="radio" class="seg-btn${s.mode === "side" ? " is-active" : ""}" aria-checked="${s.mode === "side"}" data-mode="side">Side by side</button>
    </div>
    <p class="muted small cmp-sync-note">Both views show the same resorts and time range. Add more here, or with “+ Compare” on a resort's Historical page.</p>
    ${rangeControlsHtml(s)}`;
  if (s.mode === "graph") {
    view.innerHTML = head + graphModeHtml(s);
  } else {
    view.innerHTML = head + `<p class="muted small">Loading…</p>`;
    const body = await sideModeHtml(s);
    if (!location.hash.startsWith("#/compare")) return;
    view.innerHTML = head + body;
  }
  const save = () => { saveCompare(s); renderCompare(); };

  view.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { s.mode = b.dataset.mode; save(); }));
  wireCompareControls(s, save);

  if (s.mode === "graph") {
    view.querySelector('[data-g="metric"]').addEventListener("change", e => { s.graph.metric = e.target.value; save(); });
    view.querySelector('[data-g="pct"]').addEventListener("change", e => { s.graph.pct = e.target.checked; save(); });
    drawCompareGraph(s);
  } else {
    // one section opens/closes for every column; remember which are open
    view.querySelectorAll(".cmp-section").forEach(d => d.addEventListener("toggle", () => {
      const open = new Set(s.side.open);
      d.open ? open.add(d.dataset.section) : open.delete(d.dataset.section);
      s.side.open = [...open];
      saveCompare(s);
    }));
  }
}

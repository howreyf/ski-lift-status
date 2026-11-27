// Compare tab (#/compare).
//
// Graph mode: up to 10 lines on one graph, each a resort in a season ("Niseko 26-27",
//   "Niseko 25-26", "Kiroro 27-28" ...). Seasons are lined up by date (1 Dec of every season
//   sits at the same place), so different seasons can be compared. Choose the data point,
//   "As a percentage", and the time range (whole season, or from one month to another).
// Side-by-side mode: up to 5 columns, each a resort and its own period (season / month /
//   week / day, like the Historical pages). Sections (Overview, Lifts, Runs, Snow,
//   Temperatures) open and close for every column at once.
// Choices are kept in the visitor's browser. Loaded before app.js; uses history.js helpers.

"use strict";

const MAX_LINES = 10;
const MAX_COLUMNS = 5;
// Reference categorical palette (validated for colour-blind separation, light and dark).
// Lines 9 and 10 reuse the first two colours, dashed.
const SERIES_LIGHT = ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#008a17", "#6a4ce2", "#ec4647"];
const SERIES_DARK = ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#0aac23", "#9887ef", "#eb6263"];

const METRICS = {
  lifts: { label: "Lifts open", unit: "lifts", pctOf: "of all lifts" },
  runs: { label: "Runs open", unit: "runs", pctOf: "of all runs" },
  depth: { label: "Snow depth", unit: "cm", pctOf: "of that season's maximum" },
  snow: { label: "New snow", unit: "cm", pctOf: "of that season's snowiest day" },
  base: { label: "Base temperature (daily mean)", unit: "°C", pctOf: "of that season's range of daily means" },
  summit: { label: "Summit temperature (daily mean)", unit: "°C", pctOf: "of that season's range of daily means" },
};
const SECTIONS = ["overview", "lifts", "runs", "snow", "temps"];
const SECTION_LABEL = { overview: "Overview", lifts: "Lifts", runs: "Runs", snow: "Snow", temps: "Temperatures" };

let compareGraph = null;
let pendingHistoryCarry = null; // "Go to day" from the compare graph opens the day with lifts/runs expanded

// ------------------------------------------------------------------ saved choices

function compareState() {
  let s;
  try { s = JSON.parse(localStorage.getItem("compare")) || {}; } catch { s = {}; }
  const ids = resortIds();
  const latest = availableSeasons()[0];
  const valid = id => ids.includes(id);
  const firstIds = [...pins.list(), ...ids].filter((v, i, a) => a.indexOf(v) === i).slice(0, 2);
  s.mode = s.mode === "side" ? "side" : "graph";
  s.graph = s.graph || {};
  s.graph.metric = METRICS[s.graph.metric] ? s.graph.metric : "lifts";
  s.graph.pct = !!s.graph.pct;
  s.graph.range = s.graph.range || { kind: "season" };
  s.graph.lines = (s.graph.lines || []).filter(l => valid(l.id) && state.index.seasons[l.season]).slice(0, MAX_LINES);
  if (!s.graph.lines.length && latest) s.graph.lines = firstIds.map(id => ({ id, season: latest }));
  s.side = s.side || {};
  s.side.columns = (s.side.columns || []).filter(c => valid(c.id) && UNITS.includes(c.unit) && c.value).slice(0, MAX_COLUMNS);
  if (!s.side.columns.length && latest) s.side.columns = firstIds.map(id => ({ id, unit: "season", value: latest }));
  s.side.open = Array.isArray(s.side.open) ? s.side.open : ["overview", "lifts"];
  return s;
}
function saveCompare(s) {
  try { localStorage.setItem("compare", JSON.stringify(s)); } catch { /* ignore */ }
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
function seasonOptions(selected) {
  return availableSeasons().map(l => `<option value="${l}"${l === selected ? " selected" : ""}>${seasonShort(l)}${state.index.seasons[l].demo ? " (demo)" : ""}</option>`).join("");
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

async function seriesFor(line, metric, pct, i) {
  const [sStart, sEnd] = periodRange("season", line.season);
  const recs = await recordsInRange(line.id, sStart, sEnd);
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
    key: `${i}`, id: line.id, season: line.season,
    label: `${state.index.resorts[line.id].name} ${seasonShort(line.season)}`,
    short: `${shortName(line.id)} ${seasonShort(line.season)}`,
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
  const { metric, pct, range, lines } = s.graph;
  if (!lines.length) { host.innerHTML = `<p class="muted">Add a resort to start comparing.</p>`; return; }
  host.innerHTML = `<p class="muted small">Loading…</p>`;
  const series = await Promise.all(lines.map((l, i) => seriesFor(l, metric, pct, i)));
  if (!view.querySelector(".cmp-graph")) return; // navigated away
  const [start, end] = graphRange(range);
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
  const months = seasonMonths("2001-02").map(ym => Number(ym.slice(5)));
  const monthName = n => MONTH_NAMES[n - 1].replace(/^./, c => c.toUpperCase());
  const monthOpts = sel => months.map(n => `<option value="${n}"${Number(sel) === n ? " selected" : ""}>${monthName(n)}</option>`).join("");
  return `
    <div class="cmp-controls">
      <label class="cmp-field">Data point
        <select data-g="metric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}"${k === g.metric ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
      </label>
      <label class="cmp-check"><input type="checkbox" data-g="pct"${g.pct ? " checked" : ""}> As a percentage
        <span class="muted small">(${esc(METRICS[g.metric].pctOf)})</span></label>
      <div class="cmp-field">Time range
        <div class="cmp-range">
          <select data-g="range-kind">
            <option value="season"${g.range.kind === "season" ? " selected" : ""}>Whole season</option>
            <option value="months"${g.range.kind === "months" ? " selected" : ""}>From month to month</option>
          </select>
          ${g.range.kind === "months" ? `<select data-g="from" aria-label="From">${monthOpts(g.range.from || months[1])}</select>
            <span class="muted">to</span><select data-g="to" aria-label="To">${monthOpts(g.range.to || months[2])}</select>` : ""}
        </div>
      </div>
    </div>
    <div class="cmp-lines">
      ${g.lines.map((l, i) => `
        <div class="cmp-line" data-i="${i}">
          ${lineKey({ color: seriesColor(i), dashed: i >= 8 })}
          <select data-line="id" aria-label="Resort">${resortOptions(l.id)}</select>
          <select data-line="season" aria-label="Season">${seasonOptions(l.season)}</select>
          <button type="button" class="link-button" data-remove-line="${i}" aria-label="Remove">✕</button>
        </div>`).join("")}
      ${g.lines.length < MAX_LINES ? `<button type="button" class="button button-secondary" data-add-line>+ Add resort</button>` : `<span class="muted small">Up to ${MAX_LINES} lines.</span>`}
    </div>
    <div class="cmp-graph card"></div>`;
}

// ------------------------------------------------------------------ side-by-side mode

async function columnData(c) {
  const [start, end] = periodRange(c.unit, c.value);
  const [recs, facts] = await Promise.all([recordsInRange(c.id, start, end), seasonFacts(c.id, c.unit === "season" ? c.value : seasonOf(start))]);
  return { c, start, end, recs, facts };
}

function sectionCell(key, d) {
  const { c, recs, facts, end } = d;
  const ok = recs.filter(x => x.r.ok);
  const word = UNIT_LABEL[c.unit].toLowerCase();
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

function columnHead(c, i) {
  return `
    <div class="cmp-col-head" data-col="${i}">
      <div class="cmp-col-top">
        <select data-col-id aria-label="Resort">${resortOptions(c.id)}</select>
        <button type="button" class="link-button" data-remove-col="${i}" aria-label="Remove">✕</button>
      </div>
      <select data-col-unit aria-label="View by">${UNITS.map(u => `<option value="${u}"${u === c.unit ? " selected" : ""}>${UNIT_LABEL[u]}</option>`).join("")}</select>
      <div class="picker">
        <button type="button" class="pk-arrow" data-dir="-1" aria-label="Previous">‹</button>
        <button type="button" class="pk-field" aria-haspopup="dialog" aria-expanded="false"><span>${esc(periodLabel(c.unit, c.value))}</span></button>
        <button type="button" class="pk-arrow" data-dir="1" aria-label="Next">›</button>
        <div class="pk-pop" hidden role="dialog" aria-label="Choose a ${c.unit}">
          <input type="search" class="pk-search" placeholder="Search" autocomplete="off">
          <div class="pk-body"></div>
        </div>
      </div>
      <a class="small" href="#/history/${esc(c.id)}/${c.unit}/${c.value}">Open in Historical ›</a>
    </div>`;
}

async function sideModeHtml(s) {
  const cols = s.side.columns;
  if (!cols.length) return `<p class="muted">Add a resort to start comparing.</p>${addColumnButton(s)}`;
  const data = await Promise.all(cols.map(columnData));
  const style = `style="--cols:${cols.length}"`;
  return `
    <div class="cmp-side-scroll">
      <div class="cmp-grid cmp-heads" ${style}>${cols.map(columnHead).join("")}</div>
      ${SECTIONS.map(key => `
        <details class="cmp-section" data-section="${key}"${s.side.open.includes(key) ? " open" : ""}>
          <summary>${SECTION_LABEL[key]}</summary>
          <div class="cmp-grid" ${style}>${data.map(d => `<div class="cmp-cell">${sectionCell(key, d)}</div>`).join("")}</div>
        </details>`).join("")}
    </div>
    ${addColumnButton(s)}`;
}

function addColumnButton(s) {
  return s.side.columns.length < MAX_COLUMNS
    ? `<button type="button" class="button button-secondary cmp-add" data-add-col>+ Add resort</button>`
    : `<p class="muted small">Up to ${MAX_COLUMNS} resorts side by side.</p>`;
}

// ------------------------------------------------------------------ page

async function renderCompare() {
  compareGraph?.destroy();
  compareGraph = null;
  const s = compareState();
  const head = `
    ${IS_DEMO ? `<div class="demo-banner">Demo mode: season 2025-26 is made-up data for testing.</div>` : ""}
    <h1 class="page-title">Compare</h1>
    <div class="seg cmp-mode" role="radiogroup" aria-label="Mode">
      <button type="button" role="radio" class="seg-btn${s.mode === "graph" ? " is-active" : ""}" aria-checked="${s.mode === "graph"}" data-mode="graph">Graph</button>
      <button type="button" role="radio" class="seg-btn${s.mode === "side" ? " is-active" : ""}" aria-checked="${s.mode === "side"}" data-mode="side">Side by side</button>
    </div>`;
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

  if (s.mode === "graph") {
    const g = s.graph;
    view.querySelector('[data-g="metric"]').addEventListener("change", e => { g.metric = e.target.value; save(); });
    view.querySelector('[data-g="pct"]').addEventListener("change", e => { g.pct = e.target.checked; save(); });
    view.querySelector('[data-g="range-kind"]').addEventListener("change", e => {
      const months = seasonMonths("2001-02").map(ym => Number(ym.slice(5)));
      g.range = e.target.value === "months" ? { kind: "months", from: months[1], to: months[2] } : { kind: "season" };
      save();
    });
    view.querySelector('[data-g="from"]')?.addEventListener("change", e => { g.range.from = Number(e.target.value); save(); });
    view.querySelector('[data-g="to"]')?.addEventListener("change", e => { g.range.to = Number(e.target.value); save(); });
    view.querySelectorAll(".cmp-line").forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector('[data-line="id"]').addEventListener("change", e => { g.lines[i].id = e.target.value; save(); });
      row.querySelector('[data-line="season"]').addEventListener("change", e => { g.lines[i].season = e.target.value; save(); });
    });
    view.querySelectorAll("[data-remove-line]").forEach(b => b.addEventListener("click", () => { g.lines.splice(Number(b.dataset.removeLine), 1); save(); }));
    view.querySelector("[data-add-line]")?.addEventListener("click", () => {
      const last = g.lines[g.lines.length - 1];
      g.lines.push({ id: last?.id || resortIds()[0], season: availableSeasons().find(l => l !== last?.season) || availableSeasons()[0] });
      save();
    });
    drawCompareGraph(s);
  } else {
    const cols = s.side.columns;
    view.querySelectorAll(".cmp-col-head").forEach(headEl => {
      const i = Number(headEl.dataset.col);
      headEl.querySelector("[data-col-id]").addEventListener("change", e => { cols[i].id = e.target.value; save(); });
      headEl.querySelector("[data-col-unit]").addEventListener("change", e => {
        const [start, end] = periodRange(cols[i].unit, cols[i].value);
        const anchor = todayIso() >= start && todayIso() <= end ? todayIso() : start;
        cols[i].unit = e.target.value;
        cols[i].value = unitContaining(cols[i].unit, anchor);
        save();
      });
      setupPicker(headEl.querySelector(".picker"), cols[i].unit, cols[i].value, v => { cols[i].value = v; save(); });
    });
    view.querySelectorAll("[data-remove-col]").forEach(b => b.addEventListener("click", () => { cols.splice(Number(b.dataset.removeCol), 1); save(); }));
    view.querySelector("[data-add-col]")?.addEventListener("click", () => {
      const last = cols[cols.length - 1];
      cols.push(last ? { ...last } : { id: resortIds()[0], unit: "season", value: availableSeasons()[0] });
      save();
    });
    // one section opens/closes for every column; remember which are open
    view.querySelectorAll(".cmp-section").forEach(d => d.addEventListener("toggle", () => {
      const open = new Set(s.side.open);
      d.open ? open.add(d.dataset.section) : open.delete(d.dataset.section);
      s.side.open = [...open];
      saveCompare(s);
    }));
  }
}

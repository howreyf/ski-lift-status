// Historical tab.
//
//   #/history                         directory + search (shows season totals and averages)
//   #/history/<id>                    a resort's history (last period viewed, or the latest season)
//   #/history/<id>/<unit>/<value>     unit = season (2026-27) | month (2026-12) |
//                                     week (Sunday it starts, 2026-11-29) | day (2026-11-28)
//
// Add ?demo to the address (before the #) to fill in a made-up 2025-26 season for testing.
// Loaded before app.js; uses its helpers (state, esc, formatDay, ...).

"use strict";

const IS_DEMO = new URLSearchParams(location.search).has("demo");
const UNITS = ["season", "month", "week", "day"];
const UNIT_LABEL = { season: "Season", month: "Month", week: "Week", day: "Day" };
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const TYPE_ORDER = ["Ropeway", "Gondola", "Six", "Quad", "Triple", "Pair", "Single", "Magic carpet", "N/A"];

let historyUI = null; // {id, unit, value, expanded, liftsView: "graph"|"day", day, graph}

// A click anywhere outside an open period picker closes it.
document.addEventListener("click", () => {
  document.querySelectorAll(".pk-pop:not([hidden])").forEach(pop => {
    pop.hidden = true;
    pop.parentElement.querySelector(".pk-field")?.setAttribute("aria-expanded", "false");
  });
});

// ------------------------------------------------------------------ dates

function addDaysIso(iso, n) {
  return isoFromDayNumber(dayNumber(iso) + n);
}
function sundayOf(iso) {
  return addDaysIso(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
}
function todayIso() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function seasonLabel(startYear) {
  return `${startYear}-${pad2((startYear + 1) % 100)}`;
}
function seasonStartYear(label) {
  return Number(label.slice(0, 4));
}
function seasonMonthRange() {
  const m = state.index?.season_months || { start: 11, end: 4 };
  return [m.start, m.end];
}
/** "2026-27" -> ["2026-11", "2026-12", "2027-01", ...] (the season months) */
function seasonMonths(label) {
  const [startM, endM] = seasonMonthRange();
  const y = seasonStartYear(label);
  const out = [];
  let year = startM >= 7 ? y : y + 1, month = startM;
  for (let i = 0; i < 12; i++) {
    out.push(`${year}-${pad2(month)}`);
    if (month === endM) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}
function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
function inSeasonMonth(ym) {
  const [startM, endM] = seasonMonthRange();
  const m = Number(ym.slice(5, 7));
  return startM <= endM ? m >= startM && m <= endM : m >= startM || m <= endM;
}

function periodRange(unit, value) {
  if (unit === "season") {
    const months = seasonMonths(value);
    return [`${months[0]}-01`, monthEnd(months[months.length - 1])];
  }
  if (unit === "month") return [`${value}-01`, monthEnd(value)];
  if (unit === "week") return [value, addDaysIso(value, 6)];
  return [value, value];
}

function unitContaining(unit, iso) {
  if (unit === "season") return seasonOf(iso);
  if (unit === "month") return iso.slice(0, 7);
  if (unit === "week") return sundayOf(iso);
  return iso;
}

function periodLabel(unit, value) {
  if (unit === "season") return `Season ${value}`;
  if (unit === "month") {
    const [y, m] = value.split("-").map(Number);
    return `${MONTH_NAMES[m - 1][0].toUpperCase()}${MONTH_NAMES[m - 1].slice(1)} ${y}`;
  }
  const fmt = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
  if (unit === "week") {
    const end = addDaysIso(value, 6);
    return `Week ${fmt(value, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return fmt(value, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

/** One step back or forward. Months skip the off-season. */
function shiftPeriod(unit, value, dir) {
  if (unit === "season") return seasonLabel(seasonStartYear(value) + dir);
  if (unit === "week") return addDaysIso(value, 7 * dir);
  if (unit === "day") return addDaysIso(value, dir);
  let [y, m] = value.split("-").map(Number);
  for (let i = 0; i < 12; i++) {
    m += dir;
    if (m > 12) { m = 1; y += 1; }
    if (m < 1) { m = 12; y -= 1; }
    if (inSeasonMonth(`${y}-${pad2(m)}`)) break;
  }
  return `${y}-${pad2(m)}`;
}

function availableSeasons() {
  return Object.keys(state.index.seasons || {}).sort().reverse();
}
function datesWithData() {
  const set = new Set();
  for (const s of Object.values(state.index.seasons || {})) (s.dates || []).forEach(d => set.add(d));
  return set;
}

// ------------------------------------------------------------------ period search ("26-27", "2027", "dec 2026", "30/12/26")

function fullYear(s) {
  return s.length === 2 ? 2000 + Number(s) : Number(s);
}
function monthFromWord(w) {
  if (w.length < 3) return null;
  const i = MONTH_NAMES.findIndex(n => n.startsWith(w));
  return i >= 0 ? i + 1 : null;
}

/** What the text could mean: seasons, years, months or days (year may be missing). */
function parsePeriodQuery(q) {
  q = q.trim().toLowerCase().replace(/,/g, " ").replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/\s+/g, " ");
  if (!q) return [];
  const out = [];
  const day = (y, m, d) => { if (validDate(y ?? 2000, m, d)) out.push({ kind: "day", y, m, d }); };
  let m;
  if ((m = q.match(/^(?:season )?(\d{2}|\d{4}) ?[-/] ?(\d{2}|\d{4})$/))) {
    const a = fullYear(m[1]), b = fullYear(m[2]);
    if (b === a + 1) out.push({ kind: "season", start: a });
  }
  if ((m = q.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) day(+m[1], +m[2], +m[3]);
  if ((m = q.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const y = fullYear(m[3]);
    day(y, +m[2], +m[1]);                          // dd/mm/yy
    if (+m[1] !== +m[2]) day(y, +m[1], +m[2]);     // mm/dd/yy
  }
  if ((m = q.match(/^(\d{1,2})[-/.](\d{4})$/))) out.push({ kind: "month", y: +m[2], m: +m[1] });
  if ((m = q.match(/^(\d{4})[-/.](\d{1,2})$/)) && +m[2] <= 12) out.push({ kind: "month", y: +m[1], m: +m[2] });
  if ((m = q.match(/^(\d{4})$/))) out.push({ kind: "year", year: +m[1] });
  // words: "dec", "december 2026", "dec 30", "30 december 2026"
  const tokens = q.split(" ");
  const monthTok = tokens.map(monthFromWord).find(Boolean);
  if (monthTok && !out.length) {
    const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
    const year = nums.find(n => n >= 1000) ?? null;
    const d = nums.find(n => n >= 1 && n <= 31);
    if (d) day(year, monthTok, d);
    else out.push({ kind: "month", y: year, m: monthTok });
  }
  return out.filter(a => a.kind !== "month" || (a.m >= 1 && a.m <= 12));
}

/** The year a month falls in, for each season we have data for. */
function yearsForMonth(month) {
  const [startM] = seasonMonthRange();
  return availableSeasons().map(l => (month >= startM && startM >= 7 ? seasonStartYear(l) : seasonStartYear(l) + 1));
}

/** Turn parsed meanings into choices for the current unit: [{value, label}] */
function periodChoices(anchors, unit) {
  const out = new Map();
  const add = (value) => { if (!out.has(value)) out.set(value, periodLabel(unit, value)); };
  for (const a of anchors) {
    if (a.kind === "season") {
      const label = seasonLabel(a.start);
      if (unit === "season") add(label);
      else if (unit === "month") seasonMonths(label).forEach(add);
    } else if (a.kind === "year") {
      if (unit === "season") { add(seasonLabel(a.year - 1)); add(seasonLabel(a.year)); }
      else if (unit === "month") {
        for (let m = 1; m <= 12; m++) if (inSeasonMonth(`${a.year}-${pad2(m)}`)) add(`${a.year}-${pad2(m)}`);
      }
    } else if (a.kind === "month") {
      for (const y of a.y ? [a.y] : yearsForMonth(a.m)) {
        const ym = `${y}-${pad2(a.m)}`;
        if (unit === "season") add(seasonOf(`${ym}-15`));
        else if (unit === "month") add(ym);
        else if (unit === "week") {
          for (let w = sundayOf(`${ym}-01`); w <= monthEnd(ym); w = addDaysIso(w, 7)) add(w);
        }
      }
    } else if (a.kind === "day") {
      for (const y of a.y ? [a.y] : yearsForMonth(a.m)) {
        if (!validDate(y, a.m, a.d)) continue;
        add(unitContaining(unit, `${y}-${pad2(a.m)}-${pad2(a.d)}`));
      }
    }
  }
  return [...out].slice(0, 12).map(([value, label]) => ({ value, label }));
}

function periodHasData(unit, value) {
  const [s, e] = periodRange(unit, value);
  for (const d of datesWithData()) if (d >= s && d <= e) return true;
  return false;
}

// ------------------------------------------------------------------ period picker (dropdown calendar)

function pickerBody(unit, value) {
  const seasons = availableSeasons();
  const withData = datesWithData();
  if (!seasons.length) return `<p class="muted small">No seasons recorded yet.</p>`;
  if (unit === "season") {
    return `<div class="pk-chips">${seasons.map(l => `
      <button type="button" class="pk-chip${l === value ? " is-selected" : ""}" data-value="${l}">${l.slice(2)}</button>`).join("")}</div>`;
  }
  if (unit === "month") {
    return seasons.map(l => `
      <div class="pk-group"><div class="pk-group-title">Season ${l}</div>
        <div class="pk-chips">${seasonMonths(l).map(ym => `
          <button type="button" class="pk-chip${ym === value ? " is-selected" : ""}${periodHasData("month", ym) ? "" : " is-empty"}"
            data-value="${ym}">${periodLabel("month", ym).replace(/ (\d{4})$/, "<small> $1</small>")}</button>`).join("")}</div>
      </div>`).join("");
  }
  // week and day: calendar months, Sunday to Saturday
  const selectedWeek = unit === "week" ? value : null;
  return seasons.map(l => seasonMonths(l).map(ym => {
    const first = `${ym}-01`, last = monthEnd(ym);
    let rows = "";
    for (let w = sundayOf(first); w <= last; w = addDaysIso(w, 7)) {
      let cells = "";
      for (let i = 0; i < 7; i++) {
        const d = addDaysIso(w, i);
        if (d < first || d > last) { cells += `<span class="cal-day is-out"></span>`; continue; }
        const cls = ["cal-day", withData.has(d) ? "has-data" : "", unit === "day" && d === value ? "is-selected" : "",
          d === todayIso() ? "is-today" : ""].filter(Boolean).join(" ");
        cells += `<button type="button" class="${cls}" data-date="${d}" aria-label="${esc(periodLabel("day", d))}">${Number(d.slice(8))}</button>`;
      }
      rows += `<div class="cal-row${w === selectedWeek ? " is-selected" : ""}" data-week="${w}">${cells}</div>`;
    }
    return `<div class="cal-month"><div class="pk-group-title">${periodLabel("month", ym)}</div>
      <div class="cal-head">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span>${d}</span>`).join("")}</div>${rows}</div>`;
  }).join("")).join("");
}

function setupPicker(root, unit, value, onPick) {
  const field = root.querySelector(".pk-field");
  const pop = root.querySelector(".pk-pop");
  const search = root.querySelector(".pk-search");
  const body = root.querySelector(".pk-body");

  function renderBody() {
    const q = search.value;
    if (!q.trim()) {
      body.innerHTML = `<div class="pk-cal mode-${unit}">${pickerBody(unit, value)}</div>`;
    } else {
      const choices = periodChoices(parsePeriodQuery(q), unit);
      body.innerHTML = choices.length
        ? `<div class="pk-results">${choices.map(c => `
            <button type="button" class="pk-result" data-value="${c.value}">${esc(c.label)}${
              periodHasData(unit, c.value) ? "" : ` <span class="muted small">· no data</span>`}</button>`).join("")}</div>`
        : `<p class="muted small pk-hint">${unit === "day" || unit === "week"
            ? "Try a date such as 30 Dec, December 30 2026, 30/12/26 or 2026-12-30."
            : unit === "month" ? "Try a month such as Dec, December 2026, 12/2026 or a year such as 2027."
            : "Try a season such as 26-27 or 2026-27, or a year such as 2027."}</p>`;
    }
  }
  function open() {
    pop.hidden = false;
    field.setAttribute("aria-expanded", "true");
    search.value = "";
    renderBody();
    search.focus();
    body.querySelector(".is-selected")?.scrollIntoView({ block: "center" });
  }
  function close() {
    pop.hidden = true;
    field.setAttribute("aria-expanded", "false");
  }

  field.addEventListener("click", e => { e.stopPropagation(); pop.hidden ? open() : close(); });
  pop.addEventListener("click", e => {
    e.stopPropagation();
    const t = e.target.closest("[data-value], [data-date]");
    if (!t) return;
    const v = t.dataset.value || unitContaining(unit, t.dataset.date);
    close();
    onPick(v);
  });
  search.addEventListener("input", renderBody);
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { close(); field.focus(); }
    if (e.key === "Enter") {
      const first = body.querySelector(".pk-result");
      if (first) { close(); onPick(first.dataset.value); }
    }
  });
  root.querySelectorAll(".pk-arrow").forEach(b => b.addEventListener("click", () => onPick(shiftPeriod(unit, value, Number(b.dataset.dir)))));
}

// ------------------------------------------------------------------ data for a period

async function recordsInRange(id, start, end) {
  const labels = [...new Set([seasonOf(start), seasonOf(end)])];
  const out = [];
  for (const label of labels) {
    if (!state.index.seasons[label]) continue;
    try {
      const season = await loadSeason(label);
      for (const d of season.days) {
        if (d.date >= start && d.date <= end && d.results[id]) out.push({ date: d.date, r: { ...d.results[id], date: d.date } });
      }
    } catch { /* missing season file: no data */ }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function recordFor(id, date) {
  return (await recordsInRange(id, date, date))[0]?.r || null;
}

/** Opening day = first day any run was open; closing day = last day any run was open, set once
 *  the season is over (after the last season month, i.e. 31 May). Resorts that don't publish
 *  runs (Hakuba Valley) use lifts instead. Uses the daily (09:30) records. */
async function seasonFacts(id, label) {
  const [sStart, sEnd] = periodRange("season", label);
  const recs = await recordsInRange(id, sStart, sEnd);
  const hasRuns = recs.some(x => x.r.ok && x.r.runs?.length);
  const opened = recs.filter(x => x.r.ok && (hasRuns ? x.r.runs_open > 0 : x.r.lifts_open > 0)).map(x => x.date);
  const snowy = recs.filter(x => (x.r.temps?.kind === "final" && x.r.temps.snow_hours > 0) || x.r.new_snow_cm > 0).map(x => x.date);
  const over = todayIso() > sEnd;
  return {
    basis: hasRuns ? "runs were open" : "lifts were running",
    open: opened[0] || null,
    close: over ? opened[opened.length - 1] || null : null,
    seasonEnd: sEnd,
    firstSnow: snowy[0] || null,
    lastSnow: snowy[snowy.length - 1] || null,
    over,
  };
}

// ------------------------------------------------------------------ lifts by type

function liftTypeCounts(lifts) {
  const counts = new Map();
  for (const l of lifts) {
    const t = TYPE_ORDER.includes(l.lift_type) ? l.lift_type : "N/A";
    const c = counts.get(t) || { type: t, open: 0, total: 0 };
    c.total += 1;
    if (l.status === "open") c.open += 1;
    counts.set(t, c);
  }
  return TYPE_ORDER.map(t => counts.get(t)).filter(Boolean);
}

/** Icons with totals, e.g. [gondola] 2  [chair 4] 3 */
function liftTypeTotalsHtml(lifts, withOpen = false) {
  return `<span class="type-totals">${liftTypeCounts(lifts).map(c =>
    `<span class="type-total" title="${esc(TYPE_LABEL[c.type] || "Type not published")}: ${c.total}${withOpen ? ` (${c.open} open)` : ""}">${
      c.type === "N/A" ? `<span class="type-na">?</span>` : typeIcon(c.type, true)}<span>${withOpen ? `${c.open}/${c.total}` : c.total}</span></span>`).join("")}</span>`;
}

/** Grade circles with the TOTAL number of runs of each difficulty. */
function runGradeTotalsHtml(runs) {
  if (!runs?.length) return NA;
  return `<span class="grades">${runsByGrade(runs).map(c =>
    `<span class="grade grade-${c.grade.key}" title="${esc(c.grade.label)}: ${c.total} runs">${c.total}</span>`).join("")}</span>`;
}

// ------------------------------------------------------------------ Historical tab: directory and search

/** Season averages for the search: last season if we have it, otherwise this season so far. */
function lastSeasonSummary(id) {
  const latest = availableSeasons().filter(l => !state.index.seasons[l].demo || IS_DEMO)[0];
  if (!latest) return null;
  const prev = seasonLabel(seasonStartYear(latest) - 1);
  const p = state.index.seasons[prev]?.summary?.[id];
  if (p) return { label: prev, s: p, soFar: false };
  return { label: latest, s: state.index.seasons[latest]?.summary?.[id] || {}, soFar: true };
}

function historyCells(id, recentlyViewed = false) {
  const info = state.index.resorts[id];
  const r = todayResult(id);
  const lifts = r?.lifts || [];
  const ls = lastSeasonSummary(id);
  const note = ls ? `<span class="cell-note">${ls.soFar ? `${esc(ls.label)} so far` : `season ${esc(ls.label)}`}</span>` : "";
  return `
    <span class="cell cell-name">${recentlyViewed ? HISTORY_ICON : ""}${esc(info.name)}<span class="cell-note">${esc(info.region)}</span></span>
    <span class="cell" data-label="Total lifts">${lifts.length ? `<strong>${lifts.length}</strong> lifts` : NA}</span>
    <span class="cell" data-label="Total runs">${runGradeTotalsHtml(r?.runs)}</span>
    <span class="cell" data-label="Mean base temp">${ls?.s?.base_mean_c != null ? `${deg(ls.s.base_mean_c)} °C` : NA}${note}</span>
    <span class="cell" data-label="Mean snow depth">${ls?.s?.snow_depth_mean_cm != null ? `${ls.s.snow_depth_mean_cm} cm` : NA}${note}</span>`;
}

const HISTORY_SEARCH = { cells: historyCells, href: id => `#/history/${id}` };

function renderHistoryDirectory() {
  let html = `
    <h1 class="page-title">Historical</h1>
    <p class="muted small">Past seasons, months, weeks and days for each resort. The search shows season totals and averages.</p>
    ${searchHtml()}
    <div class="directory">`;
  for (const [region, ids] of regions()) {
    html += `
      <section class="directory-region">
        <h2>${esc(region)}</h2>
        <ul>${ids.map(id => `<li><a href="#/history/${esc(id)}">${esc(state.index.resorts[id].name)}</a></li>`).join("")}</ul>
      </section>`;
  }
  view.innerHTML = html + "</div>";
  setupSearch(view, HISTORY_SEARCH);
}

// ------------------------------------------------------------------ Historical resort page

function savedHistoryView(id) {
  try { return JSON.parse(localStorage.getItem(`history:${id}`)); } catch { return null; }
}
function saveHistoryView(id, unit, value) {
  try { localStorage.setItem(`history:${id}`, JSON.stringify({ unit, value })); } catch { /* ignore */ }
}

function goHistory(id, unit, value) {
  const hash = `#/history/${id}/${unit}/${value}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  renderHistoryPage(id, unit, value);
}

function factsHtml(f) {
  if (!f) return "";
  const d = iso => esc(formatDay(iso));
  const item = (label, html) => `<span class="fact"><span class="fact-label">${label}</span> ${html}</span>`;
  return `<div class="facts">
    ${item("Opening day", f.open ? `${d(f.open)} <span class="muted">(first day ${f.basis})</span>` : f.over ? NA : "not yet")}
    ${item("Closing day", f.close ? `${d(f.close)} <span class="muted">(last day ${f.basis})</span>`
      : f.over ? NA : `not yet <span class="muted">(set after ${d(f.seasonEnd)})</span>`)}
    ${item("First snow", f.firstSnow ? d(f.firstSnow) : NA)}
    ${item("Last snow", f.lastSnow ? `${d(f.lastSnow)}${f.over ? "" : ` <span class="muted">(so far)</span>`}` : NA)}
  </div>`;
}

/** Lifts box for a season / month / week: lifts that opened at least once, expandable to the graph. */
function periodLiftsBox(recs, ui) {
  const ok = recs.filter(x => x.r.ok);
  if (!ok.length) return box("lifts", "Lifts open", `<div class="box-value">${NA}</div><div class="box-note">No data in this period</div>`);
  const latest = ok[ok.length - 1].r;
  const total = latest.lifts.length;
  const opened = new Set(ok.flatMap(x => x.r.lifts.filter(l => l.status === "open").map(l => l.name)));
  const peak = ok.reduce((a, b) => (b.r.lifts_open > a.r.lifts_open ? b : a));
  const unitWord = UNIT_LABEL[ui.unit].toLowerCase();
  if (!ui.expanded) {
    return box("lifts", "Lifts open",
      `<div class="box-value">${opened.size} <small>/ ${total}</small></div>
       <div class="box-note">opened at least once this ${unitWord} · peak ${peak.r.lifts_open} on ${esc(formatDay(peak.date).slice(0, -5))}</div>
       <div class="box-note box-more">Show graph ›</div>`,
      pct(opened.size, total), "fill-green box-clickable").replace(`data-box="lifts"`, `data-box="lifts" role="button" tabindex="0" aria-expanded="false"`);
  }
  return `
    <div class="box box-expanded" data-box="lifts">
      <div class="box-body">
        <div class="expanded-head">
          <div>
            <div class="box-label">Lifts</div>
            <div class="box-value">Total lifts: ${total}</div>
            <div class="box-note">${liftTypeTotalsHtml(latest.lifts)} · ${opened.size} opened at least once this ${unitWord}</div>
          </div>
          <button type="button" class="link-button" data-collapse aria-label="Close the graph">Close ✕</button>
        </div>
        <div class="expanded-content"></div>
      </div>
    </div>`;
}

function liftsGraphDetails(p) {
  return `<div class="tip-value"><strong>${p.value}</strong> lift${p.value === 1 ? "" : "s"} open <span class="muted">of ${p.total}</span></div>
    <div class="tip-date">${esc(formatDay(p.date))}</div>
    <div class="tip-types">${liftTypeCounts(p.lifts).map(c => `
      <div class="tip-type">${c.type === "N/A" ? `<span class="type-na">?</span>` : typeIcon(c.type, true)}
        <span>${esc(TYPE_LABEL[c.type] || "Type not published")}</span><strong>${c.open}</strong><span class="muted">/ ${c.total}</span></div>`).join("")}</div>`;
}

async function mountLiftsExpanded(id, recs, facts) {
  const host = view.querySelector('[data-box="lifts"] .expanded-content');
  if (!host || !historyUI) return;
  historyUI.graph?.destroy();
  historyUI.graph = null;
  const [start, end] = periodRange(historyUI.unit, historyUI.value);

  if (historyUI.liftsView === "day") {
    const date = historyUI.day;
    const r = await recordFor(id, date);
    host.innerHTML = `
      <div class="dayview-head">
        <div class="dayview-nav">
          <button type="button" class="pk-arrow" data-day="-1" aria-label="Previous day">‹</button>
          <strong>${esc(formatDay(date))}</strong>
          <button type="button" class="pk-arrow" data-day="1" aria-label="Next day">›</button>
        </div>
        <button type="button" class="button button-secondary" data-return>Return to graph</button>
      </div>
      ${r?.ok ? liftsTable(r.lifts, true)
        : `<p class="muted">${r ? "Couldn't read the resort's page this day." : "No record for this day."}</p>`}`;
    host.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
      historyUI.day = addDaysIso(historyUI.day, Number(b.dataset.day));
      mountLiftsExpanded(id, recs, facts);
    }));
    host.querySelector("[data-return]").addEventListener("click", () => {
      historyUI.liftsView = "graph";
      mountLiftsExpanded(id, recs, facts);
    });
    return;
  }

  const ok = recs.filter(x => x.r.ok);
  const total = ok.length ? ok[ok.length - 1].r.lifts.length : 0;
  const markers = [];
  if (facts?.open) markers.push({ date: facts.open, label: "Opening day" });
  if (facts?.close) markers.push({ date: facts.close, label: "Closing day" });
  host.innerHTML = `<p class="muted small graph-caption">Lifts open each day, ${esc(periodLabel(historyUI.unit, historyUI.value))}.
    Hover or click the graph for a day's details.</p><div class="graph-host"></div>`;
  historyUI.graph = createGraph(host.querySelector(".graph-host"), {
    start, end,
    points: ok.map(x => ({ date: x.date, value: x.r.lifts_open, total: x.r.lifts.length, lifts: x.r.lifts })),
    yMax: total,
    yLabel: "Lifts open",
    markers,
    details: liftsGraphDetails,
    onGoToDay: date => {
      historyUI.liftsView = "day";
      historyUI.day = date;
      mountLiftsExpanded(id, recs, facts);
    },
  });
}

async function renderHistoryPage(id, unit, value) {
  const info = state.index.resorts[id];
  if (!info) {
    view.innerHTML = `<p class="error">There's no resort called “${esc(id)}”.</p><p><a href="#/history">See all resorts</a></p>`;
    return;
  }
  if (!UNITS.includes(unit) || !value) {
    const saved = savedHistoryView(id);
    if (saved && UNITS.includes(saved.unit)) ({ unit, value } = saved);
    else { unit = "season"; value = availableSeasons()[0] || seasonOf(todayIso()); }
    history.replaceState(null, "", `#/history/${id}/${unit}/${value}`);
  }
  recent.add(id);
  saveHistoryView(id, unit, value);
  const samePeriod = historyUI?.id === id && historyUI.unit === unit && historyUI.value === value;
  historyUI?.graph?.destroy();
  historyUI = {
    id, unit, value,
    expanded: historyUI?.id === id ? historyUI.expanded : false,
    liftsView: samePeriod ? historyUI.liftsView : "graph",
    day: samePeriod ? historyUI.day : null,
    graph: null,
  };
  currentPage = null;

  const [start, end] = periodRange(unit, value);
  const label = unit === "season" ? value : seasonOf(start);
  const [recs, facts] = await Promise.all([recordsInRange(id, start, end), seasonFacts(id, label)]);
  if (historyUI.id !== id || historyUI.value !== value) return; // navigated away while loading

  const last = recs[recs.length - 1];
  let content;
  if (unit === "day") {
    const r = last?.r;
    content = `
      ${!r ? `<p class="warn">No record for this day.</p>` : !r.ok ? `<p class="warn">Couldn't read the resort's page this day.</p>` : ""}
      <div class="boxes">${boxesHtml(id, r, value, false)}</div>
      ${r?.ok ? liftsTable(r.lifts) + runsTable(r.runs || []) : ""}`;
  } else {
    const rep = last?.r;
    content = `
      <div class="boxes">
        ${periodLiftsBox(recs, historyUI)}
        ${rep ? runsBox(id, rep) + snowDepthBox(id, rep, last.date, false) + newSnowBox(id, rep, last.date, false)
          + tempBox(id, "base", rep, last.date, false) + tempBox(id, "summit", rep, last.date, false) : ""}
      </div>
      ${rep ? `<p class="muted small">Boxes other than lifts show ${esc(formatDay(last.date))}, the last recorded day of this period. (Period views for them are coming.)</p>`
        : `<p class="muted">No data recorded in this period.</p>`}`;
  }

  view.innerHTML = `
    ${IS_DEMO ? `<div class="demo-banner">Demo mode: season 2025-26 is made-up data for testing. Remove <code>?demo</code> from the address to see only real data.</div>` : ""}
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/history">Historical</a> › <span>${esc(info.name)}</span></nav>
    <div class="resort-head">
      <div>
        <h1 class="page-title">${esc(info.name)} <span class="badge-historical">Historical</span></h1>
        <p class="resort-links small">
          ${info.website ? `<a href="${esc(info.website)}" target="_blank" rel="noopener">Official website ↗</a> · ` : ""}${esc(info.region)}
        </p>
      </div>
      <div class="head-buttons">
        <a class="button button-secondary" href="#/resort/${esc(id)}">Switch to present</a>
      </div>
    </div>

    <div class="period" aria-label="Choose a period">
      <div class="seg" role="radiogroup" aria-label="View by">
        ${UNITS.map(u => `<button type="button" role="radio" aria-checked="${u === unit}" class="seg-btn${u === unit ? " is-active" : ""}" data-unit="${u}">${UNIT_LABEL[u]}</button>`).join("")}
      </div>
      <div class="picker">
        <button type="button" class="pk-arrow" data-dir="-1" aria-label="Previous ${unit}">‹</button>
        <button type="button" class="pk-field" aria-haspopup="dialog" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2"/></svg>
          <span>${esc(periodLabel(unit, value))}</span>
        </button>
        <button type="button" class="pk-arrow" data-dir="1" aria-label="Next ${unit}">›</button>
        <div class="pk-pop" hidden role="dialog" aria-label="Choose a ${unit}">
          <input type="search" class="pk-search" placeholder="Search, e.g. ${unit === "season" ? "26-27 or 2027" : unit === "month" ? "Dec 2026" : "30/12/26"}" autocomplete="off">
          <div class="pk-body"></div>
        </div>
      </div>
    </div>

    ${factsHtml(facts)}
    ${content}`;

  // period controls
  view.querySelectorAll(".seg-btn").forEach(b => b.addEventListener("click", () => {
    const anchor = (last?.date && last.date >= start && last.date <= end) ? last.date : (todayIso() >= start && todayIso() <= end ? todayIso() : start);
    goHistory(id, b.dataset.unit, unitContaining(b.dataset.unit, anchor));
  }));
  setupPicker(view.querySelector(".picker"), unit, value, v => goHistory(id, unit, v));

  // expandable lifts box
  const liftsBox = view.querySelector('[data-box="lifts"]');
  if (unit !== "day" && liftsBox) {
    if (historyUI.expanded) {
      liftsBox.querySelector("[data-collapse]")?.addEventListener("click", () => {
        historyUI.expanded = false;
        renderHistoryPage(id, unit, value);
      });
      mountLiftsExpanded(id, recs, facts);
    } else if (liftsBox.classList.contains("box-clickable")) {
      const expand = () => { historyUI.expanded = true; historyUI.liftsView = "graph"; renderHistoryPage(id, unit, value); };
      liftsBox.addEventListener("click", expand);
      liftsBox.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(); } });
    }
  }
}

// ------------------------------------------------------------------ demo season (only with ?demo)

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Make up a 2025-26 season from each resort's real lift and run lists. Memory only. */
function injectDemoSeason() {
  const label = "2025-26", open = "2025-12-13", close = "2026-04-05";
  const start = "2025-12-01", end = "2026-04-12";
  const days = [];
  const summary = {};
  for (let d = start; d <= end; d = addDaysIso(d, 1)) days.push({ date: d, results: {} });
  for (const id of resortIds()) {
    const base = todayResult(id);
    if (!base?.lifts?.length) continue;
    const rnd = mulberry32(hashString(id));
    const liftRank = base.lifts.map(() => rnd());
    const runRank = (base.runs || []).map(() => rnd());
    const depths = [], baseMeans = [];
    let depth = 20;
    days.forEach((day, i) => {
      const t = dayNumber(day.date), t0 = dayNumber(open), t1 = dayNumber(close);
      let frac = 0;
      if (t >= t0 && t <= t1) {
        frac = Math.min(1, (t - t0 + 1) / 18) * Math.min(1, (t1 - t + 1) / 14);
        frac = Math.max(0.12, frac * (0.85 + 0.15 * rnd()));
        if (rnd() < 0.08) frac *= 0.5; // windy day
      }
      const snowing = rnd() < 0.45;
      const newSnow = snowing ? Math.round(rnd() * 30) : 0;
      depth = Math.max(0, depth + newSnow * 0.8 - (t > dayNumber("2026-02-20") ? 3 : 1) - rnd() * 2);
      const mean = -6 + 8 * Math.sin(((t - dayNumber("2026-01-25")) / 120) * Math.PI) + (rnd() - 0.5) * 6;
      const lifts = base.lifts.map((l, j) => ({ ...l, status: liftRank[j] < frac ? (rnd() < 0.04 ? "hold" : "open") : "closed" }));
      const runs = (base.runs || []).map((r, j) => ({ ...r, status: runRank[j] < frac ? "open" : "closed" }));
      const snowHours = snowing ? Math.round(1 + rnd() * 14) : 0;
      day.results[id] = {
        ok: true, demo: true,
        lifts_open: lifts.filter(l => l.status === "open").length,
        runs_open: runs.length ? runs.filter(r => r.status === "open").length : null,
        snow_depth_cm: Math.round(depth), new_snow_cm: newSnow,
        lifts, runs,
        temps: {
          kind: "final", snow_hours: snowHours, snowed: snowHours >= 3,
          summit: { elevation_m: state.index.resorts[id].elevation_m?.summit, min_c: +(mean - 9).toFixed(1), max_c: +(mean - 1).toFixed(1), mean_c: +(mean - 5).toFixed(1) },
          base: { elevation_m: state.index.resorts[id].elevation_m?.base, min_c: +(mean - 3).toFixed(1), max_c: +(mean + 5).toFixed(1), mean_c: +mean.toFixed(1) },
        },
      };
      depths.push(Math.round(depth));
      baseMeans.push(+mean.toFixed(1));
    });
    const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
    summary[id] = {
      lifts_total: base.lifts.length, runs_total: (base.runs || []).length || null,
      snow_depth_max_cm: Math.max(...depths), snow_depth_mean_cm: avg(depths), base_mean_c: avg(baseMeans),
      base_lowest_mean_c: Math.min(...baseMeans), base_highest_mean_c: Math.max(...baseMeans),
      summit_lowest_mean_c: +(Math.min(...baseMeans) - 5).toFixed(1), summit_highest_mean_c: +(Math.max(...baseMeans) - 5).toFixed(1),
      new_snow_min_cm: 0, new_snow_max_cm: 30, new_snow_mean_cm: 7, days_recorded: days.length,
    };
  }
  state.index.seasons[label] = { file: null, demo: true, dates: days.map(d => d.date), summary };
  state.index.seasons = Object.fromEntries(Object.entries(state.index.seasons).sort());
  state.seasons.set(label, Promise.resolve({ season: label, days }));
}

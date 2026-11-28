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
const TYPE_ORDER = ["Train", "Ropeway", "Gondola", "Eight", "Six", "Quad", "Triple", "Pair", "Single", "Chairlift",
  "Surface lift", "Magic carpet", "N/A"];

let historyUI = null; // {id, unit, value, expanded: box key | null, view: "graph"|"day", day, bucket, graph}

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
/** Today in the visitor's own time zone (resorts are in many; close enough for "is it over"). */
function todayIso() {
  return new Date().toLocaleDateString("en-CA");
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
/** First and last season month over all groups (e.g. Europe's glaciers start in October). */
function seasonMonthRange() {
  const groups = Object.values(state.index?.groups || {}).map(g => g.season_months).filter(Boolean);
  const all = groups.length ? groups : [state.index?.season_months || { start: 11, end: 4 }];
  const order = m => (m >= 7 ? m - 7 : m + 5); // July = 0 ... June = 11
  const start = all.map(m => m.start).sort((a, b) => order(a) - order(b))[0];
  const end = all.map(m => m.end).sort((a, b) => order(b) - order(a))[0];
  return [start, end];
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

// ------------------------------------------------------------------ lifts by type, runs by difficulty

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

/** Grade circles with a chosen count per difficulty (e.g. runs opened this month). */
function gradeCirclesHtml(runs, countFn, titleWord) {
  if (!runs?.length) return NA;
  return `<span class="grades">${runsByGrade(runs).map(c => {
    const n = countFn(c.grade);
    return `<span class="grade grade-${c.grade.key}" title="${esc(c.grade.label)}: ${n} of ${c.total} runs ${titleWord}">${n}</span>`;
  }).join("")}</span>`;
}

function gradeOf(level) {
  return GRADES.find(g => g.levels.includes(level)) || GRADES[GRADES.length - 1];
}

// ------------------------------------------------------------------ Historical tab: period table

const DIRECTORY_UNITS = ["season", "month"]; // the Historical tab itself: seasons and months only

/** The week or day's month (a week counts as the month most of its days are in). */
function monthOfPeriod(unit, value) {
  return (unit === "week" ? addDaysIso(value, 3) : value).slice(0, 7);
}

/** The period chosen at the top of the Historical tab: the most recent season or month the
 *  visitor chose anywhere in Historical (a week or day counts as its month). First visit:
 *  the latest season. */
function historyPeriod() {
  let p;
  try { p = JSON.parse(localStorage.getItem("historyPeriod")); } catch { p = null; }
  const known = p && ((p.unit === "season" && state.index.seasons[p.value]) ||
    (p.unit === "month" && /^\d{4}-\d{2}$/.test(p.value) && inSeasonMonth(p.value)));
  return known ? p : { unit: "season", value: availableSeasons()[0] || seasonOf(todayIso()) };
}
function rememberHistoryPeriod(unit, value) {
  if (unit === "week" || unit === "day") { value = monthOfPeriod(unit, value); unit = "month"; }
  try { localStorage.setItem("historyPeriod", JSON.stringify({ unit, value })); } catch { /* ignore */ }
}
function historyHref(id) {
  const p = historyPeriod();
  return `#/history/${id}/${p.unit}/${p.value}`;
}

/** Season / Month / Week / Day buttons. */
function segHtml(units, unit) {
  return `<div class="seg" role="radiogroup" aria-label="View by">
    ${units.map(u => `<button type="button" role="radio" aria-checked="${u === unit}" class="seg-btn${u === unit ? " is-active" : ""}" data-unit="${u}">${UNIT_LABEL[u]}</button>`).join("")}
  </div>`;
}

/** The period field with ‹ › arrows and its dropdown calendar (wired up by setupPicker). */
function pickerHtml(unit, value) {
  return `
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
    </div>`;
}

/** Switching unit keeps roughly the same time: a month's season, or for a season: this
 *  month if it's in it, otherwise its last month with data, otherwise its first month. */
function switchUnit(unit, value, toUnit) {
  const [start, end] = periodRange(unit, value);
  if (toUnit === "season") return seasonOf(start);
  const today = todayIso();
  const dates = [...datesWithData()].filter(d => d >= start && d <= end).sort();
  const anchor = today >= start && today <= end ? today : dates[dates.length - 1] || start;
  return unitContaining(toUnit, anchor);
}

/** One resort over a period: the day with the most lifts / runs open, and mean base
 *  temperature and snow depth (season means use Dec-Apr like the resort pages, or every
 *  recorded day while the season has no Dec-Apr days yet). */
async function periodStatsFor(id, unit, value) {
  const [start, end] = periodRange(unit, value);
  const recs = await recordsInRange(id, start, end);
  const ok = recs.filter(x => x.r.ok);
  const most = (list, key) => list.reduce((best, x) => (best && best.r[key] >= x.r[key] ? best : x), null);
  const forMean = list => { const m = meanRecords(list, unit); return m.length ? m : list; };
  const temps = forMean(recs.filter(x => x.r.temps?.kind === "final" && x.r.temps.base?.mean_c != null)).map(x => x.r.temps.base.mean_c);
  const depths = forMean(ok.filter(x => x.r.snow_depth_cm != null)).map(x => x.r.snow_depth_cm);
  const source = snowSource(recs);
  const amounts = recs.map(x => snowAmount(x.r, source)).filter(v => v != null);
  return {
    recs,
    days: recs.length,
    facts: unit === "season" ? await seasonFacts(id, value) : null,
    snowTotal: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0)) : null,
    snowSource: source,
    lifts: most(ok, "lifts_open"),
    runs: most(ok.filter(x => x.r.runs?.length), "runs_open"),
    base: mean(temps),
    depth: mean(depths),
  };
}

const historyDir = { unit: null, value: null, stats: {} };
let historyDirToken = 0;

function historyCells(id, recentlyViewed = false) {
  const info = state.index.resorts[id];
  const s = historyDir.stats[id] || {};
  const on = (x, n) => n ? `<span class="cell-note">on ${esc(shortDay(x.date))}</span>` : "";
  const start = historyDir.unit ? periodRange(historyDir.unit, historyDir.value)[0] : latestDateOf(id);
  return `
    <span class="cell cell-name">${recentlyViewed ? HISTORY_ICON : ""}${esc(info.name)}${nightIcon(nightSkiing(id, start))}<span class="cell-note">${esc(placeOf(id))}</span>${sortNoteHtml(id)}</span>
    <span class="cell" data-label="Peak lifts open">${s.lifts
      ? `<strong>${s.lifts.r.lifts_open}</strong> / ${s.lifts.r.lifts.length}${on(s.lifts, s.lifts.r.lifts_open)}` : NA}</span>
    <span class="cell" data-label="Peak runs open">${s.runs
      ? `${runsHtml({ ok: true, runs: s.runs.r.runs })}${on(s.runs, s.runs.r.runs_open)}` : NA}</span>
    <span class="cell" data-label="Mean base temp">${s.base != null ? `${deg(s.base)} °C` : NA}</span>
    <span class="cell" data-label="Mean snow depth">${s.depth != null ? `${Math.round(s.depth)} cm` : NA}</span>`;
}

const HISTORY_SEARCH = { cells: historyCells, href: historyHref };

const HISTORY_TABLE_HEAD = `
  <div class="table-head" aria-hidden="true">
    <span>Resort</span><span>Peak lifts open</span><span>Peak runs open</span><span>Mean base temp</span><span>Mean snow depth</span><span></span>
  </div>`;

function historyRow(id) {
  const pinned = pins.has(id);
  const name = state.index.resorts[id].name;
  return `
    <div class="resort-row">
      <a class="resort-link" href="${esc(historyHref(id))}">${historyCells(id)}</a>
      <button class="pin${pinned ? " is-pinned" : ""}" type="button" data-pin="${esc(id)}"
        aria-pressed="${pinned}" title="${pinned ? "Unpin" : "Pin"} ${esc(name)}"
        aria-label="${pinned ? "Unpin" : "Pin"} ${esc(name)}">${pinIcon(pinned)}</button>
    </div>`;
}

/** The resort(s) with the best value: `better(a, b)` is true when a beats b. Ties are kept. */
function leaders(valueOf, better) {
  let best = null, ids = [];
  for (const id of resortIds()) {
    const v = valueOf(id);
    if (v == null) continue;
    if (best == null || better(v, best)) { best = v; ids = [id]; } else if (v === best) ids.push(id);
  }
  return best == null ? null : { value: best, ids };
}

/** "Niseko", "Niseko and Kiroro" or "Niseko and 3 others" (all names in the tooltip). */
function leaderNames(ids) {
  const names = ids.map(id => state.index.resorts[id].name);
  if (names.length <= 2) return `<strong>${names.map(esc).join("</strong> and <strong>")}</strong>`;
  return `<strong title="${esc(names.join(", "))}">${esc(names[0])}</strong> and ${names.length - 1} others`;
}

/** One highlight box; clicking it opens the (first) leading resort at this period. */
function highlightBox(label, lead, valueHtml, note, emptyValue, emptyNote) {
  const body = lead
    ? `<div class="box-value">${valueHtml}</div><div class="box-note">${leaderNames(lead.ids)}${note ? ` · ${note}` : ""}</div>`
    : `<div class="box-value hl-empty">${emptyValue}</div><div class="box-note">${emptyNote}</div>`;
  const inner = `<div class="box-body"><div class="box-label">${label}</div>${body}</div>`;
  return lead
    ? `<a class="box box-clickable hl-box" href="${esc(historyHref(lead.ids[0]))}">${inner}</a>`
    : `<div class="box hl-box">${inner}</div>`;
}

/** Highlights across all resorts for the chosen season or month. */
function highlightBoxes(unit, value) {
  const st = id => historyDir.stats[id] || {};
  const day = iso => esc(shortDay(iso));
  const onDay = (lead, x) => lead && lead.ids.length === 1 ? `peak on ${day(x(lead.ids[0]).date)}` : "";
  const mostRuns = leaders(id => st(id).runs?.r.runs_open || null, (a, b) => a > b);
  const mostRunsBox = highlightBox("Peak runs open", mostRuns,
    mostRuns && `${mostRuns.value} <small>runs</small>`, onDay(mostRuns, id => st(id).runs),
    NA, "No runs open yet");

  if (unit === "season") {
    const earliestOpen = leaders(id => st(id).facts?.open, (a, b) => a < b);
    const earliestSnow = leaders(id => st(id).facts?.firstSnow, (a, b) => a < b);
    const latestClose = leaders(id => st(id).facts?.close, (a, b) => a > b);
    const over = Object.values(historyDir.stats).some(s => s.facts?.over);
    // the first day of records: an "earliest" on that day may really have been earlier
    const [sStart, sEnd] = periodRange("season", value);
    const firstRecord = [...datesWithData()].filter(d => d >= sStart && d <= sEnd).sort()[0];
    const orEarlier = (lead, what) => lead?.value === firstRecord
      ? `first day recorded, so it may have ${what} earlier` : null;
    return [
      highlightBox("Earliest opening", earliestOpen, earliestOpen && day(earliestOpen.value),
        orEarlier(earliestOpen, "opened") || "first day runs were open", "Not yet", "No resort has opened yet"),
      highlightBox("Earliest snow", earliestSnow, earliestSnow && day(earliestSnow.value),
        orEarlier(earliestSnow, "snowed") || "first day it snowed", "Not yet", "No snow recorded yet"),
      highlightBox("Latest closing", latestClose, latestClose && day(latestClose.value),
        "last day runs were open", over ? NA : "Season on",
        over ? "No closing days recorded" : `Known once the season ends (${esc(shortDay(periodRange("season", value)[1]))})`),
      mostRunsBox,
    ].join("");
  }
  const mostSnow = leaders(id => st(id).snowTotal || null, (a, b) => a > b);
  const mostLifts = leaders(id => st(id).lifts?.r.lifts_open || null, (a, b) => a > b);
  return [
    highlightBox("Most new snow", mostSnow, mostSnow && `${mostSnow.value} <small>cm</small>`,
      "total this month", "0 cm", "No new snow recorded"),
    highlightBox("Peak lifts open", mostLifts, mostLifts && `${mostLifts.value} <small>lifts</small>`,
      onDay(mostLifts, id => st(id).lifts), NA, "No lifts open"),
    mostRunsBox,
  ].join("");
}

async function renderHistoryDirectory() {
  const { unit, value } = historyPeriod();
  const token = ++historyDirToken;
  const ids = [...resortIds(), ...areaIds()]; // resorts (for the highlights) and areas (table rows)
  const stats = await Promise.all(ids.map(id => periodStatsFor(id, unit, value)));
  if (token !== historyDirToken || !/^#\/history\/?$/.test(location.hash)) return; // changed again, or navigated away
  Object.assign(historyDir, { unit, value, stats: Object.fromEntries(ids.map((id, i) => [id, stats[i]])) });

  const anyData = stats.some(s => s.days);
  let html = `
    <h1 class="page-title">Historical</h1>
    <div class="period" aria-label="Choose a period">${segHtml(DIRECTORY_UNITS, unit)}${pickerHtml(unit, value)}</div>
    <p class="muted small">Every resort over this ${unitWord(unit)}. Pick a resort for its full history, down to single weeks and days.</p>
    ${anyData ? `<div class="hl-boxes">${highlightBoxes(unit, value)}</div>` : ""}
    ${searchRowHtml(true)}
    ${anyData ? "" : `<p class="warn">Nothing was recorded in ${esc(periodLabel(unit, value))}.</p>`}
    <div class="resort-table">
      ${HISTORY_TABLE_HEAD}`;
  html += resortGroupsHtml(historyRow, historySortValue, true);
  html += `</div>
    <p class="muted small legend">Peak lifts / runs open: the most open on any one day of the ${unitWord(unit)} (that day underneath).
      ${gradeLegendHtml(shownIds(), "Runs by grade:")}
      Means: base temperature (from the daily means) and snow depth${unit === "season" ? `, over ${meanMonthsLabel()} (every recorded day until the season reaches ${meanMonthsLabel().slice(0, 3)})` : ""}.</p>`;
  view.innerHTML = html;

  const pick = (u, v) => { rememberHistoryPeriod(u, v); renderHistoryDirectory(); };
  view.querySelectorAll(".seg-btn[data-unit]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.unit !== unit) pick(b.dataset.unit, switchUnit(unit, value, b.dataset.unit));
  }));
  setupPicker(view.querySelector(".picker"), unit, value, v => pick(unit, v));
  setupSearch(view, HISTORY_SEARCH);
  setupSort(view, renderHistoryDirectory);
  view.querySelectorAll("button[data-pin]").forEach(btn => btn.addEventListener("click", () => {
    if (pins.toggle(btn.dataset.pin)) renderHistoryDirectory();
  }));
  rememberCountryToggles(view);
}

// ------------------------------------------------------------------ period statistics

function savedHistoryView(id) {
  try { return JSON.parse(localStorage.getItem(`history:${id}`)); } catch { return null; }
}
function saveHistoryView(id, unit, value) {
  try { localStorage.setItem(`history:${id}`, JSON.stringify({ unit, value })); } catch { /* ignore */ }
}

/** Navigate to a period; `carry` keeps an open box / "go to day" view across the change. */
function goHistory(id, unit, value, carry = null) {
  const hash = `#/history/${id}/${unit}/${value}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  renderHistoryPage(id, unit, value, carry);
}

function shortDay(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
}

function isSnowDay(r) {
  return (r.temps?.kind === "final" && r.temps.snow_hours > 0) || r.new_snow_cm > 0;
}

/** Season means leave out the first and last season month (November and May). */
function meanRecords(recs, unit) {
  if (unit !== "season") return recs;
  const [startM, endM] = seasonMonthRange();
  return recs.filter(x => {
    const m = Number(x.date.slice(5, 7));
    return m !== startM && m !== endM;
  });
}
function meanMonthsLabel() {
  const [startM, endM] = seasonMonthRange();
  const name = m => MONTH_NAMES[(m + 11) % 12].slice(0, 3).replace(/^./, c => c.toUpperCase());
  return `${name(startM + 1)}–${name(endM - 1)}`;
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Where a resort's new snow amounts come from: its own reports if it publishes them. */
function snowSource(recs) {
  return recs.some(x => x.r.ok && x.r.new_snow_cm != null) ? "resort" : "model";
}
function snowAmount(r, source) {
  if (source === "resort") return r.ok ? r.new_snow_cm ?? null : null;
  return r.temps?.kind === "final" ? r.temps.snowfall_cm ?? null : null;
}

/** Status of a lift or run over a period: "28 Nov – present", "Opened on 5 Dec", ... */
function periodStatus(days, unit, ongoing = false, latest = state.latestDate) {
  const open = days.filter(d => d.open);
  if (!days.length) return { cls: "unknown", text: NA };
  if (!open.length) {
    if (unit === "season") return { cls: "closed", text: ongoing ? "Closed up till now" : "Closed all season" };
    return { cls: "closed", text: ongoing ? "Closed (so far)" : "Closed" };
  }
  const firstRec = days[0].date, lastRec = days[days.length - 1].date;
  const first = open[0].date, last = open[open.length - 1].date;
  const present = last === lastRec && lastRec === latest; // `latest`: the resort's latest record
  const end = present ? "present" : shortDay(last);
  if (unit === "season") return { cls: present ? "open" : "partial", text: `${shortDay(first)} – ${end}` };
  // open at the start and the end of the period (gaps in between ignored) = open the whole period
  if (first === firstRec && last === lastRec) return { cls: "open", text: present ? "Open (so far)" : "Open" };
  if (first > firstRec && last === lastRec) return { cls: "partial", text: `Opened on ${shortDay(first)}${present ? " – present" : ""}` };
  if (first === firstRec && last < lastRec) return { cls: "partial", text: `Open until ${shortDay(last)}` };
  return { cls: "partial", text: `Open ${shortDay(first)} – ${end}` };
}

/** Each lift or run over the period: latest details + the day-by-day open flag. */
function itemsOverPeriod(recs, field, isOpen) {
  const ok = recs.filter(x => x.r.ok && x.r[field]?.length);
  const latest = new Map();
  const days = new Map();
  for (const x of ok) {
    for (const item of x.r[field]) {
      latest.set(item.name, item);
      if (!days.has(item.name)) days.set(item.name, []);
      days.get(item.name).push({ date: x.date, open: isOpen(item) });
    }
  }
  return [...latest.values()].map(item => ({ item, days: days.get(item.name) }));
}

// ------------------------------------------------------------------ boxes for a season / month / week

function unitWord(unit) {
  return UNIT_LABEL[unit].toLowerCase();
}

/** A box that expands to a graph when clicked. */
function expandableBox(key, label, inner, fill, extraClass, ui) {
  return box(key, label, `${inner}<div class="box-note box-more">${ui.unit === "day" ? "Show the day ›" : "Show graph ›"}</div>`, fill,
    `${extraClass} box-clickable`).replace(`data-box="${key}"`, `data-box="${key}" role="button" tabindex="0" aria-expanded="false"`);
}

function expandedBox(key, label, headHtml) {
  return `
    <div class="box box-expanded" data-box="${key}">
      <div class="box-body">
        <div class="expanded-head">
          <div><div class="box-label">${label}</div>${headHtml}</div>
          <button type="button" class="link-button" data-collapse aria-label="Close">Close ✕</button>
        </div>
        <div class="expanded-content"></div>
      </div>
    </div>`;
}

function periodBoxes(id, recs, ui) {
  const ok = recs.filter(x => x.r.ok);
  const latest = ok[ok.length - 1]?.r;
  const word = unitWord(ui.unit);
  const out = [];

  // lifts
  if (!latest) out.push(box("lifts", "Lifts open", `<div class="box-value">${NA}</div><div class="box-note">No data in this period</div>`));
  else {
    const total = latest.lifts.length;
    const opened = new Set(ok.flatMap(x => x.r.lifts.filter(l => l.status === "open").map(l => l.name)));
    const peak = ok.reduce((a, b) => (b.r.lifts_open > a.r.lifts_open ? b : a));
    out.push(ui.expanded === "lifts"
      ? expandedBox("lifts", "Lifts", `<div class="box-value">Total lifts: ${total}</div>
          <div class="box-note">${liftTypeTotalsHtml(latest.lifts)} · ${opened.size} opened at least once this ${word}</div>`)
      : expandableBox("lifts", "Lifts open", `<div class="box-value">${opened.size} <small>/ ${total}</small></div>
          <div class="box-note">opened at least once this ${word} · peak ${peak.r.lifts_open} on ${esc(shortDay(peak.date))}</div>`,
        pct(opened.size, total), "fill-green", ui));
  }

  // runs
  const withRuns = ok.filter(x => x.r.runs?.length);
  if (!withRuns.length) out.push(box("runs", "Runs open", `<div class="box-value">${NA}</div><div class="box-note">Not published by the resort</div>`));
  else {
    const runs = withRuns[withRuns.length - 1].r.runs;
    const openedNames = new Set(withRuns.flatMap(x => x.r.runs.filter(r => r.status === "open" || r.status === "partial").map(r => r.name)));
    const openedByGrade = g => runs.filter(r => gradeOf(r.level) === g && openedNames.has(r.name)).length;
    out.push(ui.expanded === "runs"
      ? expandedBox("runs", "Runs", `<div class="box-value">Total runs: ${runs.length}</div>
          <div class="box-note">${runGradeTotalsHtml(runs)} · ${openedNames.size} opened at least once this ${word}</div>`)
      : expandableBox("runs", "Runs open", `<div class="box-value">${openedNames.size} <small>/ ${runs.length}</small></div>
          <div class="box-grades">${gradeCirclesHtml(runs, openedByGrade, `opened this ${word}`)}</div>
          <div class="box-note">opened at least once this ${word}</div>`,
        pct(openedNames.size, runs.length), "fill-green", ui));
  }

  // snow depth
  const depthRecs = meanRecords(ok, ui.unit).filter(x => x.r.snow_depth_cm != null);
  const depthMean = mean(depthRecs.map(x => x.r.snow_depth_cm));
  const depthAll = ok.filter(x => x.r.snow_depth_cm != null);
  const depthNote = ui.unit === "season" ? `mean, ${meanMonthsLabel()}` : `mean this ${word}`;
  out.push(!depthAll.length ? box("depth", "Snow depth", `<div class="box-value">${NA}</div><div class="box-note">Not published by the resort</div>`)
    : ui.expanded === "depth"
      ? expandedBox("depth", "Snow depth", `<div class="box-value">${depthMean != null ? `${Math.round(depthMean)} cm` : NA}</div><div class="box-note">${depthNote}</div>`)
      : expandableBox("depth", "Snow depth", `<div class="box-value">${depthMean != null ? `${Math.round(depthMean)} <small>cm</small>` : NA}</div>
          <div class="box-note">${depthNote} · max ${Math.max(...depthAll.map(x => x.r.snow_depth_cm))} cm</div>`, null, "", ui));

  // new snow: days it snowed
  const snowDays = ok.filter(x => isSnowDay(x.r)).map(x => x.date);
  const [pStart, pEnd] = periodRange(ui.unit, ui.value);
  let denom, denomText;
  if (ui.unit === "season") {
    denom = snowDays.length ? dayNumber(snowDays[snowDays.length - 1]) - dayNumber(snowDays[0]) + 1 : 0;
    denomText = "days from first to last snow";
  } else {
    const until = todayIso() < pEnd ? todayIso() : pEnd;
    denom = Math.max(0, dayNumber(until) - dayNumber(pStart) + 1);
    denomText = until < pEnd ? `days of this ${word} so far` : `days this ${word}`;
  }
  const snowInner = `<div class="box-value">${snowDays.length} <small>/ ${denom} days</small></div>
    <div class="box-note">snowed on ${denom ? Math.round((snowDays.length / denom) * 100) : 0}% of ${denomText}</div>`;
  out.push(ui.expanded === "snow"
    ? expandedBox("snow", "New snow", snowInner)
    : expandableBox("snow", "New snow", snowInner, null, "", ui));

  // temperatures
  for (const level of ["base", "summit"]) {
    const info = state.index.resorts[id];
    const elevation = info.elevation_m?.[level];
    const title = `${level === "summit" ? "Summit" : "Base"} at ${elevation ? `${Number(elevation).toLocaleString("en-GB")} m` : NA}`;
    const finals = meanRecords(recs, ui.unit).filter(x => x.r.temps?.kind === "final" && x.r.temps[level]?.mean_c != null);
    const m = mean(finals.map(x => x.r.temps[level].mean_c));
    const note = `mean of daily means${ui.unit === "season" ? `, ${meanMonthsLabel()}` : ` this ${word}`}`;
    const inner = `<div class="box-value">${m != null ? `${deg(m)} <small>°C</small>` : NA}</div>
      <div class="box-note">${m != null ? note : "no finished days yet"}</div>`;
    out.push(ui.expanded === level ? expandedBox(level, title, inner) : expandableBox(level, title, inner, null, "", ui));
  }
  return out.join("");
}

/** Day view: the usual boxes; lifts and runs open their "go to day" view when clicked. */
function dayBoxes(id, r, date, ui) {
  if (ui.expanded === "lifts" && r?.ok) {
    return expandedBox("lifts", "Lifts", `<div class="box-value">${r.lifts_open} <small>/ ${r.lifts.length} open</small></div>
      <div class="box-note">${liftTypeTotalsHtml(r.lifts, true)}</div>`)
      + runsBox(id, r) + snowDepthBox(id, r, date, false) + newSnowBox(id, r, date, false)
      + tempBox(id, "base", r, date, false) + tempBox(id, "summit", r, date, false);
  }
  if (ui.expanded === "runs" && r?.ok && r.runs?.length) {
    return liftsBox(id, r) + expandedBox("runs", "Runs", `<div class="box-value">${r.runs_open} <small>/ ${r.runs.length} open</small></div>
      <div class="box-note">${runGradeTotalsHtml(r.runs)}</div>`)
      + snowDepthBox(id, r, date, false) + newSnowBox(id, r, date, false)
      + tempBox(id, "base", r, date, false) + tempBox(id, "summit", r, date, false);
  }
  const clickable = (html, key) => html.replace(`data-box="${key}"`, `data-box="${key}" role="button" tabindex="0" aria-expanded="false"`)
    .replace(`class="box `, `class="box box-clickable `);
  let liftsHtml = liftsBox(id, r, r?.ok ? "View this day's lifts ›" : ""),
    runsHtml = runsBox(id, r, r?.ok && r.runs?.length ? "View this day's runs ›" : "");
  if (r?.ok) liftsHtml = clickable(liftsHtml, "lifts");
  if (r?.ok && r.runs?.length) runsHtml = clickable(runsHtml, "runs");
  return liftsHtml + runsHtml + snowDepthBox(id, r, date, false) + newSnowBox(id, r, date, false)
    + tempBox(id, "base", r, date, false) + tempBox(id, "summit", r, date, false);
}

// ------------------------------------------------------------------ expanded box contents (graphs and "go to day")

function liftsGraphDetails(p) {
  return `<div class="tip-value"><strong>${p.value}</strong> lift${p.value === 1 ? "" : "s"} open <span class="muted">of ${p.total}</span></div>
    <div class="tip-date">${esc(formatDay(p.date))}</div>
    <div class="tip-types">${liftTypeCounts(p.lifts).map(c => `
      <div class="tip-type">${c.type === "N/A" ? `<span class="type-na">?</span>` : typeIcon(c.type, true)}
        <span>${esc(TYPE_LABEL[c.type] || "Type not published")}</span><strong>${c.open}</strong><span class="muted">/ ${c.total}</span></div>`).join("")}</div>`;
}

function runsGraphDetails(p) {
  return `<div class="tip-value"><strong>${p.value}</strong> run${p.value === 1 ? "" : "s"} open <span class="muted">of ${p.runs.length}</span></div>
    <div class="tip-date">${esc(formatDay(p.date))}</div>
    <div class="tip-types">${runsByGrade(p.runs).map(c => `
      <div class="tip-type"><span class="grade grade-${c.grade.key} grade-dot"></span>
        <span>${esc(c.grade.label)}</span><strong>${c.open}</strong><span class="muted">/ ${c.total}</span></div>`).join("")}</div>`;
}

/** Group daily snow amounts into bars of a day, a week (Sun–Sat) or a month. */
function snowBars(recs, source, bucket, start, end) {
  const groups = new Map();
  for (const x of recs) {
    const amount = snowAmount(x.r, source);
    if (amount == null) continue;
    const key = bucket === "day" ? x.date : bucket === "week" ? sundayOf(x.date) : x.date.slice(0, 7);
    const g = groups.get(key) || { value: 0, days: 0, snowDays: 0 };
    g.value += amount;
    g.days += 1;
    if (isSnowDay(x.r)) g.snowDays += 1;
    groups.set(key, g);
  }
  return [...groups].map(([key, g]) => {
    let s = key, e = key;
    if (bucket === "week") e = addDaysIso(key, 6);
    if (bucket === "month") { s = `${key}-01`; e = monthEnd(key); }
    if (s < start) s = start;
    if (e > end) e = end;
    return { date: s, end: e, value: Math.round(g.value * 10) / 10, days: g.days, snowDays: g.snowDays, bucket };
  });
}

function snowBarDetails(p) {
  const label = p.bucket === "day" ? formatDay(p.date)
    : p.bucket === "week" ? `${shortDay(p.date)} – ${formatDay(p.end)}`
    : periodLabel("month", p.date.slice(0, 7));
  return `<div class="tip-value"><strong>${p.value}</strong> cm new snow</div>
    <div class="tip-date">${esc(label)}</div>
    ${p.bucket !== "day" ? `<div class="muted">snowed on ${p.snowDays} of ${p.days} recorded day${p.days === 1 ? "" : "s"}</div>` : ""}`;
}

const SNOW_BUCKETS = { season: ["day", "week", "month"], month: ["day", "week"], week: ["day"] };
const DEFAULT_BUCKET = { season: "week", month: "week", week: "day" };

/** "Go to day" for lifts or runs, with ‹ date › that moves the page's period when needed. */
async function mountDayView(id, key, host, ui, opts) {
  const date = ui.day;
  const r = await recordFor(id, date);
  const [sStart, sEnd] = periodRange("season", seasonOf(date));
  const table = !r ? `<p class="muted">No record for this day.</p>`
    : !r.ok ? `<p class="muted">Couldn't read the resort's page this day.</p>`
    : key === "lifts" ? liftsTable(r.lifts, true, nightSkiing(id, date)) : runsTable(r.runs || [], true, r.lifts_open);
  host.innerHTML = `
    <div class="dayview-head">
      <div class="dayview-nav">
        <button type="button" class="pk-arrow" data-day="-1" aria-label="Previous day"${date <= sStart ? " disabled" : ""}>‹</button>
        <strong>${esc(formatDay(date))}</strong>
        <button type="button" class="pk-arrow" data-day="1" aria-label="Next day"${date >= sEnd ? " disabled" : ""}>›</button>
      </div>
      ${opts.returnToGraph ? `<button type="button" class="button button-secondary" data-return>Return to graph</button>` : ""}
    </div>
    ${table}`;
  host.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    const next = addDaysIso(ui.day, Number(b.dataset.day));
    if (next < sStart || next > sEnd) return; // capped at the season
    const [pStart, pEnd] = periodRange(ui.unit, ui.value);
    if (next < pStart || next > pEnd) {
      // crossed into another month / week / day: move the page's period selector too
      goHistory(id, ui.unit, unitContaining(ui.unit, next), { expanded: key, view: "day", day: next });
    } else {
      ui.day = next;
      mountDayView(id, key, host, ui, opts);
    }
  }));
  host.querySelector("[data-return]")?.addEventListener("click", () => {
    ui.view = "graph";
    mountExpanded(id, opts.recs, opts.facts);
  });
}

function mountExpanded(id, recs, facts) {
  const ui = historyUI;
  const key = ui?.expanded;
  const host = key && view.querySelector(`[data-box="${key}"] .expanded-content`);
  if (!host) return;
  ui.graph?.destroy();
  ui.graph = null;

  if (ui.unit === "day") return mountDayView(id, key, host, ui, { returnToGraph: false });
  if ((key === "lifts" || key === "runs") && ui.view === "day") {
    return mountDayView(id, key, host, ui, { returnToGraph: true, recs, facts });
  }

  const [start, end] = periodRange(ui.unit, ui.value);
  const ok = recs.filter(x => x.r.ok);
  const markers = [];
  if (facts?.open) markers.push({ date: facts.open, label: "Opening day" });
  if (facts?.close) markers.push({ date: facts.close, label: "Closing day" });
  const period = esc(periodLabel(ui.unit, ui.value));
  const goToDay = k => date => { ui.view = "day"; ui.day = date; ui.expanded = k; mountExpanded(id, recs, facts); };
  let caption, graph, below = "";

  if (key === "lifts") {
    caption = `Lifts open each day, ${period}.`;
    graph = { points: ok.map(x => ({ date: x.date, value: x.r.lifts_open, total: x.r.lifts.length, lifts: x.r.lifts })),
      yMax: ok.length ? ok[ok.length - 1].r.lifts.length : 0, yLabel: "Lifts open per day", integer: true, details: liftsGraphDetails, onGoToDay: goToDay("lifts") };
  } else if (key === "runs") {
    const withRuns = ok.filter(x => x.r.runs?.length);
    caption = `Runs open each day, ${period}.`;
    graph = { points: withRuns.map(x => ({ date: x.date, value: x.r.runs_open, runs: x.r.runs })),
      yMax: withRuns.length ? withRuns[withRuns.length - 1].r.runs.length : 0, yLabel: "Runs open per day", integer: true, details: runsGraphDetails, onGoToDay: goToDay("runs") };
  } else if (key === "depth") {
    caption = `Snow depth each day, ${period}.`;
    graph = { points: ok.filter(x => x.r.snow_depth_cm != null).map(x => ({ date: x.date, value: x.r.snow_depth_cm })),
      yLabel: "Snow depth per day, cm",
      details: p => `<div class="tip-value"><strong>${p.value}</strong> cm</div><div class="tip-date">${esc(formatDay(p.date))}</div>` };
  } else if (key === "snow") {
    const source = snowSource(recs);
    const buckets = SNOW_BUCKETS[ui.unit];
    const bucket = buckets.includes(ui.bucket?.[ui.unit]) ? ui.bucket[ui.unit] : DEFAULT_BUCKET[ui.unit];
    const word = { day: "day", week: "week", month: "month" }[bucket];
    caption = `New snow per ${word}, ${period} (${source === "resort" ? "as reported by the resort" : "weather-model snowfall at the summit"}).`;
    graph = { kind: "bars", points: snowBars(recs, source, bucket, start, end), yLabel: `New snow per ${word}, cm`, details: snowBarDetails };
    if (buckets.length > 1) {
      below = `<div class="bucket-toggle" role="radiogroup" aria-label="One bar per">
        <span class="muted small">One bar per</span>
        ${buckets.map(b => `<button type="button" role="radio" aria-checked="${b === bucket}" class="seg-btn${b === bucket ? " is-active" : ""}" data-bucket="${b}">${b[0].toUpperCase() + b.slice(1)}</button>`).join("")}
      </div>`;
    }
  } else {
    const level = key;
    const finals = recs.filter(x => x.r.temps?.kind === "final" && x.r.temps[level]?.mean_c != null);
    caption = `Mean ${level} temperature each day, ${period}.`;
    graph = { points: finals.map(x => ({ date: x.date, value: x.r.temps[level].mean_c, t: x.r.temps[level] })),
      yLabel: `Mean ${level} temperature per day, °C`,
      details: p => `<div class="tip-value"><strong>${deg(p.value)}</strong> °C mean</div><div class="tip-date">${esc(formatDay(p.date))}</div>
        <div class="muted">min ${deg(p.t.min_c)} · max ${deg(p.t.max_c)} °C</div>` };
  }

  host.innerHTML = `<p class="muted small graph-caption">${caption} Hover or click the graph for details.</p><div class="graph-host"></div>${below}`;
  ui.graph = createGraph(host.querySelector(".graph-host"), { start, end, markers, ...graph });
  host.querySelectorAll("[data-bucket]").forEach(b => b.addEventListener("click", () => {
    ui.bucket = { ...(ui.bucket || {}), [ui.unit]: b.dataset.bucket };
    mountExpanded(id, recs, facts);
  }));
}

// ------------------------------------------------------------------ lists below the boxes

function periodListsHtml(recs, unit, ongoing = false, ns = null, latest = state.latestDate) {
  const ok = recs.filter(x => x.r.ok);
  if (!ok.length) return "";
  const word = unitWord(unit);
  const lifts = itemsOverPeriod(ok, "lifts", l => l.status === "open");
  const runs = itemsOverPeriod(ok, "runs", r => r.status === "open" || r.status === "partial");
  const liftsOpened = lifts.filter(x => x.days.some(d => d.open)).length;
  const runsOpened = runs.filter(x => x.days.some(d => d.open)).length;
  const badge = s => `<span class="badge s-${s.cls === "partial" ? "partial" : s.cls}">${esc(s.text)}</span>`;

  let html = `
    <details class="detail-table">
      <summary><span class="summary-title">Lifts <span class="muted">· ${liftsOpened} of ${lifts.length} opened this ${word}</span></span>
        ${liftTypeTotalsHtml(lifts.map(x => x.item))}</summary>
      <table>
        <thead><tr><th>Lift</th><th>Status this ${word}</th><th>Operating hours</th><th>Type</th></tr></thead>
        <tbody>${lifts.map(({ item: l, days }) => `
          <tr>
            <td>${esc(l.name_en)}${isNightLift(ns, l) ? nightIcon(ns, "Night skiing lift") : ""}${l.name !== l.name_en ? `<span class="cell-note" lang="ja">${esc(l.name)}</span>` : ""}</td>
            <td>${badge(periodStatus(days, unit, ongoing, latest))}</td>
            <td class="num">${esc(l.hours)}</td>
            <td>${typeIcon(l.lift_type)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
  if (!runs.length) return html + `<p class="muted small">Runs: ${NA} (the resort doesn't publish run status).</p>`;
  html += `
    <details class="detail-table">
      <summary><span class="summary-title">Runs <span class="muted">· ${runsOpened} of ${runs.length} opened this ${word}</span></span>
        ${runGradeTotalsHtml(runs.map(x => x.item))}</summary>
      <table>
        <thead><tr><th>Run</th><th>Status this ${word}</th><th>Difficulty</th></tr></thead>
        <tbody>${runs.map(({ item: x, days }) => `
          <tr>
            <td>${esc(x.name_en)}${x.name !== x.name_en ? `<span class="cell-note" lang="ja">${esc(x.name)}</span>` : ""}</td>
            <td>${badge(periodStatus(days, unit, ongoing, latest))}</td>
            <td>${difficultyHtml(x.level)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
  return html;
}

// ------------------------------------------------------------------ Historical resort page

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

async function renderHistoryPage(id, unit, value, carry = null) {
  if (!carry && typeof pendingHistoryCarry !== "undefined" && pendingHistoryCarry) {
    carry = pendingHistoryCarry; // e.g. "Go to day" from the Compare graph
    pendingHistoryCarry = null;
  }
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
  rememberHistoryPeriod(unit, value);
  const prev = historyUI?.id === id ? historyUI : null;
  historyUI?.graph?.destroy();
  let expanded = carry?.expanded ?? prev?.expanded ?? null;
  if (unit === "day" && !["lifts", "runs"].includes(expanded)) expanded = null;
  historyUI = {
    id, unit, value, expanded,
    view: carry?.view ?? (unit === "day" ? "day" : "graph"),
    day: carry?.day ?? (unit === "day" ? value : null),
    bucket: prev?.bucket || {},
    graph: null,
  };
  if (unit === "day") historyUI.day = value;
  currentPage = null;

  const [start, end] = periodRange(unit, value);
  const label = unit === "season" ? value : seasonOf(start);
  const [recs, facts] = await Promise.all([recordsInRange(id, start, end), seasonFacts(id, label)]);
  // An area (connected resorts): each resort's peak lifts / runs in the period, for its list.
  const areaMemberStats = info.area ? Object.fromEntries(await Promise.all(
    membersOf(id).map(async m => [m, await periodStatsFor(m, unit, value)]))) : {};
  if (historyUI.id !== id || historyUI.value !== value || historyUI.unit !== unit) return; // navigated away

  let content;
  if (unit === "day") {
    const r = recs[0]?.r;
    content = `
      ${!r ? `<p class="warn">No record for this day.</p>` : !r.ok ? `<p class="warn">Couldn't read the resort's page this day.</p>` : ""}
      <div class="boxes">${dayBoxes(id, r, value, historyUI)}</div>
      ${r?.ok ? liftsTable(r.lifts, false, nightSkiing(id, value)) + runsTable(r.runs || [], false, r.lifts_open) : ""}`;
  } else {
    content = `
      <div class="boxes">${periodBoxes(id, recs, historyUI)}</div>
      ${recs.length ? periodListsHtml(recs, unit, todayIso() <= end, nightSkiing(id, start), latestDateOf(id)) : `<p class="muted">No data recorded in this period.</p>`}`;
  }

  view.innerHTML = `
    ${IS_DEMO ? `<div class="demo-banner">Demo mode: season 2025-26 is made-up data for testing. Remove <code>?demo</code> from the address to see only real data.</div>` : ""}
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/history">Historical</a> › <span>${esc(info.name)}</span></nav>
    <div class="resort-head">
      <div>
        <h1 class="page-title">${esc(info.name)}${nightIcon(nightSkiing(id, start))} <span class="badge-historical">Historical</span></h1>
        <p class="resort-links small">
          ${info.website ? `<a href="${esc(info.website)}" target="_blank" rel="noopener">Official website ↗</a> · ` : ""}${esc(placeOf(id))}${
            areaOfResort(id) ? ` · part of <a href="${esc(`#/history/${areaOfResort(id)}/${unit}/${value}`)}">${esc(state.index.resorts[areaOfResort(id)].name)}</a>` : ""}
        </p>
        ${info.area ? `<p class="muted small">${membersOf(id).length} connected resorts: lifts and runs are totals; snow and temperatures are averages.</p>` : ""}
      </div>
      <div class="head-buttons">
        ${info.area
          ? `<button type="button" class="button" data-compare-area
              title="Open Compare's graph with every resort of ${esc(info.name)} (${esc(compareItemLabel(unit, value))})">Compare all ${membersOf(id).length}</button>`
          : `<button type="button" class="button button-secondary" data-compare
              title="Add ${esc(info.name)} (${esc(compareItemLabel(unit, value))}) to Compare">+ Compare</button>`}
        <a class="button button-secondary" href="#/resort/${esc(id)}">Switch to present</a>
      </div>
    </div>

    <div class="period" aria-label="Choose a period">${segHtml(UNITS, unit)}${pickerHtml(unit, value)}</div>

    ${factsHtml(facts)}
    ${info.area ? areaMembersHtml(id, m => {
      const st = areaMemberStats[m];
      return st?.lifts ? `Peak lifts <strong>${st.lifts.r.lifts_open}</strong> / ${st.lifts.r.lifts.length} · Peak runs ${st.runs ? runsHtml({ ok: true, runs: st.runs.r.runs }) : NA}` : "No data in this period";
    }, m => `#/history/${m}/${unit}/${value}`) : ""}
    ${content}`;

  // period controls
  const last = recs[recs.length - 1];
  view.querySelectorAll(".seg-btn[data-unit]").forEach(b => b.addEventListener("click", () => {
    const anchor = last?.date || (todayIso() >= start && todayIso() <= end ? todayIso() : start);
    goHistory(id, b.dataset.unit, unitContaining(b.dataset.unit, anchor));
  }));
  setupPicker(view.querySelector(".picker"), unit, value, v => goHistory(id, unit, v));
  view.querySelector("[data-compare]")?.addEventListener("click", e =>
    addToCompareWithAnimation(id, unit, value, view.querySelector(".page-title"), e.currentTarget));
  if (info.area) setupAreaButtons(id, { unit, value });

  // boxes: expand / collapse
  view.querySelectorAll(".box-clickable[data-box]").forEach(el => {
    const key = el.dataset.box;
    const expand = () => {
      historyUI.expanded = key;
      historyUI.view = unit === "day" ? "day" : "graph";
      historyUI.day = unit === "day" ? value : historyUI.day;
      renderHistoryPage(id, unit, value, { expanded: key, view: historyUI.view, day: historyUI.day });
    };
    el.addEventListener("click", expand);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(); } });
  });
  view.querySelector("[data-collapse]")?.addEventListener("click", () => {
    historyUI.expanded = null;
    renderHistoryPage(id, unit, value, { expanded: null });
  });
  if (historyUI.expanded) mountExpanded(id, recs, facts);
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
          kind: "final", snow_hours: snowHours, snowed: snowHours >= 3, snowfall_cm: newSnow,
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

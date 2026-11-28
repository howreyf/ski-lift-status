// Ski Status — single-page site with tabs (Home, Resorts) and one page per resort.
//
// Pages (the part of the address after #):
//   #/                 Home: find-resort search, pinned resorts, resort table by region
//   #/resorts          Resorts: search + directory of all resorts by region
//   #/resort/<id>      One resort: boxes (lifts, runs, snow, temperatures), lifts and runs, trail map
//   #/resort/<id>/<date>  The same resort on a past day (historical record)
//
// Data: data/lifts.json (index) + data/seasons/<season>.json (daily records).
// Live temperatures come straight from Open-Meteo in the visitor's browser.
// Pins and recently viewed resorts are saved in the visitor's browser (localStorage).

"use strict";

const NA = "N/A";
const MAX_PINS = 5;
const MAX_SUGGESTIONS = 3;
const MAX_RECENT = 10;
const LIVE_REFRESH_MS = 15 * 60 * 1000; // Open-Meteo updates "current" values every 15 minutes
const STATUS_REFRESH_MS = 5 * 60 * 1000; // re-check data/live.json (the scraper updates it every 45 minutes)

const STATUS_LABEL = { open: "Open", hold: "On hold", closed: "Closed", unknown: "Unknown" };
const RUN_STATUS_LABEL = { open: "Open", partial: "Partly open", closed: "Closed", unknown: "Unknown" };

// Run grades for Japanese resorts: green / red / black, orange for expert.
// Runs labelled with two levels (e.g. "Intermediate/Advanced") count under the harder one.
const GRADES = [
  { key: "green", label: "Green (beginner)", levels: ["First timer", "Beginner"] },
  { key: "red", label: "Red (intermediate)", levels: ["Intermediate", "Beginner/Intermediate"] },
  { key: "black", label: "Black (advanced)", levels: ["Advanced", "Intermediate/Advanced"] },
  { key: "orange", label: "Orange (expert)", levels: ["Expert"] },
  { key: "other", label: "Level not published", levels: [] },
];

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

const state = {
  index: null,        // data/lifts.json
  latestDate: null,   // newest date with data
  latestDay: null,    // that day's record: {date, results: {id: {...}}}
  liveStatus: null,   // data/live.json: latest lift/run status {date, updated, results}
  live: {},           // {id: {summit: {temp, time}, base: {temp, time}}}
  seasons: new Map(), // season label -> Promise of season file
};

// ------------------------------------------------------------------ small helpers

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function num(value, unit = "") {
  return value === null || value === undefined ? NA : `${value}${unit}`;
}

/** Temperatures always with one decimal: 1 -> "1.0". */
function deg(v) {
  return Number(v).toFixed(1);
}

function formatJst(iso) {
  if (!iso) return NA;
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time} JST`;
}

function formatDay(day) {
  const d = new Date(`${day}T12:00:00+09:00`);
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function seasonOf(day) {
  const year = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 7 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

// ------------------------------------------------------------------ saved in the browser

function readList(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode: ignore */ }
}

const pins = {
  list: () => readList("pinnedResorts").filter(id => state.index?.resorts[id]),
  has: id => pins.list().includes(id),
  toggle(id) {
    const list = pins.list();
    if (list.includes(id)) {
      writeList("pinnedResorts", list.filter(x => x !== id));
      return true;
    }
    if (list.length >= MAX_PINS) {
      toast(`You can pin up to ${MAX_PINS} resorts. Unpin one first.`);
      return false;
    }
    writeList("pinnedResorts", [...list, id]);
    return true;
  },
};

const recent = {
  list: () => readList("recentResorts").filter(id => state.index?.resorts[id]),
  add(id) {
    writeList("recentResorts", [id, ...recent.list().filter(x => x !== id)].slice(0, MAX_RECENT));
  },
};

// ------------------------------------------------------------------ data

function loadSeason(label) {
  if (!state.seasons.has(label)) {
    const file = state.index.seasons[label]?.file;
    const p = fetch(`data/${file}`, { cache: "no-cache" }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${file}`);
      return r.json();
    });
    p.catch(() => state.seasons.delete(label));
    state.seasons.set(label, p);
  }
  return state.seasons.get(label);
}

function resortIds() {
  return Object.keys(state.index.resorts);
}

/** Resorts grouped by region, in the order of the data file. */
function regions() {
  const map = new Map();
  for (const id of resortIds()) {
    const region = state.index.resorts[id].region;
    if (!map.has(region)) map.set(region, []);
    map.get(region).push(id);
  }
  return map;
}

function todayResult(id) {
  return state.latestDay?.results?.[id];
}

/** Latest lift/run status for a resort from live.json (if it's from today or newer). */
function liveStatusFor(id) {
  const ls = state.liveStatus;
  if (!ls || (state.latestDate && ls.date < state.latestDate)) return null;
  const e = ls.results?.[id];
  return e?.ok ? e : null;
}

/** The latest picture of a resort: lift and run status from live.json (every 45 min),
 *  snow and weather from the day's permanent record (once a day). */
function currentResult(id) {
  const base = todayResult(id);
  const live = liveStatusFor(id);
  if (!live) return base;
  return {
    ...(base || {}),
    ok: true,
    lifts: live.lifts, runs: live.runs, lifts_open: live.lifts_open, runs_open: live.runs_open,
    snow_depth_cm: base?.ok ? base.snow_depth_cm : null,
    new_snow_cm: base?.ok ? base.new_snow_cm : null,
    liveStatus: true,
  };
}

/** "Lift & run status: last change 14:30 JST" */
function statusTimeHtml() {
  const ls = state.liveStatus;
  if (!ls?.updated) return "";
  const time = new Date(ls.updated).toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const day = ls.date !== new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }) ? ` ${formatDay(ls.date)}` : "";
  return `Lift &amp; run status: last change <strong>${esc(time)} JST${esc(day)}</strong> (checked every 45 min, 09:08–21:08)`;
}

function seasonSummary(id) {
  return state.index.seasons[seasonOf(state.latestDate)]?.summary?.[id] || {};
}

// ------------------------------------------------------------------ live temperatures (Open-Meteo)

async function fetchLive() {
  const points = [];
  for (const id of resortIds()) {
    const info = state.index.resorts[id];
    if (!info.location || !info.elevation_m) continue;
    for (const level of ["summit", "base"]) points.push({ id, level, info });
  }
  if (!points.length) return;
  const params = new URLSearchParams({
    latitude: points.map(p => p.info.location.lat).join(","),
    longitude: points.map(p => p.info.location.lon).join(","),
    elevation: points.map(p => p.info.elevation_m[p.level]).join(","),
    current: "temperature_2m,snowfall,weather_code",
    timezone: "Asia/Tokyo",
  });
  try {
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let data = await resp.json();
    if (!Array.isArray(data)) data = [data];
    const live = {};
    points.forEach((p, i) => {
      const cur = data[i]?.current;
      if (cur && cur.temperature_2m !== null && cur.temperature_2m !== undefined) {
        (live[p.id] ||= {})[p.level] = { temp: cur.temperature_2m + 0, snowfall: cur.snowfall ?? 0, code: cur.weather_code, time: cur.time };
      }
    });
    state.live = live;
  } catch (err) {
    console.warn("Live temperatures unavailable:", err.message); // fall back to the forecast range
  }
  // Update temperature cells in place (re-rendering would interrupt typing in the search box).
  document.querySelectorAll("[data-base-temp]").forEach(el => { el.innerHTML = baseTempHtml(el.dataset.baseTemp); });
  refreshLiveBoxes();
}

/** "(12 min ago)" for a live reading. Open-Meteo gives Japan time without a zone, e.g.
 *  "2026-11-27T15:15" (the 15-minute slot the value is for). Updated every minute by tickAgo(). */
function agoText(jstTime) {
  const t = Date.parse(`${jstTime}:00+09:00`);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return "(just now)";
  if (min < 60) return `(${min} min ago)`;
  const h = Math.floor(min / 60), m = min % 60;
  return `(${h} h${m ? ` ${m} min` : ""} ago)`;
}

function agoHtml(jstTime) {
  if (!jstTime) return "";
  return `<span class="ago" data-time="${esc(jstTime)}" title="Updated ${esc(jstTime.replace("T", " "))} JST">${agoText(jstTime)}</span>`;
}

function tickAgo() {
  document.querySelectorAll(".ago[data-time]").forEach(el => { el.textContent = agoText(el.dataset.time); });
}

/** Base temperature for the table: live if we have it, otherwise today's forecast low / high. */
function baseTempHtml(id) {
  const live = state.live[id]?.base;
  if (live) return `${deg(live.temp)} °C<span class="cell-note">live ${agoHtml(live.time)}</span>`;
  const t = todayResult(id)?.temps;
  if (t?.base) {
    const note = t.kind === "forecast" ? "forecast low / high" : "low / high";
    return `${deg(t.base.min_c)} / ${deg(t.base.max_c)} °C<span class="cell-note">${note}</span>`;
  }
  return NA;
}

// ------------------------------------------------------------------ night skiing (moon symbol)

const MOON_ICON = `<svg class="moon-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg>`;

/** The resort's night skiing for the season `date` falls in (from resorts.yaml), or null. */
function nightSkiing(id, date) {
  const all = state.index.resorts[id]?.night_skiing;
  return all && date ? all[seasonOf(date)] || null : null;
}

function nightDescription(ns) {
  const d = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const period = ns.from ? `${d(ns.from)} – ${ns.to ? d(ns.to) : ns.to_note || "end not announced"}` : ns.to_note || "dates not announced";
  return [period, ns.hours ? ns.hours.replace("-", "–") : "", ns.note || ""].filter(Boolean).join(" · ");
}

/** Moon symbol; hovering shows the night skiing dates. `what` = "Night skiing" or "Night skiing lift". */
function nightIcon(ns, what = "Night skiing") {
  if (!ns) return "";
  const text = `${what}: ${nightDescription(ns)}`;
  return `<span class="night" title="${esc(text)}" role="img" aria-label="${esc(text)}">${MOON_ICON}</span>`;
}

function isNightLift(ns, l) {
  return !!ns?.lifts?.some(n => n === l.name_en || n === l.name);
}

// ------------------------------------------------------------------ resort rows (table and search)

/** Open runs per grade, for the grades this resort has. */
function runsByGrade(runs) {
  const counts = new Map();
  for (const run of runs) {
    const grade = GRADES.find(g => g.levels.includes(run.level)) || GRADES[GRADES.length - 1];
    const c = counts.get(grade.key) || { grade, open: 0, total: 0 };
    c.total += 1;
    if (run.status === "open" || run.status === "partial") c.open += 1;
    counts.set(grade.key, c);
  }
  return GRADES.map(g => counts.get(g.key)).filter(Boolean);
}

/** True when the resort lists runs as open although no lifts are running
 *  (e.g. Hakuba's run page is updated once in the morning; lifts may have closed since). */
function runsWithoutLifts(r) {
  return !!(r?.ok && r.lifts_open === 0 && r.runs_open > 0);
}

const ALERT_ICON = `<svg class="alert-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3l10 18H2z" fill="currentColor"/><path d="M12 10v5" stroke="var(--card)" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.2" fill="var(--card)"/></svg>`;

function runsAlertHtml(r, long = false) {
  if (!runsWithoutLifts(r)) return "";
  const text = `No lifts are open, but ${r.runs_open} run${r.runs_open === 1 ? " is" : "s are"} listed as open`;
  return long
    ? `<div class="box-alert" role="note">${ALERT_ICON}<span>${esc(text)}. The runs may not be reachable.</span></div>`
    : `<span class="alert-inline" title="${esc(text)}" role="img" aria-label="${esc(text)}">${ALERT_ICON}</span>`;
}

const STALE_WARNING_HOURS = 48; // warn on the site only after 2 days of failed checks

/** When the resort's status page has been failing for at least STALE_WARNING_HOURS: the time
 *  of the first failed check in a row (live.json's failing_since), otherwise null. Shorter
 *  outages show nothing (the last status we got is usually still close enough). */
function failingSince(id) {
  const since = state.liveStatus?.results?.[id]?.failing_since;
  return since && Date.now() - new Date(since).getTime() >= STALE_WARNING_HOURS * 3600e3 ? since : null;
}

/** Warning that the status shown may be out of date because the resort's page can't be read.
 *  `long`: a sentence for the resort page; otherwise a small icon with a tooltip (tables). */
function staleHtml(id, long = false) {
  const since = failingSince(id);
  if (!since) return "";
  const shown = !!liveStatusFor(id) || !!todayResult(id)?.ok;
  const text = `Couldn't reach the resort's status page since ${formatJst(since)}`;
  return long
    ? `<div class="stale-note" role="note">${ALERT_ICON}<span>${esc(text)} (it's checked every 45 min).${
        shown ? " The lift and run status below is the last one we got, so it may be out of date." : ""}</span></div>`
    : `<span class="alert-inline" title="${esc(text)}. Status may be out of date." role="img"
        aria-label="${esc(text)}. Status may be out of date.">${ALERT_ICON}</span>`;
}

function runsHtml(result) {
  const runs = result?.runs || [];
  if (!result?.ok || !runs.length) return NA;
  return `<span class="grades">${runsByGrade(runs).map(c =>
    `<span class="grade grade-${c.grade.key}" title="${esc(c.grade.label)}: ${c.open} of ${c.total} runs open">${c.open}</span>`
  ).join("")}${runsAlertHtml(result)}</span>`;
}

function liftsHtml(id, result) {
  if (!result) return NA;
  if (!result.ok) return `<span class="warn">Couldn't read page</span>`;
  const total = seasonSummary(id).lifts_total ?? result.lifts.length;
  return `<strong>${result.lifts_open}</strong> / ${total}`;
}

const HISTORY_ICON = `<svg class="history-icon" viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Recently viewed">
  <title>Recently viewed</title>
  <path d="M3 12a9 9 0 1 0 3-6.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M3 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The cells shared by the resort table and the search suggestions.
 *  `recentlyViewed` adds a small history symbol before the name (search suggestions). */
function resortCells(id, recentlyViewed = false) {
  const info = state.index.resorts[id];
  const r = currentResult(id);
  return `
    <span class="cell cell-name">${recentlyViewed ? HISTORY_ICON : ""}${esc(info.name)}${nightIcon(nightSkiing(id, state.latestDate))}<span class="cell-note">${esc(info.region)}</span></span>
    <span class="cell" data-label="Lifts open">${liftsHtml(id, r)}${staleHtml(id)}</span>
    <span class="cell" data-label="Runs open">${runsHtml(r)}</span>
    <span class="cell" data-label="Base temp" data-base-temp="${esc(id)}">${baseTempHtml(id)}</span>
    <span class="cell" data-label="Snow depth">${r?.ok ? num(r.snow_depth_cm, " cm") : NA}</span>`;
}

function pinIcon(filled) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"
    fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function resortRow(id) {
  const pinned = pins.has(id);
  const name = state.index.resorts[id].name;
  return `
    <div class="resort-row">
      <a class="resort-link" href="#/resort/${esc(id)}">${resortCells(id)}</a>
      <button class="pin${pinned ? " is-pinned" : ""}" type="button" data-pin="${esc(id)}"
        aria-pressed="${pinned}" title="${pinned ? "Unpin" : "Pin"} ${esc(name)}"
        aria-label="${pinned ? "Unpin" : "Pin"} ${esc(name)}">${pinIcon(pinned)}</button>
    </div>`;
}

const TABLE_HEAD = `
  <div class="table-head" aria-hidden="true">
    <span>Resort</span><span>Lifts open</span><span>Runs open</span><span>Base temp</span><span>Snow depth</span><span></span>
  </div>`;

// ------------------------------------------------------------------ find resort (search with suggestions)

function normalize(s) {
  return String(s).toLowerCase().normalize("NFKC").replace(/[\s\-・/]+/g, " ").trim();
}

/** How well a resort matches what was typed; -1 = no match. */
function matchScore(id, query) {
  const info = state.index.resorts[id];
  const name = normalize(info.name);
  const words = name.split(" ");
  const q = normalize(query);
  const tokens = q.split(" ");
  if (name.startsWith(q)) return 3;                                       // "hakuba h…"
  if (tokens.every(t => words.some(w => w.startsWith(t)))) return 2;      // "hap" -> Happo-one
  if (name.replace(/ /g, "").includes(q.replace(/ /g, ""))) return 1;     // inside a word
  if (normalize(info.region).startsWith(q)) return 0.5;                   // "nagano"
  return -1;
}

function suggestions(query) {
  const recentIds = recent.list();
  const byName = (a, b) => state.index.resorts[a].name.localeCompare(state.index.resorts[b].name);
  if (!normalize(query)) {
    // Nothing typed: recently viewed first, then fill up alphabetically.
    const rest = resortIds().filter(id => !recentIds.includes(id)).sort(byName);
    return [...recentIds, ...rest].slice(0, MAX_SUGGESTIONS);
  }
  const rank = id => (recentIds.includes(id) ? recentIds.indexOf(id) : Infinity);
  return resortIds()
    .map(id => ({ id, score: matchScore(id, query) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => (rank(a.id) - rank(b.id)) || (b.score - a.score) || byName(a.id, b.id))
    .slice(0, MAX_SUGGESTIONS)
    .map(x => x.id);
}

function searchHtml() {
  return `
    <div class="search" role="search">
      <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="search" class="search-input" placeholder="Find resort" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="false" aria-controls="search-list" aria-autocomplete="list" aria-label="Find resort">
      <div class="search-list" id="search-list" role="listbox" hidden></div>
    </div>`;
}

const PRESENT_SEARCH = { cells: (id, recentlyViewed) => resortCells(id, recentlyViewed), href: id => `#/resort/${id}` };

/** `opts`: which cells to show in the suggestions and where they link (present or Historical tab). */
function setupSearch(root, opts = PRESENT_SEARCH) {
  const box = root.querySelector(".search");
  if (!box) return;
  const input = box.querySelector(".search-input");
  const list = box.querySelector(".search-list");
  let items = [];
  let active = -1;

  function render() {
    items = suggestions(input.value);
    const recentIds = recent.list();
    active = Math.min(active, items.length - 1);
    list.innerHTML = items.length
      ? items.map((id, i) => `
          <a class="search-option${i === active ? " is-active" : ""}" role="option" id="opt-${esc(id)}"
            aria-selected="${i === active}" href="${esc(opts.href(id))}" data-id="${esc(id)}">${opts.cells(id, recentIds.includes(id))}</a>`).join("")
      : `<div class="search-empty">No resort matches “${esc(input.value)}”.</div>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", active >= 0 ? `opt-${items[active]}` : "");
  }

  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function go(id) {
    close();
    input.value = "";
    location.hash = opts.href(id);
  }

  input.addEventListener("focus", render);
  input.addEventListener("input", () => { active = -1; render(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) render();
      if (!items.length) return;
      active = e.key === "ArrowDown" ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) go(items[active]);
      else if (items.length === 1) go(items[0]);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });
  // Keep the list open while clicking an option (blur would otherwise close it first).
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => {
    const opt = e.target.closest(".search-option");
    if (opt) { e.preventDefault(); go(opt.dataset.id); }
  });
  input.addEventListener("blur", close);
}

// ------------------------------------------------------------------ pages

function updatedLine() {
  if (!state.latestDate) return "";
  const status = statusTimeHtml();
  return `<p class="muted small updated">${status ? `${status}<br>` : ""}Snow depth, new snow and weather:
    <strong>${esc(formatDay(state.latestDate))}</strong> (updated ${esc(formatJst(state.index.last_updated))})${seasonNoteHtml()}</p>`;
}

function seasonNoteHtml() {
  const m = state.index.season_months;
  if (!m) return "";
  const now = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Tokyo", month: "numeric" }));
  const inSeason = m.start <= m.end ? now >= m.start && now <= m.end : now >= m.start || now <= m.end;
  if (inSeason) return "";
  const name = n => new Date(2000, n - 1, 1).toLocaleString("en-GB", { month: "long" });
  return `<span class="season-note">Off-season: lift status is collected ${name(m.start)}–${name(m.end)}. Showing the last day recorded.</span>`;
}

function closedRegions() {
  return readList("closedRegions");
}

function renderHome() {
  const pinned = pins.list();
  const closed = closedRegions();
  let html = `
    <h1 class="page-title">Today at the resorts</h1>
    ${updatedLine()}
    ${searchHtml()}
    <div class="resort-table">
      ${TABLE_HEAD}`;
  if (pinned.length) {
    html += `
      <section class="group group-pinned">
        <h2 class="group-title">${pinIcon(true)} Pinned <span class="count">${pinned.length} / ${MAX_PINS}</span></h2>
        ${pinned.map(resortRow).join("")}
      </section>`;
  }
  for (const [region, ids] of regions()) {
    html += `
      <details class="group region" data-region="${esc(region)}"${closed.includes(region) ? "" : " open"}>
        <summary class="group-title">${esc(region)} <span class="count">${ids.length}</span></summary>
        ${ids.map(resortRow).join("")}
      </details>`;
  }
  html += `</div>
    <p class="muted small legend">Runs open by grade:
      <span class="grade grade-green"></span> green
      <span class="grade grade-red"></span> red
      <span class="grade grade-black"></span> black
      <span class="grade grade-orange"></span> expert
      <span class="grade grade-other"></span> level not published.
      Partly open runs count as open.</p>`;
  view.innerHTML = html;
  setupSearch(view);

  view.querySelectorAll("button[data-pin]").forEach(btn => btn.addEventListener("click", () => {
    if (pins.toggle(btn.dataset.pin)) renderHome();
  }));
  view.querySelectorAll("details.region").forEach(d => d.addEventListener("toggle", () => {
    const list = closedRegions().filter(r => r !== d.dataset.region);
    writeList("closedRegions", d.open ? list : [...list, d.dataset.region]);
  }));
}

function renderDirectory() {
  let html = `
    <h1 class="page-title">Resorts</h1>
    <p class="muted small">Pick a resort to see its page.</p>
    ${searchHtml()}
    <div class="directory">`;
  for (const [region, ids] of regions()) {
    html += `
      <section class="directory-region">
        <h2>${esc(region)}</h2>
        <ul>${ids.map(id => `<li><a href="#/resort/${esc(id)}">${esc(state.index.resorts[id].name)}</a>${nightIcon(nightSkiing(id, state.latestDate))}${staleHtml(id)}</li>`).join("")}</ul>
      </section>`;
  }
  view.innerHTML = html + "</div>";
  setupSearch(view);
}

// ------------------------------------------------------------------ resort page

// Which resort page is showing (so live updates can refresh its boxes).
let currentPage = null; // {id, date, result, isLatest}

const SNOW_CODES = [71, 73, 75, 77, 85, 86]; // Open-Meteo weather codes for snow
const TYPE_LABEL = { Gondola: "Gondola", Ropeway: "Ropeway", "Magic carpet": "Magic carpet",
  Single: "Single chair", Pair: "Pair chair", Triple: "Triple chair", Quad: "Quad chair", Six: "Six chair" };
const SEATS = { Single: 1, Pair: 2, Triple: 3, Quad: 4, Six: 6 };
const LEVEL_GRADE = { "First timer": ["green"], Beginner: ["green"], Intermediate: ["red"], Advanced: ["black"],
  Expert: ["orange"], "Beginner/Intermediate": ["green", "red"], "Intermediate/Advanced": ["red", "black"] };

function pct(part, whole) {
  if (part == null || !whole) return null;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** A box; `fill` (0-100) fills the box from the left like a progress bar. */
function box(key, label, inner, fill = null, extraClass = "") {
  return `
    <div class="box ${extraClass}" data-box="${key}">
      ${fill > 0 ? `<div class="box-fill" style="width:${fill.toFixed(1)}%"></div>` : ""}
      <div class="box-body"><div class="box-label">${label}</div>${inner}</div>
    </div>`;
}

/** Horizontal scale from lo to hi with a marker at `value` (optional fill and a tick mark). */
function scale({ lo, hi, value, fillFrom = null, tick = null, loLabel, hiLabel, valueLabel, tickLabel }) {
  if (lo == null || hi == null || value == null) return "";
  const span = hi - lo || 1;
  const at = v => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const outside = value < lo ? "below" : value > hi ? "above" : "";
  return `
    <div class="scale" role="img" aria-label="${esc(valueLabel)} on a scale from ${esc(loLabel)} to ${esc(hiLabel)}">
      <div class="scale-track">
        ${fillFrom != null ? `<div class="scale-fill" style="left:${at(fillFrom)}%;width:${Math.max(0, at(value) - at(fillFrom))}%"></div>` : ""}
        ${tick != null ? `<div class="scale-tick" style="left:${at(tick)}%" title="${esc(tickLabel)}"></div>` : ""}
        <div class="scale-marker${outside ? " is-outside" : ""}" style="left:${at(value)}%"></div>
      </div>
      <div class="scale-labels"><span>${esc(loLabel)}</span>${tickLabel ? `<span class="scale-tick-label">${esc(tickLabel)}</span>` : ""}<span>${esc(hiLabel)}</span></div>
      ${outside ? `<div class="stat-note">${esc(valueLabel)} is ${outside} this range</div>` : ""}
    </div>`;
}

function liftsBox(id, r, more = "") {
  if (!r?.ok) return box("lifts", "Lifts open", `<div class="box-value">${NA}</div>`);
  const total = (r.date === state.latestDate ? seasonSummary(id).lifts_total : null) ?? r.lifts.length;
  const p = pct(r.lifts_open, total);
  return box("lifts", "Lifts open",
    `<div class="box-value">${r.lifts_open} <small>/ ${total}</small></div>
     <div class="box-note">${Math.round(p)}% open</div>${more ? `<div class="box-note box-more">${more}</div>` : ""}`, p, "fill-green");
}

function runsBox(id, r, more = "") {
  const runs = r?.runs || [];
  if (!r?.ok || !runs.length) {
    return box("runs", "Runs open", `<div class="box-value">${NA}</div><div class="box-note">Not published by the resort</div>`);
  }
  const p = pct(r.runs_open, runs.length);
  return box("runs", "Runs open",
    `<div class="box-value">${r.runs_open} <small>/ ${runs.length}</small></div>
     <div class="box-grades">${runsHtml(r)}</div>${runsAlertHtml(r, true)}${more ? `<div class="box-note box-more">${more}</div>` : ""}`, p, "fill-green");
}

function snowDepthBox(id, r, date, isLatest) {
  const depth = r?.ok ? r.snow_depth_cm : null;
  const label = seasonOf(date);
  let ref, refText;
  if (isLatest) {
    const start = Number(label.slice(0, 4)) - 1;
    const prev = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
    const lastMax = state.index.seasons[prev]?.summary?.[id]?.snow_depth_max_cm;
    if (lastMax != null) {
      ref = lastMax;
      refText = `Last season's max: ${lastMax} cm`;
    } else {
      ref = state.index.seasons[label]?.summary?.[id]?.snow_depth_max_cm;
      refText = `Last season's max: no records yet${ref != null ? ` (bar: this season's max so far, ${ref} cm)` : ""}`;
    }
  } else {
    ref = state.index.seasons[label]?.summary?.[id]?.snow_depth_max_cm;
    refText = `Season ${label} max: ${num(ref, " cm")}`;
  }
  const p = depth != null ? pct(depth, ref) : null;
  return box("depth", "Snow depth",
    `<div class="box-value">${num(depth, " cm")}</div><div class="box-note">${esc(refText)}</div>`, p, "fill-blue");
}

function weatherIcon(snowing) {
  if (snowing) {
    return `<div class="wx wx-snow" role="img" aria-label="Snowing" title="Snowing">${"<span></span>".repeat(14)}</div>`;
  }
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map(a =>
    `<line x1="24" y1="5" x2="24" y2="11" stroke="currentColor" stroke-width="3" stroke-linecap="round" transform="rotate(${a} 24 24)"/>`).join("");
  return `<div class="wx wx-sun" role="img" aria-label="Not snowing" title="Not snowing"><svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
    <circle cx="24" cy="24" r="9" fill="currentColor"/>${rays}</svg></div>`;
}

function outlookText(o) {
  if (!o) return "";
  if (o.date == null) return `No snow in the ${o.within_days}-day forecast`;
  if (o.days === 0) return `Snow expected today (~${o.cm} cm)`;
  const when = new Date(`${o.date}T12:00:00+09:00`).toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo", weekday: "short", day: "numeric", month: "short" });
  return `Next snow in ${o.days} day${o.days === 1 ? "" : "s"} (${when}, ~${o.cm} cm)`;
}

function newSnowBox(id, r, date, isLatest) {
  const value = r?.ok ? r.new_snow_cm : null;
  const t = r?.temps;
  let snowing = false, wxNote = "";
  if (isLatest) {
    const live = state.live[id]?.summit;
    if (live) {
      snowing = live.snowfall > 0 || SNOW_CODES.includes(live.code);
      wxNote = snowing ? "Snowing at the summit now" : "Not snowing at the summit now";
    }
  } else if (t?.snow_hours != null) {
    snowing = !!t.snowed;
    wxNote = `Snowed ${t.snow_hours} hour${t.snow_hours === 1 ? "" : "s"} at the summit that day`;
  }
  const outlook = isLatest && (value === 0 || value == null) ? outlookText(r?.snow_outlook) : "";
  const s = state.index.seasons[seasonOf(date)]?.summary?.[id] || {};
  let graphic = "";
  if (value != null) {
    graphic = s.new_snow_max_cm != null && s.new_snow_max_cm > s.new_snow_min_cm
      ? scale({ lo: s.new_snow_min_cm, hi: s.new_snow_max_cm, value, fillFrom: s.new_snow_min_cm, tick: s.new_snow_mean_cm,
          loLabel: `min ${s.new_snow_min_cm}`, hiLabel: `max ${s.new_snow_max_cm} cm`, valueLabel: `${value} cm`,
          tickLabel: `mean ${s.new_snow_mean_cm}` })
      : `<div class="stat-note">Compared with the season's min, mean and max new snow once there are a few days of records.</div>`;
  }
  return box("snow", "New snow",
    `${weatherIcon(snowing)}
     <div class="box-value">${num(value, " cm")}</div>
     ${outlook ? `<div class="box-note box-outlook">${esc(outlook)}</div>` : ""}
     ${wxNote ? `<div class="box-note">${esc(wxNote)}</div>` : ""}
     ${graphic}`, null, "box-snow");
}

function tempBox(id, level, r, date, isLatest) {
  const info = state.index.resorts[id];
  const t = r?.temps?.[level];
  const elevation = t?.elevation_m ?? info.elevation_m?.[level];
  const title = `${level === "summit" ? "Summit" : "Base"} at ${elevation ? `${Number(elevation).toLocaleString("en-GB")} m` : NA}`;
  if (!t) return box(level, title, `<div class="box-value">${NA}</div>`);
  const kind = r.temps.kind === "forecast" ? "forecast min / max" : "min / max";
  let below = "";
  if (isLatest) {
    const live = state.live[id]?.[level];
    below = live
      ? `<div class="box-note">Live: <strong>${deg(live.temp)} °C</strong> ${agoHtml(live.time)}</div>
         ${scale({ lo: t.min_c, hi: t.max_c, value: live.temp, loLabel: `${deg(t.min_c)}°`, hiLabel: `${deg(t.max_c)}°`,
                   valueLabel: `Live ${deg(live.temp)} °C` })}`
      : `<div class="box-note">Live: loading…</div>`;
  } else if (t.mean_c != null) {
    const s = state.index.seasons[seasonOf(date)]?.summary?.[id] || {};
    const lowest = s[`${level}_lowest_mean_c`], highest = s[`${level}_highest_mean_c`];
    below = `<div class="box-note">Day's mean: <strong>${deg(t.mean_c)} °C</strong>${lowest != null ? ` · season's lowest mean ${deg(lowest)} °C` : ""}</div>
      ${lowest != null && highest != null && highest > lowest
        ? scale({ lo: lowest, hi: highest, value: t.mean_c, loLabel: `lowest mean ${deg(lowest)}°`, hiLabel: `highest ${deg(highest)}°`,
                  valueLabel: `Mean ${deg(t.mean_c)} °C` })
        : ""}`;
  }
  return box(level, title,
    `<div class="box-value">${deg(t.min_c)} <small>/</small> ${deg(t.max_c)} <small>°C</small></div>
     <div class="box-note">${kind}</div>${below}`);
}

function boxesHtml(id, r, date, isLatest) {
  return liftsBox(id, r) + runsBox(id, r) + snowDepthBox(id, r, date, isLatest)
    + newSnowBox(id, r, date, isLatest) + tempBox(id, "base", r, date, isLatest) + tempBox(id, "summit", r, date, isLatest);
}

/** After live data arrives, redraw only the boxes that use it. */
function refreshLiveBoxes() {
  if (!currentPage?.isLatest) return;
  const { id, date, result } = currentPage;
  const redraw = {
    snow: () => newSnowBox(id, result, date, true),
    base: () => tempBox(id, "base", result, date, true),
    summit: () => tempBox(id, "summit", result, date, true),
  };
  for (const [key, html] of Object.entries(redraw)) {
    const el = view.querySelector(`[data-box="${key}"]`);
    if (el) el.outerHTML = html();
  }
}

function typeIcon(type, compact = false) {
  const seats = SEATS[type];
  let svg;
  if (type === "Gondola") {
    svg = `<path d="M3 5l18-2M12 4v4" stroke="currentColor" stroke-width="1.6"/>
      <rect x="6" y="8" width="12" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 12h12" stroke="currentColor" stroke-width="1.6"/>`;
  } else if (type === "Ropeway") {
    svg = `<path d="M2 5l20-2M2 7l20-2" stroke="currentColor" stroke-width="1.4"/><path d="M12 6v3" stroke="currentColor" stroke-width="1.6"/>
      <rect x="4" y="9" width="16" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 13h16M9 13v7M15 13v7" stroke="currentColor" stroke-width="1.4"/>`;
  } else if (type === "Magic carpet") {
    svg = `<path d="M3 18l18-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="12" cy="7" r="2" fill="currentColor"/><path d="M12 9v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  } else if (seats) {
    svg = `<path d="M12 2v6" stroke="currentColor" stroke-width="1.6"/><path d="M7 8h10v6H7z" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <path d="M6 14h12l-1 4H7z" fill="currentColor"/><path d="M7 18v3M17 18v3" stroke="currentColor" stroke-width="1.6"/>`;
  } else {
    return `<span class="muted">${NA}</span>`;
  }
  return `<span class="type${compact ? " type-compact" : ""}"${compact ? ` title="${esc(TYPE_LABEL[type] || type)}"` : ""}><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${svg}</svg>${
    seats ? `<span class="seats" title="${seats}-seat">${seats}</span>` : ""}${compact ? "" : `<span>${esc(TYPE_LABEL[type] || type)}</span>`}</span>`;
}

function difficultyHtml(level) {
  const grades = LEVEL_GRADE[level];
  if (!grades) return `<span class="muted">${NA}</span>`;
  return `<span class="difficulty">${grades.map(g => `<span class="dot grade-${g}"></span>`).join("")}${esc(level)}</span>`;
}

function liftsTable(lifts, startOpen = false, ns = null) {
  const open = lifts.filter(l => l.status === "open").length;
  return `
    <details class="detail-table" data-list="lifts"${startOpen ? " open" : ""}>
      <summary><span class="summary-title">Lifts <span class="muted">· ${open} of ${lifts.length} open</span></span>
        ${liftTypeTotalsHtml(lifts)}</summary>
      <table>
        <thead><tr><th>Lift</th><th>Status</th><th>Operating hours</th><th>Type</th></tr></thead>
        <tbody>${lifts.map(l => `
          <tr>
            <td>${esc(l.name_en)}${isNightLift(ns, l) ? nightIcon(ns, "Night skiing lift") : ""}${l.name !== l.name_en ? `<span class="cell-note" lang="ja">${esc(l.name)}</span>` : ""}</td>
            <td><span class="badge s-${esc(l.status)}" title="Resort's wording: ${esc(l.raw)}">${esc(STATUS_LABEL[l.status])}</span></td>
            <td class="num">${esc(l.hours)}</td>
            <td>${typeIcon(l.lift_type)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
}

function runsTable(runs, startOpen = false, liftsOpen = null) {
  if (!runs.length) return `<p class="muted small">Runs: ${NA} (the resort doesn't publish run status).</p>`;
  const open = runs.filter(x => x.status === "open" || x.status === "partial").length;
  return `
    <details class="detail-table" data-list="runs"${startOpen ? " open" : ""}>
      <summary><span class="summary-title">Runs <span class="muted">· ${open} of ${runs.length} open</span>
        ${runsAlertHtml({ ok: true, lifts_open: liftsOpen, runs_open: open })}</span>
        ${runGradeTotalsHtml(runs)}</summary>
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Difficulty</th></tr></thead>
        <tbody>${runs.map(x => `
          <tr>
            <td>${esc(x.name_en)}${x.name !== x.name_en ? `<span class="cell-note" lang="ja">${esc(x.name)}</span>` : ""}</td>
            <td><span class="badge s-${esc(x.status)}" title="Resort's wording: ${esc(x.raw)}">${esc(RUN_STATUS_LABEL[x.status])}</span></td>
            <td>${difficultyHtml(x.level)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
}

function mapHtml(info) {
  const m = info.map;
  if (!m?.url) return "";
  const note = m.note ? `<p class="muted small">${esc(m.note)}.</p>` : "";
  const credit = `<p class="muted small">Map © ${esc(info.name)}, from the resort's website.</p>`;
  if (m.type === "image") {
    return `
      <section class="map">
        <h2>Trail map</h2>
        <a href="${esc(m.url)}" target="_blank" rel="noopener" title="Open full size">
          <img src="${esc(m.url)}" alt="Trail map of ${esc(info.name)}" loading="lazy">
        </a>
        ${note}${credit}
      </section>`;
  }
  const what = m.type === "pdf" ? "Open the trail map (PDF)" : "Open the trail map";
  return `
    <section class="map">
      <h2>Trail map</h2>
      <p><a class="button" href="${esc(m.url)}" target="_blank" rel="noopener">${what} ↗</a></p>
      ${note}${credit}
    </section>`;
}

async function renderResortPage(id, date) {
  const info = state.index.resorts[id];
  if (!info) {
    view.innerHTML = `<p class="error">There's no resort called “${esc(id)}”.</p><p><a href="#/resorts">See all resorts</a></p>`;
    return;
  }
  recent.add(id);
  date = date || state.latestDate;
  const isLatest = date === state.latestDate;
  let day = state.latestDay;
  if (!isLatest) {
    try {
      const season = await loadSeason(seasonOf(date));
      day = season.days.find(d => d.date === date);
    } catch {
      day = null;
    }
  }
  const record = isLatest ? currentResult(id) : day?.results?.[id];
  const r = record ? { ...record, date } : record;
  currentPage = { id, date, result: r, isLatest };

  view.innerHTML = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/resorts">Resorts</a> › <span>${esc(info.name)}</span></nav>
    <div class="resort-head">
      <div>
        <h1 class="page-title">${esc(info.name)}${nightIcon(nightSkiing(id, date))}</h1>
        <p class="resort-links small">
          ${info.website ? `<a href="${esc(info.website)}" target="_blank" rel="noopener">Official website ↗</a> · ` : ""}
          <a href="${esc(info.source_url)}" target="_blank" rel="noopener">Lift status page ↗</a> · ${esc(info.region)}
        </p>
      </div>
      <div class="head-buttons">
        <a class="button button-secondary" href="#/history/${esc(id)}">Switch to historical</a>
        <button class="pin pin-large${pins.has(id) ? " is-pinned" : ""}" type="button" data-pin="${esc(id)}"
          aria-pressed="${pins.has(id)}">${pinIcon(pins.has(id))}<span>${pins.has(id) ? "Pinned" : "Pin"}</span></button>
      </div>
    </div>
    <p class="muted small date-line">${isLatest
      ? `${r?.liveStatus ? `${statusTimeHtml()}<br>` : ""}Snow depth, new snow and weather: <strong>${esc(formatDay(date))}</strong>`
      : `Historical record: <strong>${esc(formatDay(date))}</strong>`}${
      r?.source_updated ? ` · resort last updated ${esc(formatJst(r.source_updated))}` : ""}</p>

    ${isLatest ? staleHtml(id, true) : ""}
    ${!r ? `<p class="warn">No data for this day.</p>` : !r.ok && !(isLatest && failingSince(id)) ? `<p class="warn">Couldn't read the resort's page this day.</p>` : ""}
    <div class="boxes">${boxesHtml(id, r, date, isLatest)}</div>

    ${r?.ok ? liftsTable(r.lifts, false, nightSkiing(id, date)) + runsTable(r.runs || [], false, r.lifts_open) : ""}
    ${mapHtml(info)}`;

  view.querySelector("button[data-pin]").addEventListener("click", () => {
    if (pins.toggle(id)) renderResortPage(id, isLatest ? null : date);
  });
  linkBoxesToLists();
}

/** Present page: clicking the Lifts / Runs box opens its dropdown below and scrolls to it. */
function linkBoxesToLists() {
  for (const key of ["lifts", "runs"]) {
    const boxEl = view.querySelector(`.boxes [data-box="${key}"]`);
    const list = view.querySelector(`details[data-list="${key}"]`);
    if (!boxEl || !list) continue;
    boxEl.classList.add("box-clickable");
    boxEl.setAttribute("role", "button");
    boxEl.setAttribute("tabindex", "0");
    boxEl.querySelector(".box-body").insertAdjacentHTML("beforeend",
      `<div class="box-note box-more">See all ${key} ›</div>`);
    const go = () => {
      list.open = true;
      list.scrollIntoView({ behavior: "smooth", block: "start" });
      list.querySelector("summary")?.focus({ preventScroll: true });
    };
    boxEl.addEventListener("click", go);
    boxEl.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
}

// ------------------------------------------------------------------ router

function route(scrollTop = true) {
  const path = location.hash.replace(/^#\/?/, "");
  const [page, id, date, value] = path.split("/");
  const tab = page === "resorts" || page === "resort" ? "resorts" : page === "history" ? "history" : page === "compare" ? "compare" : "home";
  document.querySelectorAll(".tabs a").forEach(a => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  currentPage = null;
  if (page !== "history" && historyUI) { historyUI.graph?.destroy(); historyUI = null; }
  if (page !== "compare" && compareGraph) { compareGraph.destroy(); compareGraph = null; }
  if (page === "history") id ? renderHistoryPage(decodeURIComponent(id), date, value) : renderHistoryDirectory();
  else if (page === "compare") { compareSeen(); renderCompare(); }
  else if (page === "resort" && id) renderResortPage(decodeURIComponent(id), /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null);
  else if (page === "resorts") renderDirectory();
  else renderHome();
  if (scrollTop) window.scrollTo(0, 0);
}

/** Fetch data/live.json; if it changed, redraw the page (unless the visitor is typing a search). */
async function loadLiveStatus(redraw = false) {
  try {
    const resp = await fetch("data/live.json", { cache: "no-cache" });
    if (!resp.ok) return; // no live file yet (e.g. off-season): use the daily record
    const data = await resp.json();
    const changed = data.updated !== state.liveStatus?.updated;
    state.liveStatus = data;
    if (redraw && changed && !document.activeElement?.classList.contains("search-input")) route(false);
  } catch (err) {
    console.warn("Live lift status unavailable:", err.message);
  }
}

// ------------------------------------------------------------------ start

async function start() {
  try {
    const resp = await fetch("data/lifts.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.index = await resp.json();
    showCompareBadge(); // resorts added to Compare since it was last opened
    const labels = Object.keys(state.index.seasons || {}).sort();
    const label = labels[labels.length - 1];
    if (label) {
      const season = await loadSeason(label);
      state.latestDay = season.days[season.days.length - 1] || null;
      state.latestDate = state.latestDay?.date || null;
    }
    if (IS_DEMO) injectDemoSeason();
  } catch (err) {
    view.innerHTML = `<p class="error">Couldn't load the data (${esc(err.message)}).</p>
      <p class="muted small">If you opened this file directly, run <code>python -m http.server -d docs</code>
      in the project folder and visit <a href="http://localhost:8000">http://localhost:8000</a> instead.</p>`;
    return;
  }
  await loadLiveStatus();
  window.addEventListener("hashchange", () => route());
  route();
  setInterval(() => loadLiveStatus(true), STATUS_REFRESH_MS);
  fetchLive();
  setInterval(fetchLive, LIVE_REFRESH_MS);
  setInterval(tickAgo, 60 * 1000); // keep "(x min ago)" current
}

start();

// Ski Status — single-page site with tabs (Home, Resorts) and one page per resort.
//
// Pages (the part of the address after #):
//   #/                 Home: find-resort search, pinned resorts, resort table by region
//   #/resorts          Resorts: search + directory of all resorts by region
//   #/resort/<id>      One resort (placeholder for now, with today's lifts and runs)
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
    current: "temperature_2m",
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
        (live[p.id] ||= {})[p.level] = { temp: cur.temperature_2m + 0, time: cur.time };
      }
    });
    state.live = live;
  } catch (err) {
    console.warn("Live temperatures unavailable:", err.message); // fall back to the forecast range
  }
  // Update temperature cells in place (re-rendering would interrupt typing in the search box).
  document.querySelectorAll("[data-base-temp]").forEach(el => { el.innerHTML = baseTempHtml(el.dataset.baseTemp); });
  document.querySelectorAll("[data-live-level]").forEach(el => {
    el.innerHTML = liveStatHtml(el.dataset.liveId, el.dataset.liveLevel);
  });
}

/** Base temperature for the table: live if we have it, otherwise today's forecast low / high. */
function baseTempHtml(id) {
  const live = state.live[id]?.base;
  if (live) return `${deg(live.temp)} °C<span class="cell-note">live</span>`;
  const t = todayResult(id)?.temps;
  if (t?.base) {
    const note = t.kind === "forecast" ? "forecast low / high" : "low / high";
    return `${deg(t.base.min_c)} / ${deg(t.base.max_c)} °C<span class="cell-note">${note}</span>`;
  }
  return NA;
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

function runsHtml(result) {
  const runs = result?.runs || [];
  if (!result?.ok || !runs.length) return NA;
  return `<span class="grades">${runsByGrade(runs).map(c =>
    `<span class="grade grade-${c.grade.key}" title="${esc(c.grade.label)}: ${c.open} of ${c.total} runs open">${c.open}</span>`
  ).join("")}</span>`;
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
  const r = todayResult(id);
  return `
    <span class="cell cell-name">${recentlyViewed ? HISTORY_ICON : ""}${esc(info.name)}<span class="cell-note">${esc(info.region)}</span></span>
    <span class="cell" data-label="Lifts open">${liftsHtml(id, r)}</span>
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

function setupSearch(root) {
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
            aria-selected="${i === active}" href="#/resort/${esc(id)}">${resortCells(id, recentIds.includes(id))}</a>`).join("")
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
    location.hash = `#/resort/${id}`;
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
    if (opt) { e.preventDefault(); go(opt.getAttribute("href").split("/").pop()); }
  });
  input.addEventListener("blur", close);
}

// ------------------------------------------------------------------ pages

function updatedLine() {
  if (!state.latestDate) return "";
  return `<p class="muted small updated">Lift data for <strong>${esc(formatDay(state.latestDate))}</strong>
    · last updated ${esc(formatJst(state.index.last_updated))}${seasonNoteHtml()}</p>`;
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
        <ul>${ids.map(id => `<li><a href="#/resort/${esc(id)}">${esc(state.index.resorts[id].name)}</a></li>`).join("")}</ul>
      </section>`;
  }
  view.innerHTML = html + "</div>";
  setupSearch(view);
}

function liveStatHtml(id, level) {
  const live = state.live[id]?.[level];
  const elevation = state.index.resorts[id].elevation_m?.[level];
  const label = `${level === "summit" ? "Summit" : "Base"}${elevation ? ` ${Number(elevation).toLocaleString("en-GB")} m` : ""}`;
  const t = todayResult(id)?.temps?.[level];
  const range = t ? `<div class="stat-note">${todayResult(id).temps.kind === "forecast" ? "forecast" : "day"}: ${deg(t.min_c)} to ${deg(t.max_c)} °C</div>` : "";
  const value = live ? `${deg(live.temp)} <small>°C</small><div class="stat-note">live</div>` : NA;
  return `<div class="label">${esc(label)}</div><div class="value">${value}</div>${range}`;
}

function renderResortPage(id) {
  const info = state.index.resorts[id];
  if (!info) {
    view.innerHTML = `<p class="error">There's no resort called “${esc(id)}”.</p><p><a href="#/resorts">See all resorts</a></p>`;
    return;
  }
  recent.add(id);
  const r = todayResult(id);
  const summary = seasonSummary(id);
  view.innerHTML = `
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/resorts">Resorts</a> › <span>${esc(info.name)}</span></nav>
    <div class="resort-head">
      <div>
        <h1 class="page-title">${esc(info.name)}</h1>
        <p class="muted">${esc(info.region)} · <a href="${esc(info.source_url)}" target="_blank" rel="noopener">resort's lift status page</a></p>
      </div>
      <button class="pin pin-large${pins.has(id) ? " is-pinned" : ""}" type="button" data-pin="${esc(id)}"
        aria-pressed="${pins.has(id)}">${pinIcon(pins.has(id))}<span>${pins.has(id) ? "Pinned" : "Pin"}</span></button>
    </div>

    <div class="placeholder">
      <strong>This resort page is a placeholder.</strong> The full design is coming soon; for now it shows today's data.
    </div>

    <div class="stats">
      <div class="stat"><div class="label">Lifts open</div><div class="value">${liftsHtml(id, r)}</div></div>
      <div class="stat"><div class="label">Runs open</div><div class="value">${runsHtml(r)}</div></div>
      <div class="stat"><div class="label">Snow depth</div><div class="value">${r?.ok ? num(r.snow_depth_cm, " cm") : NA}</div></div>
      <div class="stat"><div class="label">New snow</div><div class="value">${r?.ok ? num(r.new_snow_cm, " cm") : NA}</div></div>
      <div class="stat" data-live-id="${esc(id)}" data-live-level="summit">${liveStatHtml(id, "summit")}</div>
      <div class="stat" data-live-id="${esc(id)}" data-live-level="base">${liveStatHtml(id, "base")}</div>
    </div>
    <p class="muted small">Lift data for ${esc(formatDay(state.latestDate))}${r?.source_updated ? ` · resort last updated ${esc(formatJst(r.source_updated))}` : ""}
      · season so far: summit ${summary.summit_min_c != null ? `${deg(summary.summit_min_c)} to ${deg(summary.summit_max_c)} °C` : NA},
      base ${summary.base_min_c != null ? `${deg(summary.base_min_c)} to ${deg(summary.base_max_c)} °C` : NA}</p>

    ${r?.ok ? liftsTable(r.lifts) + runsTable(r.runs || []) : `<p class="warn">${r ? "Couldn't read the resort's page today." : "No data for today."}</p>`}`;

  view.querySelector("button[data-pin]").addEventListener("click", () => {
    if (pins.toggle(id)) renderResortPage(id);
  });
}

function liftsTable(lifts) {
  return `
    <details class="detail-table" open>
      <summary>Lifts (${lifts.length})</summary>
      <table>
        <thead><tr><th>Lift</th><th>Status</th><th>Hours</th><th class="hide-sm">Type</th><th class="hide-sm">Resort's wording</th></tr></thead>
        <tbody>${lifts.map(l => `
          <tr>
            <td>${esc(l.name_en)}${l.name !== l.name_en ? `<span class="cell-note" lang="ja">${esc(l.name)}</span>` : ""}</td>
            <td><span class="badge s-${esc(l.status)}">${esc(STATUS_LABEL[l.status])}</span></td>
            <td class="num">${esc(l.hours)}</td>
            <td class="hide-sm">${esc(l.lift_type)}</td>
            <td class="hide-sm muted small" lang="ja">${esc(l.raw)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
}

function runsTable(runs) {
  if (!runs.length) return `<p class="muted small">Runs: ${NA} (the resort doesn't publish run status).</p>`;
  return `
    <details class="detail-table">
      <summary>Runs (${runs.length})</summary>
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Level</th><th class="hide-sm">Resort's wording</th></tr></thead>
        <tbody>${runs.map(x => `
          <tr>
            <td>${esc(x.name_en)}${x.name !== x.name_en ? `<span class="cell-note" lang="ja">${esc(x.name)}</span>` : ""}</td>
            <td><span class="badge s-${esc(x.status)}">${esc(RUN_STATUS_LABEL[x.status])}</span></td>
            <td>${esc(x.level)}</td>
            <td class="hide-sm muted small" lang="ja">${esc(x.raw)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </details>`;
}

// ------------------------------------------------------------------ router

function route() {
  const path = location.hash.replace(/^#\/?/, "");
  const [page, id] = path.split("/");
  const tab = page === "resorts" || page === "resort" ? "resorts" : "home";
  document.querySelectorAll(".tabs a").forEach(a => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (page === "resort" && id) renderResortPage(decodeURIComponent(id));
  else if (page === "resorts") renderDirectory();
  else renderHome();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ start

async function start() {
  try {
    const resp = await fetch("data/lifts.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.index = await resp.json();
    const labels = Object.keys(state.index.seasons || {}).sort();
    const label = labels[labels.length - 1];
    if (label) {
      const season = await loadSeason(label);
      state.latestDay = season.days[season.days.length - 1] || null;
      state.latestDate = state.latestDay?.date || null;
    }
  } catch (err) {
    view.innerHTML = `<p class="error">Couldn't load the data (${esc(err.message)}).</p>
      <p class="muted small">If you opened this file directly, run <code>python -m http.server -d docs</code>
      in the project folder and visit <a href="http://localhost:8000">http://localhost:8000</a> instead.</p>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  fetchLive();
  setInterval(fetchLive, LIVE_REFRESH_MS);
}

start();

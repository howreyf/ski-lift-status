// Connected resorts ("areas"), e.g. Niseko United = Grand Hirafu + Annupuri + Village + Hanazono.
//
// resorts.yaml lists them under `areas`; the scraper copies them into lifts.json. Each resort is
// still scraped, stored and compared on its own. On the website an area shows as ONE row in the
// Resorts and Historical tables and has its own present and historical pages, built from its
// resorts' records combined day by day:
//   lifts, runs         all of them together, each named with its resort ("Ace Gondola (Grand Hirafu)")
//   lifts/runs open     totals
//   snow depth, new snow, temperatures, season summary values   averages of the resorts
// The area pages add the list of its resorts (with buttons to their pages and "+ Compare") and a
// "Compare all" button that loads every resort of the area into Compare's graph.
// Loaded before app.js; uses its helpers at run time.

"use strict";

function areaIds() {
  return Object.keys(state.index?.areas || {});
}

function isArea(id) {
  return !!state.index?.areas?.[id];
}

/** The area's resorts (those that exist in the data). */
function membersOf(aid) {
  return (state.index.areas[aid]?.resorts || []).filter(id => state.index.resorts[id] && !isArea(id));
}

/** The area a resort belongs to, or null. */
function areaOfResort(id) {
  return areaIds().find(a => membersOf(a).includes(id)) || null;
}

/** "Niseko Grand Hirafu" in Niseko United -> "Grand Hirafu". */
function memberShortName(aid, id) {
  const first = state.index.areas[aid].name.split(" ")[0];
  const name = state.index.resorts[id].name;
  return name.startsWith(`${first} `) ? name.slice(first.length + 1) : name;
}

/** Rows of the resort tables: every resort, with connected resorts replaced by their area
 *  (where the first of them is). */
function tableIds() {
  const out = [];
  for (const id of resortIds()) {
    const row = areaOfResort(id) || id;
    if (!out.includes(row)) out.push(row);
  }
  return out;
}

/** What the "Find resort" search can find: areas and every single resort. */
function searchIds() {
  return [...areaIds(), ...resortIds()];
}

// ------------------------------------------------------------------ combining records

const avgOf = (values, digits = 1) => {
  const v = values.filter(x => x != null && !Number.isNaN(x));
  if (!v.length) return null;
  const f = 10 ** digits;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * f) / f;
};
const sumOf = values => {
  const v = values.filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

function combineTemps(list) {
  const ts = list.filter(Boolean);
  if (!ts.length) return null;
  const out = { kind: ts.every(t => t.kind === "final") ? "final" : "forecast" };
  for (const level of ["summit", "base"]) {
    const parts = ts.map(t => t[level]).filter(Boolean);
    if (!parts.length) continue;
    out[level] = {
      elevation_m: avgOf(parts.map(p => p.elevation_m), 0),
      min_c: avgOf(parts.map(p => p.min_c)),
      max_c: avgOf(parts.map(p => p.max_c)),
      mean_c: avgOf(parts.map(p => p.mean_c)),
    };
  }
  const hours = ts.map(t => t.snow_hours).filter(v => v != null);
  if (hours.length) {
    out.snow_hours = Math.round(avgOf(hours, 1));
    out.snowed = ts.some(t => t.snowed);
  }
  const fall = avgOf(ts.map(t => t.snowfall_cm));
  if (fall != null) out.snowfall_cm = fall;
  return out;
}

/** One record for the area from its resorts' records: [[id, record or null], ...]. */
function combineRecords(aid, entries) {
  const have = entries.filter(([, r]) => r);
  if (!have.length) return null;
  const ok = have.filter(([, r]) => r.ok);
  const members = Object.fromEntries(entries.map(([id, r]) => [id, r ? !!r.ok : null]));
  if (!ok.length) return { ok: false, error: "None of its resorts' pages could be read", members, lifts: [], runs: [] };
  const tag = (id, x) => ({ ...x, name: `${x.name} (${memberShortName(aid, id)})`,
    name_en: `${x.name_en} (${memberShortName(aid, id)})`, resort: id });
  const withRuns = ok.filter(([, r]) => r.runs?.length);
  const outlooks = ok.map(([, r]) => r.snow_outlook).filter(Boolean);
  const nearest = outlooks.filter(o => o.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  const updated = ok.map(([, r]) => r.source_updated).filter(Boolean).sort();
  return {
    ok: true,
    area: true,
    members,
    lifts: ok.flatMap(([id, r]) => r.lifts.map(l => tag(id, l))),
    runs: ok.flatMap(([id, r]) => (r.runs || []).map(x => tag(id, x))),
    lifts_open: sumOf(ok.map(([, r]) => r.lifts.filter(l => l.status === "open").length)),
    runs_open: withRuns.length ? sumOf(withRuns.map(([, r]) => r.runs.filter(x => x.status === "open" || x.status === "partial").length)) : null,
    snow_depth_cm: avgOf(ok.map(([, r]) => r.snow_depth_cm), 0),
    new_snow_cm: avgOf(ok.map(([, r]) => r.new_snow_cm)),
    temps: combineTemps(have.map(([, r]) => r.temps)),
    snow_outlook: nearest || outlooks[0] || null,
    source_updated: updated[updated.length - 1] || null,
    liveStatus: ok.some(([, r]) => r.liveStatus),
    afterHours: sumOf(ok.map(([, r]) => r.afterHours || 0)) || 0,
  };
}

/** Season summary of an area: totals of lifts and runs, averages of everything else. */
function combineSummaries(parts) {
  const out = {};
  const keys = new Set(parts.flatMap(p => Object.keys(p)));
  for (const k of keys) {
    const values = parts.map(p => p[k]);
    if (k === "lifts_total" || k === "runs_total") out[k] = sumOf(values);
    else if (k === "days_recorded") out[k] = Math.max(...values.filter(v => v != null), 0);
    else if (values.some(v => typeof v === "number")) out[k] = avgOf(values);
    else out[k] = null;
  }
  return out;
}

/** Add the areas to the index as resort-like entries (so pages, tables and search can show
 *  them) and give them season summaries. Called once, right after lifts.json is loaded. */
function injectAreas() {
  for (const [aid, a] of Object.entries(state.index.areas || {})) {
    const members = (a.resorts || []).filter(id => state.index.resorts[id]);
    if (!members.length || state.index.resorts[aid]) { delete state.index.areas[aid]; continue; }
    const first = state.index.resorts[members[0]];
    const night = members.map(id => state.index.resorts[id].night_skiing).find(Boolean);
    const heights = Object.fromEntries(["summit", "base"].map(level =>
      [level, avgOf(members.map(id => state.index.resorts[id].elevation_m?.[level]), 0)]));
    state.index.resorts[aid] = {
      name: a.name, region: a.region || first.region, country: a.country || first.country,
      group: first.group, timezone: a.timezone || first.timezone,
      source_url: a.source_url || first.source_url, website: a.website, map: a.map,
      area: true, members, ...(night ? { night_skiing: night } : {}),
      // average heights (shown on its temperature boxes; there's no location, so live
      // temperatures are its resorts' averages, see fetchLive)
      ...(heights.summit != null ? { elevation_m: heights } : {}),
    };
    for (const s of Object.values(state.index.seasons || {})) {
      const parts = members.map(id => s.summary?.[id]).filter(Boolean);
      if (parts.length) (s.summary ||= {})[aid] = combineSummaries(parts);
    }
  }
}

/** Every day of a season gets each area's combined record (when any of its resorts has one). */
function addAreaRecords(days) {
  for (const aid of areaIds()) {
    const members = membersOf(aid);
    for (const d of days) {
      const rec = combineRecords(aid, members.map(id => [id, d.results[id] || null]));
      if (rec) d.results[aid] = rec;
    }
  }
}

/** Live temperatures / forecast of an area: averages of its resorts'. */
function combineLevels(values) {
  const out = {};
  for (const level of ["summit", "base"]) {
    const parts = values.map(v => v?.[level]).filter(Boolean);
    if (!parts.length) continue;
    const o = {};
    for (const k of new Set(parts.flatMap(p => Object.keys(p)))) {
      const vals = parts.map(p => p[k]);
      if (k === "code") o[k] = vals.find(c => SNOW_CODES.includes(c)) ?? vals[0];
      else if (k === "time") o[k] = vals.filter(Boolean).sort().pop();
      else if (k === "snowfall") o[k] = Math.max(...vals.filter(v => v != null), 0);
      else if (vals.some(v => typeof v === "number")) o[k] = avgOf(vals);
    }
    out[level] = o;
  }
  return out;
}

// ------------------------------------------------------------------ area pages

/** The area's resorts: name, lifts and runs open now (or in the period), buttons to open each
 *  resort and to add it to Compare. `cellsOf(id)` gives the numbers; `href(id)` the link. */
function areaMembersHtml(aid, numbersOf, href) {
  return `
    <section class="area-members" aria-labelledby="members-title">
      <h2 id="members-title">Resorts in ${esc(state.index.resorts[aid].name)}</h2>
      <div class="member-cards">${membersOf(aid).map(id => `
        <div class="member-card">
          <a class="member-name" href="${esc(href(id))}">${esc(state.index.resorts[id].name)}</a>
          <div class="member-numbers">${numbersOf(id)}</div>
          <div class="member-buttons">
            <a class="button button-small" href="${esc(href(id))}">Open ›</a>
            <button type="button" class="button button-small button-secondary" data-compare-member="${esc(id)}">+ Compare</button>
          </div>
        </div>`).join("")}</div>
    </section>`;
}

/** Wire the member "+ Compare" buttons and the "Compare all" button. `period`: {unit, value}
 *  (the history page's period; the present page uses the latest season). */
function setupAreaButtons(aid, period) {
  const titleEl = view.querySelector(".page-title");
  view.querySelectorAll("[data-compare-member]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.compareMember;
    const p = period || { unit: "season", value: seasonOf(latestDateOf(id) || todayIso()) };
    addToCompareWithAnimation(id, p.unit, p.value, titleEl, b);
  }));
  view.querySelector("[data-compare-area]")?.addEventListener("click", () => {
    const p = period || { unit: "season", value: seasonOf(latestDateOf(aid) || todayIso()) };
    compareArea(aid, p.unit, p.value);
  });
}

/** Load every resort of the area into Compare (graph mode) for the period's season and open
 *  it. Resorts already there stay, unless there's no room for all of the area's. */
function compareArea(aid, unit, value) {
  const s = compareState({ defaults: false });
  const c = compareUnitOf(unit, value);
  const season = c.unit === "season" ? c.value : seasonOf(`${c.value}-15`);
  const members = membersOf(aid);
  const has = id => s.items.some(x => x.id === id && x.season === season);
  const missing = members.filter(id => !has(id));
  if (s.items.length + missing.length > MAX_ITEMS) s.items = s.items.filter(x => members.includes(x.id) && x.season === season);
  for (const id of members) if (!has(id)) s.items.push({ id, season });
  s.items = s.items.slice(0, MAX_ITEMS);
  s.mode = "graph";
  if (c.unit === "season") s.range = { kind: "season" };
  else { const m = Number(c.value.slice(5)); s.range = { kind: "months", from: m, to: m }; }
  saveCompare(s);
  location.hash = "#/compare";
}

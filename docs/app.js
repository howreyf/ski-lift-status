// Reads data/lifts.json and shows one day's lift status for every resort.

const DATA_URL = "data/lifts.json";
const NA = "N/A";
const STATUS_LABEL = { open: "Open", hold: "On hold", closed: "Closed", unknown: "Unknown" };
const RUN_STATUS_LABEL = { open: "Open", partial: "Partly open", closed: "Closed", unknown: "Unknown" };

const app = document.getElementById("app");
const dateSelect = document.getElementById("date");
const updatedEl = document.getElementById("updated");

let data = null;

// ------------------------------------------------------------ helpers

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Number with unit, or N/A when the resort doesn't publish it. */
function num(value, unit = "") {
  return value === null || value === undefined ? NA : `${value}${unit}`;
}

/** "2026-11-27T09:02:14+09:00" -> "27 Nov 2026, 09:02 JST" */
function formatJst(iso) {
  if (!iso) return NA;
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time} JST`;
}

/** "2026-11-27" -> "Fri 27 Nov 2026" */
function formatDay(day) {
  const d = new Date(`${day}T12:00:00+09:00`);
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Ski season label used in the data file: Jul–Jun, e.g. "2026-27". */
function seasonOf(day) {
  const year = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 7 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Whole days between the resort's own "last updated" time and the day we scraped. */
function daysStale(sourceUpdated, day) {
  if (!sourceUpdated) return 0;
  const src = sourceUpdated.slice(0, 10);
  return Math.round((new Date(day) - new Date(src)) / 86400000);
}

// ------------------------------------------------------------ rendering

/** Load a season's file once and keep it for later date changes. */
const seasonCache = new Map();
function loadSeason(label) {
  if (!seasonCache.has(label)) {
    const file = data.seasons[label]?.file;
    const promise = fetch(`data/${file}`, { cache: "no-cache" }).then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${file}`);
      return resp.json();
    });
    promise.catch(() => seasonCache.delete(label)); // allow a retry after a failed load
    seasonCache.set(label, promise);
  }
  return seasonCache.get(label);
}

async function showDay(day) {
  const label = seasonOf(day);
  if (!seasonCache.has(label)) app.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const seasonData = await loadSeason(label);
    if (dateSelect.value !== day) return; // user picked another date while this was loading
    renderDay(day, seasonData.days.find(d => d.date === day), data.seasons[label]?.summary || {});
  } catch (err) {
    app.innerHTML = `<p class="error">Couldn't load the data for ${esc(formatDay(day))} (${esc(err.message)}).</p>`;
  }
}

function renderDay(day, record, season) {

  // Group resorts by region, keeping the order they appear in the data file.
  const regions = new Map();
  for (const [id, info] of Object.entries(data.resorts)) {
    if (!regions.has(info.region)) regions.set(info.region, []);
    regions.get(info.region).push([id, info]);
  }

  let html = renderOverview(regions, record, season);
  for (const [region, resorts] of regions) {
    html += `<h2 class="region">${esc(region)}</h2>`;
    for (const [id, info] of resorts) {
      html += renderResort(id, info, record?.results?.[id], season[id] || {}, day);
    }
  }
  app.innerHTML = html || `<p class="muted">No resorts in the data file yet.</p>`;
}

/** One-row-per-resort summary table at the top of the page. */
function renderOverview(regions, record, season) {
  let rows = "";
  for (const [region, resorts] of regions) {
    for (const [id, info] of resorts) {
      const r = record?.results?.[id];
      const total = season[id]?.lifts_total ?? r?.lifts?.length;
      let cells;
      if (!r) {
        cells = `<td colspan="4" class="muted">No data</td>`;
      } else if (!r.ok) {
        cells = `<td colspan="4" class="warn">Couldn't read page</td>`;
      } else {
        const runs = r.runs_open === null || r.runs_open === undefined ? NA : `${r.runs_open} / ${num(season[id]?.runs_total)}`;
        cells = `
          <td class="num"><strong>${r.lifts_open}</strong> / ${total}</td>
          <td class="num">${runs}</td>
          <td class="num">${num(r.snow_depth_cm, " cm")}</td>
          <td class="num hide-sm">${num(r.new_snow_cm, " cm")}</td>`;
      }
      // Temperatures come from Open-Meteo, so they're there even if the resort's page failed.
      cells += `
          <td class="num hide-sm">${lowHigh(r?.temps?.summit)}</td>
          <td class="num hide-sm">${lowHigh(r?.temps?.base)}</td>`;
      rows += `<tr><td><a href="#resort-${esc(id)}">${esc(info.name)}</a><span class="ja">${esc(region)}</span></td>${cells}</tr>`;
    }
  }
  const kinds = new Set(Object.values(record?.results || {}).map(r => r.temps?.kind).filter(Boolean));
  const tempNote = kinds.has("forecast")
    ? "Summit and base temperatures are today's <strong>forecast</strong> low / high; they're replaced by the final values tomorrow."
    : kinds.has("final") ? "Summit and base temperatures are the day's final low / high." : "";
  return `
    <section class="card overview">
      <table>
        <thead><tr><th>Resort</th><th>Lifts open</th><th>Runs open</th><th>Snow depth</th>
          <th class="hide-sm">New snow</th><th class="hide-sm">Summit °C<br><small>low / high</small></th>
          <th class="hide-sm">Base °C<br><small>low / high</small></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${tempNote ? `<p class="muted small hide-sm">${tempNote}</p>` : ""}
    </section>`;
}

/** 1 -> "1.0", -11.4 -> "-11.4" (temperatures always with one decimal) */
function deg(v) {
  return Number(v).toFixed(1);
}

/** {min_c, max_c} -> "-11.4 / 1.0" */
function lowHigh(t) {
  return t ? `${deg(t.min_c)} / ${deg(t.max_c)}` : NA;
}

/** Stat box for one height: "Summit 1,200 m" / "-11.4 to 1.0 °C" / "forecast". */
function tempStat(level, t, fallbackElevation, kind) {
  const elevation = t?.elevation_m ?? fallbackElevation;
  const label = `${level}${elevation ? ` ${Number(elevation).toLocaleString("en-GB")} m` : ""}`;
  if (!t) return stat(label, NA);
  const note = kind === "forecast" ? "forecast" : "day's low / high";
  return stat(label, `${deg(t.min_c)} <small>to</small> ${deg(t.max_c)} <small>°C</small><div class="stat-note">${note}</div>`);
}

function renderResort(id, info, result, seasonInfo, day) {
  const head = `
    <div class="card-head" id="resort-${esc(id)}">
      <h3><a href="${esc(info.source_url)}" target="_blank" rel="noopener">${esc(info.name)}</a></h3>
      ${result?.ok ? sourceNote(result.source_updated, day) : ""}
    </div>`;

  if (!result) {
    return `<section class="card">${head}<p class="muted">No data for this day.</p></section>`;
  }
  if (!result.ok) {
    return `<section class="card">${head}
      <p class="error">Couldn't read the resort's page this day.</p>
      <p class="muted small">${esc(result.error)}</p></section>`;
  }

  const lifts = result.lifts;
  const liftsTotal = seasonInfo.lifts_total ?? lifts.length;
  const runs = result.runs_open === null || result.runs_open === undefined
    ? NA
    : `${result.runs_open} <small>/ ${num(seasonInfo.runs_total)}</small>`;

  const stats = `
    <div class="stats">
      ${stat("Lifts open", `${result.lifts_open} <small>/ ${liftsTotal}</small>`)}
      ${stat("Runs open", runs)}
      ${stat("Snow depth", num(result.snow_depth_cm, " cm"))}
      ${stat("New snow", num(result.new_snow_cm, " cm"))}
      ${tempStat("Summit", result.temps?.summit, info.elevation_m?.summit, result.temps?.kind)}
      ${tempStat("Base", result.temps?.base, info.elevation_m?.base, result.temps?.kind)}
      ${stat("Resort reading", `${num(result.temperature_c, " °C")}<div class="stat-note">from the resort's page</div>`)}
    </div>`;

  const seasonLine = seasonInfo.days_recorded ? `
    <p class="season">Season ${esc(seasonOf(day))}:
      max snow depth ${num(seasonInfo.snow_depth_max_cm, " cm")}${seasonInfo.snow_depth_max_date ? ` (${esc(formatDay(seasonInfo.snow_depth_max_date))})` : ""}
      · summit ${tempRange(seasonInfo.summit_min_c, seasonInfo.summit_max_c)}
      · base ${tempRange(seasonInfo.base_min_c, seasonInfo.base_max_c)}
      · ${seasonInfo.days_recorded} day${seasonInfo.days_recorded === 1 ? "" : "s"} recorded</p>` : "";

  const strip = `<div class="strip" aria-hidden="true">${
    lifts.map(l => `<span class="s-${esc(l.status)}" title="${esc(l.name_en)}: ${esc(STATUS_LABEL[l.status])}"></span>`).join("")
  }</div>`;

  const rows = lifts.map(l => `
    <tr>
      <td>${esc(l.name_en)}${l.name !== l.name_en ? `<span class="ja" lang="ja">${esc(l.name)}</span>` : ""}</td>
      <td><span class="badge s-${esc(l.status)}">${esc(STATUS_LABEL[l.status])}</span></td>
      <td class="num">${esc(l.hours)}</td>
      <td class="hide-sm">${esc(l.lift_type)}</td>
      <td class="hide-sm muted small" lang="ja">${esc(l.raw)}</td>
    </tr>`).join("");

  return `
    <section class="card">
      ${head}
      ${stats}
      ${seasonLine}
      ${strip}
      <details${Object.keys(data.resorts).length === 1 ? " open" : ""}>
        <summary>Show all ${lifts.length} lifts</summary>
        <table>
          <thead><tr><th>Lift</th><th>Status</th><th>Hours</th><th class="hide-sm">Type</th><th class="hide-sm">Resort's wording</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
      ${renderRuns(result.runs || [])}
    </section>`;
}

function renderRuns(runs) {
  if (!runs.length) return `<p class="muted small">Run status: ${NA}</p>`;
  const rows = runs.map(r => `
    <tr>
      <td>${esc(r.name_en)}${r.name !== r.name_en ? `<span class="ja" lang="ja">${esc(r.name)}</span>` : ""}</td>
      <td><span class="badge s-${esc(r.status)}">${esc(RUN_STATUS_LABEL[r.status])}</span></td>
      <td>${esc(r.level)}</td>
      <td class="hide-sm muted small" lang="ja">${esc(r.raw)}</td>
    </tr>`).join("");
  return `
      <details>
        <summary>Show all ${runs.length} runs</summary>
        <table>
          <thead><tr><th>Run</th><th>Status</th><th>Level</th><th class="hide-sm">Resort's wording</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
}

function stat(label, value) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;
}

/** Season range from the final daily lows/highs; N/A until the first day is final. */
function tempRange(min, max) {
  if (min === null || min === undefined) return `${NA} <small>(after the first full day)</small>`;
  return `${deg(min)} to ${deg(max)} °C`;
}

function sourceNote(sourceUpdated, day) {
  if (!sourceUpdated) return `<span class="muted small">Resort update time: ${NA}</span>`;
  const stale = daysStale(sourceUpdated, day);
  const text = `Resort last updated ${esc(formatJst(sourceUpdated))}`;
  return stale >= 1
    ? `<span class="small warn" title="The resort hadn't refreshed its page, so this may be older information.">${text} (${stale} day${stale === 1 ? "" : "s"} earlier)</span>`
    : `<span class="muted small">${text}</span>`;
}

// ------------------------------------------------------------ start

async function start() {
  try {
    const resp = await fetch(DATA_URL, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    app.innerHTML = `<p class="error">Couldn't load ${esc(DATA_URL)} (${esc(err.message)}).</p>
      <p class="muted small">If you opened this file directly, run <code>python -m http.server -d docs</code>
      in the project folder and visit <a href="http://localhost:8000">http://localhost:8000</a> instead.</p>`;
    return;
  }

  updatedEl.textContent = `Last updated: ${formatJst(data.last_updated)}`;
  showSeasonNote();

  // Date picker: newest season first, newest day first, grouped by season.
  const labels = Object.keys(data.seasons || {}).sort().reverse();
  const days = labels.flatMap(l => [...(data.seasons[l].dates || [])].sort().reverse());
  if (!days.length) {
    app.innerHTML = `<p class="muted">No data yet.</p>`;
    return;
  }
  dateSelect.innerHTML = labels.map(l => `
    <optgroup label="Season ${esc(l)}">
      ${[...(data.seasons[l].dates || [])].sort().reverse()
        .map(d => `<option value="${esc(d)}">${esc(formatDay(d))}</option>`).join("")}
    </optgroup>`).join("");

  // Remember the chosen day in the URL (…/#2026-11-27) so it can be shared.
  const fromHash = location.hash.slice(1);
  dateSelect.value = days.includes(fromHash) ? fromHash : days[0];
  dateSelect.addEventListener("change", () => {
    history.replaceState(null, "", `#${dateSelect.value}`);
    showDay(dateSelect.value);
  });
  showDay(dateSelect.value);
}

/** Between seasons, explain why there's no new data. */
function showSeasonNote() {
  const months = data.season_months;
  if (!months) return;
  const now = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Tokyo", month: "numeric" }));
  const inSeason = months.start <= months.end
    ? now >= months.start && now <= months.end
    : now >= months.start || now <= months.end;
  if (inSeason) return;
  const name = m => new Date(2000, m - 1, 1).toLocaleString("en-GB", { month: "long" });
  const note = document.getElementById("season-note");
  note.textContent = `Off-season: lift status is collected ${name(months.start)}–${name(months.end)}. ` +
    `Showing the last day recorded; new data starts again in ${name(months.start)}.`;
  note.hidden = false;
}

start();

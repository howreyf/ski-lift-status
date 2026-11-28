// Sorting the resort tables (Resorts tab and Historical tab).
//
// A "Sort" button beside the "Find resort" search opens a small panel: sort by number of
// runs or lifts, lifts or runs open, runs (or runs open) of one difficulty, snow depth,
// temperature or night skiing; high to low or low to high; and "Keep resorts in their
// regions" (sorted inside each region dropdown) or one list for all resorts. Resorts with no
// value (N/A) always go last. The choice is shared by both tabs and kept in the browser.
// On the Historical tab the values are for the chosen season or month (peak open, means).
// Loaded before app.js; uses its helpers at run time.

"use strict";

const SORT_KEYS = [
  { key: "default", label: "Region (default order)" },
  { key: "runsTotal", label: "Number of runs" },
  { key: "liftsTotal", label: "Number of lifts" },
  { key: "liftsOpen", label: "Lifts open", hist: "Peak lifts open" },
  { key: "runsOpen", label: "Runs open", hist: "Peak runs open" },
  { key: "runsGrade", label: "Runs by difficulty", grade: true },
  { key: "runsOpenGrade", label: "Runs open by difficulty", hist: "Peak runs open by difficulty", grade: true },
  { key: "depth", label: "Snow depth", hist: "Mean snow depth" },
  { key: "temp", label: "Base temperature", hist: "Mean base temperature" },
  { key: "night", label: "Night skiing" },
];

let sortPanelOpen = false; // keep the panel open while the table redraws after a change
let activeSort = null;     // while rows are drawn: {s, valueOf} for the small value under each name

function sortGrades() {
  return GRADES.filter(g => g.key !== "other");
}

function sortState() {
  let s;
  try { s = JSON.parse(localStorage.getItem("resortSort")) || {}; } catch { s = {}; }
  return {
    key: SORT_KEYS.some(k => k.key === s.key) ? s.key : "default",
    grade: sortGrades().some(g => g.key === s.grade) ? s.grade : "black",
    desc: s.desc !== false,
    regions: s.regions !== false,
  };
}
function saveSort(s) {
  try { localStorage.setItem("resortSort", JSON.stringify(s)); } catch { /* ignore */ }
}

function sortKeyInfo(key) {
  return SORT_KEYS.find(k => k.key === key);
}
function gradeWord(grade) {
  return { green: "green", red: "red", black: "black", orange: "expert" }[grade];
}
/** "Snow depth", "Runs open (black)", "Peak lifts open" ... */
function sortLabel(s, hist) {
  const k = sortKeyInfo(s.key);
  const label = (hist && k.hist) || k.label;
  return k.grade ? `${label.replace(" by difficulty", "")} (${gradeWord(s.grade)})` : label;
}

// ------------------------------------------------------------------ values

function runsOfGrade(runs, grade, openOnly = false) {
  if (!runs?.length || !runs.some(r => gradeOf(r.level).key !== "other")) return null; // no levels published
  return runs.filter(r => gradeOf(r.level).key === grade && (!openOnly || r.status === "open" || r.status === "partial")).length;
}

/** Resorts tab: today's (live) values. */
function presentSortValue(id, s) {
  if (s.key === "night") return nightSkiing(id, state.latestDate) ? 1 : 0;
  const r = currentResult(id);
  if (s.key === "liftsTotal") return seasonSummary(id).lifts_total ?? (r?.ok ? r.lifts.length : null);
  if (s.key === "temp") {
    const live = state.live[id]?.base;
    if (live) return live.temp;
    const t = todayResult(id)?.temps?.base;
    return t ? (t.min_c + t.max_c) / 2 : null;
  }
  if (!r?.ok) return null;
  const runs = r.runs?.length ? r.runs : null;
  switch (s.key) {
    case "runsTotal": return runs ? runs.length : null;
    case "liftsOpen": return r.lifts_open;
    case "runsOpen": return runs ? r.runs_open : null;
    case "runsGrade": return runsOfGrade(runs, s.grade);
    case "runsOpenGrade": return runsOfGrade(runs, s.grade, true);
    case "depth": return r.snow_depth_cm ?? null;
  }
  return null;
}

/** Historical tab: values over the chosen season or month. */
function historySortValue(id, s) {
  const st = historyDir.stats[id] || {};
  const ok = (st.recs || []).filter(x => x.r.ok);
  const withRuns = ok.filter(x => x.r.runs?.length);
  switch (s.key) {
    case "night": return nightSkiing(id, periodRange(historyDir.unit, historyDir.value)[0]) ? 1 : 0;
    case "runsTotal": return withRuns.length ? Math.max(...withRuns.map(x => x.r.runs.length)) : null;
    case "liftsTotal": return ok.length ? Math.max(...ok.map(x => x.r.lifts.length)) : null;
    case "liftsOpen": return st.lifts ? st.lifts.r.lifts_open : null;
    case "runsOpen": return st.runs ? st.runs.r.runs_open : null;
    case "runsGrade": return withRuns.length ? runsOfGrade(withRuns[withRuns.length - 1].r.runs, s.grade) : null;
    case "runsOpenGrade": {
      const counts = withRuns.map(x => runsOfGrade(x.r.runs, s.grade, true)).filter(v => v != null);
      return counts.length ? Math.max(...counts) : null;
    }
    case "depth": return st.depth ?? null;
    case "temp": return st.base ?? null;
  }
  return null;
}

/** Resorts in sorted order; no value (N/A) always last; ties keep the usual order. */
function orderIds(ids, valueOf, s) {
  if (s.key === "default") return ids;
  return ids.map((id, i) => ({ id, i, v: valueOf(id, s) }))
    .sort((a, b) => (a.v == null) - (b.v == null)
      || (a.v == null ? 0 : s.desc ? b.v - a.v : a.v - b.v)
      || a.i - b.i)
    .map(x => x.id);
}

/** The sorted-by value under a resort's name, for values the table doesn't show. */
function sortNoteHtml(id) {
  if (!activeSort) return "";
  const { s, valueOf } = activeSort;
  if (!["runsTotal", "liftsTotal", "runsGrade", "runsOpenGrade"].includes(s.key)) return "";
  const v = valueOf(id, s);
  const text = v == null ? "N/A"
    : s.key === "runsTotal" ? `${v} runs`
    : s.key === "liftsTotal" ? `${v} lifts`
    : s.key === "runsGrade" ? `${v} ${gradeWord(s.grade)} run${v === 1 ? "" : "s"}`
    : `${v} ${gradeWord(s.grade)} open${activeSort.hist ? " at peak" : ""}`;
  return `<span class="sort-note">${esc(text)}</span>`;
}

// ------------------------------------------------------------------ table groups

/** Pinned group, then either the region dropdowns (each sorted) or one sorted list. */
function resortGroupsHtml(rowFn, valueOf, hist) {
  const s = sortState();
  const order = ids => orderIds(ids, valueOf, s);
  activeSort = s.key === "default" ? null : { s, valueOf, hist };
  const pinned = pins.list();
  const closed = closedRegions();
  let html = "";
  if (pinned.length) {
    html += `
      <section class="group group-pinned">
        <h2 class="group-title">${pinIcon(true)} Pinned <span class="count">${pinned.length} / ${MAX_PINS}</span></h2>
        ${order(pinned).map(rowFn).join("")}
      </section>`;
  }
  if (s.key === "default" || s.regions) {
    for (const [region, ids] of regions()) {
      html += `
        <details class="group region" data-region="${esc(region)}"${closed.includes(region) ? "" : " open"}>
          <summary class="group-title">${esc(region)} <span class="count">${ids.length}</span></summary>
          ${order(ids).map(rowFn).join("")}
        </details>`;
    }
  } else {
    html += `
      <section class="group group-sorted">
        <h2 class="group-title">${SORT_ICON} ${esc(sortLabel(s, hist))}
          <span class="count">${s.key === "night" ? (s.desc ? "night skiing first" : "night skiing last") : s.desc ? "high to low" : "low to high"}</span></h2>
        ${order(resortIds()).map(rowFn).join("")}
      </section>`;
  }
  activeSort = null;
  return html;
}

// ------------------------------------------------------------------ the button and panel

const SORT_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The search box with the Sort button beside it. */
function searchRowHtml(hist) {
  const s = sortState();
  const on = s.key !== "default";
  const arrow = s.key === "night" ? "" : s.desc ? " ↓" : " ↑";
  const keyRow = k => {
    const label = esc((hist && k.hist) || k.label);
    return `
      <label class="sort-opt">
        <input type="radio" name="sort-key" value="${k.key}"${k.key === s.key ? " checked" : ""}>
        <span>${label}</span>
        ${k.grade ? `<select data-sort-grade="${k.key}" aria-label="Difficulty">${sortGrades().map(g =>
          `<option value="${g.key}"${g.key === s.grade ? " selected" : ""}>${esc(gradeWord(g.key))}</option>`).join("")}</select>` : ""}
      </label>`;
  };
  return `
    <div class="search-row">
      ${searchHtml()}
      <div class="sort">
        <button type="button" class="sort-button${on ? " is-on" : ""}" aria-haspopup="dialog" aria-expanded="false">
          ${SORT_ICON}<span>Sort${on ? `: ${esc(sortLabel(s, hist))}${arrow}` : ""}</span>
        </button>
        <div class="sort-pop" role="dialog" aria-label="Sort resorts" hidden>
          <div class="sort-title">Sort by</div>
          <div class="sort-opts">${SORT_KEYS.map(keyRow).join("")}</div>
          ${on ? `
            <div class="seg sort-dir" role="radiogroup" aria-label="Order">
              <button type="button" role="radio" class="seg-btn${s.desc ? " is-active" : ""}" aria-checked="${s.desc}" data-sort-desc="1">${s.key === "night" ? "Night skiing first" : "High to low"}</button>
              <button type="button" role="radio" class="seg-btn${!s.desc ? " is-active" : ""}" aria-checked="${!s.desc}" data-sort-desc="0">${s.key === "night" ? "Night skiing last" : "Low to high"}</button>
            </div>` : ""}
          <label class="sort-check"><input type="checkbox" data-sort-regions${s.regions ? " checked" : ""}${on ? "" : " disabled"}>
            Keep resorts in their regions</label>
        </div>
      </div>
    </div>`;
}

/** Wire up the Sort panel; `redraw` re-renders the page after a change. */
function setupSort(root, redraw) {
  const wrap = root.querySelector(".sort");
  if (!wrap) return;
  const button = wrap.querySelector(".sort-button");
  const pop = wrap.querySelector(".sort-pop");
  const s = sortState();
  const open = () => { pop.hidden = false; button.setAttribute("aria-expanded", "true"); sortPanelOpen = true; };
  const close = () => { pop.hidden = true; button.setAttribute("aria-expanded", "false"); sortPanelOpen = false; };
  const change = () => { saveSort(s); sortPanelOpen = true; redraw(); };

  button.addEventListener("click", e => { e.stopPropagation(); pop.hidden ? open() : close(); });
  pop.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", function outside(e) {
    if (!document.body.contains(wrap)) { document.removeEventListener("click", outside); return; }
    if (!wrap.contains(e.target)) close();
  });
  wrap.addEventListener("keydown", e => { if (e.key === "Escape") { close(); button.focus(); } });

  pop.querySelectorAll('input[name="sort-key"]').forEach(r => r.addEventListener("change", () => {
    s.key = r.value;
    s.desc = true;
    change();
  }));
  pop.querySelectorAll("[data-sort-grade]").forEach(sel => sel.addEventListener("change", () => {
    s.grade = sel.value;
    s.key = sel.dataset.sortGrade; // picking a difficulty also picks that option
    change();
  }));
  pop.querySelectorAll("[data-sort-desc]").forEach(b => b.addEventListener("click", () => {
    s.desc = b.dataset.sortDesc === "1";
    change();
  }));
  pop.querySelector("[data-sort-regions]").addEventListener("change", e => { s.regions = e.target.checked; change(); });

  if (sortPanelOpen) open();
}

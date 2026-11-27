// "The graph": values over a period, as 2px lines (one value per day) or as bars
// (one bar per day / week / month).
//
//   - hover: a crosshair snaps to the nearest day (or bar) and a small box shows its details
//     (it disappears when the pointer leaves the graph)
//   - click: the small box stays (pinned) until another part of the graph is clicked, or
//     anywhere else on the page is clicked
//   - optional "Go to specific day" button(s) in the small box
//   - keyboard: focus the graph, then ← → move between days, Enter = go to that day, Esc = close
//   - vertical reference lines mark events such as the opening and closing day
//   - several lines (series): each with its own colour (dashed for the 9th and 10th), a legend
//     above the graph, labels at the line ends when there are 4 or fewer, and one small box
//     listing every line at that day
//
// Usage (one line or bars):
//   createGraph(element, {
//     kind: "line" | "bars",
//     start: "2026-11-01", end: "2027-05-31",        // x range (inclusive)
//     points: [{date: "2026-11-28", value: 5, ...}], // line: days without data are gaps
//                                                     // bars: {date: first day, end: last day, value}
//     yMin, yMax, integer (whole-number axis), yLabel, markers: [{date, label}],
//     details: point => "<html>",
//     onGoToDay: date => {...},                       // optional "Go to specific day" button
//   })
// Several lines:
//   createGraph(element, { start, end, yLabel, ySuffix: "%",
//     series: [{key, label, color, dashed, points: [{date, value, ...}]}],
//     details: (date, rows) => "<html>",              // rows: [{series, point}] at that day
//     onGoToDay: (seriesKey, point) => {...},         // a button per line in the small box
//   })
// Returns {destroy()}.

"use strict";

const GRAPH_HEIGHT = 280;
const GRAPH_MARGIN = { top: 26, right: 18, bottom: 34, left: 44 };

function dayNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function isoFromDayNumber(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** Round axis ticks covering lo..hi (lo may be negative), about 5 steps. */
function niceTicks(lo, hi, integer = false) {
  if (hi <= lo) hi = lo + 1;
  const rough = (hi - lo) / 5;
  const pow = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 5, 10].map(s => s * pow).find(s => s >= rough) || pow * 10;
  if (integer) step = Math.max(1, Math.round(step)); // counts (lifts, runs): whole numbers only
  const first = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = first; v < hi + step - 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

function xTicks(start, end) {
  const s = dayNumber(start), e = dayNumber(end), span = e - s;
  const out = [];
  for (let n = s; n <= e; n++) {
    const d = new Date(n * 86400000);
    if (span > 62 ? d.getUTCDate() === 1 : span > 13 ? d.getUTCDay() === 0 : true) {
      const label = span > 62
        ? d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })
        : span > 13
          ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
          : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
      out.push({ n, label });
    }
  }
  return out;
}

function createGraph(el, opts) {
  const { kind = "line", start, end, yLabel, markers = [], details, onGoToDay } = opts;
  const multi = Array.isArray(opts.series);
  const series = (multi ? opts.series : [{ key: "_", label: yLabel, color: null, points: opts.points }])
    .map(s => ({ ...s, points: [...s.points].sort((a, b) => a.date.localeCompare(b.date)) }));
  const showLegend = multi && series.length >= 1;
  const endLabels = multi && series.length <= 4;

  // x positions: every date with a value in any series (bars: one per bar)
  const xs = kind === "bars"
    ? series[0].points.map(p => p.date)
    : [...new Set(series.flatMap(s => s.points.map(p => p.date)))].sort();
  const byDate = series.map(s => new Map(s.points.map(p => [p.date, p])));
  let pinned = null;   // index into xs, or null
  let hovered = null;
  let width = 0;

  el.innerHTML = `
    ${showLegend ? `<div class="graph-legend" aria-label="Lines">${series.map(s => `
      <span class="legend-item"><svg width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5"
        stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="5 4"' : ""}/></svg>${esc(s.label)}</span>`).join("")}</div>` : ""}
    <div class="graph" tabindex="0" role="group"
      aria-label="${esc(yLabel)}. Use the left and right arrow keys to move between ${kind === "bars" ? "bars" : "days"}${onGoToDay ? " and Enter to open a day" : ""}.">
      <svg class="graph-svg" height="${GRAPH_HEIGHT}" aria-hidden="true"></svg>
      <div class="graph-tip" hidden></div>
      ${xs.length ? "" : `<div class="graph-empty">No data recorded in this period.</div>`}
    </div>`;
  const wrap = el.querySelector(".graph");
  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector(".graph-tip");

  const s0 = dayNumber(start), s1 = dayNumber(end) + 1;
  const values = series.flatMap(s => s.points.map(p => p.value));
  const lo = Math.min(opts.yMin ?? 0, ...values, 0);
  const hi = Math.max(opts.yMax ?? 0, ...values, lo + 1);
  const ticks = niceTicks(lo, hi, !!opts.integer);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];
  const x = n => GRAPH_MARGIN.left + ((n - s0) / (s1 - s0)) * (width - GRAPH_MARGIN.left - GRAPH_MARGIN.right - (endLabels ? 70 : 0));
  const y = v => GRAPH_MARGIN.top + (1 - (v - yLo) / (yHi - yLo)) * (GRAPH_HEIGHT - GRAPH_MARGIN.top - GRAPH_MARGIN.bottom);
  const xOfDate = d => x(dayNumber(d) + 0.5);
  const xOfBar = p => (x(dayNumber(p.date)) + x(dayNumber(p.end || p.date) + 1)) / 2;
  const xAt = i => (kind === "bars" ? xOfBar(series[0].points[i]) : xOfDate(xs[i]));
  const suffix = opts.ySuffix || "";

  function draw() {
    width = Math.max(300, wrap.clientWidth);
    svg.setAttribute("width", width);
    svg.setAttribute("viewBox", `0 0 ${width} ${GRAPH_HEIGHT}`);
    const plotBottom = GRAPH_HEIGHT - GRAPH_MARGIN.bottom;
    const plotRight = width - GRAPH_MARGIN.right - (endLabels ? 70 : 0);
    let html = "";

    for (const t of ticks) {
      html += `<line class="g-grid${t === 0 && yLo < 0 ? " g-zero" : ""}" x1="${GRAPH_MARGIN.left}" x2="${plotRight}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="g-axis" x="${GRAPH_MARGIN.left - 8}" y="${y(t) + 4}" text-anchor="end">${t}${suffix}</text>`;
    }
    const xt = xTicks(start, end);
    const every = Math.max(1, Math.ceil(xt.length / Math.max(1, Math.floor((plotRight - 60) / 56))));
    xt.forEach((t, i) => {
      if (i % every) return;
      html += `<line class="g-tick" x1="${x(t.n)}" x2="${x(t.n)}" y1="${plotBottom}" y2="${plotBottom + 4}"/>
        <text class="g-axis" x="${x(t.n)}" y="${plotBottom + 18}" text-anchor="start">${esc(t.label)}</text>`;
    });
    for (const m of markers) {
      const n = dayNumber(m.date) + 0.5;
      if (n < s0 || n > s1) continue;
      const anchor = x(n) > plotRight - 90 ? "end" : x(n) < 90 ? "start" : "middle";
      html += `<line class="g-marker" x1="${x(n)}" x2="${x(n)}" y1="${GRAPH_MARGIN.top - 6}" y2="${plotBottom}"/>
        <text class="g-marker-label" x="${x(n)}" y="${GRAPH_MARGIN.top - 10}" text-anchor="${anchor}">${esc(m.label)}</text>`;
    }

    if (kind === "bars") {
      series[0].points.forEach((p, i) => {
        const x0 = x(dayNumber(p.date)), x1 = x(dayNumber(p.end || p.date) + 1);
        const w = Math.max(1, Math.min(24, x1 - x0 - 2));
        const bx = (x0 + x1) / 2 - w / 2;
        const top = y(Math.max(0, p.value)), base = y(0);
        const h = base - top;
        if (h <= 0) return;
        const r = Math.min(4, w / 2, h);
        html += `<path class="g-bar" data-i="${i}" d="M${bx},${base} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + w - r} Q${bx + w},${top} ${bx + w},${top + r} V${base} Z"/>`;
      });
    } else {
      // End labels only when they don't collide (converging lines: legend + small box instead).
      const ends = series.filter(s => s.points.length).map(s => {
        const last = s.points[s.points.length - 1];
        return { x: xOfDate(last.date), y: y(last.value) };
      });
      const labelsFit = endLabels && ends.every((a, i) => ends.every((b, j) => i === j || Math.abs(a.y - b.y) >= 13 || Math.abs(a.x - b.x) >= 80));
      series.forEach((s, si) => {
        const style = s.color ? `style="stroke:${s.color}"` : "";
        let path = "", prev = null;
        for (const p of s.points) {
          const n = dayNumber(p.date);
          path += `${prev !== null && n - prev === 1 ? "L" : "M"}${xOfDate(p.date).toFixed(1)},${y(p.value).toFixed(1)} `;
          prev = n;
        }
        html += `<path class="g-line" ${style} ${s.dashed ? 'stroke-dasharray="6 4"' : ""} d="${path}"/>`;
        s.points.forEach((p, i) => {
          const n = dayNumber(p.date);
          const left = i > 0 && n - dayNumber(s.points[i - 1].date) === 1;
          const right = i < s.points.length - 1 && dayNumber(s.points[i + 1].date) - n === 1;
          if (!left && !right) html += `<circle class="g-dot" ${s.color ? `style="fill:${s.color}"` : ""} cx="${xOfDate(p.date)}" cy="${y(p.value)}" r="3.5"/>`;
        });
        if (labelsFit && s.points.length) {
          const last = s.points[s.points.length - 1];
          html += `<text class="g-end-label" x="${xOfDate(last.date) + 8}" y="${y(last.value) + 4}">${esc(s.short || s.label)}</text>`;
        }
        void si;
      });
    }
    html += `<line class="g-cross" y1="${GRAPH_MARGIN.top}" y2="${plotBottom}" visibility="hidden"/>
      <g class="g-focus-group"></g>
      <rect class="g-hit" x="${GRAPH_MARGIN.left}" y="0" width="${Math.max(0, plotRight - GRAPH_MARGIN.left)}" height="${GRAPH_HEIGHT}"/>`;
    svg.innerHTML = html;
    show(pinned ?? hovered);
  }

  function nearestIndex(clientX) {
    if (!xs.length) return null;
    const px = clientX - svg.getBoundingClientRect().left;
    let best = 0, bestDist = Infinity;
    xs.forEach((_, i) => {
      const d = Math.abs(xAt(i) - px);
      if (d < bestDist) { best = i; bestDist = d; }
    });
    return best;
  }

  function show(i) {
    const cross = svg.querySelector(".g-cross"), focus = svg.querySelector(".g-focus-group");
    svg.querySelectorAll(".g-bar.is-active").forEach(b => b.classList.remove("is-active"));
    if (i === null || i === undefined || xs[i] === undefined) {
      cross?.setAttribute("visibility", "hidden");
      if (focus) focus.innerHTML = "";
      tip.hidden = true;
      return;
    }
    const px = xAt(i);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    let content, buttons = "";
    if (kind === "bars") {
      svg.querySelector(`.g-bar[data-i="${i}"]`)?.classList.add("is-active");
      focus.innerHTML = "";
      content = details(series[0].points[i]);
    } else {
      const rows = series.map((s, si) => ({ series: s, point: byDate[si].get(xs[i]) })).filter(r => r.point);
      focus.innerHTML = rows.map(r => `<circle class="g-focus" ${r.series.color ? `style="fill:${r.series.color}"` : ""} cx="${px}" cy="${y(r.point.value)}" r="5"/>`).join("");
      if (multi) {
        content = details(xs[i], rows);
        if (onGoToDay) {
          buttons = `<div class="graph-go-list">${rows.map(r => `<button type="button" class="graph-go graph-go-small" data-series="${esc(r.series.key)}">Go to day · ${esc(r.series.short || r.series.label)}</button>`).join("")}</div>`;
        }
      } else {
        content = details(rows[0].point);
        if (onGoToDay) buttons = `<button type="button" class="graph-go">Go to specific day</button>`;
      }
    }
    tip.innerHTML = `${content}${buttons}${pinned !== null ? `<div class="graph-tip-hint">Pinned · click elsewhere to close</div>` : ""}`;
    tip.classList.toggle("is-pinned", pinned !== null);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${px + 14 + tw > width ? Math.max(4, px - 14 - tw) : px + 14}px`;
    tip.style.top = `${GRAPH_MARGIN.top}px`;
    tip.querySelectorAll(".graph-go").forEach(btn => btn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (!multi) return onGoToDay(xs[i]);
      const si = series.findIndex(s => s.key === btn.dataset.series);
      onGoToDay(series[si].key, byDate[si].get(xs[i]));
    }));
  }

  svg.addEventListener("pointermove", ev => {
    if (pinned !== null) return;
    hovered = nearestIndex(ev.clientX);
    show(hovered);
  });
  wrap.addEventListener("pointerleave", () => {
    hovered = null;
    if (pinned === null) show(null);
  });
  svg.addEventListener("click", ev => {
    ev.stopPropagation();
    pinned = nearestIndex(ev.clientX);
    show(pinned);
  });
  tip.addEventListener("click", ev => ev.stopPropagation());
  const onDocClick = ev => {
    if (pinned !== null && !wrap.contains(ev.target)) {
      pinned = null;
      show(null);
    }
  };
  document.addEventListener("click", onDocClick);

  wrap.addEventListener("keydown", ev => {
    if (!xs.length) return;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      const cur = pinned ?? hovered ?? (ev.key === "ArrowRight" ? -1 : xs.length);
      pinned = Math.max(0, Math.min(xs.length - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
      show(pinned);
    } else if (ev.key === "Enter" && pinned !== null && onGoToDay) {
      ev.preventDefault();
      tip.querySelector(".graph-go")?.click();
    } else if (ev.key === "Escape") {
      pinned = null;
      show(null);
    }
  });

  const ro = new ResizeObserver(() => { if (wrap.clientWidth !== width) draw(); });
  ro.observe(wrap);
  draw();

  return {
    destroy() {
      ro.disconnect();
      document.removeEventListener("click", onDocClick);
    },
  };
}

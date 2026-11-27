// "The graph": values over a period, as a 2px line (one value per day) or as bars
// (one bar per day / week / month).
//
//   - hover: a crosshair snaps to the nearest day (or bar) and a small box shows its details
//     (it disappears when the pointer leaves the graph)
//   - click: the small box stays (pinned) until another part of the graph is clicked, or
//     anywhere else on the page is clicked
//   - optional "Go to specific day" button in the small box (line graphs)
//   - keyboard: focus the graph, then ← → move between points, Enter = go to that day, Esc = close
//   - vertical reference lines mark events such as the opening and closing day
//
// Usage:
//   createGraph(element, {
//     kind: "line" | "bars",
//     start: "2026-11-01", end: "2027-05-31",        // x range (inclusive)
//     points: [{date: "2026-11-28", value: 5, ...}], // line: days without data are gaps
//                                                     // bars: {date: first day, end: last day, value}
//     yMin: 0, yMax: 9,                               // optional; temperatures can go below 0
//     yLabel: "Lifts open",
//     markers: [{date: "2026-11-28", label: "Opening day"}],
//     details: point => "<html>",                     // the small box's content
//     onGoToDay: date => {...},                       // optional: adds the "Go to specific day" button
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
function niceTicks(lo, hi) {
  if (hi <= lo) hi = lo + 1;
  const rough = (hi - lo) / 5;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(s => s * pow).find(s => s >= rough) || pow * 10;
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
  const { kind = "line", start, end, points, yLabel, markers = [], details, onGoToDay } = opts;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  let pinned = null;   // index into sorted, or null
  let hovered = null;
  let width = 0;

  el.innerHTML = `
    <div class="graph" tabindex="0" role="group"
      aria-label="${esc(yLabel)}. Use the left and right arrow keys to move between ${kind === "bars" ? "bars" : "days"}${onGoToDay ? " and Enter to open a day" : ""}.">
      <svg class="graph-svg" height="${GRAPH_HEIGHT}" aria-hidden="true"></svg>
      <div class="graph-tip" hidden></div>
      ${sorted.length ? "" : `<div class="graph-empty">No data recorded in this period.</div>`}
    </div>`;
  const wrap = el.querySelector(".graph");
  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector(".graph-tip");

  // x: one unit per day; bars span [date, end + 1)
  const s0 = dayNumber(start), s1 = dayNumber(end) + 1;
  const values = sorted.map(p => p.value);
  const lo = Math.min(opts.yMin ?? 0, ...values, 0);
  const hi = Math.max(opts.yMax ?? 0, ...values, lo + 1);
  const ticks = niceTicks(lo, hi);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];
  const x = n => GRAPH_MARGIN.left + ((n - s0) / (s1 - s0)) * (width - GRAPH_MARGIN.left - GRAPH_MARGIN.right);
  const y = v => GRAPH_MARGIN.top + (1 - (v - yLo) / (yHi - yLo)) * (GRAPH_HEIGHT - GRAPH_MARGIN.top - GRAPH_MARGIN.bottom);
  // where a point sits on the x axis: middle of its day (line) or of its bar
  const xOf = p => kind === "bars"
    ? (x(dayNumber(p.date)) + x(dayNumber(p.end || p.date) + 1)) / 2
    : x(dayNumber(p.date) + 0.5);

  function draw() {
    width = Math.max(300, wrap.clientWidth);
    svg.setAttribute("width", width);
    svg.setAttribute("viewBox", `0 0 ${width} ${GRAPH_HEIGHT}`);
    const plotBottom = GRAPH_HEIGHT - GRAPH_MARGIN.bottom;
    let html = "";

    for (const t of ticks) {
      html += `<line class="g-grid${t === 0 && yLo < 0 ? " g-zero" : ""}" x1="${GRAPH_MARGIN.left}" x2="${width - GRAPH_MARGIN.right}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="g-axis" x="${GRAPH_MARGIN.left - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
    }
    const xt = xTicks(start, end);
    const every = Math.max(1, Math.ceil(xt.length / Math.max(1, Math.floor((width - 60) / 56))));
    xt.forEach((t, i) => {
      if (i % every) return;
      html += `<line class="g-tick" x1="${x(t.n)}" x2="${x(t.n)}" y1="${plotBottom}" y2="${plotBottom + 4}"/>
        <text class="g-axis" x="${x(t.n)}" y="${plotBottom + 18}" text-anchor="start">${esc(t.label)}</text>`;
    });
    for (const m of markers) {
      const n = dayNumber(m.date) + 0.5;
      if (n < s0 || n > s1) continue;
      const anchor = x(n) > width - 90 ? "end" : x(n) < 90 ? "start" : "middle";
      html += `<line class="g-marker" x1="${x(n)}" x2="${x(n)}" y1="${GRAPH_MARGIN.top - 6}" y2="${plotBottom}"/>
        <text class="g-marker-label" x="${x(n)}" y="${GRAPH_MARGIN.top - 10}" text-anchor="${anchor}">${esc(m.label)}</text>`;
    }

    if (kind === "bars") {
      // thin bars (max 24px), 4px rounded top, square at the baseline, 2px gap between bars
      sorted.forEach((p, i) => {
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
      let path = "", prev = null;
      for (const p of sorted) {
        const n = dayNumber(p.date);
        path += `${prev !== null && n - prev === 1 ? "L" : "M"}${xOf(p).toFixed(1)},${y(p.value).toFixed(1)} `;
        prev = n;
      }
      html += `<path class="g-line" d="${path}"/>`;
      sorted.forEach((p, i) => {
        const n = dayNumber(p.date);
        const left = i > 0 && n - dayNumber(sorted[i - 1].date) === 1;
        const right = i < sorted.length - 1 && dayNumber(sorted[i + 1].date) - n === 1;
        if (!left && !right) html += `<circle class="g-dot" cx="${xOf(p)}" cy="${y(p.value)}" r="3.5"/>`;
      });
    }
    html += `<line class="g-cross" y1="${GRAPH_MARGIN.top}" y2="${plotBottom}" visibility="hidden"/>
      <circle class="g-focus" r="5" visibility="hidden"/>
      <rect class="g-hit" x="${GRAPH_MARGIN.left}" y="0" width="${Math.max(0, width - GRAPH_MARGIN.left - GRAPH_MARGIN.right)}" height="${GRAPH_HEIGHT}"/>`;
    svg.innerHTML = html;
    show(pinned ?? hovered);
  }

  function nearestIndex(clientX) {
    if (!sorted.length) return null;
    const px = clientX - svg.getBoundingClientRect().left;
    let best = 0, bestDist = Infinity;
    sorted.forEach((p, i) => {
      const d = Math.abs(xOf(p) - px);
      if (d < bestDist) { best = i; bestDist = d; }
    });
    return best;
  }

  function show(i) {
    const cross = svg.querySelector(".g-cross"), focus = svg.querySelector(".g-focus");
    svg.querySelectorAll(".g-bar.is-active").forEach(b => b.classList.remove("is-active"));
    if (i === null || i === undefined || !sorted[i]) {
      cross?.setAttribute("visibility", "hidden");
      focus?.setAttribute("visibility", "hidden");
      tip.hidden = true;
      return;
    }
    const p = sorted[i];
    const px = xOf(p), py = y(p.value);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    if (kind === "bars") {
      svg.querySelector(`.g-bar[data-i="${i}"]`)?.classList.add("is-active");
      focus.setAttribute("visibility", "hidden");
    } else {
      focus.setAttribute("cx", px); focus.setAttribute("cy", py); focus.setAttribute("visibility", "visible");
    }
    tip.innerHTML = `${details(p)}
      ${onGoToDay ? `<button type="button" class="graph-go">Go to specific day</button>` : ""}
      ${pinned !== null ? `<div class="graph-tip-hint">Pinned · click elsewhere to close</div>` : ""}`;
    tip.classList.toggle("is-pinned", pinned !== null);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${px + 14 + tw > width ? Math.max(4, px - 14 - tw) : px + 14}px`;
    tip.style.top = `${GRAPH_MARGIN.top}px`;
    tip.querySelector(".graph-go")?.addEventListener("click", ev => {
      ev.stopPropagation();
      onGoToDay(p.date);
    });
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
    if (!sorted.length) return;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      const cur = pinned ?? hovered ?? (ev.key === "ArrowRight" ? -1 : sorted.length);
      pinned = Math.max(0, Math.min(sorted.length - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
      show(pinned);
    } else if (ev.key === "Enter" && pinned !== null && onGoToDay) {
      ev.preventDefault();
      onGoToDay(sorted[pinned].date);
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

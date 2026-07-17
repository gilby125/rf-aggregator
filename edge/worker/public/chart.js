// 24-hour temperature + humidity trends from our own collected data. Reads
// /api/history (D1 readings the Worker records on each bridge ingest) and draws
// self-contained SVG area+line charts — no charting library. One chart per metric
// (single y-axis each), theme-aware via CSS variables, with a hover crosshair.
(function () {
  "use strict";

  const HOURS = 24;
  const REFRESH_MS = 60 * 1000;
  const METRICS = [
    { key: "temperature_F", label: "Temperature", unit: "°F", cls: "temp", dec: 1, minSpan: 4 },
    { key: "humidity", label: "Humidity", unit: "%", cls: "hum", dec: 0, minSpan: 8 },
  ];
  const W = 760, H = 200, PAD = { l: 40, r: 16, t: 14, b: 22 };

  let data = null, sensor = null;
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (v, d) => (v == null ? "—" : (Math.round(v * 10 ** d) / 10 ** d).toString());
  const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hlabel = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric" }).replace(/\s/g, "");

  function niceTicks(min, max, n) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, step0 = span / n;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
    return { ticks, lo, hi };
  }

  function makeChart(metric, points) {
    // points: [[ts,val],...] within the window
    const wrap = document.createElement("div");
    wrap.className = "chart " + metric.cls;

    const now = Math.floor(Date.now() / 1000);
    const xmin = now - HOURS * 3600, xmax = now;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;

    if (!points.length) {
      wrap.innerHTML = `<div class="chart-head"><span class="chart-title">${metric.label}</span></div>
        <div class="chart-empty">collecting… fills over the next few hours</div>`;
      return wrap;
    }

    const vals = points.map((p) => p[1]);
    let vmin = Math.min(...vals), vmax = Math.max(...vals);
    if (vmax - vmin < metric.minSpan) { const mid = (vmin + vmax) / 2; vmin = mid - metric.minSpan / 2; vmax = mid + metric.minSpan / 2; }
    const { ticks, lo, hi } = niceTicks(vmin, vmax, 4);
    const X = (ts) => PAD.l + ((ts - xmin) / (xmax - xmin)) * plotW;
    const Y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH;

    const pts = points.map((p) => [X(p[0]), Y(p[1])]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${(PAD.t + plotH).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(PAD.t + plotH).toFixed(1)} Z`;

    const grid = ticks.map((t) => {
      const y = Y(t).toFixed(1);
      return `<line class="grid" x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}"/>
              <text class="axis-y" x="${PAD.l - 6}" y="${y}" dy="0.32em">${fmt(t, metric.dec)}</text>`;
    }).join("");

    const xticks = [];
    for (let h = HOURS; h >= 0; h -= 6) {
      const ts = now - h * 3600, x = X(ts).toFixed(1);
      xticks.push(`<text class="axis-x" x="${x}" y="${H - 4}">${h === 0 ? "now" : hlabel(ts)}</text>`);
    }

    const last = points[points.length - 1];
    const gid = "g-" + metric.cls;
    wrap.innerHTML = `
      <div class="chart-head">
        <span class="chart-title">${metric.label}</span>
        <span class="chart-now"><b>${fmt(last[1], metric.dec)}</b>${metric.unit} <span class="muted">· ${esc(hhmm(last[0]))}</span></span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" role="img"
           aria-label="${metric.label} over the last ${HOURS} hours">
        <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" class="grad-top"/><stop offset="1" class="grad-bot"/>
        </linearGradient></defs>
        ${grid}
        ${xticks.join("")}
        <path class="area" d="${area}" fill="url(#${gid})"/>
        <path class="line" d="${line}"/>
        <circle class="last" cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="3.2"/>
        <g class="cursor" style="display:none">
          <line class="cx" y1="${PAD.t}" y2="${PAD.t + plotH}"/>
          <circle class="cdot" r="3.5"/>
        </g>
      </svg>
      <div class="chart-tip" hidden></div>`;

    // hover: nearest point by x
    const svg = wrap.querySelector("svg");
    const cur = wrap.querySelector(".cursor");
    const cx = wrap.querySelector(".cx");
    const cdot = wrap.querySelector(".cdot");
    const tip = wrap.querySelector(".chart-tip");
    svg.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - sx); if (d < bd) { bd = d; best = i; } }
      const [px, py] = pts[best];
      cur.style.display = ""; cx.setAttribute("x1", px); cx.setAttribute("x2", px);
      cdot.setAttribute("cx", px); cdot.setAttribute("cy", py);
      tip.hidden = false;
      tip.innerHTML = `<b>${fmt(points[best][1], metric.dec)}${metric.unit}</b> · ${esc(hhmm(points[best][0]))}`;
      const leftPct = (px / W) * 100;
      tip.style.left = leftPct + "%";
      tip.style.transform = `translateX(${leftPct > 70 ? "-100%" : "-50%"})`;
    });
    svg.addEventListener("pointerleave", () => { cur.style.display = "none"; tip.hidden = true; });
    return wrap;
  }

  function sensorsWithData(d) {
    return Object.keys(d).filter((s) => d[s].temperature_F.length || d[s].humidity.length)
      .sort((a, b) => (d[b].temperature_F.length + d[b].humidity.length) - (d[a].temperature_F.length + d[a].humidity.length));
  }

  function render() {
    const charts = el("trend-charts");
    if (!data) return;
    const list = sensorsWithData(data);
    if (!list.length) {
      charts.innerHTML = "";
      el("trend-status").textContent = "No readings collected yet — charts appear as sensors report (fills to 24h over the first day).";
      el("trend-sensor").innerHTML = "";
      return;
    }
    el("trend-status").textContent = "";
    // sensor selector
    const sel = el("trend-sensor");
    if (sel.options.length !== list.length || !list.includes(sensor)) {
      sel.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
      if (!list.includes(sensor)) sensor = list[0];
      sel.value = sensor;
    }
    const s = data[sensor] || { temperature_F: [], humidity: [] };
    charts.innerHTML = "";
    for (const m of METRICS) {
      if (!s[m.key].length && m.key === "humidity") continue; // some sensors have no humidity
      charts.appendChild(makeChart(m, s[m.key]));
    }
  }

  async function load() {
    try {
      const r = await fetch(`/api/history?hours=${HOURS}`, { headers: { "content-type": "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = (await r.json()).series || {};
      render();
    } catch (e) {
      el("trend-status").textContent = "Trends unavailable: " + e.message;
    }
  }

  el("trend-sensor").addEventListener("change", (e) => { sensor = e.target.value; render(); });
  load();
  setInterval(load, REFRESH_MS);
})();

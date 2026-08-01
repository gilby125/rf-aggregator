// 24-hour temperature + humidity trends from our own collected data. Reads
// /api/history (D1 readings the Worker records on each bridge ingest) and draws
// self-contained SVG area+line charts — no charting library. One chart per metric
// (single y-axis each), theme-aware via CSS variables, with a hover crosshair.
(function () {
  "use strict";

  // Plot window. Must match the `hours` app.js asks /api/catalog for, or the x-axis will
  // span a different range than the data.
  const HOURS = 24;
  // Ordered: doubles as display order. A sensor renders only the entries it reports, so
  // listing C and F both is safe — no sensor sends both (CONTRACTS.md §1 keeps them distinct).
  // `transform: "accum"` marks a cumulative counter (rtl_433 rain_in / rain_mm are lifetime
  // totals since device power-on). Plotted raw they look nearly flat; we convert to
  // rain-in-window so each step is a rain event and the current value is "total in the last
  // HOURS" rather than an opaque running counter.
  const METRICS = [
    { key: "temperature_F", label: "Temperature", unit: "°F", cls: "temp", dec: 1, minSpan: 4 },
    { key: "temperature_C", label: "Temperature", unit: "°C", cls: "tempc", dec: 1, minSpan: 2 },
    { key: "humidity", label: "Humidity", unit: "%", cls: "hum", dec: 0, minSpan: 8 },
    { key: "pm25", label: "PM2.5", unit: "µg/m³", cls: "pm25", dec: 0, minSpan: 10 },
    { key: "pm10", label: "PM10", unit: "µg/m³", cls: "pm10", dec: 0, minSpan: 10 },
    { key: "rain_in", label: "Rain (24h)", unit: "in", cls: "rain", dec: 2, minSpan: 0.1, transform: "accum" },
    { key: "rain_mm", label: "Rain (24h)", unit: "mm", cls: "rain", dec: 1, minSpan: 2, transform: "accum" },
    { key: "rain_rate_in_h", label: "Rain rate", unit: "in/h", cls: "rainrate", dec: 2, minSpan: 0.1 },
  ];

  // Cumulative-counter → in-window accumulation. Reset-aware: any negative step (device
  // reboot, battery pull) is clamped to 0 so the series doesn't dive to a lower baseline
  // and swallow subsequent rain. Exposed for app.js so the KPI tile agrees with the chart.
  function toAccum(points) {
    if (!points || points.length < 1) return [];
    const out = [[points[0][0], 0]];
    let cum = 0;
    for (let i = 1; i < points.length; i++) {
      const d = points[i][1] - points[i - 1][1];
      if (d > 0) cum += d;
      out.push([points[i][0], cum]);
    }
    return out;
  }
  window.rainAccumulation = (points) => {
    const a = toAccum(points);
    return a.length ? a[a.length - 1][1] : 0;
  };
  window.rainAccumSeries = toAccum;
  const W = 760, H = 200, PAD = { l: 40, r: 16, t: 14, b: 22 };

  let data = null, sensor = null;
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (v, d) => (v == null ? "—" : (Math.round(v * 10 ** d) / 10 ** d).toString());
  const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hlabel = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric" }).replace(/\s/g, "");

  // `dec` is the metric's display precision. A metric rendered with 0 decimals must not get
  // a fractional step: a 2.5 step formats as 0,3,5,8,10,13 — gaps that look uneven and wrong
  // because each label is rounded independently. Restrict to integer steps in that case.
  function niceTicks(min, max, n, dec = 1) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, step0 = span / n;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const cands = [1, 2, 2.5, 5, 10]
      .map((m) => m * mag)
      .filter((s) => dec > 0 || (s >= 1 && Number.isInteger(s)));
    const step = cands.find((s) => s >= step0) || Math.max(mag * 10, 1);
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
    const { ticks, lo, hi } = niceTicks(vmin, vmax, 4, metric.dec);
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

  // Generic over metric keys. A series object carries only the metrics that sensor actually
  // reports, so never dereference a specific key — an airmon has no temperature_F, an
  // rtl433 temp-only sensor has no humidity.
  const pointCount = (series) => Object.values(series).reduce((n, pts) => n + pts.length, 0);

  // Freshness. A ghost id left behind when the envelope id scheme changes (a channel/id
  // rollover splits history into a dead old id + a live new one) keeps ALL its accumulated
  // points, so it outranks the young live sensor on point count and gets auto-pinned — the
  // dashboard then opens on a dead series whose last point "ends" at the moment of the split.
  // Rank fresh sensors first so seeding/sorting land on the live one; dormant ids stay in the
  // dropdown for anyone who wants to look at a stopped sensor.
  const STALE_S = 3600;
  const lastTs = (series) => {
    let m = 0;
    for (const pts of Object.values(series)) { const p = pts[pts.length - 1]; if (p && p[0] > m) m = p[0]; }
    return m;
  };
  const isFresh = (series) => Math.floor(Date.now() / 1000) - lastTs(series) <= STALE_S;

  function sensorsWithData(d) {
    return Object.keys(d)
      .filter((s) => pointCount(d[s]) > 0)
      .sort((a, b) => (isFresh(d[b]) - isFresh(d[a])) || (pointCount(d[b]) - pointCount(d[a])));
  }

  // Pinned sensors render on every load without touching the dropdown; the dropdown stays
  // for browsing anything else. Persisted per-user (app.js wires it to /api/config, same as
  // the radar source), so the dashboard always shows something useful on arrival.
  let pinned = null; // null = never configured -> seed defaults; [] = user pinned nothing
  let savePinned = () => {};
  window.initTrends = (opts) => {
    const saved = opts.getPinned && opts.getPinned();
    if (Array.isArray(saved)) pinned = saved;
    savePinned = opts.savePinned || savePinned;
  };

  // First-run set: the richest sensor plus the first air-quality one plus the first rain
  // gauge, so temperature / PM / rain all appear out of the box rather than only whatever
  // sorts highest by point count.
  function seedPinned(list) {
    const pm = list.find((s) => data[s].pm25 || data[s].pm10);
    const rain = list.find((s) => data[s].rain_in || data[s].rain_mm || data[s].rain_rate_in_h);
    return [...new Set([list[0], pm, rain].filter(Boolean))];
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
    if (pinned === null) pinned = seedPinned(list);

    // "— browse another sensor —" so the dropdown is an addition to the pinned set rather
    // than the only way to see anything.
    const sel = el("trend-sensor");
    if (sel.options.length !== list.length + 1) {
      sel.innerHTML = `<option value="">— browse a sensor —</option>` +
        list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    }
    if (sensor && !list.includes(sensor)) sensor = "";
    sel.value = sensor || "";

    // Pinned first, then whatever is being browsed (if it isn't already pinned).
    const show = pinned.filter((id) => list.includes(id));
    if (sensor && !show.includes(sensor)) show.push(sensor);

    charts.innerHTML = "";
    if (!show.length) {
      charts.innerHTML = `<p class="muted">Nothing pinned — pick a sensor above and press ☆ to keep it on the dashboard.</p>`;
      return;
    }

    for (const id of show) {
      const on = pinned.includes(id);
      const block = document.createElement("section");
      block.className = "trend-block";
      block.innerHTML =
        `<div class="trend-block-head">
           <h3>${esc(id)}</h3>
           <button class="btn-icon pin${on ? " on" : ""}" data-id="${esc(id)}"
                   title="${on ? "Unpin from dashboard" : "Pin to dashboard"}"
                   aria-label="${on ? "Unpin" : "Pin"} ${esc(id)}">${on ? "★" : "☆"}</button>
         </div><div class="trend-grid"></div>`;
      const grid = block.querySelector(".trend-grid");
      for (const m of METRICS) {
        // Chart only what this sensor reports. Charting a metric it never sends renders a
        // "collecting…" panel that can never fill (airmon + temperature_F did exactly that).
        const raw = (data[id] || {})[m.key];
        if (!raw || !raw.length) continue;
        const pts = m.transform === "accum" ? toAccum(raw) : raw;
        grid.appendChild(makeChart(m, pts));
      }
      charts.appendChild(block);
    }

    charts.querySelectorAll(".pin").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.id;
        pinned = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
        if (pinned.includes(id) && sensor === id) sensor = ""; // pinned now, stop "browsing" it
        savePinned(pinned);
        render();
      })
    );
  }

  el("trend-sensor").addEventListener("change", (e) => { sensor = e.target.value; render(); });

  // Push-driven: history rides the /api/catalog response app.js already fetches on its own
  // 60s loop. A second fetch + timer here would double the Worker invocations for data that
  // arrives in the same payload. Same pattern as window.initRadar.
  window.renderTrends = (series) => { data = series || {}; render(); };
})();

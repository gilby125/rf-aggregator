// rf-aggregator UI. Same-origin API (see docs/CONTRACTS.md §2); Access handles login.
const $ = (sel) => document.querySelector(sel);
const TEAM_LOGOUT = "https://throughfire.cloudflareaccess.com/cdn-cgi/access/logout";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (typeof n === "number" ? (Math.round(n * 10) / 10).toString() : "—");
const clock = (ts) =>
  ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase() : "";
const ago = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
const stamp = (ts) => (ts ? `${clock(ts)} · ${ago(ts)}` : "never");

// Pretty labels + units for known rtl_433 fields; unknown keys fall back to the raw name.
const UNITS = {
  temperature_F: "°F", temperature_C: "°C", humidity: "%",
  pm25: "µg/m³", pm10: "µg/m³",
  wind_avg_mi_h: "mph", wind_max_mi_h: "mph", wind_gust_mi_h: "mph", wind_dir_deg: "°",
  rain_in: "in", rain_mm: "mm", rain_rate_in_h: "in/h", pressure_hPa: "hPa",
  freq: "MHz", rssi: "dB", snr: "dB", noise: "dB", battery_V: "V", light_lux: "lux", uv: "UV",
};
const LABELS = {
  temperature_F: "Temperature", temperature_C: "Temperature", humidity: "Humidity",
  pm25: "PM2.5", pm10: "PM10",
  wind_avg_mi_h: "Wind avg", wind_max_mi_h: "Wind max", wind_gust_mi_h: "Wind gust", wind_dir_deg: "Wind dir",
  rain_in: "Rain", rain_mm: "Rain", rain_rate_in_h: "Rain rate", pressure_hPa: "Pressure",
  message_type: "Msg type", sequence_num: "Seq", protocol: "Protocol", freq: "Freq",
};
const label = (k) => LABELS[k] || k.replace(/_/g, " ");

// The dashboard is imperial (°F, mph, in) but the airmon reports Celsius. The pipeline
// deliberately keeps temperature_C and temperature_F as separate fields — CONTRACTS.md §1,
// because aggregators.basicstats averages by field name and mixing units would produce a
// meaningless number. So convert for DISPLAY ONLY, right where the payload lands, and every
// renderer downstream then sees a single temperature unit.
const cToF = (c) => (c * 9) / 5 + 32;

function toDisplayUnits(fields) {
  if (!fields) return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const isC = k === "temperature_C" || k === "temperature_C_mean";
    const target = k.replace("temperature_C", "temperature_F");
    // Never clobber a real Fahrenheit reading if a sensor somehow reports both.
    if (isC && typeof v === "number" && !(target in fields)) out[target] = cToF(v);
    else out[k] = v;
  }
  return out;
}

// Same conversion for the [[ts, value], …] history series.
function historyToDisplayUnits(series) {
  const out = {};
  for (const [id, metrics] of Object.entries(series || {})) {
    const m = {};
    for (const [k, pts] of Object.entries(metrics)) {
      if (k === "temperature_C" && !("temperature_F" in metrics)) {
        m.temperature_F = pts.map(([t, v]) => [t, cToF(v)]);
      } else m[k] = pts;
    }
    out[id] = m;
  }
  return out;
}

// Radio/protocol fields: meaningless to average, hidden from GROUP cards (kept on
// individual sensor cards, where per-device signal info is useful).
const GROUP_HIDE = new Set([
  "freq", "rssi", "snr", "noise", "protocol", "message_type",
  "sequence_num", "sendmode", "button", "mic", "subtype", "status",
]);

// A <dl class="metrics"> of physical readings. `hide` drops radio fields (group cards).
function metricRows(fields, { hide = false } = {}) {
  const rows = Object.entries(fields)
    .filter(([k]) => k !== "battery_ok")
    .filter(([k]) => !(hide && GROUP_HIDE.has(k.replace(/_mean$/, ""))))
    .map(([k, v]) => {
      const base = k.replace(/_mean$/, "");
      const u = UNITS[base] ? ` <span class="unit">${UNITS[base]}</span>` : "";
      return `<dt>${esc(label(base))}</dt><dd>${fmt(v)}${u}</dd>`;
    })
    .join("");
  return rows ? `<dl class="metrics">${rows}</dl>` : `<p class="empty">no data yet</p>`;
}

async function api(path, opts = {}) {
  const resp = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

// ── per-user config (theme + radar source), persisted via /api/config ──────────
const Config = {
  data: {},
  async load() {
    try { this.data = (await api("/api/config")).config || {}; } catch { this.data = {}; }
    return this.data;
  },
  async patch(p) {
    this.data = { ...this.data, ...p };
    try { await api("/api/config", { method: "PUT", body: JSON.stringify(this.data) }); } catch { /* non-critical */ }
  },
};

// ── theme ──────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  try { theme ? localStorage.setItem("rf-theme", theme) : localStorage.removeItem("rf-theme"); } catch {}
}
function effectiveTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function initTheme() {
  $("#theme-toggle").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    Config.patch({ theme: next });
  });
}

// EPA concentration -> AQI breakpoints: [Clow, Chigh, Ilow, Ihigh]. PM2.5 uses the 2024
// revised table, PM10 the 24-hour table. The raw µg/m³ concentration and the AQI index are
// different quantities — 6 µg/m³ is AQI 33 — so the UI shows both rather than one alone.
//
// Caveat: a formally correct AQI uses a 24h average (EPA NowCast); this is computed from the
// latest instantaneous reading, so treat it as indicative rather than an official figure.
const AQI_BP = {
  pm25: [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
         [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]],
  pm10: [[0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150],
         [255, 354, 151, 200], [355, 424, 201, 300], [425, 604, 301, 500]],
};

const AQI_CATEGORIES = [
  { max: 50, label: "Good", cls: "" },
  { max: 100, label: "Moderate", cls: "" },
  { max: 150, label: "Unhealthy for sensitive groups", cls: "alert" },
  { max: 200, label: "Unhealthy", cls: "alert" },
  { max: 300, label: "Very unhealthy", cls: "alert" },
  { max: Infinity, label: "Hazardous", cls: "alert" },
];

function aqiFrom(conc, table) {
  if (typeof conc !== "number") return null;
  for (const [cl, ch, il, ih] of table) {
    if (conc >= cl && conc <= ch) return Math.round(((ih - il) / (ch - cl)) * (conc - cl) + il);
  }
  return conc > 0 ? 500 : null; // above the top breakpoint
}

// Overall AQI is the worst pollutant's sub-index, per EPA.
function airQuality(pm25, pm10) {
  const subs = [aqiFrom(pm25, AQI_BP.pm25), aqiFrom(pm10, AQI_BP.pm10)].filter((v) => v !== null);
  if (!subs.length) return null;
  const aqi = Math.max(...subs);
  return { aqi, ...AQI_CATEGORIES.find((c) => aqi <= c.max) };
}

// Sensors report at wildly different cadences: rtl433 devices every few seconds, the airmon
// hourly (--interval 3600). One global threshold marks every slow sensor permanently stale
// and inflates the Alerts tile. Estimate each sensor's own cadence from the median gap in its
// history and allow ~2 missed cycles, never dipping below the floor.
function staleAfter(series, floor) {
  const ts = [];
  for (const pts of Object.values(series || {})) for (const p of pts) ts.push(p[0]);
  if (ts.length < 3) return floor;
  ts.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 0) gaps.push(ts[i] - ts[i - 1]);
  if (!gaps.length) return floor;
  gaps.sort((a, b) => a - b);
  return Math.max(floor, gaps[Math.floor(gaps.length / 2)] * 2.5);
}

const isStale = (s, history, floor, now) =>
  (s.last_seen ?? 0) < now - staleAfter((history || {})[s.sensor_id], floor);

// Bare inline sparkline — shape only, no axes or labels. Scales to its own min/max so a
// flat-ish series still reads. Needs 2+ points; returns "" otherwise so a tile with no
// history just omits it rather than drawing a degenerate line.
function sparkline(points, cls) {
  if (!points || points.length < 2) return "";
  const W = 100, H = 26;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const X = (t) => (x1 === x0 ? W : ((t - x0) / (x1 - x0)) * W);
  const Y = (v) => H - ((v - y0) / (y1 - y0)) * H;
  const d = points.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join(" ");
  return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ── KPI stat tiles ───────────────────────────────────────────────────────────
function renderKpis({ sensors, sharedDoc, customGroups, staleThreshold, history }) {
  const now = Math.floor(Date.now() / 1000);
  const lowBatt = sensors.filter((s) => "battery_ok" in s.latest && !s.latest.battery_ok).length;
  const stale = sensors.filter((s) => isStale(s, history, staleThreshold, now)).length;
  const named = Object.keys(sharedDoc.groups || {}).filter((g) => g !== "unassigned").length;
  const groups = named + customGroups.length;
  const live = sensors.length - stale;
  const tile = (label, value, sub, cls = "", extra = "") =>
    `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}${extra}</div>`;

  // Air quality: show the actual PM2.5 and PM10 readings rather than one figure, from
  // whichever sensor is currently worst. Omitted entirely when nothing reports pm25 — a
  // permanent "—" tile is the same empty-widget problem the charts had.
  const pmSensors = sensors.filter((s) => typeof s.latest.pm25 === "number");
  let airTile = "";
  if (pmSensors.length) {
    const worst = pmSensors.reduce((a, b) => (b.latest.pm25 > a.latest.pm25 ? b : a));
    const p25 = worst.latest.pm25, p10 = worst.latest.pm10;
    const aq = airQuality(p25, p10);
    // AQI is the headline (it's the number people recognise from weather apps); the actual
    // concentrations sit underneath with their real unit.
    const value = aq ? `${aq.aqi}<span class="unit">AQI</span>` : "—";
    const conc =
      `PM2.5 ${fmt(p25)}` +
      (typeof p10 === "number" ? ` · PM10 ${fmt(p10)}` : "") +
      ` <span class="unit">µg/m³</span>`;
    airTile = tile("Air quality", value, `${aq ? aq.label : ""} · ${conc}`, aq ? aq.cls : "",
      sparkline(((history || {})[worst.sensor_id] || {}).pm25, "pm25"));
  }

  // Rain: rtl_433 rain_in / rain_mm are LIFETIME counters, meaningless as a raw value. Convert
  // to "rain in the last 24h" per gauge using the history series (window.rainAccumSeries is
  // reset-aware — a battery pull or reboot doesn't dive the baseline). Headline is the max
  // across gauges: one silent / stuck gauge shouldn't drag the number down. Tile is omitted
  // entirely when no sensor reports rain, same rule the Air quality tile follows.
  const rainSensors = sensors
    .map((s) => {
      const h = (history || {})[s.sensor_id] || {};
      const inPts = h.rain_in, mmPts = h.rain_mm;
      const hasCounter = (inPts && inPts.length) || (mmPts && mmPts.length);
      const rate = s.latest.rain_rate_in_h;
      if (!hasCounter && typeof rate !== "number") return null;
      const cumIn = inPts && inPts.length
        ? window.rainAccumulation(inPts)
        : mmPts && mmPts.length
          ? window.rainAccumulation(mmPts) / 25.4
          : 0;
      const accumSeries = inPts && inPts.length
        ? window.rainAccumSeries(inPts)
        : mmPts && mmPts.length
          ? window.rainAccumSeries(mmPts).map(([t, v]) => [t, v / 25.4])
          : null;
      return { id: s.sensor_id, cumIn, rate: typeof rate === "number" ? rate : null, accumSeries };
    })
    .filter(Boolean);
  let rainTile = "";
  if (rainSensors.length) {
    const worst = rainSensors.reduce((a, b) => (b.cumIn > a.cumIn ? b : a));
    const value = `${fmt(worst.cumIn)}<span class="unit">in</span>`;
    const perGauge = rainSensors.length > 1
      ? rainSensors.map((r) => fmt(r.cumIn)).join(" · ") + ' <span class="unit">in</span>'
      : "24h total";
    const rates = rainSensors.map((r) => r.rate).filter((v) => typeof v === "number");
    const rateStr = rates.length
      ? ` · rate ${fmt(Math.max(...rates))} <span class="unit">in/h</span>`
      : "";
    const anyRain = rainSensors.some((r) => r.cumIn > 0) || rates.some((v) => v > 0);
    rainTile = tile(
      "Rain 24h",
      value,
      `${perGauge}${rateStr}${anyRain ? "" : " · dry"}`,
      "",
      worst.accumSeries ? sparkline(worst.accumSeries, "rain") : ""
    );
  }

  // No Alerts headline tile: it summed low-battery and stale into one number larger than the
  // device count (a sensor can be both), which read alarming without being actionable. The
  // per-sensor cards already badge "battery low" / "stale" where you can act on them; the
  // counts live here as context on the Sensors tile instead.
  const sub = [`${live} live`, stale ? `${stale} stale` : null, lowBatt ? `${lowBatt} low battery` : null]
    .filter(Boolean).join(" · ");
  $("#kpis").innerHTML =
    tile("Sensors", sensors.length, sub) +
    tile("Groups", groups, `${named} shared · ${customGroups.length} custom`) +
    airTile +
    rainTile +
    tile("Last update", sharedDoc.updated ? clock(sharedDoc.updated) : "—", sharedDoc.updated ? ago(sharedDoc.updated) : "waiting for data");

  const pill = $("#updated-pill");
  if (sharedDoc.updated) {
    pill.hidden = false;
    $("#updated-text").textContent = `updated ${ago(sharedDoc.updated)}`;
    pill.classList.toggle("stale", now - sharedDoc.updated > 2 * staleThreshold);
  }
}

// ── shared (admin) groups ──────────────────────────────────────────────────────
function renderShared(sharedDoc) {
  $("#shared-updated").textContent = sharedDoc.updated ? `updated ${stamp(sharedDoc.updated)}` : "(no data yet)";
  const named = Object.entries(sharedDoc.groups || {}).filter(([g]) => g !== "unassigned");
  $("#shared-groups").innerHTML =
    named
      .map(
        ([g, a]) =>
          `<div class="card"><div class="card-head"><h3>${esc(g)}</h3></div>${metricRows(a.fields, { hide: true })}</div>`
      )
      .join("") || `<p class="muted">No shared groups defined yet — create one in Admin below.</p>`;
}

// ── custom groups ──────────────────────────────────────────────────────────────
function renderCustom(customGroups) {
  $("#custom-groups").innerHTML =
    customGroups
      .map((g) => {
        const members = g.sensor_ids
          .map((id) => (g.stale_ids.includes(id) ? `${esc(id)} <span class="badge warn">stale</span>` : esc(id)))
          .join(", ");
        return `<div class="card">
          <div class="card-head">
            <h3>${esc(g.name)}</h3>
            <button class="btn-icon edit" title="Edit" data-name="${esc(g.name)}" data-ids="${esc(g.sensor_ids.join(","))}" aria-label="Edit group">✎</button>
            <button class="btn-icon del" title="Delete" data-name="${esc(g.name)}" aria-label="Delete group">✕</button>
          </div>
          ${metricRows(g.computed, { hide: true })}
          <p class="card-foot">${g.sensor_ids.length} sensors: ${members}</p>
        </div>`;
      })
      .join("") || `<p class="muted">None yet — define one below (computed on demand).</p>`;

  document.querySelectorAll("#custom-groups .del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/custom?name=${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
      refresh();
    })
  );
  document.querySelectorAll("#custom-groups .edit").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.name, b.dataset.ids ? b.dataset.ids.split(",") : []))
  );
}

function startEdit(name, ids) {
  $("#custom-name").value = name;
  const set = new Set(ids);
  document.querySelectorAll("#sensor-picker input").forEach((i) => { i.checked = set.has(i.value); });
  $("#custom-new").open = true;
  $("#custom-name").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── individual sensors ─────────────────────────────────────────────────────────
function renderSensors(sensors, staleThreshold, history) {
  const now = Math.floor(Date.now() / 1000);
  // The section is collapsed by default, so surface the count in the header — otherwise
  // there's no signal about what's behind the disclosure.
  const fresh = sensors.filter((s) => !isStale(s, history, staleThreshold, now)).length;
  $("#sensor-count").textContent =
    `${sensors.length} device${sensors.length === 1 ? "" : "s"} · ${fresh} reporting`;
  $("#sensor-list").innerHTML =
    sensors
      .map((s) => {
        const badges = [];
        if ("battery_ok" in s.latest && !s.latest.battery_ok) badges.push('<span class="badge danger">battery low</span>');
        if (isStale(s, history, staleThreshold, now)) badges.push('<span class="badge warn">stale</span>');
        return `<div class="card">
          <div class="card-head"><h3>${esc(s.sensor_id)}</h3>${badges.join("")}</div>
          ${metricRows(s.latest)}
          <p class="card-foot">${stamp(s.last_seen)}</p>
        </div>`;
      })
      .join("") || `<p class="muted">Catalog is empty — waiting for the bridge.</p>`;
}

// ── ungrouped ──────────────────────────────────────────────────────────────────
function renderUngrouped(sensors, groupDefs, customGroups) {
  const grouped = new Set();
  if (groupDefs) Object.values(groupDefs).flat().forEach((id) => grouped.add(id));
  customGroups.forEach((g) => g.sensor_ids.forEach((id) => grouped.add(id)));
  const ungrouped = sensors.filter((s) => !grouped.has(s.sensor_id));
  $("#ungrouped-list").innerHTML = ungrouped.length
    ? `<p class="muted">Not in any group yet — add them in Admin below or a custom group.</p><ul class="ungrouped">` +
      ungrouped.map((s) => `<li>${esc(s.sensor_id)} <span class="muted">· ${stamp(s.last_seen)}</span></li>`).join("") +
      `</ul>`
    : `<p class="muted">Every sensor is in a group.</p>`;
}

function renderPicker(sensors) {
  $("#sensor-picker").innerHTML =
    sensors
      .map(
        (s) =>
          `<label><input type="checkbox" value="${esc(s.sensor_id)}"> ${esc(s.sensor_id)} <span class="muted">${esc(s.source)} · ${ago(s.last_seen)}</span></label>`
      )
      .join("") || `<p class="muted">Catalog is empty — waiting for the bridge.</p>`;
}

async function initAdmin(me, groupDefs) {
  if (!me.is_admin) return;
  $("#admin").hidden = false;
  $("#defs-json").value = JSON.stringify(groupDefs ?? {}, null, 2);
  $("#defs-save").addEventListener("click", async () => {
    try {
      const group_defs = JSON.parse($("#defs-json").value);
      const r = await api("/api/admin/group_defs", { method: "PUT", body: JSON.stringify({ group_defs }) });
      $("#defs-status").textContent = `saved (defs_version ${r.defs_version}) — reload to refresh groups`;
    } catch (e) {
      $("#defs-status").textContent = `error: ${e.message}`;
    }
  });
}

// ── data flow ───────────────────────────────────────────────────────────────────
let ME = null, GROUP_DEFS = null;
const STALE = 600; // seconds; matches the backend's 2×period staleness idea loosely
const TREND_HOURS = 24; // must match HOURS in chart.js (the plot window)

// `periodic` marks the 60s timer's calls, which are the only ones worth skipping for a hidden
// tab. The initial load and user-initiated refreshes must always render: a tab opened in the
// background (ctrl+click, session restore) is hidden at load time, and gating that leaves the
// dashboard completely blank until it is focused.
async function refresh({ periodic = false } = {}) {
  if (periodic && document.hidden) return;
  const [catalog, sharedDoc, customRes] = await Promise.all([
    api(`/api/catalog?hours=${TREND_HOURS}`),
    api("/aggregates.json"),
    api("/api/custom").catch(() => ({ groups: [] })),
  ]);
  // Normalise units once, here, so every renderer below is unit-agnostic.
  const sensors = catalog.sensors.map((s) => ({ ...s, latest: toDisplayUnits(s.latest) }));
  const customGroups = (customRes.groups || []).map((g) => ({ ...g, computed: toDisplayUnits(g.computed) }));
  for (const g of Object.values(sharedDoc.groups || {})) g.fields = toDisplayUnits(g.fields);
  const history = historyToDisplayUnits((catalog.history && catalog.history.series) || {});
  renderKpis({ sensors, sharedDoc, customGroups, staleThreshold: STALE, history });
  renderShared(sharedDoc);
  renderCustom(customGroups);
  renderSensors(sensors, STALE, history);
  renderUngrouped(sensors, GROUP_DEFS, customGroups);
  renderPicker(sensors);
  // History rides the same response — chart.js does not fetch for itself.
  if (window.renderTrends) window.renderTrends(history);
}

$("#custom-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const sensor_ids = [...document.querySelectorAll("#sensor-picker input:checked")].map((i) => i.value);
  await api("/api/custom", { method: "POST", body: JSON.stringify({ name: $("#custom-name").value, sensor_ids }) });
  $("#custom-name").value = "";
  refresh();
});

(async () => {
  initTheme();
  await Config.load();
  // server-stored theme applies if the user hasn't set one on this device
  let localTheme = null;
  try { localTheme = localStorage.getItem("rf-theme"); } catch {}
  if (!localTheme && (Config.data.theme === "light" || Config.data.theme === "dark")) applyTheme(Config.data.theme);

  // trends: pinned sensor set persisted per-user, same contract as the radar source
  if (window.initTrends) {
    window.initTrends({
      getPinned: () => Config.data.trend && Config.data.trend.pinned,
      savePinned: (ids) => Config.patch({ trend: { pinned: ids } }),
    });
  }

  // radar: hand it the persisted source + a saver (radar.js is loaded before this)
  if (window.initRadar) {
    window.initRadar({
      getSource: () => Config.data.radar && Config.data.radar.source,
      saveSource: (name) => Config.patch({ radar: { source: name } }),
    });
  }

  ME = await api("/api/me");
  $("#whoami").innerHTML = `${esc(ME.email)}${ME.is_admin ? " (admin)" : ""} · <a href="${TEAM_LOGOUT}">log out</a>`;
  if (ME.is_admin) GROUP_DEFS = (await api("/api/admin/group_defs")).group_defs;

  await refresh();
  await initAdmin(ME, GROUP_DEFS);
  setInterval(() => refresh({ periodic: true }), 60_000);
  // Catch up immediately on return rather than making the user wait out the interval.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`);
});

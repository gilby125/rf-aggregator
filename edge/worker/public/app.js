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

// EPA PM2.5 24-hour breakpoints (2012 table). These are bands, not a computed AQI index
// number — deriving a real AQI needs a 24h average, and we show an instantaneous reading.
const PM25_BANDS = [
  { max: 12, label: "Good", cls: "" },
  { max: 35.4, label: "Moderate", cls: "" },
  { max: 55.4, label: "Unhealthy for sensitive groups", cls: "alert" },
  { max: 150.4, label: "Unhealthy", cls: "alert" },
  { max: 250.4, label: "Very unhealthy", cls: "alert" },
  { max: Infinity, label: "Hazardous", cls: "alert" },
];

// ── KPI stat tiles ───────────────────────────────────────────────────────────
function renderKpis({ sensors, sharedDoc, customGroups, staleThreshold }) {
  const now = Math.floor(Date.now() / 1000);
  const lowBatt = sensors.filter((s) => "battery_ok" in s.latest && !s.latest.battery_ok).length;
  const stale = sensors.filter((s) => (s.last_seen ?? 0) < now - staleThreshold).length;
  const named = Object.keys(sharedDoc.groups || {}).filter((g) => g !== "unassigned").length;
  const groups = named + customGroups.length;
  const alerts = lowBatt + stale;
  const tile = (label, value, sub, cls = "") =>
    `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  // Worst-case PM2.5 across everything reporting it. Omitted entirely when no sensor sends
  // pm25 — a permanent "—" tile is the same empty-widget problem the charts had.
  const pm = sensors.map((s) => s.latest.pm25).filter((v) => typeof v === "number");
  let airTile = "";
  if (pm.length) {
    const worst = Math.max(...pm);
    const band = PM25_BANDS.find((b) => worst <= b.max);
    airTile = tile("Air quality", `${fmt(worst)} <span class="unit">µg/m³</span>`,
      `PM2.5 · ${band.label}`, band.cls);
  }

  $("#kpis").innerHTML =
    tile("Sensors", sensors.length, "reporting devices") +
    tile("Groups", groups, `${named} shared · ${customGroups.length} custom`) +
    tile("Alerts", alerts, alerts ? `${lowBatt} low battery · ${stale} stale` : "all healthy", alerts ? "alert" : "") +
    airTile +
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
function renderSensors(sensors, staleThreshold) {
  const now = Math.floor(Date.now() / 1000);
  // The section is collapsed by default, so surface the count in the header — otherwise
  // there's no signal about what's behind the disclosure.
  const fresh = sensors.filter((s) => (s.last_seen ?? 0) >= now - staleThreshold).length;
  $("#sensor-count").textContent =
    `${sensors.length} device${sensors.length === 1 ? "" : "s"} · ${fresh} reporting`;
  $("#sensor-list").innerHTML =
    sensors
      .map((s) => {
        const badges = [];
        if ("battery_ok" in s.latest && !s.latest.battery_ok) badges.push('<span class="badge danger">battery low</span>');
        if ((s.last_seen ?? 0) < now - staleThreshold) badges.push('<span class="badge warn">stale</span>');
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

async function refresh() {
  // Nothing to do for a tab nobody is looking at — a backgrounded dashboard otherwise burns
  // an invocation a minute forever. visibilitychange (below) refreshes once on return.
  if (document.hidden) return;
  const [catalog, sharedDoc, customRes] = await Promise.all([
    api(`/api/catalog?hours=${TREND_HOURS}`),
    api("/aggregates.json"),
    api("/api/custom").catch(() => ({ groups: [] })),
  ]);
  const sensors = catalog.sensors;
  const customGroups = customRes.groups || [];
  renderKpis({ sensors, sharedDoc, customGroups, staleThreshold: STALE });
  renderShared(sharedDoc);
  renderCustom(customGroups);
  renderSensors(sensors, STALE);
  renderUngrouped(sensors, GROUP_DEFS, customGroups);
  renderPicker(sensors);
  // History rides the same response — chart.js does not fetch for itself.
  if (window.renderTrends) window.renderTrends(catalog.history && catalog.history.series);
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
  setInterval(refresh, 60_000);
  // Catch up immediately on return rather than making the user wait out the interval.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`);
});

// rf-aggregator UI. Same-origin API (see docs/CONTRACTS.md §2); Access handles login.
const $ = (sel) => document.querySelector(sel);
const TEAM_LOGOUT = "https://throughfire.cloudflareaccess.com/cdn-cgi/access/logout";

const fmt = (n) => (typeof n === "number" ? (Math.round(n * 10) / 10).toString() : "—");
// Absolute local wall-clock, e.g. "1:38pm"
const clock = (ts) =>
  ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase() : "";
const ago = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
// Combined stamp, e.g. "1:38pm — 1 min ago"
const stamp = (ts) => (ts ? `${clock(ts)} — ${ago(ts)}` : "never");

// Radio/protocol fields: meaningless to average, so hidden from GROUP cards (kept on
// individual sensor cards, where per-device signal info is useful).
const GROUP_HIDE = new Set([
  "freq", "rssi", "snr", "noise", "protocol", "message_type",
  "sequence_num", "sendmode", "button", "mic", "subtype", "status",
]);
const physicalRows = (fields) =>
  Object.entries(fields)
    .filter(([k]) => !GROUP_HIDE.has(k.replace(/_mean$/, "")))
    .map(([k, v]) => `<tr><td>${k.replace(/_mean$/, "")}</td><td>${fmt(v)}</td></tr>`)
    .join("");

async function api(path, opts = {}) {
  const resp = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

function groupCard(name, fields, sub) {
  const rows = physicalRows(fields);
  return `<div class="card"><h3>${name}</h3><table>${rows || "<tr><td class='muted'>no data yet</td></tr>"}</table>${sub ? `<p class="muted">${sub}</p>` : ""}</div>`;
}

// Shared groups = admin-defined named groups. "unassigned" is NOT a real group — it's the
// catch-all bucket for sensors nobody has grouped yet, shown separately in #ungrouped.
async function loadShared() {
  const doc = await api("/aggregates.json");
  $("#shared-updated").textContent = doc.updated ? `updated ${stamp(doc.updated)}` : "(no data yet)";
  const named = Object.entries(doc.groups).filter(([g]) => g !== "unassigned");
  $("#shared-groups").innerHTML =
    named.map(([g, a]) => groupCard(g, a.fields, "")).join("") ||
    `<p class="muted">No shared groups defined yet — create one in Admin below.</p>`;
}

// Prefill the new/edit form with an existing group's name + members, then open it.
function startEdit(name, ids) {
  $("#custom-name").value = name;
  const set = new Set(ids);
  document.querySelectorAll("#sensor-picker input").forEach((i) => { i.checked = set.has(i.value); });
  $("#custom-new").open = true;
  $("#custom-name").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function loadCustom() {
  const { groups } = await api("/api/custom");
  $("#custom-groups").innerHTML =
    groups
      .map((g) => {
        const rows = physicalRows(g.computed);
        const members = g.sensor_ids
          .map((id) => (g.stale_ids.includes(id) ? `${id} <span class="warn">stale</span>` : id))
          .join(", ");
        return `<div class="card">
          <h3>${g.name}
            <button class="edit" data-name="${g.name}" data-ids="${g.sensor_ids.join(",")}">edit</button>
            <button class="del" data-name="${g.name}">✕</button>
          </h3>
          <table>${rows || "<tr><td class='muted'>no data yet</td></tr>"}</table>
          <p class="muted">${g.sensor_ids.length} sensors: ${members}</p>
        </div>`;
      })
      .join("") || `<p class="muted">None yet — define one below (Path B: computed on demand).</p>`;
  document.querySelectorAll("#custom-groups .del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/custom?name=${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
      loadCustom();
    })
  );
  document.querySelectorAll("#custom-groups .edit").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.name, b.dataset.ids ? b.dataset.ids.split(",") : []))
  );
}

// Individual sensor cards show ALL fields (radio info included) — only battery_ok is pulled
// out into the badge to avoid a redundant 0/1 row.
async function loadSensors() {
  const { sensors } = await api("/api/catalog");
  $("#sensor-list").innerHTML =
    sensors
      .map((s) => {
        const rows = Object.entries(s.latest)
          .filter(([k]) => k !== "battery_ok")
          .map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`)
          .join("");
        const batt =
          "battery_ok" in s.latest && !s.latest.battery_ok ? ` <span class="warn">battery low</span>` : "";
        return `<div class="card"><h3>${s.sensor_id}${batt}</h3><table>${rows || "<tr><td class='muted'>no readings</td></tr>"}</table><p class="muted">${stamp(s.last_seen)}</p></div>`;
      })
      .join("") || `<p class="muted">Catalog is empty — waiting for the bridge.</p>`;
}

// Ungrouped = sensors not in ANY group, shared (admin group_defs) OR custom (Path B).
// This is what "unassigned" actually means: sensors you haven't placed anywhere yet.
async function loadUngrouped(groupDefs) {
  const el = $("#ungrouped-list");
  const { sensors } = await api("/api/catalog");
  const grouped = new Set();
  if (groupDefs) Object.values(groupDefs).flat().forEach((id) => grouped.add(id));
  try {
    const { groups } = await api("/api/custom");
    groups.forEach((g) => g.sensor_ids.forEach((id) => grouped.add(id)));
  } catch {
    /* custom groups optional */
  }
  const ungrouped = sensors.filter((s) => !grouped.has(s.sensor_id));
  el.innerHTML = ungrouped.length
    ? `<p class="muted">Not in any group yet (shared or custom) — add them in Admin below or a custom group.</p><ul class="ungrouped">` +
      ungrouped.map((s) => `<li>${s.sensor_id} <span class="muted">· ${stamp(s.last_seen)}</span></li>`).join("") +
      `</ul>`
    : `<p class="muted">Every sensor is in a group.</p>`;
}

async function loadPicker() {
  const { sensors } = await api("/api/catalog");
  $("#sensor-picker").innerHTML =
    sensors
      .map(
        (s) =>
          `<label><input type="checkbox" value="${s.sensor_id}"> ${s.sensor_id} <span class="muted">${s.source} · ${ago(s.last_seen)}</span></label>`
      )
      .join("") || `<p class="muted">Catalog is empty — waiting for the bridge to push sensors.</p>`;
}

async function loadAdmin(me, groupDefs) {
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

$("#custom-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const sensor_ids = [...document.querySelectorAll("#sensor-picker input:checked")].map((i) => i.value);
  await api("/api/custom", {
    method: "POST",
    body: JSON.stringify({ name: $("#custom-name").value, sensor_ids }),
  });
  $("#custom-name").value = "";
  loadCustom();
});

(async () => {
  const me = await api("/api/me");
  $("#whoami").innerHTML =
    `${me.email}${me.is_admin ? " (admin)" : ""} · <a href="${TEAM_LOGOUT}">log out</a>`;
  let groupDefs = null;
  if (me.is_admin) groupDefs = (await api("/api/admin/group_defs")).group_defs;
  await Promise.all([
    loadShared(),
    loadCustom(),
    loadSensors(),
    loadUngrouped(groupDefs),
    loadPicker(),
    loadAdmin(me, groupDefs),
  ]);
  setInterval(() => { loadShared(); loadSensors(); }, 60_000);
})().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="error">${e.message}</p>`);
});

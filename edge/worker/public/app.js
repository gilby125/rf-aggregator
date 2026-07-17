// rf-aggregator UI. Same-origin API (see docs/CONTRACTS.md §2); Access handles login.
const $ = (sel) => document.querySelector(sel);

const fmt = (n) => (typeof n === "number" ? (Math.round(n * 10) / 10).toString() : "—");
const ago = (ts) => (ts ? `${Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))}m ago` : "never");

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

function groupCard(name, fields, sub) {
  const rows = Object.entries(fields)
    .map(([k, v]) => `<tr><td>${k.replace(/_mean$/, "")}</td><td>${fmt(v)}</td></tr>`)
    .join("");
  return `<div class="card"><h3>${name}</h3><table>${rows || "<tr><td class='muted'>no data yet</td></tr>"}</table>${sub ? `<p class="muted">${sub}</p>` : ""}</div>`;
}

async function loadShared() {
  const doc = await api("/aggregates.json");
  $("#shared-updated").textContent = doc.updated ? `updated ${ago(doc.updated)}` : "(no data yet)";
  $("#shared-groups").innerHTML =
    Object.entries(doc.groups)
      .map(([g, a]) => groupCard(g, a.fields, ""))
      .join("") || `<p class="muted">No shared groups yet.</p>`;
}

async function loadCustom() {
  const { groups } = await api("/api/custom");
  $("#custom-groups").innerHTML =
    groups
      .map((g) =>
        groupCard(
          `${g.name} <button class="del" data-name="${g.name}">✕</button>`,
          g.computed,
          g.stale_ids.length ? `stale/unknown: ${g.stale_ids.join(", ")}` : `${g.sensor_ids.length} sensors`
        )
      )
      .join("") || `<p class="muted">None yet — define one below (Path B: computed on demand).</p>`;
  document.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/custom?name=${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
      loadCustom();
    })
  );
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

async function loadAdmin(me) {
  if (!me.is_admin) return;
  $("#admin").hidden = false;
  const defs = await api("/api/admin/group_defs");
  $("#defs-json").value = JSON.stringify(defs.group_defs, null, 2);
  $("#defs-save").addEventListener("click", async () => {
    try {
      const group_defs = JSON.parse($("#defs-json").value);
      const r = await api("/api/admin/group_defs", { method: "PUT", body: JSON.stringify({ group_defs }) });
      $("#defs-status").textContent = `saved (defs_version ${r.defs_version})`;
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
  $("#whoami").textContent = me.email + (me.is_admin ? " (admin)" : "");
  await Promise.all([loadShared(), loadCustom(), loadPicker(), loadAdmin(me)]);
  setInterval(loadShared, 60_000);
})().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="error">${e.message}</p>`);
});

// Weather radar panel for the rf-aggregator UI. Consumes LibreWXR (RainViewer-v2
// shape): GET /public/weather-maps.json lists frames; tiles come from
//   {host}/v2/radar/{ts}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
// LibreWXR sends CORS `*`, so the browser talks to either source directly — no
// proxy. Base map tiles are CARTO (muted, theme-matched) so the colored radar
// reads on top; that's the one external tile dependency (images, not code).
//
// Exposes window.initRadar({ getSource, saveSource }); app.js calls it after the
// user's config loads so the chosen source persists per-user via /api/config.
(function () {
  "use strict";

  // ── SOURCES ────────────────────────────────────────────────────────────
  // Switchable radar backends. `base` is the metadata origin; tile URLs are
  // built from the `host` field the metadata returns, so a self-hosted instance
  // only needs its LIBREWXR_PUBLIC_URL set correctly.
  const SOURCES = {
    public: { label: "Public · api.librewxr.net", base: "https://api.librewxr.net" },
    // <FILL> Komodo self-hosted librewxr public URL, e.g. "https://radar.example.net"
    komodo: { label: "Komodo · self-hosted", base: "" },
  };

  // Map center. Sensors carry no lat/lon, so this is a config value. Set to the
  // owner's location (owner-only Access app), zoom ~9 for a local radar view.
  const HOME = { lat: 43.1301, lon: -88.4747, zoom: 9 };

  const COLOR = 7;        // 7 = Rainbow @ Selex SI (closest to a standard radar look)
  const SMOOTH = 1, SNOW = 0;
  const SIZE = window.devicePixelRatio >= 2 ? 512 : 256;  // retina crispness
  const REFRESH_MS = 5 * 60 * 1000;   // librewxr updates every 10 min; refetch every 5
  const PLAY_MS = 500, END_PAUSE_MS = 1500;

  let map, baseLayer;
  let api = null, frames = [], nowcastStart = -1;
  let pos = 0, playing = false, timer = null, cache = {}, current = null;
  let source = "public", base = "", saveSourceCb = null;

  const el = (id) => document.getElementById(id);

  // ── theme-matched base map ─────────────────────────────────────────────
  function effectiveTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function baseTileUrl() {
    const style = effectiveTheme() === "dark" ? "dark_all" : "light_all";
    return "https://{s}.basemaps.cartocdn.com/" + style + "/{z}/{x}/{y}{r}.png";
  }
  function setBase() {
    const layer = L.tileLayer(baseTileUrl(), {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      subdomains: "abcd", maxZoom: 12, detectRetina: true,
    });
    layer.addTo(map);
    layer.bringToBack();
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = layer;
  }

  // ── radar frames ───────────────────────────────────────────────────────
  function tileUrl(frame) {
    return api.host + frame.path + "/" + SIZE + "/{z}/{x}/{y}/" + COLOR + "/" + SMOOTH + "_" + SNOW + ".png";
  }
  function makeLayer(frame) {
    return L.tileLayer(tileUrl(frame), { tileSize: 256, opacity: 0.001, maxZoom: 12, zIndex: 5 });
  }
  function clearLayers() {
    for (const k in cache) { if (cache[k]) map.removeLayer(cache[k]); }
    cache = {}; current = null;
  }
  function status(msg) {
    const s = el("radar-status");
    if (!msg) { s.hidden = true; s.textContent = ""; return; }
    s.hidden = false; s.textContent = msg;
  }
  function setTimeLabel(frame, i) {
    const dt = new Date(frame.time * 1000);
    const s = dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    el("radar-time").innerHTML =
      nowcastStart >= 0 && i >= nowcastStart ? '<span class="fc">' + s + " · forecast</span>" : s;
  }

  function showFrame(i) {
    if (!frames.length) return;
    i = ((i % frames.length) + frames.length) % frames.length;
    pos = i;
    const frame = frames[i];
    setTimeLabel(frame, i);
    el("radar-scrub").value = String(i);

    if (cache[i]) {
      cache[i].setOpacity(0.85);
      if (current && current !== cache[i]) current.setOpacity(0);
      current = cache[i];
      scheduleNext();
      return;
    }
    const layer = makeLayer(frame);
    layer.on("load", function () {
      layer.setOpacity(0.85);
      if (current && current !== layer) current.setOpacity(0);
      current = layer;
      cache[i] = layer;
      scheduleNext();
    });
    layer.addTo(map);
  }

  function scheduleNext() {
    if (!playing) return;
    if (timer) clearTimeout(timer);
    const delay = pos === frames.length - 1 ? END_PAUSE_MS : PLAY_MS;
    timer = setTimeout(function () { showFrame(pos + 1); }, delay);
  }
  function play() {
    if (!frames.length) return;
    playing = true;
    el("radar-play").innerHTML = "❚❚ Pause";
    showFrame(pos + 1);
  }
  function stop() {
    playing = false;
    el("radar-play").innerHTML = "▶ Play";
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function togglePlay() { playing ? stop() : play(); }

  function onMoveStart() {
    // tiles are only valid for the loaded viewport — drop all but the current frame
    stop();
    for (const k in cache) {
      if (parseInt(k, 10) !== pos && cache[k]) { map.removeLayer(cache[k]); delete cache[k]; }
    }
  }

  // ── metadata load ──────────────────────────────────────────────────────
  async function loadMeta() {
    if (!base) return;
    status("Loading radar…");
    try {
      const r = await fetch(base + "/public/weather-maps.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const past = (d.radar && d.radar.past) || [];
      const nowcast = (d.radar && d.radar.nowcast) || [];
      if (!past.length) throw new Error("no frames yet");
      api = d;
      frames = past.slice();
      nowcastStart = -1;
      if (nowcast.length) { nowcastStart = frames.length; frames = frames.concat(nowcast); }
      clearLayers();
      el("radar-scrub").max = String(frames.length - 1);
      el("radar-attr").textContent = "LibreWXR · " + (source === "public" ? "public" : "self-hosted");
      pos = nowcastStart >= 0 ? nowcastStart - 1 : frames.length - 1;
      status("");
      showFrame(pos);
    } catch (e) {
      frames = [];
      el("radar-time").textContent = "—";
      status("Radar unavailable from “" + SOURCES[source].label + "”: " + e.message);
    }
  }

  function setSource(name) {
    if (!SOURCES[name]) name = "public";
    source = name;
    base = SOURCES[name].base;
    el("radar-source").value = name;
    stop();
    clearLayers();
    if (!base) {
      frames = [];
      el("radar-time").textContent = "—";
      status("“" + SOURCES[name].label + "” has no URL configured yet — set its `base` in /radar.js.");
      return;
    }
    loadMeta();
  }

  // ── init (called by app.js after config loads) ─────────────────────────
  window.initRadar = function (opts) {
    opts = opts || {};
    saveSourceCb = opts.saveSource || null;

    map = L.map("radar-map", { minZoom: 2, maxZoom: 12, worldCopyJump: true })
      .setView([HOME.lat, HOME.lon], HOME.zoom);
    setBase();

    const sel = el("radar-source");
    sel.innerHTML = "";
    for (const k of Object.keys(SOURCES)) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = SOURCES[k].label + (SOURCES[k].base ? "" : " (unset)");
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () {
      setSource(sel.value);
      if (saveSourceCb) saveSourceCb(sel.value);
    });

    el("radar-play").addEventListener("click", togglePlay);
    el("radar-step-back").addEventListener("click", function () { stop(); showFrame(pos - 1); });
    el("radar-step-fwd").addEventListener("click", function () { stop(); showFrame(pos + 1); });
    el("radar-scrub").addEventListener("input", function (e) { stop(); showFrame(parseInt(e.target.value, 10)); });
    map.on("movestart", onMoveStart);

    // keep the base map in sync with the app theme
    new MutationObserver(setBase).observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", setBase);

    let saved = opts.getSource && opts.getSource();
    if (!SOURCES[saved]) saved = "public";
    setSource(saved);

    setInterval(loadMeta, REFRESH_MS);
  };
})();

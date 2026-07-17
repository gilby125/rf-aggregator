// 7-day forecast from the US National Weather Service (api.weather.gov — free, no
// key, CORS `*`). Flow: /points/{lat},{lon} → the gridpoint forecast URL → periods
// (day/night). Rendered as 7 day cards; clicking a card reveals that day's written
// forecast (NWS detailedForecast for the day + night).
(function () {
  "use strict";

  // Same location as the radar HOME (owner's coords).
  const LOC = { lat: 43.1301, lon: -88.4747 };
  const REFRESH_MS = 30 * 60 * 1000; // NWS updates ~hourly

  let days = [], selected = 0;

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // shortForecast text → a weather emoji (self-contained; no external icon fetch).
  function emoji(text, isDay) {
    const t = (text || "").toLowerCase();
    if (/(thunder|t-storm|tstorm)/.test(t)) return "⛈️";
    if (/snow|flurr|blizzard|wintry|sleet|ice/.test(t)) return "❄️";
    if (/(freezing|rain|shower|drizzle)/.test(t)) return "🌧️";
    if (/fog|haze|smoke/.test(t)) return "🌫️";
    if (/(wind|breez)/.test(t)) return "💨";
    if (/(mostly cloudy|overcast)/.test(t)) return "☁️";
    if (/(partly|mostly sunny|partly sunny|few clouds|scattered cloud)/.test(t)) return isDay ? "⛅" : "🌤️";
    if (/(sunny|clear|fair)/.test(t)) return isDay ? "☀️" : "🌙";
    if (/cloud/.test(t)) return "☁️";
    return isDay ? "🌡️" : "🌙";
  }

  const dow = (iso, i) => {
    if (i === 0) return "Today";
    try { return new Date(iso).toLocaleDateString([], { weekday: "short" }); }
    catch { return ""; }
  };

  function status(msg) {
    const s = el("fc-status");
    if (!s) return;
    s.textContent = msg || "";
    s.hidden = !msg;
  }

  function renderDays() {
    el("fc-days").innerHTML = days.map((d, i) => {
      const p = d.day || d.night;
      const hi = d.day ? `${d.day.temperature}°` : "—";
      const lo = d.night ? `${d.night.temperature}°` : "—";
      const pop = Math.max((d.day?.pop ?? 0), (d.night?.pop ?? 0));
      return `<button class="fc-day${i === selected ? " selected" : ""}" data-idx="${i}" type="button">
        <span class="fc-dow">${esc(dow((p || {}).startTime, i))}</span>
        <span class="fc-ico" aria-hidden="true">${emoji(p && p.shortForecast, !!d.day)}</span>
        <span class="fc-temps"><span class="hi">${hi}</span><span class="lo">${lo}</span></span>
        <span class="fc-short">${esc((d.day || d.night).shortForecast)}</span>
        ${pop > 0 ? `<span class="fc-pop">💧 ${pop}%</span>` : ""}
      </button>`;
    }).join("");
    el("fc-days").querySelectorAll(".fc-day").forEach((b) =>
      b.addEventListener("click", () => { selected = +b.dataset.idx; renderDays(); renderDetail(); }));
  }

  function renderDetail() {
    const d = days[selected];
    if (!d) return;
    const block = (p) => p ? `<h4>${esc(p.name)}</h4><p>${esc(p.detailedForecast)}</p>` : "";
    el("fc-detail").innerHTML = block(d.day) + block(d.night);
    el("fc-detail").hidden = false;
  }

  async function load() {
    status("Loading forecast…");
    try {
      const pts = await fetch(`https://api.weather.gov/points/${LOC.lat},${LOC.lon}`, {
        headers: { accept: "application/geo+json" },
      });
      if (!pts.ok) throw new Error("points HTTP " + pts.status);
      const pj = await pts.json();
      const place = pj.properties?.relativeLocation?.properties;
      if (place) el("fc-place").textContent = `NWS · ${place.city}, ${place.state}`;

      const fc = await fetch(pj.properties.forecast, { headers: { accept: "application/geo+json" } });
      if (!fc.ok) throw new Error("forecast HTTP " + fc.status);
      const periods = (await fc.json()).properties.periods || [];

      const byDate = new Map();
      for (const p of periods) {
        const key = (p.startTime || "").slice(0, 10);
        if (!key) continue;
        if (!byDate.has(key)) byDate.set(key, {});
        const slot = byDate.get(key);
        const norm = { ...p, pop: (p.probabilityOfPrecipitation || {}).value ?? 0 };
        if (p.isDaytime) slot.day = norm; else slot.night = norm;
      }
      days = [...byDate.values()].filter((d) => d.day || d.night).slice(0, 7);
      if (!days.length) throw new Error("no periods");
      if (selected >= days.length) selected = 0;
      status("");
      renderDays();
      renderDetail();
    } catch (e) {
      status("Forecast unavailable: " + e.message);
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();

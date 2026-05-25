// Lite prosjektkart (forside + markedsføring) – gjenbruker /api/driftssentral.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);
  let cache = null, fetching = null;
  const maps = {}; // id -> {map, markers}

  function getData() {
    if (cache) return Promise.resolve(cache);
    if (!fetching) fetching = fetch("/api/driftssentral").then((r) => r.ok ? r.json() : { projects: [] }).then((d) => { cache = d; return d; }).catch(() => ({ projects: [] }));
    return fetching;
  }

  function initMap(id) {
    if (maps[id] || typeof L === "undefined") return maps[id];
    const el = document.getElementById(id);
    if (!el) return null;
    const map = L.map(id, { scrollWheelZoom: false }).setView([59.8, 6.2], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    const markers = L.layerGroup().addTo(map);
    maps[id] = { map, markers };
    return maps[id];
  }

  async function show(id) {
    const m = initMap(id);
    if (!m) return;
    setTimeout(() => m.map.invalidateSize(), 120);
    const d = await getData();
    m.markers.clearLayers();
    const pts = [];
    for (const p of (d.projects || [])) {
      if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
      m.markers.addLayer(L.marker([p.lat, p.lon]).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.customer || "")}<br>${num(p.hours)} t siste 8 uker`));
      pts.push([p.lat, p.lon]);
    }
    if (pts.length) { try { m.map.fitBounds(pts, { padding: [25, 25], maxZoom: 11 }); } catch {} }
  }

  // Forsiden er synlig ved oppstart
  if (document.getElementById("frontMap")) setTimeout(() => show("frontMap"), 400);
  // Markedsføring lastes når fanen åpnes
  const mkt = document.querySelector('.tab[data-tab="markedsforing"]');
  if (mkt) mkt.addEventListener("click", () => show("mktMap"));
})();

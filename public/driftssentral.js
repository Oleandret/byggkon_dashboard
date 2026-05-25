// Public driftssentral: OpenStreetMap-kart med prosjekt-pins (siste 8 uker) + rullende prosjektliste.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);
  let map = null, markers = null, loaded = false, pollTimer = null;

  function err(m) { const el = document.getElementById("errorBanner"); if (el) { el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); } }

  function initMap() {
    if (map || typeof L === "undefined") return;
    map = L.map("dsMap", { scrollWheelZoom: false }).setView([59.8, 6.2], 7); // Vestlandet som start
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap",
    }).addTo(map);
    markers = L.layerGroup().addTo(map);
  }

  function renderMarquee(projects) {
    document.getElementById("dsProjCount").textContent = projects.length;
    const item = (p) => `<div class="proj-item">
      <div class="pn">${esc(p.number || "")}</div>
      <div class="nm">${esc(p.name)}</div>
      <div class="meta"><span>${esc(p.customer || "—")}</span><span>${num(p.hours)} t (8 uker)</span></div>
    </div>`;
    const track = document.getElementById("dsTrack");
    const html = projects.map(item).join("");
    track.innerHTML = html + html;
    track.style.animationDuration = Math.max(60, projects.length * 3.5) + "s";
    track.style.animationPlayState = projects.length > 6 ? "running" : "paused";
  }

  function renderPins(projects) {
    if (!map || !markers) return;
    markers.clearLayers();
    const pts = [];
    for (const p of projects) {
      if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
      const m = L.marker([p.lat, p.lon]).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.customer || "")}<br>${num(p.hours)} t siste 8 uker`);
      markers.addLayer(m);
      pts.push([p.lat, p.lon]);
    }
    if (pts.length) {
      try { map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 }); } catch {}
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/driftssentral");
      if (res.status === 401) { location.href = "/login"; return; }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
      const d = await res.json();
      const projects = d.projects || [];
      renderMarquee(projects);
      renderPins(projects);
      const note = document.getElementById("dsMapNote");
      if (note) {
        const pinned = projects.filter((p) => typeof p.lat === "number").length;
        note.textContent = `${pinned} av ${projects.length} prosjekter plassert på kartet. ${d.pending ? "Flere posisjoner hentes i bakgrunnen – oppdateres automatisk." : ""}`;
      }
      // Geokoding skjer noen få om gangen på serveren – hent på nytt til alt er plassert.
      if (d.pending) { clearTimeout(pollTimer); pollTimer = setTimeout(refresh, 9000); }
    } catch (e2) { err("Kunne ikke hente driftssentral: " + e2.message); }
  }

  function clock() {
    const el = document.getElementById("dsClock");
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long" }) + " · " +
      now.toLocaleTimeString("nb-NO");
  }

  function activate() {
    if (!loaded) {
      loaded = true;
      initMap();
      // Leaflet trenger synlig container for riktig størrelse
      setTimeout(() => { if (map) map.invalidateSize(); refresh(); }, 120);
      setInterval(clock, 1000); clock();
    } else if (map) {
      setTimeout(() => map.invalidateSize(), 120);
    }
  }

  const tab = document.querySelector('.tab[data-tab="driftssentral"]');
  if (tab) tab.addEventListener("click", activate);
  const link = document.getElementById("driftLink");
  if (link && tab) link.addEventListener("click", () => tab.click());
})();

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

  function renderFocus(focus) {
    const track = document.getElementById("dsFocusTrack");
    if (!track) return;
    focus = focus || [];
    if (!focus.length) { track.innerHTML = `<div class="empty" style="padding:14px">Ingen timer ført siste 2 uker.</div>`; track.style.animation = "none"; return; }
    // Kompakt: én ansatt = to korte linjer (navn + timer, og toppprosjekt). Lettere å se alle.
    const item = (e) => {
      const top = (e.projects || [])[0];
      const proj = top ? `${esc(top.name)}${top.customer ? ` · ${esc(top.customer)}` : ""} (${num(top.hours)} t)` : "—";
      const extra = (e.projects || []).length > 1 ? `<span class="dsf-extra">+${e.projects.length - 1}</span>` : "";
      return `<div class="dsf-row">
        <div class="dsf-line1"><span class="dsf-name">${esc(e.name)}</span><span class="dsf-tot">${num(e.totalHours)} t</span></div>
        <div class="dsf-line2">${proj} ${extra}</div>
      </div>`;
    };
    const html = focus.map(item).join("");
    track.innerHTML = html + html;
    track.style.animation = "";
    track.style.animationDuration = Math.max(50, focus.length * 3) + "s";
    track.style.animationPlayState = focus.length > 8 ? "running" : "paused";
  }
  function renderWeather(disp) {
    const el = document.getElementById("dsWeather");
    if (el && disp && disp.weather) {
      const w = disp.weather;
      el.innerHTML = `<div class="hw-now">${w.current.symbol} ${w.current.temp}°<span class="hw-place"> ${esc(w.place)}</span></div>` +
        `<div class="hw-days">${(w.days || []).map((day) => `<div class="hw-day"><span class="hw-lbl">${esc(day.label)}</span><span class="hw-sym">${day.symbol}</span><span class="hw-t">${day.max}° / ${day.min}°</span></div>`).join("")}</div>`;
    }
    const addr = document.getElementById("dsAddr");
    if (addr && disp && disp.companyAddress) addr.textContent = "📍 " + disp.companyAddress;
    const head = document.getElementById("dsHeader");
    if (head && disp && disp.heroImageUrl) {
      head.style.backgroundImage = `linear-gradient(90deg, rgba(3,2,19,.78), rgba(3,2,19,.45)), url('${disp.heroImageUrl}')`;
      head.classList.add("has-hero");
    }
  }
  function renderCapacity(billingWeek) {
    const el = document.getElementById("dsCapacity");
    if (!el) return;
    const free = (billingWeek || [])
      .filter((b) => !/ole\s*andre/i.test(b.name || "")) // daglig leder vises ikke som ledig
      .filter((b) => (b.billingRate || 0) < 0.6)
      .sort((a, b) => (a.billingRate || 0) - (b.billingRate || 0));
    if (!free.length) { el.innerHTML = `<span class="subnote">Alle godt booket 👍</span>`; return; }
    el.innerHTML = free.map((b) => `<span class="ds-cap-chip">${esc(b.name)} <b>${Math.round((b.billingRate || 0) * 100)}%</b></span>`).join("");
  }
  async function refreshFocus() {
    try {
      const d = await (await fetch("/api/overview")).json();
      renderFocus(d.employeeFocus);
      renderWeather(d.display);
      renderCapacity(d.billingWeek);
    } catch {}
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
      setTimeout(() => { if (map) map.invalidateSize(); refresh(); refreshFocus(); }, 120);
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

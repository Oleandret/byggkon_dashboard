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
    el.innerHTML = free.map((b) => `<span class="ds-cap-chip">${esc(b.name)}</span>`).join("");
  }
  async function refreshFocus() {
    try {
      const d = await (await fetch("/api/overview")).json();
      renderFocus(d.employeeFocus);
      renderWeather(d.display);
      renderCapacity(d.billingWeek);
    } catch {}
  }
  function nokShort(n) { n = n || 0; if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + " mill"; if (Math.abs(n) >= 1e3) return Math.round(n / 1000) + " k"; return String(Math.round(n)); }
  function fillMarquee(trackId, items, makeItem) {
    const track = document.getElementById(trackId);
    if (!track) return;
    if (!items.length) { track.innerHTML = `<div class="empty" style="padding:14px">Ingen data.</div>`; track.style.animation = "none"; return; }
    const html = items.map(makeItem).join("");
    track.innerHTML = html + html;
    track.style.animation = "";
    track.style.animationDuration = Math.max(60, items.length * 3.5) + "s";
    track.style.animationPlayState = items.length > 8 ? "running" : "paused";
  }
  async function refreshSuppliers() {
    try {
      const res = await fetch("/api/costs");
      if (!res.ok) return;
      const d = await res.json();
      const sup = (d.suppliers || []).slice(0, 30);
      fillMarquee("dsSupTrack", sup, (s) => `<div class="proj-item"><div class="nm">${esc(s.name)}</div><div class="meta"><span>${num(s.count)} fakturaer</span><span>${nokShort(s.cost)} kr</span></div></div>`);
    } catch {}
  }
  async function refreshCustomers() {
    try {
      const res = await fetch("/api/customers");
      if (!res.ok) return;
      const d = await res.json();
      const top = (d.customers || []).slice(0, 20);
      fillMarquee("dsCustTrack", top, (c, i) => `<div class="proj-item"><div class="nm">${i + 1}. ${esc(c.name)}</div><div class="meta"><span>${esc(c.topProjectManager || "—")}</span><span>${nokShort(c.revenue)} kr</span></div></div>`);
    } catch {}
  }
  async function refreshContacts() {
    try {
      const res = await fetch("/api/org");
      if (!res.ok) return;
      const d = await res.json();
      const wrap = document.getElementById("dsContacts");
      if (!wrap) return;
      const people = (d.nodes || []).filter((p) => p.name && (p.email || p.phone))
        .sort((a, b) => a.name.localeCompare(b.name, "nb"));
      if (!people.length) { wrap.innerHTML = `<div class="empty">Ingen kontaktinfo registrert.</div>`; return; }
      wrap.innerHTML = people.map((p) => `<div class="ds-contact">
        <div class="dsc-name">${esc(p.name)}</div>
        ${p.title ? `<div class="dsc-title">${esc(p.title)}</div>` : ""}
        ${p.phone ? `<div class="dsc-line">📞 <a href="tel:${esc(p.phone.replace(/\s/g, ""))}">${esc(p.phone)}</a></div>` : ""}
        ${p.email ? `<div class="dsc-line">✉️ <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ""}
      </div>`).join("");
    } catch {}
  }

  function renderPins(projects) {
    if (!map || !markers) return;
    markers.clearLayers();
    const pts = [];
    for (const p of projects) {
      if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
      const popup = `<b>${esc(p.name)}</b><br>${esc(p.customer || "")}<br>${num(p.hours)} t siste 8 uker${p.approx ? "<br><i>omtrentlig plassering</i>" : ""}`;
      const m = p.approx
        ? L.circleMarker([p.lat, p.lon], { radius: 7, color: "#e8a33d", weight: 2, fillColor: "#f3c969", fillOpacity: .6 }).bindPopup(popup)
        : L.marker([p.lat, p.lon]).bindPopup(popup);
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
        const exact = projects.filter((p) => typeof p.lat === "number" && !p.approx).length;
        const approx = projects.filter((p) => p.approx).length;
        note.textContent = `${exact} prosjekter plassert på adresse${approx ? `, ${approx} omtrentlig (gul)` : ""}. ${d.pending ? "Flere hentes i bakgrunnen – oppdateres automatisk." : ""}`;
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
      setTimeout(() => { if (map) map.invalidateSize(); refresh(); refreshFocus(); refreshSuppliers(); refreshCustomers(); refreshContacts(); }, 120);
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

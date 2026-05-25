// Bygg-Kon Sanntidsoversikt – henter /api/overview, tegner alt, oppdaterer selv.
let revenueChart;
let refreshMs = 60 * 1000;
let timer;
let lastData = null;
let cakeReminders = [];

const nok = (n) => new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n || 0);
const nokShort = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString("nb-NO", { maximumFractionDigits: 1 }) + " M";
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + "k";
  return Math.round(v).toString();
};
const num = (n, d = 0) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: d }).format(n || 0);
const pct = (n) => `${Math.round((n || 0) * 100)} %`;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Antatt kostnadskategori utledet fra leverandørnavn (gir oversikt over hva kostnaden er).
const COST_RULES = [
  ["IT / programvare", /microsoft|adobe|autodesk|google|openai|anthropic|claude|atlassian|slack|dropbox|github|1password|fokus|statcon|revit|autocad|mercell|prosjektagent|holte|norsk prisbok|fdv|fyxer|n8n|nextify|nova|webflow|domene|domeneshop|abonnement.*software/i],
  ["Telefoni / internett", /phonero|telenor|telia|ice|altibox|gigafib|broadband|internett|mobil/i],
  ["Husleie / lokaler", /utleie|eiendom|husleie|travbane|aider.*leie|lokale|kontorleie/i],
  ["Forsikring", /forsikring|tryg|gjensidige|if\b|fremtind|storebrand.*forsik/i],
  ["Regnskap / revisjon", /regnskap|revisjon|aider|revisor|accounting|byrå/i],
  ["Bank / finans", /\bbank\b|dnb|sparebank|nordea|finans|factoring|kredinor/i],
  ["Reise / transport", /flytog|sas|norwegian|vy\b|hotell|hotel|bilutleie|drivstoff|circle k|esso|shell|bom|ferge/i],
  ["Markedsføring", /markedsf|reklame|annonse|facebook|meta\b|linkedin|google ads|nextify/i],
  ["Kontor / rekvisita", /staples|kontor|rekvisita|møbler|ikea|elkjøp|power\b|clas ohlson/i],
  ["Faglitteratur / kurs", /standard\.no|standard online|kurs|sertifisering|nkf|rif|tekna|nito|faglitteratur/i],
];
function costCategory(name) {
  const n = String(name || "");
  for (const [label, re] of COST_RULES) if (re.test(n)) return label;
  return "Annet / ukategorisert";
}

// Nøkkeltall-kort (brukes i KPI-stripa på økonomisiden)
function kpiCard({ label, value, sub = "", cls = "", accent = false }) {
  return `<div class="kpi-card${accent ? " accent" : ""}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value ${cls}">${value}</div>
    ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}
  </div>`;
}

function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = msg; el.hidden = false;
  setTimeout(() => (el.hidden = true), 9000);
}

/* ---- Påminnelser (dato-basert) ---- */
function renderReminders() {
  const el = document.getElementById("remindersList");
  if (!el) return;
  const now = new Date();
  const dow = now.getDay(); // 0=søn ... 5=fre
  const day = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const items = [...cakeReminders];
  if (dow === 5) {
    items.push("⏱️ Husk å føre timer for denne uka.");
    items.push("📣 Send prosjektene du jobber med til Daniel (sosiale medier).");
  }
  if (day >= lastDay - 3 || day <= 4) {
    items.push("🧾 Månedsskifte: husk å fakturere kunder.");
  }
  el.innerHTML = items.length
    ? items.map((t) => `<div class="rem-item">${t}</div>`).join("")
    : `<div class="empty">Ingen påminnelser akkurat nå.</div>`;
}

/* ---- Tilbud-status (rediger/lagre) ---- */
(function () {
  const eb = document.getElementById("tbEdit"), sb = document.getElementById("tbSave");
  if (!eb) return;
  const ids = ["tbSendt", "tbVunnet", "tbTapt"];
  eb.addEventListener("click", () => {
    const on = document.getElementById("tbSendt").disabled;
    ids.forEach((i) => (document.getElementById(i).disabled = !on));
    eb.textContent = on ? "🔒 Lås" : "🔓 Rediger"; sb.hidden = !on;
  });
  sb.addEventListener("click", async () => {
    sb.disabled = true;
    try {
      const body = { sendt: +document.getElementById("tbSendt").value || 0, vunnet: +document.getElementById("tbVunnet").value || 0, tapt: +document.getElementById("tbTapt").value || 0 };
      const res = await fetch("/api/tilbud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("Lagring feilet");
      ids.forEach((i) => (document.getElementById(i).disabled = true));
      eb.textContent = "🔓 Rediger"; sb.hidden = true; sb.textContent = "Lagret ✓"; setTimeout(() => (sb.textContent = "Lagre"), 2000);
    } catch (e) { showError("Kunne ikke lagre tilbud: " + e.message); } finally { sb.disabled = false; }
  });
})();

/* ---- AI-rapport ---- */
(function () {
  const btn = document.getElementById("repGenerate");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const prompt = document.getElementById("repPrompt").value.trim();
    const status = document.getElementById("repStatus");
    const out = document.getElementById("repOutput");
    if (!prompt) { status.textContent = "Skriv hva du vil ha rapport om."; return; }
    btn.disabled = true; status.textContent = "Genererer …"; out.hidden = true;
    try {
      const res = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Feil");
      out.textContent = d.report || "(tomt svar)";
      out.hidden = false; status.textContent = "";
    } catch (e) { status.textContent = "Feil: " + e.message; }
    finally { btn.disabled = false; }
  });
})();

/* ---- Driftssentral-lenke -> åpne Oversikt ---- */
(function () {
  const dl = document.getElementById("driftLink");
  if (dl) dl.addEventListener("click", () => { const t = document.querySelector('.tab[data-tab="oversikt"]'); if (t) t.click(); });
})();

/* ---- Sidemeny ---- */
(function setupSidebar() {
  const sb = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const toggle = document.getElementById("menuToggle");
  if (!sb) return;
  let locked = localStorage.getItem("bk_sidebar_locked") === "1";
  function apply() {
    document.body.classList.toggle("sidebar-locked", locked);
    document.getElementById("sidebarLock").textContent = locked ? "📌 Låst" : "📌";
  }
  function open() { sb.classList.add("open"); if (!locked) overlay.hidden = false; }
  function close() { if (locked) return; sb.classList.remove("open"); overlay.hidden = true; }
  toggle.addEventListener("click", () => (sb.classList.contains("open") ? close() : open()));
  document.getElementById("sidebarClose").addEventListener("click", () => { locked = false; localStorage.setItem("bk_sidebar_locked", "0"); apply(); sb.classList.remove("open"); overlay.hidden = true; });
  document.getElementById("sidebarLock").addEventListener("click", () => { locked = !locked; localStorage.setItem("bk_sidebar_locked", locked ? "1" : "0"); apply(); if (locked) open(); });
  overlay.addEventListener("click", close);
  sb.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { if (!locked) close(); }));
  // Sammenleggbare grupper i menyen (husker tilstand)
  const collapsed = JSON.parse(localStorage.getItem("bk_nav_collapsed") || "[]");
  sb.querySelectorAll(".nav-group").forEach((g, i) => {
    const head = g.querySelector(".nav-group-head");
    if (collapsed.includes(i)) g.classList.add("collapsed");
    head.addEventListener("click", () => {
      g.classList.toggle("collapsed");
      const c = [...sb.querySelectorAll(".nav-group")].map((x, j) => (x.classList.contains("collapsed") ? j : -1)).filter((j) => j >= 0);
      localStorage.setItem("bk_nav_collapsed", JSON.stringify(c));
    });
  });
  apply();
  if (locked) sb.classList.add("open");
})();

/* ---- Klokke ---- */
function tickClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  document.getElementById("date").textContent = now.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long" });
}

/* ---- Faner ---- */
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    if (!t.dataset.tab) return; // lenke-faner (f.eks. Innstillinger) navigerer selv
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("panel-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "okonomi") loadEconomy();
    if (t.dataset.tab === "kunder") loadCustomers();
    if (t.dataset.tab === "kostnader") loadCosts();
    if (t.dataset.tab === "itsystem") loadItCosts();
    if (t.dataset.tab === "prosjekter" && !projectNotesLoaded) { projectNotesLoaded = true; loadProjectNotes(); }
  });
});
let projectNotesLoaded = false;

/* ---- IT-kostnader fra Tripletex (lazy) ---- */
let itCostsLoaded = false;
async function loadItCosts(force = false) {
  if (itCostsLoaded && !force) return;
  const status = document.getElementById("itCostStatus");
  try {
    const res = await fetch("/api/it-costs");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    itCostsLoaded = true;
    if (status) status.hidden = true;
    const rows = (d.suppliers || []).map((c, i) => [String(i + 1), esc(c.name), num(c.count), nok(c.cost)]);
    if (rows.length) rows.push(["", "<b>Total IT 12 mnd</b>", "", `<b>${nok(d.total || 0)}</b>`]);
    fillTable("itCostTable",
      [{ label: "#" }, { label: "Leverandør" }, { label: "Fakturaer", num: true }, { label: "Kostnad 12 mnd", num: true }],
      rows, "Ingen IT-kostnader funnet i Tripletex.");
  } catch (err) {
    if (status) { status.hidden = false; status.textContent = "Kunne ikke hente IT-kostnader: " + err.message; }
  }
}

/* ---- Kostnader-fane (lazy) ---- */
let costsLoaded = false;
async function loadCosts(force = false) {
  if (costsLoaded && !force) return;
  const status = document.getElementById("kostStatus");
  try {
    const res = await fetch("/api/costs");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    status.hidden = true; costsLoaded = true;
    try { const m = await (await fetch("/api/suppliermeta")).json(); supplierMeta = m.meta || {}; } catch {}
    const sup = d.suppliers || [];
    const rows = sup.map((c, i) => {
      const m = supplierMeta[c.name] || {};
      return [
        String(i + 1), esc(c.name), `<span class="cost-cat">${esc(costCategory(c.name))}</span>`, num(c.count), nok(c.cost),
        `<label class="ramme-toggle"><input type="checkbox" class="sm-ramme" data-name="${esc(c.name)}" ${m.rammeavtale ? "checked" : ""}/> <span></span></label>`,
        `<input class="sm-input sm-ansvarlig" data-name="${esc(c.name)}" value="${esc(m.ansvarlig || "")}" placeholder="Hvem forhandler?" />`,
        `<input class="sm-input sm-status" data-name="${esc(c.name)}" value="${esc(m.status || "")}" placeholder="Status / notat" />`,
      ];
    });
    rows.push(["", "<b>Total</b>", "", "", `<b>${nok(d.total || 0)}</b>`, "", "", ""]);
    fillTable("kostTable",
      [{ label: "#" }, { label: "Leverandør" }, { label: "Hva er kostnaden? (antatt)" }, { label: "Antall", num: true }, { label: "Kostnad 12 mnd", num: true },
       { label: "Rammeavtale" }, { label: "Forhandlingsansvarlig" }, { label: "Status / aksjon" }],
      rows, "Ingen kostnader funnet.");
    const withRamme = sup.filter((c) => (supplierMeta[c.name] || {}).rammeavtale).length;
    const sumEl = document.getElementById("kostRammeSummary");
    if (sumEl) sumEl.innerHTML = `<b>${withRamme}</b> av <b>${sup.length}</b> leverandører har rammeavtale. <span class="subnote">Huk av når avtale er på plass, og noter hvem som forhandler.</span>`;
  } catch (err) {
    status.hidden = false; status.textContent = "Kunne ikke hente kostnader: " + err.message;
  }
}
let supplierMeta = {};
async function saveSupplierMeta(name) {
  const row = (sel) => document.querySelector(`${sel}[data-name="${CSS.escape(name)}"]`);
  const ramme = row("input.sm-ramme"); const ansv = row(".sm-ansvarlig"); const st = row(".sm-status");
  const payload = { name, rammeavtale: ramme ? ramme.checked : false, ansvarlig: ansv ? ansv.value.trim() : "", status: st ? st.value.trim() : "" };
  supplierMeta[name] = { rammeavtale: payload.rammeavtale, ansvarlig: payload.ansvarlig, status: payload.status };
  try { await fetch("/api/suppliermeta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
  catch (e) { showError("Kunne ikke lagre leverandørinfo: " + e.message); }
}
(function () {
  const tbl = document.getElementById("kostTable");
  if (!tbl) return;
  tbl.addEventListener("change", (e) => { const t = e.target; if (t.classList.contains("sm-ramme") || t.classList.contains("sm-input")) saveSupplierMeta(t.dataset.name); });
})();

/* ---- Kunder-fane (lazy) ---- */
let customersLoaded = false, kunderChart;
async function loadCustomers(force = false) {
  if (customersLoaded && !force) return;
  const status = document.getElementById("kunderStatus");
  try {
    const res = await fetch("/api/customers");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    status.hidden = true;
    customersLoaded = true;
    fillTable("kunderTable",
      [{ label: "#" }, { label: "Kunde" }, { label: "Mest aktiv prosjektleder" }, { label: "Kontakt / e-post" }, { label: "Telefon" }, { label: "Omsetning 12 mnd", num: true }, { label: "Fakturaer", num: true }],
      d.customers.map((c, i) => [
        String(i + 1), esc(c.name),
        esc(c.topProjectManager || "—"),
        c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—",
        esc(c.phone || "—"),
        nok(c.revenue), num(c.invoices),
      ]),
      "Ingen kunder funnet.");

    // Graf: topp 10 kunder
    const top = d.customers.slice(0, 10);
    const ctx = document.getElementById("kunderChart");
    if (ctx && top.length) {
      const data = { labels: top.map((c) => c.name), datasets: [{ data: top.map((c) => c.revenue), backgroundColor: css("--accent"), borderRadius: 5 }] };
      const opts = {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => nok(c.raw) } } },
        scales: {
          x: { ticks: { color: css("--muted"), callback: (v) => nokShort(v) }, grid: { color: css("--grid") } },
          y: { ticks: { color: css("--muted"), font: { size: 11 } }, grid: { display: false } },
        },
      };
      if (kunderChart) { kunderChart.data = data; kunderChart.update(); }
      else kunderChart = new Chart(ctx, { type: "bar", data, options: opts });
    }
  } catch (err) {
    status.hidden = false; status.textContent = "Kunne ikke hente kunder: " + err.message;
  }
}

/* ---- Hero ---- */
function renderHero(d) {
  const k = d.kpis;
  if (d.display?.heroImageUrl) {
    document.getElementById("hero").style.backgroundImage = `url('${d.display.heroImageUrl}')`;
  }
  if (d.display?.companyName) {
    document.getElementById("heroTitle").textContent = d.display.companyName;
    document.getElementById("brandName").textContent = d.display.companyName;
  }
  // Firmalogo i toppen (erstatter tekst-merket hvis lastet opp)
  const logo = document.getElementById("brandLogo");
  if (logo) {
    if (d.display?.logoUrl) {
      logo.src = d.display.logoUrl;
      logo.alt = d.display.companyName || "Logo";
      logo.hidden = false;
      const bn = document.getElementById("brandName");
      if (bn) bn.hidden = true;
    } else {
      logo.hidden = true;
      const bn = document.getElementById("brandName");
      if (bn) bn.hidden = false;
    }
  }
  const chips = [
    { label: "Omsetning i år", value: nok(k.revenueYTD) },
    { label: "Utestående", value: nok(k.outstandingTotal), cls: k.overdueTotal > 0 ? "warn" : "" },
    { label: "Forfalt", value: nok(k.overdueTotal), cls: k.overdueTotal > 0 ? "bad" : "" },
    { label: "Aktive prosjekter", value: k.activeProjects },
    { label: "Åpne ordre", value: k.openOrders },
    { label: "Timer denne mnd.", value: num(k.hoursThisMonth) },
    { label: "Snitt faktureringsgrad", value: pct(k.avgBillingRate) },
    { label: "Ledig kapasitet", value: `${k.freeCapacityCount} ansatte` },
  ];
  document.getElementById("heroKpis").innerHTML = chips.map((c) =>
    `<div class="hero-kpi"><div class="label">${c.label}</div><div class="value ${c.cls || ""}">${c.value}</div></div>`
  ).join("");

  // Adresse + vær
  if (d.display?.companyAddress) document.getElementById("heroAddress").textContent = "📍 " + d.display.companyAddress;
  const w = d.display?.weather;
  const hw = document.getElementById("heroWeather");
  if (w && hw) {
    hw.innerHTML =
      `<div class="hw-now">${w.current.symbol} ${w.current.temp}°<span class="hw-place"> ${esc(w.place)}</span></div>` +
      `<div class="hw-days">${w.days.map((day) =>
        `<div class="hw-day"><span class="hw-lbl">${esc(day.label)}</span><span class="hw-sym">${day.symbol}</span><span class="hw-t">${day.max}° / ${day.min}°</span></div>`
      ).join("")}</div>`;
  }

  // Verdier (dynamisk fra innstillinger)
  const vs = document.getElementById("valuesStrip");
  if (vs && Array.isArray(d.display?.values)) {
    vs.innerHTML = `<span class="values-title">Våre verdier</span>` +
      d.display.values.map((v) =>
        `<div class="value"><span class="vl">${esc(v.letter)}</span><span class="vw">${esc(v.text)}</span></div>`
      ).join("");
  }

  // Avdelinger (kort)
  const avd = document.getElementById("avdGrid");
  if (avd && Array.isArray(d.display?.departments)) {
    avd.innerHTML = d.display.departments.length
      ? d.display.departments.map((name) =>
          `<div class="scaffold-card"><div class="sc-title">${esc(name)}</div><div class="sc-note">Eget dashboard kommer</div></div>`
        ).join("")
      : `<div class="sc-note">Ingen avdelinger satt opp ennå.</div>`;
  }

  // Bursdager — blinkende banner + kake-påminnelse til Lana
  const bd = d.display?.birthdays || { today: [], inWeek: [] };
  const banner = document.getElementById("birthdayBanner");
  if (banner) {
    if (bd.today.length) { banner.hidden = false; banner.innerHTML = `🎉 Gratulerer med dagen, ${bd.today.map(esc).join(" & ")}! 🎂`; }
    else banner.hidden = true;
  }
  cakeReminders = (bd.inWeek || []).map((n) => `🎂 Lana: bestill kake til ${esc(n)} — bursdag om en uke.`);
  renderReminders();
}

/* ---- Rullende prosjekter ---- */
function renderProjectsMarquee(projects) {
  document.getElementById("projCount").textContent = projects.length;
  const item = (p) => `<div class="proj-item">
    <div class="pn">${esc(p.number)}</div>
    <div class="nm">${esc(p.name)}</div>
    <div class="meta"><span>${esc(p.customer || "—")}</span><span>${p.hours4w ? num(p.hours4w) + " t (4 uker)" : esc(p.projectManager || "")}</span></div>
  </div>`;
  const html = projects.map(item).join("");
  // Dobles for sømløs løkke
  const track = document.getElementById("projTrack");
  track.innerHTML = html + html;
  // Rull sakte: ca. 3,5 sek per prosjekt, minst 60 sek for hele runden
  track.style.animationDuration = Math.max(60, projects.length * 3.5) + "s";
  track.style.animationPlayState = projects.length > 6 ? "running" : "paused";
}

function renderTimesheet(ts) {
  const wrap = document.getElementById("timesheetGrid");
  if (!wrap) return;
  ts = ts || { days: [], employees: [] };
  if (!ts.employees.length) { wrap.innerHTML = `<div class="empty">Ingen aktive ansatte å spore timer for denne uka.</div>`; return; }
  const head = `<div class="ts-row ts-head"><span class="ts-name"></span>${ts.days.map((d) => `<span class="ts-cell">${esc(d.label)}</span>`).join("")}<span class="ts-stat">Status</span></div>`;
  const rows = ts.employees.map((e) =>
    `<div class="ts-row${e.missingCount > 0 ? " has-missing" : ""}">
      <span class="ts-name">${esc(e.name)}</span>
      ${e.logged.map((l) => `<span class="ts-cell ${l ? "ok" : "miss"}">${l ? "✓" : "✕"}</span>`).join("")}
      <span class="ts-stat">${e.missingCount > 0 ? `<span class="ts-badge">mangler ${e.missingCount}</span>` : `<span class="ts-ok">OK</span>`}</span>
    </div>`).join("");
  wrap.innerHTML = head + rows;
}

function renderFocusMarquee(focus) {
  const track = document.getElementById("focusTrack");
  if (!track) return;
  focus = focus || [];
  if (!focus.length) {
    track.innerHTML = `<div class="empty" style="padding:14px">Ingen timer ført siste 2 uker ennå.</div>`;
    track.style.animation = "none";
    return;
  }
  const item = (e) => {
    const projs = (e.projects || []).map((p, i) =>
      `<div class="focus-proj${i === 0 ? " top" : ""}"><span class="fp-name">${esc(p.name)}${p.customer ? ` · <span class="fp-cust">${esc(p.customer)}</span>` : ""}</span><span class="fp-hours">${num(p.hours)} t</span></div>`
    ).join("");
    return `<div class="focus-item">
      <div class="focus-head"><span class="focus-name">${esc(e.name)}</span><span class="focus-tot">${num(e.totalHours)} t</span></div>
      <div class="focus-projs">${projs}</div>
    </div>`;
  };
  const html = focus.map(item).join("");
  track.innerHTML = html + html; // dobles for sømløs løkke
  track.style.animation = "";
  track.style.animationDuration = Math.max(60, focus.length * 5) + "s";
  track.style.animationPlayState = focus.length > 4 ? "running" : "paused";
}

/* ---- Faktureringsgrad ---- */
function bucket(rate) {
  if (rate < 0.6) return { cls: "free", tag: "Ledig kapasitet" };
  if (rate < 0.85) return { cls: "mid", tag: "Moderat" };
  return { cls: "high", tag: "Høy utnyttelse" };
}
function renderBilling(billing) {
  const el = document.getElementById("billingList");
  if (!billing.length) { el.innerHTML = `<div class="empty">Ingen timer ført siste 4 uker ennå.</div>`; return; }
  el.innerHTML = billing.map((b) => {
    const bk = bucket(b.billingRate);
    const w = Math.min(100, Math.round(b.billingRate * 100));
    return `<div class="billing-row ${bk.cls}">
      <div class="nm">${esc(b.name)}</div>
      <div class="pct">${pct(b.billingRate)}</div>
      <div class="billing-bar"><span style="width:${w}%"></span></div>
      <div class="tag ${bk.cls}">${bk.tag} · ${num(b.billable)} av ${num(b.hours)} t</div>
    </div>`;
  }).join("");
}

/* ---- Omsetningsgraf ---- */
const MONTHS = ["Jan","Feb","Mar","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Des"];
function renderRevenueChart(monthly) {
  const ctx = document.getElementById("revenueChart");
  const data = { labels: MONTHS, datasets: [{ data: monthly, backgroundColor: css("--accent"), borderRadius: 6 }] };
  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => nok(c.raw) } } },
    scales: {
      x: { ticks: { color: css("--muted") }, grid: { display: false } },
      y: { ticks: { color: css("--muted"), callback: (v) => nokShort(v) }, grid: { color: css("--grid") } },
    },
  };
  if (revenueChart) { revenueChart.data = data; revenueChart.update(); }
  else revenueChart = new Chart(ctx, { type: "bar", data, options: opts });
}

/* ---- Tabeller ---- */
function fillTable(id, headers, rows, emptyMsg) {
  const t = document.getElementById(id);
  if (!t) return;
  if (!rows.length) { t.innerHTML = `<tbody><tr><td class="empty">${emptyMsg}</td></tr></tbody>`; return; }
  const head = `<thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].num ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("");
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderOutstanding(d) {
  fillTable("outstandingTable",
    [{ label: "Faktura" }, { label: "Kunde" }, { label: "Forfall" }, { label: "Utestående", num: true }, { label: "Status" }, { label: "Purr" }],
    d.outstanding.map((o) => [
      esc(o.invoiceNumber), esc(o.customer), o.dueDate || "—", nok(o.outstanding),
      o.overdue ? `<span class="pill overdue">Forfalt</span>` : `<span class="pill ok">Åpen</span>`,
      o.id ? `<a class="pill purr" href="https://tripletex.no/execute/invoiceMenu?invoiceId=${o.id}" target="_blank" rel="noopener" title="Åpne i Tripletex for å sende purring">Purr ↗</a>` : "—",
    ]),
    "Ingen utestående fakturaer.");
}
function renderOrders(d) {
  fillTable("ordersTable",
    [{ label: "Nr" }, { label: "Kunde" }, { label: "Ordredato" }, { label: "Levering" }],
    d.orders.map((o) => [esc(o.number), esc(o.customer), o.orderDate || "—", o.deliveryDate || "—"]),
    "Ingen åpne ordre.");
}

function populateProjEmp() {
  const sel = document.getElementById("projEmp");
  const cur = sel.value;
  const names = (lastData.billing || []).map((b) => b.name).filter((n) => n && n !== "Ukjent")
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">Alle ansatte</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (names.includes(cur)) sel.value = cur;
}

function renderProjectsTable() {
  if (!lastData) return;
  const q = (document.getElementById("projSearch").value || "").toLowerCase();
  const emp = document.getElementById("projEmp").value;
  let rows = lastData.projectsDetailed.slice();
  if (emp) rows = rows.filter((p) => (p.byEmp4w && p.byEmp4w[emp]) > 0);
  if (q) rows = rows.filter((p) =>
    `${p.number} ${p.name} ${p.customer} ${p.projectManager}`.toLowerCase().includes(q));
  // Mest timer øverst: per valgt ansatt hvis valgt, ellers totalt siste 4 uker
  if (emp) rows.sort((a, b) => (b.byEmp4w[emp] || 0) - (a.byEmp4w[emp] || 0));
  else rows.sort((a, b) => (b.hours4w || 0) - (a.hours4w || 0) || (b.hoursYTD || 0) - (a.hoursYTD || 0));
  const hoursLabel = emp ? `Timer 4 uker · ${emp.split(" ")[0]}` : "Timer 4 uker";
  fillTable("projectsTable",
    [{ label: "Nr" }, { label: "Prosjekt" }, { label: "Kunde" }, { label: "Prosjekteier" },
     { label: hoursLabel, num: true }, { label: "Timer i år", num: true }, { label: "Fakturerbart i år", num: true }, { label: "Siste aktivitet" }, { label: "Notat (viktig)" }],
    rows.map((p) => [
      esc(p.number), esc(p.name), esc(p.customer), esc(p.projectManager),
      num(emp ? (p.byEmp4w[emp] || 0) : p.hours4w), num(p.hoursYTD), num(p.billableYTD), p.lastActivity || "—",
      `<input class="proj-note" data-num="${esc(p.number)}" value="${esc(projectNotes[p.number] || "")}" placeholder="Notat …" />`,
    ]),
    emp ? `Ingen prosjekter for ${esc(emp)} siste 4 uker.` : "Ingen prosjekter funnet.");
}
document.getElementById("projSearch").addEventListener("input", renderProjectsTable);
document.getElementById("projEmp").addEventListener("change", renderProjectsTable);
// Lagre prosjektnotat ved blur/enter
let projectNotes = {};
(function () {
  const tbl = document.getElementById("projectsTable");
  if (!tbl) return;
  async function save(num, note) {
    projectNotes[num] = note;
    try { await fetch("/api/projectnotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: num, note }) }); }
    catch (e) { showError("Kunne ikke lagre notat: " + e.message); }
  }
  tbl.addEventListener("change", (e) => { const i = e.target.closest(".proj-note"); if (i) save(i.dataset.num, i.value.trim()); });
  tbl.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("proj-note")) e.target.blur(); });
})();
async function loadProjectNotes() {
  try { const d = await (await fetch("/api/projectnotes")).json(); projectNotes = d.notes || {}; renderProjectsTable(); } catch {}
}

function renderResource() {
  if (!lastData) return;
  const rows = lastData.projectsDetailed
    .filter((p) => (p.hours4w || 0) > 0)
    .sort((a, b) => (b.hours4w || 0) - (a.hours4w || 0));
  fillTable("pmResource",
    [{ label: "Prosjekt" }, { label: "Kunde" }, { label: "Prosjektleder" }, { label: "Timer 4 uker", num: true }, { label: "Hvem jobber på det (timer)" }],
    rows.map((p) => {
      const who = Object.entries(p.byEmp4w || {}).sort((a, b) => b[1] - a[1])
        .map(([navn, t]) => `${esc(navn)} (${num(t)} t)`).join(", ");
      return [esc(p.name), esc(p.customer), esc(p.projectManager || "—"), num(p.hours4w), who || "—"];
    }),
    "Ingen timer ført siste 4 uker.");
  populatePmEmpFilter();
  renderEmpResource();
  renderCapacity();
}

// Kapasitet: ansatte sortert etter faktureringsgrad (lavest = mest ledig).
function renderCapacity() {
  const billing = (lastData && lastData.billing) || [];
  const rows = [...billing].sort((a, b) => (a.billingRate || 0) - (b.billingRate || 0));
  fillTable("pmCapacity",
    [{ label: "Ansatt" }, { label: "Faktureringsgrad" }, { label: "Timer (4 uker)", num: true }, { label: "Vurdering" }],
    rows.map((b) => {
      const bk = bucket(b.billingRate);
      const w = Math.min(100, Math.round((b.billingRate || 0) * 100));
      const tag = b.billingRate < 0.6 ? "Ledig kapasitet" : b.billingRate < 0.85 ? "Litt rom" : "Godt booket";
      return [
        esc(b.name),
        `<div class="ratecell"><b>${pct(b.billingRate)}</b><div class="ratebar"><span style="width:${w}%"></span></div></div>`,
        num(b.hours),
        `<span class="tag ${bk.cls}">${tag}</span>`,
      ];
    }),
    "Ingen timer ført siste 4 uker.");
}

// Bygger per-ansatt-oversikt fra prosjektdata: hver ansatt -> prosjektene de
// har ført timer på siste 4 uker, sortert med flest timer øverst.
function buildEmpProjects() {
  const map = new Map();
  for (const p of (lastData.projectsDetailed || [])) {
    for (const [navn, t] of Object.entries(p.byEmp4w || {})) {
      if (!t) continue;
      const cur = map.get(navn) || { navn, total: 0, projects: [] };
      cur.total += t;
      cur.projects.push({ name: p.name, customer: p.customer, hours: t });
      map.set(navn, cur);
    }
  }
  const arr = [...map.values()].sort((a, b) => b.total - a.total);
  arr.forEach((e) => e.projects.sort((a, b) => b.hours - a.hours));
  return arr;
}

function populatePmEmpFilter() {
  const sel = document.getElementById("pmEmpFilter");
  if (!sel) return;
  const prev = sel.value;
  const emps = buildEmpProjects();
  sel.innerHTML = `<option value="">Alle ansatte</option>` +
    emps.map((e) => `<option value="${esc(e.navn)}">${esc(e.navn)} (${num(e.total)} t)</option>`).join("");
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  if (!sel.dataset.wired) {
    sel.addEventListener("change", renderEmpResource);
    sel.dataset.wired = "1";
  }
}

function renderEmpResource() {
  const wrap = document.getElementById("pmEmpResource");
  if (!wrap || !lastData) return;
  const sel = document.getElementById("pmEmpFilter");
  const filter = sel ? sel.value : "";
  let emps = buildEmpProjects();
  if (filter) emps = emps.filter((e) => e.navn === filter);
  if (!emps.length) { wrap.innerHTML = `<div class="empty">Ingen timer ført siste 4 uker.</div>`; return; }
  wrap.innerHTML = emps.map((e) => {
    const maxH = Math.max(...e.projects.map((p) => p.hours), 1);
    const initials = e.navn.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return `<div class="emp-res-group">
      <div class="emp-res-head">
        <span class="emp-res-avatar">${esc(initials)}</span>
        <span class="emp-res-name">${esc(e.navn)}</span>
        <span class="emp-res-tot">${num(e.total)} t</span>
      </div>
      <div class="emp-res-projs">${e.projects.map((p) => `
        <div class="emp-res-proj">
          <div class="erp-info"><span class="erp-name">${esc(p.name)}</span>${p.customer ? `<span class="erp-cust">${esc(p.customer)}</span>` : ""}</div>
          <div class="erp-bar"><span style="width:${Math.round((p.hours / maxH) * 100)}%"></span></div>
          <div class="erp-hours">${num(p.hours)} t</div>
        </div>`).join("")}</div>
    </div>`;
  }).join("");
}

/* ---- Hovedlasting ---- */
async function load() {
  try {
    const res = await fetch("/api/overview");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    lastData = d;
    if (d.display?.refreshSeconds) {
      const ms = d.display.refreshSeconds * 1000;
      if (ms !== refreshMs) { refreshMs = ms; clearInterval(timer); timer = setInterval(load, refreshMs); }
    }
    renderHero(d);
    renderProjectsMarquee(d.projects);
    renderTimesheet(d.timesheetWeek);
    renderFocusMarquee(d.employeeFocus);
    renderBilling(d.billing);
    renderRevenueChart(d.monthlyRevenue);
    renderOutstanding(d);
    renderOrders(d);
    populateProjEmp();
    renderProjectsTable();
    renderResource();
    const upd = document.getElementById("updated");
    const snap = d._snapshot;
    if (snap && snap.stale) {
      upd.textContent = "⚠ Viser sist kjente data (når ikke Tripletex) — sist oppdatert " + new Date(snap.savedAt).toLocaleString("nb-NO");
      upd.classList.add("stale");
    } else {
      upd.textContent = "Oppdatert " + new Date(d.updatedAt || (snap && snap.savedAt) || Date.now()).toLocaleTimeString("nb-NO");
      upd.classList.remove("stale");
    }
  } catch (err) {
    showError("Kunne ikke hente data: " + err.message);
    document.getElementById("updated").textContent = "Feil ved oppdatering";
  }
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  document.getElementById("updated").textContent = "Henter ferske tall …";
  await fetch("/api/refresh", { method: "POST" });
  economyLoaded = false;
  load();
  if (document.getElementById("panel-okonomi").classList.contains("active")) loadEconomy(true);
});

/* ---- Økonomi-fane (lazy-lastet ved første åpning) ---- */
let economyLoaded = false, ecoTrendChart, ecoBillChart, ecoBillTrendChart;
const cls = (n) => (n < 0 ? "neg" : "pos");
function plRow(label, value, { total = false, sub = false, color = false } = {}) {
  const c = `pl-row ${total ? "total" : ""} ${sub ? "sub" : ""}`;
  const vc = color ? cls(value) : "";
  return `<div class="${c}"><span class="lbl">${label}</span><span class="val ${vc}">${nok(value)}</span></div>`;
}

function renderEconomy(d) {
  document.getElementById("ecoYear").textContent = d.period.yearLabel;

  // Nøkkeltall-stripe
  const ok = (lastData && lastData.kpis) || {};
  const rev = d.resultYTD.revenue, opres = d.resultYTD.operatingResult;
  const margin = rev > 0 ? opres / rev : 0;
  document.getElementById("ecoKpis2").innerHTML = [
    kpiCard({ label: "Fakturert i år", value: nok(rev), accent: true }),
    kpiCard({ label: "Utestående", value: nok(ok.outstandingTotal || 0), sub: ok.overdueTotal > 0 ? `forfalt ${nok(ok.overdueTotal)}` : "" }),
    kpiCard({ label: "Driftsresultat", value: nok(opres), cls: opres < 0 ? "bad" : "good", sub: "dekningsgrad " + pct(margin) }),
    kpiCard({ label: "Aktive prosjekter", value: ok.activeProjects || 0 }),
    kpiCard({ label: "Timer denne uka", value: num(d.hoursThisWeek) }),
  ].join("");
  // Tilbud-verdier
  const tb = d.tilbud || { sendt: 0, vunnet: 0, tapt: 0 };
  if (!document.getElementById("tbSendt").matches(":focus")) document.getElementById("tbSendt").value = tb.sendt;
  if (!document.getElementById("tbVunnet").matches(":focus")) document.getElementById("tbVunnet").value = tb.vunnet;
  if (!document.getElementById("tbTapt").matches(":focus")) document.getElementById("tbTapt").value = tb.tapt;
  const pl = (r) =>
    plRow("Driftsinntekter", r.revenue) +
    plRow("Driftskostnader", r.opex) +
    plRow("Driftsresultat", r.operatingResult, { total: true, color: true }) +
    plRow("Finansposter", r.finance) +
    plRow("Resultat før skatt (EBT)", r.ebt, { total: true, color: true });
  document.getElementById("ecoResYTD").innerHTML = pl(d.resultYTD);
  document.getElementById("ecoResLTM").innerHTML = pl(d.resultLTM);

  const b = d.balance;
  document.getElementById("ecoBalance").innerHTML =
    plRow("Sum eiendeler", b.assets, { total: false }) +
    plRow("herav bankinnskudd", b.bank, { sub: true, color: true }) +
    plRow("herav kundefordringer", b.receivables, { sub: true }) +
    plRow("Egenkapital", b.equity) +
    plRow("Gjeld", b.liabilities) +
    plRow("herav leverandørgjeld", b.supplierDebt, { sub: true });

  const q = d.liquidity;
  document.getElementById("ecoLiq").innerHTML =
    plRow("Bankinnskudd", q.bank, { color: true }) +
    plRow("+ Kundefordringer", q.receivables) +
    plRow("− Leverandørgjeld", q.supplierDebt) +
    plRow("= Netto likviditet", q.net, { total: true, color: true });

  // Trend: inntekter (søyler) + EBT (linje)
  const ctx = document.getElementById("ecoTrend");
  const data = {
    labels: d.trend.map((t) => t.label),
    datasets: [
      { type: "bar", label: "Sum inntekter", data: d.trend.map((t) => t.revenue), backgroundColor: css("--accent"), borderRadius: 5, order: 2 },
      { type: "line", label: "EBT", data: d.trend.map((t) => t.ebt), borderColor: css("--ink"), backgroundColor: css("--ink"), tension: 0.3, order: 1 },
    ],
  };
  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: css("--muted") } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${nok(c.raw)}` } } },
    scales: { x: { ticks: { color: css("--muted") }, grid: { display: false } },
      y: { ticks: { color: css("--muted"), callback: (v) => nokShort(v) }, grid: { color: css("--grid") } } },
  };
  if (ecoTrendChart) { ecoTrendChart.data = data; ecoTrendChart.update(); }
  else ecoTrendChart = new Chart(ctx, { type: "bar", data, options: opts });

  // Graf: faktureringsgrad-utvikling siste 6 mnd (samlet, viser fremdrift)
  const bt = d.billingTrend || [];
  const ctx3 = document.getElementById("ecoBillTrend");
  if (ctx3) {
    const btData = {
      labels: bt.map((t) => t.label),
      datasets: [{
        label: "Faktureringsgrad", data: bt.map((t) => Math.round(t.billingRate * 100)),
        borderColor: css("--accent"), backgroundColor: "rgba(30,139,111,.12)",
        fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: css("--accent"),
      }],
    };
    const btOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.raw} %  (${num((bt[c.dataIndex] || {}).hours || 0)} t)` } },
      },
      scales: {
        x: { ticks: { color: css("--muted") }, grid: { display: false } },
        y: { suggestedMin: 0, suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } },
      },
    };
    if (ecoBillTrendChart) { ecoBillTrendChart.data = btData; ecoBillTrendChart.update(); }
    else ecoBillTrendChart = new Chart(ctx3, { type: "line", data: btData, options: btOpts });
  }

  const rateBar = (v) => `<div class="ratebar"><span style="width:${Math.min(100, Math.round(v * 100))}%"></span></div>`;
  const b3 = d.billing3m || { employees: [], total: { billingRate: 0, hours: 0, billable: 0 } };
  const emps = b3.employees;

  // Graf: faktureringsgrad per ansatt + samlet
  const ctx2 = document.getElementById("ecoBillChart");
  const labels = emps.map((e) => e.name.split(" ")[0]).concat(["SAMLET"]);
  const data2 = emps.map((e) => Math.round(e.billingRate * 100)).concat([Math.round(b3.total.billingRate * 100)]);
  const colors = emps.map(() => css("--accent")).concat([css("--ink")]);
  const cfg2 = {
    type: "bar",
    data: { labels, datasets: [{ data: data2, backgroundColor: colors, borderRadius: 5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw + " %" } } },
      scales: {
        x: { ticks: { color: css("--muted"), maxRotation: 60, minRotation: 45 }, grid: { display: false } },
        y: { suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } },
      },
    },
  };
  if (ecoBillChart) { ecoBillChart.data = cfg2.data; ecoBillChart.update(); }
  else ecoBillChart = new Chart(ctx2, cfg2);

  // ---- Optimaliseringstips (utledet fra tallene) ----
  const tips = [];
  tips.push(["ok", "Sterk vekst", "Selskapet har vokst fra 3 til 15 ansatte på ett år. Det gir naturlig økte kostnader (rekruttering, lønn og markedsføring) — viktig kontekst når resultat og likviditet vurderes."]);
  const k = (lastData && lastData.kpis) || {};
  if (k.overdueTotal > 0) tips.push(["warn", "Forfalte fakturaer", `${nok(k.overdueTotal)} er forfalt. Send purring (Oversikt → Utestående → «Purr»).`]);
  if (d.balance.bank < 0) tips.push(["warn", "Negativ bank", `Bankbeholdning ${nok(d.balance.bank)}. Vurder likviditetstiltak: raskere fakturering, kortere forfall (20 dager), evt. innbetaling fra eier.`]);
  if (d.resultYTD.ebt < 0) tips.push(["warn", "Negativt resultat i år", `Resultat før skatt ${nok(d.resultYTD.ebt)}. Gå gjennom kostnadene opp mot fakturerbar tid.`]);
  const br = d.billing3m.total.billingRate;
  if (br < 0.65) tips.push(["warn", "Lav faktureringsgrad", `Samlet ${pct(br)} siste 3 mnd (bransjenorm 65–75 %). Fordel arbeid til ledig kapasitet og øk salgsinnsatsen.`]);
  else tips.push(["ok", "God faktureringsgrad", `Samlet ${pct(br)} siste 3 mnd — i tråd med bransjenorm.`]);
  const low = d.billing3m.employees.filter((e) => e.billingRate < 0.5).length;
  if (low > 0) tips.push(["info", "Ledig kapasitet", `${low} ansatt(e) under 50 % faktureringsgrad. Finn fakturerbart arbeid til dem (Bærekraftige relasjoner).`]);
  if (d.balance.receivables > 0) tips.push(["info", "Kundefordringer", `${nok(d.balance.receivables)} utestående hos kunder. Følg opp betaling jevnlig.`]);
  tips.push(["info", "Pris", "Hold og øk timeprisene på nye prosjekter og rammeavtaler."]);
  tips.push(["info", "Salg", "Prioriter de beste kundene (se Kunder-fanen) — vi vil ha mer av dem."]);
  const tipsEl = document.getElementById("ecoTips");
  if (tipsEl) tipsEl.innerHTML = tips.map(([t, h, b]) => `<div class="tip tip-${t}"><div class="tip-h">${esc(h)}</div><div class="tip-b">${esc(b)}</div></div>`).join("");

  // Tabell
  const ut = document.getElementById("ecoUtil");
  if (!emps.length) {
    ut.innerHTML = `<tbody><tr><td class="empty">Ingen ansatte med timer siste 3 måneder.</td></tr></tbody>`;
  } else {
    ut.innerHTML =
      `<thead><tr><th>Ansatt</th><th class="num">Timer (3 mnd)</th><th class="num">Fakturerbart</th><th>Faktureringsgrad</th></tr></thead>` +
      `<tbody>${emps.map((u) => `<tr>
        <td>${esc(u.name)}</td>
        <td class="num">${num(u.hours)}</td>
        <td class="num">${num(u.billable)}</td>
        <td><div class="ratecell"><b>${pct(u.billingRate)}</b>${rateBar(u.billingRate)}</div></td>
      </tr>`).join("")}
      <tr class="lic-total"><td><b>Samlet</b></td><td class="num"><b>${num(b3.total.hours)}</b></td><td class="num"><b>${num(b3.total.billable)}</b></td><td><div class="ratecell"><b>${pct(b3.total.billingRate)}</b>${rateBar(b3.total.billingRate)}</div></td></tr></tbody>`;
  }
}

async function loadEconomy(force = false) {
  if (economyLoaded && !force) return;
  const status = document.getElementById("ecoStatus");
  const content = document.getElementById("ecoContent");
  status.hidden = false; status.textContent = "Laster økonomi … (henter regnskapstall, kan ta noen sekunder)";
  content.hidden = true;
  try {
    const res = await fetch("/api/economy");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    renderEconomy(d);
    economyLoaded = true;
    status.hidden = true; content.hidden = false;
  } catch (err) {
    status.hidden = false; status.textContent = "Kunne ikke hente økonomi: " + err.message;
  }
}

/* ---- Intern kommunikasjon ---- */
async function loadMessages() {
  const feed = document.getElementById("commFeed");
  if (!feed) return;
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) return;
    const d = await res.json();
    const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
    feed.innerHTML = (d.messages || []).map((m) => {
      const t = new Date(m.ts);
      const when = t.toLocaleString("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `<div class="comm-msg"><span class="comm-meta"><b>${esc(m.name)}</b> · ${when}</span><div class="comm-text">${esc(m.text)}</div></div>`;
    }).join("") || `<div class="empty">Ingen meldinger ennå. Skriv den første!</div>`;
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  } catch { /* stille */ }
}
(function () {
  const send = document.getElementById("commSend");
  if (!send) return;
  const nameEl = document.getElementById("commName");
  const textEl = document.getElementById("commText");
  if (nameEl) nameEl.value = localStorage.getItem("bk_comm_name") || "";
  async function post() {
    const text = textEl.value.trim(); if (!text) return;
    if (nameEl.value) localStorage.setItem("bk_comm_name", nameEl.value.trim());
    send.disabled = true;
    try {
      const res = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nameEl.value.trim(), text }) });
      if (!res.ok) throw new Error("Sending feilet");
      textEl.value = ""; await loadMessages();
      document.getElementById("commFeed").scrollTop = document.getElementById("commFeed").scrollHeight;
    } catch (e) { showError("Kunne ikke sende: " + e.message); } finally { send.disabled = false; }
  }
  send.addEventListener("click", post);
  textEl.addEventListener("keydown", (e) => { if (e.key === "Enter") post(); });
})();

/* ---- Siste nytt (RSS fra aviser) ---- */
async function loadRss() {
  const el = document.getElementById("rssFeed");
  if (!el) return;
  try {
    const res = await fetch("/api/news-feed");
    if (!res.ok) return;
    const d = await res.json();
    const items = d.items || [];
    if (!items.length) { el.innerHTML = `<div class="empty">Ingen nyheter tilgjengelig nå.</div>`; return; }
    el.innerHTML = items.map((n) =>
      `<a class="rss-item" href="${esc(n.link)}" target="_blank" rel="noopener">
        <span class="rss-src">${esc(n.source)}</span><span class="rss-title">${esc(n.title)}</span>
      </a>`).join("");
  } catch { /* stille */ }
}

tickClock();
setInterval(tickClock, 1000);
renderReminders();
loadRss();
setInterval(loadRss, 15 * 60 * 1000);
loadMessages();
setInterval(loadMessages, 20 * 1000);
setInterval(renderReminders, 60 * 60 * 1000);
load();
timer = setInterval(load, refreshMs);

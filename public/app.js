// Bygg-Kon Sanntidsoversikt – henter /api/overview, tegner alt, oppdaterer selv.
let revenueChart;
let refreshMs = 60 * 1000;
let timer;
let lastData = null;

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
  const items = [];
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
  });
});

/* ---- Kunder-fane (lazy) ---- */
let customersLoaded = false;
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
      [{ label: "#" }, { label: "Kunde" }, { label: "Omsetning 12 mnd", num: true }, { label: "Fakturaer", num: true }],
      d.customers.map((c, i) => [String(i + 1), esc(c.name), nok(c.revenue), num(c.invoices)]),
      "Ingen kunder funnet.");
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
  if (!rows.length) { t.innerHTML = `<tbody><tr><td class="empty">${emptyMsg}</td></tr></tbody>`; return; }
  const head = `<thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].num ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("");
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderOutstanding(d) {
  fillTable("outstandingTable",
    [{ label: "Faktura" }, { label: "Kunde" }, { label: "Forfall" }, { label: "Utestående", num: true }, { label: "Status" }],
    d.outstanding.map((o) => [
      esc(o.invoiceNumber), esc(o.customer), o.dueDate || "—", nok(o.outstanding),
      o.overdue ? `<span class="pill overdue">Forfalt</span>` : `<span class="pill ok">Åpen</span>`,
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
    [{ label: "Nr" }, { label: "Prosjekt" }, { label: "Kunde" }, { label: "Prosjektleder" },
     { label: hoursLabel, num: true }, { label: "Timer i år", num: true }, { label: "Fakturerbart i år", num: true }, { label: "Siste aktivitet" }],
    rows.map((p) => [
      esc(p.number), esc(p.name), esc(p.customer), esc(p.projectManager),
      num(emp ? (p.byEmp4w[emp] || 0) : p.hours4w), num(p.hoursYTD), num(p.billableYTD), p.lastActivity || "—",
    ]),
    emp ? `Ingen prosjekter for ${esc(emp)} siste 4 uker.` : "Ingen prosjekter funnet.");
}
document.getElementById("projSearch").addEventListener("input", renderProjectsTable);
document.getElementById("projEmp").addEventListener("change", renderProjectsTable);

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
    renderBilling(d.billing);
    renderRevenueChart(d.monthlyRevenue);
    renderOutstanding(d);
    renderOrders(d);
    populateProjEmp();
    renderProjectsTable();
    document.getElementById("updated").textContent = "Oppdatert " + new Date(d.updatedAt).toLocaleTimeString("nb-NO");
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
let economyLoaded = false, ecoTrendChart;
const cls = (n) => (n < 0 ? "neg" : "pos");
function plRow(label, value, { total = false, sub = false, color = false } = {}) {
  const c = `pl-row ${total ? "total" : ""} ${sub ? "sub" : ""}`;
  const vc = color ? cls(value) : "";
  return `<div class="${c}"><span class="lbl">${label}</span><span class="val ${vc}">${nok(value)}</span></div>`;
}

function renderEconomy(d) {
  document.getElementById("ecoYear").textContent = d.period.yearLabel;
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

  const rateBar = (v) => `<div class="ratebar"><span style="width:${Math.min(100, Math.round(v * 100))}%"></span></div>`;
  const ut = document.getElementById("ecoUtil");
  if (!d.utilization.length) {
    ut.innerHTML = `<tbody><tr><td class="empty">Ingen ansatte med timer siste 2 måneder.</td></tr></tbody>`;
  } else {
    ut.innerHTML =
      `<thead><tr><th>Ansatt</th><th class="num">Timer i år</th><th class="num">Fakturerbart</th><th>Faktureringsgrad</th><th>Utilization</th></tr></thead>` +
      `<tbody>${d.utilization.map((u) => `<tr>
        <td>${esc(u.name)}</td>
        <td class="num">${num(u.hours)}</td>
        <td class="num">${num(u.billable)}</td>
        <td><div class="ratecell"><b>${pct(u.billingRate)}</b>${rateBar(u.billingRate)}</div></td>
        <td><div class="ratecell"><b>${pct(u.utilization)}</b>${rateBar(u.utilization)}</div></td>
      </tr>`).join("")}</tbody>`;
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

tickClock();
setInterval(tickClock, 1000);
renderReminders();
setInterval(renderReminders, 60 * 60 * 1000);
load();
timer = setInterval(load, refreshMs);

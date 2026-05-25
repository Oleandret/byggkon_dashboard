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

/* ---- Klokke ---- */
function tickClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("date").textContent = now.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long" });
}

/* ---- Faner ---- */
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("panel-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "okonomi") loadEconomy();
  });
});

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

let projSort = { key: "hours4w", dir: -1 };
function renderProjectsTable() {
  if (!lastData) return;
  const q = (document.getElementById("projSearch").value || "").toLowerCase();
  let rows = lastData.projectsDetailed.filter((p) =>
    !q || `${p.number} ${p.name} ${p.customer} ${p.projectManager}`.toLowerCase().includes(q));
  rows = rows.sort((a, b) => {
    const va = a[projSort.key], vb = b[projSort.key];
    if (typeof va === "number") return (va - vb) * projSort.dir;
    return String(va || "").localeCompare(String(vb || "")) * projSort.dir;
  });
  fillTable("projectsTable",
    [{ label: "Nr" }, { label: "Prosjekt" }, { label: "Kunde" }, { label: "Prosjektleder" },
     { label: "Timer 4 uker", num: true }, { label: "Timer i år", num: true }, { label: "Fakturerbart i år", num: true }, { label: "Siste aktivitet" }],
    rows.map((p) => [
      esc(p.number), esc(p.name), esc(p.customer), esc(p.projectManager),
      num(p.hours4w), num(p.hoursYTD), num(p.billableYTD), p.lastActivity || "—",
    ]),
    "Ingen prosjekter funnet.");
}
document.getElementById("projSearch").addEventListener("input", renderProjectsTable);

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

  fillTable("ecoUtil",
    [{ label: "Ansatt" }, { label: "Timer", num: true }, { label: "Fakturerbart", num: true }, { label: "Faktureringsgrad", num: true }, { label: "Utilization", num: true }],
    d.utilization.map((u) => [esc(u.name), num(u.hours), num(u.billable), pct(u.billingRate), pct(u.utilization)]),
    "Ingen timer ført i år.");
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
load();
timer = setInterval(load, refreshMs);

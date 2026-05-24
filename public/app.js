// Dashboard-logikk: henter /api/overview, tegner KPI-er, grafer og tabeller.
// Oppdaterer automatisk hvert 60. sekund.

const REFRESH_INTERVAL_MS = 60 * 1000;
let revenueChart, hoursChart;

const nok = (n) =>
  new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n || 0);
const num = (n, d = 1) =>
  new Intl.NumberFormat("nb-NO", { maximumFractionDigits: d }).format(n || 0);
const pct = (n) => `${Math.round((n || 0) * 100)} %`;

function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 8000);
}

function kpiCard({ label, value, sub, cls = "", accent = false }) {
  return `<div class="kpi ${accent ? "accent" : ""}">
    <div class="label">${label}</div>
    <div class="value ${cls}">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

function renderKpis(k) {
  document.getElementById("kpis").innerHTML = [
    kpiCard({ label: "Omsetning hittil i år", value: nok(k.revenueYTD), accent: true }),
    kpiCard({
      label: "Utestående",
      value: nok(k.outstandingTotal),
      sub: k.overdueTotal > 0 ? `Herav forfalt: ${nok(k.overdueTotal)}` : "Ingen forfalt",
      cls: k.overdueTotal > 0 ? "bad" : "",
    }),
    kpiCard({ label: "Aktive prosjekter", value: k.activeProjects }),
    kpiCard({ label: "Åpne ordre", value: k.openOrders }),
    kpiCard({
      label: "Timer denne måneden",
      value: num(k.hoursThisMonth, 0),
      sub: `${num(k.chargeableHoursThisMonth, 0)} fakturerbare`,
    }),
    kpiCard({
      label: "Fakturerbar andel",
      value: pct(k.billableRatio),
      cls: k.billableRatio >= 0.6 ? "good" : "",
      sub: "denne måneden",
    }),
    kpiCard({ label: "Ansatte", value: k.employees }),
  ].join("");
}

const MONTHS = ["Jan","Feb","Mar","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Des"];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function renderRevenueChart(monthly) {
  const ctx = document.getElementById("revenueChart");
  const data = {
    labels: MONTHS,
    datasets: [{ label: "Omsetning", data: monthly, backgroundColor: css("--accent"), borderRadius: 6 }],
  };
  const opts = {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => nok(c.raw) } } },
    scales: {
      x: { ticks: { color: css("--muted") }, grid: { display: false } },
      y: { ticks: { color: css("--muted"), callback: (v) => (v / 1000) + "k" }, grid: { color: css("--border") } },
    },
  };
  if (revenueChart) { revenueChart.data = data; revenueChart.update(); }
  else revenueChart = new Chart(ctx, { type: "bar", data, options: opts });
}

function renderHoursChart(employeeHours) {
  const top = employeeHours.slice(0, 12);
  const ctx = document.getElementById("hoursChart");
  const data = {
    labels: top.map((e) => e.name),
    datasets: [
      { label: "Fakturerbart", data: top.map((e) => e.chargeable), backgroundColor: css("--accent"), borderRadius: 5 },
      { label: "Ikke fakturerbart", data: top.map((e) => Math.max(0, e.hours - e.chargeable)), backgroundColor: css("--accent-soft"), borderRadius: 5 },
    ],
  };
  const opts = {
    indexAxis: "y",
    responsive: true,
    plugins: { legend: { labels: { color: css("--muted") } } },
    scales: {
      x: { stacked: true, ticks: { color: css("--muted") }, grid: { color: css("--border") } },
      y: { stacked: true, ticks: { color: css("--muted") }, grid: { display: false } },
    },
  };
  if (hoursChart) { hoursChart.data = data; hoursChart.update(); }
  else hoursChart = new Chart(ctx, { type: "bar", data, options: opts });
}

function fillTable(id, headers, rows, emptyMsg) {
  const t = document.getElementById(id);
  if (!rows.length) { t.innerHTML = `<tbody><tr><td class="empty">${emptyMsg}</td></tr></tbody>`; return; }
  const head = `<thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].num ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("");
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderTables(d) {
  fillTable("outstandingTable",
    [{ label: "Faktura" }, { label: "Kunde" }, { label: "Forfall" }, { label: "Beløp", num: true }, { label: "Status" }],
    d.outstanding.map((o) => [
      o.invoiceNumber, o.customer, o.dueDate || "—", nok(o.outstanding),
      o.overdue ? `<span class="pill overdue">Forfalt</span>` : `<span class="pill ok">Åpen</span>`,
    ]),
    "Ingen utestående fakturaer 🎉");

  fillTable("projectHoursTable",
    [{ label: "Prosjekt" }, { label: "Timer", num: true }],
    d.projectHours.map((p) => [p.name, num(p.hours)]),
    "Ingen timer registrert denne måneden ennå.");

  fillTable("projectsTable",
    [{ label: "Nr" }, { label: "Prosjekt" }, { label: "Kunde" }, { label: "Prosjektleder" }],
    d.projects.map((p) => [p.number, p.name, p.customer, p.projectManager]),
    "Ingen aktive prosjekter.");

  fillTable("ordersTable",
    [{ label: "Nr" }, { label: "Kunde" }, { label: "Ordredato" }, { label: "Levering" }],
    d.orders.map((o) => [o.number, o.customer, o.orderDate || "—", o.deliveryDate || "—"]),
    "Ingen åpne ordre.");

  fillTable("employeesTable",
    [{ label: "Nr" }, { label: "Navn" }, { label: "E-post" }],
    d.employees.map((e) => [e.number || "", e.name, e.email]),
    "Ingen ansatte funnet.");
}

async function load() {
  try {
    const res = await fetch("/api/overview");
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
    const d = await res.json();
    renderKpis(d.kpis);
    renderRevenueChart(d.monthlyRevenue);
    renderHoursChart(d.employeeHours);
    renderTables(d);
    const t = new Date(d.updatedAt);
    document.getElementById("updated").textContent = "Oppdatert " + t.toLocaleTimeString("nb-NO");
  } catch (err) {
    showError("Kunne ikke hente data: " + err.message);
    document.getElementById("updated").textContent = "Feil ved oppdatering";
  }
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  document.getElementById("updated").textContent = "Henter ferske tall …";
  await fetch("/api/refresh", { method: "POST" });
  load();
});

load();
setInterval(load, REFRESH_INTERVAL_MS);

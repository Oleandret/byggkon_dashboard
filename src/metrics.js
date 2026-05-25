// Bygger ferdige tall til dashbordet fra rådata i Tripletex.
import {
  getProjects,
  getInvoices,
  getOpenOrders,
  getEmployees,
  getTimeEntries,
  getBalanceSheet,
  ymd,
} from "./tripletex.js";
import { getConfig } from "./settings.js";

function startOfYear(d = new Date()) {
  return new Date(d.getFullYear(), 0, 1);
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysAgo(n, d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - n);
  return x;
}
function fullName(p) {
  return p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "";
}

export async function buildOverview() {
  const cfg = getConfig();
  const today = new Date();
  const todayStr = ymd(today);
  const yearStart = startOfYear(today);
  const monthStart = ymd(startOfMonth(today));
  const fourWeeksAgoStr = ymd(daysAgo(28, today));

  // Tidligste dato vi trenger timer fra (året, eller 4 uker tilbake om det er tidligere).
  const timeFrom = ymd(daysAgo(28, today) < yearStart ? daysAgo(28, today) : yearStart);

  // Månedene hittil i år (for omsetning per måned)
  const monthsYTD = [];
  for (let m = 0; m <= today.getMonth(); m++) {
    const d = new Date(today.getFullYear(), m, 1);
    const end = new Date(today.getFullYear(), m + 1, 0);
    monthsYTD.push({ m, from: ymd(d), to: ymd(end > today ? today : end) });
  }

  const [projects, invoices, orders, employees, timeEntries, monthRevRows] = await Promise.all([
    getProjects({ isClosed: false }),
    getInvoices(ymd(yearStart), todayStr),
    getOpenOrders(ymd(yearStart), todayStr),
    getEmployees(),
    getTimeEntries(timeFrom, todayStr),
    // Omsetning per måned fra hovedboken (konto 3xxx, eks. mva) – samme grunnlag som Økonomi-fanen
    Promise.all(monthsYTD.map((mo) => getBalanceSheet(mo.from, mo.to, 3000, 3999))),
  ]);

  // ---- Økonomi ----
  // Omsetning = sum inntekter (3xxx). Inntekt er kredit (negativ balanceChange) → snu fortegn.
  const monthlyRevenue = Array(12).fill(0);
  monthsYTD.forEach((mo, i) => {
    monthlyRevenue[mo.m] = Math.round(
      (monthRevRows[i] || []).reduce((s, r) => s + -(r.balanceChange || 0), 0)
    );
  });
  const revenueYTD = monthlyRevenue.reduce((a, b) => a + b, 0);

  const outstanding = invoices
    .filter((i) => (i.amountOutstanding || 0) > 0)
    .map((i) => ({
      invoiceNumber: i.invoiceNumber,
      customer: i.customer?.name || "",
      dueDate: i.invoiceDueDate,
      outstanding: i.amountOutstanding,
      overdue: i.invoiceDueDate ? i.invoiceDueDate < todayStr : false,
    }))
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  const outstandingTotal = outstanding.reduce((s, i) => s + i.outstanding, 0);
  const overdueTotal = outstanding.filter((i) => i.overdue).reduce((s, i) => s + i.outstanding, 0);

  // ---- Timer denne kalendermåneden (KPI) ----
  const monthEntries = timeEntries.filter((e) => e.date >= monthStart);
  const hoursThisMonth = monthEntries.reduce((s, e) => s + (e.hours || 0), 0);
  const chargeableThisMonth = monthEntries.reduce((s, e) => s + (e.chargeableHours || 0), 0);

  // ---- Faktureringsgrad siste 4 uker, per ansatt (kun de som har ført timer) ----
  // Koble timer til ansatt via ID (navne-ekspansjon på timeføringer er ikke pålitelig).
  const employeesById = new Map(employees.map((e) => [e.id, fullName(e)]));
  const capacity4w = (cfg.weeklyCapacityHours || 37.5) * 4;
  const last4w = timeEntries.filter((e) => e.date >= fourWeeksAgoStr);
  const byEmp = new Map();
  for (const e of last4w) {
    const id = e.employee?.id;
    const name = employeesById.get(id) || fullName(e.employee) || "Ukjent";
    const key = id ?? name;
    const cur = byEmp.get(key) || { name, hours: 0, billable: 0 };
    cur.hours += e.hours || 0;
    cur.billable += e.chargeableHours || 0;
    byEmp.set(key, cur);
  }
  const billing = [...byEmp.values()]
    .filter((e) => e.hours > 0)
    .map((e) => {
      const billingRate = e.hours > 0 ? e.billable / e.hours : 0; // faktureringsgrad
      const utilization = capacity4w > 0 ? e.billable / capacity4w : 0; // mot kapasitet
      let status = "Høy utnyttelse";
      if (billingRate < 0.6) status = "Ledig kapasitet";
      else if (billingRate < 0.85) status = "Moderat";
      return {
        name: e.name,
        hours: e.hours,
        billable: e.billable,
        billingRate,
        utilization,
        status,
      };
    })
    .sort((a, b) => a.billingRate - b.billingRate); // lavest faktureringsgrad (ledig) først

  const avgBillingRate =
    billing.length > 0 ? billing.reduce((s, e) => s + e.billingRate, 0) / billing.length : 0;
  const freeCapacityCount = billing.filter((e) => e.billingRate < 0.6).length;

  // ---- Prosjekter ----
  // «Aktive prosjekter» = de det faktisk er ført timer på (Tripletex' isClosed-flagg
  // brukes lite hos Bygg-Kon, så vi går på reell aktivitet i stedet).
  const activeCutoff = ymd(daysAgo(56, today)); // siste 8 uker = "jobber på nå"
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const projAgg = new Map(); // id -> aggregat
  for (const e of timeEntries) {
    if (!e.project) continue;
    const id = e.project.id;
    const cur = projAgg.get(id) || { id, name: e.project.name || "", ytd: 0, ytdBillable: 0, last4w: 0, last8w: 0, lastActivity: "" };
    if (!cur.name && e.project.name) cur.name = e.project.name;
    cur.ytd += e.hours || 0;
    cur.ytdBillable += e.chargeableHours || 0;
    if (e.date >= fourWeeksAgoStr) cur.last4w += e.hours || 0;
    if (e.date >= activeCutoff) cur.last8w += e.hours || 0;
    if (e.date > cur.lastActivity) cur.lastActivity = e.date;
    projAgg.set(id, cur);
  }

  const enrich = (a) => {
    const p = projectsById.get(a.id);
    return {
      number: p?.number || "",
      name: a.name || p?.name || `Prosjekt ${a.id}`,
      customer: p?.customer?.name || "",
      projectManager: fullName(p?.projectManager),
      hours4w: a.last4w,
      hoursYTD: a.ytd,
      billableYTD: a.ytdBillable,
      lastActivity: a.lastActivity || null,
    };
  };

  // Prosjekter-fanen: alt med aktivitet hittil i år
  const projectsDetailed = [...projAgg.values()].map(enrich).sort((a, b) => b.hoursYTD - a.hoursYTD);

  // Venstre rullekolonne + KPI: prosjekter med aktivitet siste 8 uker
  const recentlyActive = [...projAgg.values()]
    .filter((a) => a.last8w > 0)
    .map(enrich)
    .sort((a, b) => b.hours4w - a.hours4w);

  const projects4Scroll = recentlyActive.map((p) => ({
    number: p.number,
    name: p.name,
    customer: p.customer,
    projectManager: p.projectManager,
    hours4w: p.hours4w,
  }));

  return {
    updatedAt: new Date().toISOString(),
    display: {
      companyName: cfg.companyName,
      heroImageUrl: cfg.heroImageUrl,
      refreshSeconds: cfg.refreshSeconds,
      weeklyCapacityHours: cfg.weeklyCapacityHours,
    },
    kpis: {
      revenueYTD,
      outstandingTotal,
      overdueTotal,
      activeProjects: recentlyActive.length,
      openOrders: orders.length,
      employees: employees.length,
      hoursThisMonth,
      chargeableHoursThisMonth: chargeableThisMonth,
      avgBillingRate,
      freeCapacityCount,
    },
    monthlyRevenue,
    outstanding: outstanding.slice(0, 30),
    billing,
    projects: projects4Scroll,
    projectsDetailed,
    orders: orders
      .map((o) => ({
        number: o.number,
        customer: o.customer?.name || o.customerName || "",
        orderDate: o.orderDate,
        deliveryDate: o.deliveryDate,
      }))
      .sort((a, b) => (b.orderDate || "").localeCompare(a.orderDate || "")),
  };
}

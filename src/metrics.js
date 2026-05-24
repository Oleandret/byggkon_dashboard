// Bygger ferdige tall til dashbordet fra rådata i Tripletex.
import {
  getProjects,
  getInvoices,
  getOpenOrders,
  getEmployees,
  getTimeEntries,
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

  const [projects, invoices, orders, employees, timeEntries] = await Promise.all([
    getProjects({ isClosed: false }),
    getInvoices(ymd(yearStart), todayStr),
    getOpenOrders(ymd(yearStart), todayStr),
    getEmployees(),
    getTimeEntries(timeFrom, todayStr),
  ]);

  // ---- Økonomi ----
  const realInvoices = invoices.filter((i) => !i.isCredited);
  const revenueYTD = realInvoices.reduce((s, i) => s + (i.amount || 0), 0);

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

  const monthlyRevenue = Array(12).fill(0);
  for (const i of realInvoices) {
    if (!i.invoiceDate) continue;
    const m = Number(i.invoiceDate.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) monthlyRevenue[m] += i.amount || 0;
  }

  // ---- Timer denne kalendermåneden (KPI) ----
  const monthEntries = timeEntries.filter((e) => e.date >= monthStart);
  const hoursThisMonth = monthEntries.reduce((s, e) => s + (e.hours || 0), 0);
  const chargeableThisMonth = monthEntries.reduce((s, e) => s + (e.chargeableHours || 0), 0);

  // ---- Faktureringsgrad siste 4 uker, per ansatt (kun de som har ført timer) ----
  const capacity4w = (cfg.weeklyCapacityHours || 37.5) * 4;
  const last4w = timeEntries.filter((e) => e.date >= fourWeeksAgoStr);
  const byEmp = new Map();
  for (const e of last4w) {
    const name = fullName(e.employee) || "Ukjent";
    const cur = byEmp.get(name) || { name, hours: 0, billable: 0 };
    cur.hours += e.hours || 0;
    cur.billable += e.chargeableHours || 0;
    byEmp.set(name, cur);
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

  // ---- Prosjekter (aggregert timer) ----
  const projHours = new Map(); // id -> { ytd, ytdBillable, last4w, lastActivity }
  for (const e of timeEntries) {
    if (!e.project) continue;
    const cur = projHours.get(e.project.id) || { ytd: 0, ytdBillable: 0, last4w: 0, lastActivity: "" };
    cur.ytd += e.hours || 0;
    cur.ytdBillable += e.chargeableHours || 0;
    if (e.date >= fourWeeksAgoStr) cur.last4w += e.hours || 0;
    if (e.date > cur.lastActivity) cur.lastActivity = e.date;
    projHours.set(e.project.id, cur);
  }

  const projectsDetailed = projects
    .map((p) => {
      const h = projHours.get(p.id) || { ytd: 0, ytdBillable: 0, last4w: 0, lastActivity: "" };
      return {
        number: p.number,
        name: p.name,
        customer: p.customer?.name || "",
        projectManager: fullName(p.projectManager),
        hours4w: h.last4w,
        hoursYTD: h.ytd,
        billableYTD: h.ytdBillable,
        lastActivity: h.lastActivity || null,
      };
    })
    .sort((a, b) => b.hours4w - a.hours4w);

  // Enkel liste til rullekolonnen
  const projects4Scroll = projectsDetailed.map((p) => ({
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
      activeProjects: projects.length,
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

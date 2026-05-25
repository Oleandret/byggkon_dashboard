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
import { getWeather } from "./weather.js";

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

  const [projects, invoices, orders, employees, timeEntries, monthRevRows, weather] = await Promise.all([
    getProjects({ isClosed: false }),
    getInvoices(ymd(yearStart), todayStr),
    getOpenOrders(ymd(yearStart), todayStr),
    getEmployees(),
    getTimeEntries(timeFrom, todayStr),
    // Omsetning per måned fra hovedboken (konto 3xxx, eks. mva) – samme grunnlag som Økonomi-fanen
    Promise.all(monthsYTD.map((mo) => getBalanceSheet(mo.from, mo.to, 3000, 3999))),
    getWeather().catch(() => null), // vær skal ikke kunne velte dashbordet
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
      id: i.id,
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

  // ---- Faktureringsgrad siste 7 dager, per ansatt (til kapasitet-stripa) ----
  const weekAgoStr = ymd(daysAgo(7, today));
  const weekByEmp = new Map();
  for (const e of timeEntries) {
    if (e.date < weekAgoStr) continue;
    const id = e.employee?.id;
    const name = employeesById.get(id) || fullName(e.employee) || "Ukjent";
    const key = id ?? name;
    const cur = weekByEmp.get(key) || { name, hours: 0, billable: 0 };
    cur.hours += e.hours || 0;
    cur.billable += e.chargeableHours || 0;
    weekByEmp.set(key, cur);
  }
  const billingWeek = [...weekByEmp.values()]
    .filter((e) => e.name && e.name !== "Ukjent" && e.hours > 0)
    .map((e) => ({ name: e.name, hours: e.hours, billable: e.billable, billingRate: e.billable / e.hours }))
    .sort((a, b) => a.billingRate - b.billingRate);

  // ---- Timeføring denne uka (man–i dag), per nåværende ansatt ----
  // Direkte knyttet til lønnsproblemet: hvem mangler førte timer denne uka?
  const dayShort = ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"];
  const dow0 = (today.getDay() + 6) % 7; // 0 = mandag
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - dow0);
  const weekDates = [];
  for (let i = 0; i <= dow0 && i < 5; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); weekDates.push(ymd(d)); }
  const weekDateSet = new Set(weekDates);
  const activeEmpIds = new Set(last4w.map((e) => e.employee?.id).filter((x) => x != null));
  const loggedByEmp = new Map();
  for (const e of timeEntries) {
    if (!weekDateSet.has(e.date) || (e.hours || 0) <= 0) continue;
    const id = e.employee?.id; if (id == null) continue;
    if (!loggedByEmp.has(id)) loggedByEmp.set(id, new Set());
    loggedByEmp.get(id).add(e.date);
  }
  const timesheetEmployees = [...activeEmpIds].map((id) => {
    const logged = loggedByEmp.get(id) || new Set();
    const missingCount = weekDates.filter((ds) => !logged.has(ds)).length;
    return { name: employeesById.get(id) || `#${id}`, logged: weekDates.map((ds) => logged.has(ds)), missingCount };
  }).filter((e) => e.name && e.name !== "Ukjent")
    .sort((a, b) => b.missingCount - a.missingCount || a.name.localeCompare(b.name));
  const timesheetWeek = {
    days: weekDates.map((ds) => ({ date: ds, label: dayShort[new Date(ds).getDay()] })),
    employees: timesheetEmployees,
    anyMissing: timesheetEmployees.some((e) => e.missingCount > 0),
  };

  // ---- Prosjekter ----
  // «Aktive prosjekter» = de det faktisk er ført timer på (Tripletex' isClosed-flagg
  // brukes lite hos Bygg-Kon, så vi går på reell aktivitet i stedet).
  const activeCutoff = ymd(daysAgo(90, today)); // siste 3 måneder = "jobber på nå"
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const projAgg = new Map(); // id -> aggregat
  for (const e of timeEntries) {
    if (!e.project) continue;
    const id = e.project.id;
    const cur = projAgg.get(id) || { id, name: e.project.name || "", ytd: 0, ytdBillable: 0, last4w: 0, last8w: 0, lastActivity: "", emp4wById: {} };
    if (!cur.name && e.project.name) cur.name = e.project.name;
    cur.ytd += e.hours || 0;
    cur.ytdBillable += e.chargeableHours || 0;
    if (e.date >= fourWeeksAgoStr) {
      cur.last4w += e.hours || 0;
      const eid = e.employee?.id ?? "?";
      cur.emp4wById[eid] = (cur.emp4wById[eid] || 0) + (e.hours || 0);
    }
    if (e.date >= activeCutoff) cur.last8w += e.hours || 0;
    if (e.date > cur.lastActivity) cur.lastActivity = e.date;
    projAgg.set(id, cur);
  }

  const enrich = (a) => {
    const p = projectsById.get(a.id);
    const byEmp4w = {};
    for (const [eid, h] of Object.entries(a.emp4wById || {})) {
      const nm = employeesById.get(Number(eid)) || "Ukjent";
      byEmp4w[nm] = (byEmp4w[nm] || 0) + h;
    }
    return {
      number: p?.number || "",
      name: a.name || p?.name || `Prosjekt ${a.id}`,
      customer: p?.customer?.name || "",
      projectManager: fullName(p?.projectManager),
      hours4w: a.last4w,
      hoursYTD: a.ytd,
      billableYTD: a.ytdBillable,
      lastActivity: a.lastActivity || null,
      byEmp4w,
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

  // ---- Hva jobber hver ansatt med? (siste 2 uker) ----
  const twoWeeksAgoStr = ymd(daysAgo(14, today));
  const focusMap = new Map(); // eid -> { name, total, proj: Map(pid -> {name, customer, hours}) }
  for (const e of timeEntries) {
    if (e.date < twoWeeksAgoStr || !e.project) continue;
    const eid = e.employee?.id;
    if (eid == null) continue;
    const name = employeesById.get(Number(eid)) || fullName(e.employee) || `#${eid}`;
    const cur = focusMap.get(eid) || { name, total: 0, proj: new Map() };
    cur.total += e.hours || 0;
    const pid = e.project.id;
    const meta = projectsById.get(pid);
    const pj = cur.proj.get(pid) || { name: e.project.name || meta?.name || `Prosjekt ${pid}`, customer: meta?.customer?.name || "", hours: 0 };
    pj.hours += e.hours || 0;
    cur.proj.set(pid, pj);
    focusMap.set(eid, cur);
  }
  const employeeFocus = [...focusMap.values()]
    .filter((e) => e.total > 0)
    .map((e) => {
      const projects = [...e.proj.values()].sort((a, b) => b.hours - a.hours);
      return {
        name: e.name,
        totalHours: Math.round(e.total * 10) / 10,
        projects: projects.slice(0, 4).map((p) => ({ name: p.name, customer: p.customer, hours: Math.round(p.hours * 10) / 10 })),
      };
    })
    .sort((a, b) => b.totalHours - a.totalHours);

  // ---- Bursdager ----
  const md = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayMD = md(today);
  const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
  const in7MD = md(in7);
  const bdayToday = [], bdayInWeek = [];
  for (const e of employees) {
    if (!e.dateOfBirth || String(e.dateOfBirth).length < 10) continue;
    const emd = String(e.dateOfBirth).slice(5, 10); // MM-DD
    const name = fullName(e);
    if (emd === todayMD) bdayToday.push(name);
    if (emd === in7MD) bdayInWeek.push(name);
  }

  return {
    updatedAt: new Date().toISOString(),
    display: {
      birthdays: { today: bdayToday, inWeek: bdayInWeek },
      companyName: cfg.companyName,
      logoUrl: cfg.logoUrl || "",
      heroImageUrl: cfg.heroImageUrl,
      refreshSeconds: cfg.refreshSeconds,
      weeklyCapacityHours: cfg.weeklyCapacityHours,
      values: cfg.values || [],
      companyAddress: cfg.companyAddress || "",
      weather,
      departments: cfg.departments || [],
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
    employeeFocus,
    timesheetWeek,
    billingWeek,
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

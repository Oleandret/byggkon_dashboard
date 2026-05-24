// Bygger ferdige tall til dashbordet fra rådata i Tripletex.
import {
  getProjects,
  getInvoices,
  getOpenOrders,
  getEmployees,
  getTimeEntries,
  ymd,
} from "./tripletex.js";

function startOfYear(d = new Date()) {
  return new Date(d.getFullYear(), 0, 1);
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Samlet oversikt brukt av dashbordet i ett kall.
export async function buildOverview() {
  const today = new Date();
  const yearStart = ymd(startOfYear(today));
  const monthStart = ymd(startOfMonth(today));
  const todayStr = ymd(today);

  // Hent alt parallelt.
  const [projects, invoices, orders, employees, monthEntries] = await Promise.all([
    getProjects({ isClosed: false }),
    getInvoices(yearStart, todayStr),
    getOpenOrders(yearStart, todayStr),
    getEmployees(),
    getTimeEntries(monthStart, todayStr),
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
      amount: i.amount,
      outstanding: i.amountOutstanding,
      overdue: i.invoiceDueDate ? i.invoiceDueDate < todayStr : false,
    }))
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  const outstandingTotal = outstanding.reduce((s, i) => s + i.outstanding, 0);
  const overdueTotal = outstanding
    .filter((i) => i.overdue)
    .reduce((s, i) => s + i.outstanding, 0);

  // Omsetning per måned (kolonnediagram)
  const monthlyRevenue = Array(12).fill(0);
  for (const i of realInvoices) {
    if (!i.invoiceDate) continue;
    const m = Number(i.invoiceDate.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) monthlyRevenue[m] += i.amount || 0;
  }

  // ---- Timer denne måneden ----
  const totalHours = monthEntries.reduce((s, e) => s + (e.hours || 0), 0);
  const chargeableHours = monthEntries.reduce(
    (s, e) => s + (e.chargeableHours || 0),
    0
  );
  const billableRatio = totalHours > 0 ? chargeableHours / totalHours : 0;

  // Timer per ansatt
  const hoursByEmployee = new Map();
  for (const e of monthEntries) {
    const name = e.employee
      ? `${e.employee.firstName || ""} ${e.employee.lastName || ""}`.trim()
      : "Ukjent";
    const cur = hoursByEmployee.get(name) || { name, hours: 0, chargeable: 0 };
    cur.hours += e.hours || 0;
    cur.chargeable += e.chargeableHours || 0;
    hoursByEmployee.set(name, cur);
  }
  const employeeHours = [...hoursByEmployee.values()].sort((a, b) => b.hours - a.hours);

  // Timer per prosjekt (topp aktive denne måneden)
  const hoursByProject = new Map();
  for (const e of monthEntries) {
    if (!e.project) continue;
    const cur = hoursByProject.get(e.project.id) || {
      name: e.project.name,
      hours: 0,
    };
    cur.hours += e.hours || 0;
    hoursByProject.set(e.project.id, cur);
  }
  const projectHours = [...hoursByProject.values()]
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 10);

  // ---- Prosjekter ----
  const projectList = projects
    .map((p) => ({
      number: p.number,
      name: p.name,
      customer: p.customer?.name || "",
      projectManager: p.projectManager
        ? `${p.projectManager.firstName || ""} ${p.projectManager.lastName || ""}`.trim()
        : "",
      startDate: p.startDate,
    }))
    .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));

  // ---- Ordre ----
  const orderList = orders
    .map((o) => ({
      number: o.number,
      customer: o.customer?.name || o.customerName || "",
      orderDate: o.orderDate,
      deliveryDate: o.deliveryDate,
    }))
    .sort((a, b) => (b.orderDate || "").localeCompare(a.orderDate || ""));

  return {
    updatedAt: new Date().toISOString(),
    kpis: {
      revenueYTD,
      outstandingTotal,
      overdueTotal,
      activeProjects: projects.length,
      openOrders: orders.length,
      employees: employees.length,
      hoursThisMonth: totalHours,
      chargeableHoursThisMonth: chargeableHours,
      billableRatio,
    },
    monthlyRevenue,
    outstanding: outstanding.slice(0, 25),
    employeeHours,
    projectHours,
    projects: projectList,
    orders: orderList,
    employees: employees
      .map((e) => ({
        name: `${e.firstName || ""} ${e.lastName || ""}`.trim(),
        email: e.email || "",
        number: e.employeeNumber,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

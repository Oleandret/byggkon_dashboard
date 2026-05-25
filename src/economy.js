// Bygger den live "Økonomi"-fanen: Resultat (i år + LTM), månedstrend,
// balanse, likviditet og timeregnskap/utilization per ansatt.
// Tall hentes fra saldobalansen (get_balance_sheet) gruppert på kontonummer.
import { getAccounts, getBalanceSheet, getEmployees, getTimeEntries, ymd } from "./tripletex.js";
import { getConfig } from "./settings.js";

function startOfYear(d = new Date()) { return new Date(d.getFullYear(), 0, 1); }
function fullName(p) { return p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : ""; }

// Grupperer en saldobalanse (liste fra get_balance_sheet) i resultat- og balansetall.
function summarize(rows, accById) {
  let revenue = 0, opex = 0, finance = 0, ebt = 0;          // resultat (balanceChange)
  let assets = 0, bank = 0, receivables = 0;                 // balanse (balanceOut)
  let equity = 0, liabilities = 0, supplierDebt = 0;
  for (const r of rows) {
    const a = accById.get(r.account?.id);
    if (!a) continue;
    const n = Number(a.number);
    const ch = r.balanceChange || 0;
    const out = r.balanceOut || 0;
    // Resultat (3000-8299): inntekt er kredit (negativ), kost er debet (positiv)
    if (n >= 3000 && n < 4000) revenue += -ch;
    else if (n >= 4000 && n < 8000) opex += ch;
    else if (n >= 8000 && n < 8300) finance += -ch;
    if (n >= 3000 && n < 8300) ebt += -ch;
    // Balanse (utgående saldo)
    if (n >= 1000 && n < 2000) {
      assets += out;
      if (n >= 1900 && n < 2000) bank += out;
      if (n >= 1500 && n < 1580) receivables += out;
    } else if (n >= 2000 && n < 3000) {
      if (n < 2100) equity += -out;
      else liabilities += -out;
      if (n >= 2400 && n < 2410) supplierDebt += -out;
    }
  }
  return {
    revenue, opex, operatingResult: revenue - opex, finance, ebt,
    assets, bank, receivables, equity, liabilities, supplierDebt,
  };
}

export async function buildEconomy() {
  const cfg = getConfig();
  const today = new Date();
  const todayStr = ymd(today);
  const yearStart = ymd(startOfYear(today));
  const ltmStart = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));

  // Siste 12 måneder (start på hver måned)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    months.push({
      label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
      from: ymd(d),
      to: ymd(end > today ? today : end),
    });
  }

  const [accounts, employees, ytdRows, monthRows, yearTime] = await Promise.all([
    getAccounts(),
    getEmployees(),
    getBalanceSheet(yearStart, todayStr),
    Promise.all(months.map((m) => getBalanceSheet(m.from, m.to, 3000, 8299))),
    getTimeEntries(yearStart, todayStr),
  ]);

  const accById = new Map(accounts.map((a) => [a.id, a]));
  const ytd = summarize(ytdRows, accById);

  // Resultatkontoer nullstilles ved årsskiftet, så LTM må summeres måned for måned
  // (ett balanse-kall over årsskiftet ville gitt feil tall).
  const monthSummaries = monthRows.map((rows) => summarize(rows, accById));
  const ltm = monthSummaries.reduce(
    (s, m) => ({
      revenue: s.revenue + m.revenue, opex: s.opex + m.opex,
      operatingResult: s.operatingResult + m.operatingResult,
      finance: s.finance + m.finance, ebt: s.ebt + m.ebt,
    }),
    { revenue: 0, opex: 0, operatingResult: 0, finance: 0, ebt: 0 }
  );

  // Månedstrend: Sum inntekter + EBT
  const trend = months.map((m, i) => ({
    label: m.label,
    revenue: Math.round(monthSummaries[i].revenue),
    ebt: Math.round(monthSummaries[i].ebt),
  }));

  // Likviditet (øyeblikksbilde) – ikke en prognose
  const liquidity = {
    bank: ytd.bank,
    receivables: ytd.receivables,
    supplierDebt: ytd.supplierDebt,
    net: ytd.bank + ytd.receivables - ytd.supplierDebt,
  };

  // Timeregnskap & utilization per ansatt (hittil i år)
  const weeksElapsed = Math.max(1, (today - startOfYear(today)) / (7 * 24 * 3600 * 1000));
  const capacityYTD = (cfg.weeklyCapacityHours || 37.5) * weeksElapsed;
  const empById = new Map(employees.map((e) => [e.id, fullName(e)]));
  const byEmp = new Map();
  let totalHours = 0, totalBillable = 0;
  for (const e of yearTime) {
    const id = e.employee?.id;
    const name = empById.get(id) || fullName(e.employee) || "Ukjent";
    const key = id ?? name;
    const cur = byEmp.get(key) || { name, hours: 0, billable: 0 };
    cur.hours += e.hours || 0;
    cur.billable += e.chargeableHours || 0;
    byEmp.set(key, cur);
    totalHours += e.hours || 0;
    totalBillable += e.chargeableHours || 0;
  }
  const utilization = [...byEmp.values()]
    .map((e) => ({
      name: e.name,
      hours: e.hours,
      billable: e.billable,
      billingRate: e.hours > 0 ? e.billable / e.hours : 0,
      utilization: capacityYTD > 0 ? e.billable / capacityYTD : 0,
    }))
    .sort((a, b) => b.utilization - a.utilization);

  return {
    updatedAt: new Date().toISOString(),
    period: { yearLabel: String(today.getFullYear()), today: todayStr },
    resultYTD: ytd,
    resultLTM: ltm,
    trend,
    balance: {
      assets: ytd.assets, bank: ytd.bank, receivables: ytd.receivables,
      equity: ytd.equity, liabilities: ytd.liabilities, supplierDebt: ytd.supplierDebt,
    },
    liquidity,
    hours: { totalHours, totalBillable, billingRate: totalHours > 0 ? totalBillable / totalHours : 0 },
    utilization,
  };
}

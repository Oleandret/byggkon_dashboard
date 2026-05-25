// Datalag mot Tripletex – via Regnskapsagent-MCP (ikke REST-API direkte).
// Tripletex tillater maks 1000 rader per kall, så vi paginerer med from/count.
import { callTool, resetClient as resetMcp } from "./mcpClient.js";
import { getConfig } from "./settings.js";

const PAGE = 1000;       // Tripletex maks per kall
const MAX_ROWS = 30000;  // sikkerhetsgrense
const cache = new Map(); // key -> { value, expires }

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export function clearCache() {
  cache.clear();
}
export function resetClient() {
  resetMcp();
  cache.clear();
}

// Kaster en tydelig feil hvis MCP/Tripletex svarer med en feilstruktur.
function assertOk(tool, data) {
  if (data && (data.httpStatus >= 400 || data.tripletexResponse)) {
    const msg = data.tripletexResponse?.message || data.message || `HTTP ${data.httpStatus}`;
    const vm = data.tripletexResponse?.validationMessages;
    throw new Error(`Tripletex (${tool}) avviste kallet: ${msg}${vm ? " " + JSON.stringify(vm) : ""}`);
  }
}

// Henter alle rader for et søkeverktøy med paginering, cachet.
async function fetchAll(tool, args) {
  const key = tool + JSON.stringify(args);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;

  let from = 0;
  let all = [];
  let total = Infinity;
  while (from < total && all.length < MAX_ROWS) {
    const data = await callTool(tool, { ...args, from, count: PAGE });
    assertOk(tool, data);
    const vals = data?.values || [];
    total = data?.fullResultSize ?? vals.length;
    all = all.concat(vals);
    if (vals.length < PAGE) break;
    from += PAGE;
  }
  cache.set(key, { value: all, expires: now + getConfig().cacheTtlMs });
  return all;
}

// ---- Domeneoppslag ----

export async function getProjects({ isClosed = false } = {}) {
  return fetchAll("search_projects", {
    isClosed,
    fields:
      "id,number,name,isClosed,startDate,endDate,customer(id,name),projectManager(id,firstName,lastName)",
  });
}

export async function getInvoices(fromDate, toDate) {
  return fetchAll("search_invoices", {
    invoiceDateFrom: fromDate,
    invoiceDateTo: toDate,
    fields:
      "id,invoiceNumber,invoiceDate,invoiceDueDate,amount,amountCurrency,amountOutstanding,isCredited,customer(id,name)",
  });
}

export async function getOpenOrders(fromDate, toDate) {
  return fetchAll("search_orders", {
    orderDateFrom: fromDate,
    orderDateTo: toDate,
    isClosed: false,
    fields: "id,number,orderDate,deliveryDate,isClosed,customerName,customer(id,name)",
  });
}

export async function getEmployees() {
  return fetchAll("search_employees", {
    fields: "id,firstName,lastName,email,employeeNumber,dateOfBirth,department(id,name)",
  });
}

export async function getTimeEntries(fromDate, toDate) {
  return fetchAll("search_time_entries", {
    dateFrom: fromDate,
    dateTo: toDate,
    fields:
      "id,date,hours,chargeableHours,chargeable,hourlyRate,project(id,name),employee(id,firstName,lastName)",
  });
}

// Kunder (id -> navn, e-post, telefon) – til kunde-oversikten.
export async function getCustomers() {
  return fetchAll("search_customers", { fields: "id,name,email,phoneNumber,invoiceEmail" });
}

// Kontoplan (id -> number/name), brukes til å gruppere balanse/resultat.
export async function getAccounts() {
  return fetchAll("search_accounts", { fields: "id,number,name" });
}

// Saldobalanse for en periode. balanceChange = bevegelse i perioden,
// balanceOut = utgående saldo (brukes til balanseregnskapet).
export async function getBalanceSheet(fromDate, toDate, numberFrom = 1000, numberTo = 8299) {
  return fetchAll("get_balance_sheet", {
    dateFrom: fromDate,
    dateTo: toDate,
    accountNumberFrom: numberFrom,
    accountNumberTo: numberTo,
  });
}

export { ymd };

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

// Henter adresser per prosjekt (best effort). Tripletex' feltnavn varierer, så vi
// ber om hele objektet (fields=*) og plukker ut det som ligner en adresse.
// Returnerer Map(prosjekt-id -> adressetekst). Feiler stille til tom Map.
let _projAddrCache = { ts: 0, map: null };
export async function getProjectAddresses() {
  if (_projAddrCache.map && Date.now() - _projAddrCache.ts < 30 * 60 * 1000) return _projAddrCache.map;
  const map = new Map();
  try {
    const data = await callTool("search_projects", { isClosed: false, from: 0, count: 1000, fields: "*" });
    assertOk("search_projects", data);
    for (const p of (data?.values || [])) {
      const a = p.deliveryAddress || p.projectAddress || p.address || p.physicalAddress || p.postalAddress || p.visitAddress || null;
      let s = "";
      if (a && typeof a === "object") s = [a.addressLine1, a.addressLine2, a.postalCode, a.city].filter(Boolean).join(" ").trim();
      else if (typeof a === "string") s = a.trim();
      if (s) map.set(p.id, s);
    }
  } catch { /* fields=* ikke støttet e.l. → tom map, vi faller tilbake på navn */ }
  _projAddrCache = { ts: Date.now(), map };
  return map;
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

// Detaljert variant — tar med aktivitet, kommentar og fakturerbar-status.
// Brukes til per-ansatt timeoversikt der vi vil ha ALT (fravær, ferie, syk, intern m.m.).
export async function getTimeEntriesDetailed(fromDate, toDate, employeeId) {
  const params = {
    dateFrom: fromDate,
    dateTo: toDate,
    fields: "id,date,hours,chargeableHours,chargeable,hourlyRate,comment,locked,approved,project(id,name,number),activity(id,name),employee(id,firstName,lastName)",
  };
  if (employeeId) params.employeeId = employeeId;
  try {
    return await fetchAll("search_time_entries", params);
  } catch {
    // Fallback hvis enkelte felter ikke støttes
    return fetchAll("search_time_entries", {
      dateFrom: fromDate, dateTo: toDate,
      fields: "id,date,hours,chargeableHours,project(id,name),activity(id,name),employee(id,firstName,lastName),comment",
      ...(employeeId ? { employeeId } : {}),
    });
  }
}

// Leverandørfakturaer (kostnader) i en periode.
export async function getSupplierInvoices(fromDate, toDate) {
  return fetchAll("search_supplier_invoices", {
    invoiceDateFrom: fromDate,
    invoiceDateTo: toDate,
    fields: "id,invoiceDate,amount,supplier(id,name)",
  });
}

// Leverandører med kontaktinfo (best effort – feltnavn varierer i MCP-er).
let _suppliersCache = { ts: 0, list: null };
export async function getSuppliers() {
  if (_suppliersCache.list && Date.now() - _suppliersCache.ts < 30 * 60 * 1000) return _suppliersCache.list;
  let list = [];
  try { list = await fetchAll("search_suppliers", { fields: "id,name,email,phoneNumber,invoiceEmail,organizationNumber" }); }
  catch { try { list = await fetchAll("search_suppliers", { fields: "*" }); } catch { list = []; } }
  _suppliersCache = { ts: Date.now(), list };
  return list;
}

// Faktureringskandidater: leverandørfakturaer der kommentaren inneholder
// "vf" eller "viderefaktur" – brukes til viderefakturerings-oversikten.
export async function getForwardableInvoices(fromDate, toDate) {
  try {
    const data = await callTool("search_supplier_invoices", {
      invoiceDateFrom: fromDate, invoiceDateTo: toDate, from: 0, count: 1000, fields: "*",
    });
    assertOk("search_supplier_invoices", data);
    const re = /\b(vf|viderefaktur)/i;
    return (data?.values || []).filter((r) => re.test(String(r.comment || r.description || r.title || "")));
  } catch { return []; }
}

// Detaljer for én leverandørs fakturaer (best effort med fields=*).
export async function getSupplierInvoiceDetails(supplierId, fromDate, toDate) {
  try {
    const data = await callTool("search_supplier_invoices", {
      supplierId, invoiceDateFrom: fromDate, invoiceDateTo: toDate,
      from: 0, count: 1000, fields: "*",
    });
    assertOk("search_supplier_invoices", data);
    return data?.values || [];
  } catch { return []; }
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

// Best-effort: hent prosjekter med alle felt for å trekke ut økonomi-info
// (fast pris, estimerte timer, timepris). Feiler stille til tom Map.
let _projDetailsCache = { ts: 0, map: null };
export async function getProjectsEconomyDetails() {
  if (_projDetailsCache.map && Date.now() - _projDetailsCache.ts < 30 * 60 * 1000) return _projDetailsCache.map;
  const map = new Map();
  try {
    const data = await callTool("search_projects", { isClosed: false, from: 0, count: 1000, fields: "*" });
    assertOk("search_projects", data);
    for (const p of (data?.values || [])) {
      // Tripletex har varierte feltnavn — vi prøver flere
      const isFixed =
        p.isFixedPrice === true ||
        p.fixedPrice === true ||
        /(fast\s*pris|fixed)/i.test(String(p.projectCategory?.name || p.category || p.type || ""));
      // Avtalt fast pris (NOK)
      const fixedPriceAmount =
        Number(p.fixedPriceAmount || 0) ||
        Number(p.budget || 0) ||
        Number(p.contractedAmount || 0) ||
        (typeof p.fixedPrice === "number" ? p.fixedPrice : 0) || 0;
      // Estimerte timer
      const hoursEstimated =
        Number(p.numberOfHoursEstimated || 0) ||
        Number(p.estimatedHours || 0) ||
        Number(p.hoursBudget || 0) || 0;
      const hourlyRate = Number(p.hourlyRate || 0) || 0;
      const description = String(p.description || "");
      map.set(p.id, { isFixed, fixedPriceAmount, hoursEstimated, hourlyRate, description });
    }
  } catch { /* tom map om ikke støttet */ }
  _projDetailsCache = { ts: Date.now(), map };
  return map;
}

export { ymd };

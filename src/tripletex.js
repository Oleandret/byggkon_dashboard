// Datalag mot Tripletex – rett på REST-API v2, se tripletexApi.js.
// Vi sender Tripletex sine egne parametre (fields, isClosed, dateFrom/dateTo …)
// som de er. Tripletex tillater maks 1000 rader per kall, så vi paginerer med
// from/count.
import { apiGet, resetSession } from "./tripletexApi.js";
import { getConfig } from "./settings.js";

const PAGE = 1000;       // Tripletex maks per kall
const MAX_ROWS = 30000;  // sikkerhetsgrense
const cache = new Map(); // key -> { value, expires }

// Endepunktene dashbordet henter fra.
const PROJECTS = "/project";
const ORDERS = "/order";
const INVOICES = "/invoice";
const SUPPLIER_INVOICES = "/supplierInvoice";
const CUSTOMERS = "/customer";
const SUPPLIERS = "/supplier";
const EMPLOYEES = "/employee";
const TIME_ENTRIES = "/timesheet/entry";
const ACCOUNTS = "/ledger/account";
const BALANCE_SHEET = "/balanceSheet";

// Lokal kalenderdato. toISOString() ville gitt UTC-datoen, og siden vi bygger
// datoer som new Date(år, måned, dag) i lokal tid ville 1. januar blitt til
// 31. desember året før i enhver tidssone øst for UTC.
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---- Tripletex sin datokonvensjon ----
// Alle *From-parametre er inklusive, alle *To-parametre er EKSKLUSIVE
// ("To and excluding" i openapi.json). Det samme gjelder accountNumberTo.
//
// Resten av dashbordet regner i inklusive perioder – "januar" er 01-01 til
// 01-31, "hittil i år" slutter i dag. Vi oversetter derfor her, ett sted, i
// stedet for å be hvert kallsted huske på det. Uten dette mistet hver periode
// sin siste dag, og for omsetning per måned var det nettopp månedens siste dag
// – der mye av faktureringen ligger.
function dayAfter(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function clearCache() {
  cache.clear();
}
export function resetClient() {
  resetSession();
  cache.clear();
}

// Henter alle rader fra et endepunkt med paginering, cachet.
async function fetchAll(path, params) {
  const key = path + JSON.stringify(params);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;

  let from = 0;
  let all = [];
  let total = Infinity;
  while (from < total && all.length < MAX_ROWS) {
    const data = await apiGet(path, { ...params, from, count: PAGE });
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
  return fetchAll(PROJECTS, {
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
    const data = await apiGet(PROJECTS, { isClosed: false, from: 0, count: 1000, fields: "*" });
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
  return fetchAll(INVOICES, {
    invoiceDateFrom: fromDate,
    invoiceDateTo: dayAfter(toDate),
    fields:
      "id,invoiceNumber,invoiceDate,invoiceDueDate,amount,amountCurrency,amountOutstanding,isCredited,customer(id,name)",
  });
}

export async function getOpenOrders(fromDate, toDate) {
  return fetchAll(ORDERS, {
    orderDateFrom: fromDate,
    orderDateTo: dayAfter(toDate),
    isClosed: false,
    fields: "id,number,orderDate,deliveryDate,isClosed,customerName,customer(id,name)",
  });
}

export async function getEmployees() {
  return fetchAll(EMPLOYEES, {
    fields: "id,firstName,lastName,email,employeeNumber,dateOfBirth,department(id,name)",
  });
}

export async function getTimeEntries(fromDate, toDate) {
  return fetchAll(TIME_ENTRIES, {
    dateFrom: fromDate,
    dateTo: dayAfter(toDate),
    fields:
      "id,date,hours,chargeableHours,chargeable,hourlyRate,project(id,name),employee(id,firstName,lastName)",
  });
}

// Detaljert variant — tar med aktivitet, kommentar og fakturerbar-status.
// Brukes til per-ansatt timeoversikt der vi vil ha ALT (fravær, ferie, syk, intern m.m.).
export async function getTimeEntriesDetailed(fromDate, toDate, employeeId) {
  const params = {
    dateFrom: fromDate,
    dateTo: dayAfter(toDate),
    fields: "id,date,hours,chargeableHours,chargeable,hourlyRate,comment,locked,approved,project(id,name,number),activity(id,name),employee(id,firstName,lastName)",
  };
  if (employeeId) params.employeeId = employeeId;
  try {
    return await fetchAll(TIME_ENTRIES, params);
  } catch {
    // Fallback hvis enkelte felter ikke støttes
    return fetchAll(TIME_ENTRIES, {
      dateFrom: fromDate, dateTo: dayAfter(toDate),
      fields: "id,date,hours,chargeableHours,project(id,name),activity(id,name),employee(id,firstName,lastName),comment",
      ...(employeeId ? { employeeId } : {}),
    });
  }
}

// Leverandørfakturaer (kostnader) i en periode.
export async function getSupplierInvoices(fromDate, toDate) {
  return fetchAll(SUPPLIER_INVOICES, {
    invoiceDateFrom: fromDate,
    invoiceDateTo: dayAfter(toDate),
    fields: "id,invoiceDate,amount,supplier(id,name)",
  });
}

// Leverandører med kontaktinfo (best effort – ikke alle felt finnes overalt).
let _suppliersCache = { ts: 0, list: null };
export async function getSuppliers() {
  if (_suppliersCache.list && Date.now() - _suppliersCache.ts < 30 * 60 * 1000) return _suppliersCache.list;
  let list = [];
  try { list = await fetchAll(SUPPLIERS, { fields: "id,name,email,phoneNumber,invoiceEmail,organizationNumber" }); }
  catch { try { list = await fetchAll(SUPPLIERS, { fields: "*" }); } catch { list = []; } }
  _suppliersCache = { ts: Date.now(), list };
  return list;
}

// Faktureringskandidater: leverandørfakturaer der kommentaren inneholder
// "vf" eller "viderefaktur" – brukes til viderefakturerings-oversikten.
export async function getForwardableInvoices(fromDate, toDate) {
  try {
    const data = await apiGet(SUPPLIER_INVOICES, {
      invoiceDateFrom: fromDate, invoiceDateTo: dayAfter(toDate), from: 0, count: 1000, fields: "*",
    });
    const re = /\b(vf|viderefaktur)/i;
    return (data?.values || []).filter((r) => re.test(String(r.comment || r.description || r.title || "")));
  } catch { return []; }
}

// Detaljer for én leverandørs fakturaer (best effort med fields=*).
export async function getSupplierInvoiceDetails(supplierId, fromDate, toDate) {
  try {
    const data = await apiGet(SUPPLIER_INVOICES, {
      supplierId, invoiceDateFrom: fromDate, invoiceDateTo: dayAfter(toDate),
      from: 0, count: 1000, fields: "*",
    });
    return data?.values || [];
  } catch { return []; }
}

// Kunder (id -> navn, e-post, telefon) – til kunde-oversikten.
export async function getCustomers() {
  return fetchAll(CUSTOMERS, { fields: "id,name,email,phoneNumber,invoiceEmail" });
}

// Kontoplan (id -> number/name), brukes til å gruppere balanse/resultat.
export async function getAccounts() {
  return fetchAll(ACCOUNTS, { fields: "id,number,name" });
}

// Saldobalanse for en periode. balanceChange = bevegelse i perioden,
// balanceOut = utgående saldo (brukes til balanseregnskapet).
//
// toDate og numberTo er inklusive her, slik kallstedene naturlig leser dem.
// Tripletex vil ha dem eksklusive, så begge får +1 på vei ut.
export async function getBalanceSheet(fromDate, toDate, numberFrom = 1000, numberTo = 8299) {
  return fetchAll(BALANCE_SHEET, {
    dateFrom: fromDate,
    dateTo: dayAfter(toDate),
    accountNumberFrom: numberFrom,
    accountNumberTo: numberTo + 1,
    // Be om kontonummeret direkte. Uten dette kommer account tilbake som bare
    // {id, url}, og vi må slå opp nummeret i en separat kontoplan – der en konto
    // som mangler fører til at beløpet stilltiende forsvinner ut av regnskapet.
    fields: "account(id,number,name),balanceIn,balanceChange,balanceOut",
  });
}

// Best-effort: hent prosjekter med alle felt for å trekke ut økonomi-info
// (fast pris, estimerte timer, timepris). Feiler stille til tom Map.
let _projDetailsCache = { ts: 0, map: null };
export async function getProjectsEconomyDetails() {
  if (_projDetailsCache.map && Date.now() - _projDetailsCache.ts < 30 * 60 * 1000) return _projDetailsCache.map;
  const map = new Map();
  try {
    const data = await apiGet(PROJECTS, { isClosed: false, from: 0, count: 1000, fields: "*" });
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

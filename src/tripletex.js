// Tripletex API-klient med session-token-håndtering og enkel caching.
// Konfigurasjon (tokens, base-URL, cache-tid) hentes dynamisk fra settings.js,
// slik at admin-siden kan endre dem uten omstart.
// Dokumentasjon: https://tripletex.no/v2-docs/
import { getConfig } from "./settings.js";

let sessionToken = null;
let sessionExpires = 0; // epoch ms da token utløper
const cache = new Map(); // key -> { value, expires }

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Tilbakestiller session + cache (kalles når innstillinger endres).
export function resetClient() {
  sessionToken = null;
  sessionExpires = 0;
  cache.clear();
}

export function clearCache() {
  cache.clear();
}

// Oppretter (eller gjenbruker) en session-token mot Tripletex.
async function getSessionToken() {
  const { tripletexBaseUrl, tripletexConsumerToken, tripletexEmployeeToken } = getConfig();
  const now = Date.now();
  if (sessionToken && sessionExpires - now > 10 * 60 * 1000) {
    return sessionToken;
  }
  if (!tripletexConsumerToken || !tripletexEmployeeToken) {
    throw new Error(
      "Tripletex er ikke konfigurert ennå. Legg inn consumer- og employee-token på admin-siden (/admin)."
    );
  }

  const expiration = new Date(now + 24 * 60 * 60 * 1000);
  const url =
    `${tripletexBaseUrl}/token/session/:create` +
    `?consumerToken=${encodeURIComponent(tripletexConsumerToken)}` +
    `&employeeToken=${encodeURIComponent(tripletexEmployeeToken)}` +
    `&expirationDate=${ymd(expiration)}`;

  const res = await fetch(url, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klarte ikke å opprette Tripletex-session (${res.status}): ${body}`);
  }
  const json = await res.json();
  sessionToken = json?.value?.token;
  if (!sessionToken) throw new Error("Tripletex returnerte ingen session-token.");
  sessionExpires = expiration.getTime();
  return sessionToken;
}

// Lavnivå GET mot Tripletex med Basic-auth (brukernavn "0", passord = session-token).
async function apiGet(path, params = {}) {
  const { tripletexBaseUrl } = getConfig();
  const token = await getSessionToken();
  const auth = Buffer.from(`0:${token}`).toString("base64");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const url = `${tripletexBaseUrl}${path}${qs.toString() ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tripletex GET ${path} feilet (${res.status}): ${body}`);
  }
  return res.json();
}

async function cachedGet(path, params = {}) {
  const key = path + JSON.stringify(params);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = await apiGet(path, params);
  cache.set(key, { value, expires: now + getConfig().cacheTtlMs });
  return value;
}

// ---- Domeneoppslag ----

export async function getProjects({ isClosed = false } = {}) {
  const data = await cachedGet("/project", {
    isClosed,
    count: 1000,
    fields:
      "id,number,name,isClosed,startDate,endDate,customer(id,name),projectManager(id,firstName,lastName)",
  });
  return data.values || [];
}

export async function getInvoices(fromDate, toDate) {
  const data = await cachedGet("/invoice", {
    invoiceDateFrom: fromDate,
    invoiceDateTo: toDate,
    count: 2000,
    fields:
      "id,invoiceNumber,invoiceDate,invoiceDueDate,amount,amountCurrency,amountOutstanding,isCredited,customer(id,name)",
  });
  return data.values || [];
}

export async function getOpenOrders(fromDate, toDate) {
  const data = await cachedGet("/order", {
    orderDateFrom: fromDate,
    orderDateTo: toDate,
    isClosed: false,
    count: 1000,
    fields: "id,number,orderDate,deliveryDate,isClosed,customerName,customer(id,name)",
  });
  return data.values || [];
}

export async function getEmployees() {
  const data = await cachedGet("/employee", {
    count: 500,
    fields: "id,firstName,lastName,email,employeeNumber,department(id,name)",
  });
  return data.values || [];
}

export async function getTimeEntries(fromDate, toDate) {
  const data = await cachedGet("/timesheet/entry", {
    dateFrom: fromDate,
    dateTo: toDate,
    count: 20000,
    fields:
      "id,date,hours,chargeableHours,chargeable,hourlyRate,project(id,name),employee(id,firstName,lastName)",
  });
  return data.values || [];
}

export { ymd };

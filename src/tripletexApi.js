// Direktekobling mot Tripletex REST API v2.
//
// Dette er Tripletex sin egen anbefaling for et internt dashboard som dette
// (support, 20.08.2026). Det ligger ingen MCP-server mellom lenger: MCP finnes
// for at språkmodeller skal kunne kalle verktøy, og dashbordet er ikke en
// språkmodell — det gjør vanlige datauttrekk. Ett ledd mindre å drifte, og ett
// ledd mindre å feilsøke når noe ikke stemmer.
//
// Autentisering, se
// https://developer.tripletex.no/docs/documentation/authentication-and-tokens/
//
//   Intern integrasjon (oss): en admin lager en JWT under Selskap → API-tokens.
//   Den byttes i en session token, som brukes som passord i Basic auth med
//   brukernavn "0". Ingen consumer token, ingen søknad til Tripletex.
//
//   Kommersiell integrasjon: consumer token + employee token. Støttes fortsatt,
//   i tilfelle vi en dag skal mot en annen kundes regnskap.
import { getConfig } from "./settings.js";

const PROD_BASE = "https://tripletex.no/v2";
const TEST_BASE = "https://api-test.tripletex.tech/v2";

// Session token varer så lenge vi ber om. 12 timer holder for et dashboard.
const SESSION_TTL_SECONDS = 12 * 60 * 60;
// Forny litt før utløp så et kall aldri rekker å bli avvist underveis.
const RENEW_MARGIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

let session = null; // { token, expiresAtMs }
let sessionInFlight = null;

export class TripletexError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "TripletexError";
    this.status = status;
    this.body = body;
  }
}

function baseUrl() {
  return getConfig().tripletexEnv === "test" ? TEST_BASE : PROD_BASE;
}

function credentials() {
  const c = getConfig();
  return {
    jwt: c.tripletexJwt || "",
    consumerToken: c.tripletexConsumerToken || "",
    employeeToken: c.tripletexEmployeeToken || "",
  };
}

export function hasCredentials() {
  const { jwt, employeeToken } = credentials();
  return Boolean(jwt || employeeToken);
}

export function resetSession() {
  session = null;
  sessionInFlight = null;
}

async function createSession() {
  const { jwt, consumerToken, employeeToken } = credentials();
  if (!jwt && !employeeToken) {
    throw new TripletexError(
      "Tripletex-nøkkel mangler. Sett TRIPLETEX_JWT i Railway (lages i Tripletex under Selskap → API-tokens).",
      0,
      ""
    );
  }

  if (jwt) {
    const res = await fetch(`${baseUrl()}/token/session/:createFromRefreshToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken: jwt, ttlSeconds: SESSION_TTL_SECONDS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new TripletexError(
        `Tripletex avviste nøkkelen (HTTP ${res.status}). Sjekk at TRIPLETEX_JWT er riktig, og at den er laget i samme miljø som vi kaller.`,
        res.status,
        text
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TripletexError("Uventet svar ved innlogging mot Tripletex.", res.status, text);
    }
    const token = parsed?.value?.token ?? parsed?.token;
    if (!token) throw new TripletexError("Innloggingen ga ingen session token.", res.status, text);
    return { token, expiresAtMs: Date.now() + SESSION_TTL_SECONDS * 1000 - RENEW_MARGIN_MS };
  }

  // Consumer + employee token. Disse utløper ved midnatt CET på expirationDate.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expirationDate = tomorrow.toISOString().slice(0, 10);
  const url =
    `${baseUrl()}/token/session/:create` +
    `?consumerToken=${encodeURIComponent(consumerToken)}` +
    `&employeeToken=${encodeURIComponent(employeeToken)}` +
    `&expirationDate=${expirationDate}`;
  const res = await fetch(url, { method: "PUT", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) {
    throw new TripletexError(
      `Tripletex avviste tokenene (HTTP ${res.status}).`,
      res.status,
      text
    );
  }
  const token = JSON.parse(text)?.value?.token;
  if (!token) throw new TripletexError("Innloggingen ga ingen session token.", res.status, text);
  return { token, expiresAtMs: new Date(`${expirationDate}T00:00:00`).getTime() };
}

// Gyldig session token. Samtidige kall deler på samme innlogging.
async function ensureSession() {
  if (session && session.expiresAtMs > Date.now()) return session.token;
  if (!sessionInFlight) {
    sessionInFlight = createSession()
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        sessionInFlight = null;
      });
  }
  return (await sessionInFlight).token;
}

function authHeader(token) {
  return "Basic " + Buffer.from(`0:${token}`).toString("base64");
}

// Bygger query-strengen. Tripletex vil ha rene verdier, og tomme skal utelates.
function toQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, typeof v === "boolean" ? String(v) : String(v));
  }
  return q.toString();
}

/**
 * GET mot et Tripletex-endepunkt. Returnerer svaret slik Tripletex sender det,
 * altså { values, fullResultSize, ... } for lister.
 */
export async function apiGet(path, params, isRetry = false) {
  const token = await ensureSession();
  const query = toQuery(params);
  const res = await fetch(`${baseUrl()}${path}${query ? "?" + query : ""}`, {
    headers: { Authorization: authHeader(token), Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Utløpt session — logg inn på nytt og prøv én gang til.
  if (res.status === 401 && !isRetry) {
    resetSession();
    return apiGet(path, params, true);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      const msg = parsed?.message || parsed?.error || "";
      const vm = parsed?.validationMessages;
      detail = [msg, vm ? JSON.stringify(vm) : ""].filter(Boolean).join(" ") || detail;
    } catch {
      /* behold rå tekst */
    }
    throw new TripletexError(`Tripletex ${path} avviste kallet (HTTP ${res.status}): ${detail}`, res.status, text);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TripletexError(`Tripletex ${path} svarte ikke med JSON.`, res.status, text.slice(0, 300));
  }
}

/** Hvem er vi pålogget som. Brukes av tilkoblingstesten. */
export function whoAmI() {
  return apiGet("/token/session/>whoAmI");
}

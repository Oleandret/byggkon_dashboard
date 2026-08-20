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

// Tripletex tillater 300–28800 sekunder (5 min til 8 timer) på session token.
// Vi tar maks – dashbordet kaller ofte, og tokenet fornyes automatisk uansett.
const SESSION_TTL_SECONDS = 28800;
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

// Plukker ut Tripletex sin egen feilbeskrivelse. Den er nesten alltid mer
// presis enn noe vi kan gjette oss til, så den skal alltid være med videre.
function explain(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const msg =
      parsed?.message ||
      parsed?.error_description ||
      parsed?.error ||
      parsed?.validationMessages?.[0]?.message ||
      "";
    const fields = (parsed?.validationMessages || [])
      .map((v) => [v.field, v.message].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ");
    return [msg, fields && fields !== msg ? `(${fields})` : ""].filter(Boolean).join(" ") ||
      text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function credentials() {
  const c = getConfig();
  return {
    jwt: c.tripletexJwt || "",
    consumerToken: c.tripletexConsumerToken || "",
    employeeToken: c.tripletexEmployeeToken || "",
  };
}

// Tripletex har to slags nøkler, og de ser helt forskjellige ut. Refresh
// tokenet fra Selskap → API-tokens har alltid tlxr_-prefiks; et employee token
// fra Innstillinger → Integrasjoner → API-tilgang har det ikke. Vi kjenner dem
// fra hverandre selv, så det ikke spiller noen rolle hvilken av dem som er
// limt inn i TRIPLETEX_JWT.
function isRefreshToken(value) {
  return typeof value === "string" && value.startsWith("tlxr_");
}

/**
 * Hvordan vi logger inn, ut fra hva som faktisk er satt.
 * Returnerer { kind: "refresh" | "tokenPair" | "none", ... }
 */
export function credentialKind() {
  const { jwt, consumerToken, employeeToken } = credentials();
  if (isRefreshToken(jwt)) return { kind: "refresh", refreshToken: jwt };
  // Alt annet i TRIPLETEX_JWT behandles som et employee token.
  const employee = employeeToken || jwt;
  if (employee) return { kind: "tokenPair", employeeToken: employee, consumerToken };
  return { kind: "none" };
}

export function hasCredentials() {
  return credentialKind().kind !== "none";
}

export function resetSession() {
  session = null;
  sessionInFlight = null;
}

function readSessionToken(text, status) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TripletexError("Uventet svar ved innlogging mot Tripletex.", status, text);
  }
  const token = parsed?.value?.token ?? parsed?.token;
  if (!token) throw new TripletexError("Innloggingen ga ingen session token.", status, text);
  return token;
}

async function createSession() {
  const cred = credentialKind();
  if (cred.kind === "none") {
    throw new TripletexError(
      "Tripletex-nøkkel mangler. Sett TRIPLETEX_JWT i Railway – nøkkelen lages i Tripletex under Selskap → API-tokens.",
      0,
      ""
    );
  }

  if (cred.kind === "refresh") {
    const res = await fetch(`${baseUrl()}/token/session/:createFromRefreshToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken: cred.refreshToken, ttlSeconds: SESSION_TTL_SECONDS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Ta alltid med Tripletex sin egen forklaring – den er mer presis enn
      // noe vi kan gjette oss til.
      throw new TripletexError(
        `Tripletex avviste refresh tokenet (HTTP ${res.status}). ${explain(text)}`.trim(),
        res.status,
        text
      );
    }
    return {
      token: readSessionToken(text, res.status),
      expiresAtMs: Date.now() + SESSION_TTL_SECONDS * 1000 - RENEW_MARGIN_MS,
    };
  }

  // Employee token, eventuelt sammen med et consumer token. Session token fra
  // denne veien utløper ved midnatt CET på expirationDate.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expirationDate = tomorrow.toISOString().slice(0, 10);
  const res = await fetch(`${baseUrl()}/token/session/:create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      employeeToken: cred.employeeToken,
      consumerToken: cred.consumerToken || "",
      expirationDate,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const notes = [`Tripletex avviste nøkkelen (HTTP ${res.status})`, explain(text)];
    if (!cred.consumerToken) {
      notes.push(
        "Verdien ble tolket som et employee token, og da kreves som regel også et consumer token. " +
          "Enklere vei: lag et refresh token under Selskap → API-tokens i Tripletex (starter med «tlxr_») " +
          "og bruk det som TRIPLETEX_JWT – da trengs ingen consumer token"
      );
    }
    throw new TripletexError(notes.filter(Boolean).join(". "), res.status, text);
  }
  return {
    token: readSessionToken(text, res.status),
    expiresAtMs: new Date(`${expirationDate}T00:00:00`).getTime(),
  };
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
    throw new TripletexError(
      `Tripletex ${path} avviste kallet (HTTP ${res.status}): ${explain(text)}`,
      res.status,
      text
    );
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

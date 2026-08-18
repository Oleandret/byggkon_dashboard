// OAuth 2.1 mot Tripletex sin egen MCP-server (mcp.tripletex.no).
//
// Samme flyt som Claude-connectoren bruker, og den er standardisert i
// MCP-spesifikasjonen: vi leser serverens metadata, registrerer oss som klient
// automatisk (dynamic client registration), sender admin til Tripletex for
// innlogging, og bytter koden vi får tilbake i et access token med PKCE.
// Refresh token holder koblingen i live uten ny innlogging.
//
// Tokenene lagres i innstillingsfila. På Railway betyr det at et Volume må være
// montert på SETTINGS_PATH – uten det må koblingen settes opp på nytt etter
// hver deploy.
import crypto from "node:crypto";
import { getConfig, saveConfig } from "./settings.js";

const DISCOVERY_TIMEOUT_MS = 10000;
// Vi fornyer litt før utløp så et kall aldri rekker å bli avvist.
const REFRESH_MARGIN_MS = 60 * 1000;

let discoveryCache = null; // { origin, metadata }
let refreshInFlight = null;

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken() {
  return b64url(crypto.randomBytes(32));
}

export function challengeFor(verifier) {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

function mcpOrigin() {
  const { tripletexMcpUrl } = getConfig();
  if (!tripletexMcpUrl) throw new Error("Tripletex MCP-URL er ikke satt.");
  return new URL(tripletexMcpUrl).origin;
}

/**
 * Henter serverens OAuth-metadata. Prøver først authorization-server-dokumentet
 * direkte, og faller tilbake på protected-resource-dokumentet som peker videre.
 * Returnerer null hvis serveren ikke bruker OAuth i det hele tatt – da er det en
 * selvhostet MCP uten pålogging, og resten av modulen skal ligge unna.
 */
export async function discoverOauth() {
  const origin = mcpOrigin();
  if (discoveryCache?.origin === origin) return discoveryCache.metadata;

  const get = async (path) => {
    const res = await fetch(origin + path, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  };

  let metadata = await get("/.well-known/oauth-authorization-server");
  if (!metadata?.authorization_endpoint) {
    const resource = await get("/.well-known/oauth-protected-resource");
    const issuer = resource?.authorization_servers?.[0];
    if (issuer) {
      const res = await fetch(
        new URL("/.well-known/oauth-authorization-server", issuer).toString(),
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) }
      );
      metadata = res.ok ? await res.json().catch(() => null) : null;
    }
  }
  if (!metadata?.authorization_endpoint || !metadata?.token_endpoint) metadata = null;

  discoveryCache = { origin, metadata };
  return metadata;
}

/**
 * Sørger for at vi har en klient-ID hos Tripletex. Registrerer oss automatisk
 * hvis vi ikke har en fra før, eller hvis dashbordet har fått ny adresse.
 */
async function ensureClient(redirectUri) {
  const metadata = await discoverOauth();
  if (!metadata) throw new Error("MCP-serveren tilbyr ikke OAuth.");

  const stored = getConfig().tripletexOauthClient;
  if (stored?.clientId && stored.redirectUri === redirectUri && stored.issuer === metadata.issuer) {
    return stored;
  }
  if (!metadata.registration_endpoint) {
    throw new Error(
      "Serveren støtter ikke automatisk klientregistrering. Registrer en klient manuelt hos Tripletex."
    );
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Bygg-Kon driftssentral",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // offentlig klient, PKCE beskytter koden
    }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Klientregistrering feilet (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Klientregistrering ga ikke gyldig JSON.");
  }
  const client = {
    clientId: data.client_id,
    clientSecret: data.client_secret || "",
    redirectUri,
    issuer: metadata.issuer || "",
    registeredAt: new Date().toISOString(),
  };
  if (!client.clientId) throw new Error("Klientregistrering ga ingen client_id.");
  saveConfig({ tripletexOauthClient: client });
  return client;
}

/** Bygger adressen admin sendes til for å logge inn hos Tripletex. */
export async function buildAuthorizeUrl({ redirectUri, state, codeVerifier }) {
  const metadata = await discoverOauth();
  if (!metadata) throw new Error("MCP-serveren tilbyr ikke OAuth.");
  const client = await ensureClient(redirectUri);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: challengeFor(codeVerifier),
    code_challenge_method: "S256",
    state,
    // RFC 8707: si eksplisitt hvilken ressurs tokenet skal gjelde for.
    resource: getConfig().tripletexMcpUrl,
  });
  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

function storeTokens(data) {
  const tokens = {
    accessToken: data.access_token,
    // Tripletex sender ikke nødvendigvis nytt refresh token ved fornying.
    refreshToken: data.refresh_token || getConfig().tripletexOauthTokens?.refreshToken || "",
    tokenType: data.token_type || "Bearer",
    scope: data.scope || "",
    expiresAtMs: data.expires_in
      ? Date.now() + Number(data.expires_in) * 1000
      : Date.now() + 60 * 60 * 1000,
    connectedAt: getConfig().tripletexOauthTokens?.connectedAt || new Date().toISOString(),
  };
  saveConfig({ tripletexOauthTokens: tokens });
  return tokens;
}

async function postToken(body) {
  const metadata = await discoverOauth();
  if (!metadata) throw new Error("MCP-serveren tilbyr ikke OAuth.");
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token-endepunktet svarte ikke med JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Token-utveksling feilet: ${detail}`);
  }
  if (!data.access_token) throw new Error("Token-utveksling ga ingen access_token.");
  return data;
}

/** Bytter koden fra callback-en i et access token. */
export async function exchangeCode({ code, redirectUri, codeVerifier }) {
  const client = await ensureClient(redirectUri);
  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier,
    resource: getConfig().tripletexMcpUrl,
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  return storeTokens(await postToken(body));
}

/** Fornyer access token. Flere samtidige kall deler på samme forespørsel. */
export async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const { tripletexOauthClient: client, tripletexOauthTokens: tokens } = getConfig();
    if (!tokens?.refreshToken) throw new Error("Ingen refresh token – koble til Tripletex på nytt.");
    if (!client?.clientId) throw new Error("Ingen registrert OAuth-klient – koble til Tripletex på nytt.");
    const body = {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: client.clientId,
      resource: getConfig().tripletexMcpUrl,
    };
    if (client.clientSecret) body.client_secret = client.clientSecret;
    return storeTokens(await postToken(body));
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Gyldig access token, eller null hvis vi ikke er koblet til. Null er ikke en
 * feil – en selvhostet MCP-server uten OAuth skal kunne brukes som før.
 */
export async function getAccessToken() {
  const tokens = getConfig().tripletexOauthTokens;
  if (!tokens?.accessToken) return null;
  if (tokens.expiresAtMs && tokens.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) return tokens.accessToken; // la serveren avvise den
  const fresh = await refreshAccessToken();
  return fresh.accessToken;
}

export function getOauthStatus() {
  const { tripletexOauthClient: client, tripletexOauthTokens: tokens } = getConfig();
  return {
    connected: Boolean(tokens?.accessToken),
    clientRegistered: Boolean(client?.clientId),
    redirectUri: client?.redirectUri || "",
    scope: tokens?.scope || "",
    connectedAt: tokens?.connectedAt || "",
    expiresAt: tokens?.expiresAtMs ? new Date(tokens.expiresAtMs).toISOString() : "",
  };
}

/** Kobler fra og ber Tripletex trekke tilbake tokenet hvis de støtter det. */
export async function disconnect() {
  const { tripletexOauthClient: client, tripletexOauthTokens: tokens } = getConfig();
  const metadata = await discoverOauth().catch(() => null);
  if (metadata?.revocation_endpoint && tokens?.refreshToken && client?.clientId) {
    const body = { token: tokens.refreshToken, client_id: client.clientId };
    if (client.clientSecret) body.client_secret = client.clientSecret;
    await fetch(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    }).catch(() => {
      /* best effort – vi glemmer tokenet lokalt uansett */
    });
  }
  saveConfig({ tripletexOauthTokens: {} });
}

// MCP-klient mot vår egen Tripletex MCP-server (repoet Oleandret/tripletex-mcp,
// startet med MCP_TRANSPORT=http og eksponert på .../mcp).
// Snakker "streamable HTTP" JSON-RPC mot den URL-en.
// URL-en hentes fra innstillinger/miljøvariabel og er hemmelig.
import { getConfig } from "./settings.js";
import { getAccessToken, refreshAccessToken } from "./tripletexOauth.js";

let sessionId = null;
let initPromise = null;
let serverInfo = null; // { name, version } fra initialize-svaret

function parseBody(text) {
  if (!text) return null;
  text = text.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.parse(text); } catch {}
  }
  // SSE: finn siste "data:"-linje som er gyldig JSON-RPC
  let found = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data:")) {
      try {
        const obj = JSON.parse(t.slice(5).trim());
        if (obj && (obj.jsonrpc || obj.result || obj.error)) found = obj;
      } catch {}
    }
  }
  return found;
}

async function rpc(method, params, isNotification = false) {
  const { tripletexMcpUrl, tripletexJwt } = getConfig();
  if (!tripletexMcpUrl) {
    throw new Error(
      "Tripletex MCP-URL er ikke satt. Legg den inn på admin-siden (/admin) eller som miljøvariabel TRIPLETEX_MCP_URL (f.eks. https://tripletex-mcp-production.up.railway.app/mcp)."
    );
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  // To måter å autentisere, avhengig av hvilken MCP-server vi peker på:
  //   Tripletex sin egen (mcp.tripletex.no) krever OAuth – Bearer-token.
  //   Vår selvhostede tar nøkkelen som header, eller har den i miljøet sitt.
  const accessToken = await getAccessToken();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  else if (tripletexJwt) headers["X-Tripletex-Jwt"] = tripletexJwt;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = { jsonrpc: "2.0", method, params };
  if (!isNotification) body.id = Math.floor(Math.random() * 1e9);

  const res = await fetch(tripletexMcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`MCP ${method} feilet (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }
  if (isNotification) return null;
  return parseBody(await res.text());
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const r = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "byggkon-dashboard", version: "2.0" },
      });
      if (r?.error) {
        throw new Error(`MCP initialize: ${r.error.message || JSON.stringify(r.error)}`);
      }
      serverInfo = r?.result?.serverInfo || null;
      await rpc("notifications/initialized", {}, true);
    })().catch((e) => {
      initPromise = null; // tillat ny init ved feil
      throw e;
    });
  }
  return initPromise;
}

// MCP-serveren holder sesjonene i minnet, så de forsvinner ved ny deploy.
// Da er den lagrede session-ID-en vår ugyldig og kallet avvises – én ny
// initialisering fikser det.
function isStaleSession(err) {
  const msg = String(err?.message || "");
  return /HTTP (400|404)/.test(msg) || /session/i.test(msg);
}

// Utløpt eller trukket tilbake access token.
function isAuthError(err) {
  const msg = String(err?.message || "");
  return /HTTP 401/.test(msg) || /invalid_token/i.test(msg);
}

// Kaller et MCP-verktøy og returnerer parset JSON-resultat.
export async function callTool(name, args = {}) {
  try {
    return await callToolOnce(name, args);
  } catch (err) {
    if (isAuthError(err)) {
      await refreshAccessToken(); // kaster videre hvis vi må koble til på nytt
      resetClient();
      return callToolOnce(name, args);
    }
    if (!isStaleSession(err)) throw err;
    resetClient();
    return callToolOnce(name, args);
  }
}

async function callToolOnce(name, args) {
  await ensureInit();
  const r = await rpc("tools/call", { name, arguments: args });
  const result = r?.result;
  if (r?.error) throw new Error(`MCP-verktøy ${name}: ${r.error.message || JSON.stringify(r.error)}`);
  const content = result?.content;
  let payload = result;
  if (Array.isArray(content)) {
    const textPart = content.find((c) => c.type === "text");
    if (textPart) {
      try { payload = JSON.parse(textPart.text); } catch { payload = textPart.text; }
    }
  }
  if (result?.isError) {
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`MCP-verktøy ${name} returnerte feil: ${String(msg).slice(0, 300)}`);
  }
  return payload;
}

// Kobler opp og returnerer serverens navn/versjon – brukes av tilkoblingstesten.
export async function handshake() {
  await ensureInit();
  return serverInfo;
}

// Verktøyene MCP-serveren tilbyr. Brukes av tilkoblingstesten for å sjekke at
// serveren har det dashbordet trenger.
export async function listTools() {
  await ensureInit();
  const r = await rpc("tools/list", {});
  if (r?.error) {
    throw new Error(`MCP tools/list: ${r.error.message || JSON.stringify(r.error)}`);
  }
  return r?.result?.tools || [];
}

export function resetClient() {
  sessionId = null;
  initPromise = null;
  serverInfo = null;
}

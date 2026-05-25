// MCP-klient mot Regnskapsagent (Tripletex via MCP).
// Snakker "streamable HTTP" JSON-RPC mot URL-en fra Regnskapsagent.
// URL-en hentes fra innstillinger/miljøvariabel og er hemmelig.
import { getConfig } from "./settings.js";

let sessionId = null;
let initPromise = null;

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
  const { regnskapsagentMcpUrl } = getConfig();
  if (!regnskapsagentMcpUrl) {
    throw new Error(
      "Regnskapsagent MCP-URL er ikke satt. Legg den inn på admin-siden (/admin) eller som miljøvariabel REGNSKAPSAGENT_MCP_URL."
    );
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = { jsonrpc: "2.0", method, params };
  if (!isNotification) body.id = Math.floor(Math.random() * 1e9);

  const res = await fetch(regnskapsagentMcpUrl, {
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
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "byggkon-dashboard", version: "1.0" },
      });
      await rpc("notifications/initialized", {}, true);
    })().catch((e) => {
      initPromise = null; // tillat ny init ved feil
      throw e;
    });
  }
  return initPromise;
}

// Kaller et MCP-verktøy og returnerer parset JSON-resultat.
export async function callTool(name, args = {}) {
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

export function resetClient() {
  sessionId = null;
  initPromise = null;
}

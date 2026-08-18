// Tilkoblingstest for Tripletex-kjeden: innstillinger → MCP-server → Tripletex.
// Kjøres fra admin-siden. Går ett steg om gangen og stopper ved første feil,
// slik at svaret peker på hvor det faktisk klikker – ikke bare at "noe" er galt.
import { getConfig } from "./settings.js";
import { callTool, handshake, listTools, resetClient } from "./mcpClient.js";

const HEALTH_TIMEOUT_MS = 10000;

// Verktøyene dashbordet faktisk kaller. Mangler noen av dem, er MCP-serveren
// enten en eldre versjon eller en annen server enn vi tror.
const REQUIRED_TOOLS = [
  "search_projects",
  "search_orders",
  "search_invoices",
  "search_supplier_invoices",
  "search_customers",
  "search_suppliers",
  "search_employees",
  "search_time_entries",
  "search_accounts",
  "get_balance_sheet",
];

function short(value, max = 400) {
  return String(value ?? "").slice(0, max);
}

// Maskerer en URL slik at den kan vises i nettleseren uten å lekke hele
// adressen – vi viser vertsnavn og sti, men ikke query/token.
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(ugyldig URL)";
  }
}

export async function runConnectionTests() {
  const steps = [];
  let failed = false;

  // Kjører ett steg. Etter første feil markeres resten som ikke kjørt, slik at
  // en feil tidlig i kjeden ikke drukner i følgefeil lenger ute.
  async function step(name, hint, fn) {
    if (failed) {
      steps.push({ name, status: "skipped", detail: "Ikke kjørt – et tidligere steg feilet." });
      return null;
    }
    const startedAt = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, status: "ok", detail: short(detail || "OK"), ms: Date.now() - startedAt });
      return detail;
    } catch (err) {
      failed = true;
      steps.push({
        name,
        status: "error",
        detail: short(err?.message || err),
        hint,
        ms: Date.now() - startedAt,
      });
      return null;
    }
  }

  const config = getConfig();

  await step(
    "Innstillinger",
    "Sett TRIPLETEX_MCP_URL i Railway, eller lim inn URL-en under MCP & datakilder.",
    () => {
      const url = config.tripletexMcpUrl;
      if (!url) throw new Error("Tripletex MCP-URL er ikke satt.");
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`"${short(url, 60)}" er ikke en gyldig URL.`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error("URL-en må starte med https://");
      }
      const notes = [`MCP-URL: ${safeUrl(url)}`];
      if (!parsed.pathname.endsWith("/mcp")) {
        notes.push("Merk: adressen slutter ikke på /mcp – det er vanligvis feil.");
      }
      notes.push(
        config.tripletexJwt
          ? "TRIPLETEX_JWT er satt på dashbordet og sendes med hvert kall."
          : "TRIPLETEX_JWT er ikke satt på dashbordet – MCP-serveren må ha sin egen."
      );
      return notes.join(" ");
    }
  );

  await step(
    "Helsesjekk av MCP-serveren",
    "Sjekk at tjenesten kjører i Railway, og at MCP_TRANSPORT=http er satt.",
    async () => {
      const origin = new URL(config.tripletexMcpUrl).origin;
      const res = await fetch(origin + "/health", {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`HTTP ${res.status} fra ${origin}/health: ${short(body, 200)}`);
      try {
        const data = JSON.parse(body);
        return `${data.server || "ukjent server"} ${data.version || ""} svarer på ${origin}`.trim();
      } catch {
        return `${origin} svarer (HTTP ${res.status})`;
      }
    }
  );

  await step(
    "MCP-håndtrykk",
    "Serveren svarer, men snakker ikke MCP på denne adressen. Sjekk at URL-en slutter på /mcp.",
    async () => {
      resetClient(); // tving en fersk sesjon, ellers tester vi bare en gammel
      const info = await handshake();
      return info?.name
        ? `Tilkoblet ${info.name} ${info.version || ""}`.trim()
        : "Tilkoblet (serveren oppga ikke navn)";
    }
  );

  await step(
    "Verktøy",
    "MCP-serveren er trolig en eldre versjon. Deploy siste versjon av tripletex-mcp.",
    async () => {
      const tools = await listTools();
      const names = new Set(tools.map((t) => t.name));
      const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
      if (missing.length) {
        throw new Error(`Mangler ${missing.length} verktøy: ${missing.join(", ")}`);
      }
      return `${tools.length} verktøy tilgjengelig, alle ${REQUIRED_TOOLS.length} dashbordet trenger er på plass.`;
    }
  );

  await step(
    "Tripletex-pålogging",
    "Nøkkelen mangler eller er avvist. Sjekk TRIPLETEX_JWT, og at den er laget i samme miljø (produksjon vs. test).",
    async () => {
      const me = await callTool("whoami");
      if (me?.httpStatus >= 400 || me?.tripletexResponse) {
        const msg = me.tripletexResponse?.message || me.message || `HTTP ${me.httpStatus}`;
        throw new Error(`Tripletex avviste påloggingen: ${msg}`);
      }
      const v = me?.value || me || {};
      const company = v.companyName || v.company?.name || v.companyId || "";
      const employee = v.employeeName || v.employee?.name || "";
      const who = [company, employee].filter(Boolean).join(" · ");
      return who ? `Pålogget: ${who}` : "Pålogget Tripletex.";
    }
  );

  await step(
    "Datauttrekk",
    "Påloggingen virker, men prosjektdata kommer ikke ut. Sjekk rettighetene til brukeren nøkkelen ble laget for.",
    async () => {
      const data = await callTool("search_projects", {
        isClosed: false,
        from: 0,
        count: 1,
        fields: "id,number,name,customer(id,name)",
      });
      if (data?.httpStatus >= 400 || data?.tripletexResponse) {
        const msg = data.tripletexResponse?.message || data.message || `HTTP ${data.httpStatus}`;
        throw new Error(`Tripletex avviste kallet: ${msg}`);
      }
      const values = data?.values;
      if (!Array.isArray(values)) {
        throw new Error("Uventet svar – fant ingen 'values'-liste i resultatet.");
      }
      const total = data.fullResultSize ?? values.length;
      if (!values.length) {
        return `Kallet gikk gjennom, men Tripletex returnerte ingen aktive prosjekter (${total} totalt).`;
      }
      // Uten fields-støtte i MCP-serveren kommer navnene tomme tilbake, og
      // dashbordet ville vist prosjekter og kunder uten navn.
      if (!values[0].name) {
        throw new Error(
          "Prosjektet mangler navn – MCP-serveren sender trolig ikke 'fields' videre til Tripletex. Deploy siste versjon av tripletex-mcp."
        );
      }
      return `${total} aktive prosjekter. Første: ${values[0].number || "?"} ${values[0].name}`;
    }
  );

  return {
    ok: !failed,
    checkedAt: new Date().toISOString(),
    steps,
  };
}

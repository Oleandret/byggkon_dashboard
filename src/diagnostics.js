// Tilkoblingstest for Tripletex-kjeden: innstillinger → MCP-server → Tripletex.
// Kjøres fra admin-siden. Går ett steg om gangen og stopper ved første feil,
// slik at svaret peker på hvor det faktisk klikker – ikke bare at "noe" er galt.
//
// Testen skal virke mot begge servertypene vi kan peke på: vår egen selvhostede
// tripletex-mcp, og Tripletex sin egen mcp.tripletex.no som krever OAuth. Den
// lister derfor opp hva serveren faktisk tilbyr i stedet for å ta for gitt at
// verktøyene heter det vi forventer.
import { getConfig } from "./settings.js";
import { callTool, handshake, listTools, resetClient } from "./mcpClient.js";
import { discoverOauth, getOauthStatus } from "./tripletexOauth.js";

const HEALTH_TIMEOUT_MS = 10000;

// Verktøyene dashbordet faktisk kaller.
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

function short(value, max = 500) {
  return String(value ?? "").slice(0, max);
}

// Vertsnavn og sti, uten query – trygt å vise i nettleseren.
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

  // Etter første feil markeres resten som ikke kjørt, slik at en feil tidlig i
  // kjeden ikke drukner i følgefeil lenger ute.
  async function step(name, hint, fn) {
    if (failed) {
      steps.push({ name, status: "skipped", detail: "Ikke kjørt – et tidligere steg feilet." });
      return null;
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      const warn = result && typeof result === "object" && result.warn;
      steps.push({
        name,
        status: warn ? "warn" : "ok",
        detail: short(warn ? result.warn : result || "OK"),
        hint: warn ? hint : undefined,
        ms: Date.now() - startedAt,
      });
      return result;
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
  let usesOauth = false;

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
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("URL-en må starte med https://");
      return `MCP-URL: ${safeUrl(url)}`;
    }
  );

  await step(
    "Type MCP-server",
    "Sjekk at URL-en peker dit du tror. Tripletex sin egen server er https://mcp.tripletex.no/, vår egen ligger på Railway og slutter på /mcp.",
    async () => {
      const metadata = await discoverOauth().catch(() => null);
      usesOauth = Boolean(metadata);
      if (!usesOauth) {
        return `Selvhostet MCP-server uten OAuth. ${
          config.tripletexJwt
            ? "TRIPLETEX_JWT er satt på dashbordet og sendes med hvert kall."
            : "MCP-serveren må ha sin egen TRIPLETEX_JWT."
        }`;
      }
      return `Krever OAuth (utsteder ${safeUrl(metadata.issuer || config.tripletexMcpUrl)}).`;
    }
  );

  await step(
    "Helsesjekk av MCP-serveren",
    "Sjekk at tjenesten kjører. For vår egen: at MCP_TRANSPORT=http er satt i Railway.",
    async () => {
      const origin = new URL(config.tripletexMcpUrl).origin;
      // Tripletex sin server har ikke /health, men svarer på rot-URL-en.
      const res = await fetch(usesOauth ? origin : origin + "/health", {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const body = await res.text().catch(() => "");
      // 401 fra en OAuth-server betyr at den lever og krever pålogging – det er
      // ikke en feil her, det håndteres i neste steg.
      if (!res.ok && !(usesOauth && res.status === 401)) {
        throw new Error(`HTTP ${res.status} fra ${origin}: ${short(body, 200)}`);
      }
      try {
        const data = JSON.parse(body);
        if (data.server) return `${data.server} ${data.version || ""} svarer på ${origin}`.trim();
      } catch {
        /* ikke JSON – det går fint */
      }
      return `${origin} svarer (HTTP ${res.status})`;
    }
  );

  await step(
    "Pålogging",
    "Gå til MCP & datakilder og trykk «Koble til Tripletex».",
    async () => {
      if (!usesOauth) return "Ikke nødvendig – serveren bruker ikke OAuth.";
      const status = getOauthStatus();
      if (!status.connected) {
        throw new Error("Ikke koblet til Tripletex ennå – ingen OAuth-pålogging er fullført.");
      }
      const expires = status.expiresAt ? new Date(status.expiresAt).toLocaleString("nb-NO") : "ukjent";
      return `Koblet til. Tilgangen utløper ${expires} og fornyes automatisk.`;
    }
  );

  await step(
    "MCP-håndtrykk",
    "Serveren svarer, men snakker ikke MCP på denne adressen. Sjekk at URL-en er riktig.",
    async () => {
      resetClient(); // tving en fersk sesjon, ellers tester vi bare en gammel
      const info = await handshake();
      return info?.name
        ? `Tilkoblet ${info.name} ${info.version || ""}`.trim()
        : "Tilkoblet (serveren oppga ikke navn)";
    }
  );

  // Verktøysteget feiler ikke, det rapporterer. Peker vi på en annen MCP-server
  // enn vår egen, heter verktøyene noe annet – og da er det nettopp lista over
  // hva som finnes vi trenger å se.
  const toolStep = await step(
    "Verktøy",
    "Dashbordet kan ikke hente data før disse finnes. Vår egen tripletex-mcp har dem alle – Tripletex sin egen server bruker andre navn, og da må datalaget kobles om.",
    async () => {
      const tools = await listTools();
      const names = tools.map((t) => t.name);
      const present = new Set(names);
      const missing = REQUIRED_TOOLS.filter((t) => !present.has(t));
      if (missing.length) {
        return {
          warn:
            `${tools.length} verktøy tilgjengelig, men ${missing.length} av ${REQUIRED_TOOLS.length} dashbordet trenger mangler: ` +
            `${missing.join(", ")}. Serveren tilbyr: ${names.join(", ")}`,
          names,
        };
      }
      return `${tools.length} verktøy tilgjengelig, alle ${REQUIRED_TOOLS.length} dashbordet trenger er på plass.`;
    }
  );

  const available = new Set(
    (toolStep && typeof toolStep === "object" && toolStep.names) || REQUIRED_TOOLS
  );

  await step(
    "Tripletex-pålogging",
    "Nøkkelen mangler eller er avvist. Sjekk at den er laget i samme miljø (produksjon vs. test).",
    async () => {
      if (!available.has("whoami")) {
        return "Hoppet over – serveren har ikke et whoami-verktøy.";
      }
      const me = await callTool("whoami");
      if (me?.httpStatus >= 400 || me?.tripletexResponse) {
        const msg = me.tripletexResponse?.message || me.message || `HTTP ${me.httpStatus}`;
        throw new Error(`Tripletex avviste påloggingen: ${msg}`);
      }
      const v = me?.value || me || {};
      const who = [v.companyName || v.company?.name || v.companyId, v.employeeName || v.employee?.name]
        .filter(Boolean)
        .join(" · ");
      return who ? `Pålogget: ${who}` : "Pålogget Tripletex.";
    }
  );

  await step(
    "Datauttrekk",
    "Påloggingen virker, men prosjektdata kommer ikke ut. Sjekk rettighetene til brukeren nøkkelen ble laget for.",
    async () => {
      if (!available.has("search_projects")) {
        throw new Error(
          "Serveren har ikke search_projects, så dashbordet kan ikke hente prosjekter fra den."
        );
      }
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
    ok: !failed && !steps.some((s) => s.status === "warn"),
    checkedAt: new Date().toISOString(),
    steps,
  };
}

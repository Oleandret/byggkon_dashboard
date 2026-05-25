// Lagring og uthenting av innstillinger.
// Verdier kan settes via admin-siden (lagres i en JSON-fil) eller via
// miljøvariabler. Filen vinner over miljøvariabler når den finnes.
//
// På Railway er filsystemet flyktig mellom deployer. Sett SETTINGS_PATH til en
// montert Volume (f.eks. /data/settings.json) for at innstillinger skal være
// permanente. Se README.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SETTINGS_PATH =
  process.env.SETTINGS_PATH || path.join(process.cwd(), "data", "settings.json");

// Startdata for kompetansematrisen (generert fra opplastet Excel).
function defaultCompetence() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "competence-seed.json"), "utf8"));
  } catch {
    return { scale: [], groups: [], employees: [] };
  }
}

// Standard hentes fra miljøvariabler (eller fornuftige defaults).
function defaults() {
  return {
    companyName: process.env.COMPANY_NAME || "BYGG-KON",
    heroImageUrl:
      process.env.HERO_IMAGE_URL ||
      "https://cdn.prod.website-files.com/6971dca24ade29a12176f9bf/69bd3f133cccc0a691865253_Travbaneveien3-8.jpg",
    regnskapsagentMcpUrl: process.env.REGNSKAPSAGENT_MCP_URL || "",
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "byggkon",
    weeklyCapacityHours: Number(process.env.WEEKLY_CAPACITY_HOURS || 37.5),
    cacheTtlMs: Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000),
    refreshSeconds: Number(process.env.REFRESH_SECONDS || 60),
    orgChart: defaultOrgChart(),
    competence: defaultCompetence(),
  };
}

// Startstruktur for organisasjonskartet (fra opplastet PDF, mai 2026).
function defaultOrgChart() {
  return [
    { id: "ole", name: "Ole-André Torjussen", title: "Daglig leder", email: "oat@byggkon.no", phone: "929 80 460", parentId: null },
    { id: "benedicte", name: "Benedicte Molnes", title: "Lederstøtte og prosjektingeniør", email: "bm@byggkon.no", phone: "467 89 790", parentId: "ole" },
    { id: "tormod", name: "Tormod Skavland", title: "Avdelingsleder BYGG og prosjektadm", email: "ts@byggkon.no", phone: "976 56 526", parentId: "ole" },
    { id: "mariam", name: "Mariam Sediqi Ansari", title: "Prosjektingeniør", email: "msa@byggkon.no", phone: "977 71 112", parentId: "tormod" },
    { id: "william", name: "William Larsen", title: "Avdelingsleder RIB", email: "wl@byggkon.no", phone: "412 27 676", parentId: "ole" },
    { id: "mortenl", name: "Morten Larsen", title: "Faglig leder RIB", email: "morten@byggkon.no", phone: "970 85 371", parentId: "william" },
    { id: "lana", name: "Svjetlana Milic Baros", title: "RIB", email: "lana@byggkon.no", phone: "950 97 996", parentId: "william" },
    { id: "bendik", name: "Bendik Selmer-Andersen", title: "RIB", email: "ba@byggkon.no", phone: "917 14 515", parentId: "william" },
    { id: "ola", name: "Ola K Undheim", title: "RIB", email: "au@byggkon.no", phone: "913 44 486", parentId: "william" },
    { id: "torgunnar", name: "Tor Gunnar Vilke", title: "RIB", email: "tgv@byggkon.no", phone: "452 59 205", parentId: "william" },
    { id: "ove", name: "Ove Henning Tjølsen", title: "Faglig leder ARK", email: "ovehenning@byggkon.no", phone: "951 98 426", parentId: "ole" },
    { id: "svein", name: "Svein Arne Bjørkheim", title: "Avdelingsleder RIBr", email: "sab@byggkon.no", phone: "954 24 989", parentId: "ole" },
    { id: "morteng", name: "Morten Grimen", title: "RIBr", email: "mg@byggkon.no", phone: "", parentId: "svein" },
    { id: "anders", name: "Anders Midbrød", title: "Andre rådgivende fag", email: "am@byggkon.no", phone: "404 97 160", parentId: "ole" },
    { id: "frode", name: "Frode Fiksdal", title: "AI-prosjekter, RIBtre", email: "ff@byggkon.no", phone: "977 54 977", parentId: "ole" },
  ];
}

let cached = null;

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Hele konfigurasjonen (fil over miljøvariabler over defaults).
export function getConfig() {
  if (!cached) {
    const file = readFile();
    const merged = { ...defaults() };
    // Bare ikke-tomme felter fra fila overstyrer.
    for (const [k, v] of Object.entries(file)) {
      if (v !== undefined && v !== null && v !== "") merged[k] = v;
    }
    cached = merged;
  }
  return cached;
}

// Lagrer endrede felter. Tomme strenger ignoreres (sletter ikke eksisterende
// tokens/passord hvis feltet står tomt i skjemaet).
export function saveConfig(partial) {
  const current = { ...readFile() };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    current[k] = v;
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2));
  cached = null; // tving ny innlasting
  return getConfig();
}

// Trygg versjon for visning i admin-UI: maskerer hemmeligheter.
export function getConfigForAdmin() {
  const c = getConfig();
  return {
    companyName: c.companyName,
    heroImageUrl: c.heroImageUrl,
    hasMcpUrl: Boolean(c.regnskapsagentMcpUrl),
    hasDashboardPassword: Boolean(c.dashboardPassword),
    weeklyCapacityHours: c.weeklyCapacityHours,
    cacheTtlMs: c.cacheTtlMs,
    refreshSeconds: c.refreshSeconds,
    settingsPath: SETTINGS_PATH,
  };
}

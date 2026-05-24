// Lagring og uthenting av innstillinger.
// Verdier kan settes via admin-siden (lagres i en JSON-fil) eller via
// miljøvariabler. Filen vinner over miljøvariabler når den finnes.
//
// På Railway er filsystemet flyktig mellom deployer. Sett SETTINGS_PATH til en
// montert Volume (f.eks. /data/settings.json) for at innstillinger skal være
// permanente. Se README.
import fs from "fs";
import path from "path";

export const SETTINGS_PATH =
  process.env.SETTINGS_PATH || path.join(process.cwd(), "data", "settings.json");

// Standard hentes fra miljøvariabler (eller fornuftige defaults).
function defaults() {
  return {
    companyName: process.env.COMPANY_NAME || "BYGG-KON",
    heroImageUrl:
      process.env.HERO_IMAGE_URL ||
      "https://cdn.prod.website-files.com/6971dca24ade29a12176f9bf/69bd3f133cccc0a691865253_Travbaneveien3-8.jpg",
    tripletexBaseUrl: process.env.TRIPLETEX_BASE_URL || "https://tripletex.no/v2",
    tripletexConsumerToken: process.env.TRIPLETEX_CONSUMER_TOKEN || "",
    tripletexEmployeeToken: process.env.TRIPLETEX_EMPLOYEE_TOKEN || "",
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "byggkon",
    weeklyCapacityHours: Number(process.env.WEEKLY_CAPACITY_HOURS || 37.5),
    cacheTtlMs: Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000),
    refreshSeconds: Number(process.env.REFRESH_SECONDS || 60),
  };
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
    tripletexBaseUrl: c.tripletexBaseUrl,
    hasConsumerToken: Boolean(c.tripletexConsumerToken),
    hasEmployeeToken: Boolean(c.tripletexEmployeeToken),
    hasDashboardPassword: Boolean(c.dashboardPassword),
    weeklyCapacityHours: c.weeklyCapacityHours,
    cacheTtlMs: c.cacheTtlMs,
    refreshSeconds: c.refreshSeconds,
    settingsPath: SETTINGS_PATH,
  };
}

import "dotenv/config"; // leser en lokal .env-fil hvis den finnes (ignoreres på Railway)
import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { buildEconomy } from "./src/economy.js";
import { getNewsFeed } from "./src/newsfeed.js";
import { clearCache, resetClient, getInvoices, getCustomers, getSupplierInvoices, getSupplierInvoiceDetails, getProjects, getProjectAddresses, getTimeEntries, getEmployees, ymd } from "./src/tripletex.js";
import { geocodeOne, sleep } from "./src/geocode.js";
import { serveWithSnapshot, expireSnapshots } from "./src/snapshot.js";
const snapTtl = () => getConfig().cacheTtlMs || 300000;
import { getConfig, saveConfig, getConfigForAdmin, SETTINGS_PATH } from "./src/settings.js";

// Mappe for opplastede filer (ved siden av innstillingsfila – legg på Volume på Railway).
const UPLOAD_DIR = path.join(path.dirname(SETTINGS_PATH), "uploads");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Admin-passordet er en bootstrap-hemmelighet som settes som miljøvariabel
// (ikke redigerbart fra UI). Alt annet styres fra admin-siden.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin-bytt-meg";
const SESSION_SECRET = process.env.SESSION_SECRET || "bytt-meg-til-en-lang-tilfeldig-streng";

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "15mb" })); // rom for opplastede bilder (base64)
app.use(
  cookieSession({
    name: "bk_session",
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

// Opplastede filer (krever innlogging – samme cookie som dashbordet)
app.use("/uploads", (req, res, next) => requireAuth(req, res, next), express.static(UPLOAD_DIR));

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Ikke innlogget" });
  return res.redirect("/login");
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Krever admin" });
  return res.redirect("/admin/login");
}

// ---- Ansatt-innlogging ----
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.post("/login", (req, res) => {
  if ((req.body?.password || "") === getConfig().dashboardPassword) {
    req.session.loggedIn = true;
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});
app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

// ---- Admin-innlogging ----
app.get("/admin/login", (req, res) => res.sendFile(path.join(__dirname, "views", "admin-login.html")));
app.post("/admin/login", (req, res) => {
  if ((req.body?.password || "") === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.loggedIn = true; // admin ser også dashbordet
    return res.redirect("/admin");
  }
  res.redirect("/admin/login?error=1");
});
app.get("/admin", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "views", "admin.html"))
);

// ---- Admin-API ----
app.get("/api/admin/settings", requireAdmin, (req, res) => res.json(getConfigForAdmin()));

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  try {
    const allowed = [
      "companyName",
      "heroImageUrl",
      "regnskapsagentMcpUrl",
      "dashboardPassword",
      "weeklyCapacityHours",
      "cacheTtlMs",
      "refreshSeconds",
      "companyOrgNr",
      "companyAddress",
      "companyEmail",
      "companyPhone",
      "companyWebsite",
    ];
    const partial = {};
    for (const k of allowed) {
      if (k in (req.body || {})) {
        let v = req.body[k];
        if (["weeklyCapacityHours", "cacheTtlMs", "refreshSeconds"].includes(k)) {
          v = v === "" || v === null ? "" : Number(v);
        }
        partial[k] = v;
      }
    }
    // Valider MCP-URL: må være en faktisk http(s)-adresse (ikke f.eks. et passord)
    if (partial.regnskapsagentMcpUrl !== undefined && !/^https?:\/\//i.test(partial.regnskapsagentMcpUrl)) {
      return res.status(400).json({ error: "Regnskapsagent MCP-URL må starte med https:// — lim inn hele URL-en fra Regnskapsagent, ikke et passord." });
    }
    // Verdier (array) lagres direkte hvis sendt
    if (Array.isArray(req.body?.values)) {
      partial.values = req.body.values
        .filter((x) => x && (x.letter || x.text))
        .map((x) => ({ letter: String(x.letter || "").slice(0, 3), text: String(x.text || "") }));
    }
    // Avdelinger (liste av navn)
    if (Array.isArray(req.body?.departments)) {
      partial.departments = req.body.departments.map((d) => String(d || "").trim()).filter(Boolean);
    }
    // MCP-servere (navn + url). Url må være http(s).
    if (Array.isArray(req.body?.mcpServers)) {
      partial.mcpServers = req.body.mcpServers
        .map((m) => ({ name: String(m.name || "").slice(0, 60).trim(), url: String(m.url || "").slice(0, 500).trim() }))
        .filter((m) => m.name && /^https?:\/\//i.test(m.url));
    }
    saveConfig(partial);
    resetClient(); // ny token + tøm cache slik at nye nøkler tas i bruk
    res.json({ ok: true, settings: getConfigForAdmin() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Dashboard-API ----
app.get("/api/overview", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("overview", () => buildOverview(), snapTtl()));
  } catch (err) {
    console.error("Feil i /api/overview:", err.message);
    res.status(502).json({ error: err.message });
  }
});
// ---- Kostnader per leverandør (siste 12 mnd, fra Tripletex) ----
// Ekskluder lønn-/skatte-relaterte oppføringer (ikke faktiske leverandørkostnader).
const SALARY_RE = /\b(skatteetaten|skattekontoret|skatt\s|skattetrekk|arbeidsgiveravgift|lønn|lonn|payroll|nav|otp|pensjon\s?innskudd|trygdeavgift)\b/i;
app.get("/api/costs", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("costs", async () => {
      const today = new Date();
      const to = ymd(today);
      const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
      const sis = await getSupplierInvoices(from, to);
      const bySup = new Map();
      let total = 0;
      for (const s of sis) {
        const name = s.supplier?.name || "Ukjent";
        if (SALARY_RE.test(name)) continue; // ingen lønnskostnader skal med
        const id = s.supplier?.id;
        const cost = Math.abs(s.amount || 0);
        const cur = bySup.get(name) || { name, id, cost: 0, count: 0 };
        cur.cost += cost; cur.count += 1; total += cost;
        if (id && !cur.id) cur.id = id;
        bySup.set(name, cur);
      }
      const meta = getConfig().supplierMeta || {};
      // Filtrer bort de som er merket "avsluttet" – men ta dem med i en egen liste
      const all = [...bySup.values()].sort((a, b) => b.cost - a.cost);
      const suppliers = all.filter((s) => !(meta[s.name] && meta[s.name].terminated));
      const terminated = all.filter((s) => meta[s.name] && meta[s.name].terminated);
      return { suppliers, terminated, total };
    }, snapTtl()));
  } catch (err) {
    console.error("Feil i /api/costs:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Detalj for én leverandør: alle fakturaer siste 12 mnd med tilgjengelige felt.
app.get("/api/supplier-detail", requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler navn" });
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const allSi = await getSupplierInvoices(from, to);
    const matches = allSi.filter((s) => (s.supplier?.name || "") === name);
    if (!matches.length) return res.json({ name, invoices: [] });
    const supplierId = matches.find((m) => m.supplier?.id)?.supplier?.id;
    let rows = matches.map((r) => ({ id: r.id, invoiceDate: r.invoiceDate || "", amount: Math.abs(r.amount || 0) }));
    if (supplierId) {
      // Full info når mulig
      const details = await getSupplierInvoiceDetails(supplierId, from, to);
      if (details.length) {
        rows = details.map((r) => ({
          id: r.id,
          invoiceNumber: r.invoiceNumber || r.kid || "",
          invoiceDate: r.invoiceDate || "",
          dueDate: r.invoiceDueDate || r.dueDate || "",
          amount: Math.abs(r.amount || r.amountCurrency || 0),
          currency: r.currency || "NOK",
          comment: r.comment || r.description || r.title || "",
          voucherNumber: r.voucher?.number || "",
          status: r.status || "",
        }));
      }
    }
    rows.sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || ""));
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
    res.json({ name, supplierId, invoices: rows, total });
  } catch (err) {
    console.error("Feil i /api/supplier-detail:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Markedsføring: full kontaktliste (alle kunder fra Tripletex, all tilgjengelig data).
app.get("/api/marketing-contacts", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("marketing-contacts", async () => {
      const custList = await getCustomers();
      const contacts = custList.map((c) => ({
        kilde: "Tripletex",
        navn: c.name || "",
        epost: c.email || "",
        fakturaEpost: c.invoiceEmail || "",
        telefon: c.phoneNumber || "",
      })).sort((a, b) => a.navn.localeCompare(b.navn, "nb"));
      const lokiConfigured = (getConfig().mcpServers || []).some((m) => /loki/i.test(m.name));
      return { updatedAt: new Date().toISOString(), contacts, lokiConfigured };
    }, snapTtl()));
  } catch (err) {
    console.error("Feil i /api/marketing-contacts:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// IT-relaterte leverandørkostnader (ekte data fra Tripletex, siste 12 mnd).
const IT_SUPPLIER_RE = /microsoft|office\s?365|azure|adobe|autodesk|revit|autocad|google|openai|chatgpt|anthropic|claude|atlassian|jira|slack|dropbox|github|gitlab|1password|fokus|statcon|sletten|mercell|prosjektagent|holte|norsk\s?prisbok|byggforsk|standard\s?online|fireflies|fyxer|n8n|webflow|nextify|nova|phonero|telenor|telia|\bice\b|altibox|remarkable|domene|itrelasjon|it relasjon|linkedin/i;
app.get("/api/it-costs", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("it-costs", async () => {
      const today = new Date();
      const to = ymd(today);
      const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
      const sis = await getSupplierInvoices(from, to);
      const bySup = new Map();
      let total = 0;
      for (const s of sis) {
        const name = s.supplier?.name || "Ukjent";
        if (!IT_SUPPLIER_RE.test(name)) continue;
        const cost = Math.abs(s.amount || 0);
        const cur = bySup.get(name) || { name, cost: 0, count: 0 };
        cur.cost += cost; cur.count += 1; total += cost;
        bySup.set(name, cur);
      }
      const suppliers = [...bySup.values()].sort((a, b) => b.cost - a.cost);
      return { suppliers, total };
    }, snapTtl()));
  } catch (err) {
    console.error("Feil i /api/it-costs:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Driftssentral: aktive prosjekter siste 8 uker + geokodede posisjoner til kart.
app.get("/api/driftssentral", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getTime() - 56 * 24 * 3600 * 1000)); // 8 uker
    const [projects, time, addrMap] = await Promise.all([
      getProjects().catch(() => []),
      getTimeEntries(from, to).catch(() => []),
      getProjectAddresses().catch(() => new Map()),
    ]);
    const pMeta = new Map(projects.map((p) => [p.id, p]));
    const agg = new Map();
    for (const e of time) {
      if (!e.project) continue;
      const id = e.project.id;
      const cur = agg.get(id) || { id, name: e.project.name || pMeta.get(id)?.name || `Prosjekt ${id}`, hours: 0, last: "" };
      cur.hours += e.hours || 0;
      if (e.date > cur.last) cur.last = e.date;
      agg.set(id, cur);
    }
    let list = [...agg.values()].filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours).map((p) => {
      const m = pMeta.get(p.id);
      return { id: p.id, number: m?.number || "", name: p.name, customer: m?.customer?.name || "", hours: Math.round(p.hours * 10) / 10, last: p.last };
    });

    // ---- Geokoding: adresse (best) -> renset prosjektnavn -> kunde -> gjett (kontoret) ----
    // Koordinater lagres per prosjekt på server (proj) så de kommer opp umiddelbart.
    const gc = getConfig().geocache || {};
    const projCache = { ...(gc.proj || {}) };   // prosjekt-id -> { lat, lon, exact }
    const qCache = { ...(gc.q || {}) };          // søketekst -> coord | null
    const OFFICE = { lat: 58.9700, lon: 5.7331 }; // Stavanger – gjett når usikker
    const GENERIC = /\b(nybygg|ombygging|rehabilitering|rehab|tilbygg|prosjektering|prosjekt|rammeavtale|byggetrinn|trinn\s*\d+|utvidelse|riving|riv|totalentreprise|forprosjekt|skisseprosjekt|RIB|RIBr|ARK|RIV|RIE|diverse|intern)\b/gi;
    const nameQuery = (name) => String(name || "").replace(/^\s*\d+[\s.\-:]*/, "").replace(GENERIC, " ").replace(/\s+/g, " ").trim();
    const jitter = (s) => { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h % 1000) / 1000 - 0.5) * 0.06; };
    let added = 0; const BUDGET = 8; let changed = false;
    async function geocodeQ(q) {
      if (!q) return null;
      if (q in qCache) return qCache[q];          // allerede forsøkt (coord eller null)
      if (added >= BUDGET) return undefined;      // budsjett brukt opp – neste runde
      const g = await geocodeOne(q);
      added++; await sleep(1100);
      qCache[q] = g || null; changed = true;
      return qCache[q];
    }
    let pending = false;
    for (const p of list) {
      const saved = projCache[p.id];
      if (saved && saved.exact) { p.lat = saved.lat; p.lon = saved.lon; p.approx = false; continue; }
      const cands = [];
      if (addrMap.get(p.id)) cands.push(addrMap.get(p.id) + ", Norge");
      const nm = nameQuery(p.name); if (nm && nm.length > 2) cands.push(nm + ", Norge");
      if (p.customer) cands.push(p.customer + ", Norge");
      let coord = null, allTried = true;
      for (const q of cands) {
        const r = await geocodeQ(q);
        if (r === undefined) { allTried = false; break; }
        if (r) { coord = r; break; }
      }
      if (coord) {
        p.lat = coord.lat; p.lon = coord.lon; p.approx = false;
        projCache[p.id] = { lat: coord.lat, lon: coord.lon, exact: true }; changed = true;
      } else {
        // Vis alltid en pin – gjett (omtrentlig) ved kontoret
        p.lat = OFFICE.lat + jitter(p.id); p.lon = OFFICE.lon + jitter(p.name); p.approx = true;
        if (!allTried) pending = true; // budsjett oppbrukt – forfines i neste runde
      }
    }
    if (changed) saveConfig({ geocache: { proj: projCache, q: qCache } });
    res.json({ updatedAt: new Date().toISOString(), projects: list, pending });
  } catch (err) {
    console.error("Feil i /api/driftssentral:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Live status for AI-agentene (sjekker at sidene svarer) ----
// check:true => sjekkes live mot adressen. check:false => antas operativ (alltid grønn).
const STATUS_AGENTS = [
  { key: "loki", name: "Loki AI", url: "https://byggkon-loki-ai-production.up.railway.app/", check: true },
  { key: "nova", name: "Nova AI", url: "https://nova-ai-agent-bygg-kon-production.up.railway.app/", check: true },
  { key: "regnskap", name: "Regnskapsagent", url: "", check: false },
  { key: "hilde", name: "Hilde (eiendom)", url: "https://byggkon.bluemint.dev", check: false },
];
let agentStatusCache = { ts: 0, agents: [] };
app.get("/api/agent-status", requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (now - agentStatusCache.ts < 20000 && agentStatusCache.agents.length) {
      return res.json({ agents: agentStatusCache.agents, cached: true });
    }
    const agents = await Promise.all(STATUS_AGENTS.map(async (a) => {
      if (!a.check) return { key: a.key, name: a.name, url: a.url, up: true };
      try {
        const r = await fetch(a.url, { method: "GET", signal: AbortSignal.timeout(6000) });
        return { key: a.key, name: a.name, url: a.url, up: r.status < 500 };
      } catch {
        return { key: a.key, name: a.name, url: a.url, up: false };
      }
    }));
    agentStatusCache = { ts: now, agents };
    res.json({ agents });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/news-feed", requireAuth, async (req, res) => {
  try {
    res.json({ items: await getNewsFeed() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- AI-rapport (LLM) ----
app.post("/api/report", requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").slice(0, 4000);
    if (!prompt) return res.status(400).json({ error: "Beskriv hva slags rapport du vil ha." });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
    if (!apiKey) return res.status(400).json({ error: "AI-rapporter er ikke aktivert ennå. Legg inn ANTHROPIC_API_KEY (og evt. ANTHROPIC_MODEL) i Railway → Variables." });
    // Hent litt systemkontekst så rapporten blir konkret
    let ctx = {};
    try {
      const [ov, ec] = await Promise.all([buildOverview(), buildEconomy()]);
      ctx = {
        kpis: ov.kpis,
        resultatIÅr: ec.resultYTD, resultatLTM: ec.resultLTM, balanse: ec.balance,
        likviditet: ec.liquidity, faktureringsgrad3mnd: ec.billing3m && ec.billing3m.total,
        toppProsjekter: (ov.projectsDetailed || []).slice(0, 8).map((p) => ({ navn: p.name, timer4uker: p.hours4w })),
      };
    } catch {}
    const body = {
      model, max_tokens: 1800,
      system: "Du er en rapportassistent for byggefirmaet Bygg-Kon AS. Lag en ryddig, kortfattet rapport på norsk basert på brukerens ønske og de medfølgende systemtallene. Bruk tydelige overskrifter og punktlister. Hvis data mangler for noe brukeren ber om, si det kort.",
      messages: [{ role: "user", content: `Ønsket rapport: ${prompt}\n\nTilgjengelige systemtall (JSON):\n${JSON.stringify(ctx)}` }],
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: j.error?.message || `AI-kall feilet (${r.status})` });
    const text = (j.content || []).map((c) => c.text || "").join("\n");
    res.json({ report: text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/economy", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("economy", () => buildEconomy(), snapTtl()));
  } catch (err) {
    console.error("Feil i /api/economy:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Beste kunder siste 12 måneder ----
app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("customers", async () => {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const [invoices, custList, projects, timeEntries] = await Promise.all([
      getInvoices(from, to),
      getCustomers().catch(() => []),
      getProjects().catch(() => []),
      getTimeEntries(from, to).catch(() => []),
    ]);
    const custById = new Map(custList.map((c) => [c.id, c]));
    // Prosjekt -> { kunde-id, prosjektleder-navn }
    const projMeta = new Map();
    for (const p of projects) {
      const pm = p.projectManager ? `${p.projectManager.firstName || ""} ${p.projectManager.lastName || ""}`.trim() : "";
      projMeta.set(p.id, { custId: p.customer?.id, pm });
    }
    // Timer per kunde per prosjektleder -> finn den som jobber mest mot kunden
    const custPmHours = new Map(); // custId -> Map(pm -> hours)
    for (const e of timeEntries) {
      const meta = projMeta.get(e.project?.id);
      if (!meta || meta.custId == null || !meta.pm) continue;
      const m = custPmHours.get(meta.custId) || new Map();
      m.set(meta.pm, (m.get(meta.pm) || 0) + (e.hours || 0));
      custPmHours.set(meta.custId, m);
    }
    const topPm = (custId) => {
      const m = custPmHours.get(custId);
      if (!m) return "";
      let best = "", bh = 0;
      for (const [k, v] of m) if (v > bh) { bh = v; best = k; }
      return best;
    };
    const byCust = new Map();
    for (const i of invoices) {
      const id = i.customer?.id ?? i.customer?.name ?? "ukjent";
      const cur = byCust.get(id) || { id, name: i.customer?.name || "Ukjent", revenue: 0, invoices: 0 };
      cur.revenue += i.amount || 0;
      cur.invoices += 1;
      byCust.set(id, cur);
    }
    const customers = [...byCust.values()].map((c) => {
      const info = custById.get(c.id) || {};
      return { name: c.name, revenue: c.revenue, invoices: c.invoices, email: info.email || info.invoiceEmail || "", phone: info.phoneNumber || "", topProjectManager: topPm(c.id) };
    }).sort((a, b) => b.revenue - a.revenue);
    return { updatedAt: new Date().toISOString(), customers };
    }, snapTtl()));
  } catch (err) {
    console.error("Feil i /api/customers:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/refresh", requireAuth, (req, res) => {
  clearCache();
  expireSnapshots();
  res.json({ ok: true });
});

// ---- Firmalogo (admin laster opp, vises i toppen) ----
app.post("/api/admin/upload-logo", requireAdmin, (req, res) => {
  try {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig bilde. Last opp PNG, JPG, WEBP, GIF eller SVG." });
    const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: "Logoen er for stor (maks 4 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const e of ["png", "jpg", "webp", "gif", "svg"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `logo.${e}`)); } catch {} }
    fs.writeFileSync(path.join(UPLOAD_DIR, `logo.${ext}`), buf);
    const logoUrl = "/uploads/logo." + ext + "?v=" + Date.now();
    saveConfig({ logoUrl });
    res.json({ ok: true, logoUrl });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- HR / plantegninger (flere kontorer) med ansatt-pins ----
app.get("/api/hr", requireAuth, (req, res) => {
  res.json({ floorplans: getConfig().floorplans || [] });
});
app.post("/api/hr", requireAuth, (req, res) => {
  try {
    const fps = Array.isArray(req.body?.floorplans) ? req.body.floorplans : null;
    if (!fps) return res.status(400).json({ error: "Mangler floorplans-liste" });
    const clean = fps.map((p) => ({
      id: String(p.id || "").slice(0, 40),
      name: String(p.name || "").slice(0, 80),
      url: String(p.url || "").slice(0, 500),
      pins: Array.isArray(p.pins) ? p.pins.map((pn) => ({
        name: String(pn.name || "").slice(0, 80),
        x: Math.max(0, Math.min(100, Number(pn.x) || 0)),
        y: Math.max(0, Math.min(100, Number(pn.y) || 0)),
      })) : [],
    }));
    saveConfig({ floorplans: clean });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Opplasting av plantegning for et kontor (base64). Innlogget ansatt kan laste opp.
app.post("/api/hr/upload", requireAuth, (req, res) => {
  try {
    const planId = String(req.body?.planId || "plan");
    const m = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig bilde. Last opp PNG, JPG, WEBP, GIF eller SVG." });
    const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: "Bildet er for stort (maks 12 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = planId.replace(/[^a-z0-9_-]/gi, "") || "plan";
    for (const e of ["png", "jpg", "webp", "gif", "svg"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `floorplan-${safe}.${e}`)); } catch {} }
    const fname = `floorplan-${safe}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    const url = "/uploads/" + fname + "?v=" + Date.now();
    const fps = (getConfig().floorplans || []).map((p) => (p.id === planId ? { ...p, url } : p));
    saveConfig({ floorplans: fps });
    res.json({ ok: true, planId, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Tilbud-status (sendt / vunnet / tapt) ----
app.get("/api/tilbud", requireAuth, (req, res) => res.json(getConfig().tilbud || { sendt: 0, vunnet: 0, tapt: 0 }));
app.post("/api/tilbud", requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    saveConfig({ tilbud: { sendt: Math.max(0, Number(b.sendt) || 0), vunnet: Math.max(0, Number(b.vunnet) || 0), tapt: Math.max(0, Number(b.tapt) || 0) } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Intern kommunikasjon (felles meldingsvegg) ----
app.get("/api/messages", requireAuth, (req, res) => {
  res.json({ messages: (getConfig().messages || []).slice(-100) });
});
app.post("/api/messages", requireAuth, (req, res) => {
  try {
    const name = String(req.body?.name || "").slice(0, 60) || "Anonym";
    const text = String(req.body?.text || "").trim().slice(0, 800);
    if (!text) return res.status(400).json({ error: "Tom melding" });
    const msgs = (getConfig().messages || []).slice(-199);
    msgs.push({ name, text, ts: Date.now() });
    saveConfig({ messages: msgs });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Nyheter internt ----
app.get("/api/news", requireAuth, (req, res) => res.json({ news: getConfig().news || [] }));
app.post("/api/news", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.news) ? req.body.news : null;
    if (!list) return res.status(400).json({ error: "Mangler news-liste" });
    const clean = list.map((n) => ({ date: String(n.date || "").slice(0, 10), text: String(n.text || "").slice(0, 2000) }));
    saveConfig({ news: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Felles kalender (alle innloggede kan legge inn) ----
app.get("/api/calendar", requireAuth, (req, res) => {
  res.json({ events: getConfig().calendar || [] });
});
app.post("/api/calendar", requireAuth, (req, res) => {
  try {
    const date = String(req.body?.date || "").slice(0, 10);
    const title = String(req.body?.title || "").trim().slice(0, 200);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Ugyldig dato" });
    if (!title) return res.status(400).json({ error: "Tittel mangler" });
    const allowed = ["bursdag", "oppstart", "mote", "frist", "annet"];
    let type = String(req.body?.type || "annet");
    if (!allowed.includes(type)) type = "annet";
    const by = String(req.body?.by || "").trim().slice(0, 60);
    const ev = { id: "c" + Date.now().toString(36) + Math.floor(Math.random() * 1000), date, title, type, by, ts: Date.now() };
    const list = (getConfig().calendar || []).slice(-499);
    list.push(ev);
    saveConfig({ calendar: list });
    res.json({ ok: true, event: ev });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/calendar/delete", requireAuth, (req, res) => {
  try {
    const id = String(req.body?.id || "");
    if (!id) return res.status(400).json({ error: "Mangler id" });
    const list = (getConfig().calendar || []).filter((e) => e.id !== id);
    saveConfig({ calendar: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Prosjektnotater (viktige notater per prosjekt) ----
app.get("/api/projectnotes", requireAuth, (req, res) => res.json({ notes: getConfig().projectNotes || {} }));
app.post("/api/projectnotes", requireAuth, (req, res) => {
  try {
    const number = String(req.body?.number || "").slice(0, 40);
    if (!number) return res.status(400).json({ error: "Mangler prosjektnummer" });
    const note = String(req.body?.note || "").slice(0, 1000);
    const notes = { ...(getConfig().projectNotes || {}) };
    if (note) notes[number] = note; else delete notes[number];
    saveConfig({ projectNotes: notes });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Leverandør-meta (rammeavtale + forhandlingsansvarlig) ----
app.get("/api/suppliermeta", requireAuth, (req, res) => res.json({ meta: getConfig().supplierMeta || {} }));
app.post("/api/suppliermeta", requireAuth, (req, res) => {
  try {
    const name = String(req.body?.name || "").slice(0, 120);
    if (!name) return res.status(400).json({ error: "Mangler leverandørnavn" });
    const meta = { ...(getConfig().supplierMeta || {}) };
    meta[name] = {
      rammeavtale: !!req.body?.rammeavtale,
      ansvarlig: String(req.body?.ansvarlig || "").slice(0, 80),
      status: String(req.body?.status || "").slice(0, 120),
      terminated: !!req.body?.terminated,
    };
    saveConfig({ supplierMeta: meta });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Ansattes rollebeskrivelser ----
app.get("/api/roledescriptions", requireAuth, (req, res) => res.json({ roles: getConfig().roleDescriptions || [] }));
app.post("/api/roledescriptions", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.roles) ? req.body.roles : null;
    if (!list) return res.status(400).json({ error: "Mangler roles-liste" });
    const clean = list.map((r) => ({ name: String(r.name || "").slice(0, 80), role: String(r.role || "").slice(0, 120), description: String(r.description || "").slice(0, 4000), photo: String(r.photo || "").slice(0, 500) }));
    saveConfig({ roleDescriptions: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Last opp bilde av ansatt (brukes ved rollebeskrivelsen). Returnerer url.
app.post("/api/roles/upload", requireAuth, (req, res) => {
  try {
    const idRaw = String(req.body?.id || "ansatt");
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig bilde. Last opp PNG, JPG, WEBP eller GIF." });
    const ext = m[1].toLowerCase().replace("jpeg", "jpg");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Bildet er for stort (maks 8 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = idRaw.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "ansatt";
    for (const e of ["png", "jpg", "webp", "gif"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `emp-${safe}.${e}`)); } catch {} }
    const fname = `emp-${safe}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    res.json({ ok: true, url: "/uploads/" + fname + "?v=" + Date.now() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Potensielle kunder (leads) ----
app.get("/api/leads", requireAuth, (req, res) => res.json({ leads: getConfig().leads || [] }));
app.post("/api/leads", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.leads) ? req.body.leads : null;
    if (!list) return res.status(400).json({ error: "Mangler leads-liste" });
    const clean = list.map((l) => ({ name: String(l.name || "").slice(0, 120), contact: String(l.contact || "").slice(0, 160), note: String(l.note || "").slice(0, 600), by: String(l.by || "").slice(0, 60) }));
    saveConfig({ leads: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- HR-forespørsler (praktiske behov) ----
app.get("/api/hrrequests", requireAuth, (req, res) => res.json({ requests: (getConfig().hrRequests || []).slice(-200) }));
app.post("/api/hrrequests", requireAuth, (req, res) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: "Tom forespørsel" });
    const by = String(req.body?.by || "").trim().slice(0, 60);
    const list = (getConfig().hrRequests || []).slice(-199);
    list.push({ id: "r" + Date.now().toString(36), text, by, ts: Date.now(), done: false });
    saveConfig({ hrRequests: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/hrrequests/update", requireAuth, (req, res) => {
  try {
    const id = String(req.body?.id || "");
    const action = String(req.body?.action || "");
    let list = getConfig().hrRequests || [];
    if (action === "delete") list = list.filter((r) => r.id !== id);
    else if (action === "toggle") list = list.map((r) => (r.id === id ? { ...r, done: !r.done } : r));
    saveConfig({ hrRequests: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Intensjonsavtaler (selskaper vi samarbeider med) ----
app.get("/api/intentions", requireAuth, (req, res) => res.json({ intentions: getConfig().intentions || [] }));
app.post("/api/intentions", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.intentions) ? req.body.intentions : null;
    if (!list) return res.status(400).json({ error: "Mangler intentions-liste" });
    const clean = list.map((x) => ({
      company: String(x.company || "").slice(0, 120),
      contact: String(x.contact || "").slice(0, 120),
      type: String(x.type || "").slice(0, 120),
      status: String(x.status || "").slice(0, 60),
      date: String(x.date || "").slice(0, 10),
      note: String(x.note || "").slice(0, 1000),
    }));
    saveConfig({ intentions: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Pårørende per ansatt (HR) ----
app.get("/api/nextofkin", requireAuth, (req, res) => res.json({ nextOfKin: getConfig().nextOfKin || [] }));
app.post("/api/nextofkin", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.nextOfKin) ? req.body.nextOfKin : null;
    if (!list) return res.status(400).json({ error: "Mangler nextOfKin-liste" });
    const clean = list.map((x) => ({
      employee: String(x.employee || "").slice(0, 80),
      kinName: String(x.kinName || "").slice(0, 80),
      relation: String(x.relation || "").slice(0, 60),
      phone: String(x.phone || "").slice(0, 40),
      note: String(x.note || "").slice(0, 400),
    }));
    saveConfig({ nextOfKin: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- HR-dokumenter (forsikring, sentralgodkjenning, relevante) ----
app.get("/api/hrdocfiles", requireAuth, (req, res) => res.json({ docs: getConfig().hrDocs || [] }));
app.post("/api/hrdocfiles", requireAuth, (req, res) => {
  try {
    const title = String(req.body?.title || "Dokument").slice(0, 160);
    const category = String(req.body?.category || "Annet").slice(0, 60);
    const revision = String(req.body?.revision || "").slice(0, 10);
    const m = /^data:(application\/pdf|image\/(png|jpeg|jpg|webp));base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig fil. Last opp PDF eller PNG/JPG." });
    const ext = m[1].toLowerCase().includes("pdf") ? "pdf" : m[2].toLowerCase().replace("jpeg", "jpg");
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 14 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 14 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const id = "doc" + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const fname = `${id}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    const list = (getConfig().hrDocs || []).slice(-199);
    list.push({ id, title, category, revision, url: "/uploads/" + fname, uploadedAt: new Date().toISOString().slice(0, 10) });
    saveConfig({ hrDocs: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/hrdocfiles/delete", requireAuth, (req, res) => {
  try {
    const id = String(req.body?.id || "");
    saveConfig({ hrDocs: (getConfig().hrDocs || []).filter((d) => d.id !== id) });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Visjon / felles målsetning ----
app.get("/api/vision", requireAuth, (req, res) => res.json({ vision: getConfig().vision || "" }));
app.post("/api/vision", requireAuth, (req, res) => {
  try { saveConfig({ vision: String(req.body?.vision || "").slice(0, 8000) }); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- KI: forslag fra ansatte ----
function enrichSug(s) {
  const votes = s.votes || {};
  const vals = Object.values(votes).filter((v) => v >= 1 && v <= 6);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  return { ...s, votes, voteAvg: avg, voteCount: vals.length };
}
app.get("/api/kisuggestions", requireAuth, (req, res) => {
  const list = (getConfig().kiSuggestions || []).slice(-100).map(enrichSug);
  res.json({ suggestions: list });
});
app.post("/api/kisuggestions", requireAuth, (req, res) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: "Tomt forslag" });
    const by = String(req.body?.by || "").trim().slice(0, 60);
    const list = (getConfig().kiSuggestions || []).slice(-99);
    list.push({ id: "k" + Date.now().toString(36), text, by, ts: Date.now(), importance: "Middels", production: "Idé", sellable: "Nei", votes: {} });
    saveConfig({ kiSuggestions: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Terningkast – én stemme per navn (overskrives ved ny stemme).
app.post("/api/kisuggestions/vote", requireAuth, (req, res) => {
  try {
    const id = String(req.body?.id || "");
    const by = String(req.body?.by || "").trim().slice(0, 60) || "Anonym";
    const value = Math.max(1, Math.min(6, Number(req.body?.value) || 0));
    if (!id || !value) return res.status(400).json({ error: "Mangler id eller verdi 1–6" });
    const list = (getConfig().kiSuggestions || []).map((s) => {
      if (s.id !== id) return s;
      const votes = { ...(s.votes || {}) };
      votes[by] = value;
      return { ...s, votes };
    });
    saveConfig({ kiSuggestions: list });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Full lagring (rediger/ranger alle forslag)
app.post("/api/kisuggestions/save", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.suggestions) ? req.body.suggestions : null;
    if (!list) return res.status(400).json({ error: "Mangler suggestions-liste" });
    const imp = ["Høy", "Middels", "Lav"];
    const prod = ["Idé", "Under utvikling", "Klar", "I produksjon"];
    const sell = ["Ja", "Kanskje", "Nei"];
    const clean = list.map((s) => ({
      id: String(s.id || "k" + Date.now().toString(36) + Math.floor(Math.random() * 1000)),
      text: String(s.text || "").slice(0, 600),
      by: String(s.by || "").slice(0, 60),
      ts: Number(s.ts) || Date.now(),
      importance: imp.includes(s.importance) ? s.importance : "Middels",
      production: prod.includes(s.production) ? s.production : "Idé",
      sellable: sell.includes(s.sellable) ? s.sellable : "Nei",
      votes: (s.votes && typeof s.votes === "object") ? s.votes : {},
    }));
    saveConfig({ kiSuggestions: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/kisuggestions/delete", requireAuth, (req, res) => {
  try {
    const id = String(req.body?.id || "");
    saveConfig({ kiSuggestions: (getConfig().kiSuggestions || []).filter((s) => s.id !== id) });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- KI-agenter: statusoversikt (idé → pågående → testing → operativ) ----
const KI_STATUS = ["idé", "pågående", "testing", "operativ"];
// Gamle statuser migreres til de nye verdiene.
const kiStatusMap = { "ferdig": "operativ", "klar": "operativ", "i produksjon": "operativ", "under utvikling": "pågående" };
const normKiStatus = (s) => { const v = kiStatusMap[String(s || "").toLowerCase()] || s; return KI_STATUS.includes(v) ? v : "idé"; };
app.get("/api/kiagents", requireAuth, (req, res) => {
  const agents = (getConfig().kiAgents || []).map((a) => ({ ...a, status: normKiStatus(a.status) }));
  res.json({ agents });
});
app.post("/api/kiagents", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.agents) ? req.body.agents : null;
    if (!list) return res.status(400).json({ error: "Mangler agents-liste" });
    const clean = list.map((a) => ({
      name: String(a.name || "").slice(0, 80), email: String(a.email || "").slice(0, 120),
      desc: String(a.desc || "").slice(0, 400), status: normKiStatus(a.status),
    }));
    saveConfig({ kiAgents: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Parkering: bilde + pins ----
app.get("/api/parking", requireAuth, (req, res) => res.json({ parking: getConfig().parking || { url: "", pins: [] } }));
app.post("/api/parking", requireAuth, (req, res) => {
  try {
    const p = req.body?.parking || {};
    const clean = {
      url: String(p.url || "").slice(0, 500),
      pins: Array.isArray(p.pins) ? p.pins.map((pn) => ({ name: String(pn.name || "").slice(0, 80), x: Math.max(0, Math.min(100, Number(pn.x) || 0)), y: Math.max(0, Math.min(100, Number(pn.y) || 0)) })) : [],
    };
    saveConfig({ parking: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/parking/upload", requireAuth, (req, res) => {
  try {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig bilde." });
    const ext = m[1].toLowerCase().replace("jpeg", "jpg");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: "Bildet er for stort (maks 12 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const e of ["png", "jpg", "webp", "gif"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `parking.${e}`)); } catch {} }
    fs.writeFileSync(path.join(UPLOAD_DIR, `parking.${ext}`), buf);
    const url = "/uploads/parking." + ext + "?v=" + Date.now();
    const cur = getConfig().parking || { url: "", pins: [] };
    saveConfig({ parking: { ...cur, url } });
    res.json({ ok: true, url });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Personalhåndbok (opplasting + revisjonsdato) ----
app.get("/api/handbook", requireAuth, (req, res) => res.json({ handbook: getConfig().handbook || { url: "", filename: "", revision: "" } }));
app.post("/api/handbook", requireAuth, (req, res) => {
  try {
    const revision = String(req.body?.revision || "").slice(0, 10);
    const filename = String(req.body?.filename || "Personalhåndbok").slice(0, 120);
    const m = /^data:(application\/pdf|image\/(png|jpeg|jpg|webp));base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig fil. Last opp PDF (anbefalt) eller PNG/JPG." });
    const ext = m[1].toLowerCase().includes("pdf") ? "pdf" : m[2].toLowerCase().replace("jpeg", "jpg");
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 14 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 14 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const e of ["pdf", "png", "jpg", "webp"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `handbook.${e}`)); } catch {} }
    fs.writeFileSync(path.join(UPLOAD_DIR, `handbook.${ext}`), buf);
    const url = "/uploads/handbook." + ext + "?v=" + Date.now();
    const handbook = { url, filename, revision };
    saveConfig({ handbook });
    res.json({ ok: true, handbook });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Faglig utviklingsmål 2026 (per ansatt) ----
app.get("/api/devgoals", requireAuth, (req, res) => res.json({ devGoals: getConfig().devGoals || [] }));
app.post("/api/devgoals", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.devGoals) ? req.body.devGoals : null;
    if (!list) return res.status(400).json({ error: "Mangler devGoals-liste" });
    const clean = list.map((g) => ({ name: String(g.name || "").slice(0, 80), goals: String(g.goals || "").slice(0, 4000) }));
    saveConfig({ devGoals: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Ledelse: filer (Likviditetsprognose, Økonomirapport, Resultat, Budsjett) ----
const LED_SLOTS = { likviditet: 1, rapport: 1, resultat: 1, budsjett: 1 };
app.get("/api/ledelse/files", requireAdmin, (req, res) => res.json({ files: getConfig().ledelseFiles || {} }));
app.post("/api/ledelse/file", requireAdmin, (req, res) => {
  try {
    const slot = String(req.body?.slot || "");
    if (!LED_SLOTS[slot]) return res.status(400).json({ error: "Ukjent slot" });
    const revision = String(req.body?.revision || "").slice(0, 10);
    const filename = String(req.body?.filename || "Dokument").slice(0, 160);
    const m = /^data:([^;]+);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig fil." });
    const mime = m[1].toLowerCase();
    const ext = mime.includes("pdf") ? "pdf"
      : mime.includes("spreadsheet") ? "xlsx"
      : mime.includes("presentation") ? "pptx"
      : mime.includes("msword") ? "doc"
      : (filename.split(".").pop() || "bin").toLowerCase().slice(0, 5);
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 16 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 16 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const e of ["pdf", "xlsx", "xls", "pptx", "ppt", "doc", "docx", "csv"]) { try { fs.unlinkSync(path.join(UPLOAD_DIR, `ledelse-${slot}.${e}`)); } catch {} }
    fs.writeFileSync(path.join(UPLOAD_DIR, `ledelse-${slot}.${ext}`), buf);
    const url = "/uploads/ledelse-" + slot + "." + ext + "?v=" + Date.now();
    const files = { ...(getConfig().ledelseFiles || {}) };
    files[slot] = { url, filename, revision, uploadedAt: new Date().toISOString().slice(0, 10) };
    saveConfig({ ledelseFiles: files });
    res.json({ ok: true, file: files[slot] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Ledelse: faktureringsgrad ansatte (utvikling 12 mnd, 3 mnd, 2 uker, 1 uke) ----
app.get("/api/ledelse/billing", requireAdmin, async (req, res) => {
  try {
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    const fromStr = ymd(from); const toStr = ymd(today);
    const [employees, time] = await Promise.all([
      getEmployees().catch(() => []),
      getTimeEntries(fromStr, toStr).catch(() => []),
    ]);
    const empName = new Map(employees.map((e) => [e.id, `${e.firstName || ""} ${e.lastName || ""}`.trim()]));
    // Bygg månedsetiketter (12 mnd)
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      months.push({
        label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
        from: ymd(d), to: ymd(end > today ? today : end),
      });
    }
    // per ansatt: { name, byMonth:[12]{h,b}, last3:{h,b}, last14:{h,b}, last7:{h,b} }
    const empMap = new Map();
    const d14 = new Date(today); d14.setDate(today.getDate() - 14);
    const d7 = new Date(today); d7.setDate(today.getDate() - 7);
    const d90 = new Date(today); d90.setDate(today.getDate() - 90);
    const s14 = ymd(d14), s7 = ymd(d7), s90 = ymd(d90);
    let total14h = 0, total14b = 0, total7h = 0, total7b = 0;
    for (const e of time) {
      const id = e.employee?.id; if (id == null) continue;
      const name = empName.get(id); if (!name) continue;
      let row = empMap.get(id);
      if (!row) { row = { id, name, byMonth: months.map(() => ({ h: 0, b: 0 })), last3: { h: 0, b: 0 }, last14: { h: 0, b: 0 }, last7: { h: 0, b: 0 } }; empMap.set(id, row); }
      const h = e.hours || 0, b = e.chargeableHours || 0;
      const mi = months.findIndex((m) => e.date >= m.from && e.date <= m.to);
      if (mi >= 0) { row.byMonth[mi].h += h; row.byMonth[mi].b += b; }
      if (e.date >= s90) { row.last3.h += h; row.last3.b += b; }
      if (e.date >= s14) { row.last14.h += h; row.last14.b += b; total14h += h; total14b += b; }
      if (e.date >= s7) { row.last7.h += h; row.last7.b += b; total7h += h; total7b += b; }
    }
    // kun ansatte med aktivitet siste 28 dager (=nåværende)
    const s28 = ymd(new Date(today.getTime() - 28 * 86400000));
    const activeIds = new Set();
    for (const e of time) { if (e.date >= s28 && e.employee?.id != null) activeIds.add(e.employee.id); }
    const employeesOut = [...empMap.values()]
      .filter((r) => activeIds.has(r.id))
      .map((r) => ({
        name: r.name,
        trend12: r.byMonth.map((m) => (m.h > 0 ? m.b / m.h : null)),
        last3Rate: r.last3.h > 0 ? r.last3.b / r.last3.h : 0,
        last3Hours: Math.round(r.last3.h),
        last3Billable: Math.round(r.last3.b),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "nb"));
    res.json({
      months: months.map((m) => m.label),
      employees: employeesOut,
      total: {
        last14: { rate: total14h > 0 ? total14b / total14h : 0, hours: Math.round(total14h), billable: Math.round(total14b) },
        last7: { rate: total7h > 0 ? total7b / total7h : 0, hours: Math.round(total7h), billable: Math.round(total7b) },
      },
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ---- Ledelse (kun leder/admin) ----
app.get("/api/ledelse", requireAdmin, (req, res) => {
  res.json({ meetings: getConfig().ledelse?.meetings || [] });
});
app.post("/api/ledelse", requireAdmin, (req, res) => {
  try {
    const meetings = Array.isArray(req.body?.meetings) ? req.body.meetings.map((m) => ({
      id: String(m.id || Date.now()), date: String(m.date || "").slice(0, 10),
      title: String(m.title || "").slice(0, 200), notes: String(m.notes || "").slice(0, 50000),
    })) : (getConfig().ledelse?.meetings || []);
    saveConfig({ ledelse: { meetings } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Markedsføring (redigerbar strategi) ----
app.get("/api/marketing", requireAuth, (req, res) => res.json({ marketing: getConfig().marketing || "" }));
app.post("/api/marketing", requireAuth, (req, res) => {
  try {
    if (typeof req.body?.marketing !== "string") return res.status(400).json({ error: "Mangler tekst" });
    saveConfig({ marketing: req.body.marketing.slice(0, 50000) });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- HR-dokumenter (rekruttering / onboarding) ----
app.get("/api/hrdocs", requireAuth, (req, res) => {
  const c = getConfig();
  res.json({ recruiting: c.hrRecruiting || "", onboarding: c.hrOnboarding || "" });
});
app.post("/api/hrdocs", requireAuth, (req, res) => {
  try {
    const partial = {};
    if (typeof req.body?.recruiting === "string") partial.hrRecruiting = req.body.recruiting.slice(0, 50000);
    if (typeof req.body?.onboarding === "string") partial.hrOnboarding = req.body.onboarding.slice(0, 50000);
    saveConfig(partial);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- CV-er ----
app.get("/api/cvs", requireAuth, (req, res) => res.json({ cvs: getConfig().cvs || [] }));
app.post("/api/cvs", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.cvs) ? req.body.cvs : null;
    if (!list) return res.status(400).json({ error: "Mangler cvs-liste" });
    const clean = list.map((c) => ({
      name: String(c.name || "").slice(0, 120), url: String(c.url || "").slice(0, 500), note: String(c.note || "").slice(0, 300),
    }));
    saveConfig({ cvs: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Prosjektmøter (referater + saker) ----
app.get("/api/prosjektmoter", requireAuth, (req, res) => {
  const f = getConfig().prosjektmoter || { meetings: [], suggestions: [] };
  res.json({ meetings: f.meetings || [], suggestions: f.suggestions || [] });
});
app.post("/api/prosjektmoter", requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const meetings = Array.isArray(b.meetings) ? b.meetings.map((m) => ({
      id: String(m.id || Date.now()), date: String(m.date || "").slice(0, 10),
      title: String(m.title || "").slice(0, 200), notes: String(m.notes || "").slice(0, 20000),
    })) : (getConfig().prosjektmoter?.meetings || []);
    const suggestions = Array.isArray(b.suggestions) ? b.suggestions.map((s) => ({
      text: String(s.text || "").slice(0, 500), by: String(s.by || "").slice(0, 80), date: String(s.date || "").slice(0, 10),
    })) : (getConfig().prosjektmoter?.suggestions || []);
    saveConfig({ prosjektmoter: { meetings, suggestions } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Lisenskostnader ----
app.get("/api/licenses", requireAuth, (req, res) => {
  res.json({ licenses: getConfig().licenses || [] });
});
app.post("/api/licenses", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.licenses) ? req.body.licenses : null;
    if (!list) return res.status(400).json({ error: "Mangler licenses-liste" });
    const clean = list.map((l) => ({
      system: String(l.system || "").slice(0, 120),
      cost: Math.max(0, Number(l.cost) || 0),
      interval: l.interval === "mnd" ? "mnd" : "år",
    }));
    saveConfig({ licenses: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Kontakter fra Tripletex (kunder), alfabetisk ----
app.get("/api/tripletex-contacts", requireAuth, async (req, res) => {
  try {
    const list = await getCustomers();
    const contacts = list
      .map((c) => ({ name: c.name || "", email: c.email || c.invoiceEmail || "", phone: c.phoneNumber || "" }))
      .filter((c) => c.name)
      .sort((a, b) => a.name.localeCompare(b.name, "nb"));
    res.json({ contacts });
  } catch (err) {
    console.error("Feil i /api/tripletex-contacts:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Kontaktpersoner ----
app.get("/api/contacts", requireAuth, (req, res) => {
  res.json({ contacts: getConfig().contacts || [] });
});
app.post("/api/contacts", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
    if (!list) return res.status(400).json({ error: "Mangler contacts-liste" });
    const clean = list.map((c) => ({
      name: String(c.name || "").slice(0, 120),
      role: String(c.role || "").slice(0, 200),
      org: String(c.org || "").slice(0, 120),
      phone: String(c.phone || "").slice(0, 60),
      email: String(c.email || "").slice(0, 120),
      note: String(c.note || "").slice(0, 500),
    }));
    saveConfig({ contacts: clean });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Fagmøter (referater + forslag) ----
app.get("/api/fagmoter", requireAuth, (req, res) => {
  const f = getConfig().fagmoter || { meetings: [], suggestions: [] };
  res.json({ meetings: f.meetings || [], suggestions: f.suggestions || [] });
});
app.post("/api/fagmoter", requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const meetings = Array.isArray(b.meetings) ? b.meetings.map((m) => ({
      id: String(m.id || Date.now()),
      date: String(m.date || "").slice(0, 10),
      title: String(m.title || "").slice(0, 200),
      notes: String(m.notes || "").slice(0, 20000),
    })) : (getConfig().fagmoter?.meetings || []);
    const suggestions = Array.isArray(b.suggestions) ? b.suggestions.map((s) => ({
      text: String(s.text || "").slice(0, 500),
      by: String(s.by || "").slice(0, 80),
      date: String(s.date || "").slice(0, 10),
    })) : (getConfig().fagmoter?.suggestions || []);
    saveConfig({ fagmoter: { meetings, suggestions } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Organisasjonskart (innloggede ansatte kan se og redigere) ----
app.get("/api/org", requireAuth, (req, res) => {
  res.json({ nodes: getConfig().orgChart || [] });
});
// ---- Kompetansematrise (Ansatte-fanen) ----
app.get("/api/competence", requireAuth, (req, res) => {
  res.json(getConfig().competence || { scale: [], groups: [], employees: [] });
});
app.post("/api/competence", requireAuth, (req, res) => {
  try {
    const c = req.body || {};
    if (!Array.isArray(c.groups) || !Array.isArray(c.employees)) {
      return res.status(400).json({ error: "Ugyldig kompetansestruktur" });
    }
    saveConfig({ competence: { scale: c.scale || [], groups: c.groups, employees: c.employees } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/org", requireAuth, (req, res) => {
  try {
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : null;
    if (!nodes) return res.status(400).json({ error: "Mangler nodes-liste" });
    const clean = nodes.map((n) => ({
      id: String(n.id),
      name: String(n.name || ""),
      title: String(n.title || ""),
      email: String(n.email || ""),
      phone: String(n.phone || ""),
      parentId: n.parentId == null ? null : String(n.parentId),
    }));
    saveConfig({ orgChart: clean });
    res.json({ ok: true, count: clean.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---- Statisk frontend (beskyttet) ----
app.use(requireAuth, express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Bygg-Kon dashboard kjører på port ${PORT}`));

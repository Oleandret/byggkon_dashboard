import "dotenv/config"; // leser en lokal .env-fil hvis den finnes (ignoreres på Railway)
import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { buildEconomy } from "./src/economy.js";
import { getNewsFeed } from "./src/newsfeed.js";
import { clearCache, resetClient, getInvoices, getCustomers, getSupplierInvoices, ymd } from "./src/tripletex.js";
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
    res.json(await buildOverview());
  } catch (err) {
    console.error("Feil i /api/overview:", err.message);
    res.status(502).json({ error: err.message });
  }
});
// ---- Kostnader per leverandør (siste 12 mnd, fra Tripletex) ----
app.get("/api/costs", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const sis = await getSupplierInvoices(from, to);
    const bySup = new Map();
    let total = 0;
    for (const s of sis) {
      const name = s.supplier?.name || "Ukjent";
      const cost = Math.abs(s.amount || 0);
      const cur = bySup.get(name) || { name, cost: 0, count: 0 };
      cur.cost += cost; cur.count += 1; total += cost;
      bySup.set(name, cur);
    }
    const suppliers = [...bySup.values()].sort((a, b) => b.cost - a.cost);
    res.json({ suppliers, total });
  } catch (err) {
    console.error("Feil i /api/costs:", err.message);
    res.status(502).json({ error: err.message });
  }
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
    res.json(await buildEconomy());
  } catch (err) {
    console.error("Feil i /api/economy:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Beste kunder siste 12 måneder ----
app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const [invoices, custList] = await Promise.all([getInvoices(from, to), getCustomers().catch(() => [])]);
    const custById = new Map(custList.map((c) => [c.id, c]));
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
      return { name: c.name, revenue: c.revenue, invoices: c.invoices, email: info.email || info.invoiceEmail || "", phone: info.phoneNumber || "" };
    }).sort((a, b) => b.revenue - a.revenue);
    res.json({ updatedAt: new Date().toISOString(), customers });
  } catch (err) {
    console.error("Feil i /api/customers:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/refresh", requireAuth, (req, res) => {
  clearCache();
  res.json({ ok: true });
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

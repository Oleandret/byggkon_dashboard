import "dotenv/config"; // leser en lokal .env-fil hvis den finnes (ignoreres på Railway)
import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { buildEconomy } from "./src/economy.js";
import { clearCache, resetClient, getInvoices, getCustomers, ymd } from "./src/tripletex.js";
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

// Opplasting av plantegning (base64 data-URL). Lagres i UPLOAD_DIR.
app.post("/api/admin/upload-floorplan", requireAdmin, (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl || "";
    const m = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i.exec(dataUrl);
    if (!m) return res.status(400).json({ error: "Ugyldig bilde. Last opp PNG, JPG, WEBP, GIF eller SVG." });
    let ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: "Bildet er for stort (maks 12 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    // Fjern eventuelle gamle plantegninger
    for (const e of ["png", "jpg", "webp", "gif", "svg"]) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, "floorplan." + e)); } catch {}
    }
    const fname = "floorplan." + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    const url = "/uploads/" + fname + "?v=" + Date.now();
    saveConfig({ floorPlanUrl: url });
    res.json({ ok: true, floorPlanUrl: url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
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
      "floorPlanUrl",
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

// ---- HR / plantegning med ansatt-pins ----
app.get("/api/hr", requireAuth, (req, res) => {
  const c = getConfig();
  res.json({ floorPlanUrl: c.floorPlanUrl || "/floorplan.png", pins: c.floorPins || [] });
});
app.post("/api/hr", requireAuth, (req, res) => {
  try {
    const pins = Array.isArray(req.body?.pins) ? req.body.pins : null;
    if (!pins) return res.status(400).json({ error: "Mangler pins-liste" });
    const clean = pins.map((p) => ({
      name: String(p.name || "").slice(0, 80),
      x: Math.max(0, Math.min(100, Number(p.x) || 0)),
      y: Math.max(0, Math.min(100, Number(p.y) || 0)),
    }));
    saveConfig({ floorPins: clean });
    res.json({ ok: true, count: clean.length });
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

import "dotenv/config"; // leser en lokal .env-fil hvis den finnes (ignoreres på Railway)
import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { buildEconomy } from "./src/economy.js";
import { clearCache, resetClient } from "./src/tripletex.js";
import { getConfig, saveConfig, getConfigForAdmin } from "./src/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Admin-passordet er en bootstrap-hemmelighet som settes som miljøvariabel
// (ikke redigerbart fra UI). Alt annet styres fra admin-siden.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin-bytt-meg";
const SESSION_SECRET = process.env.SESSION_SECRET || "bytt-meg-til-en-lang-tilfeldig-streng";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  cookieSession({
    name: "bk_session",
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

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

app.post("/api/refresh", requireAuth, (req, res) => {
  clearCache();
  res.json({ ok: true });
});

// ---- Organisasjonskart (innloggede ansatte kan se og redigere) ----
app.get("/api/org", requireAuth, (req, res) => {
  res.json({ nodes: getConfig().orgChart || [] });
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

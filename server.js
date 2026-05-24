import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { clearCache } from "./src/tripletex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Felles passord for ansatte. Sett DASHBOARD_PASSWORD i miljøet.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "byggkon";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "bytt-meg-til-en-lang-tilfeldig-streng";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  cookieSession({
    name: "bk_session",
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000, // 12 timer
    httpOnly: true,
    sameSite: "lax",
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Ikke innlogget" });
  }
  return res.redirect("/login");
}

// ---- Innlogging ----
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (password === DASHBOARD_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

// ---- API ----
app.get("/api/overview", requireAuth, async (req, res) => {
  try {
    const data = await buildOverview();
    res.json(data);
  } catch (err) {
    console.error("Feil i /api/overview:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/refresh", requireAuth, (req, res) => {
  clearCache();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---- Statisk frontend (beskyttet) ----
app.use(requireAuth, express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Bygg-Kon dashboard kjører på port ${PORT}`);
});

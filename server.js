import "dotenv/config"; // leser en lokal .env-fil hvis den finnes (ignoreres på Railway)
import express from "express";
import cookieSession from "cookie-session";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildOverview } from "./src/metrics.js";
import { buildEconomy } from "./src/economy.js";
import { getNewsFeed } from "./src/newsfeed.js";
import { clearCache, resetClient, getInvoices, getCustomers, getSupplierInvoices, getSupplierInvoiceDetails, getSuppliers, getForwardableInvoices, getProjects, getProjectAddresses, getTimeEntries, getTimeEntriesDetailed, getEmployees, getProjectsEconomyDetails, getAccounts, getBalanceSheet, ymd } from "./src/tripletex.js";
import { geocodeOne, sleep } from "./src/geocode.js";
import { serveWithSnapshot, expireSnapshots, startBackgroundWarmer } from "./src/snapshot.js";
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

// ---- Microsoft Entra ID (Azure AD) OAuth — begrenset til @byggkon.no ----
// Aktiveres kun hvis miljøvariabler er satt på Railway.
// Krever MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID (byggkon-tenant ID
// eller domenenavn), og MICROSOFT_REDIRECT_URI.
const MS_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MS_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";
const MS_TENANT = process.env.MICROSOFT_TENANT_ID || "byggkon.no"; // tenant-ID eller "byggkon.no"
const MS_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || ""; // https://din-app.up.railway.app/auth/microsoft/callback
const ALLOWED_DOMAIN = process.env.OAUTH_ALLOWED_DOMAIN || "byggkon.no";
const OAUTH_ENABLED = !!(MS_CLIENT_ID && MS_CLIENT_SECRET && MS_REDIRECT_URI);

// Hjelper: er Microsoft-login tilgjengelig? (Brukes av login-siden)
app.get("/api/auth/config", (req, res) => res.json({
  oauthEnabled: OAUTH_ENABLED,
  provider: "microsoft",
  allowedDomain: ALLOWED_DOMAIN,
  user: req.session?.user || null,
}));

// Start OAuth-flyt: send brukeren til Microsoft
app.get("/auth/microsoft", (req, res) => {
  if (!OAUTH_ENABLED) return res.status(503).send("Microsoft OAuth ikke konfigurert. Sett MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID og MICROSOFT_REDIRECT_URI som env-variabler.");
  const state = Math.random().toString(36).slice(2);
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    redirect_uri: MS_REDIRECT_URI,
    response_type: "code",
    response_mode: "query",
    scope: "openid email profile User.Read",
    prompt: "select_account",
    domain_hint: ALLOWED_DOMAIN, // tipser Microsoft til å velge riktig tenant
    state,
  });
  res.redirect(`https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT)}/oauth2/v2.0/authorize?` + params.toString());
});

// OAuth-callback
app.get("/auth/microsoft/callback", async (req, res) => {
  try {
    if (!OAUTH_ENABLED) return res.redirect("/login?error=oauth-disabled");
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect("/login?error=" + encodeURIComponent(error_description || error));
    if (!code || state !== req.session?.oauthState) return res.redirect("/login?error=state-mismatch");
    delete req.session.oauthState;

    // Bytt code for token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        redirect_uri: MS_REDIRECT_URI,
        grant_type: "authorization_code",
        scope: "openid email profile User.Read",
      }),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error("MS token-feil:", txt.slice(0, 300));
      return res.redirect("/login?error=token-exchange");
    }
    const tokens = await tokenRes.json();

    // Hent brukerinfo fra Microsoft Graph
    const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: "Bearer " + tokens.access_token },
    });
    if (!userRes.ok) return res.redirect("/login?error=userinfo");
    const user = await userRes.json();

    // Verifiser domene — userPrincipalName / mail
    const email = String(user.mail || user.userPrincipalName || "").toLowerCase();
    const domain = email.split("@")[1] || "";
    if (!email || domain !== ALLOWED_DOMAIN) {
      return res.redirect("/login?error=wrong-domain&got=" + encodeURIComponent(domain));
    }

    // Logg inn
    req.session.loggedIn = true;
    req.session.user = {
      email,
      name: user.displayName || email,
      provider: "microsoft",
      jobTitle: user.jobTitle || "",
      loggedInAt: Date.now(),
    };
    // Loggfør innlogging
    const cfg = getConfig();
    const log = Array.isArray(cfg.loginLog) ? cfg.loginLog : [];
    log.push({ email, name: req.session.user.name, at: new Date().toISOString() });
    saveConfig({ loginLog: log.slice(-500) });
    res.redirect("/");
  } catch (err) {
    console.error("OAuth-feil:", err);
    res.redirect("/login?error=server");
  }
});

// ---- Claude-redigering av kodebasen (kun admin) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "Oleandret/byggkon_dashboard";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const CLAUDE_ENABLED = !!ANTHROPIC_API_KEY;

app.get("/api/admin/claude/config", requireAdmin, (req, res) => res.json({
  claudeEnabled: CLAUDE_ENABLED,
  githubEnabled: !!GITHUB_TOKEN,
  repo: GITHUB_REPO,
  branch: GITHUB_BRANCH,
}));

// Filer/mapper Claude får lov å hente kontekst fra (sikkerhetsgjerde)
const ALLOWED_PATHS_RE = /^(public|src|views|server\.js|package\.json|README\.md)/;
async function listProjectFiles() {
  const root = path.join(__dirname);
  const result = [];
  function walk(rel) {
    const abs = path.join(root, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "data") continue;
      if (e.isDirectory()) walk(childRel);
      else if (ALLOWED_PATHS_RE.test(childRel)) {
        const stat = fs.statSync(abs + "/" + e.name);
        result.push({ path: childRel, size: stat.size });
      }
    }
  }
  walk("");
  return result;
}

// Hent fil-innhold (admin-only)
app.get("/api/admin/claude/file", requireAdmin, (req, res) => {
  try {
    const rel = String(req.query.path || "");
    if (!ALLOWED_PATHS_RE.test(rel)) return res.status(400).json({ error: "Ikke tillatt sti" });
    const abs = path.join(__dirname, rel);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: "Ikke funnet" });
    const content = fs.readFileSync(abs, "utf8");
    res.json({ path: rel, content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send melding til Claude (Anthropic API)
app.post("/api/admin/claude/chat", requireAdmin, async (req, res) => {
  try {
    if (!CLAUDE_ENABLED) return res.status(503).json({ error: "ANTHROPIC_API_KEY ikke satt på Railway" });
    const message = String(req.body?.message || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];
    const includeFiles = Array.isArray(req.body?.includeFiles) ? req.body.includeFiles : [];
    if (!message) return res.status(400).json({ error: "Tom melding" });

    // Bygg system-prompt med prosjektkontekst
    const projectFiles = await listProjectFiles();
    let systemPrompt = `Du hjelper Ole-André med å redigere kodebasen til Bygg-Kon sitt interne dashboard.
Prosjektet er et Node.js + Express-prosjekt deployet på Railway, med vanlig JS/HTML/CSS-frontend.

Prosjekt-strukturen:
${projectFiles.map((f) => "- " + f.path + " (" + Math.round(f.size / 1024) + " kB)").join("\n")}

VIKTIGE REGLER når brukeren ber om endringer:
1. Foreslå nøyaktige edits ved å bruke dette formatet — som JSON i en kodeblokk:
\`\`\`changes
{
  "commit_message": "Kort beskrivelse av endringen",
  "edits": [
    {
      "file": "public/index.html",
      "find": "eksakt tekst som finnes i fila nå",
      "replace": "ny tekst som erstatter den"
    }
  ]
}
\`\`\`
2. "find" må være EKSAKT tekst som finnes i fila — inkludert innrykk og whitespace
3. For større endringer, lag flere edits i samme "edits"-array
4. Hvis du trenger å se innholdet i en fil før du foreslår endringer, svar med: "Jeg trenger å se innholdet i [filsti]" så henter brukeren det
5. Forklar kort hva endringen gjør på norsk før kodeblokken
6. Hvis brukeren ber om noe som krever ny fil, bruk "find": "" og legg hele innholdet i "replace"`;

    // Inkluder fil-innhold som ble bedt om
    if (includeFiles.length) {
      systemPrompt += "\n\nInnholdet i relevante filer:\n";
      for (const f of includeFiles.slice(0, 5)) {
        if (!ALLOWED_PATHS_RE.test(f)) continue;
        try {
          const content = fs.readFileSync(path.join(__dirname, f), "utf8");
          if (content.length > 50000) {
            systemPrompt += `\n=== ${f} (forkortet, ${content.length} tegn totalt) ===\n${content.slice(0, 50000)}\n[...kuttet]\n`;
          } else {
            systemPrompt += `\n=== ${f} ===\n${content}\n`;
          }
        } catch {}
      }
    }

    const messages = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: message },
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: String(req.body?.model || "claude-sonnet-4-6").slice(0, 60),
        max_tokens: 8000,
        system: systemPrompt,
        messages,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: "Anthropic feilet: " + txt.slice(0, 300) });
    }
    const data = await r.json();
    const reply = data.content?.[0]?.text || "";
    // Parse ut endringsblokken hvis Claude la inn en
    let proposedChanges = null;
    const match = reply.match(/```changes\s*\n([\s\S]*?)\n```/);
    if (match) {
      try { proposedChanges = JSON.parse(match[1]); } catch {}
    }
    res.json({ ok: true, reply, proposedChanges });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bruk endringer og push til GitHub
app.post("/api/admin/claude/apply", requireAdmin, async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN ikke satt på Railway" });
    const changes = req.body?.changes;
    if (!changes?.edits || !Array.isArray(changes.edits)) return res.status(400).json({ error: "Mangler edits" });
    const commitMsg = String(changes.commit_message || "Claude: oppdater dashbordet").slice(0, 200);

    const applied = [];
    const errors = [];
    for (const edit of changes.edits) {
      const rel = String(edit.file || "");
      if (!ALLOWED_PATHS_RE.test(rel)) { errors.push({ file: rel, error: "Ikke tillatt sti" }); continue; }
      // Hent eksisterende fil-SHA via GitHub Contents API
      try {
        const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rel)}?ref=${GITHUB_BRANCH}`, {
          headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json" },
        });
        let existingContent = ""; let sha = undefined;
        if (getRes.ok) {
          const meta = await getRes.json();
          sha = meta.sha;
          existingContent = Buffer.from(meta.content || "", "base64").toString("utf8");
        } else if (getRes.status !== 404) {
          throw new Error("GitHub GET " + getRes.status);
        }
        // Anvend endringen
        let newContent;
        if (!edit.find || edit.find === "") {
          newContent = String(edit.replace || "");
        } else {
          if (!existingContent.includes(edit.find)) {
            errors.push({ file: rel, error: "Kunne ikke finne 'find'-tekst i fila" });
            continue;
          }
          newContent = existingContent.replace(edit.find, edit.replace);
        }
        if (newContent === existingContent) { errors.push({ file: rel, error: "Ingen endring" }); continue; }
        // PUT ny versjon
        const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rel)}`, {
          method: "PUT",
          headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({
            message: commitMsg + " · " + rel,
            content: Buffer.from(newContent, "utf8").toString("base64"),
            sha,
            branch: GITHUB_BRANCH,
            committer: { name: "Claude (Bygg-Kon)", email: "ai@byggkon.no" },
          }),
        });
        if (!putRes.ok) {
          const t = await putRes.text();
          errors.push({ file: rel, error: "GitHub PUT " + putRes.status + ": " + t.slice(0, 200) });
        } else {
          applied.push(rel);
        }
      } catch (e) { errors.push({ file: rel, error: e.message }); }
    }
    res.json({ ok: errors.length === 0, applied, errors, commitMessage: commitMsg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Git-revisjoner: list siste commits + revert ----
app.get("/api/admin/git/commits", requireAdmin, async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN ikke satt" });
    const per_page = Math.min(50, Math.max(1, Number(req.query.per_page) || 30));
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?sha=${GITHUB_BRANCH}&per_page=${per_page}`, {
      headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return res.status(502).json({ error: "GitHub feilet: " + r.status });
    const data = await r.json();
    const commits = (data || []).map((c) => ({
      sha: c.sha,
      shortSha: (c.sha || "").slice(0, 7),
      message: c.commit?.message || "",
      author: c.commit?.author?.name || "",
      authorEmail: c.commit?.author?.email || "",
      date: c.commit?.author?.date || "",
      url: c.html_url,
    }));
    res.json({ ok: true, commits, currentSha: commits[0]?.sha });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Revert: lag en ny commit som peker tilbake til target-commit sitt tree.
// Bevarer hele historikken — vi sletter ikke noe, vi legger til en ny commit.
app.post("/api/admin/git/revert", requireAdmin, async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN ikke satt" });
    const targetSha = String(req.body?.sha || "").trim();
    if (!/^[a-f0-9]{7,40}$/i.test(targetSha)) return res.status(400).json({ error: "Ugyldig commit-SHA" });
    const ghHeaders = { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

    // 1) Hent målet-commit for å finne tree
    const tgtRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits/${targetSha}`, { headers: ghHeaders });
    if (!tgtRes.ok) return res.status(404).json({ error: "Fant ikke commit " + targetSha });
    const tgt = await tgtRes.json();
    const treeSha = tgt.tree?.sha;
    if (!treeSha) return res.status(500).json({ error: "Target commit har ikke tree" });

    // 2) Hent nåværende HEAD på branchen (skal være parent)
    const refRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, { headers: ghHeaders });
    if (!refRes.ok) return res.status(500).json({ error: "Kunne ikke hente HEAD" });
    const ref = await refRes.json();
    const headSha = ref.object?.sha;

    // 3) Lag en ny commit med target-tree, parent = HEAD
    const shortTarget = targetSha.slice(0, 7);
    const msg = `Revert til ${shortTarget}: ${tgt.message?.split("\n")[0] || ""}`.slice(0, 200);
    const newCommitRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits`, {
      method: "POST", headers: ghHeaders,
      body: JSON.stringify({ message: msg, tree: treeSha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) {
      const t = await newCommitRes.text();
      return res.status(500).json({ error: "Klarte ikke lage commit: " + t.slice(0, 200) });
    }
    const newCommit = await newCommitRes.json();

    // 4) Oppdater branch-referansen til den nye commit-en
    const updateRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, {
      method: "PATCH", headers: ghHeaders,
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
    if (!updateRes.ok) {
      const t = await updateRes.text();
      return res.status(500).json({ error: "Klarte ikke oppdatere ref: " + t.slice(0, 200) });
    }
    res.json({ ok: true, newSha: newCommit.sha, revertedTo: targetSha, message: msg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// "Hvem er jeg innlogget som?" — brukes av frontend til å vise navn i header
app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    user: req.session?.user || { email: "", name: "Passord-bruker", provider: "password" },
    isAdmin: !!req.session?.isAdmin,
  });
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
    // MCP-servere (navn + url + key). Url må være http(s).
    if (Array.isArray(req.body?.mcpServers)) {
      partial.mcpServers = req.body.mcpServers
        .map((m) => ({
          name: String(m.name || "").slice(0, 60).trim(),
          url: String(m.url || "").slice(0, 500).trim(),
          key: String(m.key || "").slice(0, 500).trim(),
        }))
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
      const [sis, supplierList] = await Promise.all([
        getSupplierInvoices(from, to),
        getSuppliers().catch(() => []),
      ]);
      // navn -> {email, phone, orgNr}
      const supContact = new Map();
      for (const s of supplierList) {
        if (!s.name) continue;
        supContact.set(s.name, {
          email: s.email || s.invoiceEmail || "",
          phone: s.phoneNumber || s.phone || "",
          orgNr: s.organizationNumber || "",
        });
      }
      const bySup = new Map();
      let total = 0;
      for (const s of sis) {
        const name = s.supplier?.name || "Ukjent";
        if (SALARY_RE.test(name)) continue; // ingen lønnskostnader skal med
        const id = s.supplier?.id;
        const cost = Math.abs(s.amount || 0);
        const c = supContact.get(name) || {};
        const cur = bySup.get(name) || { name, id, cost: 0, count: 0, email: c.email || "", phone: c.phone || "", orgNr: c.orgNr || "" };
        cur.cost += cost; cur.count += 1; total += cost;
        if (id && !cur.id) cur.id = id;
        bySup.set(name, cur);
      }
      const meta = getConfig().supplierMeta || {};
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

// Til viderefakturering: leverandørfakturaer der kommentaren inneholder "vf"
// eller "viderefaktur" – siste 12 måneder.
app.get("/api/forwardable", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const rows = await getForwardableInvoices(from, to);
    const out = rows.map((r) => ({
      id: r.id,
      supplier: r.supplier?.name || "",
      invoiceDate: r.invoiceDate || "",
      invoiceNumber: r.invoiceNumber || r.kid || "",
      comment: r.comment || r.description || r.title || "",
      amount: Math.abs(r.amount || 0),
    })).sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || ""));
    res.json({ invoices: out, total: out.reduce((s, r) => s + r.amount, 0) });
  } catch (err) {
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
    const prev = meta[name] || {};
    // Avtale-felter kan oppdateres delvis: tom streng = fjern, ellers behold/overskriv.
    const agreementUrl = req.body?.agreementUrl !== undefined
      ? String(req.body.agreementUrl).slice(0, 500) : (prev.agreementUrl || "");
    const agreementName = req.body?.agreementName !== undefined
      ? String(req.body.agreementName).slice(0, 200) : (prev.agreementName || "");
    meta[name] = {
      rammeavtale: !!req.body?.rammeavtale,
      ansvarlig: String(req.body?.ansvarlig || "").slice(0, 80),
      status: String(req.body?.status || "").slice(0, 120),
      terminated: !!req.body?.terminated,
      agreementUrl,
      agreementName,
    };
    saveConfig({ supplierMeta: meta });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- BIM-modeller (in-browser viewer) ----
const BIM_DIR = path.join(UPLOAD_DIR, "bim");
function bimSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " kB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
app.get("/api/bim/models", requireAuth, (req, res) => {
  try {
    fs.mkdirSync(BIM_DIR, { recursive: true });
    const files = fs.readdirSync(BIM_DIR).filter((f) => /\.(ifc|xkt|gltf|glb)$/i.test(f));
    const models = files.map((f) => {
      const st = fs.statSync(path.join(BIM_DIR, f));
      return {
        name: f.replace(/^\d+-/, ""),
        url: "/uploads/bim/" + f,
        size: st.size,
        sizeText: bimSize(st.size),
        uploadedAt: st.mtime.toISOString(),
      };
    }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    res.json({ models });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/bim/upload", requireAuth, (req, res) => {
  try {
    const filename = String(req.body?.filename || "modell").slice(0, 200);
    if (!/\.(ifc|xkt|gltf|glb)$/i.test(filename)) {
      return res.status(400).json({ error: "Kun .ifc, .xkt, .gltf, .glb støttes." });
    }
    const m = /^data:([^;]+);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!m) return res.status(400).json({ error: "Ugyldig fil." });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 250 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 250 MB)." });
    fs.mkdirSync(BIM_DIR, { recursive: true });
    const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_");
    const target = Date.now() + "-" + safe;
    fs.writeFileSync(path.join(BIM_DIR, target), buf);
    res.json({ ok: true, url: "/uploads/bim/" + target, name: filename });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/bim/delete", requireAuth, (req, res) => {
  try {
    const url = String(req.body?.url || "");
    if (!/^\/uploads\/bim\/[A-Za-z0-9._-]+$/.test(url)) return res.status(400).json({ error: "Ugyldig URL" });
    const fname = url.replace("/uploads/bim/", "");
    const fp = path.join(BIM_DIR, fname);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Last opp avtale/rammeavtale for en leverandør ----
app.post("/api/supplier-agreement/upload", requireAuth, (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const filename = String(req.body?.filename || "avtale").slice(0, 160);
    const m = /^data:([^;]+);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!name || !m) return res.status(400).json({ error: "Ugyldig fil eller mangler leverandør." });
    const mime = m[1].toLowerCase();
    const ext = mime.includes("pdf") ? "pdf"
      : mime.includes("wordprocessingml") ? "docx"
      : mime.includes("spreadsheetml") ? "xlsx"
      : mime.includes("msword") ? "doc"
      : mime.includes("ms-excel") ? "xls"
      : (filename.split(".").pop() || "bin").toLowerCase().slice(0, 5);
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 15 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
    const safeFile = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
    const target = `agreement-${safeName}-${Date.now()}-${safeFile}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, target), buf);
    const url = "/uploads/" + target;
    // Lagre på supplierMeta
    const all = { ...(getConfig().supplierMeta || {}) };
    const prev = all[name] || {};
    all[name] = { ...prev, agreementUrl: url, agreementName: filename };
    saveConfig({ supplierMeta: all });
    res.json({ ok: true, url, ext });
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
app.get("/api/arbeidsmetodikk", requireAuth, (req, res) => res.json({ arbeidsmetodikk: getConfig().arbeidsmetodikk || "" }));
app.post("/api/arbeidsmetodikk", requireAuth, (req, res) => {
  try {
    const txt = String(req.body?.arbeidsmetodikk || "");
    saveConfig({ arbeidsmetodikk: txt.slice(0, 20000) });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

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
    // 6-måneders totaltrend (sum av alle aktive ansatte per måned)
    const trend6 = months.slice(-6).map((_, j) => {
      const i = months.length - 6 + j;
      let mh = 0, mb = 0;
      for (const r of empMap.values()) {
        if (!activeIds.has(r.id)) continue;
        mh += r.byMonth[i].h; mb += r.byMonth[i].b;
      }
      return { label: months[i].label, rate: mh > 0 ? mb / mh : 0, hours: Math.round(mh), billable: Math.round(mb) };
    });
    res.json({
      months: months.map((m) => m.label),
      months6: trend6.map((t) => t.label),
      trend6,
      employees: employeesOut,
      total: {
        last14: { rate: total14h > 0 ? total14b / total14h : 0, hours: Math.round(total14h), billable: Math.round(total14b) },
        last7: { rate: total7h > 0 ? total7b / total7h : 0, hours: Math.round(total7h), billable: Math.round(total7b) },
      },
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ---- Ledelse: auto-data fra Tripletex til Likviditet/Resultat/Budsjett + justeringer ----
app.get("/api/ledelse/auto", requireAdmin, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("ledelse-auto", async () => {
      const today = new Date();
      const todayStr = ymd(today);
      const yearStart = new Date(today.getFullYear(), 0, 1);

      // Bygg 12 mnd bakover + 12 mnd fremover (totalt 24 etiketter)
      const monthsPast = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        monthsPast.push({
          key: ymd(d).slice(0, 7),
          label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
          from: ymd(d),
          to: ymd(end > today ? today : end),
        });
      }
      const monthsFuture = [];
      for (let i = 1; i <= 12; i++) {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        monthsFuture.push({
          key: ymd(d).slice(0, 7),
          label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
        });
      }

      // Hent regnskapsdata for siste 12 mnd
      const [accounts, invoices, supplierInvs, monthSums] = await Promise.all([
        getAccounts(),
        getInvoices(ymd(yearStart), todayStr),
        getSupplierInvoices(monthsPast[0].from, todayStr),
        Promise.all(monthsPast.map((m) => getBalanceSheet(m.from, m.to, 3000, 8299))),
      ]);
      const accById = new Map(accounts.map((a) => [a.id, a]));
      const summarize = (rows) => {
        let revenue = 0, opex = 0;
        for (const r of rows) {
          const a = accById.get(r.account?.id); if (!a) continue;
          const n = Number(a.number);
          const ch = r.balanceChange || 0;
          if (n >= 3000 && n < 4000) revenue += -ch;
          else if (n >= 4000 && n < 8000) opex += ch;
        }
        return { revenue: Math.round(revenue), opex: Math.round(opex), result: Math.round(revenue - opex) };
      };

      // RESULTAT 12 mnd historisk
      const resultat = monthsPast.map((m, i) => ({ ...m, ...summarize(monthSums[i]) }));
      // Snitt siste 6 mnd brukes som basis for budsjett
      const avg6Rev = resultat.slice(-6).reduce((s, r) => s + r.revenue, 0) / 6;
      const avg6Opex = resultat.slice(-6).reduce((s, r) => s + r.opex, 0) / 6;

      // BUDSJETT: framskriving av snitt for 12 mnd fram
      const budsjett = monthsFuture.map((m) => ({
        ...m,
        revenuePlan: Math.round(avg6Rev),
        opexPlan: Math.round(avg6Opex),
        resultPlan: Math.round(avg6Rev - avg6Opex),
      }));

      // LIKVIDITET: utestående fakturaer (innkommende) og leverandørfakturaer (utgående)
      // gruppert per måned framover (basert på forfallsdato), pluss snitt-kost framover
      const liqIn = new Map();  // key=YYYY-MM
      const liqOut = new Map();
      for (const inv of invoices) {
        const due = inv.invoiceDueDate || inv.invoiceDate || "";
        const out = Number(inv.amountOutstanding || 0);
        if (!due || out <= 0) continue;
        const key = due.slice(0, 7);
        liqIn.set(key, (liqIn.get(key) || 0) + out);
      }
      for (const si of supplierInvs) {
        const due = si.invoiceDueDate || si.invoiceDate || "";
        const amt = Math.abs(Number(si.amount || 0));
        if (!due || amt <= 0) continue;
        const key = due.slice(0, 7);
        liqOut.set(key, (liqOut.get(key) || 0) + amt);
      }
      // Likviditet-listing: vis nåværende måned + 11 framover
      const liqMonths = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        const key = ymd(d).slice(0, 7);
        liqMonths.push({
          key, label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
          cashIn: Math.round(liqIn.get(key) || 0),
          cashOut: Math.round(liqOut.get(key) || (i > 0 ? avg6Opex : 0)), // framtidige måneder bruker snitt-kost
        });
      }
      // Akkumulert netto kontantstrøm (uten startbalanse — admin kan legge inn via justering)
      let acc = 0;
      const likviditet = liqMonths.map((m) => {
        acc += (m.cashIn - m.cashOut);
        return { ...m, net: m.cashIn - m.cashOut, accumulated: acc };
      });

      const adj = getConfig().ledelseAdjustments || {};
      return {
        updatedAt: new Date().toISOString(),
        resultat, budsjett, likviditet,
        adjustments: {
          resultat: adj.resultat || [],
          budsjett: adj.budsjett || [],
          likviditet: adj.likviditet || [],
        },
        notes: {
          basis: "Basisestimat = gjennomsnitt siste 6 måneder. Justeringer legges til/trekkes fra i kolonnen til høyre.",
        },
      };
    }, 10 * 60 * 1000));
  } catch (err) {
    console.error("Feil i /api/ledelse/auto:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Ledelse: Likviditetsprognose i Excel-stil (12 mnd × poster) ----
app.get("/api/ledelse/likviditet", requireAdmin, async (req, res) => {
  try {
    res.json(await serveWithSnapshot("ledelse-likviditet", async () => {
      const today = new Date();
      const todayStr = ymd(today);
      const yearStart = ymd(new Date(today.getFullYear(), 0, 1));

      // 12 måneder framover, starter med inneværende måned
      const months = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        months.push({
          key: ymd(d).slice(0, 7),
          label: d.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }),
        });
      }
      const monthKeys = new Set(months.map((m) => m.key));

      // Hent data
      const [invoicesCust, supplierInvs, accounts, monthSums] = await Promise.all([
        getInvoices(yearStart, todayStr).catch(() => []),
        getSupplierInvoices(ymd(new Date(today.getFullYear() - 1, today.getMonth(), 1)), todayStr).catch(() => []),
        getAccounts().catch(() => []),
        Promise.all(
          [...Array(6)].map((_, i) => {
            const d = new Date(today.getFullYear(), today.getMonth() - (6 - i), 1);
            const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            return getBalanceSheet(ymd(d), ymd(end > today ? today : end), 3000, 8299).catch(() => []);
          })
        ),
      ]);

      // Beregn snitt lønn / drift / andre fra siste 6 mnd
      const accById = new Map(accounts.map((a) => [a.id, a]));
      const sum6 = { lonn: 0, drift: 0, andre: 0, leie: 0, mvaaga: 0 };
      const monthsCount = monthSums.length || 1;
      for (const rows of monthSums) {
        for (const r of rows) {
          const a = accById.get(r.account?.id); if (!a) continue;
          const n = Number(a.number);
          const ch = r.balanceChange || 0;
          if (n >= 5000 && n < 5900) sum6.lonn += ch;
          else if (n >= 6300 && n < 6400) sum6.leie += ch;
          else if (n >= 6000 && n < 8000) sum6.drift += ch;
          else if (n >= 2700 && n < 2780) sum6.mvaaga += ch;
        }
      }
      const avg = {
        lonn: Math.round(sum6.lonn / monthsCount),
        drift: Math.round(sum6.drift / monthsCount),
        leie: Math.round(sum6.leie / monthsCount),
        mvaaga: Math.round(sum6.mvaaga / monthsCount),
      };

      // Kundefordringer per måned (forfallsdato)
      const kundefordr = {};
      for (const inv of invoicesCust) {
        const due = inv.invoiceDueDate || inv.invoiceDate;
        if (!due) continue;
        const out = Number(inv.amountOutstanding || 0);
        if (out <= 0) continue;
        const key = monthKeys.has(due.slice(0, 7)) ? due.slice(0, 7) : months[0].key; // forfalt → første måned
        kundefordr[key] = (kundefordr[key] || 0) + out;
      }
      // Leverandørgjeld per måned (forfallsdato)
      const levgjeld = {};
      for (const si of supplierInvs) {
        const due = si.invoiceDueDate || si.invoiceDate;
        if (!due) continue;
        const amt = Math.abs(Number(si.amount || 0));
        if (amt <= 0) continue;
        const key = monthKeys.has(due.slice(0, 7)) ? due.slice(0, 7) : months[0].key;
        levgjeld[key] = (levgjeld[key] || 0) + amt;
      }

      // Bygg seksjoner
      const sections = [
        {
          key: "innbetalinger", title: "Innbetalinger", positive: true,
          rows: [
            { key: "kundefordringer", label: "Kundefordringer", auto: months.map((m) => Math.round(kundefordr[m.key] || 0)), source: "Utestående kundefakturaer fra Tripletex" },
            { key: "innbetalingProsjekt", label: "Innbetaling prosjekter", auto: months.map(() => 0), source: "Legg inn forventet prosjektomsetning manuelt" },
            { key: "laneopptak", label: "Låneopptak / tilskudd", auto: months.map(() => 0), source: "Manuell" },
            { key: "annetInn", label: "Annen innbetaling", auto: months.map(() => 0), source: "Manuell" },
          ],
        },
        {
          key: "utbetalinger", title: "Utbetalinger", positive: false,
          rows: [
            { key: "leverandorgjeld", label: "Leverandørgjeld", auto: months.map((m) => Math.round(levgjeld[m.key] || 0)), source: "Utestående leverandørfakturaer" },
            { key: "kjopTomt", label: "Kjøp av tomt / investering", auto: months.map(() => 0), source: "Manuell" },
            { key: "annetUt", label: "Annen utbetaling", auto: months.map(() => 0), source: "Manuell" },
          ],
        },
        {
          key: "fasteKostnader", title: "Faste kostnader", positive: false,
          rows: [
            { key: "lonn", label: "Lønnsutbetalinger", auto: months.map(() => avg.lonn), source: "Snitt 6 mnd (kontoklasse 5xxx)" },
            { key: "innleie", label: "Innleie personell", auto: months.map(() => 0), source: "Manuell" },
            { key: "husleie", label: "Husleie", auto: months.map(() => avg.leie), source: "Snitt 6 mnd (konto 63xx)" },
            { key: "drift", label: "Andre driftskostnader", auto: months.map(() => avg.drift), source: "Snitt 6 mnd (øvrige 6xxx-7xxx)" },
            { key: "mvaaga", label: "MVA / AGA / skattetrekk", auto: months.map(() => avg.mvaaga), source: "Snitt 6 mnd (27xx)" },
            { key: "annetFast", label: "Andre betalinger", auto: months.map(() => 0), source: "Manuell" },
          ],
        },
      ];

      const cfg = getConfig().ledelseLikviditet || {};
      return {
        months,
        sections,
        startBalance: Number(cfg.startBalance) || 0,
        kassekreditt: Number(cfg.kassekreditt) || 1000000,
        kassekredittSaldo: Number(cfg.kassekredittSaldo) || 0,
        rente: Number(cfg.rente) || 0.0747,
        adjustments: cfg.adjustments || {},
        updatedAt: new Date().toISOString(),
      };
    }, 10 * 60 * 1000));
  } catch (err) {
    console.error("Feil i /api/ledelse/likviditet:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Lagre likviditet-innstillinger (start, KK) + justeringer per rad/måned
app.post("/api/ledelse/likviditet", requireAdmin, (req, res) => {
  try {
    const prev = getConfig().ledelseLikviditet || {};
    const next = { ...prev };
    if (req.body?.startBalance !== undefined) next.startBalance = Number(req.body.startBalance) || 0;
    if (req.body?.kassekreditt !== undefined) next.kassekreditt = Number(req.body.kassekreditt) || 0;
    if (req.body?.kassekredittSaldo !== undefined) next.kassekredittSaldo = Number(req.body.kassekredittSaldo) || 0;
    if (req.body?.rente !== undefined) next.rente = Number(req.body.rente) || 0;
    if (req.body?.adjustments && typeof req.body.adjustments === "object") {
      const clean = {};
      for (const [rowKey, byMonth] of Object.entries(req.body.adjustments)) {
        if (!rowKey || !byMonth || typeof byMonth !== "object") continue;
        const m = {};
        for (const [mk, v] of Object.entries(byMonth)) {
          if (!/^\d{4}-\d{2}$/.test(mk)) continue;
          const n = Number(v);
          if (Number.isFinite(n) && n !== 0) m[mk] = Math.round(n);
        }
        if (Object.keys(m).length) clean[String(rowKey).slice(0, 60)] = m;
      }
      next.adjustments = clean;
    }
    saveConfig({ ledelseLikviditet: next });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Ledelse: justeringer (admin) ----
app.get("/api/ledelse/adjustments", requireAdmin, (req, res) => res.json({ adjustments: getConfig().ledelseAdjustments || {} }));
app.post("/api/ledelse/adjustments", requireAdmin, (req, res) => {
  try {
    const slot = String(req.body?.slot || "").toLowerCase();
    if (!["likviditet", "resultat", "budsjett"].includes(slot)) return res.status(400).json({ error: "Ukjent slot" });
    const list = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!list) return res.status(400).json({ error: "Mangler items" });
    const all = { ...(getConfig().ledelseAdjustments || {}) };
    all[slot] = list.slice(0, 200).map((x) => ({
      id: String(x.id || ("a_" + Math.random().toString(36).slice(2, 9))),
      month: String(x.month || "").slice(0, 7),
      label: String(x.label || "").slice(0, 200),
      amount: Math.round(Number(x.amount) || 0),
      type: x.type === "out" ? "out" : "in", // in = legges til, out = trekkes fra
      note: String(x.note || "").slice(0, 300),
    }));
    saveConfig({ ledelseAdjustments: all });
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

// ---- Avdelingsmedlemmer (hvilke ansatte hører til hvilken avdeling) ----
app.get("/api/department-members", requireAuth, (req, res) => res.json({ members: getConfig().departmentMembers || {} }));
app.post("/api/department-members", requireAuth, (req, res) => {
  try {
    const m = req.body?.members;
    if (!m || typeof m !== "object") return res.status(400).json({ error: "Mangler members-objekt" });
    const clean = {};
    for (const [dept, list] of Object.entries(m)) {
      if (!dept || !Array.isArray(list)) continue;
      clean[String(dept).slice(0, 80)] = list.map((x) => String(x || "").slice(0, 80)).filter(Boolean);
    }
    saveConfig({ departmentMembers: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- KS-saker per avdeling ----
app.get("/api/dept-ks", requireAuth, (req, res) => res.json({ ks: getConfig().deptKs || {} }));
app.post("/api/dept-ks", requireAuth, (req, res) => {
  try {
    const k = req.body?.ks;
    if (!k || typeof k !== "object") return res.status(400).json({ error: "Mangler ks-objekt" });
    const clean = {};
    for (const [dept, list] of Object.entries(k)) {
      if (!dept || !Array.isArray(list)) continue;
      clean[String(dept).slice(0, 80)] = list.slice(0, 500).map((x) => ({
        id: String(x.id || ("ks_" + Math.random().toString(36).slice(2, 9))),
        title: String(x.title || "").slice(0, 200),
        owner: String(x.owner || "").slice(0, 80),
        status: String(x.status || "Åpen").slice(0, 30),
        deadline: String(x.deadline || "").slice(0, 20),
        note: String(x.note || "").slice(0, 1000),
      }));
    }
    saveConfig({ deptKs: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Tilbudsarbeid: pris-matrise per avdeling ----
app.get("/api/dept-tilbud", requireAuth, (req, res) => res.json({ tilbud: getConfig().deptTilbud || {} }));
app.post("/api/dept-tilbud", requireAuth, (req, res) => {
  try {
    const t = req.body?.tilbud;
    if (!t || typeof t !== "object") return res.status(400).json({ error: "Mangler tilbud-objekt" });
    const clean = {};
    for (const [dept, obj] of Object.entries(t)) {
      if (!dept || !obj || typeof obj !== "object") continue;
      const sections = Array.isArray(obj.sections) ? obj.sections : [];
      clean[String(dept).slice(0, 80)] = {
        sections: sections.slice(0, 50).map((sec) => ({
          title: String(sec.title || "").slice(0, 120),
          rows: (Array.isArray(sec.rows) ? sec.rows : []).slice(0, 500).map((r) => ({
            label: String(r.label || "").slice(0, 200),
            unit: String(r.unit || "").slice(0, 40),
            price: Math.max(0, Number(r.price) || 0),
            note: String(r.note || "").slice(0, 300),
          })),
        })),
      };
    }
    saveConfig({ deptTilbud: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Ansatt-innstillinger (Orion MCP + visibility per ansatt) ----
app.get("/api/employee-settings", requireAuth, (req, res) => {
  const all = getConfig().employeeSettings || {};
  const out = {};
  for (const [name, s] of Object.entries(all)) {
    out[name] = {
      orion: {
        url: s.orion?.url || "",
        enabled: !!s.orion?.enabled,
        hasKey: !!s.orion?.key,
        chatPath: s.orion?.chatPath || "",
        statusPath: s.orion?.statusPath || "",
        protocol: s.orion?.protocol || "auto", // auto | mcp | rest | openai
        toolName: s.orion?.toolName || "",
      },
      visibility: s.visibility || {},
    };
  }
  res.json({ settings: out });
});
app.post("/api/employee-settings", requireAuth, (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler ansattnavn" });
    const all = { ...(getConfig().employeeSettings || {}) };
    const prev = all[name] || {};
    const body = req.body || {};
    const orionPrev = prev.orion || {};
    const orion = {
      url: body.orion?.url !== undefined ? String(body.orion.url).slice(0, 500) : (orionPrev.url || ""),
      key: (body.orion && typeof body.orion.key === "string" && body.orion.key)
        ? String(body.orion.key).slice(0, 500)
        : (orionPrev.key || ""),
      enabled: typeof body.orion?.enabled === "boolean" ? body.orion.enabled : !!orionPrev.enabled,
      chatPath: body.orion?.chatPath !== undefined ? String(body.orion.chatPath).slice(0, 200) : (orionPrev.chatPath || ""),
      statusPath: body.orion?.statusPath !== undefined ? String(body.orion.statusPath).slice(0, 200) : (orionPrev.statusPath || ""),
      protocol: ["auto", "mcp", "rest", "openai"].includes(body.orion?.protocol) ? body.orion.protocol : (orionPrev.protocol || "auto"),
      toolName: body.orion?.toolName !== undefined ? String(body.orion.toolName).slice(0, 60) : (orionPrev.toolName || ""),
    };
    const visibility = body.visibility && typeof body.visibility === "object"
      ? Object.fromEntries(Object.entries(body.visibility).map(([k, v]) => [String(k).slice(0, 40), !!v]))
      : (prev.visibility || {});
    all[name] = { orion, visibility };
    saveConfig({ employeeSettings: all });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Orion MCP-proxy: henter status fra ansattes Orion-server ----
app.get("/api/employee-status", requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler navn" });
    const cfg = (getConfig().employeeSettings || {})[name];
    const orion = cfg?.orion;
    if (!orion || !orion.enabled || !orion.url) {
      return res.json({ ok: false, reason: "Orion MCP er ikke aktivert for denne ansatte" });
    }
    const url = orion.url.replace(/\/+$/, "").replace(/([^:])\/{2,}/g, "$1/");
    const tryEndpoints = [];
    if (orion.statusPath) {
      const customUrl = orion.statusPath.startsWith("http") ? orion.statusPath : url + (orion.statusPath.startsWith("/") ? orion.statusPath : "/" + orion.statusPath);
      tryEndpoints.push({ method: "GET", url: customUrl + (customUrl.includes("?") ? "&" : "?") + "employee=" + encodeURIComponent(name), label: "custom" });
      tryEndpoints.push({ method: "POST", url: customUrl, body: { employee: name }, label: "custom POST" });
    }
    tryEndpoints.push({ method: "GET", url: url + "/status?employee=" + encodeURIComponent(name), label: "/status" });
    tryEndpoints.push({ method: "GET", url: url + "/api/status?employee=" + encodeURIComponent(name), label: "/api/status" });
    tryEndpoints.push({ method: "POST", url: url, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: orion.toolName || "get_status", arguments: { employee: name } } }, label: "mcp-root" });
    tryEndpoints.push({ method: "POST", url: url + "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: orion.toolName || "get_status", arguments: { employee: name } } }, label: "mcp" });
    const attempts = [];
    for (const ep of tryEndpoints) {
      try {
        const r = await fetch(ep.url, {
          method: ep.method,
          headers: {
            "Content-Type": "application/json",
            ...(orion.key ? { Authorization: "Bearer " + orion.key, "X-Api-Key": orion.key } : {}),
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
          signal: AbortSignal.timeout(8000),
        });
        attempts.push({ label: ep.label, url: ep.url, status: r.status });
        if (!r.ok) continue;
        const txt = await r.text();
        let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
        return res.json({ ok: true, source: ep.label, data });
      } catch (e) { attempts.push({ label: ep.label, url: ep.url, error: e.message }); }
    }
    res.json({ ok: false, reason: "Orion svarte ikke på noen av de prøvde endepunktene. Sett eksakt 'Status-sti' i innstillinger.", attempts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MCP streamable HTTP-helper. Sender JSON-RPC og parser både rene JSON-svar
// og SSE-strømmer (text/event-stream). Returnerer { ok, status, data, raw }.
async function mcpCall(url, key, jsonrpcBody) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2024-11-05",
      ...(key ? { Authorization: "Bearer " + key, "X-Api-Key": key } : {}),
    },
    body: JSON.stringify(jsonrpcBody),
    signal: AbortSignal.timeout(30000),
  });
  const ct = r.headers.get("content-type") || "";
  const txt = await r.text();
  if (!r.ok) return { ok: false, status: r.status, raw: txt.slice(0, 400) };
  // SSE: linjer som "data: {...}"
  if (ct.includes("text/event-stream")) {
    const lines = txt.split("\n").filter((l) => l.startsWith("data:"));
    for (const line of lines) {
      const payload = line.slice(5).trim();
      try { const data = JSON.parse(payload); return { ok: true, status: r.status, data, raw: txt.slice(0, 400) }; } catch {}
    }
    return { ok: true, status: r.status, data: { raw: txt.slice(0, 800) }, raw: txt.slice(0, 400) };
  }
  try { return { ok: true, status: r.status, data: JSON.parse(txt), raw: txt.slice(0, 400) }; }
  catch { return { ok: true, status: r.status, data: { raw: txt }, raw: txt.slice(0, 400) }; }
}

// ---- Orion tools/list: oppdager hvilke verktøy som finnes ----
app.get("/api/employee-orion-tools", requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler navn" });
    const cfg = (getConfig().employeeSettings || {})[name];
    const orion = cfg?.orion;
    if (!orion?.url) return res.json({ ok: false, reason: "Mangler Orion-URL" });
    const url = orion.url.replace(/\/+$/, "").replace(/([^:])\/{2,}/g, "$1/");
    const chatPath = orion.chatPath || "/mcp";
    const target = chatPath.startsWith("http") ? chatPath : url + (chatPath.startsWith("/") ? chatPath : "/" + chatPath);
    const result = await mcpCall(target, orion.key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (!result.ok) return res.json({ ok: false, reason: "HTTP " + result.status, snippet: result.raw });
    const tools = result.data?.result?.tools || result.data?.tools || [];
    res.json({ ok: true, tools, raw: result.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Orion discovery: prober vanlige stier og rapporterer hva som svarer ----
app.get("/api/employee-orion-probe", requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler navn" });
    const cfg = (getConfig().employeeSettings || {})[name];
    const orion = cfg?.orion;
    if (!orion?.url) return res.json({ ok: false, reason: "Mangler Orion-URL" });
    const url = orion.url.replace(/\/+$/, "").replace(/([^:])\/{2,}/g, "$1/");
    const probes = [
      { method: "GET", url: url + "/" },
      { method: "GET", url: url + "/.well-known/mcp" },
      { method: "GET", url: url + "/api" },
      { method: "GET", url: url + "/api/tools" },
      { method: "GET", url: url + "/openapi.json" },
      // POST mot vanlige chat-stier (det de fleste web-baserte MCP/agent-hubs eksponerer)
      { method: "POST", url: url + "/api/chat", body: { message: "ping" } },
      { method: "POST", url: url + "/api/v1/chat", body: { message: "ping" } },
      { method: "POST", url: url + "/api/messages", body: { message: "ping" } },
      { method: "POST", url: url + "/api/orion/chat", body: { message: "ping" } },
      { method: "POST", url: url + "/chat", body: { message: "ping" } },
      // MCP standard
      { method: "POST", url: url + "/api/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
      { method: "POST", url: url + "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
      { method: "POST", url: url, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
      // SSE-baserte servere
      { method: "GET", url: url + "/sse" },
      { method: "GET", url: url + "/events" },
    ];
    const results = [];
    for (const p of probes) {
      try {
        const r = await fetch(p.url, {
          method: p.method,
          headers: { "Content-Type": "application/json", ...(orion.key ? { Authorization: "Bearer " + orion.key, "X-Api-Key": orion.key } : {}) },
          body: p.body ? JSON.stringify(p.body) : undefined,
          signal: AbortSignal.timeout(6000),
        });
        const ct = r.headers.get("content-type") || "";
        let snippet = "";
        try { snippet = (await r.text()).slice(0, 200); } catch {}
        results.push({ method: p.method, url: p.url, status: r.status, contentType: ct, snippet });
      } catch (e) {
        results.push({ method: p.method, url: p.url, error: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Per-ansatt timeoversikt (siste 2 + 4 uker, ALT fra Tripletex) ----
app.get("/api/employee-time", requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Mangler navn" });
    res.json(await serveWithSnapshot("emp-time:" + name, async () => {
      const today = new Date();
      const todayStr = ymd(today);
      const from = ymd(new Date(today.getTime() - 28 * 86400000));
      const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
      const nameKeys = (n) => {
        const parts = norm(n).split(" ").filter(Boolean);
        const k = new Set([parts.join(" ")]);
        if (parts.length >= 2) k.add(parts[0] + " " + parts[parts.length - 1]);
        return k;
      };
      const target = nameKeys(name);
      const matches = (full) => { const k = nameKeys(full); for (const x of k) if (target.has(x)) return true; return false; };

      // Finn ansatt-ID (lar oss bruke employeeId-filter for raskere kall)
      const employees = await getEmployees().catch(() => []);
      const emp = employees.find((e) => matches(`${e.firstName || ""} ${e.lastName || ""}`.trim()));
      const empId = emp?.id;

      const timeEntries = await getTimeEntriesDetailed(from, todayStr, empId).catch(() => []);
      const d14 = ymd(new Date(today.getTime() - 14 * 86400000));
      const d28 = ymd(new Date(today.getTime() - 28 * 86400000));

      // Klassifiser hver linje: faktureringsbar prosjekt, intern, fravær (ferie/syk/avspasering)
      const FRAVAER_RE = /\b(ferie|syk|sjuk|fravær|fraver|avspaser|permisjon|legebes|tannlege|barn syk|fri|helligdag|fridag|kurs|opplær|skolering)\b/i;
      const INTERN_RE = /\b(intern|administr|admin|salg|markedsf|markedsforing|hr|møte|mote|sosialt|kontor)\b/i;
      function classify(activityName, projectName) {
        const txt = (activityName || "") + " " + (projectName || "");
        if (FRAVAER_RE.test(txt)) return "fravær";
        if (INTERN_RE.test(txt)) return "intern";
        return "prosjekt";
      }

      function aggregatePeriod(entries) {
        let total = 0, billable = 0, intern = 0, fravar = 0, project = 0;
        const byProject = new Map();
        const byActivity = new Map();
        const byCategory = { prosjekt: 0, intern: 0, fravær: 0 };
        const sample = [];
        for (const e of entries) {
          const h = Number(e.hours) || 0;
          const b = Number(e.chargeableHours) || 0;
          const pname = e.project?.name || "(uten prosjekt)";
          const aname = e.activity?.name || "(uten aktivitet)";
          const cat = classify(aname, pname);
          total += h; billable += b;
          byCategory[cat] = (byCategory[cat] || 0) + h;
          if (cat === "fravær") fravar += h;
          else if (cat === "intern") intern += h;
          else project += h;
          byProject.set(pname, (byProject.get(pname) || 0) + h);
          const akey = aname;
          byActivity.set(akey, (byActivity.get(akey) || 0) + h);
          if (sample.length < 200) sample.push({
            date: e.date, hours: h, billable: b,
            project: pname, projectNumber: e.project?.number || "",
            activity: aname, comment: e.comment || "",
          });
        }
        return {
          totalHours: Math.round(total * 10) / 10,
          billableHours: Math.round(billable * 10) / 10,
          billingRate: total > 0 ? billable / total : 0,
          internHours: Math.round(intern * 10) / 10,
          fravarHours: Math.round(fravar * 10) / 10,
          projectHours: Math.round(project * 10) / 10,
          byCategory,
          projects: [...byProject.entries()].map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 })).sort((a, b) => b.hours - a.hours),
          activities: [...byActivity.entries()].map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 })).sort((a, b) => b.hours - a.hours),
          entries: sample.sort((a, b) => b.date.localeCompare(a.date)),
        };
      }

      const e2 = timeEntries.filter((e) => e.date >= d14);
      const e4 = timeEntries.filter((e) => e.date >= d28);
      return {
        employeeId: empId,
        last2w: aggregatePeriod(e2),
        last4w: aggregatePeriod(e4),
      };
    }, 5 * 60 * 1000));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ---- Orion MCP chat-proxy ----
app.post("/api/employee-chat", requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const message = String(req.body?.message || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];
    if (!name || !message) return res.status(400).json({ error: "Mangler navn eller melding" });
    const cfg = (getConfig().employeeSettings || {})[name];
    const orion = cfg?.orion;
    if (!orion || !orion.enabled || !orion.url) {
      return res.json({ ok: false, reason: "Orion MCP er ikke aktivert for denne ansatte" });
    }
    const url = orion.url.replace(/\/+$/, "").replace(/([^:])\/{2,}/g, "$1/");
    const tool = orion.toolName || "chat";
    const proto = orion.protocol || "auto";

    // Bygg listen av endepunkter å prøve, basert på protokoll-valg
    const tryEndpoints = [];
    if (orion.chatPath) {
      // Brukerdefinert sti — prøv først
      const customUrl = orion.chatPath.startsWith("http") ? orion.chatPath : url + (orion.chatPath.startsWith("/") ? orion.chatPath : "/" + orion.chatPath);
      tryEndpoints.push({ method: "POST", url: customUrl, body: { employee: name, message, history }, label: "custom" });
      tryEndpoints.push({ method: "POST", url: customUrl, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { employee: name, message, history } } }, label: "custom-mcp" });
      tryEndpoints.push({ method: "POST", url: customUrl, body: { messages: [...history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: message }] }, label: "custom-openai" });
    }
    if (proto === "auto" || proto === "mcp") {
      // MCP streamable HTTP — bruk mcpCall med riktige headers
      const mcpTargets = [url + "/mcp", url, url + "/rpc"];
      for (const target of mcpTargets) {
        const mcpResult = await mcpCall(target, orion.key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { employee: name, message, history } } }).catch(() => null);
        if (mcpResult && mcpResult.ok) {
          const data = mcpResult.data;
          const reply = data?.result?.content?.[0]?.text || data?.result?.text || data?.reply || data?.message;
          if (reply) return res.json({ ok: true, reply: String(reply), raw: data, source: "mcp " + target });
        }
      }
    }
    if (proto === "auto" || proto === "rest") {
      tryEndpoints.push({ method: "POST", url: url + "/chat", body: { employee: name, message, history }, label: "rest /chat" });
      tryEndpoints.push({ method: "POST", url: url + "/api/chat", body: { employee: name, message, history }, label: "rest /api/chat" });
      tryEndpoints.push({ method: "POST", url: url + "/message", body: { employee: name, message, history }, label: "rest /message" });
      tryEndpoints.push({ method: "POST", url: url + "/ask", body: { employee: name, question: message, history }, label: "rest /ask" });
      tryEndpoints.push({ method: "POST", url: url + "/query", body: { employee: name, query: message }, label: "rest /query" });
    }
    if (proto === "auto" || proto === "openai") {
      const msgs = [...history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: message }];
      tryEndpoints.push({ method: "POST", url: url + "/v1/chat/completions", body: { messages: msgs }, label: "openai /v1/chat/completions" });
      tryEndpoints.push({ method: "POST", url: url + "/chat/completions", body: { messages: msgs }, label: "openai /chat/completions" });
    }

    const attempts = [];
    for (const ep of tryEndpoints) {
      try {
        const r = await fetch(ep.url, {
          method: ep.method,
          headers: {
            "Content-Type": "application/json",
            ...(orion.key ? { Authorization: "Bearer " + orion.key, "X-Api-Key": orion.key } : {}),
          },
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(30000),
        });
        attempts.push({ label: ep.label, url: ep.url, status: r.status });
        if (!r.ok) continue;
        const txt = await r.text();
        let data; try { data = JSON.parse(txt); } catch { data = { reply: txt }; }
        const reply = data.reply || data.message || data.text
          || data.result?.content?.[0]?.text || data.result?.text
          || data.choices?.[0]?.message?.content || data.response
          || (typeof data === "string" ? data : null);
        return res.json({ ok: true, reply: String(reply || JSON.stringify(data)), raw: data, source: ep.label });
      } catch (e) {
        attempts.push({ label: ep.label, url: ep.url, error: e.message });
      }
    }
    res.json({
      ok: false,
      reason: "Orion svarte ikke på noen av de prøvde endepunktene. Sett eksakt 'Chat-sti' i innstillinger.",
      attempts,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- KI-agent-bestillinger (egen avdeling: KI-agenter) ----
app.get("/api/ki-orders", requireAuth, (req, res) => res.json({ orders: getConfig().kiAgentOrders || [] }));
app.post("/api/ki-orders", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.orders) ? req.body.orders : null;
    if (!list) return res.status(400).json({ error: "Mangler orders-liste" });
    const clean = list.slice(0, 500).map((o) => ({
      id: String(o.id || ("ki_" + Math.random().toString(36).slice(2, 9))),
      agent: String(o.agent || "").slice(0, 60),
      customer: String(o.customer || "").slice(0, 160),
      customerEmail: String(o.customerEmail || "").slice(0, 160),
      orderDate: String(o.orderDate || "").slice(0, 20),
      status: String(o.status || "Aktiv").slice(0, 30),
      monthlyPrice: Math.max(0, Number(o.monthlyPrice) || 0),
      note: String(o.note || "").slice(0, 600),
    }));
    saveConfig({ kiAgentOrders: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- KS-dokumenter per avdeling (prioritert rekkefølge) ----
app.get("/api/dept-ksdocs", requireAuth, (req, res) => res.json({ docs: getConfig().deptKsDocs || {} }));
app.post("/api/dept-ksdocs", requireAuth, (req, res) => {
  try {
    const d = req.body?.docs;
    if (!d || typeof d !== "object") return res.status(400).json({ error: "Mangler docs-objekt" });
    const clean = {};
    for (const [dept, list] of Object.entries(d)) {
      if (!dept || !Array.isArray(list)) continue;
      clean[String(dept).slice(0, 80)] = list.slice(0, 200).map((x) => ({
        id: String(x.id || ("d_" + Math.random().toString(36).slice(2, 9))),
        name: String(x.name || "").slice(0, 200),
        url: String(x.url || "").slice(0, 500),
        code: String(x.code || "").slice(0, 40),
        note: String(x.note || "").slice(0, 600),
      }));
    }
    saveConfig({ deptKsDocs: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/dept-ksdocs/upload", requireAuth, (req, res) => {
  try {
    const dept = String(req.body?.dept || "").trim();
    const filename = String(req.body?.filename || "dokument").slice(0, 160);
    const m = /^data:([^;]+);base64,(.+)$/i.exec(req.body?.dataUrl || "");
    if (!dept || !m) return res.status(400).json({ error: "Ugyldig fil eller mangler dept." });
    const mime = m[1].toLowerCase();
    const ext = mime.includes("pdf") ? "pdf"
      : mime.includes("wordprocessingml") ? "docx"
      : mime.includes("spreadsheetml") ? "xlsx"
      : mime.includes("presentationml") ? "pptx"
      : mime.includes("msword") ? "doc"
      : mime.includes("ms-excel") ? "xls"
      : (filename.split(".").pop() || "bin").toLowerCase().slice(0, 5);
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "Filen er for stor (maks 15 MB)." });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safeDept = String(dept).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
    const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
    const stamp = Date.now();
    const target = `ksdoc-${safeDept}-${stamp}-${safeName}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, target), buf);
    res.json({ ok: true, url: "/uploads/" + target, ext });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Prosjektkoordinering (kanban) per avdeling ----
app.get("/api/dept-kanban", requireAuth, (req, res) => res.json({ kanban: getConfig().deptKanban || {} }));
app.post("/api/dept-kanban", requireAuth, (req, res) => {
  try {
    const k = req.body?.kanban;
    if (!k || typeof k !== "object") return res.status(400).json({ error: "Mangler kanban-objekt" });
    const STAGES = ["1", "2", "3", "4", "5"]; // 1-Reg, 2-Oppstart, 3-Under arbeid, 4-Til kontroll, 5-Utsendt
    const clean = {};
    for (const [dept, obj] of Object.entries(k)) {
      if (!dept || !obj || typeof obj !== "object") continue;
      const cards = Array.isArray(obj.cards) ? obj.cards : [];
      clean[String(dept).slice(0, 80)] = {
        cards: cards.slice(0, 500).map((c) => {
          const stageOwners = {};
          if (c.stageOwners && typeof c.stageOwners === "object") {
            for (const k of STAGES) {
              const v = c.stageOwners[k];
              if (v) stageOwners[k] = String(v).slice(0, 80);
            }
          }
          return {
            id: String(c.id || ("k_" + Math.random().toString(36).slice(2, 9))),
            title: String(c.title || "").slice(0, 200),
            customer: String(c.customer || "").slice(0, 120),
            stage: STAGES.includes(String(c.stage)) ? String(c.stage) : "1",
            projectNumber: String(c.projectNumber || "").slice(0, 30),
            owner: String(c.owner || "").slice(0, 80),
            stageOwners,
            dueDate: String(c.dueDate || "").slice(0, 20),
          };
        }),
      };
    }
    saveConfig({ deptKanban: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Økonomi per avdeling: prosjektregnskap (fast pris / medgått) ----
app.get("/api/dept-economy", requireAuth, async (req, res) => {
  try {
    const dept = String(req.query.dept || "").trim();
    if (!dept) return res.status(400).json({ error: "Mangler dept-parameter" });
    res.json(await serveWithSnapshot("dept-economy:" + dept, async () => {
      const today = new Date();
      const to = ymd(today);
      const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
      const cfg = getConfig();
      const members = (cfg.departmentMembers || {})[dept] || [];
      const memberNorm = new Set(members.map((m) => String(m || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim()));
      const [projects, details, timeEntries, invoices] = await Promise.all([
        getProjects().catch(() => []),
        getProjectsEconomyDetails().catch(() => new Map()),
        getTimeEntries(from, to).catch(() => []),
        getInvoices(from, to).catch(() => []),
      ]);
      // Hours per project total + per medlem (filter til de som har timer fra avdelingsmedlemmer)
      const projHours = new Map();      // projId -> total hours
      const projDeptHours = new Map();  // projId -> dept-medlemmers timer
      for (const e of timeEntries) {
        if (!e.project) continue;
        const pid = e.project.id;
        projHours.set(pid, (projHours.get(pid) || 0) + (e.hours || 0));
        const empName = `${e.employee?.firstName || ""} ${e.employee?.lastName || ""}`.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
        const parts = empName.split(" ").filter(Boolean);
        const flKey = parts.length >= 2 ? (parts[0] + " " + parts[parts.length - 1]) : empName;
        if (memberNorm.has(empName) || memberNorm.has(flKey)) {
          projDeptHours.set(pid, (projDeptHours.get(pid) || 0) + (e.hours || 0));
        }
      }
      // Fakturert per prosjekt (best effort — invoices har customer, ikke project. Vi fordeler per kunde→prosjekt om mulig)
      const projInvoiced = new Map();   // projId -> invoiced (best effort)
      const overrides = (cfg.deptEconomyMeta || {})[dept]?.projects || {};
      const rows = [];
      for (const p of projects) {
        // Bare ta med prosjekter der avdelingen har timer (eller manuell override)
        const deptH = projDeptHours.get(p.id) || 0;
        if (deptH <= 0 && !overrides[p.id]) continue;
        const d = details.get(p.id) || {};
        const ov = overrides[p.id] || {};
        const isFixed = (typeof ov.isFixedPrice === "boolean") ? ov.isFixedPrice : !!d.isFixed;
        const fixedPrice = Number(ov.fixedPrice) || d.fixedPriceAmount || 0;
        const hoursEstimated = Number(ov.hoursEstimated) || d.hoursEstimated || 0;
        const hoursLogged = projHours.get(p.id) || 0;
        rows.push({
          id: p.id,
          number: p.number || "",
          name: p.name || "",
          customer: p.customer?.name || "",
          projectManager: p.projectManager ? `${p.projectManager.firstName || ""} ${p.projectManager.lastName || ""}`.trim() : "",
          type: isFixed ? "Fast pris" : "Medgått",
          isFixedPrice: isFixed,
          fixedPrice,
          hoursEstimated,
          hoursLogged,
          hoursDept: deptH,
          startDate: p.startDate || "",
          endDate: p.endDate || "",
          note: String(ov.note || ""),
          invoiced: projInvoiced.get(p.id) || 0,
        });
      }
      rows.sort((a, b) => b.hoursLogged - a.hoursLogged);
      return {
        updatedAt: new Date().toISOString(),
        dept,
        projects: rows,
        summary: {
          count: rows.length,
          fixedCount: rows.filter((r) => r.isFixedPrice).length,
          medgattCount: rows.filter((r) => !r.isFixedPrice).length,
          totalFixedPrice: rows.reduce((s, r) => s + (r.isFixedPrice ? r.fixedPrice : 0), 0),
          totalHoursLogged: rows.reduce((s, r) => s + r.hoursLogged, 0),
          totalHoursEstimated: rows.reduce((s, r) => s + (r.hoursEstimated || 0), 0),
        },
      };
    }, 10 * 60 * 1000));
  } catch (err) {
    console.error("Feil i /api/dept-economy:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Manuell override av prosjekt-økonomi (fast pris, estimerte timer, type) ----
app.post("/api/dept-economy/meta", requireAuth, (req, res) => {
  try {
    const dept = String(req.body?.dept || "").trim();
    const meta = req.body?.projects;
    if (!dept || !meta || typeof meta !== "object") return res.status(400).json({ error: "Mangler dept eller projects" });
    const all = getConfig().deptEconomyMeta || {};
    const clean = {};
    for (const [pid, ov] of Object.entries(meta)) {
      if (!pid) continue;
      clean[pid] = {
        isFixedPrice: typeof ov.isFixedPrice === "boolean" ? ov.isFixedPrice : undefined,
        fixedPrice: Number(ov.fixedPrice) || 0,
        hoursEstimated: Number(ov.hoursEstimated) || 0,
        note: String(ov.note || "").slice(0, 1000),
      };
    }
    all[dept] = { projects: clean };
    saveConfig({ deptEconomyMeta: all });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- IT-system og verktøy (alle innloggede kan redigere) ----
app.get("/api/itsystems", requireAuth, (req, res) => res.json({ systems: getConfig().itSystems || [] }));
app.post("/api/itsystems", requireAuth, (req, res) => {
  try {
    const list = Array.isArray(req.body?.systems) ? req.body.systems : null;
    if (!list) return res.status(400).json({ error: "Mangler systems-liste" });
    const clean = list.map((s) => ({
      title: String(s.title || "").slice(0, 120),
      url: String(s.url || "").slice(0, 500),
      note: String(s.note || "").slice(0, 600),
      status: String(s.status || "").slice(0, 30),
      statusCls: String(s.statusCls || "").slice(0, 16),
    }));
    saveConfig({ itSystems: clean });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Aktive MCP-agenter (navn + url + key) — kun ledelse ----
app.get("/api/admin/mcpservers", requireAdmin, (req, res) => res.json({ servers: getConfig().mcpServers || [] }));
app.post("/api/admin/mcpservers", requireAdmin, (req, res) => {
  try {
    const list = Array.isArray(req.body?.servers) ? req.body.servers : null;
    if (!list) return res.status(400).json({ error: "Mangler servers-liste" });
    const clean = list
      .map((m) => ({
        name: String(m.name || "").slice(0, 60).trim(),
        url: String(m.url || "").slice(0, 500).trim(),
        key: String(m.key || "").slice(0, 500).trim(),
      }))
      .filter((m) => m.name);
    saveConfig({ mcpServers: clean });
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

// Bakgrunnsjobb: hold snapshots ferske gjennom dagen.
// Disse er de tyngste endepunktene som henter mye fra Tripletex.
const buildBalance = async () => {
  const today = new Date();
  const todayStr = ymd(today);
  const yearStart = new Date(today.getFullYear(), 0, 1);
  return getBalanceSheet(ymd(yearStart), todayStr);
};
startBackgroundWarmer({
  overview: async () => (await import("./src/metrics.js")).buildOverview(),
  economy: async () => (await import("./src/economy.js")).buildEconomy(),
  costs: async () => {
    const today = new Date();
    const to = ymd(today);
    const from = ymd(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
    const [sis, supplierList] = await Promise.all([getSupplierInvoices(from, to), getSuppliers().catch(() => [])]);
    const supContact = new Map();
    for (const s of supplierList) {
      if (!s.name) continue;
      supContact.set(s.name, { email: s.email || s.invoiceEmail || "", phone: s.phoneNumber || s.phone || "", orgNr: s.organizationNumber || "" });
    }
    const bySup = new Map(); let total = 0;
    for (const s of sis) {
      const nm = s.supplier?.name || "Ukjent";
      if (SALARY_RE.test(nm)) continue;
      const id = s.supplier?.id;
      const cost = Math.abs(s.amount || 0);
      const c = supContact.get(nm) || {};
      const cur = bySup.get(nm) || { name: nm, id, cost: 0, count: 0, email: c.email || "", phone: c.phone || "", orgNr: c.orgNr || "" };
      cur.cost += cost; cur.count += 1; total += cost;
      if (id && !cur.id) cur.id = id;
      bySup.set(nm, cur);
    }
    const meta = getConfig().supplierMeta || {};
    const all = [...bySup.values()].sort((a, b) => b.cost - a.cost);
    return { suppliers: all.filter((s) => !(meta[s.name] && meta[s.name].terminated)), terminated: all.filter((s) => meta[s.name] && meta[s.name].terminated), total };
  },
}, 10 * 60 * 1000); // 10 minutter

app.listen(PORT, () => console.log(`Bygg-Kon dashboard kjører på port ${PORT}`));

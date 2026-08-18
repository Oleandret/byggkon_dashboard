// Admin – laster og lagrer innstillinger via /api/admin/settings.
function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = msg; el.hidden = false;
  setTimeout(() => (el.hidden = true), 9000);
}

async function loadSettings() {
  const res = await fetch("/api/admin/settings");
  if (res.status === 403 || res.status === 401) { location.href = "/admin/login"; return; }
  if (!res.ok) { showError("Kunne ikke hente innstillinger."); return; }
  const s = await res.json();
  document.getElementById("companyName").value = s.companyName || "";
  document.getElementById("heroImageUrl").value = s.heroImageUrl || "";
  document.getElementById("weeklyCapacityHours").value = s.weeklyCapacityHours ?? "";
  document.getElementById("refreshSeconds").value = s.refreshSeconds ?? "";
  document.getElementById("cacheTtlMs").value = s.cacheTtlMs ?? "";
  document.getElementById("mcpSet").hidden = !s.hasMcpUrl;
  document.getElementById("jwtSet").hidden = !s.hasTripletexJwt;
  renderTripletexOauth(s.tripletexOauth || {});
  document.getElementById("passwordSet").hidden = !s.hasDashboardPassword;
  // Firmaopplysninger
  ["companyOrgNr", "companyAddress", "companyEmail", "companyPhone", "companyWebsite", "floorPlanUrl"].forEach((k) => {
    if (document.getElementById(k)) document.getElementById(k).value = s[k] || "";
  });
  // Verdier -> tekst
  const vt = document.getElementById("valuesText");
  if (vt) vt.value = (s.values || []).map((v) => `${v.letter} - ${v.text}`).join("\n");
  const dt = document.getElementById("departmentsText");
  if (dt) dt.value = (s.departments || []).join("\n");
  renderMcp(s.mcpServers || []);
  const lp = document.getElementById("logoPreview"), lpw = document.getElementById("logoPreviewWrap");
  if (lp && s.logoUrl) { lp.src = s.logoUrl; lpw.hidden = false; } else if (lpw) { lpw.hidden = true; }
  document.getElementById("settingsPath").textContent = "Lagringssti: " + (s.settingsPath || "");
}

// ---- Logo-opplasting ----
const logoBtn = document.getElementById("logoUpload");
if (logoBtn) logoBtn.addEventListener("click", () => {
  const f = document.getElementById("logoFile").files[0];
  const msg = document.getElementById("logoMsg");
  if (!f) { msg.textContent = "Velg en bildefil først."; return; }
  if (f.size > 4 * 1024 * 1024) { msg.textContent = "Logoen er for stor (maks 4 MB)."; return; }
  msg.textContent = "Laster opp …";
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch("/api/admin/upload-logo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: reader.result }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Opplasting feilet");
      const lp = document.getElementById("logoPreview"), lpw = document.getElementById("logoPreviewWrap");
      lp.src = d.logoUrl; lpw.hidden = false;
      msg.textContent = "✓ Lastet opp og lagret. Vises i toppen på dashbordet.";
    } catch (e) { msg.textContent = "Feil: " + e.message; }
  };
  reader.readAsDataURL(f);
});

// ---- MCP-servere ----
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function renderMcp(list) {
  const el = document.getElementById("mcpList");
  if (!el) return;
  el.innerHTML = (list.length ? list : []).map((m, i) => `
    <div class="mcp-row" data-i="${i}" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <input class="mcp-name" placeholder="Navn (f.eks. Loki)" value="${esc(m.name)}" style="flex:1;min-width:120px" />
      <input class="mcp-url" placeholder="https://…" value="${esc(m.url)}" style="flex:2;min-width:200px" />
      <button type="button" class="btn-ghost mcp-del">🗑</button>
    </div>`).join("");
}
function collectMcp() {
  return [...document.querySelectorAll("#mcpList .mcp-row")].map((r) => ({
    name: r.querySelector(".mcp-name").value.trim(),
    url: r.querySelector(".mcp-url").value.trim(),
  })).filter((m) => m.name || m.url);
}
document.getElementById("mcpAdd")?.addEventListener("click", () => {
  const el = document.getElementById("mcpList");
  el.insertAdjacentHTML("beforeend", `<div class="mcp-row" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><input class="mcp-name" placeholder="Navn (f.eks. Loki)" style="flex:1;min-width:120px" /><input class="mcp-url" placeholder="https://…" style="flex:2;min-width:200px" /><button type="button" class="btn-ghost mcp-del">🗑</button></div>`);
});
document.getElementById("mcpList")?.addEventListener("click", (e) => { if (e.target.classList.contains("mcp-del")) e.target.closest(".mcp-row").remove(); });

document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  // Bare send med felter som har verdi (tomme token/passord beholdes på serveren).
  const payload = {};
  const fields = ["companyName", "heroImageUrl", "tripletexMcpUrl",
    "dashboardPassword", "weeklyCapacityHours", "refreshSeconds", "cacheTtlMs",
    "companyOrgNr", "companyAddress", "companyEmail", "companyPhone", "companyWebsite"];
  for (const k of fields) {
    if (!f[k]) continue;
    const v = f[k].value;
    if (v !== "") payload[k] = v;
  }
  // Verdier fra tekstfelt: "B - Tekst" per linje
  const vt = document.getElementById("valuesText");
  if (vt) {
    payload.values = vt.value.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return null;
      const m = t.match(/^(.{1,3}?)\s*[-–:]\s*(.+)$/) || t.match(/^(\S+)\s+(.+)$/);
      return m ? { letter: m[1].trim(), text: m[2].trim() } : { letter: "", text: t };
    }).filter(Boolean);
  }
  const dt = document.getElementById("departmentsText");
  if (dt) payload.departments = dt.value.split("\n").map((l) => l.trim()).filter(Boolean);
  payload.mcpServers = collectMcp();
  const res = await fetch("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { const er = await res.json().catch(() => ({})); showError(er.error || "Lagring feilet."); return; }
  const msg = document.getElementById("savedMsg");
  msg.hidden = false; setTimeout(() => (msg.hidden = true), 3000);
  // Tøm token/passord-felt og oppdater "satt"-merker
  ["tripletexMcpUrl", "dashboardPassword"].forEach((k) => (f[k].value = ""));
  loadSettings();
});

// ---- Opplasting av plantegning ----
const upBtn = document.getElementById("floorPlanUpload");
if (upBtn) {
  upBtn.addEventListener("click", () => {
    const f = document.getElementById("floorPlanFile").files[0];
    const msg = document.getElementById("floorPlanUploadMsg");
    if (!f) { msg.textContent = "Velg en bildefil først."; return; }
    if (f.size > 12 * 1024 * 1024) { msg.textContent = "Bildet er for stort (maks 12 MB)."; return; }
    msg.textContent = "Laster opp …";
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch("/api/admin/upload-floorplan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl: reader.result }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || "Opplasting feilet");
        document.getElementById("floorPlanUrl").value = d.floorPlanUrl || "";
        msg.textContent = "✓ Lastet opp og lagret.";
      } catch (e) { msg.textContent = "Feil: " + e.message; }
    };
    reader.readAsDataURL(f);
  });
}

// ---- OAuth mot Tripletex sin MCP-server ----
function renderTripletexOauth(o) {
  const badge = document.getElementById("ttxConnected");
  const status = document.getElementById("ttxStatus");
  const connect = document.getElementById("ttxConnect");
  const disconnect = document.getElementById("ttxDisconnect");
  if (!status) return;
  badge.hidden = !o.connected;
  disconnect.hidden = !o.connected;
  if (o.connected) {
    const since = o.connectedAt ? new Date(o.connectedAt).toLocaleString("nb-NO") : "";
    status.textContent = since
      ? `Tilkoblet Tripletex siden ${since}. Tilgangen fornyes automatisk.`
      : "Tilkoblet Tripletex. Tilgangen fornyes automatisk.";
    connect.textContent = "Koble til på nytt";
  } else {
    status.textContent = "Ikke tilkoblet. Trykk «Koble til Tripletex» for å logge inn.";
    connect.textContent = "Koble til Tripletex";
  }
}

document.getElementById("ttxDisconnect")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await fetch("/api/admin/tripletex/disconnect", { method: "POST" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    loadSettings();
  } catch (err) {
    showError("Kunne ikke koble fra: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// Beskjed etter at Tripletex har sendt oss tilbake fra innloggingen.
(function showTripletexResult() {
  const ttx = new URLSearchParams(location.search).get("ttx");
  if (!ttx) return;
  if (ttx === "ok") {
    const msg = document.getElementById("savedMsg");
    if (msg) { msg.textContent = "✓ Tilkoblet Tripletex"; msg.hidden = false; setTimeout(() => (msg.hidden = true), 6000); }
  } else {
    showError("Tilkobling til Tripletex feilet: " + ttx);
  }
  history.replaceState(null, "", location.pathname);
})();

// ---- Test av Tripletex-tilkoblingen ----
const TEST_MARK = { ok: "✓", warn: "!", error: "✕", skipped: "–" };
const TEST_COLOR = { ok: "#1e8b6f", warn: "#b8860b", error: "#c0392b", skipped: "#9aa0a6" };

function renderTestSteps(d) {
  const rows = (d.steps || []).map((s) => `
    <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid rgba(3,2,19,.08)">
      <span style="color:${TEST_COLOR[s.status] || "#9aa0a6"};font-weight:700;line-height:1.4">${TEST_MARK[s.status] || "?"}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${esc(s.name)}${s.ms != null ? ` <span style="font-weight:400;color:#9aa0a6">${s.ms} ms</span>` : ""}</div>
        <div style="color:#4a4a55;word-break:break-word">${esc(s.detail)}</div>
        ${s.hint ? `<div style="margin-top:4px;color:#8a6d1f">→ ${esc(s.hint)}</div>` : ""}
      </div>
    </div>`).join("");
  const hasError = (d.steps || []).some((s) => s.status === "error");
  const head = d.ok
    ? `<div style="color:#1e8b6f;font-weight:700">✓ Tilkoblingen virker</div>`
    : hasError
      ? `<div style="color:#c0392b;font-weight:700">✕ Tilkoblingen virker ikke</div>`
      : `<div style="color:#b8860b;font-weight:700">! Tilkoblingen virker, men ikke alt dashbordet trenger er på plass</div>`;
  return `${head}<div style="margin-top:10px">${rows}</div>`;
}

document.getElementById("testRun")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const box = document.getElementById("testResults");
  btn.disabled = true;
  box.innerHTML = `<div class="hint">Kjører test … (kan ta noen sekunder)</div>`;
  try {
    const res = await fetch("/api/admin/test-connection", { method: "POST" });
    if (res.status === 401 || res.status === 403) { location.href = "/admin/login"; return; }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `Testen kunne ikke kjøres (HTTP ${res.status}).`);
    box.innerHTML = renderTestSteps(d);
  } catch (err) {
    box.innerHTML = `<div style="color:#c0392b">Testen kunne ikke kjøres: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ---- Faner i innstillinger ----
document.querySelectorAll("#setTabs .set-card, #setTabs .set-tab").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#setTabs .set-card, #setTabs .set-tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".set-panel").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById("set-" + b.dataset.set)?.classList.add("active");
    // Scroll inn til toppen av panelet for å se innholdet
    document.getElementById("set-" + b.dataset.set)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

loadSettings();

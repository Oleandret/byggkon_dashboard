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
  const fields = ["companyName", "heroImageUrl", "regnskapsagentMcpUrl",
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
  ["regnskapsagentMcpUrl", "dashboardPassword"].forEach((k) => (f[k].value = ""));
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

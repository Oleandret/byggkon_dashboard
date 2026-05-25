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
  document.getElementById("settingsPath").textContent = "Lagringssti: " + (s.settingsPath || "");
}

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

loadSettings();

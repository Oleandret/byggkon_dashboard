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
  document.getElementById("settingsPath").textContent = "Lagringssti: " + (s.settingsPath || "");
}

document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  // Bare send med felter som har verdi (tomme token/passord beholdes på serveren).
  const payload = {};
  const fields = ["companyName", "heroImageUrl", "regnskapsagentMcpUrl",
    "dashboardPassword", "weeklyCapacityHours", "refreshSeconds", "cacheTtlMs"];
  for (const k of fields) {
    const v = f[k].value;
    if (v !== "") payload[k] = v;
  }
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

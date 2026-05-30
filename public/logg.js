// Logg-fane: viser server-logg fra in-memory buffer
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tab = document.querySelector('.tab[data-tab="logg"]');
  if (!tab) return;

  let autoTimer = null;
  let loaded = false;

  async function load() {
    const level = document.getElementById("logLevelFilter")?.value || "";
    const search = document.getElementById("logSearch")?.value || "";
    const list = document.getElementById("logList");
    const counts = document.getElementById("logCounts");
    try {
      const params = new URLSearchParams({ limit: "300" });
      if (level) params.set("level", level);
      if (search) params.set("search", search);
      const r = await fetch("/api/logs?" + params.toString());
      const d = await r.json();
      counts.innerHTML = `
        <span class="log-count log-info">${d.counts.info} info</span>
        <span class="log-count log-warn">${d.counts.warn} warn</span>
        <span class="log-count log-error">${d.counts.error} error</span>
        <span class="subnote">${d.logs.length} viste (av ${d.total} totalt)</span>
      `;
      if (!d.logs.length) {
        list.innerHTML = `<div class="empty">Ingen logghendelser ennå.</div>`;
        return;
      }
      list.innerHTML = d.logs.map((l) => {
        const time = new Date(l.ts).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const date = new Date(l.ts).toLocaleDateString("nb-NO", { day: "2-digit", month: "2-digit" });
        return `<div class="log-entry log-${esc(l.level)}">
          <div class="log-meta">
            <span class="log-level-badge log-lvl-${esc(l.level)}">${esc(l.level)}</span>
            <span class="log-time" title="${esc(l.ts)}">${esc(date)} ${esc(time)}</span>
          </div>
          <pre class="log-message">${esc(l.message)}</pre>
        </div>`;
      }).join("");
    } catch (e) {
      list.innerHTML = `<div class="empty">Kunne ikke hente logg: ${esc(e.message)}</div>`;
    }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(load, 5000);
    document.getElementById("logAutoToggle").textContent = "⏱ Auto på (5s)";
    document.getElementById("logAutoToggle").classList.add("active");
  }
  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    document.getElementById("logAutoToggle").textContent = "⏱ Auto av";
    document.getElementById("logAutoToggle").classList.remove("active");
  }

  tab.addEventListener("click", () => {
    if (!loaded) { loaded = true; load(); }
  });

  document.addEventListener("click", async (e) => {
    if (e.target.id === "logReload") return load();
    if (e.target.id === "logAutoToggle") return autoTimer ? stopAuto() : startAuto();
    if (e.target.id === "logClear") {
      if (!confirm("Tømme logg-buffer på server?")) return;
      await fetch("/api/logs/clear", { method: "POST" });
      load();
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "logLevelFilter" || e.target.id === "logSearch") {
      clearTimeout(window._logSearchT);
      window._logSearchT = setTimeout(load, 300);
    }
  });
})();

// Live status for AI-agentene (Loki, Nova ...) – blinkende "tilkoblet"-badge.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const containers = document.querySelectorAll(".js-agent-status");
  if (!containers.length) return;

  function render(agents) {
    const html = (agents || []).map((a) => {
      const up = a.up;
      return `<a class="agent-badge ${up ? "up" : "down"}" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.url)}">
        <span class="agent-dot"></span>
        <span class="agent-text">${esc(a.name)} ${up ? "er tilkoblet" : "er frakoblet"}</span>
      </a>`;
    }).join("");
    containers.forEach((c) => (c.innerHTML = html));
  }

  async function poll() {
    try {
      const res = await fetch("/api/agent-status");
      if (!res.ok) return;
      const d = await res.json();
      render(d.agents);
    } catch { /* stille */ }
  }
  poll();
  setInterval(poll, 30000);
})();

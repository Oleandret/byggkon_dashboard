// Bygg-Kon AI Hub – nav-og-eiker-graf: sentralnode med agentene rundt, live status.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const wrap = document.getElementById("aiHub");
  if (!wrap) return;

  function render(agents) {
    const n = agents.length || 1;
    const cx = 50, cy = 50, r = 36; // prosent av containeren
    const pts = agents.map((a, i) => {
      const ang = (-90 + i * 360 / n) * Math.PI / 180;
      return { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), a };
    });
    const svg = `<svg class="hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none">` +
      pts.map((p) => `<line x1="50" y1="50" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}" class="hub-line ${p.a.up ? "up" : "down"}" />`).join("") +
      `</svg>`;
    const center = `<div class="hub-center"><span class="hub-center-dot"></span><span class="hub-center-txt">Bygg-Kon<br>AI Hub</span></div>`;
    const nodes = pts.map((p) => {
      const tag = p.a.url ? "a" : "div";
      const href = p.a.url ? ` href="${esc(p.a.url)}" target="_blank" rel="noopener"` : "";
      return `<${tag} class="hub-node ${p.a.up ? "up" : "down"}" style="left:${p.x}%;top:${p.y}%"${href} title="${p.a.up ? "Tilkoblet" : "Frakoblet"}">
        <span class="hub-dot"></span><span class="hub-name">${esc(p.a.name)}</span>
      </${tag}>`;
    }).join("");
    wrap.innerHTML = svg + center + nodes;
  }

  async function load() {
    let agents = [];
    try { const d = await (await fetch("/api/agent-status")).json(); agents = d.agents || []; } catch {}
    if (agents.length) render(agents);
  }
  load();
  setInterval(load, 30000);
})();

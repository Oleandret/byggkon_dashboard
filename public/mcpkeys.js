// MCP-nøkler til kunder – redigerbar, låsbar tabell. Lagres server-side.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const AGENTS = ["Nova", "Loki", "Hilde", "Orion"];
  const tbl = document.getElementById("mcpTable");
  if (!tbl) return;
  const editBtn = document.getElementById("mcpEdit"), addBtn = document.getElementById("mcpAdd"), saveBtn = document.getElementById("mcpSave");
  let rows = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); if (!el) return; el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  const agentSelect = (val) => `<select class="kon-f" data-f="agent"><option value=""${val ? "" : " selected"}>– velg –</option>${AGENTS.map((a) => `<option value="${a}"${val === a ? " selected" : ""}>${a}</option>`).join("")}</select>`;

  function render() {
    const head = `<thead><tr><th>Kundenavn</th><th>Firmanavn</th><th>E-post</th><th>Telefon</th><th>Bestilt</th><th>KI-agent</th><th>MCP-nøkkel</th><th>Sagt opp</th><th>Notat</th>${editing ? "<th></th>" : ""}</tr></thead>`;
    const body = rows.length ? rows.map((r, i) => editing
      ? `<tr data-i="${i}">
          <td><input class="kon-f" data-f="customer" value="${esc(r.customer)}" placeholder="Kundenavn" /></td>
          <td><input class="kon-f" data-f="company" value="${esc(r.company)}" placeholder="Firmanavn" /></td>
          <td><input class="kon-f" data-f="email" type="email" value="${esc(r.email)}" placeholder="E-post" /></td>
          <td><input class="kon-f" data-f="phone" value="${esc(r.phone)}" placeholder="Telefon" style="width:120px" /></td>
          <td><input class="kon-f" data-f="date" type="date" value="${esc(r.date)}" /></td>
          <td>${agentSelect(r.agent)}</td>
          <td><input class="kon-f" data-f="key" value="${esc(r.key)}" placeholder="MCP-nøkkel" /></td>
          <td style="text-align:center"><input type="checkbox" data-f="cancelled" ${r.cancelled ? "checked" : ""} /></td>
          <td><input class="kon-f" data-f="note" value="${esc(r.note)}" placeholder="Notat" /></td>
          <td><button class="btn-ghost mcp-del">🗑</button></td></tr>`
      : `<tr${r.cancelled ? ' style="opacity:.55"' : ""}><td><b>${esc(r.customer) || "—"}</b></td><td>${esc(r.company) || "—"}</td><td>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</td><td>${esc(r.phone) || "—"}</td><td>${esc(r.date) || "—"}</td><td>${r.agent ? `<span class="cost-cat">${esc(r.agent)}</span>` : "—"}</td><td><code>${esc(r.key) || "—"}</code></td><td style="text-align:center">${r.cancelled ? "✅ Sagt opp" : "—"}</td><td>${esc(r.note) || "—"}</td></tr>`
    ).join("") : `<tr><td class="empty" colspan="${editing ? 10 : 9}">Ingen MCP-nøkler lagt inn ennå.</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  const onChange = (e) => { const r = e.target.closest("tr[data-i]"); if (!r || !e.target.dataset.f) return; const f = e.target.dataset.f; rows[Number(r.dataset.i)][f] = e.target.type === "checkbox" ? e.target.checked : e.target.value; };
  tbl.addEventListener("input", onChange);
  tbl.addEventListener("change", onChange);
  tbl.addEventListener("click", (e) => { if (!e.target.classList.contains("mcp-del")) return; rows.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { rows.unshift({ customer: "", company: "", email: "", phone: "", date: "", agent: "", key: "", cancelled: false, note: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try { const res = await fetch("/api/mcpkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mcpKeys: rows }) });
      if (!res.ok) throw new Error("Lagring feilet"); saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/mcpkeys")).json(); rows = (d.mcpKeys || []).map((r) => ({ ...r })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente MCP-nøkler: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="mcpkeys"]');
  if (tab) tab.addEventListener("click", load);
})();

// KI-agenter: statusoversikt (pågående/ferdig/idé) + forslag fra ansatte.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const board = document.getElementById("kiBoard");
  if (!board) return;
  const editBtn = document.getElementById("kiEdit"), addBtn = document.getElementById("kiAdd"), saveBtn = document.getElementById("kiSave");
  const COLS = [["pågående", "Pågående", "wip"], ["ferdig", "Ferdig", "done"], ["idé", "Ideer", "idea"]];
  let agents = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    board.classList.toggle("editing", editing);
    board.innerHTML = COLS.map(([key, label, cls]) => {
      const items = agents.map((a, i) => [a, i]).filter(([a]) => a.status === key);
      const cards = items.map(([a, i]) => editing
        ? `<div class="ki-card edit" data-i="${i}">
             <input class="kon-f" data-f="name" value="${esc(a.name)}" placeholder="Navn" />
             <input class="kon-f" data-f="email" value="${esc(a.email)}" placeholder="e-post / id" />
             <textarea class="kon-f" data-f="desc" rows="2" placeholder="Hva gjør agenten?">${esc(a.desc)}</textarea>
             <select class="kon-f" data-f="status">${COLS.map(([k, l]) => `<option value="${k}"${a.status === k ? " selected" : ""}>${l}</option>`).join("")}</select>
             <button class="btn-ghost ki-del">🗑</button>
           </div>`
        : `<div class="ki-card">
             <div class="ki-name">${esc(a.name)}</div>
             ${a.email ? `<div class="ki-email">${esc(a.email)}</div>` : ""}
             ${a.desc ? `<div class="ki-desc">${esc(a.desc)}</div>` : ""}
           </div>`).join("") || `<div class="empty">Ingen.</div>`;
      return `<div class="ki-col ki-${cls}"><h3 class="ki-col-h">${label} <span class="ki-count">${items.length}</span></h3>${cards}</div>`;
    }).join("");
  }
  board.addEventListener("input", (e) => { const c = e.target.closest(".ki-card"); if (c && e.target.dataset.f) agents[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  board.addEventListener("change", (e) => { const c = e.target.closest(".ki-card"); if (c && e.target.dataset.f === "status") render(); });
  board.addEventListener("click", (e) => { if (!e.target.classList.contains("ki-del")) return; agents.splice(Number(e.target.closest(".ki-card").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { agents.push({ name: "", email: "", desc: "", status: "idé" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/kiagents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agents }) });
      if (!res.ok) throw new Error("Lagring feilet");
      saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });

  // ---- Forslag fra ansatte ----
  const sugEl = document.getElementById("kiSuggestions");
  let suggestions = [];
  function renderSug() {
    sugEl.innerHTML = suggestions.length ? suggestions.slice().reverse().map((s) =>
      `<div class="sug-item"><span>${esc(s.text)}${s.by ? ` <span class="sug-by">— ${esc(s.by)}</span>` : ""}</span><button class="sug-del" data-id="${esc(s.id)}">✕</button></div>`
    ).join("") : `<div class="empty">Ingen forslag ennå.</div>`;
  }
  document.getElementById("kiSuggestBtn").addEventListener("click", async () => {
    const inp = document.getElementById("kiSuggestInput"), byEl = document.getElementById("kiSuggestBy");
    const text = inp.value.trim(); if (!text) return;
    try {
      const res = await fetch("/api/kisuggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, by: byEl.value.trim() }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Feil");
      suggestions.push({ id: "tmp" + Date.now(), text, by: byEl.value.trim() }); inp.value = ""; renderSug();
      loadSug(true);
    } catch (e2) { err("Kunne ikke sende forslag: " + e2.message); }
  });
  sugEl.addEventListener("click", async (e) => {
    const b = e.target.closest(".sug-del"); if (!b) return;
    try { await fetch("/api/kisuggestions/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.id }) }); suggestions = suggestions.filter((s) => s.id !== b.dataset.id); renderSug(); } catch {}
  });
  async function loadSug(force) { try { const d = await (await fetch("/api/kisuggestions")).json(); suggestions = d.suggestions || []; renderSug(); } catch {} }

  async function load() {
    if (loaded) return; loaded = true;
    try { const d = await (await fetch("/api/kiagents")).json(); agents = (d.agents || []).map((a) => ({ ...a })); render(); } catch (e2) { err("Kunne ikke hente agenter: " + e2.message); }
    loadSug();
  }
  const tab = document.querySelector('.tab[data-tab="kiagenter"]');
  if (tab) tab.addEventListener("click", load);
})();

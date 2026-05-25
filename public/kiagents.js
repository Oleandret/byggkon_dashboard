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

  // ---- Forslag fra ansatte (redigerbar + rangerbar) ----
  const sugEl = document.getElementById("kiSuggestions");
  const sugEdit = document.getElementById("kiSugEdit"), sugSave = document.getElementById("kiSugSave");
  let suggestions = [], sugEditing = false;
  const IMP = ["Høy", "Middels", "Lav"], PROD = ["Idé", "Under utvikling", "Klar", "I produksjon"], SELL = ["Ja", "Kanskje", "Nei"];
  const impRank = { "Høy": 0, "Middels": 1, "Lav": 2 };
  const opts = (arr, v) => arr.map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join("");
  function sortedSug() { return suggestions.slice().sort((a, b) => (impRank[a.importance] ?? 1) - (impRank[b.importance] ?? 1) || (b.ts || 0) - (a.ts || 0)); }
  function impCls(i) { return i === "Høy" ? "imp-high" : i === "Lav" ? "imp-low" : "imp-mid"; }
  function renderSug() {
    const list = sortedSug();
    if (!list.length) { sugEl.innerHTML = `<div class="empty">Ingen forslag ennå.</div>`; return; }
    sugEl.innerHTML = list.map((s) => {
      const i = suggestions.indexOf(s);
      return sugEditing
        ? `<div class="ki-sug edit" data-i="${i}">
             <textarea class="kon-f" data-f="text" rows="2" placeholder="Forslag …">${esc(s.text)}</textarea>
             <div class="ki-sug-fields">
               <label>Viktighet <select class="kon-f" data-f="importance">${opts(IMP, s.importance)}</select></label>
               <label>Produksjon <select class="kon-f" data-f="production">${opts(PROD, s.production)}</select></label>
               <label>Kan selges <select class="kon-f" data-f="sellable">${opts(SELL, s.sellable)}</select></label>
               <input class="kon-f" data-f="by" value="${esc(s.by)}" placeholder="Navn" style="max-width:120px" />
               <button class="btn-ghost sug-del" data-id="${esc(s.id)}">🗑</button>
             </div>
           </div>`
        : `<div class="ki-sug">
             <div class="ki-sug-top"><span class="imp-badge ${impCls(s.importance)}">${esc(s.importance || "Middels")}</span><span class="ki-sug-text">${esc(s.text)}</span></div>
             <div class="ki-sug-meta">
               <span class="ki-tag">⚙ ${esc(s.production || "Idé")}</span>
               <span class="ki-tag${s.sellable === "Ja" ? " sell-yes" : ""}">💰 Selges: ${esc(s.sellable || "Nei")}</span>
               ${s.by ? `<span class="sug-by">— ${esc(s.by)}</span>` : ""}
             </div>
           </div>`;
    }).join("");
  }
  sugEl.addEventListener("input", (e) => { const c = e.target.closest(".ki-sug"); if (c && e.target.dataset.f) suggestions[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  sugEl.addEventListener("change", (e) => { const c = e.target.closest(".ki-sug"); if (c && e.target.dataset.f) { suggestions[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; } });
  sugEl.addEventListener("click", async (e) => {
    const b = e.target.closest(".sug-del"); if (!b) return;
    suggestions = suggestions.filter((s) => s.id !== b.dataset.id); renderSug();
  });
  sugEdit.addEventListener("click", () => { sugEditing = !sugEditing; sugEdit.textContent = sugEditing ? "🔒 Lås" : "🔓 Rediger / ranger"; sugSave.hidden = !sugEditing; renderSug(); });
  sugSave.addEventListener("click", async () => {
    sugSave.disabled = true;
    try { const res = await fetch("/api/kisuggestions/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestions }) });
      if (!res.ok) throw new Error("Lagring feilet"); sugSave.textContent = "Lagret ✓"; setTimeout(() => (sugSave.textContent = "Lagre"), 2000); await loadSug(true);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { sugSave.disabled = false; }
  });
  document.getElementById("kiSuggestBtn").addEventListener("click", async () => {
    const inp = document.getElementById("kiSuggestInput"), byEl = document.getElementById("kiSuggestBy");
    const text = inp.value.trim(); if (!text) return;
    try {
      const res = await fetch("/api/kisuggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, by: byEl.value.trim() }) });
      if (!res.ok) throw new Error("Feil");
      inp.value = ""; await loadSug(true);
    } catch (e2) { err("Kunne ikke sende forslag: " + e2.message); }
  });
  async function loadSug(force) { try { const d = await (await fetch("/api/kisuggestions")).json(); suggestions = (d.suggestions || []).map((s) => ({ ...s })); renderSug(); } catch {} }

  async function load() {
    if (loaded) return; loaded = true;
    try { const d = await (await fetch("/api/kiagents")).json(); agents = (d.agents || []).map((a) => ({ ...a })); render(); } catch (e2) { err("Kunne ikke hente agenter: " + e2.message); }
    loadSug();
  }
  const tab = document.querySelector('.tab[data-tab="kiagenter"]');
  if (tab) tab.addEventListener("click", load);
})();

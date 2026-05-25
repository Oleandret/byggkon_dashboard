// Faglig utviklingsmål 2026 per ansatt – redigerbar, låsbar liste.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const listEl = document.getElementById("dgList");
  if (!listEl) return;
  const editBtn = document.getElementById("dgEdit"), addBtn = document.getElementById("dgAdd"), saveBtn = document.getElementById("dgSave");
  let rows = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function bullets(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return `<div class="empty">Ingen mål lagt inn.</div>`;
    return `<ul class="dg-bullets">${lines.map((l) => `<li>${esc(l.replace(/^[-•*]\s*/, ""))}</li>`).join("")}</ul>`;
  }

  function render() {
    listEl.innerHTML = rows.length ? rows.map((r, i) => editing
      ? `<div class="dg-item edit" data-i="${i}">
           <input class="kon-f dg-name" data-f="name" value="${esc(r.name)}" placeholder="Navn" />
           <textarea class="kon-f dg-goals" data-f="goals" rows="4" placeholder="Ett mål per linje …">${esc(r.goals)}</textarea>
           <button class="btn-ghost dg-del">🗑</button>
         </div>`
      : `<div class="dg-item"><div class="dg-name-lbl">${esc(r.name) || "—"}</div>${bullets(r.goals)}</div>`
    ).join("") : `<div class="empty">Ingen ansatte lagt inn ennå. Lås opp og klikk «+ Ansatt».</div>`;
  }
  listEl.addEventListener("input", (e) => { const c = e.target.closest(".dg-item"); if (c && e.target.dataset.f) rows[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  listEl.addEventListener("click", (e) => { if (!e.target.classList.contains("dg-del")) return; rows.splice(Number(e.target.closest(".dg-item").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { rows.push({ name: "", goals: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/devgoals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ devGoals: rows }) });
      if (!res.ok) throw new Error("Lagring feilet");
      saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/devgoals")).json(); rows = (d.devGoals || []).map((r) => ({ ...r })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente mål: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="fagmoter"]');
  if (tab) tab.addEventListener("click", load);
  load();
})();

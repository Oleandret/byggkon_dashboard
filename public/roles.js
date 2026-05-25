// Ansattes rollebeskrivelse – redigerbar, låsbar liste per ansatt.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const listEl = document.getElementById("roleList");
  if (!listEl) return;
  const editBtn = document.getElementById("roleEdit"), addBtn = document.getElementById("roleAdd"), saveBtn = document.getElementById("roleSave");
  let rows = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    listEl.innerHTML = rows.length ? rows.map((r, i) => editing
      ? `<div class="role-item edit" data-i="${i}">
           <input class="kon-f role-name" data-f="name" value="${esc(r.name)}" placeholder="Navn" />
           <input class="kon-f role-role" data-f="role" value="${esc(r.role)}" placeholder="Rolle / tittel" />
           <textarea class="kon-f role-desc" data-f="description" rows="4" placeholder="Rollebeskrivelse – ansvar og oppgaver …">${esc(r.description)}</textarea>
           <button class="btn-ghost role-del">🗑</button>
         </div>`
      : `<div class="role-item">
           <div class="role-head"><span class="role-name-lbl">${esc(r.name) || "—"}</span>${r.role ? `<span class="role-role-lbl">${esc(r.role)}</span>` : ""}</div>
           <div class="role-desc-lbl">${esc(r.description) || "<span class='empty'>Ingen beskrivelse.</span>"}</div>
         </div>`
    ).join("") : `<div class="empty">Ingen rollebeskrivelser ennå. Lås opp og klikk «+ Ansatt».</div>`;
  }
  listEl.addEventListener("input", (e) => { const c = e.target.closest(".role-item"); if (c && e.target.dataset.f) rows[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  listEl.addEventListener("click", (e) => { if (!e.target.classList.contains("role-del")) return; rows.splice(Number(e.target.closest(".role-item").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { rows.push({ name: "", role: "", description: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/roledescriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: rows }) });
      if (!res.ok) throw new Error("Lagring feilet");
      saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/roledescriptions")).json(); rows = (d.roles || []).map((r) => ({ ...r })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente roller: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="hr"]');
  if (tab) tab.addEventListener("click", load);
})();

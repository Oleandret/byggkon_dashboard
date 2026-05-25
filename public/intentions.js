// Intensjonsavtaler / samarbeidspartnere – redigerbar, låsbar tabell.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tbl = document.getElementById("intTable");
  if (!tbl) return;
  const editBtn = document.getElementById("intEdit"), addBtn = document.getElementById("intAdd"), saveBtn = document.getElementById("intSave");
  let rows = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    const head = `<thead><tr><th>Selskap</th><th>Kontaktperson</th><th>Type avtale</th><th>Status</th><th>Dato</th><th>Notat</th>${editing ? "<th></th>" : ""}</tr></thead>`;
    const body = rows.length ? rows.map((r, i) => editing
      ? `<tr data-i="${i}">
          <td><input class="kon-f" data-f="company" value="${esc(r.company)}" placeholder="Selskap" /></td>
          <td><input class="kon-f" data-f="contact" value="${esc(r.contact)}" placeholder="Kontakt" /></td>
          <td><input class="kon-f" data-f="type" value="${esc(r.type)}" placeholder="Type avtale" /></td>
          <td><input class="kon-f" data-f="status" value="${esc(r.status)}" placeholder="Status" style="width:110px" /></td>
          <td><input class="kon-f" data-f="date" type="date" value="${esc(r.date)}" /></td>
          <td><input class="kon-f" data-f="note" value="${esc(r.note)}" placeholder="Notat" /></td>
          <td><button class="btn-ghost int-del">🗑</button></td></tr>`
      : `<tr><td><b>${esc(r.company) || "—"}</b></td><td>${esc(r.contact) || "—"}</td><td>${esc(r.type) || "—"}</td><td>${r.status ? `<span class="cost-cat">${esc(r.status)}</span>` : "—"}</td><td>${esc(r.date) || "—"}</td><td>${esc(r.note) || "—"}</td></tr>`
    ).join("") : `<tr><td class="empty" colspan="${editing ? 7 : 6}">Ingen intensjonsavtaler lagt inn ennå.</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  tbl.addEventListener("input", (e) => { const r = e.target.closest("tr[data-i]"); if (r && e.target.dataset.f) rows[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; });
  tbl.addEventListener("click", (e) => { if (!e.target.classList.contains("int-del")) return; rows.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { rows.unshift({ company: "", contact: "", type: "", status: "", date: "", note: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try { const res = await fetch("/api/intentions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentions: rows }) });
      if (!res.ok) throw new Error("Lagring feilet"); saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/intentions")).json(); rows = (d.intentions || []).map((r) => ({ ...r })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente intensjonsavtaler: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="intensjonsavtaler"]');
  if (tab) tab.addEventListener("click", load);
})();

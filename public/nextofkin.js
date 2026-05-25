// Pårørende (nødkontakt) per ansatt – redigerbar, låsbar tabell.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tbl = document.getElementById("kinTable");
  if (!tbl) return;
  const editBtn = document.getElementById("kinEdit"), addBtn = document.getElementById("kinAdd"), saveBtn = document.getElementById("kinSave");
  let rows = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    const head = `<thead><tr><th>Ansatt</th><th>Pårørende</th><th>Relasjon</th><th>Telefon</th><th>Notat</th>${editing ? "<th></th>" : ""}</tr></thead>`;
    const body = rows.length ? rows.map((r, i) => editing
      ? `<tr data-i="${i}">
          <td><input class="kon-f" data-f="employee" value="${esc(r.employee)}" placeholder="Ansatt" /></td>
          <td><input class="kon-f" data-f="kinName" value="${esc(r.kinName)}" placeholder="Pårørende" /></td>
          <td><input class="kon-f" data-f="relation" value="${esc(r.relation)}" placeholder="Relasjon" style="width:120px" /></td>
          <td><input class="kon-f" data-f="phone" value="${esc(r.phone)}" placeholder="Telefon" style="width:130px" /></td>
          <td><input class="kon-f" data-f="note" value="${esc(r.note)}" placeholder="Notat" /></td>
          <td><button class="btn-ghost kin-del">🗑</button></td></tr>`
      : `<tr><td><b>${esc(r.employee) || "—"}</b></td><td>${esc(r.kinName) || "—"}</td><td>${esc(r.relation) || "—"}</td><td>${r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : "—"}</td><td>${esc(r.note) || "—"}</td></tr>`
    ).join("") : `<tr><td class="empty" colspan="${editing ? 6 : 5}">Ingen pårørende lagt inn ennå.</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  tbl.addEventListener("input", (e) => { const r = e.target.closest("tr[data-i]"); if (r && e.target.dataset.f) rows[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; });
  tbl.addEventListener("click", (e) => { if (!e.target.classList.contains("kin-del")) return; rows.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { rows.push({ employee: "", kinName: "", relation: "", phone: "", note: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try { const res = await fetch("/api/nextofkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nextOfKin: rows }) });
      if (!res.ok) throw new Error("Lagring feilet"); saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/nextofkin")).json(); rows = (d.nextOfKin || []).map((r) => ({ ...r })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente pårørende: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="hr"]');
  if (tab) tab.addEventListener("click", load);
})();

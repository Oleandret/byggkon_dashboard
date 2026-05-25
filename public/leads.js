// Potensielle kunder (leads) – redigerbar, låsbar liste på kunder-fanen.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tbl = document.getElementById("leadTable");
  if (!tbl) return;
  const editBtn = document.getElementById("leadEdit"), addBtn = document.getElementById("leadAdd"), saveBtn = document.getElementById("leadSave");
  let leads = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    const head = `<thead><tr><th>Potensiell kunde</th><th>Kontakt</th><th>Notat / status</th><th>Lagt inn av</th>${editing ? "<th></th>" : ""}</tr></thead>`;
    const body = leads.length ? leads.map((l, i) => editing
      ? `<tr data-i="${i}">
          <td><input class="kon-f" data-f="name" value="${esc(l.name)}" placeholder="Firma/kunde" /></td>
          <td><input class="kon-f" data-f="contact" value="${esc(l.contact)}" placeholder="Navn/e-post/tlf" /></td>
          <td><input class="kon-f" data-f="note" value="${esc(l.note)}" placeholder="Notat / oppfølging" /></td>
          <td><input class="kon-f" data-f="by" value="${esc(l.by)}" placeholder="Ditt navn" style="width:90px" /></td>
          <td><button class="btn-ghost lead-del">🗑</button></td></tr>`
      : `<tr><td><b>${esc(l.name) || "—"}</b></td><td>${esc(l.contact) || "—"}</td><td>${esc(l.note) || "—"}</td><td>${esc(l.by) || "—"}</td></tr>`
    ).join("") : `<tr><td class="empty" colspan="${editing ? 5 : 4}">Ingen potensielle kunder lagt inn ennå.</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  tbl.addEventListener("input", (e) => { const r = e.target.closest("tr[data-i]"); if (r && e.target.dataset.f) leads[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; });
  tbl.addEventListener("click", (e) => { if (!e.target.classList.contains("lead-del")) return; leads.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { leads.unshift({ name: "", contact: "", note: "", by: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leads }) });
      if (!res.ok) throw new Error("Lagring feilet");
      saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/leads")).json(); leads = (d.leads || []).map((l) => ({ ...l })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente leads: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="kunder"]');
  if (tab) tab.addEventListener("click", load);
})();

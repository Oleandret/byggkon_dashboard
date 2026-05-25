// Lisenskostnader i IT-system – redigerbar tabell med årlig total.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nok = (n) => new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n || 0);
  const tbl = document.getElementById("licTable");
  const editBtn = document.getElementById("licEdit"), addBtn = document.getElementById("licAdd"), saveBtn = document.getElementById("licSave");
  let licenses = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }
  const yearly = (l) => (l.interval === "mnd" ? (l.cost || 0) * 12 : (l.cost || 0));

  function render() {
    const total = licenses.reduce((s, l) => s + yearly(l), 0);
    const head = `<thead><tr><th>System</th><th class="num">Kostnad</th><th>Intervall</th><th class="num">Per år</th>${editing ? "<th></th>" : ""}</tr></thead>`;
    const body = licenses.map((l, i) => editing
      ? `<tr data-i="${i}">
          <td><input class="kon-f" data-f="system" value="${esc(l.system)}" /></td>
          <td class="num"><input class="kon-f lic-cost" data-f="cost" type="number" value="${l.cost || 0}" style="width:90px;text-align:right" /></td>
          <td><select class="kon-f" data-f="interval"><option value="år"${l.interval !== "mnd" ? " selected" : ""}>år</option><option value="mnd"${l.interval === "mnd" ? " selected" : ""}>mnd</option></select></td>
          <td class="num">${nok(yearly(l))}</td>
          <td><button class="btn-ghost lic-del">🗑</button></td></tr>`
      : `<tr><td>${esc(l.system)}</td><td class="num">${nok(l.cost)}</td><td>${esc(l.interval)}</td><td class="num">${nok(yearly(l))}</td></tr>`
    ).join("");
    const foot = `<tr class="lic-total"><td><b>Total per år</b></td><td></td><td></td><td class="num"><b>${nok(total)}</b></td>${editing ? "<td></td>" : ""}</tr>`;
    tbl.innerHTML = head + `<tbody>${body}${foot}</tbody>`;
  }
  tbl.addEventListener("input", (e) => {
    const row = e.target.closest("tr[data-i]"); if (!row || !e.target.dataset.f) return;
    const l = licenses[Number(row.dataset.i)]; const f = e.target.dataset.f;
    l[f] = f === "cost" ? Number(e.target.value) : e.target.value;
    if (f === "cost" || f === "interval") render();
  });
  tbl.addEventListener("click", (e) => { if (!e.target.classList.contains("lic-del")) return; licenses.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { licenses.push({ system: "", cost: 0, interval: "år" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try { const res = await fetch("/api/licenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ licenses }) });
      if (!res.ok) throw new Error("Lagring feilet"); saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function loadLic() { if (loaded) return; try { const d = await (await fetch("/api/licenses")).json(); licenses = (d.licenses || []).map((l) => ({ ...l })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente lisenser: " + e2.message); } }
  const tab = document.querySelector('.tab[data-tab="itsystem"]');
  if (tab) tab.addEventListener("click", loadLic);
})();

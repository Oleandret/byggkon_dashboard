// Nyheter internt – redigerbar liste på forsiden.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const listEl = document.getElementById("newsList");
  const editBtn = document.getElementById("newsEdit"), addBtn = document.getElementById("newsAdd"), saveBtn = document.getElementById("newsSave");
  if (!listEl) return;
  let news = [], editing = false, loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    news.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    listEl.innerHTML = news.length ? news.map((n, i) => editing
      ? `<div class="news-item edit" data-i="${i}">
          <input class="kon-f news-date" type="date" value="${esc(n.date)}" data-f="date" />
          <textarea class="kon-f news-text" rows="2" data-f="text" placeholder="Nyhet …">${esc(n.text)}</textarea>
          <button class="btn-ghost news-del">🗑</button></div>`
      : `<div class="news-item"><div class="news-date-lbl">${esc(n.date)}</div><div class="news-body">${esc(n.text)}</div></div>`
    ).join("") : `<div class="empty">Ingen nyheter ennå.</div>`;
  }
  listEl.addEventListener("input", (e) => { const c = e.target.closest(".news-item"); if (c && e.target.dataset.f) news[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  listEl.addEventListener("click", (e) => { if (!e.target.classList.contains("news-del")) return; news.splice(Number(e.target.closest(".news-item").dataset.i), 1); render(); });
  editBtn.addEventListener("click", () => { editing = !editing; editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; addBtn.hidden = !editing; saveBtn.hidden = !editing; render(); });
  addBtn.addEventListener("click", () => { news.unshift({ date: today(), text: "" }); render(); });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try { const res = await fetch("/api/news", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ news }) });
      if (!res.ok) throw new Error("Lagring feilet"); saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { saveBtn.disabled = false; }
  });
  async function load() { if (loaded) return; try { const d = await (await fetch("/api/news")).json(); news = (d.news || []).map((n) => ({ ...n })); loaded = true; render(); } catch (e2) { err("Kunne ikke hente nyheter: " + e2.message); } }
  load();
})();

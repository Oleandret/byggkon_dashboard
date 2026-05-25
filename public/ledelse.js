// Ledelse – ledermøte-referater, kun for leder (admin). 403 => vis innloggings-melding.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const meetingsEl = document.getElementById("ledMeetings");
  let meetings = [], loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  async function save() {
    try {
      const res = await fetch("/api/ledelse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetings }) });
      if (!res.ok) throw new Error("Lagring feilet");
    } catch (e) { err("Kunne ikke lagre: " + e.message); }
  }
  function render() {
    meetings.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    meetingsEl.innerHTML = meetings.map((m, i) => `
      <div class="fm-meeting" data-i="${i}">
        <div class="fm-m-head">
          <input class="fm-date" type="date" value="${esc(m.date)}" data-f="date" />
          <input class="fm-title" type="text" value="${esc(m.title)}" placeholder="Tittel" data-f="title" />
          <button class="btn-ghost fm-del" title="Slett">🗑</button>
        </div>
        <textarea class="fm-notes" rows="12" data-f="notes">${esc(m.notes)}</textarea>
      </div>`).join("") || `<div class="empty">Ingen referater ennå.</div>`;
  }
  meetingsEl.addEventListener("input", (e) => { const c = e.target.closest(".fm-meeting"); if (c && e.target.dataset.f) meetings[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  meetingsEl.addEventListener("change", (e) => { if (e.target.dataset.f) save(); });
  meetingsEl.addEventListener("click", (e) => { if (!e.target.classList.contains("fm-del")) return; const i = Number(e.target.closest(".fm-meeting").dataset.i); if (confirm("Slette referatet?")) { meetings.splice(i, 1); render(); save(); } });
  document.getElementById("ledAdd").addEventListener("click", () => { meetings.unshift({ id: String(Date.now()), date: today(), title: "Ledermøte", notes: "" }); render(); save(); });

  async function loadLedelse() {
    if (loaded) return;
    try {
      const res = await fetch("/api/ledelse");
      if (res.status === 403 || res.status === 401) {
        document.getElementById("ledLocked").hidden = false;
        document.getElementById("ledContent").hidden = true;
        return;
      }
      const d = await res.json();
      meetings = d.meetings || [];
      document.getElementById("ledLocked").hidden = true;
      document.getElementById("ledContent").hidden = false;
      loaded = true; render();
    } catch (e) { err("Kunne ikke hente ledelse: " + e.message); }
  }
  const tab = document.querySelector('.tab[data-tab="ledelse"]');
  if (tab) tab.addEventListener("click", loadLedelse);
})();

// Generisk møte-modul: referater (redigerbare) + saker/forslag.
// Brukes både for Fagmøter (prefix "fm") og Prosjektmøter (prefix "pm").
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  function err(msg) { const el = document.getElementById("errorBanner"); el.textContent = msg; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function setupMeetings(prefix, tabName, endpoint) {
    const meetingsEl = document.getElementById(prefix + "Meetings");
    const suggEl = document.getElementById(prefix + "Suggestions");
    if (!meetingsEl) return;
    let meetings = [], suggestions = [], loaded = false;

    async function save() {
      try {
        const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetings, suggestions }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      } catch (e) { err("Kunne ikke lagre: " + e.message); }
    }
    function renderMeetings() {
      meetings.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      meetingsEl.innerHTML = meetings.map((m, i) => `
        <div class="fm-meeting" data-i="${i}">
          <div class="fm-m-head">
            <input class="fm-date" type="date" value="${esc(m.date)}" data-f="date" />
            <input class="fm-title" type="text" value="${esc(m.title)}" placeholder="Tittel" data-f="title" />
            <button class="btn-ghost fm-del" title="Slett">🗑</button>
          </div>
          <textarea class="fm-notes" rows="5" placeholder="Referat / notater …" data-f="notes">${esc(m.notes)}</textarea>
        </div>`).join("") || `<div class="empty">Ingen referater ennå.</div>`;
    }
    function renderSuggestions() {
      suggEl.innerHTML = suggestions.length
        ? suggestions.map((s, i) => `<div class="fm-sugg" data-i="${i}">
            <div><span class="fm-s-text">${esc(s.text)}</span>
            <span class="fm-s-meta">${s.by ? esc(s.by) + " · " : ""}${esc(s.date || "")}</span></div>
            <button class="fm-s-del" title="Fjern">×</button></div>`).join("")
        : `<div class="empty">Ingen saker ennå.</div>`;
    }
    meetingsEl.addEventListener("input", (e) => {
      const card = e.target.closest(".fm-meeting"); if (!card || !e.target.dataset.f) return;
      meetings[Number(card.dataset.i)][e.target.dataset.f] = e.target.value;
    });
    meetingsEl.addEventListener("change", (e) => { if (e.target.dataset.f) save(); });
    meetingsEl.addEventListener("click", (e) => {
      if (!e.target.classList.contains("fm-del")) return;
      const i = Number(e.target.closest(".fm-meeting").dataset.i);
      if (confirm("Slette dette referatet?")) { meetings.splice(i, 1); renderMeetings(); save(); }
    });
    document.getElementById(prefix + "AddMeeting").addEventListener("click", () => {
      meetings.unshift({ id: String(Date.now()), date: today(), title: "Møte", notes: "" });
      renderMeetings(); save();
    });
    suggEl.addEventListener("click", (e) => {
      if (!e.target.classList.contains("fm-s-del")) return;
      suggestions.splice(Number(e.target.closest(".fm-sugg").dataset.i), 1); renderSuggestions(); save();
    });
    document.getElementById(prefix + "SuggestBtn").addEventListener("click", () => {
      const input = document.getElementById(prefix + "SuggestInput");
      const by = document.getElementById(prefix + "SuggestBy");
      const text = input.value.trim(); if (!text) return;
      suggestions.unshift({ text, by: by.value.trim(), date: today() });
      input.value = ""; renderSuggestions(); save();
    });

    async function load() {
      if (loaded) return;
      try {
        const res = await fetch(endpoint);
        if (res.status === 401) { location.href = "/login"; return; }
        const d = await res.json();
        meetings = d.meetings || []; suggestions = d.suggestions || [];
        loaded = true; renderMeetings(); renderSuggestions();
      } catch (e) { err("Kunne ikke hente møter: " + e.message); }
    }
    const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (tab) tab.addEventListener("click", load);
  }

  setupMeetings("fm", "fagmoter", "/api/fagmoter");
  setupMeetings("pm", "prosjektmoter", "/api/prosjektmoter");
})();

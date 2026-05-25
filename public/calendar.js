// Felles kalender på forsiden – alle innloggede kan legge inn hendelser.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gridEl = document.getElementById("calGrid");
  if (!gridEl) return;
  const monthLbl = document.getElementById("calMonthLbl");
  const upcomingEl = document.getElementById("calUpcoming");
  const form = document.getElementById("calForm");
  const dateIn = document.getElementById("calDate");
  const typeIn = document.getElementById("calType");
  const titleIn = document.getElementById("calTitle");
  const byIn = document.getElementById("calBy");

  const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
  const TYPE = {
    bursdag: { icon: "🎂", label: "Bursdag" },
    oppstart: { icon: "🚀", label: "Oppstart" },
    mote: { icon: "📅", label: "Møte" },
    frist: { icon: "⏰", label: "Frist" },
    annet: { icon: "📌", label: "Annet" },
  };

  let events = [];
  let view = new Date(); view.setDate(1);

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = iso(new Date());

  function err(m) { const el = document.getElementById("errorBanner"); if (!el) return; el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function eventsOn(dStr) { return events.filter((e) => e.date === dStr).sort((a, b) => a.ts - b.ts); }

  function renderGrid() {
    monthLbl.textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    // Mandag = 0
    let lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));
    while (cells.length % 7 !== 0) cells.push(null);

    gridEl.innerHTML = cells.map((c) => {
      if (!c) return `<div class="cal-cell cal-empty"></div>`;
      const dStr = iso(c);
      const evs = eventsOn(dStr);
      const isToday = dStr === todayIso;
      const dots = evs.slice(0, 4).map((e) => `<span class="cal-dot t-${e.type}" title="${esc(e.title)}"></span>`).join("");
      const more = evs.length > 4 ? `<span class="cal-more">+${evs.length - 4}</span>` : "";
      return `<button type="button" class="cal-cell${isToday ? " is-today" : ""}${evs.length ? " has-ev" : ""}" data-date="${dStr}">
        <span class="cal-num">${c.getDate()}</span>
        <span class="cal-dots">${dots}${more}</span>
      </button>`;
    }).join("");
  }

  function renderUpcoming() {
    const upcoming = events
      .filter((e) => e.date >= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts)
      .slice(0, 12);
    if (!upcoming.length) { upcomingEl.innerHTML = `<div class="empty">Ingen kommende hendelser.</div>`; return; }
    upcomingEl.innerHTML = upcoming.map((e) => {
      const t = TYPE[e.type] || TYPE.annet;
      const [y, m, d] = e.date.split("-");
      const dlbl = `${d}. ${MONTHS[Number(m) - 1].slice(0, 3)}`;
      const by = e.by ? `<span class="cal-by">${esc(e.by)}</span>` : "";
      return `<div class="cal-up-item" data-id="${e.id}">
        <span class="cal-up-date">${dlbl}</span>
        <span class="cal-up-main"><span class="cal-up-ico">${t.icon}</span>${esc(e.title)} ${by}</span>
        <button class="cal-del" data-id="${e.id}" title="Fjern">✕</button>
      </div>`;
    }).join("");
  }

  function render() { renderGrid(); renderUpcoming(); }

  // Klikk på dag -> forhåndsfyll dato i skjema
  gridEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell[data-date]");
    if (!cell) return;
    dateIn.value = cell.dataset.date;
    titleIn.focus();
  });

  // Slett fra kommende-liste
  upcomingEl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".cal-del");
    if (!btn) return;
    const id = btn.dataset.id;
    const ev = events.find((x) => x.id === id);
    if (!confirm(`Fjerne «${ev ? ev.title : "hendelse"}» fra kalenderen?`)) return;
    try {
      const res = await fetch("/api/calendar/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error("Sletting feilet");
      events = events.filter((x) => x.id !== id);
      render();
    } catch (e2) { err("Kunne ikke fjerne: " + e2.message); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = { date: dateIn.value, type: typeIn.value, title: titleIn.value.trim(), by: byIn.value.trim() };
    if (!payload.date || !payload.title) { err("Fyll inn dato og tittel."); return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await fetch("/api/calendar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Lagring feilet");
      events.push(d.event);
      titleIn.value = "";
      render();
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { btn.disabled = false; }
  });

  document.getElementById("calPrev").addEventListener("click", () => { view.setMonth(view.getMonth() - 1); renderGrid(); });
  document.getElementById("calNext").addEventListener("click", () => { view.setMonth(view.getMonth() + 1); renderGrid(); });
  document.getElementById("calToday").addEventListener("click", () => { view = new Date(); view.setDate(1); renderGrid(); });

  async function load() {
    try {
      const res = await fetch("/api/calendar");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      events = (d.events || []).map((x) => ({ ...x }));
      dateIn.value = todayIso;
      render();
    } catch (e2) { err("Kunne ikke hente kalender: " + e2.message); }
  }
  load();
})();

// Felles kalender (forside) – ingen månedsrutenett. Du legger inn ting,
// og det som nærmer seg dukker opp her ca. én uke i forveien.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const upcomingEl = document.getElementById("calUpcoming");
  if (!upcomingEl) return;
  const form = document.getElementById("calForm");
  const dateIn = document.getElementById("calDate");
  const typeIn = document.getElementById("calType");
  const titleIn = document.getElementById("calTitle");
  const byIn = document.getElementById("calBy");
  const showAllBtn = document.getElementById("calShowAll");

  const MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
  const TYPE = {
    bursdag: { icon: "🎂", label: "Bursdag" },
    oppstart: { icon: "🚀", label: "Oppstart" },
    mote: { icon: "📅", label: "Møte" },
    frist: { icon: "⏰", label: "Frist" },
    annet: { icon: "📌", label: "Annet" },
  };
  const WINDOW_DAYS = 7; // "aktuelt" = dukker opp en uke i forveien

  let events = [];
  let showAll = false;

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = iso(new Date());
  const horizonIso = (() => { const d = new Date(); d.setDate(d.getDate() + WINDOW_DAYS); return iso(d); })();

  function err(m) { const el = document.getElementById("errorBanner"); if (!el) return; el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function daysUntil(dStr) {
    const a = new Date(todayIso), b = new Date(dStr);
    return Math.round((b - a) / 86400000);
  }
  function relLabel(n) {
    if (n <= 0) return "I dag";
    if (n === 1) return "I morgen";
    return `Om ${n} dager`;
  }

  function render() {
    let list = events
      .filter((e) => e.date >= todayIso && (showAll || e.date <= horizonIso))
      .sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);

    if (!list.length) {
      upcomingEl.innerHTML = `<div class="empty">${showAll ? "Ingenting fremover." : "Ingenting aktuelt akkurat nå. Legg inn noe under."}</div>`;
      return;
    }
    upcomingEl.innerHTML = list.map((e) => {
      const t = TYPE[e.type] || TYPE.annet;
      const [, m, d] = e.date.split("-");
      const dlbl = `${Number(d)}. ${MONTHS[Number(m) - 1]}`;
      const n = daysUntil(e.date);
      const by = e.by ? `<span class="cal-by">${esc(e.by)}</span>` : "";
      const soon = n <= 2 ? " soon" : "";
      return `<div class="cal-up-item" data-id="${e.id}">
        <span class="cal-up-ico" title="${esc(t.label)}">${t.icon}</span>
        <span class="cal-up-main">${esc(e.title)} ${by}<span class="cal-up-when${soon}">${dlbl} · ${relLabel(n)}</span></span>
        <button class="cal-del" data-id="${e.id}" title="Fjern">✕</button>
      </div>`;
    }).join("");
  }

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

  if (showAllBtn) showAllBtn.addEventListener("click", () => {
    showAll = !showAll;
    showAllBtn.textContent = showAll ? "Vis aktuelt" : "Vis alt";
    render();
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

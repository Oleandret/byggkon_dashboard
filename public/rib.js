// Avdelings-dashboards: identifiserer ansatte i en avdeling via tittelen i
// organisasjonskartet og viser løpende prosjekter (timer siste 4 uker, Tripletex).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);

  // Definer hver avdeling: data-dept-attributt + filter på tittel
  const DEPTS = {
    rib: {
      label: "RIB",
      match: (t) => /RIB/i.test(t) && !/RIBr\b/i.test(t),
    },
    led: {
      label: "Ledelse",
      match: (t) => /\b(daglig leder|faglig leder|avdelingsleder|partner|CEO|leder)\b/i.test(t) && !/(RIB|ARK|RIBr|brann)/i.test(t.replace(/leder/gi, "")),
    },
  };

  function renderInto(dept, people, projects) {
    const grid = document.querySelector(`.dept-grid[data-dept="${dept}"]`);
    const status = document.querySelector(`.dept-status[data-dept="${dept}"]`);
    if (!grid) return;
    if (!people.length) { grid.innerHTML = ""; if (status) status.textContent = `Ingen ansatte i ${DEPTS[dept].label} i organisasjonskartet.`; return; }
    const cards = people.map((name) => {
      const projs = projects
        .map((p) => ({ name: p.name, customer: p.customer, hours: (p.byEmp4w || {})[name] || 0 }))
        .filter((p) => p.hours > 0)
        .sort((a, b) => b.hours - a.hours);
      const total = projs.reduce((s, p) => s + p.hours, 0);
      const rows = projs.length
        ? projs.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.customer ? `<span class="rib-cust">${esc(p.customer)}</span>` : ""}</td><td class="num">${num(p.hours)} t</td></tr>`).join("")
        : `<tr><td class="empty" colspan="2">Ingen timer ført siste 4 uker.</td></tr>`;
      return `<div class="rib-card"><div class="rib-head"><span class="rib-name">${esc(name)}</span><span class="rib-tot">${num(total)} t</span></div><table class="rib-tbl"><tbody>${rows}</tbody></table></div>`;
    }).join("");
    grid.innerHTML = cards;
    if (status) status.textContent = `${people.length} ${DEPTS[dept].label}-ansatte. Timer siste 4 uker hentet fra Tripletex.`;
  }

  async function loadAll() {
    try {
      const [ovRes, orgRes] = await Promise.all([fetch("/api/overview"), fetch("/api/org")]);
      const ov = await ovRes.json();
      const org = await orgRes.json();
      const projects = ov.projectsDetailed || [];
      for (const [key, def] of Object.entries(DEPTS)) {
        const people = (org.nodes || []).filter((n) => def.match(String(n.title || ""))).map((n) => n.name).sort((a, b) => a.localeCompare(b, "nb"));
        renderInto(key, people, projects);
      }
    } catch (e) {
      document.querySelectorAll(".dept-status").forEach((s) => { s.hidden = false; s.textContent = "Kunne ikke hente data: " + e.message; });
    }
  }

  let loaded = false;
  document.querySelectorAll(".dept-reload").forEach((b) => b.addEventListener("click", loadAll));
  const tab = document.querySelector('.tab[data-tab="avdelinger"]');
  if (tab) tab.addEventListener("click", () => { if (!loaded) { loaded = true; loadAll(); } });
})();

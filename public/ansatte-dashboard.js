// Personlige ansatt-dashboards på HR-fanen.
// Viser rolle, kontaktinfo, timer (3 uker + YTD), aktive prosjekter,
// faktureringsgrad siste 3 mnd, kompetanse, rollebeskrivelse og faglige mål.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);
  const pct = (x) => Math.round((x || 0) * 100) + " %";
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
  function nameKeys(n) {
    const parts = norm(n).split(" ").filter(Boolean);
    const keys = new Set();
    if (!parts.length) return keys;
    keys.add(parts.join(" "));
    if (parts.length >= 2) keys.add(parts[0] + " " + parts[parts.length - 1]);
    return keys;
  }
  function namesMatch(a, b) {
    const ka = nameKeys(a), kb = nameKeys(b);
    for (const k of ka) if (kb.has(k)) return true;
    return false;
  }

  let orgNodes = [];      // {id, name, title, email, phone, parentId}
  let projects = [];      // overview.projectsDetailed
  let competence = null;  // { scale, groups, employees }
  let roles = [];         // [{name, role, description, photo}]
  let devGoals = [];      // [{name, goals}]
  let billing3m = [];     // [{name, hours, billable, billingRate}]
  let activeName = null;
  let loaded = false;

  async function loadAll() {
    try {
      const [orgRes, ovRes, kompRes, roleRes, goalRes, ecoRes] = await Promise.all([
        fetch("/api/org"),
        fetch("/api/overview"),
        fetch("/api/competence"),
        fetch("/api/roledescriptions"),
        fetch("/api/devgoals"),
        fetch("/api/economy"),
      ]);
      orgNodes = (await orgRes.json()).nodes || [];
      const ov = await ovRes.json();
      projects = ov.projectsDetailed || [];
      competence = await kompRes.json();
      roles = (await roleRes.json()).roles || [];
      devGoals = (await goalRes.json()).devGoals || [];
      const eco = await ecoRes.json();
      billing3m = eco?.billing3m?.employees || [];
      renderChips();
      // Velg første ansatt automatisk
      if (orgNodes.length && !activeName) setActive(orgNodes[0].name);
    } catch (e) {
      const bar = document.getElementById("ansChipBar");
      if (bar) bar.innerHTML = `<div class="empty">Kunne ikke hente data: ${esc(e.message)}</div>`;
    }
  }

  function renderChips() {
    const bar = document.getElementById("ansChipBar");
    if (!bar) return;
    const term = norm(document.getElementById("ansSearch")?.value || "");
    const sorted = orgNodes.slice().sort((a, b) => a.name.localeCompare(b.name, "nb"));
    const filtered = sorted.filter((n) => !term || norm(n.name + " " + (n.title || "")).includes(term));
    if (!filtered.length) {
      bar.innerHTML = `<div class="empty">Ingen ansatte funnet.</div>`;
      return;
    }
    bar.innerHTML = filtered.map((n) => {
      const initials = n.name.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]).join("");
      const active = n.name === activeName ? "active" : "";
      return `<button class="ans-chip ${active}" data-name="${esc(n.name)}">
        <span class="ans-chip-avatar">${esc(initials)}</span>
        <span class="ans-chip-body">
          <span class="ans-chip-name">${esc(n.name)}</span>
          <span class="ans-chip-title">${esc(n.title || "")}</span>
        </span>
      </button>`;
    }).join("");
  }

  function setActive(name) {
    activeName = name;
    renderChips();
    renderDash();
  }

  function renderDash() {
    const card = document.getElementById("ansDashCard");
    if (!card || !activeName) return;
    card.hidden = false;

    const emp = orgNodes.find((n) => namesMatch(n.name, activeName)) || { name: activeName };
    const initials = emp.name.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]).join("");
    const role = roles.find((r) => namesMatch(r.name, activeName)) || {};
    const goals = devGoals.find((g) => namesMatch(g.name, activeName)) || { goals: "" };
    const bill = billing3m.find((b) => namesMatch(b.name, activeName)) || null;

    /* ---- Header ---- */
    document.getElementById("ansDashHeader").innerHTML = `
      <div class="ans-dash-head">
        ${role.photo ? `<img class="ans-dash-avatar" src="${esc(role.photo)}" alt="${esc(emp.name)}" />`
                     : `<div class="ans-dash-avatar ans-dash-avatar-init">${esc(initials)}</div>`}
        <div class="ans-dash-meta">
          <h2 style="margin:0">${esc(emp.name)}</h2>
          <div class="ans-dash-title">${esc(emp.title || role.role || "")}</div>
          <div class="ans-dash-contacts">
            ${emp.email ? `<a href="mailto:${esc(emp.email)}">✉ ${esc(emp.email)}</a>` : ""}
            ${emp.phone ? `<a href="tel:${esc(emp.phone.replace(/\s/g, ''))}">📞 ${esc(emp.phone)}</a>` : ""}
          </div>
        </div>
      </div>`;

    /* ---- KPI-rad: timer 3 uker, timer 4 uker, YTD, faktureringsgrad ---- */
    const pickEmp = (p, w) => p["byEmp" + w] || {};
    let h3w = 0, h4w = 0, hYtd = 0;
    projects.forEach((p) => {
      for (const [empName, t] of Object.entries(pickEmp(p, "3w"))) {
        if (namesMatch(empName, activeName)) h3w += t;
      }
      for (const [empName, t] of Object.entries(pickEmp(p, "4w"))) {
        if (namesMatch(empName, activeName)) h4w += t;
      }
      // YTD approx: byEmp4w summed not available; use bill object if available
    });
    if (bill) hYtd = bill.hours; // siste 3 mnd timer
    document.getElementById("ansDashKpis").innerHTML = `
      <div class="ans-kpi"><div class="ak-lbl">Timer siste 3 uker</div><div class="ak-val">${num(h3w)} t</div></div>
      <div class="ans-kpi"><div class="ak-lbl">Timer siste 4 uker</div><div class="ak-val">${num(h4w)} t</div></div>
      <div class="ans-kpi"><div class="ak-lbl">Timer siste 3 mnd</div><div class="ak-val">${num(hYtd)} t</div></div>
      <div class="ans-kpi"><div class="ak-lbl">Faktureringsgrad 3 mnd</div><div class="ak-val">${bill ? pct(bill.billingRate) : "—"}</div></div>
    `;

    /* ---- Aktive prosjekter ---- */
    const projList = projects.map((p) => {
      let hours = 0;
      for (const [empName, t] of Object.entries(pickEmp(p, "3w") || pickEmp(p, "4w"))) {
        if (namesMatch(empName, activeName)) { hours += t; break; }
      }
      return { name: p.name, customer: p.customer, number: p.number, projectManager: p.projectManager, hours };
    }).filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours);

    document.getElementById("ansDashProjects").innerHTML = `
      <h3>📁 Aktive prosjekter <span class="subnote">(siste 3 uker)</span></h3>
      ${projList.length ? `
      <table class="ans-tbl">
        <thead><tr><th>Prosjekt</th><th>Kunde</th><th class="num">Timer</th></tr></thead>
        <tbody>${projList.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b>${p.number ? `<span class="subnote"> · ${esc(p.number)}</span>` : ""}${p.projectManager ? `<br><span class="subnote">PL: ${esc(p.projectManager)}</span>` : ""}</td>
            <td>${esc(p.customer || "")}</td>
            <td class="num">${num(p.hours)} t</td>
          </tr>`).join("")}</tbody>
      </table>` : `<div class="empty">Ingen prosjekter med timer siste 3 uker.</div>`}`;

    /* ---- Rollebeskrivelse ---- */
    const desc = String(role.description || "").trim();
    document.getElementById("ansDashRole").innerHTML = `
      <h3>👤 Rollebeskrivelse</h3>
      ${desc ? `<div class="ans-role-text">${esc(desc).replace(/\n/g, "<br>")}</div>`
            : `<div class="empty">Ingen rollebeskrivelse registrert ennå. Legg til på «Rollebeskrivelser»-fanen.</div>`}`;

    /* ---- Kompetanse ---- */
    let kompHtml = `<h3>🎓 Kompetanse</h3>`;
    if (competence && competence.groups && Array.isArray(competence.employees)) {
      const empRow = competence.employees.find((e) => namesMatch(e.name, activeName));
      if (empRow && empRow.skills) {
        const scale = competence.scale || [];
        const entries = [];
        competence.groups.forEach((g) => {
          g.skills.forEach((skill) => {
            const lvl = empRow.skills[skill];
            if (lvl != null && lvl > 0) entries.push({ group: g.group, skill, level: lvl });
          });
        });
        entries.sort((a, b) => b.level - a.level);
        if (entries.length) {
          kompHtml += `<div class="komp-pills">${entries.slice(0, 24).map((e) => {
            const lvlText = scale[e.level] || ("Nivå " + e.level);
            return `<div class="komp-pill level-${e.level}" title="${esc(e.group)}"><span class="kp-skill">${esc(e.skill)}</span><span class="kp-lvl">${e.level}/${(scale.length || 4) - 1} · ${esc(lvlText)}</span></div>`;
          }).join("")}</div>`;
          if (entries.length > 24) kompHtml += `<p class="subnote">+${entries.length - 24} flere. Se Kompetanse-fanen.</p>`;
        } else {
          kompHtml += `<div class="empty">Ingen ferdigheter registrert ennå.</div>`;
        }
      } else {
        kompHtml += `<div class="empty">Personen er ikke lagt inn i kompetansematrisen.</div>`;
      }
    } else {
      kompHtml += `<div class="empty">Kompetansematrise ikke tilgjengelig.</div>`;
    }
    document.getElementById("ansDashKomp").innerHTML = kompHtml;

    /* ---- Faglige mål ---- */
    const goalText = String(goals.goals || "").trim();
    const goalLines = goalText ? goalText.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    document.getElementById("ansDashGoals").innerHTML = `
      <h3>🎯 Faglige utviklingsmål 2026</h3>
      ${goalLines.length ? `<ul class="goal-list">${goalLines.map((g) => `<li>${esc(g.replace(/^[-•*]\s*/, ""))}</li>`).join("")}</ul>`
                         : `<div class="empty">Ingen mål registrert ennå. Sett mål på Fagmøter-fanen.</div>`}`;
  }

  /* ============ EVENTS ============ */
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#ansChipBar .ans-chip");
    if (chip && chip.dataset.name) { setActive(chip.dataset.name); return; }
    if (e.target.id === "ansReload") { loaded = false; loadAll(); return; }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "ansSearch") renderChips();
  });

  // Last data når HR-fanen åpnes
  const hrTab = document.querySelector('.tab[data-tab="hr"]');
  if (hrTab) hrTab.addEventListener("click", () => {
    if (!loaded) { loaded = true; loadAll(); }
  });
})();

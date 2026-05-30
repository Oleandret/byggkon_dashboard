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
  let empSettings = {};   // { name: { orion: {url, enabled, hasKey}, visibility } }
  let activeName = null;
  let activeSub = "oversikt"; // oversikt | timer | status | innstillinger
  let timeData = null;        // cached for active employee
  let statusData = null;      // cached for active employee
  let loaded = false;

  async function loadAll() {
    try {
      const [orgRes, ovRes, kompRes, roleRes, goalRes, ecoRes, setRes] = await Promise.all([
        fetch("/api/org"),
        fetch("/api/overview"),
        fetch("/api/competence"),
        fetch("/api/roledescriptions"),
        fetch("/api/devgoals"),
        fetch("/api/economy"),
        fetch("/api/employee-settings"),
      ]);
      orgNodes = (await orgRes.json()).nodes || [];
      const ov = await ovRes.json();
      projects = ov.projectsDetailed || [];
      competence = await kompRes.json();
      roles = (await roleRes.json()).roles || [];
      devGoals = (await goalRes.json()).devGoals || [];
      const eco = await ecoRes.json();
      billing3m = eco?.billing3m?.employees || [];
      empSettings = (await setRes.json()).settings || {};
      renderChips();
      if (orgNodes.length && !activeName) setActive(orgNodes[0].name);
    } catch (e) {
      const bar = document.getElementById("ansChipBar");
      if (bar) bar.innerHTML = `<div class="empty">Kunne ikke hente data: ${esc(e.message)}</div>`;
    }
  }
  function settingsFor(name) {
    return empSettings[name] || { orion: { url: "", enabled: false, hasKey: false }, visibility: {} };
  }
  function visible(name, key, fallback = true) {
    const v = settingsFor(name).visibility || {};
    return v[key] !== undefined ? v[key] : fallback;
  }
  async function saveSettings(name, payload) {
    try {
      const res = await fetch("/api/employee-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...payload }) });
      if (!res.ok) throw new Error("Lagring feilet");
      // Hent oppdaterte settings
      const r = await fetch("/api/employee-settings");
      empSettings = (await r.json()).settings || {};
    } catch (e) { alert("Kunne ikke lagre: " + e.message); }
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
    activeSub = "oversikt";
    timeData = null; statusData = null;
    renderChips();
    renderDash();
  }

  function setActiveSub(sub) {
    activeSub = sub;
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
    const set = settingsFor(emp.name);

    /* ---- Header + sub-sub-tabs ---- */
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
      </div>
      <div class="ans-subtabs" id="ansSubtabs">
        <button class="ans-subtab ${activeSub === "oversikt" ? "active" : ""}" data-asub="oversikt">📋 Oversikt</button>
        <button class="ans-subtab ${activeSub === "timer" ? "active" : ""}" data-asub="timer">⏱ Timeoversikt</button>
        <button class="ans-subtab ${activeSub === "status" ? "active" : ""}" data-asub="status">🟢 Status${set.orion?.enabled ? "" : " <span class=\"subnote\">(av)</span>"}</button>
        <button class="ans-subtab ${activeSub === "innstillinger" ? "active" : ""}" data-asub="innstillinger">⚙ Innstillinger</button>
      </div>`;

    // Vis riktig sub-sub-tab innhold
    if (activeSub === "oversikt") renderOversikt(emp, role, goals, bill);
    else if (activeSub === "timer") renderTimer(emp);
    else if (activeSub === "status") renderStatus(emp);
    else if (activeSub === "innstillinger") renderInnstillinger(emp);
  }

  function renderOversikt(emp, role, goals, bill) {
    // Skjul ikke-relevante seksjoner
    document.getElementById("ansDashKpis").hidden = false;
    document.getElementById("ansDashGrid").hidden = false;
    document.querySelector("#ansDashCard .grid-2:nth-of-type(3)") && (document.querySelector("#ansDashCard .grid-2:nth-of-type(3)").hidden = false);
    // Bygg innholdet helt på nytt slik at vi kan styre layout
    const content = document.getElementById("ansDashContent") || (() => {
      const d = document.createElement("div");
      d.id = "ansDashContent";
      // Sett inn etter header
      const parent = document.getElementById("ansDashCard");
      parent.appendChild(d);
      return d;
    })();
    // Skjul de gamle direktebarna (kpis/grid)
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);

    // Hent timer
    const pickEmp = (p, w) => p["byEmp" + w] || {};
    let h3w = 0, h4w = 0;
    projects.forEach((p) => {
      for (const [empName, t] of Object.entries(pickEmp(p, "3w"))) if (namesMatch(empName, emp.name)) h3w += t;
      for (const [empName, t] of Object.entries(pickEmp(p, "4w"))) if (namesMatch(empName, emp.name)) h4w += t;
    });
    const hYtd = bill ? bill.hours : 0;

    const projList = projects.map((p) => {
      let hours = 0;
      const src = pickEmp(p, "3w");
      const hasAny = Object.keys(src).length;
      const fallback = hasAny ? src : pickEmp(p, "4w");
      for (const [empName, t] of Object.entries(fallback)) if (namesMatch(empName, emp.name)) { hours += t; break; }
      return { name: p.name, customer: p.customer, number: p.number, projectManager: p.projectManager, hours };
    }).filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours);

    let html = `
      <div class="ans-kpis">
        <div class="ans-kpi"><div class="ak-lbl">Timer siste 3 uker</div><div class="ak-val">${num(h3w)} t</div></div>
        <div class="ans-kpi"><div class="ak-lbl">Timer siste 4 uker</div><div class="ak-val">${num(h4w)} t</div></div>
        <div class="ans-kpi"><div class="ak-lbl">Timer siste 3 mnd</div><div class="ak-val">${num(hYtd)} t</div></div>
        <div class="ans-kpi"><div class="ak-lbl">Faktureringsgrad 3 mnd</div><div class="ak-val">${bill ? pct(bill.billingRate) : "—"}</div></div>
      </div>`;

    if (visible(emp.name, "projects", true)) {
      html += `<div class="grid-2" style="margin-top:14px"><div class="ans-dash-block">
        <h3>📁 Aktive prosjekter <span class="subnote">(siste 3 uker)</span></h3>
        ${projList.length ? `<table class="ans-tbl"><thead><tr><th>Prosjekt</th><th>Kunde</th><th class="num">Timer</th></tr></thead>
          <tbody>${projList.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.number ? `<span class="subnote"> · ${esc(p.number)}</span>` : ""}${p.projectManager ? `<br><span class="subnote">PL: ${esc(p.projectManager)}</span>` : ""}</td><td>${esc(p.customer || "")}</td><td class="num">${num(p.hours)} t</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ingen prosjekter med timer siste 3 uker.</div>`}
      </div>`;
      if (visible(emp.name, "role", true)) {
        const desc = String(role.description || "").trim();
        html += `<div class="ans-dash-block">
          <h3>👤 Rollebeskrivelse</h3>
          ${desc ? `<div class="ans-role-text">${esc(desc).replace(/\n/g, "<br>")}</div>` : `<div class="empty">Ingen rollebeskrivelse registrert ennå.</div>`}
        </div>`;
      }
      html += `</div>`;
    }

    if (visible(emp.name, "komp", true) || visible(emp.name, "goals", true)) {
      html += `<div class="grid-2" style="margin-top:14px">`;
      if (visible(emp.name, "komp", true)) {
        let kompHtml = `<h3>🎓 Kompetanse</h3>`;
        if (competence && competence.groups && Array.isArray(competence.employees)) {
          const empRow = competence.employees.find((e) => namesMatch(e.name, emp.name));
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
              kompHtml += `<div class="komp-pills">${entries.slice(0, 24).map((e) => `<div class="komp-pill level-${e.level}" title="${esc(e.group)}"><span class="kp-skill">${esc(e.skill)}</span><span class="kp-lvl">${e.level}/${(scale.length || 4) - 1} · ${esc(scale[e.level] || "")}</span></div>`).join("")}</div>`;
              if (entries.length > 24) kompHtml += `<p class="subnote">+${entries.length - 24} flere.</p>`;
            } else kompHtml += `<div class="empty">Ingen ferdigheter registrert ennå.</div>`;
          } else kompHtml += `<div class="empty">Personen er ikke lagt inn i kompetansematrisen.</div>`;
        }
        html += `<div class="ans-dash-block">${kompHtml}</div>`;
      }
      if (visible(emp.name, "goals", true)) {
        const goalLines = String(goals.goals || "").split("\n").map((l) => l.trim()).filter(Boolean);
        html += `<div class="ans-dash-block">
          <h3>🎯 Faglige utviklingsmål 2026</h3>
          ${goalLines.length ? `<ul class="goal-list">${goalLines.map((g) => `<li>${esc(g.replace(/^[-•*]\s*/, ""))}</li>`).join("")}</ul>` : `<div class="empty">Ingen mål registrert ennå.</div>`}
        </div>`;
      }
      html += `</div>`;
    }

    content.innerHTML = html;
  }

  async function renderTimer(emp) {
    // Skjul oversikts-innhold
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();
    content.innerHTML = `<div class="subnote">Henter timer fra Tripletex …</div>`;
    if (!timeData) {
      try {
        const r = await fetch("/api/employee-time?name=" + encodeURIComponent(emp.name));
        timeData = await r.json();
      } catch (e) { content.innerHTML = `<div class="empty">Kunne ikke hente: ${esc(e.message)}</div>`; return; }
    }
    const renderPeriod = (title, p) => {
      const projHtml = p.projects.length ? `<table class="ans-tbl"><thead><tr><th>Prosjekt</th><th class="num">Timer</th></tr></thead>
        <tbody>${p.projects.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${num(x.hours)} t</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ingen timer.</div>`;
      return `<div class="ans-dash-block">
        <h3>${esc(title)}</h3>
        <div class="ans-kpis" style="grid-template-columns:repeat(3,1fr)">
          <div class="ans-kpi"><div class="ak-lbl">Totalt</div><div class="ak-val">${num(p.totalHours)} t</div></div>
          <div class="ans-kpi"><div class="ak-lbl">Fakturerbart</div><div class="ak-val">${num(p.billableHours)} t</div></div>
          <div class="ans-kpi"><div class="ak-lbl">Faktureringsgrad</div><div class="ak-val">${pct(p.billingRate)}</div></div>
        </div>
        ${projHtml}
      </div>`;
    };
    content.innerHTML = `<div class="grid-2" style="margin-top:14px">
      ${renderPeriod("⏱ Siste 2 uker", timeData.last2w)}
      ${renderPeriod("📅 Siste 4 uker", timeData.last4w)}
    </div>`;
  }

  async function renderStatus(emp) {
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();
    const set = settingsFor(emp.name);
    if (!set.orion?.enabled) {
      content.innerHTML = `<div class="ans-dash-block">
        <h3>🟢 Status</h3>
        <div class="empty">Orion MCP er ikke aktivert for ${esc(emp.name)}. Gå til <b>⚙ Innstillinger</b> for å koble til Orion-serveren og slå på status-henting.</div>
      </div>`;
      return;
    }
    content.innerHTML = `<div class="subnote">Henter status fra Orion …</div>`;
    try {
      const r = await fetch("/api/employee-status?name=" + encodeURIComponent(emp.name));
      statusData = await r.json();
    } catch (e) { content.innerHTML = `<div class="empty">Kunne ikke hente: ${esc(e.message)}</div>`; return; }
    if (!statusData.ok) {
      content.innerHTML = `<div class="ans-dash-block"><h3>🟢 Status</h3><div class="empty">${esc(statusData.reason || "Ingen data")}</div></div>`;
      return;
    }
    // Render data — prøver å plukke ut vanlige felter, ellers vis rådata
    const d = statusData.data || {};
    const items = [];
    function push(label, val) { if (val != null && val !== "") items.push({ label, val: String(val) }); }
    push("Nåværende oppgave", d.currentTask || d.now || d.activity);
    push("Status", d.status || d.state);
    push("Lokasjon", d.location || d.where);
    push("Tilgjengelig", d.available);
    push("Sist oppdatert", d.updatedAt || d.timestamp || d.lastSeen);
    const summary = d.summary || d.message || d.text;
    content.innerHTML = `<div class="ans-dash-block">
      <h3>🟢 Status fra Orion</h3>
      ${items.length ? `<div class="ans-status-grid">${items.map((x) => `<div class="ans-status-row"><span class="ass-lbl">${esc(x.label)}</span><span class="ass-val">${esc(x.val)}</span></div>`).join("")}</div>` : ""}
      ${summary ? `<div class="ans-role-text" style="margin-top:10px">${esc(summary).replace(/\n/g, "<br>")}</div>` : ""}
      ${!items.length && !summary ? `<pre class="code-snip" style="max-height:300px;overflow:auto">${esc(JSON.stringify(d, null, 2))}</pre>` : ""}
    </div>`;
  }

  function renderInnstillinger(emp) {
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();
    const set = settingsFor(emp.name);
    content.innerHTML = `
      <div class="ans-dash-block">
        <h3>🔗 Orion MCP — datahub for ${esc(emp.name)}</h3>
        <p class="subnote">Orion er en valgfri MCP-hub som henter data fra ulike kilder for å vise en status-oversikt. Hver ansatt bestemmer selv om de vil koble til. URL og nøkkel lagres trygt på serveren og deles ikke videre.</p>
        <div class="settings-form">
          <label class="settings-row">
            <span>Orion MCP-URL</span>
            <input id="orionUrl" type="url" class="kon-f" placeholder="https://orion.byggkon.ai" value="${esc(set.orion?.url || "")}" />
          </label>
          <label class="settings-row">
            <span>API-nøkkel</span>
            <input id="orionKey" type="password" class="kon-f" placeholder="${set.orion?.hasKey ? "(nøkkel er lagret — la stå tom for å beholde)" : "Lim inn API-nøkkelen"}" />
          </label>
          <label class="settings-row settings-row-check">
            <input type="checkbox" id="orionEnabled" ${set.orion?.enabled ? "checked" : ""} />
            <span><b>Aktiver Orion</b> — bruk denne MCP-en for Status-fanen</span>
          </label>
          <div class="org-actions">
            <button class="btn-primary" id="orionSave">Lagre</button>
            <button class="btn-ghost" id="orionTest">Test tilkobling</button>
            <span id="orionTestMsg" class="subnote"></span>
          </div>
        </div>
      </div>

      <div class="ans-dash-block" style="margin-top:14px">
        <h3>👁 Hva som vises på Oversikt</h3>
        <p class="subnote">Skjul seksjoner du ikke vil vise. Endringer lagres når du klikker «Lagre synlighet».</p>
        <div class="settings-form">
          <label class="settings-row settings-row-check"><input type="checkbox" id="visProjects" ${visible(emp.name, "projects", true) ? "checked" : ""}/> <span>📁 Aktive prosjekter</span></label>
          <label class="settings-row settings-row-check"><input type="checkbox" id="visRole" ${visible(emp.name, "role", true) ? "checked" : ""}/> <span>👤 Rollebeskrivelse</span></label>
          <label class="settings-row settings-row-check"><input type="checkbox" id="visKomp" ${visible(emp.name, "komp", true) ? "checked" : ""}/> <span>🎓 Kompetanse</span></label>
          <label class="settings-row settings-row-check"><input type="checkbox" id="visGoals" ${visible(emp.name, "goals", true) ? "checked" : ""}/> <span>🎯 Faglige mål</span></label>
          <div class="org-actions"><button class="btn-primary" id="visSave">Lagre synlighet</button></div>
        </div>
      </div>`;

    document.getElementById("orionSave").addEventListener("click", async () => {
      const url = document.getElementById("orionUrl").value.trim();
      const keyInp = document.getElementById("orionKey").value.trim();
      const enabled = document.getElementById("orionEnabled").checked;
      await saveSettings(emp.name, { orion: { url, key: keyInp, enabled } });
      document.getElementById("orionTestMsg").textContent = "✓ Lagret";
      renderDash();
    });
    document.getElementById("orionTest").addEventListener("click", async () => {
      const msg = document.getElementById("orionTestMsg");
      msg.textContent = "Tester …";
      try {
        const r = await fetch("/api/employee-status?name=" + encodeURIComponent(emp.name));
        const d = await r.json();
        msg.textContent = d.ok ? "✓ Tilkobling OK" : "✗ " + (d.reason || "Feil");
      } catch (e) { msg.textContent = "✗ " + e.message; }
    });
    document.getElementById("visSave").addEventListener("click", async () => {
      const visibility = {
        projects: document.getElementById("visProjects").checked,
        role: document.getElementById("visRole").checked,
        komp: document.getElementById("visKomp").checked,
        goals: document.getElementById("visGoals").checked,
      };
      await saveSettings(emp.name, { visibility });
      document.getElementById("orionTestMsg").textContent = "✓ Synlighet lagret";
    });
  }

  /* ============ EVENTS ============ */
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#ansChipBar .ans-chip");
    if (chip && chip.dataset.name) { setActive(chip.dataset.name); return; }
    if (e.target.id === "ansReload") { loaded = false; loadAll(); return; }
    const sub = e.target.closest("#ansSubtabs .ans-subtab");
    if (sub && sub.dataset.asub) { setActiveSub(sub.dataset.asub); return; }
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

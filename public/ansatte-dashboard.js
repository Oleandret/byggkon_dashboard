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
  let activeSub = "oversikt"; // oversikt | timer | chat | status | innstillinger
  let timeData = null;        // cached for active employee
  let statusData = null;      // cached for active employee
  let chatHistory = [];       // [{role:"user"|"assistant", text}]
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
    // Kompakte navn-chips, alfabetisk
    bar.innerHTML = filtered.map((n) => {
      const active = n.name === activeName ? "active" : "";
      return `<button class="ans-chip-mini ${active}" data-name="${esc(n.name)}" title="${esc(n.title || "")}">${esc(n.name)}</button>`;
    }).join("");
  }

  function setActive(name) {
    activeName = name;
    activeSub = "oversikt";
    timeData = null; statusData = null; chatHistory = [];
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
        <button class="ans-subtab ${activeSub === "chat" ? "active" : ""}" data-asub="chat">💬 Chat${set.orion?.enabled ? "" : " <span class=\"subnote\">(av)</span>"}</button>
        <button class="ans-subtab ${activeSub === "timer" ? "active" : ""}" data-asub="timer">⏱ Timeoversikt</button>
        <button class="ans-subtab ${activeSub === "status" ? "active" : ""}" data-asub="status">🟢 Status${set.orion?.enabled ? "" : " <span class=\"subnote\">(av)</span>"}</button>
        <button class="ans-subtab ${activeSub === "innstillinger" ? "active" : ""}" data-asub="innstillinger">⚙ Innstillinger</button>
      </div>`;

    // Vis riktig sub-sub-tab innhold
    if (activeSub === "oversikt") renderOversikt(emp, role, goals, bill);
    else if (activeSub === "timer") renderTimer(emp);
    else if (activeSub === "chat") renderChat(emp);
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
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();
    content.innerHTML = `<div class="subnote">Henter alle timer fra Tripletex …</div>`;
    if (!timeData) {
      try {
        const r = await fetch("/api/employee-time?name=" + encodeURIComponent(emp.name));
        timeData = await r.json();
      } catch (e) { content.innerHTML = `<div class="empty">Kunne ikke hente: ${esc(e.message)}</div>`; return; }
    }
    const fmt = (n) => Math.round(n * 10) / 10 + " t";
    function renderPeriod(title, p) {
      const projHtml = p.projects.length ? `<table class="ans-tbl"><thead><tr><th>Prosjekt</th><th class="num">Timer</th></tr></thead>
        <tbody>${p.projects.slice(0, 15).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${fmt(x.hours)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ingen prosjekttimer.</div>`;
      const actHtml = p.activities.length ? `<table class="ans-tbl"><thead><tr><th>Aktivitet</th><th class="num">Timer</th></tr></thead>
        <tbody>${p.activities.slice(0, 15).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${fmt(x.hours)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ingen aktiviteter.</div>`;
      return `<div class="ans-dash-block">
        <h3>${esc(title)}</h3>
        <div class="ans-kpis" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px">
          <div class="ans-kpi"><div class="ak-lbl">Totalt ført</div><div class="ak-val">${fmt(p.totalHours)}</div></div>
          <div class="ans-kpi"><div class="ak-lbl">Fakturerbart</div><div class="ak-val">${fmt(p.billableHours)} <span class="subnote">(${pct(p.billingRate)})</span></div></div>
        </div>
        <div class="ans-kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
          <div class="ans-kpi"><div class="ak-lbl">Prosjekt</div><div class="ak-val" style="font-size:16px">${fmt(p.projectHours)}</div></div>
          <div class="ans-kpi"><div class="ak-lbl">Intern</div><div class="ak-val" style="font-size:16px">${fmt(p.internHours)}</div></div>
          <div class="ans-kpi"><div class="ak-lbl">Fravær / ferie / syk</div><div class="ak-val" style="font-size:16px">${fmt(p.fravarHours)}</div></div>
        </div>
        <div class="grid-2" style="gap:10px">
          <div><h4 style="margin:4px 0 6px;font-size:12px;color:var(--muted)">PER PROSJEKT</h4>${projHtml}</div>
          <div><h4 style="margin:4px 0 6px;font-size:12px;color:var(--muted)">PER AKTIVITET</h4>${actHtml}</div>
        </div>
      </div>`;
    }
    // Detaljert linjeliste (siste 4 uker)
    const entries = (timeData.last4w?.entries || []).slice(0, 50);
    const detailHtml = entries.length ? `
      <div class="ans-dash-block" style="margin-top:14px">
        <h3>📋 Alle timeføringer — siste 4 uker</h3>
        <table class="ans-tbl">
          <thead><tr><th>Dato</th><th>Prosjekt</th><th>Aktivitet</th><th>Kommentar</th><th class="num">Timer</th><th class="num">Fakt.</th></tr></thead>
          <tbody>${entries.map((e) => `<tr>
            <td>${esc(e.date)}</td>
            <td>${esc(e.project)}${e.projectNumber ? `<span class="subnote"> · ${esc(e.projectNumber)}</span>` : ""}</td>
            <td>${esc(e.activity)}</td>
            <td class="subnote">${esc(e.comment || "")}</td>
            <td class="num">${fmt(e.hours)}</td>
            <td class="num">${fmt(e.billable)}</td>
          </tr>`).join("")}</tbody>
        </table>
        ${(timeData.last4w?.entries || []).length > 50 ? `<p class="subnote">Viser de 50 nyeste oppføringene.</p>` : ""}
      </div>` : "";
    content.innerHTML = `<div class="grid-2" style="margin-top:14px">
      ${renderPeriod("⏱ Siste 2 uker", timeData.last2w)}
      ${renderPeriod("📅 Siste 4 uker", timeData.last4w)}
    </div>${detailHtml}`;
  }

  /* ============ CHAT (Orion MCP) ============ */
  function renderChat(emp) {
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();
    const set = settingsFor(emp.name);
    if (!set.orion?.enabled) {
      content.innerHTML = `<div class="ans-dash-block">
        <h3>💬 Chat med Orion</h3>
        <div class="empty">Orion MCP er ikke aktivert for ${esc(emp.name)}. Gå til <b>⚙ Innstillinger</b> for å koble til Orion-serveren først.</div>
      </div>`;
      return;
    }
    content.innerHTML = `<div class="ans-dash-block">
      <h3>💬 Chat med Orion <span class="subnote">— stiller spørsmål til ${esc(emp.name)} sin Orion-hub</span></h3>
      <div class="chat-box" id="chatLog">
        ${chatHistory.length ? chatHistory.map((m) => `<div class="chat-msg chat-${esc(m.role)}"><div class="chat-bubble">${esc(m.text).replace(/\n/g, "<br>")}</div></div>`).join("")
                            : `<div class="empty">Still et spørsmål for å starte. Eksempler: «Hva jobber jeg med i dag?», «Vis siste e-poster», «Hvor mye har jeg ført i dag?», «Hva er status på X?»</div>`}
      </div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" class="kon-f" type="text" placeholder="Skriv en melding til Orion …" autocomplete="off" />
        <button class="btn-primary" id="chatSend" type="submit">Send</button>
        <button class="btn-ghost" id="chatClear" type="button">Tøm</button>
      </form>
    </div>`;
    const input = document.getElementById("chatInput");
    const log = document.getElementById("chatLog");
    function scrollLog() { log.scrollTop = log.scrollHeight; }
    function addMsg(role, text) {
      chatHistory.push({ role, text });
      // Re-render bare log-delen
      const empty = log.querySelector(".empty"); if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "chat-msg chat-" + role;
      div.innerHTML = `<div class="chat-bubble">${esc(text).replace(/\n/g, "<br>")}</div>`;
      log.appendChild(div); scrollLog();
    }
    document.getElementById("chatForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const message = input.value.trim(); if (!message) return;
      input.value = ""; addMsg("user", message);
      const typing = document.createElement("div");
      typing.className = "chat-msg chat-assistant chat-typing";
      typing.innerHTML = `<div class="chat-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
      log.appendChild(typing); scrollLog();
      try {
        const r = await fetch("/api/employee-chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: emp.name, message, history: chatHistory.slice(-10) }),
        });
        const d = await r.json();
        typing.remove();
        if (!d.ok) {
          let txt = "⚠ " + (d.reason || "Ingen svar fra Orion.");
          if (d.attempts) {
            txt += "\n\nForsøkte:\n" + d.attempts.map((a) => "• " + a.label + " → " + (a.error || ("HTTP " + a.status))).join("\n");
            txt += "\n\nGå til ⚙ Innstillinger → Diagnostikk for å finne riktig sti.";
          }
          addMsg("assistant", txt);
        } else addMsg("assistant", d.reply || "(tomt svar)");
      } catch (e) { typing.remove(); addMsg("assistant", "⚠ Feil: " + e.message); }
    });
    document.getElementById("chatClear").addEventListener("click", () => { chatHistory = []; renderChat(emp); });
    input.focus();
  }

  async function renderStatus(emp) {
    ["ansDashKpis", "ansDashGrid"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const allGrids = document.querySelectorAll("#ansDashCard > .grid-2"); allGrids.forEach((g) => g.hidden = true);
    const content = document.getElementById("ansDashContent") || (() => { const d = document.createElement("div"); d.id = "ansDashContent"; document.getElementById("ansDashCard").appendChild(d); return d; })();

    content.innerHTML = `<div class="status-grid-4">
      <div class="ans-dash-block status-col" id="statusCol1">
        <h3>📌 Hva jobber ${esc(emp.name)} med <span class="subnote">(siste 4 uker)</span></h3>
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
      <div class="ans-dash-block status-col" id="statusCol2">
        <h3>📁 Prosjekter <span class="subnote">(siste 4 uker)</span></h3>
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
      <div class="ans-dash-block status-col" id="statusCol3">
        <h3>📅 Kommende møter <span class="subnote">(neste 2 uker)</span></h3>
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
      <div class="ans-dash-block status-col status-col-automation" id="statusCol4">
        <h3>⚡ Forslag til automasjoner</h3>
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
    <p class="subnote" style="margin-top:10px;text-align:center">Data caches i 15 min for å spare LLM-kall. Klikk «↻» øverst for å oppdatere.</p>`;

    try {
      const r = await fetch("/api/employee-status-rich?name=" + encodeURIComponent(emp.name));
      const d = await r.json();
      if (d.error) {
        document.querySelectorAll(".status-col").forEach((c) => {
          const h = c.querySelector("h3");
          c.innerHTML = h.outerHTML + `<div class="empty">Feil: ${esc(d.error)}</div>`;
        });
        return;
      }

      // Kolonne 1: Hva jobber han med
      const c1 = document.getElementById("statusCol1");
      c1.innerHTML = c1.querySelector("h3").outerHTML +
        (d.col1_workSummary ? `<div class="ans-role-text">${esc(d.col1_workSummary).replace(/\n/g, "<br>")}</div>`
         : d.entryCount === 0 ? `<div class="empty">Ingen timer ført siste 4 uker.</div>`
         : !d.claudeEnabled ? `<div class="empty">Krever <code>ANTHROPIC_API_KEY</code> på Railway.</div>`
         : `<div class="empty">Kunne ikke generere sammendrag.</div>`);

      // Kolonne 2: Prosjekter
      const c2 = document.getElementById("statusCol2");
      const projs = d.col2_projects || [];
      c2.innerHTML = c2.querySelector("h3").outerHTML +
        (projs.length ? `<table class="ans-tbl">
          <thead><tr><th>Prosjekt</th><th class="num">Timer</th></tr></thead>
          <tbody>${projs.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.lastDate ? `<br><span class="subnote">Sist: ${esc(p.lastDate)}</span>` : ""}</td><td class="num">${num(Math.round(p.hours))} t</td></tr>`).join("")}</tbody>
        </table>` : `<div class="empty">Ingen prosjekter siste 4 uker.</div>`);

      // Kolonne 3: Kalender
      const c3 = document.getElementById("statusCol3");
      c3.innerHTML = c3.querySelector("h3").outerHTML +
        (d.col3_calendar ? `<div class="status-cal-text">${esc(d.col3_calendar).replace(/\n/g, "<br>")}</div>`
         : !d.orionEnabled ? `<div class="empty">Orion MCP ikke aktivert. Gå til <b>⚙ Innstillinger</b>.</div>`
         : !d.hasOrionCalendar ? `<div class="empty">Orion har ikke et kalender-verktøy ennå. Sjekk «🔧 Vis verktøy» under Innstillinger.</div>`
         : `<div class="empty">Ingen kommende møter.</div>`);

      // Kolonne 4: Automasjoner
      const c4 = document.getElementById("statusCol4");
      c4.innerHTML = c4.querySelector("h3").outerHTML +
        (d.col4_automations ? `<div class="automation-list">${esc(d.col4_automations)
          .replace(/\*\*Forslag:\*\*\s*([^\n]+)/g, '<div class="auto-sug"><div class="auto-sug-h">⚡ $1</div>')
          .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
          .replace(/\n\n/g, "</div><div class=\"auto-sug-spacer\"></div>")
          .replace(/\n/g, "<br>")}</div>`
         : !d.claudeEnabled ? `<div class="empty">Krever <code>ANTHROPIC_API_KEY</code> på Railway.</div>`
         : !d.orionEnabled ? `<div class="empty">Krever Orion MCP for å lese e-poster.</div>`
         : !d.hasOrionEmails ? `<div class="empty">Orion har ikke et e-post-verktøy tilgjengelig. Sjekk «🔧 Vis verktøy».</div>`
         : `<div class="empty">Ingen mønstre funnet.</div>`);

    } catch (e) {
      content.innerHTML = `<div class="empty">Kunne ikke hente: ${esc(e.message)}</div>`;
    }
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
            <span>Orion MCP-URL (basis-URL, uten sti)</span>
            <input id="orionUrl" type="url" class="kon-f" placeholder="https://orion.byggkon.ai" value="${esc(set.orion?.url || "")}" />
          </label>
          <label class="settings-row">
            <span>API-nøkkel</span>
            <input id="orionKey" type="password" class="kon-f" placeholder="${set.orion?.hasKey ? "(nøkkel er lagret — la stå tom for å beholde)" : "Lim inn API-nøkkelen"}" />
          </label>
          <label class="settings-row">
            <span>Protokoll</span>
            <select id="orionProto" class="kon-f">
              <option value="auto" ${(set.orion?.protocol || "auto") === "auto" ? "selected" : ""}>Auto (prøv alle)</option>
              <option value="mcp" ${set.orion?.protocol === "mcp" ? "selected" : ""}>MCP JSON-RPC (tools/call)</option>
              <option value="rest" ${set.orion?.protocol === "rest" ? "selected" : ""}>REST (/chat, /api/chat)</option>
              <option value="openai" ${set.orion?.protocol === "openai" ? "selected" : ""}>OpenAI-stil (/v1/chat/completions)</option>
            </select>
          </label>
          <label class="settings-row">
            <span>Chat-sti (valgfri, overstyrer auto — f.eks. <code>/agent/chat</code> eller hel URL)</span>
            <input id="orionChatPath" type="text" class="kon-f" placeholder="/chat eller https://..." value="${esc(set.orion?.chatPath || "")}" />
          </label>
          <label class="settings-row">
            <span>Status-sti (valgfri)</span>
            <input id="orionStatusPath" type="text" class="kon-f" placeholder="/status eller https://..." value="${esc(set.orion?.statusPath || "")}" />
          </label>
          <label class="settings-row">
            <span>Verktøy-navn for MCP (valgfri — f.eks. <code>chat</code>, <code>ask</code>, <code>query</code>)</span>
            <input id="orionTool" type="text" class="kon-f" placeholder="chat" value="${esc(set.orion?.toolName || "")}" />
          </label>
          <label class="settings-row settings-row-check">
            <input type="checkbox" id="orionEnabled" ${set.orion?.enabled ? "checked" : ""} />
            <span><b>Aktiver Orion</b> — bruk denne MCP-en for Status og Chat</span>
          </label>
          <div class="org-actions">
            <button class="btn-primary" id="orionSave">Lagre</button>
            <button class="btn-ghost" id="orionTest">Test status</button>
            <button class="btn-ghost" id="orionTools">🔧 Vis verktøy</button>
            <button class="btn-ghost" id="orionProbe">🔍 Diagnostikk</button>
            <span id="orionTestMsg" class="subnote"></span>
          </div>
          <div id="orionProbeOut" class="probe-out" hidden></div>
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
      const payload = {
        orion: {
          url: document.getElementById("orionUrl").value.trim(),
          key: document.getElementById("orionKey").value.trim(),
          enabled: document.getElementById("orionEnabled").checked,
          protocol: document.getElementById("orionProto").value,
          chatPath: document.getElementById("orionChatPath").value.trim(),
          statusPath: document.getElementById("orionStatusPath").value.trim(),
          toolName: document.getElementById("orionTool").value.trim(),
        },
      };
      await saveSettings(emp.name, payload);
      document.getElementById("orionTestMsg").textContent = "✓ Lagret";
      renderDash();
    });
    document.getElementById("orionTest").addEventListener("click", async () => {
      const msg = document.getElementById("orionTestMsg");
      const out = document.getElementById("orionProbeOut");
      msg.textContent = "Tester status …"; out.hidden = true;
      try {
        const r = await fetch("/api/employee-status?name=" + encodeURIComponent(emp.name));
        const d = await r.json();
        if (d.ok) { msg.textContent = "✓ Tilkobling OK (" + esc(d.source || "") + ")"; }
        else {
          msg.textContent = "✗ " + (d.reason || "Feil");
          if (d.attempts) {
            out.hidden = false;
            out.innerHTML = `<h4>Forsøkte:</h4><table class="probe-tbl"><thead><tr><th>Label</th><th>URL</th><th>Status</th></tr></thead><tbody>${d.attempts.map((a) => `<tr><td>${esc(a.label)}</td><td><code>${esc(a.url)}</code></td><td>${a.error ? `<span class="probe-err">${esc(a.error)}</span>` : esc(String(a.status))}</td></tr>`).join("")}</tbody></table>`;
          }
        }
      } catch (e) { msg.textContent = "✗ " + e.message; }
    });
    document.getElementById("orionTools").addEventListener("click", async () => {
      const msg = document.getElementById("orionTestMsg");
      const out = document.getElementById("orionProbeOut");
      msg.textContent = "Henter verktøy fra Orion …"; out.hidden = true;
      try {
        const r = await fetch("/api/employee-orion-tools?name=" + encodeURIComponent(emp.name));
        const d = await r.json();
        if (!d.ok) { msg.textContent = "✗ " + (d.reason || "Feil"); if (d.snippet) { out.hidden = false; out.innerHTML = `<h4>Svar fra Orion:</h4><pre class="code-snip">${esc(d.snippet)}</pre>`; } return; }
        const tools = d.tools || [];
        msg.textContent = "✓ " + tools.length + " verktøy funnet";
        out.hidden = false;
        out.innerHTML = `<h4>Verktøy i Orion:</h4>
          <table class="probe-tbl">
            <thead><tr><th>Navn</th><th>Beskrivelse</th></tr></thead>
            <tbody>${tools.map((t) => `<tr><td><b>${esc(t.name || "")}</b> <button class="btn-ghost orion-pick-tool" data-name="${esc(t.name || "")}">Bruk</button></td><td class="subnote">${esc(t.description || "")}</td></tr>`).join("")}</tbody>
          </table>
          <p class="subnote">Klikk «Bruk» for å sette verktøyet som default for chat.</p>`;
        out.querySelectorAll(".orion-pick-tool").forEach((b) => b.addEventListener("click", () => {
          document.getElementById("orionTool").value = b.dataset.name;
          msg.textContent = "Sett verktøy: " + b.dataset.name + ". Klikk Lagre.";
        }));
      } catch (e) { msg.textContent = "✗ " + e.message; }
    });
    document.getElementById("orionProbe").addEventListener("click", async () => {
      const msg = document.getElementById("orionTestMsg");
      const out = document.getElementById("orionProbeOut");
      msg.textContent = "Prober Orion …"; out.hidden = true;
      try {
        const r = await fetch("/api/employee-orion-probe?name=" + encodeURIComponent(emp.name));
        const d = await r.json();
        if (!d.ok) { msg.textContent = "✗ " + (d.reason || "Feil"); return; }
        msg.textContent = "✓ Diagnostikk ferdig";
        out.hidden = false;
        out.innerHTML = `<h4>Endepunkter som svarte:</h4>
          <table class="probe-tbl">
            <thead><tr><th>Metode</th><th>URL</th><th>Status</th><th>Type</th><th>Svar</th></tr></thead>
            <tbody>${(d.results || []).map((r) => `<tr>
              <td>${esc(r.method)}</td>
              <td><code>${esc(r.url)}</code></td>
              <td>${r.error ? `<span class="probe-err">err</span>` : `<b class="probe-${r.status < 400 ? "ok" : "err"}">${r.status}</b>`}</td>
              <td class="subnote">${esc(r.contentType || "")}</td>
              <td class="subnote">${esc(r.error || (r.snippet || "").slice(0, 80))}</td>
            </tr>`).join("")}</tbody>
          </table>
          <p class="subnote">Tips: Endepunkt med status 200 og JSON-svar er kandidater. Lim inn URL-en (etter basis-URL) i «Chat-sti» / «Status-sti» og lagre.</p>`;
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

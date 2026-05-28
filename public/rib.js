// Avdelings-dashboard med undertabs:
//   - Timeoversikt (per ansatt, prosjekter siste 4 uker)
//   - Prosjektoversikt (alle prosjekter avdelingen jobber på)
//   - KS (redigerbar liste over KS-saker + prioriterte KS-dokumenter)
//   - Prosjektkoordinering (drag-and-drop kanban, 5 faser)
//   - Økonomi (fast pris / medgått, estimerte timer vs påløpt)
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);
  const nok = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.round(n || 0)) + " kr";
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
  function inferred(deptName, title) {
    const t = String(title || "").trim();
    const d = norm(deptName);
    if (!t) return false;
    if (d === norm("RIB")) return /^(faglig leder rib|avdelingsleder rib|rib)$/i.test(t);
    if (d === norm("RIBr")) return /\bRIBr\b|\bbrann/i.test(t);
    if (d === norm("ARK")) return /\bARK\b/i.test(t) && !/RIB/i.test(t);
    if (d === norm("Ledelse")) {
      if (/(RIB|ARK|RIBr|brann)/i.test(t.replace(/leder/gi, ""))) return false;
      return /\b(daglig leder|faglig leder|avdelingsleder|partner|CEO|leder)\b/i.test(t);
    }
    if (d === norm("Andre rådgivende fag")) return /andre rådgivende/i.test(t);
    if (d === norm("Prosjektadministrasjon / BYGG")) return /(prosjektadm|prosjektleder|bygg)/i.test(t);
    if (d === norm("Intern administrasjon")) return /(administrasjon|hr|intern|kontor|øko)/i.test(t);
    return false;
  }

  const STAGES = [
    { id: "1", label: "1 - Registrering", color: "#fff7d6" },
    { id: "2", label: "2 - Oppstart", color: "#ffffff" },
    { id: "3", label: "3 - Under arbeid", color: "#fdecd9" },
    { id: "4", label: "4 - Til kontroll", color: "#e9f2ff" },
    { id: "5", label: "5 - Utsendt", color: "#dff5e1" },
  ];

  let activeDept = null;
  let activeSub = "timer";
  let orgNodes = [];
  let projects = [];
  let members = {};
  let editingMembers = false;

  let ksAll = {};        // dept -> [...]
  let ksEditing = false;
  let ksDocsAll = {};    // dept -> [{id, name, url, code, note}]
  let kanbanAll = {};    // dept -> { cards }
  let economyData = null;
  let kiOrders = [];     // [{id, agent, customer, customerEmail, orderDate, status, monthlyPrice, note}]
  let tilbudAll = {};    // dept -> { sections: [{title, rows: [{label, unit, price, note}]}] }

  function membersFor(dept) {
    if (Array.isArray(members[dept])) return members[dept];
    return orgNodes.filter((n) => inferred(dept, n.title)).map((n) => n.name);
  }

  /* =================== TIMEOVERSIKT =================== */
  function renderTimer() {
    const grid = document.getElementById("deptGrid");
    const status = document.getElementById("deptStatus");
    if (!grid) return;
    const people = membersFor(activeDept);
    if (!people.length) {
      grid.innerHTML = "";
      status.hidden = false;
      status.textContent = "Ingen ansatte i denne avdelingen. Klikk «Rediger medlemmer».";
      return;
    }
    status.hidden = true;
    grid.innerHTML = people.map((personName) => {
      const projs = projects.map((p) => {
        let hours = 0;
        for (const [empName, t] of Object.entries(p.byEmp4w || {})) {
          if (namesMatch(empName, personName)) { hours += t; break; }
        }
        return { name: p.name, customer: p.customer, hours };
      }).filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours);
      const total = projs.reduce((s, p) => s + p.hours, 0);
      const rows = projs.length
        ? projs.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.customer ? `<span class="rib-cust">${esc(p.customer)}</span>` : ""}</td><td class="num">${num(p.hours)} t</td></tr>`).join("")
        : `<tr><td class="empty" colspan="2">Ingen timer ført siste 4 uker.</td></tr>`;
      return `<div class="rib-card"><div class="rib-head"><span class="rib-name">${esc(personName)}</span><span class="rib-tot">${num(total)} t</span></div><table class="rib-tbl"><tbody>${rows}</tbody></table></div>`;
    }).join("");
  }

  /* =================== PROSJEKTOVERSIKT =================== */
  function renderProsjekter() {
    const box = document.getElementById("deptProjects");
    if (!box) return;
    const people = membersFor(activeDept);
    const list = projects.map((p) => {
      let deptHours = 0;
      const contribs = [];
      for (const [empName, t] of Object.entries(p.byEmp4w || {})) {
        if (people.some((pn) => namesMatch(empName, pn))) { deptHours += t; contribs.push({ name: empName, hours: t }); }
      }
      return { ...p, deptHours, contribs: contribs.sort((a, b) => b.hours - a.hours) };
    }).filter((p) => p.deptHours > 0).sort((a, b) => b.deptHours - a.deptHours);

    if (!list.length) { box.innerHTML = `<div class="empty">Ingen prosjekter med timer fra denne avdelingen siste 4 uker.</div>`; return; }
    box.innerHTML = `
      <table class="dept-proj-tbl">
        <thead><tr><th>Prosjekt</th><th>Kunde</th><th>Prosjektleder</th><th class="num">Timer (avd.) 4u</th><th class="num">Timer total 4u</th><th>Bidragsytere</th></tr></thead>
        <tbody>${list.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b>${p.number ? `<span class="subnote"> · ${esc(p.number)}</span>` : ""}</td>
            <td>${esc(p.customer || "")}</td>
            <td>${esc(p.projectManager || "")}</td>
            <td class="num"><b>${num(p.deptHours)}</b> t</td>
            <td class="num">${num(p.hours4w)} t</td>
            <td>${p.contribs.map((c) => `${esc(c.name.split(" ")[0])} (${num(c.hours)}t)`).join(", ")}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  }

  /* =================== KS — saker + dokumenter =================== */
  async function loadKs() {
    try { const d = await (await fetch("/api/dept-ks")).json(); ksAll = d.ks || {}; } catch { ksAll = {}; }
    try { const d2 = await (await fetch("/api/dept-ksdocs")).json(); ksDocsAll = d2.docs || {}; } catch { ksDocsAll = {}; }
    renderKs();
  }
  function ksFor(dept) { return Array.isArray(ksAll[dept]) ? ksAll[dept] : []; }
  function ksDocsFor(dept) { return Array.isArray(ksDocsAll[dept]) ? ksDocsAll[dept] : []; }
  async function saveKs() {
    try { await fetch("/api/dept-ks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ks: ksAll }) }); } catch {}
  }
  async function saveKsDocs() {
    try { await fetch("/api/dept-ksdocs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docs: ksDocsAll }) }); } catch {}
  }
  function renderKs() {
    const box = document.getElementById("ksList");
    if (!box || !activeDept) return;
    const rows = ksFor(activeDept);
    const docs = ksDocsFor(activeDept);
    document.getElementById("ksAdd").hidden = !ksEditing;
    document.getElementById("ksSave").hidden = !ksEditing;
    document.getElementById("ksEdit").textContent = ksEditing ? "🔒 Lås" : "🔓 Lås opp";

    // Dokument-liste øverst (prioritert rekkefølge, med pil opp/ned + opplastningsknapp)
    const docsHtml = `
      <div class="ks-docs">
        <div class="proj-head" style="margin-top:0">
          <h3 style="margin:0">KS-dokumenter <span class="subnote">— i prioritert rekkefølge</span></h3>
          <div class="org-actions">
            <input type="file" id="ksDocFile" hidden accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.txt" />
            <button id="ksDocUpload" class="btn-ghost">⬆ Last opp dokument</button>
          </div>
        </div>
        ${docs.length ? `
        <ol class="ks-doc-list">
          ${docs.map((d, i) => `
            <li class="ks-doc" data-i="${i}">
              <div class="ks-doc-rank">${i + 1}</div>
              <div class="ks-doc-body">
                <div class="ks-doc-title">
                  ${d.code ? `<span class="ks-doc-code">${esc(d.code)}</span>` : ""}
                  ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener"><b>${esc(d.name)}</b></a>` : `<b>${esc(d.name)}</b>`}
                </div>
                ${d.note ? `<div class="subnote">${esc(d.note)}</div>` : ""}
              </div>
              <div class="ks-doc-actions">
                <button class="btn-ghost ks-doc-up" data-i="${i}" title="Flytt opp" ${i === 0 ? "disabled" : ""}>▲</button>
                <button class="btn-ghost ks-doc-down" data-i="${i}" title="Flytt ned" ${i === docs.length - 1 ? "disabled" : ""}>▼</button>
                <button class="btn-ghost ks-doc-del" data-i="${i}" title="Fjern">🗑</button>
              </div>
            </li>`).join("")}
        </ol>` : `<div class="empty">Ingen dokumenter lastet opp ennå. Klikk «⬆ Last opp dokument» — første dokument blir prioritet 1.</div>`}
      </div>`;

    let sakerHtml = "";
    if (!rows.length) {
      sakerHtml = `<div class="empty">Ingen KS-saker registrert ennå. Lås opp og klikk «+ Sak».</div>`;
    } else if (ksEditing) {
      sakerHtml = `<div class="ks-list">${rows.map((r, i) => `
        <div class="ks-item edit" data-i="${i}">
          <input class="kon-f ks-title" data-f="title" value="${esc(r.title)}" placeholder="Tittel/beskrivelse" />
          <div class="ks-row">
            <input class="kon-f" data-f="owner" value="${esc(r.owner)}" placeholder="Ansvarlig" />
            <select class="kon-f" data-f="status">
              ${["Åpen", "Pågår", "Lukket", "Utsatt"].map((s) => `<option ${r.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
            <input class="kon-f" type="date" data-f="deadline" value="${esc(r.deadline)}" />
            <button class="btn-ghost ks-del">🗑</button>
          </div>
          <textarea class="kon-f" data-f="note" rows="2" placeholder="Notat / status">${esc(r.note)}</textarea>
        </div>`).join("")}</div>`;
    } else {
      sakerHtml = `<table class="ks-tbl">
        <thead><tr><th>Sak</th><th>Ansvarlig</th><th>Status</th><th>Frist</th><th>Notat</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="ks-stat-${esc(String(r.status || "").toLowerCase())}">
            <td><b>${esc(r.title)}</b></td>
            <td>${esc(r.owner)}</td>
            <td><span class="ks-pill ks-${esc(String(r.status || "").toLowerCase())}">${esc(r.status)}</span></td>
            <td>${esc(r.deadline)}</td>
            <td>${esc(r.note).replace(/\n/g, "<br>")}</td>
          </tr>`).join("")}</tbody></table>`;
    }

    box.innerHTML = `${docsHtml}<h3 style="margin-top:18px">KS-saker og avvik</h3>${sakerHtml}`;

    // KS-dokumenter: opplasting + sortering
    const fileInput = document.getElementById("ksDocFile");
    const upBtn = document.getElementById("ksDocUpload");
    if (upBtn && fileInput) {
      upBtn.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const f = fileInput.files?.[0]; if (!f) return;
        if (f.size > 15 * 1024 * 1024) { alert("Filen er for stor (maks 15 MB)."); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await fetch("/api/dept-ksdocs/upload", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dept: activeDept, filename: f.name, dataUrl: reader.result }),
            });
            if (!res.ok) throw new Error("Opplasting feilet");
            const data = await res.json();
            // Hent kode fra filnavn (f.eks. POL-KS-001)
            const m = /([A-Z]{2,4}-[A-Z]{2,4}-\d{3,4})/.exec(f.name);
            const code = m ? m[1] : "";
            const cleanName = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/^[A-Z]{2,4}-[A-Z]{2,4}-\d{3,4}[_\-\s]*/, "");
            if (!ksDocsAll[activeDept]) ksDocsAll[activeDept] = [];
            ksDocsAll[activeDept].push({
              id: "d_" + Math.random().toString(36).slice(2, 9),
              name: cleanName || f.name,
              url: data.url,
              code,
              note: "",
            });
            await saveKsDocs();
            renderKs();
          } catch (e) { alert("Kunne ikke laste opp: " + e.message); }
        };
        reader.readAsDataURL(f);
      };
    }
    box.querySelectorAll(".ks-doc-up").forEach((b) => b.addEventListener("click", async () => {
      const i = Number(b.dataset.i); const arr = ksDocsAll[activeDept];
      if (!arr || i <= 0) return;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; await saveKsDocs(); renderKs();
    }));
    box.querySelectorAll(".ks-doc-down").forEach((b) => b.addEventListener("click", async () => {
      const i = Number(b.dataset.i); const arr = ksDocsAll[activeDept];
      if (!arr || i >= arr.length - 1) return;
      [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; await saveKsDocs(); renderKs();
    }));
    box.querySelectorAll(".ks-doc-del").forEach((b) => b.addEventListener("click", async () => {
      const i = Number(b.dataset.i); const arr = ksDocsAll[activeDept];
      if (!arr) return;
      if (!confirm("Fjerne dokumentet fra lista? Filen ligger fortsatt på serveren.")) return;
      arr.splice(i, 1); await saveKsDocs(); renderKs();
    }));
  }

  /* =================== KANBAN =================== */
  async function loadKanban() {
    try { const d = await (await fetch("/api/dept-kanban")).json(); kanbanAll = d.kanban || {}; } catch { kanbanAll = {}; }
    renderKanban();
  }
  function kanbanFor(dept) {
    if (!kanbanAll[dept]) kanbanAll[dept] = { cards: [] };
    return kanbanAll[dept];
  }
  async function saveKanban() {
    try { await fetch("/api/dept-kanban", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kanban: kanbanAll }) }); } catch {}
  }
  function renderKanban() {
    const board = document.getElementById("kanbanBoard");
    if (!board || !activeDept) return;
    const data = kanbanFor(activeDept);
    board.innerHTML = STAGES.map((st) => {
      const cards = data.cards.filter((c) => c.stage === st.id);
      return `<div class="kb-col" data-stage="${st.id}" style="background:${st.color}">
        <div class="kb-col-head"><span class="kb-col-title">${esc(st.label)}</span><span class="kb-col-count">${cards.length}</span></div>
        <div class="kb-cards" data-stage="${st.id}">
          ${cards.map((c) => `
            <div class="kb-card" draggable="true" data-id="${esc(c.id)}">
              <div class="kb-card-title"><span class="kb-edit-title" contenteditable="true" data-id="${esc(c.id)}" data-f="title">${esc(c.title)}</span></div>
              <div class="kb-card-meta subnote"><span class="kb-edit-title" contenteditable="true" data-id="${esc(c.id)}" data-f="customer">${esc(c.customer || "Legg til kunde")}</span></div>
              ${c.owner || c.dueDate ? `<div class="kb-card-foot"><span class="subnote">${esc(c.owner)}</span>${c.dueDate ? `<span class="kb-due">${esc(c.dueDate)}</span>` : ""}</div>` : ""}
              <button class="kb-del" data-id="${esc(c.id)}">×</button>
            </div>`).join("")}
        </div>
      </div>`;
    }).join("");
    board.querySelectorAll(".kb-card").forEach((card) => {
      card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", card.dataset.id); card.classList.add("dragging"); });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    });
    board.querySelectorAll(".kb-cards").forEach((zone) => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-target"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drop-target"));
      zone.addEventListener("drop", async (e) => {
        e.preventDefault(); zone.classList.remove("drop-target");
        const id = e.dataTransfer.getData("text/plain");
        const stage = zone.dataset.stage;
        const card = data.cards.find((c) => c.id === id);
        if (card && card.stage !== stage) { card.stage = stage; await saveKanban(); renderKanban(); }
      });
    });
    board.querySelectorAll(".kb-edit-title").forEach((el) => {
      el.addEventListener("blur", async () => {
        const id = el.dataset.id, f = el.dataset.f;
        const c = data.cards.find((x) => x.id === id);
        if (!c) return;
        const v = el.textContent.trim();
        if (c[f] !== v) { c[f] = v; await saveKanban(); }
      });
    });
    board.querySelectorAll(".kb-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        data.cards = data.cards.filter((c) => c.id !== id);
        await saveKanban(); renderKanban();
      });
    });
  }
  function addKanbanCard(title, customer, projectNumber) {
    const data = kanbanFor(activeDept);
    data.cards.push({
      id: "k_" + Math.random().toString(36).slice(2, 9),
      title: title || "Nytt prosjekt", customer: customer || "", stage: "1",
      projectNumber: projectNumber || "", owner: "", dueDate: "",
    });
  }

  /* =================== ØKONOMI =================== */
  async function loadEconomy() {
    const box = document.getElementById("deptEconomy");
    const top = document.getElementById("deptEconomyTop");
    if (!box || !activeDept) return;
    box.innerHTML = `<div class="subnote">Henter prosjektregnskap fra Tripletex …</div>`;
    top.innerHTML = "";
    try {
      const d = await (await fetch("/api/dept-economy?dept=" + encodeURIComponent(activeDept))).json();
      economyData = d;
      const s = d.summary || {};
      top.innerHTML = `
        <div class="econ-kpis">
          <div class="econ-kpi"><div class="ek-lbl">Prosjekter</div><div class="ek-val">${num(s.count)}</div></div>
          <div class="econ-kpi"><div class="ek-lbl">Fast pris</div><div class="ek-val">${num(s.fixedCount)}</div></div>
          <div class="econ-kpi"><div class="ek-lbl">Medgått</div><div class="ek-val">${num(s.medgattCount)}</div></div>
          <div class="econ-kpi"><div class="ek-lbl">Sum fastpris</div><div class="ek-val">${nok(s.totalFixedPrice)}</div></div>
          <div class="econ-kpi"><div class="ek-lbl">Timer påløpt</div><div class="ek-val">${num(s.totalHoursLogged)} t</div></div>
          <div class="econ-kpi"><div class="ek-lbl">Timer estimert</div><div class="ek-val">${num(s.totalHoursEstimated)} t</div></div>
        </div>`;
      const rows = d.projects || [];
      if (!rows.length) {
        box.innerHTML = `<div class="empty">Ingen aktive prosjekter med timer fra denne avdelingen.</div>`;
        return;
      }
      box.innerHTML = `<table class="econ-tbl">
        <thead><tr>
          <th>Prosjekt</th><th>Kunde</th><th>PL</th>
          <th>Type</th><th class="num">Fast pris</th>
          <th class="num">Est. timer</th><th class="num">Timer påløpt</th>
          <th class="num">Timer avd.</th><th class="num">Progresjon</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r) => {
          const prog = r.hoursEstimated > 0 ? Math.min(100, Math.round(100 * r.hoursLogged / r.hoursEstimated)) : 0;
          const over = r.hoursEstimated > 0 && r.hoursLogged > r.hoursEstimated;
          return `<tr class="econ-row" data-pid="${esc(r.id)}">
            <td><b>${esc(r.name)}</b>${r.number ? `<span class="subnote"> · ${esc(r.number)}</span>` : ""}</td>
            <td>${esc(r.customer)}</td>
            <td>${esc(r.projectManager)}</td>
            <td><span class="econ-type ${r.isFixedPrice ? "fast" : "medgatt"}">${esc(r.type)}</span></td>
            <td class="num">${r.fixedPrice > 0 ? nok(r.fixedPrice) : "—"}</td>
            <td class="num">${r.hoursEstimated > 0 ? num(r.hoursEstimated) + " t" : "—"}</td>
            <td class="num ${over ? "over" : ""}">${num(r.hoursLogged)} t</td>
            <td class="num">${num(r.hoursDept)} t</td>
            <td class="num"><div class="econ-prog"><div class="econ-prog-bar ${over ? "over" : ""}" style="width:${prog}%"></div><span>${r.hoursEstimated > 0 ? prog + "%" : ""}</span></div></td>
            <td><button class="btn-ghost econ-edit" data-pid="${esc(r.id)}" title="Rediger fast pris / estimat">✏️</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
      box.querySelectorAll(".econ-edit").forEach((b) => b.addEventListener("click", () => openEconomyEdit(b.dataset.pid)));
    } catch (e) {
      box.innerHTML = `<div class="empty">Kunne ikke hente økonomi: ${esc(e.message)}</div>`;
    }
  }
  function openEconomyEdit(pid) {
    const row = (economyData?.projects || []).find((r) => String(r.id) === String(pid));
    if (!row) return;
    const dlg = document.createElement("div");
    dlg.className = "econ-modal";
    dlg.innerHTML = `
      <div class="econ-modal-card">
        <h3>${esc(row.name)}</h3>
        <p class="subnote">${esc(row.customer)} · ${esc(row.projectManager)}</p>
        <label class="econ-fld"><span>Type</span>
          <select id="emType">
            <option value="fast" ${row.isFixedPrice ? "selected" : ""}>Fast pris</option>
            <option value="medgatt" ${!row.isFixedPrice ? "selected" : ""}>Medgått</option>
          </select>
        </label>
        <label class="econ-fld"><span>Fast pris (kr)</span><input id="emPrice" type="number" min="0" step="1000" value="${row.fixedPrice || 0}" /></label>
        <label class="econ-fld"><span>Estimerte timer</span><input id="emHours" type="number" min="0" step="10" value="${row.hoursEstimated || 0}" /></label>
        <label class="econ-fld"><span>Notat</span><textarea id="emNote" rows="3">${esc(row.note || "")}</textarea></label>
        <div class="econ-modal-act">
          <button class="btn-ghost" id="emCancel">Avbryt</button>
          <button class="btn-primary" id="emSave">Lagre</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const close = () => dlg.remove();
    dlg.querySelector("#emCancel").addEventListener("click", close);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
    dlg.querySelector("#emSave").addEventListener("click", async () => {
      const others = {};
      for (const r of (economyData?.projects || [])) {
        if (String(r.id) === String(pid)) continue;
        others[r.id] = { isFixedPrice: r.isFixedPrice, fixedPrice: r.fixedPrice, hoursEstimated: r.hoursEstimated, note: r.note || "" };
      }
      const payload = {
        dept: activeDept,
        projects: { ...others, [pid]: {
          isFixedPrice: dlg.querySelector("#emType").value === "fast",
          fixedPrice: Number(dlg.querySelector("#emPrice").value) || 0,
          hoursEstimated: Number(dlg.querySelector("#emHours").value) || 0,
          note: dlg.querySelector("#emNote").value,
        } },
      };
      try {
        await fetch("/api/dept-economy/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        close(); loadEconomy();
      } catch (e2) { alert("Kunne ikke lagre: " + e2.message); }
    });
  }

  /* =================== KI-BESTILLINGER (kun KI-agenter) =================== */
  async function loadKiOrders() {
    try { const d = await (await fetch("/api/ki-orders")).json(); kiOrders = d.orders || []; } catch { kiOrders = []; }
    renderKiOrders();
  }
  async function saveKiOrders() {
    try { await fetch("/api/ki-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orders: kiOrders }) }); } catch {}
  }
  function renderKiOrders() {
    const list = document.getElementById("kiOrdersList");
    const top = document.getElementById("kiOrdersTop");
    if (!list || !top) return;
    // Summer
    const sumMonthly = kiOrders.reduce((s, o) => s + (Number(o.monthlyPrice) || 0), 0);
    const active = kiOrders.filter((o) => /aktiv/i.test(o.status)).length;
    const agentSet = new Set(kiOrders.map((o) => o.agent).filter(Boolean));
    top.innerHTML = `<div class="econ-kpis" style="grid-template-columns:repeat(4,1fr)">
      <div class="econ-kpi"><div class="ek-lbl">Bestillinger totalt</div><div class="ek-val">${num(kiOrders.length)}</div></div>
      <div class="econ-kpi"><div class="ek-lbl">Aktive</div><div class="ek-val">${num(active)}</div></div>
      <div class="econ-kpi"><div class="ek-lbl">Ulike agenter</div><div class="ek-val">${num(agentSet.size)}</div></div>
      <div class="econ-kpi"><div class="ek-lbl">MRR (eks. mva)</div><div class="ek-val">${nok(sumMonthly)}</div></div>
    </div>`;

    if (!kiOrders.length) {
      list.innerHTML = `<div class="empty">Ingen bestillinger registrert ennå. Klikk «+ Bestilling» for å legge til den første.</div>`;
      return;
    }
    list.innerHTML = `<table class="ki-orders-tbl">
      <thead><tr>
        <th>Agent</th><th>Kunde</th><th>E-post</th><th>Bestilt</th>
        <th>Status</th><th class="num">Pris/mnd</th><th>Notat</th><th></th>
      </tr></thead>
      <tbody>${kiOrders.map((o, i) => `
        <tr class="ki-row" data-i="${i}">
          <td><select class="kon-f" data-f="agent">
            ${["", "Hilde", "Nova", "Embla", "Stein", "Eira", "Saga", "Openclaw"].map((a) => `<option ${o.agent === a ? "selected" : ""}>${a}</option>`).join("")}
          </select></td>
          <td><input class="kon-f" data-f="customer" value="${esc(o.customer)}" placeholder="Kundenavn" /></td>
          <td><input class="kon-f" type="email" data-f="customerEmail" value="${esc(o.customerEmail)}" placeholder="post@kunde.no" /></td>
          <td><input class="kon-f" type="date" data-f="orderDate" value="${esc(o.orderDate)}" /></td>
          <td><select class="kon-f" data-f="status">
            ${["Aktiv", "Prøve", "Pauset", "Avsluttet"].map((s) => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select></td>
          <td><input class="kon-f num" type="number" min="0" step="50" data-f="monthlyPrice" value="${o.monthlyPrice || 0}" /></td>
          <td><input class="kon-f" data-f="note" value="${esc(o.note)}" placeholder="Notat" /></td>
          <td><button class="btn-ghost ki-del" data-i="${i}">🗑</button></td>
        </tr>`).join("")}</tbody>
    </table>`;
  }

  /* =================== TILBUDSARBEID (pris-matrise) =================== */
  async function loadTilbud() {
    try { const d = await (await fetch("/api/dept-tilbud")).json(); tilbudAll = d.tilbud || {}; } catch { tilbudAll = {}; }
    renderTilbud();
  }
  function tilbudFor(dept) {
    if (!tilbudAll[dept]) {
      // Default-skjelett: noen vanlige seksjoner
      tilbudAll[dept] = { sections: [
        { title: "Fastpriser", rows: [] },
        { title: "Enhetspriser", rows: [] },
        { title: "Timepriser", rows: [] },
      ] };
    }
    return tilbudAll[dept];
  }
  async function saveTilbud() {
    try { await fetch("/api/dept-tilbud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tilbud: tilbudAll }) }); } catch {}
  }
  function renderTilbud() {
    const box = document.getElementById("tilbudList");
    if (!box || !activeDept) return;
    const data = tilbudFor(activeDept);
    box.innerHTML = data.sections.map((sec, sIdx) => `
      <div class="tilbud-section" data-s="${sIdx}">
        <div class="tilbud-section-head">
          <input class="kon-f tilbud-sec-title" data-s="${sIdx}" value="${esc(sec.title)}" placeholder="Seksjonsnavn" />
          <button class="btn-ghost tilbud-row-add" data-s="${sIdx}">+ Rad</button>
          <button class="btn-ghost tilbud-sec-del" data-s="${sIdx}" title="Slett seksjon">🗑</button>
        </div>
        <table class="tilbud-tbl">
          <thead><tr><th>Beskrivelse</th><th>Enhet</th><th class="num">Pris (kr)</th><th>Notat</th><th></th></tr></thead>
          <tbody>${sec.rows.map((r, rIdx) => `
            <tr data-s="${sIdx}" data-r="${rIdx}">
              <td><input class="kon-f" data-f="label" value="${esc(r.label)}" placeholder="Beskrivelse" /></td>
              <td><input class="kon-f" data-f="unit" value="${esc(r.unit)}" placeholder="stk / m² / time / fast" /></td>
              <td><input class="kon-f num" type="number" min="0" step="100" data-f="price" value="${r.price || 0}" /></td>
              <td><input class="kon-f" data-f="note" value="${esc(r.note || "")}" placeholder="Notat" /></td>
              <td><button class="btn-ghost tilbud-row-del" data-s="${sIdx}" data-r="${rIdx}">🗑</button></td>
            </tr>`).join("") || `<tr><td colspan="5" class="empty">Ingen rader ennå. Klikk «+ Rad».</td></tr>`}</tbody>
        </table>
      </div>`).join("") + `<div class="org-actions" style="margin-top:10px"><button id="tilbudSecAdd" class="btn-ghost">+ Ny seksjon</button><button id="tilbudSave" class="btn-primary">Lagre</button></div>`;
  }

  /* =================== MEDLEMS-EDITOR =================== */
  function renderMemberEditor() {
    const box = document.getElementById("deptMemberEdit");
    if (!editingMembers || !activeDept) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const chosen = new Set(membersFor(activeDept));
    const all = orgNodes.slice().sort((a, b) => a.name.localeCompare(b.name, "nb"));
    box.innerHTML = `<p class="subnote">Huk av hvem som hører til <b>${esc(activeDept)}</b>. Lagres automatisk.</p>
      <div class="dept-checks">${all.map((n) => `
        <label class="dept-check"><input type="checkbox" data-name="${esc(n.name)}" ${chosen.has(n.name) ? "checked" : ""}/> <span>${esc(n.name)}</span>${n.title ? `<span class="subnote"> · ${esc(n.title)}</span>` : ""}</label>
      `).join("")}</div>
      <div class="org-actions" style="margin-top:8px"><button id="deptEditDone" class="btn-primary">Ferdig</button></div>`;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", async () => {
      const list = [...box.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.dataset.name);
      members[activeDept] = list;
      try { await fetch("/api/department-members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ members }) }); } catch {}
      renderActiveSub();
    }));
    document.getElementById("deptEditDone").addEventListener("click", () => { editingMembers = false; renderMemberEditor(); });
  }

  /* =================== SUBTAB-BYTTE =================== */
  function renderActiveSub() {
    if (activeSub === "timer") renderTimer();
    else if (activeSub === "prosjekter") renderProsjekter();
    else if (activeSub === "ks") renderKs();
    else if (activeSub === "kanban") renderKanban();
    else if (activeSub === "okonomi") loadEconomy();
    else if (activeSub === "kiorders") loadKiOrders();
    else if (activeSub === "tilbud") loadTilbud();
  }
  function setSubtab(sub) {
    activeSub = sub;
    document.querySelectorAll("#deptSubtabs .subtab").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
    document.querySelectorAll("#panel-avdelinger .subview").forEach((v) => { v.hidden = true; v.classList.remove("active"); });
    const map = { timer: "subTimer", prosjekter: "subProsjekter", ks: "subKs", kanban: "subKanban", okonomi: "subOkonomi", kiorders: "subKiOrders", tilbud: "subTilbud" };
    const el = document.getElementById(map[sub]);
    if (el) { el.hidden = false; el.classList.add("active"); }
    renderActiveSub();
  }
  function setActive(dept) {
    activeDept = dept;
    editingMembers = false;
    document.querySelectorAll("#avdGrid .avd-chip").forEach((c) => c.classList.toggle("active", c.dataset.deptName === dept));
    document.getElementById("deptSubtabs").hidden = false;
    document.getElementById("deptEditMembers").hidden = false;
    document.getElementById("deptDashTitle").textContent = dept + " – dashboard";
    // KI-bestillinger-fanen vises kun for KI-agenter-avdelingen
    const isKi = /KI[-\s]?agenter/i.test(dept);
    const kiBtn = document.querySelector('#deptSubtabs .subtab[data-sub="kiorders"]');
    if (kiBtn) kiBtn.hidden = !isKi;
    // For KI-agenter er Bestillinger den primære fanen
    if (isKi && (activeSub === "timer" || activeSub === "prosjekter")) activeSub = "kiorders";
    if (!isKi && activeSub === "kiorders") activeSub = "timer";
    document.querySelectorAll("#deptSubtabs .subtab").forEach((b) => b.classList.toggle("active", b.dataset.sub === activeSub));
    document.querySelectorAll("#panel-avdelinger .subview").forEach((v) => { v.hidden = true; v.classList.remove("active"); });
    const map = { timer: "subTimer", prosjekter: "subProsjekter", ks: "subKs", kanban: "subKanban", okonomi: "subOkonomi", kiorders: "subKiOrders", tilbud: "subTilbud" };
    const el = document.getElementById(map[activeSub]);
    if (el) { el.hidden = false; el.classList.add("active"); }
    renderMemberEditor();
    renderActiveSub();
  }

  /* =================== DATA =================== */
  async function loadAll() {
    try {
      const [ovRes, orgRes, memRes] = await Promise.all([
        fetch("/api/overview"), fetch("/api/org"), fetch("/api/department-members"),
      ]);
      const ov = await ovRes.json();
      const org = await orgRes.json();
      const mem = await memRes.json();
      orgNodes = org.nodes || [];
      projects = ov.projectsDetailed || [];
      members = mem.members || {};
      loadKs(); loadKanban(); loadTilbud();
      if (activeDept) renderActiveSub();
    } catch (e) {
      const status = document.getElementById("deptStatus");
      if (status) { status.hidden = false; status.textContent = "Kunne ikke hente data: " + e.message; }
    }
  }

  /* =================== EVENTS =================== */
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#avdGrid .avd-chip");
    if (chip && chip.dataset.deptName) { setActive(chip.dataset.deptName); return; }
    if (e.target.id === "deptReload") return loadAll();
    if (e.target.id === "deptEditMembers") { editingMembers = !editingMembers; renderMemberEditor(); return; }

    const sub = e.target.closest("#deptSubtabs .subtab");
    if (sub && sub.dataset.sub) return setSubtab(sub.dataset.sub);

    if (e.target.id === "ksEdit") { ksEditing = !ksEditing; renderKs(); return; }
    if (e.target.id === "ksAdd") {
      if (!ksAll[activeDept]) ksAll[activeDept] = [];
      ksAll[activeDept].push({ id: "ks_" + Math.random().toString(36).slice(2, 9), title: "", owner: "", status: "Åpen", deadline: "", note: "" });
      renderKs(); return;
    }
    if (e.target.id === "ksSave") { saveKs().then(() => { ksEditing = false; renderKs(); }); return; }
    if (e.target.classList && e.target.classList.contains("ks-del")) {
      const item = e.target.closest(".ks-item");
      if (item) { ksAll[activeDept].splice(Number(item.dataset.i), 1); renderKs(); }
      return;
    }

    // KI-bestillinger
    if (e.target.id === "kiOrderAdd") {
      kiOrders.push({ id: "ki_" + Math.random().toString(36).slice(2, 9), agent: "", customer: "", customerEmail: "", orderDate: new Date().toISOString().slice(0, 10), status: "Aktiv", monthlyPrice: 0, note: "" });
      renderKiOrders(); return;
    }
    if (e.target.id === "kiOrderSave") { saveKiOrders().then(() => { const b = document.getElementById("kiOrderSave"); if (b) { b.textContent = "Lagret ✓"; setTimeout(() => b.textContent = "Lagre", 1500); } }); return; }
    if (e.target.classList && e.target.classList.contains("ki-del")) {
      const i = Number(e.target.dataset.i);
      if (Number.isFinite(i)) { kiOrders.splice(i, 1); renderKiOrders(); }
      return;
    }

    // Tilbudsarbeid
    if (e.target.id === "tilbudSecAdd") {
      const d = tilbudFor(activeDept);
      d.sections.push({ title: "Ny seksjon", rows: [] });
      renderTilbud(); return;
    }
    if (e.target.id === "tilbudSave") { saveTilbud().then(() => { const b = document.getElementById("tilbudSave"); if (b) { b.textContent = "Lagret ✓"; setTimeout(() => b.textContent = "Lagre", 1500); } }); return; }
    if (e.target.classList && e.target.classList.contains("tilbud-row-add")) {
      const s = Number(e.target.dataset.s);
      const d = tilbudFor(activeDept);
      if (d.sections[s]) { d.sections[s].rows.push({ label: "", unit: "", price: 0, note: "" }); renderTilbud(); }
      return;
    }
    if (e.target.classList && e.target.classList.contains("tilbud-row-del")) {
      const s = Number(e.target.dataset.s), r = Number(e.target.dataset.r);
      const d = tilbudFor(activeDept);
      if (d.sections[s]) { d.sections[s].rows.splice(r, 1); renderTilbud(); }
      return;
    }
    if (e.target.classList && e.target.classList.contains("tilbud-sec-del")) {
      const s = Number(e.target.dataset.s);
      const d = tilbudFor(activeDept);
      if (d.sections[s] && confirm("Slette seksjonen «" + d.sections[s].title + "»?")) { d.sections.splice(s, 1); renderTilbud(); }
      return;
    }

    if (e.target.id === "kanbanAdd") {
      const title = prompt("Tittel på nytt kort:");
      if (title) { addKanbanCard(title, "", ""); saveKanban().then(renderKanban); }
      return;
    }
    if (e.target.id === "kanbanFromActive") {
      const people = membersFor(activeDept);
      const data = kanbanFor(activeDept);
      const existing = new Set(data.cards.map((c) => (c.title + "|" + c.customer).toLowerCase()));
      let added = 0;
      projects.forEach((p) => {
        const hasDept = Object.keys(p.byEmp4w || {}).some((empName) => people.some((pn) => namesMatch(empName, pn)));
        if (!hasDept) return;
        const key = (p.name + "|" + (p.customer || "")).toLowerCase();
        if (existing.has(key)) return;
        addKanbanCard(p.name, p.customer || "", p.number || "");
        added++;
      });
      if (added > 0) saveKanban().then(renderKanban);
      else alert("Alle aktive prosjekter ligger allerede i kanban-en.");
      return;
    }
  });

  document.addEventListener("input", (e) => {
    const item = e.target.closest("#ksList .ks-item.edit");
    if (item && e.target.dataset.f) {
      const i = Number(item.dataset.i);
      const f = e.target.dataset.f;
      if (ksAll[activeDept] && ksAll[activeDept][i]) ksAll[activeDept][i][f] = e.target.value;
      return;
    }
    // KI-bestillinger inline-redigering
    const kiRow = e.target.closest("#kiOrdersList .ki-row");
    if (kiRow && e.target.dataset.f) {
      const i = Number(kiRow.dataset.i);
      const f = e.target.dataset.f;
      if (kiOrders[i]) kiOrders[i][f] = (f === "monthlyPrice") ? (Number(e.target.value) || 0) : e.target.value;
      return;
    }
    // Tilbudsarbeid inline-redigering
    const tRow = e.target.closest(".tilbud-tbl tbody tr");
    if (tRow && e.target.dataset.f) {
      const s = Number(tRow.dataset.s), r = Number(tRow.dataset.r);
      const d = tilbudFor(activeDept);
      if (d.sections[s] && d.sections[s].rows[r]) {
        const f = e.target.dataset.f;
        d.sections[s].rows[r][f] = (f === "price") ? (Number(e.target.value) || 0) : e.target.value;
      }
      return;
    }
    if (e.target.classList && e.target.classList.contains("tilbud-sec-title")) {
      const s = Number(e.target.dataset.s);
      const d = tilbudFor(activeDept);
      if (d.sections[s]) d.sections[s].title = e.target.value;
    }
  });

  let loaded = false;
  const tab = document.querySelector('.tab[data-tab="avdelinger"]');
  if (tab) tab.addEventListener("click", () => { if (!loaded) { loaded = true; loadAll(); } });
})();

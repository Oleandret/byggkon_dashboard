// Levende kompetansematrise (Ansatte-fanen).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tbl = document.getElementById("kompTable");
  const status = document.getElementById("kompStatus");
  const editBtn = document.getElementById("kompEdit");
  const saveBtn = document.getElementById("kompSave");
  const addSkillBtn = document.getElementById("kompAddSkill");
  const addPersonBtn = document.getElementById("kompAddPerson");
  const searchEl = document.getElementById("kompSearch");

  let data = null, editing = false, dirty = false, loaded = false;

  function err(msg) {
    const el = document.getElementById("errorBanner");
    el.textContent = msg; el.hidden = false; setTimeout(() => (el.hidden = true), 8000);
  }
  const allSkills = () => data.groups.flatMap((g) => g.skills);
  function markDirty() { dirty = true; saveBtn.textContent = "Lagre *"; }

  function renderLegend() {
    const sc = (data.scale && data.scale.length) ? data.scale
      : [{ v: 0, label: "Ingen" }, { v: 1, label: "Noe" }, { v: 2, label: "En del" }, { v: 3, label: "Lang erfaring" }, { v: 4, label: "Superbruker" }];
    document.getElementById("kompLegend").innerHTML =
      sc.map((s) => `<span class="lg"><span class="sw lvl${s.v}"></span> ${s.v} – ${esc(s.label)}</span>`).join("");
  }

  function render() {
    const q = (searchEl.value || "").toLowerCase().trim();
    let groups = data.groups;
    let employees = data.employees;
    if (q) {
      const nameHits = data.employees.filter((e) => e.name.toLowerCase().includes(q));
      if (nameHits.length) {
        employees = nameHits;
      } else {
        groups = data.groups
          .map((g) => ({ name: g.name, skills: g.skills.filter((s) => s.toLowerCase().includes(q)) }))
          .filter((g) => g.skills.length);
      }
    }
    let groupRow = `<th class="namecol" rowspan="2">Medarbeider</th>`;
    let skillRow = "";
    for (const g of groups) {
      if (!g.skills.length) continue;
      groupRow += `<th class="group-th" colspan="${g.skills.length}">${esc(g.name)}</th>`;
      for (const s of g.skills) skillRow += `<th class="skill-th">${esc(s)}</th>`;
    }
    const flat = groups.flatMap((g) => g.skills);
    let body = "";
    for (const e of employees) {
      const ei = data.employees.indexOf(e);
      let row = `<td class="namecol">${esc(e.name)}${e.email ? `<span class="nm-sub">${esc(e.email)}</span>` : ""}</td>`;
      for (const s of flat) {
        const v = Math.max(0, Math.min(4, (e.ratings && e.ratings[s]) || 0));
        row += `<td class="cell lvl${v}" data-ei="${ei}" data-skill="${esc(s)}">${v || ""}</td>`;
      }
      body += `<tr>${row}</tr>`;
    }
    tbl.innerHTML = `<thead><tr class="groups">${groupRow}</tr><tr class="skills">${skillRow}</tr></thead><tbody>${body}</tbody>`;
    tbl.classList.toggle("editing", editing);
  }

  // Klikk i celle (redigering): øk nivå 0→1→2→3→4→0
  tbl.addEventListener("click", (e) => {
    if (!editing) return;
    const td = e.target.closest("td.cell");
    if (!td) return;
    const emp = data.employees[Number(td.dataset.ei)];
    const skill = td.dataset.skill;
    if (!emp) return;
    if (!emp.ratings) emp.ratings = {};
    const v = ((emp.ratings[skill] || 0) + 1) % 5;
    emp.ratings[skill] = v;
    td.className = `cell lvl${v}`;
    td.textContent = v || "";
    markDirty();
  });

  function setEditing(on) {
    editing = on;
    editBtn.textContent = on ? "🔒 Lås arket" : "🔓 Lås opp arket";
    saveBtn.hidden = !on; addSkillBtn.hidden = !on; addPersonBtn.hidden = !on;
    document.getElementById("kompHint").textContent = on
      ? "Arket er åpent: klikk i en celle for å øke nivået (0→4→0). + Ferdighet / + Person legger til. Husk å lagre, og lås arket igjen når du er ferdig."
      : "Arket er låst (skrivebeskyttet). Trykk «Lås opp arket» for å legge inn eller endre kompetanse.";
    tbl.classList.toggle("editing", on);
  }
  editBtn.addEventListener("click", () => setEditing(!editing));
  searchEl.addEventListener("input", render);

  addSkillBtn.addEventListener("click", () => {
    const name = (prompt("Navn på ny ferdighet:") || "").trim();
    if (!name) return;
    let grp = data.groups.find((g) => g.name === "Egendefinert");
    if (!grp) { grp = { name: "Egendefinert", skills: [] }; data.groups.push(grp); }
    if (!grp.skills.includes(name)) grp.skills.push(name);
    markDirty(); render();
  });
  addPersonBtn.addEventListener("click", () => {
    const name = (prompt("Navn på person:") || "").trim();
    if (!name) return;
    const email = (prompt("E-post (valgfritt):") || "").trim();
    data.employees.push({ name, email, ratings: {} });
    markDirty(); render();
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/competence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scale: data.scale, groups: data.groups, employees: data.employees }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      dirty = false; saveBtn.textContent = "Lagret ✓";
      setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); }
    finally { saveBtn.disabled = false; }
  });

  async function loadCompetence(force = false) {
    if (loaded && !force) return;
    try {
      const res = await fetch("/api/competence");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      data = { scale: d.scale || [], groups: d.groups || [], employees: d.employees || [] };
      loaded = true;
      status.hidden = true;
      renderLegend(); render();
    } catch (e2) {
      status.hidden = false; status.textContent = "Kunne ikke hente kompetansematrise: " + e2.message;
    }
  }

  window.addEventListener("beforeunload", (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ""; } });
  const tabBtn = document.querySelector('.tab[data-tab="ansatte"]');
  if (tabBtn) tabBtn.addEventListener("click", () => loadCompetence());
})();

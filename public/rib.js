// Avdelings-dashboards. Alle avdelingschips er klikkbare. For hver avdeling
// kan medlemmer redigeres (lagres på server). Default-medlemmer utledes fra
// organisasjonskart-titler hvis ingen er lagret manuelt for den avdelingen.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n || 0);
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const nameKey = (n) => { const a = norm(n).split(" "); return a.length < 2 ? a[0] || "" : a[0] + " " + a[a.length - 1]; };

  // Heuristisk default-tilhørighet basert på tittel i org-kartet
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

  let activeDept = null;
  let orgNodes = [];
  let projects = [];
  let members = {}; // dept -> [names]
  let editingMembers = false;

  function membersFor(dept) {
    if (Array.isArray(members[dept])) return members[dept];
    return orgNodes.filter((n) => inferred(dept, n.title)).map((n) => n.name);
  }

  function render() {
    const grid = document.getElementById("deptGrid");
    const status = document.getElementById("deptStatus");
    const title = document.getElementById("deptDashTitle");
    const edit = document.getElementById("deptEditMembers");
    if (!grid) return;
    if (!activeDept) {
      title.textContent = "Velg en avdeling øverst";
      edit.hidden = true;
      grid.innerHTML = "";
      status.hidden = true;
      return;
    }
    title.textContent = activeDept + " – dashboard";
    edit.hidden = false;
    const people = membersFor(activeDept);
    if (!people.length) {
      grid.innerHTML = "";
      status.hidden = false;
      status.textContent = "Ingen ansatte i denne avdelingen. Klikk «Rediger medlemmer» for å legge til.";
      return;
    }
    status.hidden = true;
    grid.innerHTML = people.map((personName) => {
      const target = nameKey(personName);
      const projs = projects.map((p) => {
        let hours = 0;
        for (const [empName, t] of Object.entries(p.byEmp4w || {})) {
          if (nameKey(empName) === target) { hours += t; break; }
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
      render();
    }));
    document.getElementById("deptEditDone").addEventListener("click", () => { editingMembers = false; renderMemberEditor(); });
  }

  function setActive(dept) {
    activeDept = dept;
    editingMembers = false;
    document.querySelectorAll("#avdGrid .avd-chip").forEach((c) => c.classList.toggle("active", c.dataset.deptName === dept));
    renderMemberEditor();
    render();
  }

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
      render();
    } catch (e) {
      const status = document.getElementById("deptStatus");
      if (status) { status.hidden = false; status.textContent = "Kunne ikke hente data: " + e.message; }
    }
  }

  // Klikk på avdelingschip
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#avdGrid .avd-chip");
    if (chip && chip.dataset.deptName) setActive(chip.dataset.deptName);
    if (e.target.id === "deptReload") loadAll();
    if (e.target.id === "deptEditMembers") { editingMembers = !editingMembers; renderMemberEditor(); }
  });

  let loaded = false;
  const tab = document.querySelector('.tab[data-tab="avdelinger"]');
  if (tab) tab.addEventListener("click", () => { if (!loaded) { loaded = true; loadAll(); } });
})();

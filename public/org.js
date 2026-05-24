// Dynamisk, redigerbart organisasjonskart.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const chartEl = document.getElementById("orgChart");
  const hint = document.getElementById("orgHint");
  const toggleBtn = document.getElementById("orgEditToggle");
  const addRootBtn = document.getElementById("orgAddRoot");
  const saveBtn = document.getElementById("orgSave");
  const resetBtn = document.getElementById("orgReset");

  let nodes = [];        // [{id,name,title,email,phone,parentId}]
  let editing = false;
  let dirty = false;
  let dragId = null;

  function orgError(msg) {
    const el = document.getElementById("errorBanner");
    el.textContent = msg; el.hidden = false;
    setTimeout(() => (el.hidden = true), 8000);
  }
  const byId = (id) => nodes.find((n) => n.id === id);
  const childrenOf = (id) => nodes.filter((n) => n.parentId === id);
  const roots = () => nodes.filter((n) => n.parentId == null || !byId(n.parentId));
  const genId = () => "n" + Date.now().toString(36) + Math.floor(Math.random() * 1000);

  function isDescendant(maybeChildId, ancestorId) {
    let cur = byId(maybeChildId);
    const seen = new Set();
    while (cur && cur.parentId != null && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = byId(cur.parentId);
    }
    return false;
  }

  function nodeCard(n) {
    const isLead = /leder|daglig/i.test(n.title || "");
    const tools = editing
      ? `<div class="on-tools">
           <button data-act="add" data-id="${n.id}" title="Legg til under">＋</button>
           <button data-act="edit" data-id="${n.id}" title="Rediger">✎</button>
           <button data-act="del" data-id="${n.id}" title="Slett">🗑</button>
         </div>`
      : "";
    const contact = [n.email, n.phone].filter(Boolean).join(" · ");
    return `<div class="org-node ${isLead ? "lead" : ""}" draggable="${editing}" data-id="${n.id}">
      ${tools}
      <span class="on-name">${esc(n.name)}</span>
      ${n.title ? `<span class="on-title">${esc(n.title)}</span>` : ""}
      ${contact ? `<span class="on-contact">${esc(contact)}</span>` : ""}
    </div>`;
  }

  function renderNode(n) {
    const kids = childrenOf(n.id);
    const sub = kids.length ? `<ul>${kids.map((k) => `<li>${renderNode(k)}</li>`).join("")}</ul>` : "";
    return nodeCard(n) + sub;
  }

  function render() {
    const rs = roots();
    if (!rs.length) {
      chartEl.innerHTML = `<p class="empty">Ingen personer. Klikk «+ Person» for å starte.</p>`;
      return;
    }
    chartEl.innerHTML = `<ul>${rs.map((r) => `<li>${renderNode(r)}</li>`).join("")}</ul>`;
    chartEl.classList.toggle("editing", editing);
    if (editing) wireDnD();
  }

  // ---- Drag & drop for å endre hvem man rapporterer til ----
  function wireDnD() {
    chartEl.querySelectorAll(".org-node").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        dragId = el.dataset.id; el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); dragId = null;
        chartEl.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over")); });
      el.addEventListener("dragover", (e) => {
        if (!dragId || dragId === el.dataset.id) return;
        e.preventDefault(); el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (e) => {
        e.preventDefault(); el.classList.remove("drag-over");
        reparent(dragId, el.dataset.id);
      });
    });
  }

  function reparent(childId, newParentId) {
    if (!childId || childId === newParentId) return;
    const child = byId(childId);
    if (!child) return;
    if (newParentId === childId || isDescendant(newParentId, childId)) {
      orgError("Kan ikke flytte en person inn under sin egen underordnede.");
      return;
    }
    // Ikke la siste rot bli borte
    if ((child.parentId == null || !byId(child.parentId)) && roots().length <= 1) {
      orgError("Dette er øverste leder. Legg en annen person øverst først om du vil endre toppen.");
      return;
    }
    child.parentId = newParentId;
    markDirty(); render();
  }

  // ---- Modal (legg til / rediger) ----
  const modal = document.getElementById("orgModal");
  let modalMode = null; // {type:'add'|'edit', id, parentId}
  function openModal(title, vals, mode) {
    document.getElementById("orgModalTitle").textContent = title;
    document.getElementById("m_name").value = vals.name || "";
    document.getElementById("m_title").value = vals.title || "";
    document.getElementById("m_email").value = vals.email || "";
    document.getElementById("m_phone").value = vals.phone || "";
    modalMode = mode; modal.hidden = false;
    document.getElementById("m_name").focus();
  }
  function closeModal() { modal.hidden = true; modalMode = null; }
  document.getElementById("m_cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.getElementById("m_save").addEventListener("click", () => {
    const data = {
      name: document.getElementById("m_name").value.trim(),
      title: document.getElementById("m_title").value.trim(),
      email: document.getElementById("m_email").value.trim(),
      phone: document.getElementById("m_phone").value.trim(),
    };
    if (!data.name) { orgError("Navn må fylles ut."); return; }
    if (modalMode.type === "edit") {
      Object.assign(byId(modalMode.id), data);
    } else {
      nodes.push({ id: genId(), parentId: modalMode.parentId, ...data });
    }
    markDirty(); closeModal(); render();
  });

  // ---- Knapper på node-kort ----
  chartEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.act, n = byId(id);
    if (act === "edit") openModal("Rediger person", n, { type: "edit", id });
    else if (act === "add") openModal("Legg til person", {}, { type: "add", parentId: id });
    else if (act === "del") deleteNode(id);
  });

  function deleteNode(id) {
    const n = byId(id);
    if (!n) return;
    const kids = childrenOf(id);
    if (!confirm(`Slette ${n.name}?` + (kids.length ? ` ${kids.length} underordnede flyttes opp ett nivå.` : ""))) return;
    const wasRoot = n.parentId == null || !byId(n.parentId);
    if (wasRoot && kids.length) {
      // Forfrem første barn til ny rot, resten under den
      const newRoot = kids[0]; newRoot.parentId = null;
      kids.slice(1).forEach((k) => (k.parentId = newRoot.id));
    } else {
      kids.forEach((k) => (k.parentId = n.parentId));
    }
    nodes = nodes.filter((x) => x.id !== id);
    markDirty(); render();
  }

  // ---- Edit-modus ----
  function setEditing(on) {
    editing = on;
    toggleBtn.textContent = on ? "✓ Ferdig" : "✎ Rediger";
    addRootBtn.hidden = !on;
    saveBtn.hidden = !on;
    resetBtn.hidden = !on;
    hint.textContent = on
      ? "Dra et kort oppå en annen for å endre hvem hen rapporterer til. ＋ legger til, ✎ endrer, 🗑 sletter."
      : "Skrivebeskyttet. Klikk «Rediger» for å flytte personer, legge til eller endre.";
    render();
  }
  toggleBtn.addEventListener("click", () => setEditing(!editing));
  addRootBtn.addEventListener("click", () => {
    const r = roots()[0];
    openModal("Legg til person", {}, { type: "add", parentId: r ? r.id : null });
  });

  function markDirty() { dirty = true; saveBtn.textContent = "Lagre *"; }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      dirty = false; saveBtn.textContent = "Lagret ✓";
      setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (err) {
      orgError("Kunne ikke lagre: " + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn.addEventListener("click", () => { if (dirty && !confirm("Forkaste ulagrede endringer?")) return; loadOrg(); });

  async function loadOrg() {
    try {
      const res = await fetch("/api/org");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      nodes = (d.nodes || []).map((n) => ({ ...n }));
      dirty = false; saveBtn.textContent = "Lagre";
      render();
    } catch (err) {
      orgError("Kunne ikke hente organisasjonskart: " + err.message);
    }
  }

  // Advarsel ved navigering bort med ulagrede endringer
  window.addEventListener("beforeunload", (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ""; } });

  loadOrg();
})();

// HR – plantegning med ansatt-pins (klikk for å plassere, dra for å flytte).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const wrap = document.getElementById("floorWrap");
  const img = document.getElementById("floorImg");
  const pinsEl = document.getElementById("floorPins");
  const editBtn = document.getElementById("hrEdit");
  const saveBtn = document.getElementById("hrSave");
  const planSel = document.getElementById("hrPlan");
  const uploadRow = document.getElementById("hrUploadRow");
  let floorplans = [], curId = null, editing = false, dirty = false, loaded = false, dragIdx = -1;

  function err(msg) { const el = document.getElementById("errorBanner"); el.textContent = msg; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }
  const curPlan = () => floorplans.find((p) => p.id === curId);
  const pins = () => (curPlan() ? (curPlan().pins = curPlan().pins || []) : []);

  function render() {
    const p = curPlan();
    if (p && p.url) { img.src = p.url; img.style.display = ""; document.getElementById("floorMissing").hidden = true; }
    else { img.removeAttribute("src"); img.style.display = "none"; document.getElementById("floorMissing").hidden = false; }
    img.onerror = () => { document.getElementById("floorMissing").hidden = false; };
    pinsEl.innerHTML = pins().map((pn, i) =>
      `<div class="floor-pin${editing ? " edit" : ""}" style="left:${pn.x}%;top:${pn.y}%" data-i="${i}">
        <span class="fp-dot"></span><span class="fp-label">${esc(pn.name)}</span>
      </div>`).join("");
  }

  img.addEventListener("click", (e) => {
    if (!editing) return;
    const r = img.getBoundingClientRect();
    const name = (prompt("Navn på ansatt for denne plassen:") || "").trim();
    if (!name) return;
    pins().push({ name, x: Math.round(((e.clientX - r.left) / r.width) * 1000) / 10, y: Math.round(((e.clientY - r.top) / r.height) * 1000) / 10 });
    dirty = true; render();
  });
  pinsEl.addEventListener("mousedown", (e) => {
    if (!editing) return; const el = e.target.closest(".floor-pin"); if (!el) return;
    dragIdx = Number(el.dataset.i); e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (dragIdx < 0 || !editing) return; const r = img.getBoundingClientRect();
    pins()[dragIdx].x = Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 1000) / 10));
    pins()[dragIdx].y = Math.max(0, Math.min(100, Math.round(((e.clientY - r.top) / r.height) * 1000) / 10));
    dirty = true; render();
  });
  window.addEventListener("mouseup", () => { dragIdx = -1; });
  pinsEl.addEventListener("dblclick", (e) => {
    if (!editing) return; const el = e.target.closest(".floor-pin"); if (!el) return;
    const i = Number(el.dataset.i);
    if (confirm(`Fjern markøren for ${pins()[i].name}?`)) { pins().splice(i, 1); dirty = true; render(); }
  });

  function setEditing(on) {
    editing = on;
    editBtn.textContent = on ? "🔒 Lås" : "🔓 Lås opp";
    saveBtn.hidden = !on;
    if (uploadRow) uploadRow.hidden = !on;
    document.getElementById("hrHint").textContent = on
      ? "Last opp plantegning for valgt kontor, og klikk på tegningen for å sette markører. Dra for å flytte, dobbeltklikk for å fjerne. Husk å lagre."
      : "Plantegning over kontoret. Velg kontor i nedtrekkslista. Lås opp for å laste opp bilde og plassere ansatte.";
    wrap.classList.toggle("editing", on);
    render();
  }
  editBtn.addEventListener("click", () => setEditing(!editing));
  if (planSel) planSel.addEventListener("change", () => { curId = planSel.value; render(); });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/hr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ floorplans }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      dirty = false; saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); }
    finally { saveBtn.disabled = false; }
  });

  // Opplasting av plantegning for valgt kontor
  const upBtn = document.getElementById("hrUpload");
  if (upBtn) upBtn.addEventListener("click", () => {
    const f = document.getElementById("hrFile").files[0];
    const msg = document.getElementById("hrUploadMsg");
    if (!f) { msg.textContent = "Velg en bildefil først."; return; }
    if (f.size > 12 * 1024 * 1024) { msg.textContent = "Bildet er for stort (maks 12 MB)."; return; }
    msg.textContent = "Laster opp …";
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch("/api/hr/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: curId, dataUrl: reader.result }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || "Opplasting feilet");
        if (curPlan()) curPlan().url = d.url;
        msg.textContent = "✓ Lastet opp.";
        render();
      } catch (e2) { msg.textContent = "Feil: " + e2.message; }
    };
    reader.readAsDataURL(f);
  });

  async function loadHR() {
    if (loaded) return;
    try {
      const res = await fetch("/api/hr");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      floorplans = (d.floorplans || []).map((p) => ({ ...p, pins: (p.pins || []).map((x) => ({ ...x })) }));
      if (planSel) planSel.innerHTML = floorplans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
      curId = floorplans[0] ? floorplans[0].id : null;
      if (planSel && curId) planSel.value = curId;
      loaded = true; render();
    } catch (e2) { err("Kunne ikke hente HR-data: " + e2.message); }
  }

  window.addEventListener("beforeunload", (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ---- Underfaner i HR ----
  document.querySelectorAll("#hrSubtabs .subtab").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#hrSubtabs .subtab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".hr-sub").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("hrsub-" + b.dataset.sub).classList.add("active");
    });
  });

  // ---- Tekstdokumenter: rekruttering + onboarding ----
  function setupDoc(area, editId, saveId, field) {
    const ta = document.getElementById(area), eb = document.getElementById(editId), sb = document.getElementById(saveId);
    eb.addEventListener("click", () => {
      const on = ta.disabled;
      ta.disabled = !on; eb.textContent = on ? "🔒 Lås" : "🔓 Lås opp"; sb.hidden = !on;
      if (on) ta.focus();
    });
    sb.addEventListener("click", async () => {
      sb.disabled = true;
      try {
        const res = await fetch("/api/hrdocs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: ta.value }) });
        if (!res.ok) throw new Error("Lagring feilet");
        sb.textContent = "Lagret ✓"; setTimeout(() => (sb.textContent = "Lagre"), 2000);
        ta.disabled = true; eb.textContent = "🔓 Lås opp"; sb.hidden = true;
      } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { sb.disabled = false; }
    });
  }
  setupDoc("recText", "recEdit", "recSave", "recruiting");
  setupDoc("onbText", "onbEdit", "onbSave", "onboarding");
  let docsLoaded = false;
  async function loadDocs() {
    if (docsLoaded) return;
    try {
      const d = await (await fetch("/api/hrdocs")).json();
      document.getElementById("recText").value = d.recruiting || "";
      document.getElementById("onbText").value = d.onboarding || "";
      docsLoaded = true;
    } catch (e2) { /* ignore */ }
  }

  // ---- CV-liste ----
  let cvs = [], cvEditing = false, cvLoaded = false;
  const cvGrid = document.getElementById("cvGrid");
  function renderCv() {
    cvGrid.innerHTML = cvs.map((c, i) => cvEditing
      ? `<div class="scaffold-card kon-edit" data-i="${i}">
          <input class="kon-f" data-f="name" value="${esc(c.name)}" placeholder="Navn" />
          <input class="kon-f" data-f="url" value="${esc(c.url)}" placeholder="Lenke til CV (URL)" />
          <input class="kon-f" data-f="note" value="${esc(c.note)}" placeholder="Notat" />
          <button class="btn-ghost cv-del">🗑 Fjern</button></div>`
      : `<div class="scaffold-card"><div class="sc-title">${esc(c.name)}</div>
          ${c.note ? `<div class="sc-sub">${esc(c.note)}</div>` : ""}
          ${c.url ? `<a class="sc-link" href="${esc(c.url)}" target="_blank" rel="noopener">Åpne CV ↗</a>` : `<div class="sc-note">Ingen lenke lagt inn.</div>`}</div>`
    ).join("") || `<div class="empty">Ingen CV-er lagt inn ennå.</div>`;
  }
  cvGrid.addEventListener("input", (e) => { const c = e.target.closest(".kon-edit"); if (c && e.target.dataset.f) cvs[Number(c.dataset.i)][e.target.dataset.f] = e.target.value; });
  cvGrid.addEventListener("click", (e) => { if (!e.target.classList.contains("cv-del")) return; cvs.splice(Number(e.target.closest(".kon-edit").dataset.i), 1); renderCv(); });
  document.getElementById("cvEdit").addEventListener("click", () => {
    cvEditing = !cvEditing;
    document.getElementById("cvEdit").textContent = cvEditing ? "🔒 Lås" : "🔓 Lås opp";
    document.getElementById("cvAdd").hidden = !cvEditing; document.getElementById("cvSave").hidden = !cvEditing;
    renderCv();
  });
  document.getElementById("cvAdd").addEventListener("click", () => { cvs.push({ name: "", url: "", note: "" }); renderCv(); });
  document.getElementById("cvSave").addEventListener("click", async () => {
    const sb = document.getElementById("cvSave"); sb.disabled = true;
    try { const res = await fetch("/api/cvs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cvs }) });
      if (!res.ok) throw new Error("Lagring feilet"); sb.textContent = "Lagret ✓"; setTimeout(() => (sb.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { sb.disabled = false; }
  });
  async function loadCvs() { if (cvLoaded) return; try { const d = await (await fetch("/api/cvs")).json(); cvs = (d.cvs || []).map((c) => ({ ...c })); cvLoaded = true; renderCv(); } catch (e2) { /* ignore */ } }

  const tab = document.querySelector('.tab[data-tab="hr"]');
  if (tab) tab.addEventListener("click", () => { loadHR(); loadDocs(); loadCvs(); });
})();

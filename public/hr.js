// HR – plantegning med ansatt-pins (klikk for å plassere, dra for å flytte).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const wrap = document.getElementById("floorWrap");
  const img = document.getElementById("floorImg");
  const pinsEl = document.getElementById("floorPins");
  const editBtn = document.getElementById("hrEdit");
  const saveBtn = document.getElementById("hrSave");
  let pins = [], editing = false, dirty = false, loaded = false, dragIdx = -1;

  function err(msg) { const el = document.getElementById("errorBanner"); el.textContent = msg; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    pinsEl.innerHTML = pins.map((p, i) =>
      `<div class="floor-pin${editing ? " edit" : ""}" style="left:${p.x}%;top:${p.y}%" data-i="${i}">
        <span class="fp-dot"></span><span class="fp-label">${esc(p.name)}</span>
      </div>`
    ).join("");
  }

  // Klikk på tegningen i edit-modus = ny pin
  img.addEventListener("click", (e) => {
    if (!editing) return;
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    const name = (prompt("Navn på ansatt for denne plassen:") || "").trim();
    if (!name) return;
    pins.push({ name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    dirty = true; render();
  });

  // Dra / slett pin
  pinsEl.addEventListener("mousedown", (e) => {
    if (!editing) return;
    const el = e.target.closest(".floor-pin"); if (!el) return;
    dragIdx = Number(el.dataset.i); e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (dragIdx < 0 || !editing) return;
    const r = img.getBoundingClientRect();
    pins[dragIdx].x = Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 1000) / 10));
    pins[dragIdx].y = Math.max(0, Math.min(100, Math.round(((e.clientY - r.top) / r.height) * 1000) / 10));
    dirty = true; render();
  });
  window.addEventListener("mouseup", () => { dragIdx = -1; });
  pinsEl.addEventListener("dblclick", (e) => {
    if (!editing) return;
    const el = e.target.closest(".floor-pin"); if (!el) return;
    const i = Number(el.dataset.i);
    if (confirm(`Fjern markøren for ${pins[i].name}?`)) { pins.splice(i, 1); dirty = true; render(); }
  });

  function setEditing(on) {
    editing = on;
    editBtn.textContent = on ? "🔒 Lås" : "🔓 Lås opp";
    saveBtn.hidden = !on;
    document.getElementById("hrHint").textContent = on
      ? "Klikk på tegningen for å sette en markør. Dra for å flytte, dobbeltklikk for å fjerne. Husk å lagre."
      : "Plantegning over kontoret. Lås opp for å plassere ansatte.";
    wrap.classList.toggle("editing", on);
    render();
  }
  editBtn.addEventListener("click", () => setEditing(!editing));

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/hr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pins }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      dirty = false; saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); }
    finally { saveBtn.disabled = false; }
  });

  async function loadHR() {
    if (loaded) return;
    try {
      const res = await fetch("/api/hr");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      img.src = d.floorPlanUrl || "/floorplan.png";
      img.onerror = () => { document.getElementById("floorMissing").hidden = false; };
      pins = (d.pins || []).map((p) => ({ ...p }));
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

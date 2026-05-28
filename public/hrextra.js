// HR-tillegg: Visjon, dokumentbibliotek, parkering (bilde+pin) og forespørsler.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function err(m) { const el = document.getElementById("errorBanner"); if (el) { el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); } }
  const fileToDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

  /* ---------- Visjon ---------- */
  (function () {
    const view = document.getElementById("visView"), ta = document.getElementById("visText");
    const eb = document.getElementById("visEdit"), sb = document.getElementById("visSave");
    if (!view) return;
    let loaded = false;
    function show(text) { view.innerHTML = esc(text).replace(/\n/g, "<br>"); ta.value = text; }
    eb.addEventListener("click", () => {
      const editing = view.hidden;
      view.hidden = !editing ? false : true; // toggle
      if (ta.hidden) { ta.hidden = false; view.hidden = true; eb.textContent = "🔒 Lås"; sb.hidden = false; ta.focus(); }
      else { ta.hidden = true; view.hidden = false; eb.textContent = "🔓 Lås opp"; sb.hidden = true; }
    });
    sb.addEventListener("click", async () => {
      sb.disabled = true;
      try { const res = await fetch("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vision: ta.value }) });
        if (!res.ok) throw new Error("Lagring feilet"); show(ta.value); ta.hidden = true; view.hidden = false; eb.textContent = "🔓 Lås opp"; sb.hidden = true;
      } catch (e2) { err("Kunne ikke lagre visjon: " + e2.message); } finally { sb.disabled = false; }
    });
    async function load() { if (loaded) return; loaded = true; try { const d = await (await fetch("/api/vision")).json(); show(d.vision || ""); } catch {} }
    const tab = document.querySelector('.tab[data-tab="hr"]'); if (tab) tab.addEventListener("click", load);
  })();

  /* ---------- Arbeidsmetodikk ---------- */
  (function () {
    const view = document.getElementById("metView"), ta = document.getElementById("metText");
    const eb = document.getElementById("metEdit"), sb = document.getElementById("metSave");
    if (!view) return;
    let loaded = false;
    function show(text) {
      // Pen formatering: linjer som starter med tall+punktum blir overskrifter,
      // linjer som starter med * eller - blir punkter, ellers vanlig avsnitt.
      const lines = String(text || "").split("\n");
      let html = "", inUl = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t) { if (inUl) { html += "</ul>"; inUl = false; } html += "<br>"; continue; }
        if (/^\d+\.\s/.test(t)) {
          if (inUl) { html += "</ul>"; inUl = false; }
          html += `<h3 class="met-h">${esc(t)}</h3>`;
        } else if (/^[•*\-]\s/.test(t)) {
          if (!inUl) { html += `<ul class="met-ul">`; inUl = true; }
          html += `<li>${esc(t.replace(/^[•*\-]\s+/, ""))}</li>`;
        } else if (/^Hovedprinsipp:/i.test(t)) {
          if (inUl) { html += "</ul>"; inUl = false; }
          html += `<p class="met-principle"><b>${esc(t)}</b></p>`;
        } else {
          if (inUl) { html += "</ul>"; inUl = false; }
          html += `<p>${esc(t)}</p>`;
        }
      }
      if (inUl) html += "</ul>";
      view.innerHTML = html || `<div class="empty">Ingen tekst lagret ennå. Lås opp for å redigere.</div>`;
      ta.value = text;
    }
    eb.addEventListener("click", () => {
      if (ta.hidden) { ta.hidden = false; view.hidden = true; eb.textContent = "🔒 Lås"; sb.hidden = false; ta.focus(); }
      else { ta.hidden = true; view.hidden = false; eb.textContent = "🔓 Lås opp"; sb.hidden = true; }
    });
    sb.addEventListener("click", async () => {
      sb.disabled = true;
      try {
        const res = await fetch("/api/arbeidsmetodikk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ arbeidsmetodikk: ta.value }) });
        if (!res.ok) throw new Error("Lagring feilet");
        show(ta.value); ta.hidden = true; view.hidden = false; eb.textContent = "🔓 Lås opp"; sb.hidden = true;
      } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { sb.disabled = false; }
    });
    async function load() { if (loaded) return; loaded = true; try { const d = await (await fetch("/api/arbeidsmetodikk")).json(); show(d.arbeidsmetodikk || ""); } catch {} }
    const tab = document.querySelector('.tab[data-tab="hr"]'); if (tab) tab.addEventListener("click", load);
  })();

  /* ---------- Dokumentbibliotek ---------- */
  (function () {
    const listEl = document.getElementById("docList"), upBox = document.getElementById("docUpload"), eb = document.getElementById("docEdit");
    if (!listEl) return;
    let docs = [], loaded = false, editing = false;
    function render() {
      const byCat = {};
      docs.forEach((d) => { (byCat[d.category] = byCat[d.category] || []).push(d); });
      const cats = Object.keys(byCat);
      listEl.innerHTML = cats.length ? cats.map((cat) => `
        <div class="doc-cat-group"><h3 class="doc-cat-h">${esc(cat)}</h3>
        ${byCat[cat].map((d) => `<div class="doc-row">
          <span class="doc-ico">${d.url.includes(".pdf") ? "📄" : "🖼️"}</span>
          <span class="doc-main"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>
            <span class="doc-rev">Rev: ${esc(d.revision || "—")} · lastet opp ${esc(d.uploadedAt || "")}</span></span>
          ${editing ? `<button class="doc-del" data-id="${esc(d.id)}">🗑</button>` : ""}
        </div>`).join("")}</div>`).join("") : `<div class="empty">Ingen dokumenter lastet opp ennå.</div>`;
    }
    eb.addEventListener("click", () => { editing = !editing; eb.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; upBox.hidden = !editing; render(); });
    listEl.addEventListener("click", async (e) => {
      const b = e.target.closest(".doc-del"); if (!b) return;
      if (!confirm("Fjerne dokumentet?")) return;
      try { await fetch("/api/hrdocfiles/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.id }) }); docs = docs.filter((d) => d.id !== b.dataset.id); render(); } catch (e2) { err(e2.message); }
    });
    document.getElementById("docSave").addEventListener("click", async () => {
      const f = document.getElementById("docFile").files[0];
      if (!f) { err("Velg en fil."); return; }
      const sb = document.getElementById("docSave"); sb.disabled = true;
      try {
        const dataUrl = await fileToDataUrl(f);
        const body = { dataUrl, title: document.getElementById("docTitle").value.trim() || f.name, category: document.getElementById("docCat").value, revision: document.getElementById("docRevision").value };
        const res = await fetch("/api/hrdocfiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || "Opplasting feilet");
        document.getElementById("docTitle").value = "";
        await loadDocs(true);
        sb.textContent = "Lastet opp ✓"; setTimeout(() => (sb.textContent = "Last opp"), 2000);
      } catch (e2) { err("Kunne ikke laste opp: " + e2.message); } finally { sb.disabled = false; }
    });
    async function loadDocs(force) { if (loaded && !force) return; loaded = true; try { const d = await (await fetch("/api/hrdocfiles")).json(); docs = d.docs || []; render(); } catch (e2) { err(e2.message); } }
    const tab = document.querySelector('.tab[data-tab="hr"]'); if (tab) tab.addEventListener("click", () => loadDocs());
  })();

  /* ---------- Parkering (bilde + pin) ---------- */
  (function () {
    const wrap = document.getElementById("parkWrap"), img = document.getElementById("parkImg"), pinsEl = document.getElementById("parkPins");
    if (!wrap) return;
    const eb = document.getElementById("parkEdit"), sb = document.getElementById("parkSave"), upRow = document.getElementById("parkUploadRow");
    let data = { url: "", pins: [] }, editing = false, loaded = false, dragIdx = -1, placing = false;
    const pins = () => (data.pins = data.pins || []);
    function render() {
      if (data.url) { img.src = data.url; img.style.display = ""; document.getElementById("parkMissing").hidden = true; }
      else { img.removeAttribute("src"); img.style.display = "none"; document.getElementById("parkMissing").hidden = false; }
      pinsEl.innerHTML = pins().map((pn, i) => `<div class="floor-pin${editing ? " edit" : ""}" style="left:${pn.x}%;top:${pn.y}%" data-i="${i}"><span class="fp-dot"></span><span class="fp-label">${esc(pn.name)}</span></div>`).join("");
    }
    function place(cx, cy) {
      const r = img.getBoundingClientRect();
      const nameEl = document.getElementById("parkPinName");
      const name = (nameEl.value || "").trim(); if (!name) { err("Skriv inn merke først."); return; }
      pins().push({ name, x: Math.max(0, Math.min(100, Math.round(((cx - r.left) / r.width) * 1000) / 10)), y: Math.max(0, Math.min(100, Math.round(((cy - r.top) / r.height) * 1000) / 10)) });
      nameEl.value = ""; placing = false; wrap.classList.remove("placing"); render();
    }
    img.addEventListener("click", (e) => { if (!editing) return; const nm = document.getElementById("parkPinName"); if (placing || (nm && nm.value.trim())) place(e.clientX, e.clientY); });
    pinsEl.addEventListener("mousedown", (e) => { if (!editing) return; const el = e.target.closest(".floor-pin"); if (!el) return; dragIdx = Number(el.dataset.i); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if (dragIdx < 0 || !editing) return; const r = img.getBoundingClientRect(); pins()[dragIdx].x = Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 1000) / 10)); pins()[dragIdx].y = Math.max(0, Math.min(100, Math.round(((e.clientY - r.top) / r.height) * 1000) / 10)); render(); });
    window.addEventListener("mouseup", () => { dragIdx = -1; });
    pinsEl.addEventListener("dblclick", (e) => { if (!editing) return; const el = e.target.closest(".floor-pin"); if (!el) return; const i = Number(el.dataset.i); if (confirm(`Fjerne «${pins()[i].name}»?`)) { pins().splice(i, 1); render(); } });
    eb.addEventListener("click", () => { editing = !editing; eb.textContent = editing ? "🔒 Lås" : "🔓 Lås opp"; sb.hidden = !editing; upRow.hidden = !editing; if (!editing) { placing = false; wrap.classList.remove("placing"); } render(); });
    document.getElementById("parkPinAdd").addEventListener("click", () => { if (!(document.getElementById("parkPinName").value || "").trim()) { err("Skriv inn merke først."); return; } placing = true; wrap.classList.add("placing"); document.getElementById("parkHint").textContent = "Klikk på bildet der plassen er."; });
    sb.addEventListener("click", async () => { sb.disabled = true; try { const res = await fetch("/api/parking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parking: data }) }); if (!res.ok) throw new Error("Lagring feilet"); sb.textContent = "Lagret ✓"; setTimeout(() => (sb.textContent = "Lagre"), 2000); } catch (e2) { err("Kunne ikke lagre: " + e2.message); } finally { sb.disabled = false; } });
    document.getElementById("parkUpload").addEventListener("click", async () => {
      const f = document.getElementById("parkFile").files[0]; const msg = document.getElementById("parkMsg");
      if (!f) { msg.textContent = "Velg en bildefil."; return; }
      msg.textContent = "Laster opp …";
      try { const dataUrl = await fileToDataUrl(f); const res = await fetch("/api/parking/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl }) }); const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || "Feil"); data.url = d.url; msg.textContent = "✓ Lastet opp."; render(); } catch (e2) { msg.textContent = "Feil: " + e2.message; }
    });
    async function load() { if (loaded) return; loaded = true; try { const d = await (await fetch("/api/parking")).json(); data = d.parking || { url: "", pins: [] }; render(); } catch (e2) { err(e2.message); } }
    const tab = document.querySelector('.tab[data-tab="hr"]'); if (tab) tab.addEventListener("click", load);
  })();

  /* ---------- Forespørsler ---------- */
  (function () {
    const listEl = document.getElementById("reqList"); if (!listEl) return;
    let reqs = [], loaded = false;
    function render() {
      listEl.innerHTML = reqs.length ? reqs.slice().reverse().map((r) => `
        <div class="req-item${r.done ? " done" : ""}" data-id="${esc(r.id)}">
          <button class="req-toggle" data-id="${esc(r.id)}" title="Merk som ordnet">${r.done ? "✅" : "⬜"}</button>
          <span class="req-text">${esc(r.text)}${r.by ? ` <span class="req-by">— ${esc(r.by)}</span>` : ""}</span>
          <button class="req-del" data-id="${esc(r.id)}">✕</button>
        </div>`).join("") : `<div class="empty">Ingen forespørsler ennå.</div>`;
    }
    document.getElementById("reqBtn").addEventListener("click", async () => {
      const inp = document.getElementById("reqInput"), byEl = document.getElementById("reqBy");
      const text = inp.value.trim(); if (!text) return;
      try { const res = await fetch("/api/hrrequests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, by: byEl.value.trim() }) }); if (!res.ok) throw new Error("Feil"); inp.value = ""; await load(true); } catch (e2) { err("Kunne ikke sende: " + e2.message); }
    });
    listEl.addEventListener("click", async (e) => {
      const tg = e.target.closest(".req-toggle"), dl = e.target.closest(".req-del");
      if (tg) { try { await fetch("/api/hrrequests/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: tg.dataset.id, action: "toggle" }) }); await load(true); } catch {} }
      else if (dl) { if (!confirm("Fjerne forespørselen?")) return; try { await fetch("/api/hrrequests/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: dl.dataset.id, action: "delete" }) }); await load(true); } catch {} }
    });
    async function load(force) { if (loaded && !force) return; loaded = true; try { const d = await (await fetch("/api/hrrequests")).json(); reqs = d.requests || []; render(); } catch (e2) { err(e2.message); } }
    const tab = document.querySelector('.tab[data-tab="hr"]'); if (tab) tab.addEventListener("click", () => load());
  })();
})();

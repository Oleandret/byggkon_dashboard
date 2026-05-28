// Forhåndsfylte kort for KI-agenter, kvalitetssikring og rapporter.
// Dette er et stillas – innhold/kobling bygges ut senere. Ingen passord vises her.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const linkUrl = (u) => (/^(https?:\/\/|mailto:)/.test(u) ? u : "https://" + u);
  const card = (c) => `<div class="scaffold-card">
    <div class="sc-head"><span class="sc-title">${esc(c.title)}</span>${c.status ? `<span class="sc-badge ${c.statusCls || ""}">${esc(c.status)}</span>` : ""}</div>
    ${c.sub ? `<div class="sc-sub">${esc(c.sub)}</div>` : ""}
    <div class="sc-note">${esc(c.note || "")}</div>
    ${c.url ? `<a class="sc-link" href="${esc(linkUrl(c.url))}" target="_blank" rel="noopener">Åpne ↗</a>` : ""}
  </div>`;
  function fill(id, items) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = items.map(card).join("");
  }

  // ---- IT-system: redigerbar liste lagret på server ----
  function renderItList(items, editing) {
    const el = document.getElementById("itGrid");
    if (!el) return;
    const sorted = items.slice().sort((a, b) => a.title.localeCompare(b.title, "nb"));
    el.className = editing ? "it-list editing" : "it-list";
    el.innerHTML = sorted.map((c, i) => {
      const realIdx = items.indexOf(c);
      if (editing) {
        return `<div class="it-item edit" data-i="${realIdx}">
          <input class="kon-f" data-f="title" value="${esc(c.title)}" placeholder="Tittel" />
          <input class="kon-f" data-f="url" value="${esc(c.url)}" placeholder="URL (uten https://)" />
          <input class="kon-f" data-f="note" value="${esc(c.note)}" placeholder="Hva brukes det til?" />
          <input class="kon-f" data-f="status" value="${esc(c.status || "")}" placeholder="Status (valgfritt)" style="max-width:120px" />
          <button class="btn-ghost it-del">🗑</button>
        </div>`;
      }
      return `<div class="it-item">
        <button class="it-head" type="button">
          <span class="it-name">${esc(c.title)}</span>
          ${c.status ? `<span class="sc-badge ${c.statusCls || ""}">${esc(c.status)}</span>` : ""}
          <span class="it-caret">▸</span>
        </button>
        <div class="it-body">
          <div class="it-note">${esc(c.note || "")}</div>
          ${c.url ? `<a class="sc-link" href="${esc(linkUrl(c.url))}" target="_blank" rel="noopener">Åpne ↗</a>` : ""}
        </div>
      </div>`;
    }).join("");
    el.addEventListener("click", (e) => { const b = e.target.closest(".it-head"); if (b) b.parentElement.classList.toggle("open"); });
  }
  let itItems = [], itEditing = false, itLoaded = false;
  async function loadItSystems() {
    if (itLoaded) return; itLoaded = true;
    try { const d = await (await fetch("/api/itsystems")).json(); itItems = (d.systems || []).map((x) => ({ ...x })); renderItList(itItems, false); } catch {}
  }
  document.addEventListener("input", (e) => {
    const it = e.target.closest(".it-item.edit"); if (!it || !e.target.dataset.f) return;
    itItems[Number(it.dataset.i)][e.target.dataset.f] = e.target.value;
  });
  document.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("it-del")) {
      itItems.splice(Number(e.target.closest(".it-item").dataset.i), 1); renderItList(itItems, true);
    }
  });
  const itEditBtn = document.getElementById("itEdit");
  if (itEditBtn) itEditBtn.addEventListener("click", () => {
    itEditing = !itEditing;
    itEditBtn.textContent = itEditing ? "🔒 Lås" : "🔓 Lås opp";
    document.getElementById("itAdd").hidden = !itEditing;
    document.getElementById("itSave").hidden = !itEditing;
    renderItList(itItems, itEditing);
  });
  const itAddBtn = document.getElementById("itAdd");
  if (itAddBtn) itAddBtn.addEventListener("click", () => { itItems.push({ title: "", url: "", note: "" }); renderItList(itItems, true); });
  const itSaveBtn = document.getElementById("itSave");
  if (itSaveBtn) itSaveBtn.addEventListener("click", async () => {
    itSaveBtn.disabled = true;
    try { const res = await fetch("/api/itsystems", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systems: itItems.filter((x) => x.title) }) });
      if (!res.ok) throw new Error("Lagring feilet"); itSaveBtn.textContent = "Lagret ✓"; setTimeout(() => (itSaveBtn.textContent = "Lagre"), 2000);
    } catch (e) { /* ignore */ } finally { itSaveBtn.disabled = false; }
  });
  const itTab = document.querySelector('.tab[data-tab="itsystem"]');
  if (itTab) itTab.addEventListener("click", loadItSystems);

  // ---- MCP-keys editor (admin only) på KI-agenter-fanen ----
  let mcp = [];
  async function loadMcpKeys() {
    try {
      const res = await fetch("/api/admin/mcpservers");
      if (!res.ok) { document.getElementById("mcpKeysCard").hidden = true; return; }
      const d = await res.json();
      mcp = d.servers || [];
      document.getElementById("mcpKeysCard").hidden = false;
      renderMcpKeys();
    } catch { document.getElementById("mcpKeysCard").hidden = true; }
  }
  function renderMcpKeys() {
    const el = document.getElementById("mcpKeysList");
    if (!el) return;
    el.innerHTML = mcp.length ? mcp.map((m, i) => `<div class="mcp-keys-row" data-i="${i}">
      <input class="kon-f mk-name" placeholder="Navn (Loki, Nova, …)" value="${esc(m.name || "")}" />
      <input class="kon-f mk-url" placeholder="https://… (MCP-URL)" value="${esc(m.url || "")}" />
      <input class="kon-f mk-key" type="password" placeholder="API-nøkkel (valgfritt)" value="${esc(m.key || "")}" />
      <button class="btn-ghost mk-del">🗑</button>
    </div>`).join("") : `<div class="empty">Ingen MCP-tilkoblinger lagt inn. Klikk «+ Agent».</div>`;
  }
  function collectMcpKeys() {
    return [...document.querySelectorAll("#mcpKeysList .mcp-keys-row")].map((r) => ({
      name: r.querySelector(".mk-name").value.trim(),
      url: r.querySelector(".mk-url").value.trim(),
      key: r.querySelector(".mk-key").value.trim(),
    })).filter((m) => m.name);
  }
  document.getElementById("mcpKeysAdd")?.addEventListener("click", () => { mcp.push({ name: "", url: "", key: "" }); renderMcpKeys(); });
  document.getElementById("mcpKeysList")?.addEventListener("click", (e) => { if (e.target.classList.contains("mk-del")) { mcp.splice(Number(e.target.closest(".mcp-keys-row").dataset.i), 1); renderMcpKeys(); } });
  document.getElementById("mcpKeysSave")?.addEventListener("click", async () => {
    const list = collectMcpKeys();
    const btn = document.getElementById("mcpKeysSave"); btn.disabled = true;
    try { const res = await fetch("/api/admin/mcpservers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ servers: list }) });
      if (!res.ok) throw new Error("Lagring feilet"); mcp = list; renderMcpKeys();
      btn.textContent = "Lagret ✓"; setTimeout(() => (btn.textContent = "Lagre"), 2000);
    } catch (e) { /* ignore */ } finally { btn.disabled = false; }
  });
  const kiTab = document.querySelector('.tab[data-tab="kiagenter"]');
  if (kiTab) kiTab.addEventListener("click", loadMcpKeys);

  // KI-agenter – BYGG-KON.ai-plattformen (6 agenter koblet til Claude via MCP)
  fill("kiGrid", [
    { title: "BYGG-KON.ai (plattform)", url: "byggkon-ai-platform-production.up.railway.app", status: "Aktiv", statusCls: "ok", note: "Samlet AI-plattform: 6 agenter koblet til Claude via MCP. Produserer dispensasjonssøknader, UAK-sjekklister, KS-planer og befaringsrapporter på sekunder." },
    { title: "Loki", url: "byggkon-loki-ai-production.up.railway.app", status: "Aktiv", statusCls: "ok", note: "Synkroniserer hele OneDrive/SharePoint til en Pinecone-vektorindeks. Søk i faktisk innhold på tvers av alle prosjekter." },
    { title: "Nova", url: "nova-ai-agent-bygg-kon-production.up.railway.app", status: "Aktiv", statusCls: "ok", note: "RAG-assistent som svarer ansatte via chat, Teams, e-post og webhook. Indekserer Drive og parser vedlegg. (Også «Spør Nova» nede til høyre.)" },
    { title: "Hilde", url: "byggkon.bluemint.dev", status: "Aktiv", statusCls: "ok", note: "Eiendom og eier fra Kartverket og Brønnøysund — matrikkel, grunnbok og kontaktinfo, automatisk." },
    { title: "Tripletex-agent", status: "Aktiv", statusCls: "ok", note: "Faktura, regnskap, prosjektøkonomi og timer via MCP — alltid med bekreftelse før skriveoperasjoner." },
    { title: "Epostagent", status: "Utvikling", note: "Lærer av hvert svar og foreslår svar på lignende henvendelser fra kunde/byggherre/intern." },
    { title: "KI Tilbud", url: "bk-tilbud.aiki.as/login", status: "Aktiv", statusCls: "ok", note: "Produserer komplette tilbud etter NS 8400 og NS 3450 — kombinerer Loki, Nova og Tripletex." },
  ]);

  // Kvalitetssikring
  fill("ksGrid", [
    { title: "Sidemannskontroll", status: "Planlagt", note: "KI som bistår kontroll av kollegas arbeid før levering." },
    { title: "TEK / standardsjekk", status: "Planlagt", note: "Sjekk av samsvar mot TEK17 og relevante NS-standarder." },
    { title: "Dokumentkontroll", status: "Planlagt", note: "Gjennomgang av prosjektdokumenter for mangler og avvik." },
  ]);

  // (IT-systemer lastes nå fra /api/itsystems lenger opp i fila)

  // Rapporter (recurring AI)
  fill("rapGrid", [
    { title: "Ukentlig driftsrapport", status: "Planlagt", note: "Sammendrag av økonomi, timer og prosjekter – hver mandag." },
    { title: "Månedlig økonomirapport", status: "Planlagt", note: "Resultat, balanse og likviditet automatisk hver måned." },
    { title: "Kapasitetsrapport", status: "Planlagt", note: "Hvem har ledig kapasitet de neste ukene." },
  ]);
})();

// Onboarding: hurtiglenker til alle systemer + personalhåndbok (opplasting/lås/revisjonsdato).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }
  const linkUrl = (u) => (!u ? "" : /^https?:|^mailto:/.test(u) ? u : "https://" + u);

  // ---- Hurtiglenker (interne + eksterne) ----
  const LINKS = [
    { group: "Interne", items: [
      { t: "Bygg-Kon dashboard (denne siden)", u: "" },
      { t: "Tripletex – timer & regnskap", u: "tripletex.no" },
      { t: "Office 365 / Teams / OneNote", u: "portal.office.com" },
      { t: "SharePoint", u: "byggkon.sharepoint.com" },
      { t: "OneDrive", u: "onedrive.live.com" },
      { t: "Møteromsbooking (TB3)", u: "tb3-booking.itrelasjon.com" },
      { t: "Faktura/bilag-mottak", u: "mailto:byggkon@ebilag.com" },
      { t: "1Password (passord)", u: "1password.com" },
    ]},
    { group: "Fag & prosjekt", items: [
      { t: "Holteportalen (kalkyle/KS)", u: "holteportalen.no" },
      { t: "Norsk Standard", u: "standard.no" },
      { t: "Byggforsk", u: "byggforsk.no" },
      { t: "Norsk Prisbok", u: "norskprisbok.no" },
      { t: "Mercell (anbud)", u: "mercell.com" },
      { t: "Prosjektagenten", u: "prosjektagenten.no" },
    ]},
    { group: "KI & verktøy", items: [
      { t: "Claude (Anthropic)", u: "claude.ai" },
      { t: "ChatGPT / OpenAI", u: "chatgpt.com" },
      { t: "Fireflies (møtereferat)", u: "fireflies.ai" },
      { t: "Fyxer AI", u: "app.fyxer.com" },
      { t: "n8n (automasjon)", u: "n8n.io" },
      { t: "Adobe / Acrobat", u: "adobe.com" },
    ]},
    { group: "Marked & styre", items: [
      { t: "LinkedIn", u: "linkedin.com" },
      { t: "Nettside (Webflow)", u: "webflow.com/dashboard/sites/bygg-kon/general" },
      { t: "Orgbrain (styre)", u: "apps.orgbrain.ai/home/organizations/943885397" },
    ]},
  ];
  function renderLinks() {
    const el = document.getElementById("onbLinks");
    if (!el) return;
    el.innerHTML = LINKS.map((g) => `
      <div class="onb-group">
        <h3 class="onb-group-h">${esc(g.group)}</h3>
        <div class="onb-link-row">${g.items.map((i) => i.u
          ? `<a class="sc-link" href="${esc(linkUrl(i.u))}" target="_blank" rel="noopener">${esc(i.t)} ↗</a>`
          : `<span class="sc-link disabled">${esc(i.t)}</span>`).join("")}</div>
      </div>`).join("");
  }

  // ---- Personalhåndbok ----
  let editing = false;
  function renderHandbook(hb) {
    const view = document.getElementById("hbView");
    if (!view) return;
    if (hb && hb.url) {
      view.innerHTML = `
        <div class="hb-card">
          <div class="hb-meta">
            <div class="hb-name">📘 ${esc(hb.filename || "Personalhåndbok")}</div>
            <div class="hb-rev">Revisjonsdato: <b>${esc(hb.revision || "—")}</b></div>
          </div>
          <a class="btn-primary" href="${esc(hb.url)}" target="_blank" rel="noopener">Åpne ↗</a>
        </div>`;
    } else {
      view.innerHTML = `<div class="empty">Ingen personalhåndbok lastet opp ennå.</div>`;
    }
  }
  const editBtn = document.getElementById("hbEdit");
  const uploadBox = document.getElementById("hbUpload");
  if (editBtn) editBtn.addEventListener("click", () => {
    editing = !editing;
    editBtn.textContent = editing ? "🔒 Lås" : "🔓 Lås opp";
    uploadBox.hidden = !editing;
  });
  const saveBtn = document.getElementById("hbSave");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const fileEl = document.getElementById("hbFile");
    const rev = document.getElementById("hbRevision").value;
    const f = fileEl.files[0];
    if (!f) { err("Velg en fil først."); return; }
    saveBtn.disabled = true;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f);
      });
      const res = await fetch("/api/handbook", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl, revision: rev, filename: f.name }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Opplasting feilet");
      renderHandbook(d.handbook);
      saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Last opp / lagre"), 2000);
    } catch (e2) { err("Kunne ikke laste opp: " + e2.message); } finally { saveBtn.disabled = false; }
  });

  async function load() {
    renderLinks();
    try { const d = await (await fetch("/api/handbook")).json(); renderHandbook(d.handbook); } catch { renderHandbook(null); }
  }
  load();
})();

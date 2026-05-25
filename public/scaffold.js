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

  // IT-system og verktøy (uten passord) – alfabetisk liste, klikk for detaljer
  function renderItList(items) {
    const el = document.getElementById("itGrid");
    if (!el) return;
    const sorted = items.slice().sort((a, b) => a.title.localeCompare(b.title, "nb"));
    el.className = "it-list";
    el.innerHTML = sorted.map((c, i) => `
      <div class="it-item" data-i="${i}">
        <button class="it-head" type="button">
          <span class="it-name">${esc(c.title)}</span>
          ${c.status ? `<span class="sc-badge ${c.statusCls || ""}">${esc(c.status)}</span>` : ""}
          <span class="it-caret">▸</span>
        </button>
        <div class="it-body">
          <div class="it-note">${esc(c.note || "")}</div>
          ${c.url ? `<a class="sc-link" href="${esc(linkUrl(c.url))}" target="_blank" rel="noopener">Åpne ↗</a>` : ""}
        </div>
      </div>`).join("");
    el.addEventListener("click", (e) => { const b = e.target.closest(".it-head"); if (b) b.parentElement.classList.toggle("open"); });
  }
  renderItList([
    { title: "Tripletex", url: "tripletex.no", note: "Timeføring, fakturering og regnskap. Datakilden bak dette dashbordet." },
    { title: "Office 365", url: "portal.office.com", note: "E-post, Teams, OneNote, Office-pakken. Alle ansatte." },
    { title: "Fireflies AI", url: "fireflies.ai", note: "Møtereferat automatisk for Teams-møter. Inviter ai@byggkon.no, så lages referat og skrives til delt OneNote-mappe.", status: "Auto", statusCls: "ok" },
    { title: "Fyxer AI", url: "app.fyxer.com", note: "E-posthåndtering med AI (under testing)." },
    { title: "Holteportalen (EG Holte)", url: "holteportalen.no", note: "Kalkyle og byggeprosjekt-verktøy. Brukernavn = din byggkon-epost." },
    { title: "Holte KS-system", url: "holteportalen.no", note: "Kvalitetssikringssystem (abonnement)." },
    { title: "OpenAI / ChatGPT", url: "chatgpt.com", note: "Språkmodell (LLM) for tekst, analyse og hjelp. Bedriftskonto: ai@byggkon.no." },
    { title: "Claude (Anthropic)", url: "claude.ai", note: "Språkmodell (LLM) for tekst, analyse, koding og dokumenter. Driver bl.a. dette dashbordet og Cowork." },
    { title: "n8n", url: "n8n.io", note: "Automatisering og arbeidsflyt for KI-agentene." },
    { title: "Prosjektagenten", url: "prosjektagenten.no", note: "AI for å finne relevante prosjekter/tilbud. Konto: oat@byggkon.no." },
    { title: "Mercell", url: "mercell.com", note: "Anbuds- og tilbudsplattform (offentlige konkurranser). Konto: oat@byggkon.no." },
    { title: "Orgbrain", url: "apps.orgbrain.ai/home/organizations/943885397", note: "Styresystem – styremøter, protokoller og dokumenter." },
    { title: "Faktura / bilag-mottak", note: "Send kvitteringer og bilag til: byggkon@ebilag.com (kommer rett inn i regnskapet).", url: "mailto:byggkon@ebilag.com" },
    { title: "Byggforsk", url: "byggforsk.no", note: "Byggdetaljblader og faglige oppslag." },
    { title: "Norsk Standard", url: "standard.no", note: "NS-standarder (NS 8401, 8405, TEK m.m.)." },
    { title: "Norsk Prisbok", url: "norskprisbok.no", note: "Priser og kostnadsoppslag for bygg. Konto: oat@byggkon.no." },
    { title: "1Password", url: "1password.com", note: "Passordbehandler for bedriften. Alle innlogginger/passord ligger her – ikke i dette dashbordet.", status: "Passord", statusCls: "ok" },
    { title: "LinkedIn", url: "linkedin.com", note: "Nettverk, rekruttering og markedsføring." },
    { title: "Phonero", url: "phonero.no", note: "Telefonabonnement (mobil)." },
    { title: "reMarkable", url: "remarkable.com", note: "Digital notatblokk." },
    { title: "Adobe", url: "adobe.com", note: "PDF / Acrobat og designverktøy." },
    { title: "Nettside (Webflow)", url: "webflow.com/dashboard/sites/bygg-kon/general", note: "Ny nettside byggkon.no – redigeres i Webflow." },
    { title: "Møteromsbooking", url: "tb3-booking.itrelasjon.com", note: "Booking av møterom på Travbaneveien." },
    { title: "RIB-programmer", note: "Konstruksjonsprogramvare: Focus, Statcon, Revit, AutoCAD og Sletten. (Skrivebordsapper – installeres lokalt.)" },
  ]);

  // Rapporter (recurring AI)
  fill("rapGrid", [
    { title: "Ukentlig driftsrapport", status: "Planlagt", note: "Sammendrag av økonomi, timer og prosjekter – hver mandag." },
    { title: "Månedlig økonomirapport", status: "Planlagt", note: "Resultat, balanse og likviditet automatisk hver måned." },
    { title: "Kapasitetsrapport", status: "Planlagt", note: "Hvem har ledig kapasitet de neste ukene." },
  ]);
})();

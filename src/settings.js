// Lagring og uthenting av innstillinger.
// Verdier kan settes via admin-siden (lagres i en JSON-fil) eller via
// miljøvariabler. Filen vinner over miljøvariabler når den finnes.
//
// På Railway er filsystemet flyktig mellom deployer. Sett SETTINGS_PATH til en
// montert Volume (f.eks. /data/settings.json) for at innstillinger skal være
// permanente. Se README.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SETTINGS_PATH =
  process.env.SETTINGS_PATH || path.join(process.cwd(), "data", "settings.json");

// Startdata for kompetansematrisen (generert fra opplastet Excel).
function defaultCompetence() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "competence-seed.json"), "utf8"));
  } catch {
    return { scale: [], groups: [], employees: [] };
  }
}

// Standard hentes fra miljøvariabler (eller fornuftige defaults).
function defaults() {
  return {
    companyName: process.env.COMPANY_NAME || "BYGG-KON",
    logoUrl: process.env.LOGO_URL || "",
    heroImageUrl:
      process.env.HERO_IMAGE_URL ||
      "https://cdn.prod.website-files.com/6971dca24ade29a12176f9bf/69bd3f133cccc0a691865253_Travbaneveien3-8.jpg",
    regnskapsagentMcpUrl: process.env.REGNSKAPSAGENT_MCP_URL || "",
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "byggkon",
    weeklyCapacityHours: Number(process.env.WEEKLY_CAPACITY_HOURS || 37.5),
    cacheTtlMs: Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000),
    refreshSeconds: Number(process.env.REFRESH_SECONDS || 60),
    // Firmaopplysninger
    companyOrgNr: process.env.COMPANY_ORGNR || "943 885 397 MVA",
    companyAddress: process.env.COMPANY_ADDRESS || "Travbaneveien 3, 4031 Stavanger",
    companyEmail: process.env.COMPANY_EMAIL || "",
    companyPhone: process.env.COMPANY_PHONE || "51 97 44 00",
    companyWebsite: process.env.COMPANY_WEBSITE || "www.byggkon.no",
    values: defaultValues(),
    departments: ["Ledelse", "Intern administrasjon", "Prosjektadministrasjon / BYGG", "RIB", "ARK", "RIBr", "Andre rådgivende fag", "KI-agenter"],
    floorplans: [
      { id: "stavanger", name: "Travbaneveien (Stavanger)", url: process.env.FLOORPLAN_URL || "/floorplan.png", pins: [] },
      { id: "haugesund", name: "Haugesund (RIBr)", url: "", pins: [] },
    ],
    hrRecruiting: "",
    hrOnboarding: defaultOnboarding(),
    cvs: [],
    marketing: defaultMarketing(),
    tilbud: { sendt: 0, vunnet: 0, tapt: 0 },
    news: [{ date: "2026-05-25", text: "Velkommen til Bygg-Kon sitt nye interne dashboard!" }],
    messages: [],
    calendar: [],
    devGoals: [],
    handbook: { url: "", filename: "", revision: "" },
    geocache: {},
    projectNotes: {},
    supplierMeta: {},
    roleDescriptions: [
      {
        name: "Ole-André Torjussen",
        role: "Daglig leder",
        description: "Tar i tillegg på meg oppdrag innen prosjektadministrasjon, helst som byggherreombud eller prosjektleder.\n\nDet forventes at ledelsen:\n• sikrer tilførsel av riktige og tilstrekkelige oppdrag\n• har åpen, direkte og ærlig dialog med ansatte\n• har lav terskel for innspill, spørsmål og tilbakemeldinger\n• prioriterer struktur, systemer og kontinuitet i driften\n• har tydelig fokus på økonomi, inntjening og bærekraftig vekst\n• ser menneskene bak rollene og bygger tillit i organisasjonen\n\nGjennom tydelig ledelse, gode systemer og felles retning skal Byggkon skape forutsigbarhet, stabilitet og langsiktig verdiskaping – for kunder, ansatte og samarbeidspartnere.",
        photo: "",
      },
    ],
    leads: [],
    intentions: [],
    nextOfKin: [],
    hrRequests: [],
    hrDocs: [],
    ledelseFiles: { likviditet: {}, rapport: {}, resultat: {}, budsjett: {} },
    ledelseAdjustments: { likviditet: [], resultat: [], budsjett: [] }, // { slot: [{month, label, amount, note}] }
    employeeSettings: {}, // { "Navn": { orion: { url, key, enabled }, visibility: { projects, role, komp, goals, status } } }
    ledelseLikviditet: {
      startBalance: 0,
      kassekreditt: 1000000,
      kassekredittSaldo: 0,
      rente: 0.0747,
      // adjustments[rowKey][monthKey] = beløp (positivt = inn, negativt = ut for innbetalinger)
      adjustments: {},
    },
    mcpServers: [],
    itSystems: defaultItSystems(),
    departmentMembers: {},
    deptKs: {},           // { dept: [{id, title, owner, status, deadline, note}] }
    deptKanban: {},       // { dept: { cards: [{id, title, customer, stage, projectNumber, owner, dueDate}] } }
    deptEconomyMeta: {},  // { dept: { projects: { projId: { isFixedPrice, fixedPrice, hoursEstimated, note } } } }
    deptKsDocs: {},       // { dept: [{id, name, url, code, note}] } – KS-dokumenter i prioritert rekkefølge
    kiAgentOrders: [],    // [{id, agent, customer, customerEmail, orderDate, status, monthlyPrice, note}]
    deptTilbud: {},       // { dept: { sections: [{title, rows: [{label, unit, price, note}]}] } }
    parking: { url: "", pins: [] },
    kiSuggestions: [],
    kiAgents: [
      { name: "Hilde", email: "hilde@byggkon.ai", desc: "AI-agent for å finne eiendom", status: "pågående" },
      { name: "Stein", email: "stein@byggkon.ai", desc: "AI-agent for kalkyle og kostnader på bygg", status: "pågående" },
      { name: "Nova", email: "nova@byggkon.ai", desc: "AI-agent for kompetanse på bygging og regelverk", status: "operativ" },
      { name: "Embla", email: "embla@byggkon.ai", desc: "AI-agent for tilbud", status: "pågående" },
      { name: "Eira", email: "eira@byggkon.ai", desc: "AI-agent for kundeoppfølging", status: "pågående" },
      { name: "Openclaw", email: "nova@byggkon.ai", desc: "Openclaw", status: "idé" },
      { name: "Saga", email: "saga@byggkon.ai", desc: "Testkonto for AI-agenter", status: "pågående" },
    ],
    vision: defaultVision(),
    arbeidsmetodikk: defaultArbeidsmetodikk(),
    newsFeeds: [
      { name: "Aftenbladet", url: "https://www.aftenbladet.no/rss" },
      { name: "VG", url: "https://www.vg.no/rss/feed/" },
      { name: "Dagbladet", url: "https://www.dagbladet.no/rss" },
      { name: "TV 2", url: "https://www.tv2.no/rss/nyheter" },
      { name: "Nettavisen", url: "https://www.nettavisen.no/service/rich-rss" },
    ],
    fagmoter: { meetings: [], suggestions: [] },
    prosjektmoter: { meetings: [], suggestions: [] },
    ledelse: { meetings: defaultLedermoter() },
    licenses: [
      { system: "Tripletex", cost: 0, interval: "år" },
      { system: "Microsoft Office 365", cost: 0, interval: "år" },
      { system: "Adobe", cost: 0, interval: "år" },
      { system: "Fyxer AI", cost: 0, interval: "mnd" },
      { system: "Fireflies", cost: 0, interval: "mnd" },
      { system: "Holte (KS + portal)", cost: 0, interval: "år" },
      { system: "Norsk Prisbok", cost: 0, interval: "år" },
      { system: "Mercell", cost: 0, interval: "år" },
      { system: "Orgbrain", cost: 0, interval: "år" },
      { system: "Phonero (telefoni)", cost: 0, interval: "mnd" },
      { system: "OpenAI / ChatGPT", cost: 0, interval: "mnd" },
      { system: "n8n", cost: 0, interval: "mnd" },
      { system: "1Password", cost: 0, interval: "mnd" },
      { system: "Webflow", cost: 0, interval: "år" },
      { system: "Regnskapsagent", cost: 349, interval: "mnd" },
    ],
    contacts: [
      { name: "Ole Christoffer Olsen", role: "Manager – Travbaneveien Admin (utleier)", org: "Aider", phone: "975 37 438 / 51 87 09 00", email: "", note: "Kontaktperson for bygget vi leier." },
      { name: "Mathias Furenes", role: "IT-kontaktperson / IT-support", org: "IT Relasjon AS", phone: "", email: "", note: "Kontakt ved IT-problemer." },
      { name: "Eldin", role: "IT-support", org: "IT Relasjon AS", phone: "", email: "", note: "Alternativ kontakt ved IT-problemer." },
      { name: "Elias Voll", role: "Adgangskontroll – bygg Travbaneveien", org: "", phone: "944 20 426", email: "eliasvoll.tb3@gmail.com", note: "Adgangskort til kontoret." },
      { name: "Anna Maja Oleszczyk", role: "Lønnsmedarbeider", org: "Brainiacs AS (regnskapsbyrå)", phone: "", email: "amo@brainiacs.no", note: "Kjører lønn månedlig. Krever timegodkjenning i Tripletex før lønnskjøring, følger opp manglende timelister direkte med ansatte. Brukes til: lønn, ferie/avspasering, feriedager, fleksisaldo, sykmelding." },
      { name: "Lisa Haga Bø", role: "Regnskapsfører", org: "Brainiacs AS", phone: "", email: "lhb@brainiacs.no", note: "Tilknyttet Haga-gruppen. Brukes til: regnskap, MVA, periodeavslutning." },
      { name: "Christian Wedler", role: "Advokat", org: "Stavanger Advokatkontor", phone: "", email: "c.wedler@stavangeradvokatkontor.no", note: "Juridisk rådgivning, kontrakter (NS 8407/8405), tvister, selskapsstruktur, eieropsjonsavtaler. Alt. e-post: cw@hagabolig.no." },
      { name: "Amund Rangøy", role: "Utvikler / kontaktperson Nova", org: "AIKI AS", phone: "", email: "amund@aiki.as", note: "Hovedkontakt for Nova-prosjektet (attesteringsflyt, n8n-workflows, integrasjoner). Brukes til: drift og videreutvikling av Nova, feilsøking." },
      { name: "Martin Nipedal", role: "Partner / utvikler", org: "AIKI AS", phone: "", email: "martin@aiki.as", note: "AIKI-prosjekter sammen med Amund, tekniske avklaringer." },
      { name: "Yngve B.", role: "Kontaktperson AI-agent eiendom", org: "Bluemint AS", phone: "", email: "yngve@bluemint.no", note: "Knyttet til AI-agenten Hilde (hilde@byggkon.ai). Brukes til: utvikling og oppfølging av Hilde." },
      { name: "Daniel Herigstad", role: "Markedsføring / digital", org: "Nextify", phone: "", email: "daniel@nextify.no", note: "Digital markedsføring, kampanjer, SoMe-strategi." },
      { name: "Adrian Wollum", role: "Markedsføring / digital", org: "Nextify", phone: "", email: "adrian@nextify.no", note: "Markedsføring, leveranser sammen med Daniel. Generell postboks: post@nextify.no." },
      { name: "Tommy Haga", role: "Eier / nøkkelkontakt", org: "Haga Bolig / T. Haga AS", phone: "", email: "th@hagabolig.no", note: "Eier-/kunderelasjon. T. Haga AS-kontakter: Stian Byberg, Fredrik Solberg, Ådne Søyland m.fl." },
    ],
    orgChart: defaultOrgChart(),
    competence: defaultCompetence(),
  };
}

// Startinnhold for Ledelse-fanen (ledermøte-referat, bak leder-pålogging).
function defaultLedermoter() {
  const notes = [
    "AGENDA",
    "1. Status rekruttering og bemanning",
    "2. Oppdatering fra prosjektporteføljen",
    "3. Administrativ og økonomisk status",
    "4. Fremdrift digitaliseringsprosjekter",
    "5. Markedsarbeid og synlighet",
    "6. Eventuelle saker/utfordringer",
    "",
    "REKRUTTERING / BEMANNING",
    "- Svein Arne Bjørkheim ansatt, starter til sommeren – RIBr, avdelingsleder Haugesund.",
    "- Morten Grimen starter neste måned (RIBr).",
    "- Ola K. Undheim (RIB). Tor Gunnar Vilke (RIB, faglig leder). Benedicte Molnes.",
    "- 15 ansatte fra 1. august (1 i mammapermisjon). Rekruttering settes på pause noen måneder.",
    "- RIV-oppkjøpskandidater settes på hold. Humano (nytt rekrutteringsfirma) satt på pause.",
    "- Øke bemanning på yngre/rimeligere ansatte: OK.",
    "",
    "ARBEIDSMENGDE",
    "- Ordre bra i mai. Snitt faktureringsgrad 71 % (bransjenorm ~65–75 %).",
    "- Må øke på RIB/RIBr nå med flere nyansatte.",
    "",
    "ØKONOMI",
    "- Rekrutterings- og markedsføringskostnader fortsatt betydelige.",
    "- Mars-inntekt ca. 1,3 mill.",
    "- Timepriser: økt til 1460,- på nye prosjekter; ny rammeavtale 1445,-.",
    "- Endre fakturaforfall til 20 dager. Vurdere likviditetstiltak.",
    "",
    "DIGITALISERING / AI",
    "- Pilot salg av AI-agent for tomtesøk (byggkon.ai): forslag 359,- eks. mva/mnd.",
    "- Selge AI-agent Nova til eksisterende kunder: 950,- eks. mva/mnd.",
    "",
    "MARKEDSFØRING",
    "- Ny nettside online (byggkon.no). AI-agent Hilde for tomtesøk (byggkon.ai).",
    "- Tiltak: LinkedIn, SoMe, e-post, fysiske møter.",
    "",
    "OPPKJØP",
    "- Status Glenn: iverksatt, ikke landet ennå. Flere jobber sammen med ham.",
  ].join("\n");
  return [{ id: "2026-05-20", date: "2026-05-20", title: "Ledermøte", notes }];
}

// Startinnhold for markedsføring-fanen (redigerbar strategi).
function defaultItSystems() {
  return [
    { title: "Tripletex", url: "tripletex.no", note: "Timeføring, fakturering og regnskap. Datakilden bak dette dashbordet." },
    { title: "Office 365", url: "portal.office.com", note: "E-post, Teams, OneNote, Office-pakken. Alle ansatte." },
    { title: "Fireflies AI", url: "fireflies.ai", note: "Møtereferat automatisk for Teams-møter. Inviter ai@byggkon.no.", status: "Auto", statusCls: "ok" },
    { title: "Fyxer AI", url: "app.fyxer.com", note: "E-posthåndtering med AI (under testing)." },
    { title: "Holteportalen (EG Holte)", url: "holteportalen.no", note: "Kalkyle og byggeprosjekt-verktøy." },
    { title: "Holte KS-system", url: "holteportalen.no", note: "Kvalitetssikringssystem (abonnement)." },
    { title: "OpenAI / ChatGPT", url: "chatgpt.com", note: "Språkmodell. Bedriftskonto: ai@byggkon.no." },
    { title: "Claude (Anthropic)", url: "claude.ai", note: "Språkmodell. Driver dette dashbordet og Cowork." },
    { title: "n8n", url: "n8n.io", note: "Automasjon og arbeidsflyt for KI-agentene." },
    { title: "Prosjektagenten", url: "prosjektagenten.no", note: "AI for å finne relevante prosjekter/tilbud." },
    { title: "Mercell", url: "mercell.com", note: "Anbuds- og tilbudsplattform (offentlige konkurranser)." },
    { title: "Orgbrain", url: "apps.orgbrain.ai/home/organizations/943885397", note: "Styresystem – styremøter, protokoller og dokumenter." },
    { title: "Faktura / bilag-mottak", url: "mailto:byggkon@ebilag.com", note: "Send kvitteringer/bilag til byggkon@ebilag.com." },
    { title: "Byggforsk", url: "byggforsk.no", note: "Byggdetaljblader og faglige oppslag." },
    { title: "Norsk Standard", url: "standard.no", note: "NS-standarder (NS 8401, 8405, TEK m.m.)." },
    { title: "Norsk Prisbok", url: "norskprisbok.no", note: "Priser og kostnadsoppslag for bygg." },
    { title: "1Password", url: "1password.com", note: "Passordbehandler. Alle innlogginger ligger her.", status: "Passord", statusCls: "ok" },
    { title: "LinkedIn", url: "linkedin.com", note: "Nettverk, rekruttering og markedsføring." },
    { title: "Phonero", url: "phonero.no", note: "Telefonabonnement (mobil)." },
    { title: "reMarkable", url: "remarkable.com", note: "Digital notatblokk." },
    { title: "Adobe", url: "adobe.com", note: "PDF / Acrobat og designverktøy." },
    { title: "Nettside (Webflow)", url: "webflow.com/dashboard/sites/bygg-kon/general", note: "Ny nettside byggkon.no – redigeres i Webflow." },
    { title: "Møteromsbooking", url: "tb3-booking.itrelasjon.com", note: "Booking av møterom på Travbaneveien." },
    { title: "RIB-programmer", url: "", note: "Konstruksjonsprogramvare: Focus, Statcon, Revit, AutoCAD, Sletten." },
  ];
}

function defaultVision() {
  return `Felles målsetning for Byggkon

Byggkon skal være en trygg, lojal og profesjonell samarbeidspartner som leverer kvalitet i alle ledd. Vi skal være kjent for å dekke flere fagfelt, levere på tvers av disipliner og håndtere både små, store og komplekse prosjekter – inkludert større og mer varierte oppdrag og samarbeid med totalentreprenører.

Vi skal alltid ha kunden i sentrum og jobbe målrettet for å sikre fornøyde kunder gjennom høy faglig kvalitet, erfaring og pålitelig gjennomføring. Byggkon skal tydelig vise hvem vi er, både i markedet og på nettsiden, med en enkel, profesjonell og effektiv kommunikasjon som gjenspeiler kvaliteten vi leverer.

Menneskene i Byggkon er vår viktigste ressurs. Vi skal ta vare på kompetansen i selskapet, se hver enkelt medarbeider og legge til rette for utvikling, samarbeid og trivsel. En åpen kultur med lav terskel for dialog skal prege hele organisasjonen.

Ledelsen i Byggkon skal være synlig, tilgjengelig og tydelig. Det forventes at ledelsen:
• sikrer tilførsel av riktige og tilstrekkelige oppdrag
• har åpen, direkte og ærlig dialog med ansatte
• har lav terskel for innspill, spørsmål og tilbakemeldinger
• prioriterer struktur, systemer og kontinuitet i driften
• har tydelig fokus på økonomi, inntjening og bærekraftig vekst
• ser menneskene bak rollene og bygger tillit i organisasjonen

Gjennom tydelig ledelse, gode systemer og felles retning skal Byggkon skape forutsigbarhet, stabilitet og langsiktig verdiskaping – for kunder, ansatte og samarbeidspartnere.`;
}

function defaultArbeidsmetodikk() {
  return [
    "1. Innledning (kort – sett retning)",
    "• Målet er ikke mer arbeid, men bedre kontroll og mindre stress",
    "• Dette handler om enkle vaner som gir stor effekt over tid",
    "",
    "2. Håndtering av oppgaver (få kontroll på arbeidsmengden)",
    "Hovedprinsipp: Alt ut av hodet – inn i system",
    "• Lag en mappe i innboksen for oppgaver (>2 min å svare på)",
    "• Oppgavemappen — oppgaver kan ligge der noen dager. Hjernen kjører prosess i bakhånd",
    "• Dra e-poster dit i stedet for å la dem ligge og «stresse» deg",
    "• Sjekk mailen på morgenen og etter lunsj. Kun 2 ganger om dagen.",
    "• Bruk korte notater (OneNote) for å holde oversikt",
    "• Ikke skriv lange notater — det skal være raskt og praktisk",
    "",
    "3. Struktur i kalender og arbeidshverdag",
    "(alle legger sine ting inn i kalenderen)",
    "Hovedprinsipp: Kalenderen styrer dagen din — ikke motsatt",
    "• Mandager for meg — belastning/igangsette og pushe prosjekt.",
    "• Maks 2 møter per dag (vær forberedt)",
    "• Teams-møter: hold dem til 45 min",
    "• Fysiske møter: fortsatt viktig — bruk dem bevisst, f.eks. direkte møter med kunde. Ha god tid.",
    "• Book møter når du vet du er opplagt",
    "• Bruk korte, faste (recurring) møter der det gir mening",
    "• Begrens multitasking (se i taket 2 min)",
    "",
    "4. Møte- og samarbeidsstruktur",
    "Hovedprinsipp: Forutsigbarhet skaper ro",
    "• Bruk recurring møter med eksterne samarbeidspartnere",
    "• Recurring møter vil som regel redusere arbeidsoppgaver",
    "• Juster intervall etter fremdrift i prosjekt",
    "• Organiser møter på eget initiativ — ikke vent på andre",
    "• «Presenter» arbeidet til den som har behov for det.",
    "• Fredager: ikke eksterne møter, kanskje interne.",
    "• Kalender og aktivitet kan organiseres etter kapasitet/sosialt behov/hva som fungerer for deg",
    "",
    "5. Kundeoppfølging",
    "Hovedprinsipp: Fast rytme = mindre stress",
    "• Sett av fast tid til oppfølging: torsdag/fredag ca. kl. 10",
    "• Legg inn i kalender:",
    "    • Hvem som skal følges opp",
    "    • Leveringstidspunkt",
    "• Vær realistisk på frister — si heller realistisk levering enn å bomme. Avklar alltid forventet leveringstidspunkt. Utfordre dem om det høres urealistisk ut.",
    "",
    "6. Planlegging og prioritering",
    "Hovedprinsipp: Planlegg fremover — ikke bare reager",
    "• Hver fredag:",
    "    • Planlegg 2 uker frem i tid",
    "    • Lag prioriteringsliste over oppgaver",
    "    • Sorter etter viktighet",
    "• Legg inn i kalender:",
    "    • Hva du skal jobbe med neste uke",
    "• Hold deg mest mulig til planlagte (recurring) aktiviteter",
    "",
    "7. Ressursstyring og belastning",
    "Hovedprinsipp: Si ifra før det blir et problem",
    "• Be om bistand når det blir for mye",
    "• Ikke vent til du er overbelastet",
    "• Struktur og prioritering er det viktigste verktøyet mot stress",
    "• Ikke sjekk mail etter jobb",
    "• Noe er viktig, noe kan skyves på, noe er mindre viktig.",
    "• Hva er en typisk rådgiver for en frustrert prosjektleder? Venter på å få arbeidsoppgave, i stedet for å ta grep for å igangsette oppgaven, eller gir ikke tilbakemelding om oppgaven er fullført. Prosjektleder VS Rådgiver.",
    "",
    "8. Avslutning",
    "• Dette er ikke «regler», men anbefalte arbeidsvaner",
    "• Ta med dere det som fungerer",
    "• Små justeringer kan gi stor effekt over tid",
  ].join("\n");
}

function defaultMarketing() {
  return [
    "MARKEDSFØRING – BYGG-KON",
    "",
    "Mål: Øke synligheten og få tilgang på de beste prosjektene og kundene.",
    "",
    "Synlighet i sosiale medier",
    "- Jevnlige innlegg på LinkedIn: prosjekter, fagkompetanse, nyansatte, milepæler.",
    "- Send prosjektbilder/info til Daniel (fredager) for publisering.",
    "",
    "E-postmarkedsføring",
    "- Nyhetsbrev til kunder og kontakter med faglig innhold og referanseprosjekter.",
    "- Følg opp tilbud og henvendelser raskt.",
    "",
    "Relasjonsbygging",
    "- Lunsj og møter med nøkkelkunder jevnlig (mandager: prioriter de gode kundene).",
    "- Fredager: oppfølging — ring den som skal ha leveransen.",
    "",
    "Potensielle kundelister",
    "- Utarbeide og vedlikeholde liste over potensielle kunder (segmentert).",
    "- Bruk Mercell og Prosjektagenten for å finne aktuelle prosjekter.",
    "- Kartlegg hva slags kunder de beste er — finn flere lignende.",
    "",
    "Innhold og fag",
    "- Synliggjør kompetansen: RIB, RIBr, ARK, prosjektledelse og AI-verktøy.",
    "- Vis frem byggkon.ai-plattformen som et konkurransefortrinn.",
  ].join("\n");
}

// Startinnhold for onboarding-siden (fra intern rutine, uten passord).
function defaultOnboarding() {
  return [
    "ONBOARDING – NY ANSATT I BYGG-KON",
    "",
    "Tilganger og systemer:",
    "- Office 365 – Office-pakken inkl. Copilot. Tilgang til prosjekthotell.",
    "- Tripletex – timeføring og regnskap.",
    "- Holteportalen – KS (kontakt Ove).",
    "- Holte Byggsøk – byggesøknader.",
    "- Byggforsk – konto: post@byggkon.no.",
    "- Fireflies – OneNote-referater (ai@byggkon.no). Inviter til møter, referat lages automatisk.",
    "- n8n – kort opplæring (tilbud / uavhengig kontroll AI-agent).",
    "- ChatGPT – konto: ai@byggkon.no.",
    "- Fyxer AI – AI for mailhåndtering.",
    "- Prosjektagenten – database med offentlige og private prosjekter.",
    "- IT-support – support@itrelasjon.no.",
    "- Programvare – AutoCAD/Revit m.m., tilganger hos Ove.",
    "",
    "Utstyr:",
    "- Wenaas – jakke, verneutstyr, sko.",
    "- Mobil – Apple. Overføring av telefonabonnement.",
    "",
    "Praktisk:",
    "- Kalender – julebord o.l., invitasjoner.",
    "- Anbudsforespørsler – gjennomgang.",
    "",
    "Oppgaver (OA):",
    "- Bestille tilgangskort til bygget.",
    "- Bestille HMS-kort.",
    "- Bestille mobil (Apple).",
    "- Programvare – sjekk med Ove.",
    "- Fellesrutiner.",
  ].join("\n");
}

// Bedriftens verdier (BYGG-KON), vises på forsiden – redigerbare i innstillinger.
function defaultValues() {
  return [
    { letter: "B", text: "Bærekraftige relasjoner" },
    { letter: "Y", text: "Yrkesstolthet" },
    { letter: "G", text: "Gjensidig tillit" },
    { letter: "G", text: "Gjennomføringskraft" },
    { letter: "K", text: "Kvalitet" },
    { letter: "O", text: "Ordentlighet" },
    { letter: "N", text: "Nøyaktighet" },
  ];
}

// Startstruktur for organisasjonskartet (fra opplastet PDF, mai 2026).
function defaultOrgChart() {
  return [
    { id: "ole", name: "Ole-André Torjussen", title: "Daglig leder", email: "oat@byggkon.no", phone: "929 80 460", parentId: null },
    { id: "benedicte", name: "Benedicte Molnes", title: "Lederstøtte og prosjektingeniør", email: "bm@byggkon.no", phone: "467 89 790", parentId: "ole" },
    { id: "tormod", name: "Tormod Skavland", title: "Avdelingsleder BYGG og prosjektadm", email: "ts@byggkon.no", phone: "976 56 526", parentId: "ole" },
    { id: "mariam", name: "Mariam Sediqi Ansari", title: "Prosjektingeniør", email: "msa@byggkon.no", phone: "977 71 112", parentId: "tormod" },
    { id: "william", name: "William Larsen", title: "Avdelingsleder RIB", email: "wl@byggkon.no", phone: "412 27 676", parentId: "ole" },
    { id: "mortenl", name: "Morten Larsen", title: "Faglig leder RIB", email: "morten@byggkon.no", phone: "970 85 371", parentId: "william" },
    { id: "lana", name: "Svjetlana Milic Baros", title: "RIB", email: "lana@byggkon.no", phone: "950 97 996", parentId: "william" },
    { id: "bendik", name: "Bendik Selmer-Andersen", title: "RIB", email: "ba@byggkon.no", phone: "917 14 515", parentId: "william" },
    { id: "ola", name: "Ola K Undheim", title: "RIB", email: "au@byggkon.no", phone: "913 44 486", parentId: "william" },
    { id: "torgunnar", name: "Tor Gunnar Vilke", title: "RIB", email: "tgv@byggkon.no", phone: "452 59 205", parentId: "william" },
    { id: "ove", name: "Ove Henning Tjølsen", title: "Faglig leder ARK", email: "ovehenning@byggkon.no", phone: "951 98 426", parentId: "ole" },
    { id: "svein", name: "Svein Arne Bjørkheim", title: "Avdelingsleder RIBr", email: "sab@byggkon.no", phone: "954 24 989", parentId: "ole" },
    { id: "morteng", name: "Morten Grimen", title: "RIBr", email: "mg@byggkon.no", phone: "", parentId: "svein" },
    { id: "anders", name: "Anders Midbrød", title: "Andre rådgivende fag", email: "am@byggkon.no", phone: "404 97 160", parentId: "ole" },
    { id: "frode", name: "Frode Fiksdal", title: "AI-prosjekter, RIBtre", email: "ff@byggkon.no", phone: "977 54 977", parentId: "ole" },
  ];
}

let cached = null;

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Hele konfigurasjonen (fil over miljøvariabler over defaults).
export function getConfig() {
  if (!cached) {
    const file = readFile();
    const merged = { ...defaults() };
    // Bare ikke-tomme felter fra fila overstyrer.
    for (const [k, v] of Object.entries(file)) {
      if (v !== undefined && v !== null && v !== "") merged[k] = v;
    }
    cached = merged;
  }
  return cached;
}

// Lagrer endrede felter. Tomme strenger ignoreres (sletter ikke eksisterende
// tokens/passord hvis feltet står tomt i skjemaet).
export function saveConfig(partial) {
  const current = { ...readFile() };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    current[k] = v;
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2));
  cached = null; // tving ny innlasting
  return getConfig();
}

// Trygg versjon for visning i admin-UI: maskerer hemmeligheter.
export function getConfigForAdmin() {
  const c = getConfig();
  return {
    companyName: c.companyName,
    heroImageUrl: c.heroImageUrl,
    companyOrgNr: c.companyOrgNr,
    companyAddress: c.companyAddress,
    companyEmail: c.companyEmail,
    companyPhone: c.companyPhone,
    companyWebsite: c.companyWebsite,
    values: c.values || [],
    departments: c.departments || [],
    logoUrl: c.logoUrl || "",
    hasMcpUrl: Boolean(c.regnskapsagentMcpUrl),
    hasDashboardPassword: Boolean(c.dashboardPassword),
    weeklyCapacityHours: c.weeklyCapacityHours,
    cacheTtlMs: c.cacheTtlMs,
    refreshSeconds: c.refreshSeconds,
    mcpServers: (c.mcpServers || []).map((m) => ({ name: m.name, url: m.url })),
    settingsPath: SETTINGS_PATH,
  };
}

# Bygg-Kon — Sanntidsoversikt

Et live internt dashboard som henter sanntidsdata fra **Tripletex** og gir hele firmaet — og deg som daglig leder — full oversikt over drift, økonomi, prosjekter og kapasitet. Bygget for **Railway**, med profil tilpasset byggkon.no (Inter-font, mørk tekst #030213, teal-aksent #1e8b6f og bygg-bildet som banner), innebygd **Nova AI**-widget og en egen **admin-side** for alle innstillinger.

## Innhold

**Fane «Oversikt» (operasjonsvegg):**
- Heltebanner med bygg-bildet, live klokke/dato og nøkkeltall (omsetning i år, utestående/forfalt, aktive prosjekter, åpne ordre, timer denne måneden, snitt faktureringsgrad, ledig kapasitet).
- **Aktive prosjekter** som ruller automatisk i venstre kolonne.
- **Faktureringsgrad siste 4 uker** per ansatt (kun de som har ført timer), sortert med lavest grad øverst slik at ledig kapasitet er lett å se.
- Omsetning per måned, utestående fakturaer og åpne ordre.

**Fane «Prosjekter»:** søkbar tabell over alle aktive prosjekter med kunde, prosjektleder, timer siste 4 uker, timer i år, fakturerbart i år og siste aktivitet.

**Nova AI:** chat-widgeten er bygget inn nede til høyre.

## Slik fungerer innstillingene

Det meste settes fra **admin-siden** (`/admin`), beskyttet med eget admin-passord. Der legger du inn ansatt-passord, ukekapasitet, forsidebilde og oppdateringsintervall. Verdiene lagres i en JSON-fil på serveren. Tripletex-nøkkelen settes som miljøvariabel, ikke her.

Det eneste som **må** settes som miljøvariabel er:

| Variabel | Hva |
|---|---|
| `ADMIN_PASSWORD` | passord for admin-siden |
| `SESSION_SECRET` | lang tilfeldig streng som signerer innlogging |
| `SETTINGS_PATH` | sti til innstillingsfila — på Railway: `/data/settings.json` (krever Volume, se under) |

I tillegg må `TRIPLETEX_JWT` settes som miljøvariabel — se neste avsnitt. Resten kan settes som variabler i stedet for på admin-siden, se `.env.example`.

## 1. Datakilde: Tripletex API v2

Dashbordet snakker **rett med Tripletex sitt REST-API**. Ingen mellomledd, ingen egen tjeneste å drifte — bare én nøkkel som miljøvariabel.

Dette er Tripletex sin egen anbefaling for et internt dashboard som dette (support, 20.08.2026).

**a) Lag en API-nøkkel**

Bygg-Kon er ett selskap, så vi bruker Tripletex sin **interne integrasjon**. Da trengs verken consumer token eller søknaden med 2–3 ukers behandlingstid:

1. Logg inn i Tripletex som bruker med admin-rettigheter.
2. **Selskap → API-tokens →** opprett ny.
3. Kopier hemmeligheten. **Den vises bare én gang.**

> ⚠️ Riktig nøkkel **starter med `tlxr_`**. Tripletex har to slags nøkler som er lette å forveksle:
>
> | Hvor i Tripletex | Ser ut som | Trenger consumer token |
> |---|---|---|
> | Selskap → **API-tokens** | `tlxr_…` | nei ← bruk denne |
> | Innstillinger → Integrasjoner → **API-tilgang** | uten prefiks | ja |
>
> Dashbordet kjenner dem fra hverandre og velger riktig innlogging selv. Men limer du inn den andre, må du også skaffe et consumer token — og det er nettopp ventetiden vi ville unngå. **Test tilkobling** viser hvilken av dem den fant.

Krever at Integrasjoner-modulen er aktiv på kontoen. Nøkkelen arver rettighetene til brukeren den lages for — mangler den tilgang til f.eks. regnskapet, ser dashbordet bare deler av dataene.

**b) Legg nøkkelen inn i Railway**

```
TRIPLETEX_JWT=<jwt-hemmeligheten fra steg a>
```

Det er alt. Nøkkelen settes bevisst **ikke** fra admin-siden, så den aldri havner i innstillingsfila — som miljøvariabel overlever den enhver deploy.

| Variabel | Når |
|---|---|
| `TRIPLETEX_JWT` | normalt |
| `TRIPLETEX_ENV=test` | for å kjøre mot `api-test.tripletex.tech` i stedet for produksjon |
| `TRIPLETEX_CONSUMER_TOKEN` + `TRIPLETEX_EMPLOYEE_TOKEN` | kommersiell integrasjon mot andre selskapers regnskap |

**c) Sjekk at det virker**

`/admin` → **Test tilkobling** → **Kjør test** går gjennom kjeden steg for steg:

| Steg | Svarer på |
|---|---|
| Nøkkel | er en nøkkel satt, og hvilket miljø kaller vi? |
| Innlogging | godtar Tripletex nøkkelen? |
| Prosjekter | kommer det prosjektdata ut, med navn? |
| Timer | kommer timeføringene ut? |
| Regnskap | svarer saldobalansen, som økonomi-fanen bygger på? |

Testen stopper ved første feil og viser hva som må fikses.

**Hvordan påloggingen fungerer:** JWT-en byttes i en session token via `POST /token/session/:createFromRefreshToken`, som brukes som passord i Basic auth med brukernavn `0`. Session token varer 8 timer (Tripletex sitt maksimum) og fornyes automatisk; ved 401 logges det inn på nytt og kallet prøves om igjen. Alt ligger i [`src/tripletexApi.js`](src/tripletexApi.js).

**Endepunktene dashbordet henter fra**

`/project` · `/order` · `/invoice` · `/supplierInvoice` · `/customer` · `/supplier` · `/employee` · `/timesheet/entry` · `/ledger/account` · `/balanceSheet`

Alle kalles med `fields` for å utvide nøstede objekter (`customer(id,name)`, `project(id,name)` …) og `from`/`count` for paginering — maks 1000 rader per kall, se [`src/tripletex.js`](src/tripletex.js).

### Hva med MCP?

Dashbordet gikk tidligere via en MCP-server — først Regnskapsagent sin, så vår egen. Grunnen var at Regnskapsagent hadde det godkjente consumer-tokenet vi manglet. Da vi fant den interne integrasjonen med JWT, falt den grunnen bort: MCP finnes for at *språkmodeller* skal kunne kalle verktøy, og dashbordet er ingen språkmodell. Leddet er derfor fjernet.

[Tripletex sin egen MCP-server](https://developer.tripletex.no/tripletex-mcp-beta/) (`mcp.tripletex.no`) er fortsatt riktig verktøy for å la **Claude eller ChatGPT** jobbe mot regnskapet i en samtale. Den bruker OAuth, og slipper foreløpig bare inn de offisielle klientene — egne klienter skal støttes senere, uten dato. Den er ikke relevant for dashbordet.

## 2. Kjør lokalt (valgfritt)

```bash
npm install
cp .env.example .env      # sett minst ADMIN_PASSWORD og SESSION_SECRET
npm start                 # http://localhost:3000  (admin: http://localhost:3000/admin)
```

## 3. Deploy på Railway

1. Push koden til GitHub (se under).
2. Railway → **New Project → Deploy from GitHub repo** → velg repoet. Node oppdages automatisk (`npm start`).
3. **Variables**: legg inn minst `ADMIN_PASSWORD`, `SESSION_SECRET` og `SETTINGS_PATH=/data/settings.json`.
4. **Volume** (for at innstillinger skal overleve ny deploy): tjenesten → **+ New → Volume**, mount path `/data`. Uten Volume nullstilles innstillingene ved hver deploy.
5. **Settings → Networking → Generate Domain** for offentlig adresse.
6. Legg inn `TRIPLETEX_JWT` (se avsnitt 1), åpne `/admin`, logg inn med `ADMIN_PASSWORD`, og kjør **Test tilkobling**. Ferdig.

> `PORT` settes automatisk av Railway.

## Push til GitHub

```bash
cd byggkon-dashboard
git add -A && git commit -m "Bygg-Kon dashboard"
git push -u origin main
```

## Sikkerhet

- Dashbordet ligger bak ansatt-innlogging; admin-siden bak eget admin-passord.
- Tripletex-nøkkelen ligger kun som miljøvariabel på serveren, aldri i nettleseren og aldri i innstillingsfila. Admin-siden viser bare om den er satt, ikke selve verdien.
- Bytt ansatt-passordet fra admin-siden ved behov.

## Filstruktur

```
byggkon-dashboard/
├─ server.js            # Express: innlogging, admin, API-ruter
├─ src/
│  ├─ settings.js       # Innstillinger (fil + miljøvariabler)
│  ├─ tripletexApi.js    # Tripletex REST v2: innlogging + session token
│  ├─ tripletex.js      # Datalag: domeneoppslag, paginering + caching
│  ├─ diagnostics.js    # Tilkoblingstesten på admin-siden
│  └─ metrics.js        # Nøkkeltall, faktureringsgrad, prosjektdata
├─ public/              # Dashboard (index, app.js, styles.css, admin.js, login)
├─ views/               # Admin-sider (utenfor statisk servering)
├─ railway.json         # Railway-konfig
├─ .env.example
└─ package.json
```

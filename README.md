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

Det meste settes fra **admin-siden** (`/admin`), beskyttet med eget admin-passord. Der legger du inn MCP-URL-en til Tripletex-serveren, ansatt-passord, ukekapasitet, forsidebilde og oppdateringsintervall. Verdiene lagres i en JSON-fil på serveren. Selve Tripletex-tokenene ligger på MCP-tjenesten, ikke her.

Det eneste som **må** settes som miljøvariabel er:

| Variabel | Hva |
|---|---|
| `ADMIN_PASSWORD` | passord for admin-siden |
| `SESSION_SECRET` | lang tilfeldig streng som signerer innlogging |
| `SETTINGS_PATH` | sti til innstillingsfila — på Railway: `/data/settings.json` (krever Volume, se under) |

Du kan også sette `TRIPLETEX_MCP_URL` m.m. som miljøvariabler (se `.env.example`) hvis du heller vil det.

## 1. Datakilde: vår egen Tripletex MCP-server

Dashbordet henter data via MCP-serveren i repoet [**Oleandret/tripletex-mcp**](https://github.com/Oleandret/tripletex-mcp), som er en tynn proxy rett over Tripletex API v2. Ingen tredjepart står lenger mellom oss og regnskapet — tokenene ligger på vår egen Railway-tjeneste.

**a) Lag en API-nøkkel i Tripletex**

Bygg-Kon er ett selskap, så vi bruker Tripletex sin **interne integrasjon**. Da trengs verken consumer token eller søknaden med 2–3 ukers behandlingstid:

1. Logg inn i Tripletex som bruker med admin-rettigheter.
2. **Selskap → API-tokens →** opprett ny.
3. Kopier JWT-hemmeligheten. **Den vises bare én gang.**

Krever at Integrasjoner-modulen er aktiv på kontoen. Sørg også for at brukeren som oppretter tokenet har tilstrekkelige rettigheter, ellers ser dashbordet bare deler av dataene.

**b) Deploy MCP-serveren på Railway**

1. Railway → **New Project → Deploy from GitHub repo** → `Oleandret/tripletex-mcp`.
2. **Variables:**
   ```
   MCP_TRANSPORT=http
   TRIPLETEX_JWT=<jwt-hemmeligheten fra steg a>
   ```
   (`TRIPLETEX_ENV=test` hvis du vil kjøre mot Tripletex sitt testmiljø.)
3. **Settings → Networking → Generate Domain.** Helsesjekken svarer på `/health`, MCP-endepunktet er `/mcp`.

> Har du allerede consumer + employee token fra før, virker de også: sett `TRIPLETEX_CONSUMER_TOKEN` og `TRIPLETEX_EMPLOYEE_TOKEN` i stedet for `TRIPLETEX_JWT`.

**c) Koble dashbordet til**

Sett `TRIPLETEX_MCP_URL` i Railway på dashbord-tjenesten — hele adressen, med `/mcp` til slutt:

```
TRIPLETEX_MCP_URL=https://tripletex-mcp-production.up.railway.app/mcp
```

URL-en kan også limes inn på `/admin` → **MCP & datakilder**, men som miljøvariabel er den uavhengig av innstillingsfila.

Tripletex-nøkkelen settes **ikke** på admin-siden — den hører hjemme som `TRIPLETEX_JWT` på MCP-tjenesten. Trenger du unntaksvis at dashbordet sender den selv (f.eks. hvis én MCP-tjeneste skal betjene flere selskaper), kan `TRIPLETEX_JWT` settes på dashbord-tjenesten i stedet; da sendes den som `X-Tripletex-Jwt`-header ved hvert kall.

MCP-serveren har ingen egen pålogging: kjenner noen både URL-en og nøkkelen, har de tilgang til regnskapet. Behandle begge som passord.

> Migrering fra Regnskapsagent: den gamle `REGNSKAPSAGENT_MCP_URL` leses fortsatt som fallback, og et lagret `regnskapsagentMcpUrl` i innstillingsfila migreres automatisk. Fjern begge når `TRIPLETEX_MCP_URL` er på plass.

**d) Sjekk at det virker**

`/admin` → **Test tilkobling** → **Kjør test** går gjennom kjeden steg for steg:

| Steg | Svarer på |
|---|---|
| Innstillinger | er MCP-URL-en satt og gyldig? |
| Helsesjekk | kjører MCP-tjenesten? |
| MCP-håndtrykk | snakker den MCP på denne adressen? |
| Verktøy | har den alle verktøyene dashbordet trenger? |
| Tripletex-pålogging | godtar Tripletex nøkkelen? |
| Datauttrekk | kommer det faktisk prosjektdata ut, med navn? |

Testen stopper ved første feil og viser hva som må fikses, så du slipper å gjette hvilket ledd som svikter.

**e) Verktøyene dashbordet er avhengig av**

`search_projects` · `search_orders` · `search_invoices` · `search_supplier_invoices` · `search_customers` · `search_suppliers` · `search_employees` · `search_time_entries` · `search_accounts` · `get_balance_sheet`

Alle kalles med Tripletex sine egne parametre, inkludert `fields` for å utvide nøstede objekter (`customer(id,name)`, `project(id,name)` …) og `from`/`count` for paginering (maks 1000 rader per kall). Oppdaterer du MCP-serveren, må disse fortsette å sende `fields` videre til Tripletex — uten den mangler dashbordet kunde-, prosjekt- og ansattnavn.

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
6. Åpne `/admin`, logg inn med `ADMIN_PASSWORD`, og lim inn `TRIPLETEX_MCP_URL` + ansatt-passord (om du ikke satte dem som variabler). Ferdig.

> `PORT` settes automatisk av Railway.

## Push til GitHub

```bash
cd byggkon-dashboard
git add -A && git commit -m "Bygg-Kon dashboard"
git push -u origin main
```

## Sikkerhet

- Dashbordet ligger bak ansatt-innlogging; admin-siden bak eget admin-passord.
- MCP-URL-en ligger kun på serveren (miljøvariabel eller innstillingsfil), aldri i nettleseren. Admin-siden viser bare om den er satt, ikke selve verdien.
- Bytt ansatt-passordet fra admin-siden ved behov.

## Filstruktur

```
byggkon-dashboard/
├─ server.js            # Express: innlogging, admin, API-ruter
├─ src/
│  ├─ settings.js       # Innstillinger (fil + miljøvariabler)
│  ├─ mcpClient.js      # JSON-RPC mot tripletex-mcp (streamable HTTP)
│  ├─ tripletex.js      # Datalag: MCP-verktøykall, paginering + caching
│  └─ metrics.js        # Nøkkeltall, faktureringsgrad, prosjektdata
├─ public/              # Dashboard (index, app.js, styles.css, admin.js, login)
├─ views/               # Admin-sider (utenfor statisk servering)
├─ railway.json         # Railway-konfig
├─ .env.example
└─ package.json
```

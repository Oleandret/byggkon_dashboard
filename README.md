# Bygg-Kon — Driftsdashboard

Et live internt dashboard som henter sanntidsdata fra **Tripletex** og viser nøkkeltall, prosjekter, fakturaer/ordre og timer for hele Bygg-Kon. Bygget for å hostes på **Railway**, beskyttet med felles innlogging for ansatte.

Dashbordet oppdateres automatisk hvert minutt, og data caches i 5 minutter for å holde seg godt innenfor Tripletex sine API-grenser selv om mange ser på det samtidig.

## Hva vises

- **Nøkkeltall:** omsetning hittil i år, utestående og forfalte beløp, antall aktive prosjekter, åpne ordre, timer denne måneden, fakturerbar andel, antall ansatte.
- **Grafer:** omsetning per måned og timer per ansatt (fakturerbart vs. ikke).
- **Tabeller:** utestående fakturaer, mest aktive prosjekter, alle aktive prosjekter, åpne ordre og ansattliste.

## 1. Skaff Tripletex-nøkler

Dashbordet snakker direkte med Tripletex sitt REST-API, og trenger to nøkler:

1. **Consumer token** – knyttet til en API-integrasjon. Få denne fra Tripletex (Selskap → API-tilgang) eller fra deres support/partner.
2. **Employee token** – genereres på din egen brukerprofil i Tripletex under *Min profil → API-tilgang → Ny nøkkel*.

Tips: Prøv først mot testmiljøet ved å sette `TRIPLETEX_BASE_URL=https://api-test.tripletex.tech/v2`.

## 2. Kjør lokalt (valgfritt)

```bash
npm install
cp .env.example .env      # fyll inn nøkler og passord
npm start                 # åpne http://localhost:3000
```

## 3. Deploy på Railway

1. Legg koden i et Git-repo (GitHub/GitLab).
2. Gå til [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**, og velg repoet. Railway oppdager Node automatisk (Nixpacks) og kjører `npm start`.
3. Åpne tjenesten → **Variables** og legg inn:

   | Variabel | Verdi |
   |---|---|
   | `TRIPLETEX_CONSUMER_TOKEN` | consumer-token fra Tripletex |
   | `TRIPLETEX_EMPLOYEE_TOKEN` | employee-token fra Tripletex |
   | `DASHBOARD_PASSWORD` | felles passord ansatte logger inn med |
   | `SESSION_SECRET` | en lang tilfeldig streng |
   | `TRIPLETEX_BASE_URL` | (valgfritt) test- eller produksjons-URL |

4. Under **Settings → Networking → Generate Domain** får du en offentlig adresse, f.eks. `byggkon-dashboard.up.railway.app`.
5. Del adressen og passordet med de ansatte. Ferdig — siden viser ferske tall og oppdaterer seg selv.

> `PORT` settes automatisk av Railway, så den trenger du ikke røre.

## Sikkerhet

- Hele siden ligger bak innlogging; ingenting er offentlig uten passordet.
- API-nøklene ligger kun som miljøvariabler på serveren, aldri i nettleseren.
- Bytt `DASHBOARD_PASSWORD` ved behov (f.eks. når noen slutter) — endre variabelen i Railway, så logges alle ut.

## Filstruktur

```
byggkon-dashboard/
├─ server.js            # Express-server, innlogging, API-ruter
├─ src/
│  ├─ tripletex.js      # Tripletex-klient: session-token + caching
│  └─ metrics.js        # Bygger nøkkeltall fra rådata
├─ public/              # Frontend (dashboard, innlogging, css, js)
├─ railway.json         # Railway-konfig (helsesjekk + startkommando)
├─ .env.example         # Mal for miljøvariabler
└─ package.json
```

## Tilpasning

- **Oppdateringsfrekvens:** endre `REFRESH_INTERVAL_MS` i `public/app.js`.
- **Cache-tid:** endre `CACHE_TTL_MS` (miljøvariabel).
- **Flere/andre tall:** legg til oppslag i `src/tripletex.js` og regn ut i `src/metrics.js`.
- **Individuelle brukere i stedet for felles passord:** kan bygges på ved behov.

# Kulturhusprogram – Evenemang på kulturhusen i Göteborg med omnejd

Samlar evenemang från kulturhusen i Göteborg med omnejd till en sökbar tabell.

## Struktur

```
index.html                    – webbsidan (frontend)
functions/api/[[route]].js    – Cloudflare Pages Function (backend)
```

## Endpoints

- `/api/events` – JSON med alla evenemang (cache 6 h)
- `/api/events?refresh=1` – tvinga fram färsk hämtning
- `/api/debug` – felsökningsinfo per källa

## Källor

- goteborg.se (kulturhusen – sidan är servern-renderad, hämtas direkt)
- musikenshus.se
- houseofpossibilitas.se
- kulturhusetmollan.se
- kungalv.se (Angular-renderad kalender – hämtas via sajtens sök-API `POST /Search/Result/`)
- partille.se (Vue-renderad kalender – hämtas via sajtens JSON-API `/_api/eventlistpage/events`)
- bibliotek.kungsbacka.se

## Deployment (Cloudflare Pages)

1. Koppla repot som Pages-projekt (Build: ingen build, output: `/`).
2. Lägg till miljövariabel under **Settings → Variables and Secrets**:
   - `JINA_API_KEY` = din Jina-nyckel (hemlig, ska ALDRIG committas till repot)
3. Varje push till repot triggar automatisk deploy – `functions/`-mappen följer med och aktiverar API:et.

## Felsökning

Får du `"<!doctype..." is not valid JSON` på `/api/events` betyder det att funktionen inte är deployad – kontrollera att filen ligger exakt som `functions/api/[[route]].js` och att du deployat hela projektet (inte bara index.html).

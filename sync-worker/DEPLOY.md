# Træning-sync + Strava — deploy-vejledning

## 1. Forudsætninger
- Node.js installeret
- Cloudflare-konto (samme som du bruger til personale-registret er fint)

## 2. Installer Wrangler (Cloudflare's CLI)
```
npm install -g wrangler
wrangler login
```

## 3. Opret KV-namespace
```
wrangler kv namespace create TRAINING_KV
```
Kommandoen returnerer et `id`. Åbn `wrangler.toml` og indsæt det i stedet for
`REPLACE_MED_DIT_KV_NAMESPACE_ID`.

## 4. Opret en Strava-app (til auto-import af løbeture)
1. Gå til https://www.strava.com/settings/api og opret en app.
2. "Authorization Callback Domain" skal være din Worker's domæne, altså
   `dit-subdomaene.workers.dev` (uden https:// og uden sti).
3. Noter dit **Client ID** og **Client Secret** — de skal bruges i trin 6.

## 5. Sæt LOB_APP_URL i wrangler.toml
Åbn `wrangler.toml` og erstat `LOB_APP_URL` med den fulde URL på din
løbe-tracker, fx:
```
LOB_APP_URL = "https://dit-brugernavn.github.io/dit-repo/lob/index.html"
```
Det er hertil Strava sender brugeren tilbage efter godkendelse.

## 6. Deploy Worker'en og sæt hemmelige nøgler
Stå i `sync-worker`-mappen:
```
wrangler deploy
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
```
(indtast værdierne fra trin 4 når du bliver bedt om det — de bliver ALDRIG
skrevet til en fil, kun gemt krypteret hos Cloudflare)

Wrangler viser en URL i stil med:
```
https://oliver-training-sync.DIT-SUBDOMÆNE.workers.dev
```
Den URL skal du bruge i næste trin — og den skal matche det domæne du satte
som "Authorization Callback Domain" i trin 4.

## 7. Sæt URL'en i alle tre apps
Åbn hver af disse tre filer og find linjen med `SYNC_BASE_URL`:
- `sbd/index.html`
- `lob/index.html`
- `index.html` (dashboard)

Erstat placeholder-teksten med din rigtige Worker-URL, fx:
```js
const SYNC_BASE_URL = 'https://oliver-training-sync.dit-subdomaene.workers.dev';
```

## 8. Forbind Strava (gør dette for både Oliver og Ellen)
1. Åbn løbe-trackeren, skift til din profil (Oliver/Ellen)
2. Gå til Opsætning → tryk "Forbind med Strava"
3. Godkend på Strava — du bliver sendt tilbage til appen automatisk
4. Gentag for den anden profil

## 9. Test
- Tryk "Synkroniser nu" i Opsætning for at hente øjeblikkeligt, eller vent —
  Worker'en henter automatisk nye løbeture hver 3. time (Cron Trigger).
- Log noget i SBD-trackeren på telefonen, vent et par sekunder (sync sker med
  1,5 sek. forsinkelse efter du gemmer), og genindlæs siden på computeren —
  data burde nu være der.

## Sådan virker det
- Hver app gemmer stadig i localStorage som altid — det er stadig det appen
  bruger, og det virker uden internet.
- Ved gem sender appen (med lidt forsinkelse) også data op til Worker'en.
- Ved åbning henter appen først ned fra Worker'en, og bruger den nyeste
  version (baseret på tidsstempel) — så den enhed du sidst gemte fra, vinder.
- Strava-import kører automatisk hver 3. time via en Cron Trigger på
  Worker'en, og skriver direkte ind i den samme KV-nøgle som almindelig sync
  bruger — så løbeture fra Strava dukker op i appen helt automatisk, uden at
  appen selv skal snakke med Strava.
- Hver profil (main = Oliver, partner = Ellen) har sin egen Strava-forbindelse
  og sit eget token-lager — de kan ikke se eller påvirke hinandens data.
- Ingen adgangskontrol på selve sync — Worker-URL'en er reelt den eneste
  "nøgle". Del den ikke offentligt. Strava-tokens ligger krypteret i KV og
  eksponeres aldrig til klienten.

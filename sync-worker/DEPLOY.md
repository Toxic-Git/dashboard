# Deploy-vejledning — sync-worker (Cloudflare Worker)

Denne Worker giver cross-device sync (telefon ↔ computer, Oliver ↔ Ellen)
og automatisk import af løbeture fra Strava. Alle tre apps virker uden den —
de gemmer bare kun lokalt.

Du skal bruge en gratis Cloudflare-konto (cloudflare.com).

---

## 1. Installér Wrangler og log ind

```
npm install -g wrangler
wrangler login
```

## 2. Opret KV-namespace

```
cd sync-worker
wrangler kv namespace create TRAINING_KV
```

Wrangler udskriver et ID. Åbn `wrangler.toml` og erstat
`INDSAET-KV-NAMESPACE-ID-HER` med det ID.

## 3. Deploy

```
wrangler deploy
```

Wrangler udskriver din Worker-URL, fx:

```
https://oliver-training-sync.dit-navn.workers.dev
```

**Kopiér den** — du skal bruge den i trin 5 (og evt. 4).

## 4. Strava (valgfrit)

1. Gå til https://www.strava.com/settings/api og opret en app.
   - **Authorization Callback Domain:** din Worker-domæne uden `https://`,
     fx `oliver-training-sync.dit-navn.workers.dev`
2. Sæt `LOB_APP_URL` i `wrangler.toml` til din rigtige
   `.../lob/index.html`-adresse på GitHub Pages, og kør `wrangler deploy` igen.
3. Sæt secrets (Client ID og Client Secret står på Strava-siden):

```
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
```

Herefter kan I trykke "Forbind med Strava" i løbe-trackerens Opsætning —
én gang pr. profil (Oliver og Ellen). Worker'en henter nye løbeture
automatisk hver 3. time; "Synkroniser nu"-knappen henter dem med det samme.

## 5. Sæt Worker-URL'en ind i appene

Find linjen `const SYNC_BASE_URL = 'https://REPLACE-ME.workers.dev';` i:

- `index.html` (dashboard)
- `sbd/index.html`
- `lob/index.html`

og erstat med din rigtige Worker-URL. Upload de tre filer til GitHub igen.

---

## Test at det virker

1. Åbn `https://din-worker-url/kv/test` i en browser — du skal få
   `{"value":null,"updatedAt":0}` (ikke en fejlside).
2. Log noget i SBD-appen på én enhed, åbn appen på en anden — data skal
   dukke op efter få sekunder.
3. (Strava) Åbn `https://din-worker-url/strava/status?profile=main` —
   du skal få `{"connected":false}` før forbindelse, `true` efter.

## Sikkerhed

Der er ingen adgangskontrol — Worker-URL'en fungerer som adgangskode.
Del den ikke offentligt, og læg den ikke i et offentligt repo-readme.

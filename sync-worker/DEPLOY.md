# Deploy-vejledning — sync-worker (Cloudflare Worker)

Denne Worker giver cross-device sync (telefon ↔ computer, Oliver ↔ Ellen).
Alle tre apps virker uden den — de gemmer bare kun lokalt.

Løbeture importeres manuelt i løbe-trackerens Opsætning (GPX/TCX/CSV fra
Samsung Health, Apple Health m.fl.) — det kræver ikke denne Worker.

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

## 4. Sæt Worker-URL'en ind i appene

Find linjen `const SYNC_BASE_URL = 'https://REPLACE-ME.workers.dev';` i:

- `index.html` (dashboard)
- `sbd/index.html`
- `lob/index.html`

og erstat med din rigtige Worker-URL. Upload de tre filer til GitHub igen.

---

## Test at det virker

1. Åbn `https://din-worker-url/kv/lob_state` i en browser. Uden adgangskode sat
   får du `{"value":...,"updatedAt":...}`; med `SYNC_TOKEN` sat får du
   `{"error":"uautoriseret"}` (401) — det er meningen.
2. Log noget i SBD-appen på én enhed, åbn appen på en anden — data skal
   dukke op efter få sekunder.

## 5. Sæt sync-adgangskode (anbefalet)

Uden den kan enhver, der kender Worker-URL'en, læse og overskrive dine data.

```
wrangler secret put SYNC_TOKEN
```

Vælg en lang tilfældig kode (32+ tegn, fx fra en password-manager). Så snart den
er sat, afviser Worker'en alle kald uden `Authorization: Bearer <kode>` (401).
Indtast samme kode i løbe-trackeren under **Opsætning → Synkronisering** på hver
enhed — SBD og dashboard bruger automatisk samme kode (samme domæne).
Rotation: sæt en ny `SYNC_TOKEN` og indtast den nye kode på alle enheder.

## Sikkerhed

Med `SYNC_TOKEN` sat kræves en bearer-kode til alle kald. Uden den er
Worker-URL'en reelt den eneste "adgangskode" — del den ikke offentligt.
Koden ligger i browserens localStorage på dine enheder, så den beskytter mod
fremmede, ikke mod nogen med adgang til din egen telefon.

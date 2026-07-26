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

1. Åbn `https://din-worker-url/kv/test` i en browser — du skal få
   `{"value":null,"updatedAt":0}` (ikke en fejlside).
2. Log noget i SBD-appen på én enhed, åbn appen på en anden — data skal
   dukke op efter få sekunder.

## Sikkerhed

Der er ingen adgangskontrol — Worker-URL'en fungerer som adgangskode.
Del den ikke offentligt, og læg den ikke i et offentligt repo-readme.

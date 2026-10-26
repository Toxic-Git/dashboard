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

1. Åbn `https://din-worker-url/version` i en browser — du skal få
   `{"api":2,"keys":[…],"conditionalPut":true}` (v2). Ser du `not found`,
   kører en ældre Worker; deploy `worker.js` igen.
2. Log noget i SBD-appen på én enhed, åbn appen på en anden — data skal
   dukke op efter få sekunder.

## Sikkerhed

Sæt hemmeligheden `SYNC_TOKEN` (`wrangler secret put SYNC_TOKEN`, eller Cloudflare → Worker → Settings → Variables and Secrets → Secret) og indtast samme kode i løbe-appens Opsætning. Uden den er Worker'en åben for alle, der kender URL'en.

## Eksisterende opsætning / opgradering til v2

v2 virker med både binding `TRAINING_KV` (nøgler som de er) og den ældre binding `KV` (nøgler gemt som `kv:<nøgle>`), så eksisterende data findes uændret. Opgradering = deploy `worker.js`; gamle deployments kan rulles tilbage i Cloudflare. Se `docs/V3-SYNC.md`.

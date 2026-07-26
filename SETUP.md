# Opsætnings-guide — Trænings-app (Dashboard + SBD + Løb)

Denne guide tager dig fra "en masse filer" til en færdig, virkende app på
telefon og computer, for både dig og Ellen.

---

## 0. Hvad du har fået

```
dit-repo/
  index.html          ← Dashboard (forsiden)
  manifest.json         ← PWA-manifest til dashboard
  sw.js                ← Service worker til dashboard
  dash-icon.svg         ← Ikon til dashboard

  sbd/
    index.html         ← SBD-tracker (styrke)
    manifest.json, sw.js, icon-192.png, icon-512.png

  lob/
    index.html         ← Løbe-tracker
    manifest.json, sw.js, icon.svg

  demo-data.html        ← Værktøj til at se appen fyldt med eksempeldata

  sync-worker/
    worker.js          ← Cloudflare Worker (cross-device sync)
    wrangler.toml        ← Konfiguration til Worker'en
    DEPLOY.md           ← Detaljeret deploy-vejledning til Worker'en
```

---

## 1. Læg det på GitHub Pages

1. Opret et repo på GitHub (eller genbrug et eksisterende), fx `traening`.
2. Upload alle filer og mapper **præcis i den struktur som ovenfor** — `sbd/`
   og `lob/` skal være undermapper i roden af repoet, ikke inde i en ekstra
   mappe.
3. Gå til repoets **Settings → Pages**, vælg branch (typisk `main`) og
   mappe `/ (root)`, og gem.
4. Efter ét minuts tid får du en URL i stil med:
   ```
   https://dit-brugernavn.github.io/traening/
   ```
   Det er din **dashboard-URL**. `sbd/` og `lob/` ligger under samme adresse
   (`.../traening/sbd/index.html` osv.).

---

## 2. Sæt cross-device sync op (valgfrit, men anbefalet)

Uden dette trin virker alle tre apps fint — de gemmer bare kun lokalt på den
enhed du bruger dem på. Med dette trin synkroniserer data automatisk mellem
telefon og computer. (Løbeture importeres manuelt i løbe-trackerens
Opsætning som GPX/TCX/CSV — det kræver ikke dette trin.)

Følg `sync-worker/DEPLOY.md` — kort fortalt:

1. `npm install -g wrangler` og `wrangler login`
2. Opret et KV-namespace, sæt dets ID ind i `wrangler.toml`
3. `wrangler deploy` i `sync-worker`-mappen
4. Kopiér den URL Wrangler giver dig (`https://oliver-training-sync.xxx.workers.dev`)

**Sæt den URL ind tre steder** — find linjen `const SYNC_BASE_URL = ...` i:
- `index.html`
- `sbd/index.html`
- `lob/index.html`

og erstat placeholder-teksten med din rigtige URL. Upload de tre ændrede
filer til GitHub igen.

---

## 3. Installér som app på telefonen (begge jeres telefoner)

For hver af de tre adresser (dashboard, `sbd/`, `lob/`):

**iPhone:** Åbn adressen i Safari → tryk Del-ikonet → "Føj til hjemmeskærm".
**Android:** Åbn adressen i Chrome → menu (⋮) → "Føj til startskærm" / "Installer app".

Du ender med tre ikoner — Dashboard, SBD, Løb — der åbner som almindelige
apps, uden browser-bjælke.

---

## 4. Åbn på computeren

Bare besøg samme tre adresser i en almindelig browser — layoutet tilpasser
sig automatisk til en bredere skærm.

---

## 5. Første gang I bruger det

1. **SBD:** vælg profil (Oliver/Ellen) øverst, log jeres 1RM i Opsætning.
2. **Løb:** vælg profil, gennemfør onboarding (maxpuls, hvilepuls, evt.
   20-min-test).
3. **Dashboard:** vælg profil, tjek at "Denne uge" og "Oversigt" viser data.
4. (Valgfrit) Aktivér push-påmindelser i dashboardets "Indstillinger"-sektion.

---

## 6. Vil du se hvordan det ser ud fyldt med data først?

Åbn `demo-data.html` (samme adresse som resten, fx
`.../traening/demo-data.html`), tryk "Indlæs demo-data", og udforsk. Tryk
"Ryd demo-data" bagefter for at starte helt rent — se filen selv for detaljer.

---

## Tjekliste

- [ ] Alle filer uploadet til GitHub, `sbd/`/`lob/` som undermapper i roden
- [ ] GitHub Pages aktiveret, dashboard-URL virker
- [ ] (Valgfrit) Worker deployet, `SYNC_BASE_URL` sat i alle tre filer
- [ ] Alle tre apps installeret som PWA på begge telefoner
- [ ] SBD og løb onboardet for begge profiler
- [ ] Dashboard viser rigtige data for begge profiler

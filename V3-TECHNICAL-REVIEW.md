# V3-TECHNICAL-REVIEW — Teknisk stabilisering (V3.1)

**FASE 1 (teknisk stabilisering) — dato 2026-10-26.** Alt nedenfor er verificeret af mig i denne session ud fra koden og egne testkørsler; tidligere testresultater er ikke genbrugt. Hvor noget kun er inspiceret eller kun testet mod en mock, står det udtrykkeligt.

## 0. Læsevejledning — fire kategorier
| Kategori | Betydning |
|---|---|
| ✅ **Verificeret** | kørt som automatiseret test mod rigtig kode (se niveau) eller smoke-testet mod den rigtige, deployede Worker |
| 🧪 **Testet med mocks / kun kode** | testet mod Worker-*kildekode* i Node (in-memory KV), ikke mod Cloudflares runtime/produktion |
| 🔶 **Kræver produktionstest** | kan ikke gøres uden at røre dine rigtige data eller uden dine hemmeligheder |
| ⚠️ **Kendte problemer** | se afsnit 8 |

## 1. Bekræftede fejl (fundet ved kodeinspektion + reproduktion)
| # | Fejl | Konsekvens | Bevis |
|---|---|---|---|
| B1 | V3-brugerdata (planændringer, afviste forslag, fokus, "ikke mulig"-dage) blev **ikke** synket | enhederne viste forskellige kalendere/forslag | kode + `tp-sync`-tests |
| B2 | Sync v1: serverens nyere version **overskrev tavst** usendte lokale ændringer | tabt data ved to enheder/offline | reproduceret i test (v1-adfærd) |
| B3 | Gendannelse satte `__updatedAt=nu` → en gendannet (evt. ældre) backup kunne senere vinde over/skjule nyere serverdata | tavs overskrivning af nyere data | kode + test (nu: gendannelse rører ikke serverversionen; konflikt-dialog) |
| B4 | `dash_schedule_anchor` gemmes som rå datostreng, men backup/gendannelse antog JSON → sprang eksport over / ville ødelægge ved gendannelse | rytme-anker tabt/korrupt | test (rå streng nu bevaret) |
| B5 | Hybrid-konflikter skelnede ikke typer: alle underkropsdage = "tung"; alle planlagte kvalitetsløb = "hårdt"; teknik-dage (box squat, deficit-dødløft 3×3 ≈60–65 %) gav samme advarsel som tung squat/dødløft | falske advarsler, tillid undermineres | `tests/tp-plan-typer.test.js` |
| B6 | Service workers cachede og genbrugte svar fra sync-Workeren (`/kv/…`); sbd/lob faldt tilbage til cached `index.html` | gammel serverversion kunne se frisk ud; offline → "bad-json" i stedet for "offline" | `tests/sw-sync.test.js` (fejler uden rettelsen) |
| B7 | `lob/index.html`: `detectPlanGap` regnede dage som ms/86 400 000 → +1 dag over sommer-/vintertid | planen skubbet én dag for meget (opstod faktisk i testen kl. 23:24 efter skiftet 25. okt) | `tests/lob.test.js` |
| B8 | `TP.summarize` kastede på korrupt (men checksum-gyldig) backup i stedet for at afvise pænt | importfejl uden brugerbesked | `tests/tp-migration.test.js` |
| B9 | `TP.hash(null)` og ikke-liste `changes` kastede | kantfald | `tests/debug-rounds.test.js` |
| B10 | SBD-appen sendte ikke `Authorization`-header → ville fejle (401) så snart `SYNC_TOKEN` blev sat | sync ville stoppe i SBD | `tp-sync`-tests (SBD-sti) |
| B11 | e2e-testene brugte en håndskrevet mock-Worker i stedet for Worker-koden | mock kunne afvige fra virkeligheden | e2e kører nu mod `sync-worker/worker.js` |
| B12 | **Produktions-Worker'en var ældre end repoet:** binding `KV` (ikke `TRAINING_KV`), nøgler `kv:<nøgle>`, ingen token-tjek, ingen validering. Repoets `worker.js` ville være fejlet / ikke fundet dine data | deploy af repo-koden uændret ville have ødelagt sync | set i Cloudflare-dashboardet |
| B13 | Worker'en var **åben** (`SYNC_TOKEN` ikke sat) | alle med URL'en kunne læse/skrive | observeret; **rettet af ejeren kl. 23:55** (secret sat i Cloudflare) |

## 2. Rettelser (kort)
- **Sync-arkitektur:** ny `tp-sync.js` (delt motor), Worker API v2 (betinget PUT/409, validering, `/version`, tp_meta-nøgler), klient og Worker bagudkompatible (se `docs/V3-SYNC.md`).
- **Konfliktstrategi:** blobs → bruger vælger (intet tavst); meta → tabsfri state-merge; rapporter afledt (ikke synket).
- **Problem B:** typebaserede regler R1/R1b/R2/R2b/R8 + alvor/begrundelse/"bygger på"/begrænsninger; planlagte løbstyper udledt af planfase (lav sikkerhed, markeret). Programmer omskrives aldrig.
- **Backup/restore:** rå anker, korrupt-sikker oversigt, gendannelse rører ikke serverversion.
- **Service workers:** udelukker synk-kald; cache-versioner hævet (dash v11, sbd v8, lob v7).
- **Worker produktion:** v2 deployet med understøttelse af begge bindings (`TRAINING_KV`/`KV`) og nøgleformater.

## 3. Ændrede filer
`sync-worker/worker.js` (v2) · `tp-core.js` · `tp-sync.js` (ny) · `tp-plan.js` · `tp-ui.js` · `index.html` · `sbd/index.html` · `lob/index.html` · `sw.js` · `sbd/sw.js` · `lob/sw.js` · docs: `docs/V3-SYNC.md` (ny), `docs/V3-ARKITEKTUR.md`, `sync-worker/DEPLOY.md`, dette dokument · tests: `tests/tp-sync.test.js`, `tp-plan-typer.test.js`, `tp-migration.test.js`, `sw-sync.test.js`, `debug-rounds.test.js`, `worker-local.js` (nye), `tests/helpers/world.js`, `tests/fixtures/worker-v1.js`, `tp-core/lob/sbd/tp-report/tp-plan`-tests (opdateret), `e2e/e2e.js`.

## 4. Migreringer
Ingen destruktive. Additiv og idempotent V2→V3-migrering (`tpv:3`, stabile id'er, `exerciseSubs`/`sessionEval`/`altOverrides`), meta: `tombs`, `dismissTombs`, `cal`, `goalPriority.at` tilføjet ved indlæsning. Nye lokale nøgler: `<nøgle>__sh`, `tp_sync_state`, `tp_sync_notes`, `tp_sync_backup_<nøgle>`, `tp_sync_conflict_<nøgle>`. **Server:** nye nøgler `tp_meta_main/partner`; eksisterende `kv:`-data uændret. Dokumenteret og testet: `tests/tp-migration.test.js` (V2-fixture, begge profiler, ingen tab, idempotens, load skriver ikke).

## 5. Testresultater
**Node (`node tests/run-all.js`): alle 14 filer grønne** — bl.a. tp-sync 37, tp-core 27, tp-migration 12, tp-plan 23 + tp-plan-typer 16, tp-report 19, tp-substitution 20, lob 27, sbd 21+14, sw-sync 6, debug-rounds. Lokal Worker-runtime (`tests/worker-local.js`, wrangler dev --local, binding `KV`): **9/9**.
**Browser-e2e (Chromium, Playwright):** se afsnit 6 og seneste kørsel i `e2e/results.json`.

### Testniveauer — hvad er hvad
| Niveau | Dækker | Er det en produktionstest? |
|---|---|---|
| Enhed / integration (Worker-kode i Node) | konflikter, meta-merge, offline, restore+sync, profilisolering, v1-kompatibilitet, begge bindings | **Nej** (kildekode + in-memory KV) |
| Browser-e2e | konflikt-banner, tastatur, offline-kø, profilisolering, status, alt fra tidligere | **Nej** (Worker-kode bag Playwright-route) |
| Lokal Worker-runtime (workerd) | API-kontrakt + klientmotor to enheder | **Nej** (lokal runtime, lokal KV) |
| **Deployet Worker (produktion)** | før token: `/version`→api 2; 4 poster læst uændret; ukendt nøgle 400; ugyldig værdi 422; forældet base 409 (intet skrevet); CORS 200. Efter token: `/version` 200, `/kv/*` uden token **401**, forkert token **401**, OPTIONS 200 | **Ja, men kun læse/afvisnings-smoke** (korrekt token er ikke prøvet af mig) |
| Produktion: skrivning + to-enheds-konflikt | – | **Ikke udført** (ville ændre dine rigtige data) |

**Manglende for en fuld produktionstest:** (1) et dedikeret test-namespace/Worker (så skrivning ikke rører rigtige data) — eller din udtrykkelige tilladelse til en reversibel skrivetest; (2) `SYNC_TOKEN` er sat af ejeren og kendes ikke af mig (og bør ikke deles med mig); (3) to rigtige enheder. Ingen tokens er udskrevet eller gemt i filer/ZIP.

## 6. Browsertjek (Chromium via Playwright; ingen Firefox/Safari/fysisk mobil)
- Responsivt: ingen vandret scroll/overflow for 3 visninger × 7 bredder (360–1920).
- Konfliktbanner @390: role=alert, 3 knapper ≥44 px, tastatur-aktivering (fokus + Enter), ingen vandret scroll.
- Tastatur/fokus: faner, modal-fokusfælde, Escape, fokus tilbage til udløser (eksisterende tests, kørt igen).
- axe (WCAG 2.x A/AA) over alle skærme/tilstande ved 390 og 1366 px, inkl. nye dashboardtilstande.
- Offline: ændring gemmes lokalt og i kø, sendes ved `online`; PWA-offline-visning.
- **Ikke gjort:** skærmlæser (ingen påstand), iOS/Android-enheder, WebKit/Firefox.

## 7. Verificeret funktionalitet (opsummering)
**✅** konfliktbanner + valg, betinget skrivning/409, meta-merge, tombstones, offline-kø, profilisolering (Worker afviser mismatch), backup/restore inkl. rollback og korrupt input, V2→V3-migrering, typebaserede konfliktregler, substitution (primær + A + B; udført øvelse gemmes; ingen vægtoverførsel; hovedløfts-progression beskyttet; per-pas-omfang), månedsrapporter, regression (progression, RPE, deload, SBD-historik, løbeplan/-import, pausetimer, genstart, profilskift).
**🧪** to-enheds-/offline-/restore-scenarier mod Worker-kode og lokal runtime. **🔶** skrivning og to-enheds-konflikt mod produktion; token-flow.

## 8. Kendte begrænsninger / problemer
1. `SYNC_TOKEN` er nu sat (verificeret: 401 uden/forkert token). Appene på **alle enheder** skal have samme kode i løbe-appens Opsætning, ellers vises 401-beskeden og der synkes ikke (lokale data urørte). Korrekt-token-flowet er testet mod Worker-kode, ikke mod produktion.
2. KV har ingen atomisk CAS → ekstremt snævert race-vindue (se `docs/V3-SYNC.md`).
3. Blob-konflikter kræver brugervalg (bevidst); ingen auto-merge af træningslogs.
4. Planlagte løbstyper er skøn ud fra planfase (lav sikkerhed) — løb-appen vælger dagens pas dagen før. To definitioner af "hårdt løb" lever side om side (dashboard ≥80 % maxHR vs. løb-appens Z3+ ≥70 %).
5. Gendannelse er ikke atomisk i localStorage (snapshot + rollback; strømsvigt midt i kan give delvis tilstand → snapshot er vejen tilbage).
6. Multi-fane på samme enhed er ikke særskilt håndteret (restore genindlæser andre faner).
7. Tombstones ryddes efter 120 dage.
8. Kun Chromium; ingen skærmlæser; ingen fysisk mobil.
9. `wrangler.toml` og `sync-worker/.wrangler/cache/wrangler-account.json` er sporet i git i brugerens repo — bør ud af versionsstyring (konto-id'er).
10. Brugerens Cloudflare-Worker-kode blev opdateret via dashboard-editoren (formateret af editoren); den er semantisk identisk med `sync-worker/worker.js` (samme linjetal/struktur; `/version` svarer som forventet). Repoet er kilde til sandhed.

# V3.1 — Synkronisering: datamodel, konfliktstrategi, scenarier og niveauer

Gælder `tp-sync.js` (klient, delt af dashboard/SBD/løb) og `sync-worker/worker.js` (API v2). Alt nedenfor er beskrevet ud fra koden og de tests, der faktisk findes (se "Testniveauer").

## 1. Hvad synkes — brugerdata vs. afledte data
| Data | Nøgle på serveren | Type | Synkes? | Hvorfor |
|---|---|---|---|---|
| Styrketræning (logs, 1RM, substitutioner, evalueringer) | `sbd_state`, `sbd_partner` | brugerdata (blob) | ja | kilden til al historik |
| Løb (løb, profil, mål, evalueringer) | `lob_state`, `lob_partner` | brugerdata (blob) | ja | kilden til al løbehistorik |
| Planændringer (flyt/let/spring over), afviste forslag (+ "vis igen"), fokus/målprioritering | `tp_meta_main`, `tp_meta_partner` | brugerdata (meta) | ja | brugerens egne valg |
| "Ikke mulig"-dage, indhentningsdage, rytme-anker | spejles ind i meta (`cal`) og tilbage til `dash_*`-nøglerne | brugerdata | ja | styrer kalenderen |
| Månedsrapporter (`meta.reports`) | – | **afledt** | **nej** | genberegnes af de synkede logs; synkede kopier ville kunne modsige kilden |
| `meta.lastRestore`, `tp_prerestore_snapshot`, `tp_restore_epoch`, `tp_last_export` | – | enhedslokal | nej | gælder kun denne enhed |
| `sbd_state.profile` (aktiv profil på enheden) | – | enhedslokal | nej (ignoreres i hash/pull) | ellers ville profilskift på én enhed skifte profil på en anden |
| `sync_token` | – | hemmelighed | aldrig (ikke i backup, ikke i serverdata) | |

## 2. Konfliktstrategi (ikke "sidste skriver vinder")
**Blobs** (`sbd_*`, `lob_*`): klienten husker for hver nøgle serverens versionsnummer (`<nøgle>__updatedAt`) og en hash af den sidst server-bekræftede værdi (`<nøgle>__sh`). Lokal ændring = "snavset" (hash ≠ `__sh`).
- Server uændret + lokal snavset → send (betinget PUT med `baseUpdatedAt`).
- Server nyere + lokal ren → hent (ingen konflikt).
- Server nyere + lokal snavset → **konflikt**: intet overskrives. Et banner (role=alert) giver tre valg: *Behold denne enhed* · *Brug den anden enhed* · *Hent begge som fil*. Den fravalgte version lægges i en sikkerhedskopi (`tp_sync_backup_<nøgle>`) og kan genskabes under Indstillinger.
- Identisk indhold (anden nøglerækkefølge) → ingen konflikt.
- Blobs auto-flettes **ikke**: en tavs sammenfletning af træningslogs kan give dobbelte pas eller tabte sæt, så brugeren vælger.

**Meta** (`tp_meta_*`): tabsfri tilstandsbaseret sammenfletning (kommutativ, idempotent): union af planændringer; *tombstones* (fortrydelser) forhindrer at en fortrudt ændring genopstår; afviste forslag/"vis igen" = register `{on,t}` pr. forslag (seneste handling vinder pr. forslag); "ikke mulig"-dage = register pr. dato; fokus = seneste ændring vinder, og et skifte noteres synligt. Ingen dialog nødvendig. Tombstones ryddes efter 120 dage.

**Worker v2:** `PUT {value, baseUpdatedAt}` → `409` + serverens nuværende post hvis versionen er ændret. PUT uden `baseUpdatedAt` virker som før (v1-klienter). Versionen er monotont stigende. Validering (`422`/`413`), `GET /version` (`{api:2}`).

## 3. Scenarier
| Scenarie | Forventet adfærd | Dækket af |
|---|---|---|
| Telefonen ændrer mens PC er offline | ændringen ligger i kø ("Venter på at blive sendt"); sendes når online; ingen fejldialog | integration + browser-e2e |
| Begge enheder ændrer samme blob | den sidste der synker får konflikt-banner; intet tabes | integration + browser-e2e + lokal workerd |
| Begge ændrer planlægningsdata (meta) | flettes automatisk, begge ændringer bevares | integration |
| Gendannelse af ældre backup | de gendannede data er "snavsede" og sendes betinget; ændret server → konflikt-banner | integration |
| Sletning på én enhed (fortrudt planændring) | tombstone; genopstår ikke fra en tredje enhed | integration |
| Samtidige kalenderændringer | register pr. dato, union | integration |
| Profilskift under synk | aktiv profil ignoreres; Ellens meta når aldrig Olivers nøgle (Worker afviser profil-mismatch med 422) | integration + browser-e2e |
| Ældre klient uden synk-hash | lokal version sikkerhedskopieres, serverens tages, besked noteres | integration |
| Ældre Worker (v1) | blobs synkes som før; meta markeres "ikke understøttet" (planlægningsdata deles ikke før Worker er opdateret); pre-GET-tjek beskytter mod de fleste overskrivninger (ikke race-frit) | integration |

## 4. Offline og status
Offline mærkes tydeligt ("Offline — ændringer gemmes her og sendes, når du er online igen"); status viser sidst synkroniseret, hvad der venter, seneste problem og sikkerhedskopier. Tilgængelig som tekst (ikke kun farve). Service workers cacher aldrig synk-kald (`/kv/…`, `/version`) — ellers kunne en gammel serverversion se frisk ud.

## 5. Worker-deployment (faktisk produktionstilstand)
Produktions-Worker'en (`oliver-training-sync`) var en **ældre version** end repoets: binding `KV` (ikke `TRAINING_KV`), nøgler gemt som `kv:<nøgle>`, ingen token-tjek. v2 understøtter begge opsætninger (`env.TRAINING_KV || env.KV`; præfiks kun for `KV`), så eksisterende data findes uændret. Den ældre kode ligger stadig som tidligere deployment i Cloudflare (rollback).
`SYNC_TOKEN` er sat som secret i produktion (verificeret: 401 uden/forkert token). Samme kode skal indtastes i løbe-appens Opsætning på hver enhed.

## 6. Testniveauer (hvad er IKKE en produktionstest)
| Niveau | Hvad | Hvor | Status |
|---|---|---|---|
| Enhed | klientlogik, meta-merge, migrering, backup | `tests/tp-core`, `tp-sync`, `tp-migration`, `tp-plan*`, `sw-sync` | grøn |
| Integration (Worker-KODE i Node, in-memory KV, flere "enheder") | Worker v1/v2-kildekode + klientmotor | `tests/tp-sync.test.js` (37) | grøn. **Ikke Cloudflares runtime** |
| Browser-e2e (Chromium) | rigtige sider mod Worker-kode med in-memory KV | `e2e/e2e.js` | se review |
| Lokal Worker-runtime | workerd via `wrangler dev --local` (lokal KV, binding `KV`) | `tests/worker-local.js` (9) | grøn. **Ikke en deployet Worker** |
| Deployet Worker (produktion) | smoke-test uden skrivning: `/version`, læsning af 4 poster, 400/422/409, CORS | udført manuelt via Chrome | ok. **Skrivning/to-enheds-konflikt er ikke testet mod produktion** (ville ændre rigtige data) |

## 7. Kendte begrænsninger
- KV har ingen atomisk compare-and-swap: to PUT'er i præcis samme millisekund kan race (vinduet er meget lille for én bruger med to enheder). Det betingede PUT fanger alle andre tilfælde.
- Samme-enhed multi-fane er ikke særskilt behandlet (hver fane har egen hukommelsestilstand; gendannelse genindlæser andre faner).
- Blob-konflikter kræver brugerens valg (bevidst).
- Planlagte løbstyper er skøn ud fra planens fase (se kalender-dokumentationen).

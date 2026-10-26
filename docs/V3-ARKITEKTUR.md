# Træningsplatform V3 — arkitektur, datamodeller og regler

Gælder: dashboard (`index.html`), SBD (`sbd/index.html`), Løb (`lob/index.html`). Vanilla HTML/CSS/JS, localStorage, GitHub Pages, valgfri Cloudflare-Worker-sync. Ingen build, ingen nye eksterne afhængigheder, ingen AI/backend.

## 1. Lag og filer
| Fil | Rolle | DOM? |
|---|---|---|
| `tp-core.js` (`window.TP`) | Delt dataadgang, validering, **versioneret additiv migrering**, stabile id'er, **samlet backup/gendannelse**, øvelsesbibliotek + substitutionsregler, evalueringsregler | nej (testes i Node) |
| `tp-ui.js` (`window.TPUI`) | Backup-panel (eksport, filtjek, gendannelsesplan, bekræftelse, fortryd), toast, fane-synk | ja |
| `tp-plan.js` (`window.TPPLAN`) | Kalenderoverlay, hybrid belastningsregler (R1–R7), omlægningsforslag, målprioritering (fokus) | nej |
| `tp-report.js` (`window.TPREPORT`) | Månedsrapport (regelbaseret), eksport (HTML/tekst) | nej |

Eksisterende funktioner genbruges: `slotForDate`/`getBlockedDates`/`toggleBlockedDate` (planlægning), `getLastPerformance`/`getExercises`/`MUSCLE_MAP` (styrke), `lobGoal`/`profile.goals`/`raceGoal` (mål), `sbdReadiness`, `weekStartOf`. Der er **ikke** bygget parallelle systemer for progression, restitution eller planlægning.

## 2. Datamodeller
Nye felter ligger i de **eksisterende synkede blobs** (Workerens `ALLOWED_KEYS` er uændret = ingen ny ekstern afhængighed). Planændringer, afviste forslag, fokus og rapporter ligger i lokale `tp_meta_*`-nøgler (med i backup, ikke synket).

**`sbd_state` / `sbd_partner`** (tilføjet, alt valgfrit): `tpv` (schema=3), `exerciseSubs{plannedName:{to,since}}`, `altOverrides{exId:[navn,navn]}`, `sessionEval{dayN:{effort 1–10, energy 1–5, vs easier|as|harder, pain[], comment≤500, ts}}`, `logs[dayN].sid` (stabilt id `sbd-<profil>-dayN-<ts>`), `logs[dayN].exercises[i].plannedName` + `.sub{scope,at}` (kun når øvelsen er skiftet).
**`lob_state` / `lob_partner`**: `tpv`, `runs[i].id` (stabilt; fandtes), `runs[i].eval` (samme form uden energi).
**`tp_meta_main` / `tp_meta_partner`** (lokal): `tpv`, `planChanges[{id,at,type: moveRun|easyRun|skipRun|swapRun|skipSbd,…}]`, `dismissed{nøgle:{at,action: rejected|ignored}}`, `goalPriority{focus: balanced|strength|hypertrophy|run, goalIds[], since}`, `reports{'YYYY-MM': snapshot}`, `lastRestore`.
**Øvrige nye lokale nøgler**: `tp_prerestore_snapshot` (fortryd), `tp_restore_epoch` (fane-synk), `tp_last_export`. `sync_token` eksporteres **aldrig**.

## 3. Migrering (`TP.migrateSbd/migrateLob/migrateMeta`)
Additiv og idempotent: kun manglende felter tilføjes, ukendte felter bevares, intet slettes. Kører ved indlæsning i hver app og ved gendannelse. Gamle profiler (uden felterne) fungerer uændret. Nye id'er er deterministiske, så gentagne migreringer giver samme resultat. Tests: `tests/tp-core.test.js` (bl.a. idempotens, profil-isolation, ingen skrivning ved `TP.load`).

## 4. Samlet backup og gendannelse
**Format (version 3):** `{format:3, app:'traening-platform', appVersion, exportedAt, scope: all|main|partner, meta:{schema, counts, checksum, bytes}, data:{sbd_state, sbd_partner, lob_state, lob_partner, tp_meta_*, dash:{blokerede/indhentningsdage, anker, profil…}}}`. Checksum = FNV-1a 32-bit over data (opdager afkortning/korruption — **ikke** kryptografisk).
**Gendannelse:** (1) parse + valider (afkortet JSON, forkert checksum, nyere format, analyse-eksport, korrupte blobs afvises *før* noget skrives); (2) **plan** vises: pr. datasæt add/replace/same/invalid + konflikter (færre pas/løb end nu, ældre seneste dato, ændret efter backup, sync-advarsel); (3) valg pr. datasæt + eksplicit bekræftelsesboks før "Gendan nu"; (4) staging i hukommelse → snapshot af nuværende data → skriv + **verificér** → ved fejl **rollback**; (5) "Fortryd gendannelse" fra snapshot; (6) andre åbne faner genindlæser (`tp_restore_epoch`). Gamle formater (SBD v1, løb v1, enkelt-løb) kan gendannes (kun egen del). Ellens fil rører aldrig Olivers data (profil-isolation testet).
**Begrænsning (localStorage har ingen transaktioner):** skrivning sker nøgle for nøgle. Sikkerheden er snapshot + verificering + rollback; ved strømsvigt *midt i* en gendannelse kan en delvis tilstand opstå, og snapshottet er så vejen tilbage. Quota-fejl opdages og rulles tilbage (testet). Snapshot fylder kortvarigt dobbelt plads.
**Sync-interaktion:** pull overskriver kun lokalt hvis serverens `updatedAt` > lokal `<nøgle>__updatedAt`. Gendannelse sætter lokal `__updatedAt = nu`, så en ældre serverkopi ikke vinder ved næste opstart (testet mod mock — **ikke** mod den rigtige Worker). Næste push sender de gendannede data.

## 5. Øvelsesskift (primær + A + B)
Bibliotek `TP.ALT_LIB` (~33 øvelser, 2 alternativer hvor det er fagligt forsvarligt; **Jefferson Curl og 1RM-forsøg har bevidst ingen**). Hvert alternativ har muskelgruppe, bevægelsesmønster, udstyr og kort begrundelse; kan overstyres pr. øvelse (`altOverrides`, max 2). **Kerneprincip:** `logEx.name` = den *faktisk udførte* øvelse, `logEx.plannedName` = den planlagte. Derfor er al historik/PR/1RM/volumen (som i forvejen slås op på navn) automatisk adskilt, uden at ændre de eksisterende læsere. Vægte overføres aldrig; alternativets forslag er dets *egen* seneste præstation (eller tomt). Hovedløftets progressionslæsere (`getLastWorkingKg`, `getProgressionSuggestion`, `getChartData`, `sbdProgress`, `getBlockBestE1RM`) bruger `primaryLogEx()`, som ignorerer pas hvor primæren er skiftet. 1RM auto-opdateres kun for de kendte hovedløftsnavne. Skift er kun muligt før første gennemførte sæt. Omfang: "kun dette pas" (standard) eller "dette og fremtidige pas" (kræver ekstra bekræftelse; ændrer ikke programmet, kun hvad der foreslås).

## 6. Evaluering efter træning
Styrke: dialog ved "Afslut træning" (valgfri, "Spring over", "Annuller" afslutter ikke). Løb: kort kort efter gem. Gemmes ved sessionen, vises i historik/løbeliste, med i backup. Bruges kun som kontekst: et mønster kræver ≥3 svar (`TP.evalPattern`); ét dårligt pas ændrer intet. Selvrapporteret — vises aldrig som måling, ingen diagnoser.

## 7. Samlet kalender (dashboard → "Samlet kalender")
Projektion = eksisterende rytme (`slotForDate`, samme cursor-logik som ugeplanen) + gennemførte pas + overlay fra `planChanges`. Ændringer: **flyt løb**, **gør løb roligt**, **spring løb over** (overlay, fortryd = fjern posten); **styrke "Kan ikke i dag"** bruger den *eksisterende* blokerede-dage-mekanisme (rækkefølgen/progressionen uændret) og logges. Styrke↔styrke-bytte tilbydes ikke: cyklussen er programstyret. Forhåndsvisning viser advarsler før→efter; intet ændres uden bekræftelse. "Markér som gennemført" sker *kun* i appen (link) for at undgå dobbeltregistrering. Ellens løbedage er faste (hendes krav) → flytning slået fra. `slotMapForRange` (O(n)) er bevist ækvivalent med `slotForDate` i e2e.

## 8. Hybrid belastning — regler (alle i `TPPLAN.RULES/TH`)
R1 tung benstyrke ±1 dag fra hårdt løb · R2 dødløft ±1 dag fra langt løb (≥1,4× snit og ≥8 km) · R3 ≥3 intensive dage i træk (R3b: ≥5 dage uden restitutionsdag, info) · R4 løbe-km >1,3× snit af op til 3 uger og ≥+4 km (R4b styrkesæt, info) · R5 uge uden restitutionsdag (**restitutionsdag = ingen styrke og intet hårdt løb; roligt løb tæller**, ellers ville Olivers rytme altid udløse advarsel) · R6 ≥5 træningsdage/7 + ≥3 selvvurderinger med gentaget mønster · R7 tung benstyrke ≤3 dage / hårdt løb ≤2 dage før et løbsmål. Gennemførte løb klassificeres hårde ved snitpuls ≥82 % af maxHR. Ellens styrke er tilbehør → tæller aldrig som "tung benstyrke". Hver advarsel har *hvorfor*, *hvis ignoreret*, *fakta* og (hvor muligt) op til 3 forslag, hvor hvert er simuleret (advarsler før→efter) og aldrig anvendes uden klik. Kan afvises ("ikke relevant") eller ignoreres; skjulte kan vises igen. Ingen samlet score. Ingen medicinske udsagn.

## 9. Målprioritering
`goalPriority.focus`: **Balanceret** (færrest advarsler, mindste ændring først), **Styrke først** og **Hypertrofi** (styrkepas foreslås aldrig rykket; løb flyttes/lettes), **Løbepræstation** (hårde løb ≤14 dage før løb/tilknyttet måldato gøres aldrig rolige; styrkepas rykkes først; R7 øverst). Eksisterende mål (løbemål, VDOT, løbsmål, styrkemål) kan knyttes; løbsdatoer udvider "tæt på"-beskyttelsen, styrkemål vises som kontekst. Fokus er pr. profil, **omskriver aldrig programmer**, og forklares i UI.

## 10. Månedsrapport
Regelbaseret (RP1–RP5, RN1–RN7, se `TPREPORT.RULES`), **ingen AI** — det er mærket i UI/eksport. Hvert udsagn har "Grundlag" (tal). Afsluttede måneder gemmes som snapshot (genberegn-knap); løbende måned er foreløbig og udløser ikke fald-/planregler. Planlagt vs. gennemført beregnes kun hvis rytmens anker ligger før månedens start. Eksport: HTML, tekst, print/PDF (iframe) — ingen backend. Snapshots er med i backup. PR/e2RM beregnes på øvelsesnavn → substitutioner blandes ikke ind.

## 11. Testmatrix
Node: `node tests/run-all.js` (8 filer). E2E (Playwright/Chromium, syntetiske data, mock-Worker): se `testresultater-e2e.txt`. axe (WCAG 2.x A/AA) over alle skærme og nye tilstande ved 390 og 1366 px. Regression af eksisterende funktioner (progression, deload, RPE, historik, løbeplan/registrering, profilskift, pausetimer, genstart) kører i samme suite.

## 12. Kendte begrænsninger / ikke verificeret
- Skærmlæser ikke testet (kun axe + tastatur + kodeinspektion). Ingen fysisk iOS/Android. Kun Chromium (ikke Firefox/WebKit).
- **Sync mod den rigtige Worker er ikke testet** — kun mod mock. Backup/gendannelse+sync-sikkerhed er logisk afledt og mock-testet.
- Gendannelse er ikke atomisk (localStorage); se pkt. 4.
- Hybridreglerne er vejledende heuristikker, ikke en fysiologisk model. Tærskler er valgt konservativt og kan justeres i `TPPLAN.TH`.
- Planlagte *lange* løb er ikke kendt i rytmen (kun let/kvalitet), så R2 udløses kun for gennemførte lange løb.
- Planændringer, afviste forslag, fokus og rapporter er lokale pr. enhed (synkes ikke — ville kræve en Worker-ændring).
- `wrangler.toml` og `sync-worker/.wrangler/…` er sporet i git i repoet (ikke i review-pakken) — bør ud af versionsstyring.

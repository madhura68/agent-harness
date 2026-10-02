---
title: "Agent-harness M7 — Qwen 3.8 voor een 96 GB-machine op echt werk (task-bench)"
status: draft
last_updated: 2026-10-02
revision: 1
---

# Agent-harness M7 — Qwen 3.8 voor een 96 GB-machine op echt werk (task-bench)

Vervolg op [M5](2026-09-30-model-comparison-refiner-design.md) en [M6](2026-10-01-local-precision-refiner-design.md), voor IDEA-229. Brainstorm met JP op 2026-10-02: alle vier de ontwerpsecties zijn goedgekeurd, en JP vroeg om deze spec ("schrijf de spec en start de reviewloop").

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "ik zou graag de Qwen 3.8 op een 96Gb machine willen testen, via een openrouter model en dan met taken die echt werk representeren". Daarachter ligt IDEA-229: "voordat ik een Mac Mini of Mac studio koop wil ik kijken wat de modellen kunnen die daarop kunnen draaien. (…) maar alleen als er een echte meerwaarde is."

**Vraag van M7.** Kan Qwen 3.8, zoals hij op een machine van 96 GB zou draaien, ons echte werk aan? En kan hij meer dan wat max2 nu al lokaal doet?
- Van Qwen 3.8 staan op OpenRouter twee modellen met open gewichten: `qwen/qwen3.8-27b` (dense) en `qwen/qwen3.8-2.4t-a95b`. Het tweede past niet op 96 GB. Flash, Max en Omni zijn alleen via de API te gebruiken.
- "Qwen 3.8 op 96 GB" is dus de 27B op volle precisie: BF16 is ongeveer 55 GB, plus cache. Dat past niet in 64 GB, wel ruim in 96 GB.
- Het gehoste `qwen/qwen3.8-27b` staat in M7 voor die machine. Gehost is een bovengrens: in M6 kwam het gehoste model door de zeef, en dezelfde 27B lokaal op Q8 zakte (§6).

**Echt werk** betekent hier: Scrum4Me-taken uitvoeren zoals de productieworker dat doet (`TASK_IMPLEMENTATION`, het M3-pad). Het model schrijft code in een repo, tot de verify-gate van die repo groen is.

**Eerst bruikbare resultaat:** 12 oude, afgeronde taken: 6 uit agent-harness en 6 uit scrum4me-mcp.
- Elke taak gaat door `harness task-bench` (§4.1), één keer met `qwen/qwen3.8-27b` via OpenRouter en één keer met `gsq-lokaal` (`qwen3.8-gsq-rco:27b-iq3_s-text`) op max2.
- Een run is **geslaagd** als twee dingen kloppen: de verify-gate van de repo is aan het eind groen, en de verborgen tests uit de echte oplossing slagen (§4.2).

**Eerste praktijkproef:** één taak met het gehoste model, helemaal door de bench, in increment 1 (§4.7). Die meet de echte kosten en tijd per taak, en bewijst dat de toets met de verborgen tests werkt, voordat de rest draait.

**Beslisregel.** Een model kan het werk aan bij minstens 9 van de 12 taken geslaagd.

| Gehost (van 12) | gsq (van 12) | Oordeel | Betekenis voor de aankoop |
|---|---|---|---|
| 8 of minder | – | gezakt | Ook de 96 GB-klasse kan ons werk niet aan. Geen Mac voor dit doel. |
| 9 of meer | 9 of meer | max2 volstaat | max2 kan het al. Geen meerwaarde. |
| 9 of meer | 8 of minder, minstens 3 minder dan gehost | meerwaarde | Kandidaat: de 27B in BF16 op een Mac van 96 GB. Eerst een proef op echte hardware, want gehost ≠ lokaal. |
| 9 of meer | 8 of minder, hooguit 2 minder dan gehost | onbeslist | Het verschil is te klein voor een besluit. |

**Grens.** Een oordeel is ook onbeslist als het steunt op een telling op de grens of één eronder:
- gehost precies 9 of 8;
- gsq precies 9 of 8, als die telling het oordeel bepaalt (rij 2 en 3);
- een verschil van precies 3.

Bij onbeslist kiest JP: meer taken toevoegen, of stoppen. Stoppen betekent: geen meerwaarde aangetoond.

**Niet-doelen:**
- **Snelheid of geheugen op een Mac.** De tijd per taak staat alleen ter informatie in het rapport.
- **De Scrum4Me-webrepo.** Daar ontbreekt nog een bewezen verify-recept (M3 §10).
- **Andere werksoorten:** idee-chat, reviews, specs en plannen schrijven.
- **Live taken:** geen jobs in Scrum4Me, geen pushes, geen statuswijzigingen.
- **Andere modellen** dan de twee hierboven.
- **De productieworker wijzigen:** geen ander model, geen andere config, geen wijziging aan `runTaskJob`.

**Zichtbaar bewijs:** `llm-bench/results/task-bench-<datum>.md` in de max2-repo, met de takenset, de runs per model en het oordeel.

## 2. Besluiten

Alle besluiten zijn van JP, uit de brainstorm van 2026-10-02.

| # | Vraag | Besluit |
|---|---|---|
| 1 | Welk werk | Taken uitvoeren (`TASK_IMPLEMENTATION`). Idee-chat, reviews en specs vallen erbuiten. |
| 2 | Welke taken | Oude, afgeronde taken opnieuw uitvoeren vanaf hun begincommit, met de echte oplossing als referentie. Geen nieuwe sprinttaken. |
| 3 | Welke modellen | `qwen/qwen3.8-27b` via OpenRouter en `gsq-lokaal` op max2. |
| 4 | Welke repo's | agent-harness en scrum4me-mcp: daarvoor bestaat het verify-recept al. |
| 5 | Budget | Binnen de resterende $19,08 van de OpenRouter-sleutel. De driver stopt bij $15 en vraagt JP. Eén run per taak. |
| 6 | Aanpak | A: een benchmode in de harness (`harness task-bench`), met dezelfde lus als de worker. B (live worker) en C (`harness run`) zijn afgewezen. |
| 7 | Beslisregel | Zie §1: drempel 9 van 12, een verschil van minstens 3, grensgevallen onbeslist. |
| 8 | Privacy | Code uit agent-harness en scrum4me-mcp mag naar de aanbieders van OpenRouter, met `data_collection: deny`, zoals in M5. |
| 9 | Omvang | 12 taken, 6 per repo, door JP goedgekeurd vóór de eerste modelrun. |

## 3. Uitgangssituatie

- **De worker (M3)** voert `TASK_IMPLEMENTATION`-jobs uit met `runTaskJob` (`src/worker/task-impl.ts`):
  - systeemprompt `TASK_SYSTEM_PROMPT` en taakprompt `renderTaskPrompt(payload)`;
  - tools `list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run_tests` (`createTaskTools`, `src/worker/task-tools.ts`), plus de doc-tools uit `allow`;
  - prepare en verify in wegwerpcontainers (`runInContainer`, `src/worker/containers.ts`);
  - de modellus `runManifest` (`src/run.ts`), met de gate als `afterAnswer`: elk eindantwoord draait `recipe.verify`, en na `maxVerifyRepairs` rode gates faalt de run.
- **De taakconfig op max2** (`/etc/agent-harness/worker.json`, blok `task`):
  - limieten `maxTurns 40`, `maxOutputTokens 80000`, `maxWallSeconds 2400`, `maxToolErrors 8`, `contextTokens 65536`;
  - image `node:24-bookworm`, uid/gid 1000, npm-cache `/var/lib/agent-harness/npm-cache`;
  - `maxVerifyRepairs` niet gezet, dus de standaard 3.
  - Het model is `qwen3.8-gsq-rco:27b-iq3_s-text` op `http://127.0.0.1:11434/v1`, zonder extra instellingen (thinking aan).
- **De recepten:**
  - agent-harness: prepare `npm ci`, verify `npm run verify` (lint, typecheck, `vitest run`);
  - scrum4me-mcp: prepare `npm ci` en `npm run prisma:generate`, verify typecheck, `typecheck:tests` en `vitest run` met zeven uitsluitingen. Die tests falen alleen in een worktree, omdat de gitdir buiten de containermount staat (`docs/runbooks/task-worker.md`).
  - Beide repo's testen met vitest, dus een losse testset draait met `npx vitest run <bestanden>`.
- **Containers opruimen:** `killLeftoverContainers` verwijdert bij elke taakjob alle containers met een naam op `^harness-`. Bench en worker kunnen dus niet tegelijk draaien.
- **Docker op max2:** `janpeter` (uid 1000) zit in de docker-groep, en `node:24-bookworm` staat er al.
- **De harness telt kosten:** `runManifest` telt `usage.cost` op tot `costUsd` per run. Er is geen kostengrens in de lus.
- **Uit M5 en M6:** het gehoste `qwen/qwen3.8-27b` kwam in M5 door de zeef van de promptverfijner, met en zonder docs. gsq kwam alleen zonder docs door. De lokale Q8 zakte in M6 met docs (12/15 afgerond).
- **OpenRouter:** `qwen/qwen3.8-27b` kost $0,42 per miljoen invoertokens en $3 per miljoen uitvoertokens. De sleutel heeft een limiet van $20, waarvan $0,92 gebruikt is.
- **Kandidaten:** sinds 2026-08-01 raken 40 commits op main in agent-harness en 71 in scrum4me-mcp zowel `src/` als tests, zonder wijziging aan `package.json`, de lockfile of Prisma, en met 20–400 gewijzigde regels.
- **De M3-spike** haalde 7 van 9 kleine taken met gsq (M3 §10).

## 4. Opzet

### 4.1 `harness task-bench`

Een nieuw subcommando in agent-harness: `harness task-bench --case <json> --model-config <json> --task-config <json> --out <map>`.

- **Samenstelling.** Het gebruikt de bestaande, geëxporteerde onderdelen:
  - `TASK_SYSTEM_PROMPT` zonder de zin over de doc-tools (zie onder);
  - `renderTaskPrompt`;
  - `createTaskTools`;
  - `runInContainer` met het recept van de repo;
  - `runManifest` met profiel `tools`.
  - De gate is gelijk aan die in `runTaskJob`: `afterAnswer` draait `recipe.verify`, met `maxVerifyRepairs` pogingen. Die gate-logica (ongeveer 20 regels) staat in de bench opnieuw.
  - `runTaskJob` en de rest van het workerpad veranderen niet.
- **De taakconfig** is een kopie van het `task`-blok uit `worker.json`: limieten, image, uid/gid, npm-cache, `maxVerifyRepairs` en recepten. Zo meet de bench met precies de grenzen van productie.
- **Verloop per run:**
  1. Een wegwerpclone van de repo op `base_commit`, in een map binnen `--out` (vers, buiten elke workercache).
  2. Prepare in een container.
  3. De modellus met de gate.
  4. Na het einde van de lus, buiten het zicht van het model, gaan de verborgen tests uit `ref_commit` de clone in: elk bestand uit `hidden_tests` overschrijft wat er staat. Daarna draait `hidden_test_command` in de verify-container.
  5. Een resultaat-JSON en de trace in `--out`, en de diff van de clone tegen `base_commit` als patch, vóór het plaatsen van de verborgen tests.
- **Containernamen** beginnen met `harness-bench-`. Ze vallen dus ook onder het opruimfilter van de worker; daarom draait de bench alleen in een venster (§4.5).
- **Uitkomst per run** (`status` in de resultaat-JSON):
  - `geslaagd`: de laatste gate is groen en de verborgen tests zijn groen;
  - `verborgen_tests_rood`: de gate is groen, de verborgen tests niet;
  - `verify_rood`: na `maxVerifyRepairs` rode gates;
  - `limiet`: `maxTurns`, `maxOutputTokens`, `maxWallSeconds` of `maxToolErrors` bereikt;
  - `geen_wijzigingen`: de clone is ongewijzigd;
  - `benchfout`: clone, prepare of container faalde buiten het model om. Een benchfout telt niet als modelfout; die run draait opnieuw.
- **De resultaat-JSON** bevat verder:
  - de case-id, het model, de status;
  - modelbeurten, toolaanroepen en toolfouten;
  - tokens in en uit, `costUsd` en de wandtijd;
  - de staart van de laatste gate-uitvoer en van de uitvoer van de verborgen tests.
- **Bewuste verschillen met productie:**
  - de basis is `base_commit`, niet de default-branch;
  - geen MCP-job, geen claim, geen commit of push, geen status- of logaanroepen;
  - **geen doc-tools.** De docs-store van nu kan de oplossing van een oude taak al bevatten. De docs in de repo zelf blijven leesbaar via `read_file`.
  - **geen `verify_task_against_plan`.** De verborgen tests nemen die toets over.

### 4.2 De takenset

- **Bron:** afgeronde Scrum4Me-taken (DONE). Uit product Agent-harness voor de repo agent-harness, en uit product Scrum4Me voor de repo scrum4me-mcp. Per taak gaan in de case:
  - de taaktekst zoals de worker hem krijgt: titel, beschrijving, implementatieplan, en titel en acceptatiecriteria van de story;
  - de commit waarmee de taak op main kwam (`ref_commit`).
- **Criteria per taak:**
  1. `ref_commit` staat op main. `base_commit` is zijn eerste ouder.
  2. Op `base_commit` zijn prepare en verify van het recept groen.
  3. De verborgen tests zijn de testbestanden die `ref_commit` toevoegt of wijzigt. Met `hidden_test_command` falen ze op `base_commit` en slagen ze op `ref_commit`, in de verify-container.
  4. De verborgen tests toetsen alleen wat de taaktekst vastlegt (namen, signaturen, gedrag), niet toevallige details van de oplossing van toen.
  5. Het implementatieplan bevat niet de volledige implementatie. Anders meet de taak overtikken.
  6. Geen schemamigratie, geen nieuwe dependency, geen webrepo.
  7. Een mix: 6 per repo, features en fixes, en qua omvang van `ref_commit` 4 klein (20–80 regels), 4 middel (81–200) en 4 groot (201–400).
- **Selectie:** Claude stelt de 12 voor. Per taak staan in het voorstel: repo, taakcode, `ref_commit`, omvang, soort, de verborgen tests, en het bewijs voor criterium 2 en 3. JP keurt de lijst goed vóór de eerste modelrun van increment 3. Daarna ligt de set vast in `cases.jsonl` en verandert hij niet meer.
- **De taak van de praktijkproef** (increment 1) voldoet aan dezelfde criteria en mag een van de 12 worden.

### 4.3 Modellen en instellingen

- `gsq-lokaal`: `qwen3.8-gsq-rco:27b-iq3_s-text` op `http://127.0.0.1:11434/v1`, zonder extra instellingen, zoals de productieworker.
- `qwen3.8-openrouter`: `qwen/qwen3.8-27b` op `https://openrouter.ai/api/v1`, met `provider: {data_collection: "deny", require_parameters: true}` en `reasoning: {effort: "medium"}`, zoals de docs-variant in M5. Temperatuur en seed blijven op de standaard, net als bij de worker.
- Beide krijgen de limieten uit §3. Eén run per taak. Gehost is niet herhaalbaar, dus één run is een steekproef; dat noemt het rapport.

### 4.4 Driver en scorer (llm-bench, repo max2)

- Een map `llm-bench/task_bench/` met:
  - `cases.jsonl` (§4.2);
  - `models.json` met de twee labels (§4.3);
  - een run-script dat `harness task-bench` per taak en model aanroept;
  - een scorer.
- **Het run-script:**
  - draait de taken na elkaar;
  - slaat over wat al een geldige resultaat-JSON heeft;
  - telt `costUsd` op en stopt vóór de volgende run als het totaal $15 bereikt.
- **De scorer** maakt de tabel per taak en model, de tellingen, en het oordeel volgens §1, met de grensgevallen.
- Tests met de standaardbibliotheek (`unittest`), zoals de rest van llm-bench. `check_key.py` uit M5 controleert de uitvoer.

### 4.5 Vensters en veiligheid op max2

- **Waar:** alles draait op max2, uit een eigen worktree van agent-harness met een eigen build (`~/Development/agent-harness-m7`). De checkout van de worker (`~/Development/agent-harness`) blijft onaangeroerd. De uitvoer gaat naar `~/m7-runs/`, buiten elke repo.
- **Vensters:** elk venster alleen op JP's go, binnen de tijd die JP noemt, volgens de Vensterprocedure van M6 (`docs/plans/M6-local-precision-refiner.md`):
  - de dienststand vooraf;
  - de M4-stop (fail-closed);
  - de containers stoppen die volgens de dienststand draaien;
  - starten in tmux met het sessie-ID;
  - na afloop herstellen en de dienststand na vastleggen.
  - Bij een nachtvenster een vangnet dat vlak voor het einde afbreekt en herstelt, zoals in M6.
- **De OpenRouter-sleutel** staat op de Mac in `~/.zshenv`. Voor een gehost venster gaat hij via stdin naar een bestand met modus 0600 op een tmpfs op max2 (`/run/user/1000/`). Daar leest het run-script hem in. Hij staat nooit in argv, in een log of in een repo. Na het venster verdwijnt het bestand.
- **De Ollama-config, de productieconfig en het model van de worker** blijven ongewijzigd.

### 4.6 Budget

- De limieten begrenzen een run: hooguit 40 beurten van 65.536 tokens invoer en 80.000 tokens uitvoer. Dat is hooguit ongeveer $1,10 + $0,24 = $1,34 per run met `qwen/qwen3.8-27b`. Een eigen kostengrens per run is daarom niet nodig.
- Het run-script stopt bij $15 in totaal (§4.4). De limiet van de sleutel ($20) is de harde grens.
- Kost de praktijkproef meer dan $1,25, dan stopt M7 voor JP's besluit. 12 runs passen dan niet meer veilig binnen $15.

### 4.7 Volgorde

1. **Increment 1: bench plus praktijkproef.**
   - `harness task-bench` met unittests: een nepmodel en neppe containers, en een gate-test gelijk aan die van de worker.
   - De PR in agent-harness; JP merget.
   - Op max2 de worktree `~/Development/agent-harness-m7` met `npm ci` en een build.
   - Eén taak met de hand gekozen en gecontroleerd volgens §4.2.
   - Op JP's go een venster van ongeveer een uur: die taak met `qwen3.8-openrouter`.
2. **Increment 2: takenset en driver.** De selectie van 12 taken, met bewijs. JP keurt goed, en de set wordt bevroren. Driver en scorer met tests, als PR in max2.
3. **Increment 3:** op JP's go `qwen3.8-openrouter` op alle 12 taken, in een venster van ongeveer 3 uur.
4. **Increment 4:** op JP's go `gsq-lokaal` op alle 12 taken, in een nachtvenster (tot 40 minuten per taak).
5. **Increment 5:** het rapport en het oordeel, in een PR in max2.

### 4.8 Het rapport

`llm-bench/results/task-bench-<datum>.md` met:
- de takenset: per taak repo, taakcode, `ref_commit`, omvang, soort en de verborgen tests;
- per taak de uitkomst van beide modellen, met de reden van elk falen en bij `verborgen_tests_rood` de falende tests;
- de tellingen, het oordeel en de betekenis volgens §1, met de grensgevallen;
- kosten per run en in totaal, tijd per run, modelbeurten en toolfouten;
- de verschillen met productie (§4.1) en de kanttekeningen (§6);
- per venster de dienststand vooraf en achteraf, en elke afgebroken run met de reden;
- de commits: de bench in agent-harness, de driver in max2, de worker-checkout, en `ollama --version`.

## 5. Acceptatiecriteria

1. `harness task-bench` volgt de lus van de worker. Systeemprompt (zonder de doc-tools-zin), taakprompt, tools, recept, gate met `maxVerifyRepairs` en limieten zijn gelijk aan `runTaskJob` met de taakconfig van max2. Dat blijkt uit unittests en uit de trace van de praktijkproef.
2. De praktijkproef draaide één taak met `qwen3.8-openrouter` door de bench. Er is een resultaat-JSON, met kosten en tijd, en de verborgen tests liepen als toets.
3. De takenset telt 12 taken (6 per repo). Elke taak heeft het bewijs voor de criteria 2 en 3 uit §4.2. JP keurde de lijst goed vóór increment 3.
4. Beide modellen draaiden alle 12 taken geldig. Elke `benchfout` draaide opnieuw.
5. Het rapport bevat wat §4.8 noemt, en geeft het oordeel volgens §1. De totale kosten bleven binnen het budget van §4.6.
6. Na elk venster draaiden op max2 precies de diensten van vooraf. De worker-checkout en de workerconfig zijn ongewijzigd. De sleutel staat nergens in argv, logs of repo's, en `check_key.py` vindt nul treffers in de uitvoer en de resultaten.
7. `npm run verify` in agent-harness en de unittests van llm-bench zijn groen.

## 6. Risico's en open punten

- **Kleine aantallen.** Bij 12 taken scheelt één taak 8 procentpunt. Daarom de grens: een uitslag vlak bij een drempel is onbeslist, geen bewijs. Meer taken is dan JP's keuze.
- **Gehost ≠ lokaal.** In M6 kwam gehost door en zakte de lokale Q8. Een positief oordeel is een kandidaat voor een proef op echte hardware, geen koopadvies.
- **Gehost is niet herhaalbaar.** Eén run per taak is een steekproef; een tweede run past niet in het budget.
- **Verborgen tests kunnen te streng zijn,** als ze toevallige details van de oude oplossing toetsen. Criterium 4 in §4.2 beperkt dat. Het rapport toont bij elk `verborgen_tests_rood` de falende tests, zodat JP het kan beoordelen.
- **Lekken.** De commits zijn van augustus tot oktober 2026 en staan in privérepo's, dus de kans dat ze in de training van Qwen 3.8 zaten is klein. De docs-store van nu valt weg (§4.1).
- **Geen doc-tools** maakt de bench iets strenger dan productie, voor beide modellen gelijk.
- **Kosten.** De bovengrens is ongeveer $1,34 per run (§4.6). De praktijkproef meet de echte kosten vóór de rest.
- **Doorlooptijd.** gsq kan tot 40 minuten per taak nemen, dus 12 taken tot 8 uur. De worker ligt in elk venster stil.
- **Bench in een eigen worktree** op max2. De kans dat een build daar de productieworker raakt is daarmee weg. De containers delen wel de npm-cache van de worker; in een venster draait de worker niet.

## Review record

_Nog geen rondes._

---
title: "Agent-harness M7 — Qwen 3.8 voor een 96 GB-machine op echt werk (task-bench)"
status: draft
last_updated: 2026-10-02
revision: 4
---

# Agent-harness M7 — Qwen 3.8 voor een 96 GB-machine op echt werk (task-bench)

Vervolg op [M5](2026-09-30-model-comparison-refiner-design.md) en [M6](2026-10-01-local-precision-refiner-design.md), voor IDEA-229. Brainstorm met JP op 2026-10-02: alle vier de ontwerpsecties zijn goedgekeurd, en JP vroeg om deze spec ("schrijf de spec en start de reviewloop").

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "ik zou graag de Qwen 3.8 op een 96Gb machine willen testen, via een openrouter model en dan met taken die echt werk representeren". Daarachter ligt IDEA-229: "voordat ik een Mac Mini of Mac studio koop wil ik kijken wat de modellen kunnen die daarop kunnen draaien. (…) maar alleen als er een echte meerwaarde is."

**Vraag van M7.** Kan Qwen 3.8, zoals hij op een machine van 96 GB zou draaien, ons echte werk aan? En kan hij meer dan wat max2 nu al lokaal doet?
- Van Qwen 3.8 staan op OpenRouter twee modellen met open gewichten: `qwen/qwen3.8-27b` (dense) en `qwen/qwen3.8-2.4t-a95b`. Het tweede past niet op 96 GB. Flash, Max en Omni zijn alleen via de API te gebruiken.
- "Qwen 3.8 op 96 GB" is dus de 27B op volle precisie: BF16 is ongeveer 55 GB, plus cache. Dat past niet in 64 GB, wel ruim in 96 GB.
- Het gehoste `qwen/qwen3.8-27b` staat in M7 voor die machine. Het draait via een route op 16-bit (BF16 of FP16), zodat de precisie gelijk is aan wat die machine zou draaien (§4.3).
- Gehost blijft een bovengrens. In M5 kwam het gehoste model door de zeef van de promptverfijner, toen nog bij aanbieders met een onbekende precisie. In M6 zakte dezelfde 27B lokaal op Q8 (§6).

**Echt werk** betekent hier: Scrum4Me-taken uitvoeren zoals de productieworker dat doet (`TASK_IMPLEMENTATION`, het M3-pad). Het model schrijft code in een repo, tot de verify-gate van die repo groen is.

**Eerst bruikbare resultaat:** 12 oude, afgeronde taken: 6 uit agent-harness en 6 uit scrum4me-mcp.
- Elke taak gaat door `harness task-bench` (§4.1), één keer met `qwen/qwen3.8-27b` via OpenRouter en één keer met `gsq-lokaal` (`qwen3.8-gsq-rco:27b-iq3_s-text`) op max2.
- Een run is **geslaagd** als twee dingen kloppen: de verify-gate van de repo is aan het eind groen, en de verborgen tests uit de echte oplossing slagen (§4.1, §4.2).

**Eerste praktijkproef:** één taak met het gehoste model, helemaal door de bench, in increment 1 (§4.7). Die meet de echte kosten en tijd per taak, en bewijst dat de toets met de verborgen tests werkt, voordat de rest draait.

**Beslisregel.** Een model kan het werk aan bij minstens 9 van de 12 taken geslaagd.

| Gehost (van 12) | gsq (van 12) | Oordeel | Betekenis voor de aankoop |
|---|---|---|---|
| 8 of minder | – | gezakt | Geen meerwaarde aangetoond: ook de 96 GB-klasse haalt de drempel niet. Haalt gsq 9 of meer, dan volstaat max2. Geen Mac voor dit doel. |
| 9 of meer | 9 of meer | max2 volstaat | max2 kan het al. Geen meerwaarde. |
| 9 of meer | 8 of minder, minstens 3 minder dan gehost | meerwaarde | Kandidaat: de 27B in BF16 op een Mac van 96 GB. Eerst een proef op echte hardware, want gehost ≠ lokaal. |
| 9 of meer | 8 of minder, hooguit 2 minder dan gehost | onbeslist | Het verschil is te klein voor een besluit. |

**Grens.** Een oordeel is ook onbeslist als het steunt op een telling op de grens of één eronder:
- gehost precies 9 of 8;
- gsq precies 9 of 8, als die telling het oordeel bepaalt (rij 2 en 3);
- een verschil van precies 3, alleen in rij 3, waar het verschil het oordeel bepaalt.

Bij onbeslist kiest JP: meer taken toevoegen, of stoppen. Stoppen betekent: geen meerwaarde aangetoond.

**Niet-doelen:**
- **Snelheid of geheugen op een Mac.** De tijd per taak staat alleen ter informatie in het rapport.
- **De Scrum4Me-webrepo.** Daar ontbreekt nog een bewezen verify-recept (M3 §10).
- **Andere werksoorten:** idee-chat, reviews, specs en plannen schrijven.
- **Live taken:** geen jobs in Scrum4Me, geen pushes, geen statuswijzigingen.
- **Andere modellen** dan de twee hierboven.
- **De productieworker wijzigen:** geen ander model, geen andere config, geen gedragswijziging aan `runTaskJob`. In `task-impl.ts` komen alleen twee exports en een optie in `renderTaskPrompt` waarvan de standaard het huidige gedrag is (§4.1).

**Zichtbaar bewijs:** `llm-bench/results/task-bench-<datum>.md` in de max2-repo, met de takenset, de runs per model en het oordeel.

## 2. Besluiten

Alle besluiten zijn van JP, uit de brainstorm van 2026-10-02.

| # | Vraag | Besluit |
|---|---|---|
| 1 | Welk werk | Taken uitvoeren (`TASK_IMPLEMENTATION`). Idee-chat, reviews en specs vallen erbuiten. |
| 2 | Welke taken | Oude, afgeronde taken opnieuw uitvoeren vanaf hun begincommit, met de echte oplossing als referentie. Geen nieuwe sprinttaken. |
| 3 | Welke modellen | `qwen/qwen3.8-27b` via OpenRouter en `gsq-lokaal` op max2. |
| 4 | Welke repo's | agent-harness en scrum4me-mcp: daarvoor bestaat het verify-recept al. |
| 5 | Budget | Binnen de resterende $19,08 van de OpenRouter-sleutel. De driver stopt en vraagt JP (§4.6). Eén run per taak. |
| 6 | Aanpak | A: een benchmode in de harness (`harness task-bench`), met dezelfde lus als de worker. B (live worker) en C (`harness run`) zijn afgewezen. |
| 7 | Beslisregel | Zie §1: drempel 9 van 12, een verschil van minstens 3, grensgevallen onbeslist. |
| 8 | Privacy | Code uit agent-harness en scrum4me-mcp mag naar de aanbieders van OpenRouter, met `data_collection: deny`, zoals in M5. |
| 9 | Omvang | 12 taken, 6 per repo, door JP goedgekeurd vóór de eerste modelrun. |

## 3. Uitgangssituatie

- **De worker (M3)** voert `TASK_IMPLEMENTATION`-jobs uit met `runTaskJob` (`src/worker/task-impl.ts`):
  - systeemprompt `TASK_SYSTEM_PROMPT` en taakprompt `renderTaskPrompt(payload)`;
    - `TASK_SYSTEM_PROMPT` noemt in zijn eerste zin de doc-tools;
    - `renderTaskPrompt` zet altijd een blok `## Product` neer met de opdracht om `search_product_docs` en `list_product_docs` te gebruiken (`task-impl.ts:59`);
  - tools `list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run_tests` (`createTaskTools`, `src/worker/task-tools.ts`), plus de doc-tools uit `allow`. Een onbekende tool geeft `UNKNOWN_TOOL` en telt als toolfout (`src/tools/policy.ts:30`);
  - prepare en verify in wegwerpcontainers (`runInContainer`, `src/worker/containers.ts`);
  - de modellus `runManifest` (`src/run.ts`), met de gate als `afterAnswer`: elk eindantwoord draait `recipe.verify`, en na `maxVerifyRepairs` rode gates faalt de run. Wat groen is en welke tekst het model bij rood ziet, bepalen `isGreen` en `verifyText`; die zijn module-privé (`task-impl.ts:124-131`). De gate houdt lopende containers bij en stopt als een container niet aantoonbaar is opgeruimd.
- **Hoe `runManifest` eindigt:** `completed`, `budget_exceeded`, `timed_out`, of `failed` met een code. De codes zijn onder andere:
  - `TOO_MANY_TOOL_ERRORS`;
  - de code van de gate;
  - `MODEL_ERROR`: een netwerk- of HTTP-fout, zonder herhaling;
  - `HARNESS_ERROR`: onder andere een externe stop;
  - `TOOL_NOT_AVAILABLE`.
- **De taakconfig op max2** (`/etc/agent-harness/worker.json`, blok `task`):
  - limieten `maxTurns 40`, `maxOutputTokens 80000`, `maxWallSeconds 2400`, `maxToolErrors 8`, `contextTokens 65536`;
  - image `node:24-bookworm`, uid/gid 1000, npm-cache `/var/lib/agent-harness/npm-cache`;
  - `maxVerifyRepairs` niet gezet, dus de standaard 3.
  - Het model is `qwen3.8-gsq-rco:27b-iq3_s-text` op `http://127.0.0.1:11434/v1`, zonder extra instellingen (thinking aan).
- **De recepten:**
  - agent-harness: prepare `npm ci`, verify `npm run verify` (lint, typecheck, `vitest run`);
  - scrum4me-mcp: prepare `npm ci` en `npm run prisma:generate`, verify typecheck, `typecheck:tests` en `vitest run` met zeven uitsluitingen. Die tests falen alleen in een worktree, omdat de gitdir buiten de containermount staat (`docs/runbooks/task-worker.md`).
- **De tests:**
  - Beide repo's testen met vitest, met `include: ['__tests__/**/*.test.ts']`. Een losse testset draait dus met `npx vitest run <bestanden>`.
  - Hulpbestanden staan ook onder `__tests__/` (bijvoorbeeld `fakes/`, `fixtures/`, `helpers.ts`).
  - scrum4me-mcp heeft een submodule, `vendor/scrum4me-shared`.
- **Containers opruimen:** de namen zijn `harness-<eerste 8 tekens van het id>-<soort>-<n>` (`containerName`). `killLeftoverContainers` verwijdert bij elke taakjob alle containers met een naam op `^harness-`. Bench en worker kunnen dus niet tegelijk draaien.
- **Docker op max2:** `janpeter` (uid 1000) zit in de docker-groep, en `node:24-bookworm` staat er al.
- **De harness telt kosten:** `runManifest` telt `usage.cost` op tot `costUsd` per run. Er is geen kostengrens in de lus.
- **Uit M5 en M6:** het gehoste `qwen/qwen3.8-27b` kwam in M5 door de zeef van de promptverfijner, met en zonder docs. gsq kwam alleen zonder docs door. De lokale Q8 zakte in M6 met docs (12/15 afgerond); de missers liepen vast op de docs-tools.
- **OpenRouter:** `qwen/qwen3.8-27b` staat in de modellijst op $0,42 per miljoen invoertokens en $3 per miljoen uitvoertokens. Prijs en precisie hangen af van de aanbieder. Volgens de publieke endpointlijst van 2026-10-02:
  - de meeste aanbieders draaien FP8, FP4 of een onbekende precisie;
  - op 16-bit staan er twee: DeepInfra (BF16, $0,15 in en $1,88 uit per miljoen tokens, met tools en reasoning) en Cerebras (FP16, zonder tools);
  - in M5 liep het gehoste model via Reka en Wafer, allebei met een onbekende precisie.
  - De sleutel heeft een limiet van $20, waarvan $0,92 gebruikt is.
- **Kandidaten** (grof filter, telling van 2026-10-02): op `origin/main` raken sinds 2026-08-01 40 commits in agent-harness en ongeveer 70 in scrum4me-mcp zowel `src/` als tests, zonder wijziging aan `package.json`, de lockfile of Prisma, en met 20–400 gewijzigde regels. De selectie legt haar eigen bron-pin en filter vast (§4.2).
- **De M3-spike** haalde 7 van 9 kleine taken met gsq (M3 §10).

## 4. Opzet

### 4.1 `harness task-bench`

Een nieuw subcommando in agent-harness: `harness task-bench --case <json> --model-config <json> --task-config <json> --out <map>`.

- **Samenstelling.** Het gebruikt de bestaande onderdelen van de worker:
  - **systeemprompt:** `TASK_SYSTEM_PROMPT` zonder de bijzin ", en je kunt productdocumentatie lezen met de doc-tools". Een test bewijst dat precies die bijzin het verschil is.
  - **taakprompt:** `renderTaskPrompt` met een nieuwe optie die het blok `## Product` weglaat. De standaard laat het blok staan, dus de worker verandert niet. Een test bewijst dat systeem- en taakprompt van de bench geen naam van een doc-tool bevatten.
  - `createTaskTools`, `runInContainer` met het recept van de repo, en `runManifest` met profiel `tools`.
  - **De gate** is gelijk aan die in `runTaskJob`. `afterAnswer` draait `recipe.verify`, met `maxVerifyRepairs` pogingen en dezelfde tekst bij rood. `isGreen` en `verifyText` worden geëxporteerd, zonder gedragswijziging, en de bench gebruikt ze. Net als `runTaskJob` houdt de bench lopende containers bij. Meldt `runInContainer` dat een container niet aantoonbaar is opgeruimd (`cleanup: 'uncertain'`), dan stopt de run en is het een `benchfout`.
- **Herhalen bij storingen, alleen op de gehoste route.**
  - De bench geeft `runManifest` een modelclient die een verzoek bij een tijdelijke fout tot 3 keer opnieuw doet. Tijdelijk is: een netwerkfout, HTTP 408, 429 of 5xx, of een foutbody van OpenRouter met zo'n code.
  - Tussen de pogingen zit een oplopende wachttijd, binnen `maxWallSeconds`.
  - Elke herhaling staat in de trace en in de resultaat-JSON. Pas als de herhalingen op zijn, eindigt de run op `MODEL_ERROR`, en dus op een benchfout.
  - Met de 16-bit-route is er maar één aanbieder (§4.3), en de modelclient zelf herhaalt niet (§3). Zonder deze herhaling zou een losse storing bij DeepInfra (uptime 98,45% over een dag) ongeveer een op de drie runs als benchfout laten eindigen.
  - Voor `gsq-lokaal` staat het uit, zoals in productie: daar kan een fout van Ollama ook modelgedrag zijn.
- **De taakconfig** is een kopie van het `task`-blok uit `worker.json`: limieten, image, uid/gid, npm-cache, `maxVerifyRepairs` en recepten. Zo meet de bench met precies de grenzen van productie.
- **Verloop per run:**
  1. Een wegwerpclone van de repo in een map binnen `--out`, vers en buiten elke workercache. Checkout van `base_commit`, daarna `git submodule update --init --recursive` op de gitlinks van die commit.
  2. Prepare in een container.
  3. De modellus met de gate.
  4. De diff van de clone tegen `base_commit` als patch vastleggen.
  5. **De verborgen toets, buiten het zicht van het model:**
     - Zet de hele map `__tests__/` en de runnerconfig (`vitest.config.*`, `package.json`, `tsconfig*.json`) exact terug naar hun stand in `ref_commit`. Bestanden die het model daar toevoegde, verdwijnen ook.
     - Draai `hidden_test_command` met de JSON-reporter van vitest in de verify-container.
     - Geslaagd als de exitcode 0 is, én de JSON laat zien dat elk bestand uit `hidden_tests` draaide met minstens één test en zonder falende of overgeslagen tests.
     - Zo kan een aanpassing van het model aan tests of runnerconfig de toets niet omzeilen.
  6. Een resultaat-JSON en de trace in `--out`.
- **Containers:** de bench gebruikt `containerName` met een eigen run-id. De namen beginnen dus ook met `harness-` en vallen onder het opruimfilter van de worker; daarom draait de bench alleen in een venster (§4.5). `containerName` gebruikt alleen de eerste 8 tekens van het id, dus runs draaien strikt na elkaar.
- **Uitkomst per run** (`status` in de resultaat-JSON):
  - `geslaagd`: de gate is groen en de verborgen toets is geslaagd;
  - `verborgen_tests_rood`: de gate is groen, de verborgen toets niet;
  - `verify_rood`: de gate faalde na `maxVerifyRepairs` rode runs;
  - `limiet`: `budget_exceeded`, `timed_out`, of `failed` met `TOO_MANY_TOOL_ERRORS`;
  - `geen_wijzigingen`: de clone is ongewijzigd;
  - **`benchfout`:** clone, submodule, prepare of container faalde buiten het model om, of `runManifest` eindigde op `MODEL_ERROR`, `HARNESS_ERROR` of `TOOL_NOT_AVAILABLE`.
    - Een benchfout telt niet als modelfout. De driver draait die taak één keer opnieuw.
    - Is de tweede poging ook een benchfout, dan stopt de driver en beslist JP. Een onvolledige set telt nooit als 12 geldige runs.
    - Kosten en bewijs van elke poging blijven bewaard.
- **De resultaat-JSON** bevat verder:
  - de case-id, het model, de status, en de ruwe eindstatus van `runManifest` met de foutmelding (gemaskeerd);
  - per respons de aanbieder;
  - het aantal herhaalde verzoeken, met hun foutcodes;
  - modelbeurten, toolaanroepen en toolfouten;
  - tokens in en uit, `costUsd` en de wandtijd;
  - de staart van de laatste gate-uitvoer en de vitest-JSON van de verborgen toets.
- **Bewuste verschillen met productie:**
  - de basis is `base_commit`, niet de default-branch;
  - geen MCP-job, geen claim, geen commit of push, geen status- of logaanroepen;
  - **geen doc-tools.** De docs-store van nu kan de oplossing van een oude taak al bevatten. Daarom verdwijnen ze ook uit de prompts (zie Samenstelling). De docs in de repo zelf blijven leesbaar via `read_file`.
  - **geen `verify_task_against_plan`.** De verborgen toets neemt die taak over.
  - **herhalen bij storingen op de gehoste route.** De worker draait lokaal en heeft geen route naar een aanbieder op afstand.

### 4.2 De takenset

- **Bron:** afgeronde Scrum4Me-taken (DONE). Uit product Agent-harness voor de repo agent-harness, en uit product Scrum4Me voor de repo scrum4me-mcp. Per taak gaan in de case:
  - de taaktekst zoals de worker hem krijgt: titel, beschrijving, implementatieplan, en titel en acceptatiecriteria van de story;
  - de commit waarmee de taak op main kwam (`ref_commit`).
- **Criteria per taak:**
  1. `ref_commit` staat op main. `base_commit` is zijn eerste ouder.
  2. Op `base_commit` zijn prepare en verify van het recept groen.
  3. `hidden_tests` zijn de testbestanden (`*.test.ts` onder `__tests__/`) die `ref_commit` toevoegt of wijzigt. Ze worden met de verborgen toets van §4.1 gedraaid. Op `base_commit` falen ze, en op `ref_commit` slagen ze, in de verify-container.
  4. De verborgen tests toetsen alleen wat de taaktekst vastlegt (namen, signaturen, gedrag), niet toevallige details van de oplossing van toen.
  5. Het plan bevat niet de volledige implementatie. Dat geldt voor het implementatieplan in de taak, en ook voor een plan van deze taak dat op `base_commit` al in de repo staat (bijvoorbeeld onder `docs/plans/`). Anders meet de taak overtikken.
  6. Geen schemamigratie, geen nieuwe dependency, geen webrepo, en `ref_commit` wijzigt de runnerconfig niet (`vitest.config.*`, `package.json`, `tsconfig*.json`).
  7. Een mix: 6 per repo, features en fixes, en qua omvang van `ref_commit` 4 klein (20–80 regels), 4 middel (81–200) en 4 groot (201–400).
- **Selectie:** Claude stelt de 12 voor.
  - Per taak staan in het voorstel: repo, taakcode, `ref_commit`, omvang, soort, de verborgen tests, en het bewijs voor criterium 2 en 3.
  - Het voorstel legt ook de bron-pin (`origin/main`-commit per repo) en het filter vast.
  - JP keurt de lijst goed vóór de eerste modelrun van increment 3. Daarna ligt de set vast in `cases.jsonl` en verandert hij niet meer.
- **De taak van de praktijkproef** (increment 1) voldoet aan dezelfde criteria en mag een van de 12 worden.

### 4.3 Modellen en instellingen

- `gsq-lokaal`: `qwen3.8-gsq-rco:27b-iq3_s-text` op `http://127.0.0.1:11434/v1`, zonder extra instellingen, zoals de productieworker.
- `qwen3.8-openrouter`: `qwen/qwen3.8-27b` op `https://openrouter.ai/api/v1`.
  - Met `provider: {data_collection: "deny", require_parameters: true, quantizations: ["bf16", "fp16"]}` en `reasoning: {effort: "medium"}`, zoals de docs-variant in M5 maar nu op 16-bit.
  - Met tools en `require_parameters` blijft nu alleen DeepInfra (BF16) over.
  - Het rapport legt per respons de aanbieder vast, en bij het begin van elk venster een kopie van de publieke endpointlijst als bewijs van de precisie.
  - Is er geen toegestane route, dan geeft OpenRouter een fout. Na de herhalingen (§4.1) wordt dat een benchfout, nooit een terugval naar een lagere of onbekende precisie.
  - Herhalen bij storingen staat aan voor dit label, en uit voor `gsq-lokaal` (§4.1).
  - Temperatuur en seed blijven op de standaard, net als bij de worker.
- Beide krijgen de limieten uit §3. Eén run per taak. Gehost is niet herhaalbaar, dus één run is een steekproef; dat noemt het rapport.

### 4.4 Driver en scorer (llm-bench, repo max2)

- Een map `llm-bench/task_bench/` met:
  - `cases.jsonl` (§4.2);
  - `models.json` met de twee labels (§4.3);
  - een run-script dat `harness task-bench` per taak en model aanroept;
  - de scorer, als functie in dat script of als eigen script.
- **Het run-script:**
  - draait de taken na elkaar;
  - slaat over wat al een geldige resultaat-JSON heeft;
  - draait een benchfout één keer opnieuw en stopt bij een tweede (§4.1);
  - houdt één grootboek bij van de kosten van de proef, alle runs en herhalingen, en start geen nieuwe run als het totaal $14 of meer is (§4.6).
- **De scorer** maakt de tabel per taak en model, de tellingen, en het oordeel volgens §1, met de grensgevallen. Hij scoort alleen een volledige set van 12 geldige runs per model.
- Tests met de standaardbibliotheek (`unittest`), zoals de rest van llm-bench. `check_key.py` uit M5 controleert de uitvoer.

### 4.5 Vensters en veiligheid op max2

- **Waar:** alles draait op max2, uit een eigen worktree van agent-harness met een eigen build (`~/Development/agent-harness-m7`). De checkout van de worker (`~/Development/agent-harness`) blijft onaangeroerd. De uitvoer gaat naar `~/m7-runs/`, buiten elke repo.
- **Vensters:** elk venster alleen op JP's go, binnen de tijd die JP noemt, volgens de Vensterprocedure van M6 (`docs/plans/M6-local-precision-refiner.md`):
  - de dienststand vooraf;
  - de M4-stop (fail-closed);
  - de containers stoppen die volgens de dienststand draaien;
  - starten in tmux met het sessie-ID;
  - na afloop herstellen en de dienststand na vastleggen.
  - Bij een nachtvenster een vangnet dat vlak voor het einde afbreekt en herstelt, zoals `q8-docs-vangnet.sh` uit M6 (max2-repo, `llm-bench/results/refiner-precisie-2026-10-01/`).
- **De OpenRouter-sleutel** staat op de Mac in `~/.zshenv`.
  - Voor een gehost venster gaat hij via stdin naar een bestand met modus 0600 op een tmpfs op max2 (`/run/user/1000/`). Het run-script leest hem daar één keer in. Vóór elk venster wordt gecontroleerd dat het bestand er is.
  - De modelconfig noemt alleen `api_key_env`. De waarde staat nooit in argv, een log, de modelconfig, de trace, de resultaat-JSON of een repo.
  - Na het venster verdwijnt het bestand.
- **De Ollama-config, de productieconfig en het model van de worker** blijven ongewijzigd.

### 4.6 Budget

- **Per run (schatting):** op de 16-bit-route (DeepInfra: $0,15/M in, $1,88/M uit) kost een run bij de vaste limieten (40 × 65.536 tokens in, 80.000 uit) ongeveer $0,39 + $0,15 = $0,54.
  - Dat is een schatting, geen grens: prijzen kunnen veranderen, en `fitContext` schat tokens op tekens.
  - Een eigen kostengrens in de lus komt er niet.
- **Eén grootboek:** de proef, alle runs en alle herhalingen tellen samen. Het run-script start geen run meer bij $14 of meer.
  - $14 plus één lopende run is de behoudende planning.
  - De limiet van de sleutel ($20) is de enige harde grens.
- **Na de proef:** kost de praktijkproef meer dan $1,00, dan stopt M7 voor JP's besluit. $14 moet ruimte laten voor 13 gehoste runs plus één herhaling.

### 4.7 Volgorde

1. **Increment 1: bench plus praktijkproef.**
   - `harness task-bench` met unittests:
     - een nepmodel en neppe containers;
     - een gate-test gelijk aan die van de worker;
     - de prompttests uit §4.1;
     - de verborgen toets, met een test die laat zien dat een aangepaste runnerconfig of een weggehaalde test niet als geslaagd telt;
     - het herhalen bij storingen: alleen tijdelijke fouten, hooguit 3 keer, binnen de deadline, en alleen op de gehoste route.
   - De PR in agent-harness; JP merget.
   - Op max2 de worktree `~/Development/agent-harness-m7` met `npm ci` en een build.
   - Eén taak met de hand gekozen en gecontroleerd volgens §4.2.
   - Op JP's go een venster van ongeveer een uur: die taak met `qwen3.8-openrouter`, op de 16-bit-route. De proef controleert dat elke respons van een aanbieder op 16-bit kwam, en meldt hoeveel verzoeken herhaald zijn.
2. **Increment 2: takenset en driver.** De selectie van 12 taken, met bewijs. JP keurt goed, en de set wordt bevroren. Driver en scorer met tests, als PR in max2.
3. **Increment 3:** op JP's go `qwen3.8-openrouter` op alle 12 taken, in een venster van ongeveer 3 uur.
4. **Increment 4:** op JP's go `gsq-lokaal` op alle 12 taken, in een nachtvenster (tot 40 minuten per taak).
5. **Increment 5:** het rapport en het oordeel, in een PR in max2.

### 4.8 Het rapport

`llm-bench/results/task-bench-<datum>.md` met:
- de takenset: per taak repo, taakcode, `ref_commit`, omvang, soort en de verborgen tests, plus de bron-pin en het filter;
- per taak de uitkomst van beide modellen, met de reden van elk falen en bij `verborgen_tests_rood` de falende tests;
- elke benchfout en herhaling apart, met de reden;
- de tellingen, het oordeel en de betekenis volgens §1, met de grensgevallen;
- kosten per run en in totaal (het grootboek), tijd per run, modelbeurten en toolfouten;
- per gehoste run de aanbieder per respons, en de endpointlijst bij het begin van elk venster;
- de verschillen met productie (§4.1) en de kanttekeningen (§6);
- per venster de dienststand vooraf en achteraf, en elke afgebroken run met de reden;
- de commits: de bench in agent-harness, de driver in max2, de worker-checkout, en `ollama --version`.

## 5. Acceptatiecriteria

1. `harness task-bench` volgt de lus van de worker:
   - Systeemprompt, taakprompt, tools, recept, gate met `maxVerifyRepairs` en limieten zijn gelijk aan `runTaskJob` met de taakconfig van max2.
   - Twee uitzonderingen: de doc-tools-bijzin en het blok `## Product` vallen weg.
   - Unittests tonen drie dingen:
     - er staat geen naam van een doc-tool in de prompts;
     - de verborgen toets telt een aangepaste runnerconfig of een weggehaalde test niet als geslaagd;
     - het herhalen bij storingen raakt alleen tijdelijke fouten op de gehoste route, en hooguit 3 keer.
   - De trace van de praktijkproef laat de lus zien.
2. De praktijkproef draaide één taak met `qwen3.8-openrouter` door de bench.
   - Er is een resultaat-JSON, met kosten en tijd.
   - Elke respons kwam van een aanbieder op 16-bit, en het aantal herhaalde verzoeken staat erbij.
   - De verborgen toets draaide met de `__tests__/` en de runnerconfig van `ref_commit`.
3. De takenset telt 12 taken (6 per repo). Elke taak heeft het bewijs voor de criteria 2 en 3 uit §4.2, met de bron-pin. JP keurde de lijst goed vóór increment 3.
4. Beide modellen draaiden alle 12 taken geldig. Elke run eindigde in een van de modelstatussen uit §4.1, na hooguit één herhaling bij een benchfout.
5. Het rapport bevat wat §4.8 noemt, en geeft het oordeel volgens §1. De totale kosten bleven binnen §4.6.
6. Na elk venster draaiden op max2 precies de diensten van vooraf. De worker-checkout en de workerconfig zijn ongewijzigd. De sleutel staat nergens in argv, logs, configs, traces, resultaten of repo's, en `check_key.py` vindt nul treffers.
7. `npm run verify` in agent-harness en de unittests van llm-bench zijn groen.

## 6. Risico's en open punten

- **Kleine aantallen.** Bij 12 taken scheelt één taak 8 procentpunt. Daarom de grens: een uitslag vlak bij een drempel is onbeslist, geen bewijs. Meer taken is dan JP's keuze.
- **Gehost ≠ lokaal.** In M5 kwam gehost door de zeef, bij aanbieders met een onbekende precisie, en in M6 zakte de lokale Q8. M7 legt de gehoste precisie vast op 16-bit (§4.3), maar engine en template blijven anders dan op een Mac. Een positief oordeel is een kandidaat voor een proef op echte hardware, geen koopadvies.
- **Eén aanbieder op 16-bit.** Met tools blijft alleen DeepInfra over.
  - Losse storingen vangt de herhaling in de bench op (§4.1).
  - Valt DeepInfra langer weg of verandert hij van precisie, dan worden het benchfouten en een stop voor JP, geen run op een andere precisie.
  - Een herhaling kan ook een fout verbergen die door de uitvoer van het model komt. Daarom toont het rapport de herhalingen per taak.
- **Gehost is niet herhaalbaar.** Eén run per taak is een steekproef; een tweede run past niet in het budget.
- **Storingen bij aanbieders.** Een 429 of 5xx eindigt een run meteen als `MODEL_ERROR`, want de modelclient herhaalt niet. §4.1 maakt daar een benchfout van, met één herhaling en daarna een stop voor JP. Zo bepaalt een storing het oordeel niet.
- **Verborgen tests kunnen te streng zijn,** als ze toevallige details van de oude oplossing toetsen. Criterium 4 in §4.2 beperkt dat. Het rapport toont bij elk `verborgen_tests_rood` de falende tests, zodat JP het kan beoordelen.
- **Lekken.** De commits zijn van augustus tot oktober 2026 en staan in privérepo's, dus de kans dat ze in de training van Qwen 3.8 zaten is klein. De docs-store van nu valt weg (§4.1), en criterium 5 sluit plannen uit die de oplossing al bevatten.
- **Geen doc-tools** maakt de bench iets strenger dan productie, voor beide modellen gelijk.
- **Kosten.** Ongeveer $0,54 per run op de 16-bit-route bij de vaste limieten (§4.6), als schatting. De praktijkproef meet de echte kosten vóór de rest.
- **Doorlooptijd.** gsq kan tot 40 minuten per taak nemen, dus 12 taken tot 8 uur. De worker ligt in elk venster stil.
- **Bench in een eigen worktree** op max2. Een build daar raakt de productieworker niet. De containers delen wel de npm-cache van de worker; in een venster draait de worker niet.

## Review record

### Ronde 1 (2026-10-02, rev 1 `45b1a3d` → rev 2)

Reviewers: `mac:claude` (0 BLOCKER, 2 MAJOR, 5 MINOR, NO-GO) en `mac:codex` (0 BLOCKER, 3 MAJOR, 2 MINOR, NO-GO). Alle bevindingen zijn tegen de tree gecontroleerd en overgenomen.

**Convergente MAJOR's:**
1. **Doc-tools in de taakprompt.** `renderTaskPrompt` vraagt altijd om `search_product_docs` en `list_product_docs` (`task-impl.ts:59`). In de bench geeft dat `UNKNOWN_TOOL`-fouten. Fix in §4.1: een optie om het blok `## Product` weg te laten (de standaard blijft), plus een prompttest. Criterium 1 noemt de uitzondering.
2. **Geen status voor `MODEL_ERROR`, `HARNESS_ERROR` en `TOOL_NOT_AVAILABLE`.** Fix in §4.1: die vallen onder `benchfout`, met één herhaling. Een tweede benchfout stopt de driver voor JP.
   - Van de twee voorstellen is dat van codex gekozen: een onvolledige set telt nooit als 12 geldige runs.
   - Het voorstel van claude, "een tweede `MODEL_ERROR` telt als niet geslaagd", zou een storing als modelfout tellen.

**MAJOR van codex:** het model kon `vitest.config.ts` of tests aanpassen, zodat de verborgen toets niets meer bewees. Fix in §4.1, stap 5:
- de hele `__tests__/` en de runnerconfig teruggezet naar `ref_commit`;
- de vitest-JSON moet tonen dat elk verborgen testbestand draaide;
- criterium 6 sluit taken uit die de runnerconfig wijzigen.
- Dit dekt ook claude-MINOR 2 (hulpbestanden onder `__tests__/`).

**MINOR's:**
- **De bovengrens van $1,34** (claude 1, codex 2) is nu een schatting. Met de duurste aanbieder tot $2,94 per run. Er is één grootboek, en de stop staat op $14.
- **De gate** (claude 3): `isGreen` en `verifyText` worden geëxporteerd, en de bench stopt bij `cleanup: 'uncertain'`.
- **Rij 1 van de beslistabel** (claude 4): nu "geen meerwaarde aangetoond".
- **Verwijzingen** (claude 5): het vangnet verwijst naar `q8-docs-vangnet.sh`; "gehost door de zeef" was M5, niet M6.
- **Submodule** (codex 1): `git submodule update --init --recursive` na de checkout.

**Kleinere punten, ook verwerkt:**
- de verschilgrens geldt alleen in rij 3 (codex);
- de kandidaten zijn nu "ongeveer 70" in scrum4me-mcp, met een bron-pin bij de selectie (codex);
- de sleutel staat alleen als `api_key_env` in de modelconfig (codex);
- criterium 5 geldt ook voor een plan in de repo op `base_commit` (claude);
- runs draaien strikt na elkaar vanwege `containerName` (claude).

**Eigen correctie:** de containernamen beginnen met `harness-<8 tekens>-`, niet met `harness-bench-`.

**Omvang:** geen nieuw onderdeel. Er komen bij: een promptoptie, een statusmapping, de terugzet-stap en de JSON-controle in de verborgen toets, de submodule-stap, twee exports en een kleiner kostenplafond. Het eerste resultaat en de praktijkproef blijven gelijk.

### Ronde 2 (2026-10-02, rev 2 `005d6ce` → rev 3)

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 1 MINOR, GO) en `mac:codex` (0 BLOCKER, 1 MAJOR, 1 MINOR, NO-GO). Beide zagen de fixes van ronde 1 als gehouden. Codex noemde alleen de kostenzin "deels gehouden".

**Het eindregel-besluit:** beide reviewers steunen de gekozen regel uit ronde 1: één herhaling bij een benchfout, en daarna een stop voor JP.
- Claude vroeg er wel bij dat de resultaat-JSON de (gemaskeerde) foutmelding naast de ruwe eindstatus bewaart. Bij gsq kan een herhaalde `MODEL_ERROR` namelijk ook modelgedrag zijn. Dat is overgenomen in §4.1.

**MAJOR van codex: de gehoste precisie lag niet vast.** De publieke endpointlijst van `qwen/qwen3.8-27b` toont FP4, FP8, FP16, BF16 en onbekend. De spec las het gehoste model als de 27B op volle precisie. Fix:
- `quantizations: ["bf16", "fp16"]` in het provider-blok (§4.3), wat met tools nu alleen DeepInfra (BF16) laat;
- per respons de aanbieder, en een kopie van de endpointlijst per venster;
- geen terugval naar een lagere of onbekende precisie;
- de proef controleert de route (§4.7, criterium 2).
- §1, §3 en §6 noemen nu ook dat het gehoste model in M5 via aanbieders met een onbekende precisie liep.

**MINOR's:**
- **Kosten** (codex): $14 plus één run is nu een behoudende planning, en de sleutellimiet van $20 de enige harde grens.
  - Met de 16-bit-route (DeepInfra $0,15/M in, $1,88/M uit) daalt de schatting naar ongeveer $0,54 per run.
- **Drempel van de proef** (claude): van $1,25 naar $1,00. $14 moet 13 gehoste runs plus één herhaling dekken.

**Kleinere punten, ook verwerkt:**
- "terug naar ref_commit" is exact: bestanden die het model toevoegde, verdwijnen (codex);
- per respons de aanbieder in de resultaat-JSON.

**Omvang:** geen nieuw onderdeel. Er komen bij: een precisiefilter in de modelconfig, bewijs van aanbieder en precisie, en een lagere drempel voor de proef. Het eerste resultaat en de praktijkproef blijven gelijk.

### Ronde 3 (2026-10-02, rev 3 `b2cc43d` → rev 4)

Reviewers: `mac:codex` (0 BLOCKER, 0 MAJOR, 0 MINOR, GO) en `mac:claude` (0 BLOCKER, 1 MAJOR, 0 MINOR, NO-GO). Beide zagen alle vijf fixes van ronde 2 als gehouden. Claude controleerde de routing-docs van OpenRouter: `quantizations` filtert, en zonder passende aanbieder komt er een fout.

**MAJOR van claude: met één aanbieder en een modelclient zonder herhaling worden benchfouten waarschijnlijk.** Nagerekend met de publieke uptime van DeepInfra (98,45% over een dag) en `model-client.ts`, dat niet herhaalt:
- bij ongeveer 25 verzoeken per run eindigt zo'n 32% van de runs in een benchfout;
- de kans dat dezelfde taak twee keer faalt is ongeveer 10%;
- de kans dat increment 3 minstens één keer stopt is ongeveer 73%.

Een verkeerd oordeel volgt er niet uit, want een onvolledige set wordt nooit gescoord. Maar het plan voor increment 3 houdt dan geen stand. Codex achtte één aanbieder aanvaardbaar, omdat een storing de proef stopt in plaats van een modelfout te maken. Beide lezingen kloppen: claude's punt gaat over de uitvoerbaarheid.

Fix in §4.1 en §4.3: een begrensde herhaling in de bench, alleen op de gehoste route.
- tijdelijke fouten: netwerk, 408, 429, 5xx;
- hooguit 3 keer, binnen de deadline;
- vastgelegd in de trace en de resultaat-JSON.
- Voor gsq staat het uit, want een fout van Ollama kan modelgedrag zijn.
- Unittest in §4.7, criterium 1 en 2, en het risico in §6.

**Omvangtoets vóór ronde 4.** Elke toevoeging uit de rondes 1–3 beantwoordt een aangetoond faalpad:
- promptoptie: doc-tool-fouten;
- statusmapping: storing telt als modelfout;
- terugzetten en JSON: een vals geslaagd;
- submodule: prepare faalt;
- exports: drift van de gate;
- grootboek: overschrijding;
- precisiefilter: verkeerde precisie;
- herhaling: vastlopen.

Geen enkele toevoeging is een nieuw subsysteem. Weg kan alleen de aparte scorer, en die mag al een functie in het run-script zijn. Het eerste resultaat en de praktijkproef staan nog in increment 1.

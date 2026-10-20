# Review record: M8 review-bench plan (IDEA-270)

Document: `docs/plans/M8-review-bench.md`. Phase: plan. Idea: IDEA-270 (`cmvgl078e00xozr7rv79oeck3`), `idea_phase: PLAN`. Product: Agent-harness (`cmuhjw9e80003mt7rq4w3sauu`). Orchestrator: mac:claude (Claude Opus 5.5). Spec: revisie 2, dubbel GO (`86628ea3`); het spec-record staat in `2026-10-20-review-bench-spec-review-record.md`.

## Vóór ronde 1

**Revisies 1 → 3, vóór de dispatch.**
- Rev 1 (`6559730`) zat op 63k van de 64k tekens. De bestandstabel ging eruit, en S3 (de praktijkstappen) verhuisde naar de body. `verify_only` houdt een worker niet tegen (`scrum4me-mcp src/verify/gate.ts:11-12`), dus de praktijkstappen zijn sessiestappen en geen sprint-taken. Dat werd rev 2 (`ef152fb`), en die is als ProductDoc PLANS `idea-270-plan` revisie 2 geüpload.
- Rev 3 (`275db568`) herstelde twee claims die bij de eigen controle fout bleken:
  - "labels zonder punt vanwege `Manifest.id`" klopte niet. `runManifest` valideert `Manifest.id` niet, en `BENCH_LABEL` (`src/cli.ts:550`) staat punten toe. Het label is nu de configuratienaam, en models.json is geschrapt;
  - "`check_budget` met dezelfde vooruitschatting als M7" klopte niet. M7 stopt op `total >= budget_stop`, zonder vooruitschatting. Fix: M8 stopt als `totaal + maxCostUsd > --budget`, met een erratum op spec §4.7.

**Mislukte eerste dispatch.** Beide aanvragen kregen DISPATCH_INVALID_INPUT, omdat `gate.ts` en `run.py` als git-pin waren meegegeven en die moeten `.md` zijn. Er is geen request aangemaakt. De keys waren `69c5d2b5-d8d4-40f7-bdd9-73428451752f` en `10470b2c-8e9e-4420-9347-c63be48d8559`. Daarna is alleen het plan gepind, met de code-excerpts E1 (gate.ts) en E2 (M7 run.py) in de body.

## Ronde 1: revisie 3 (`275db5689c366f217012d348adc5d3529739360e`)

**Pin:** `plan`, `docs/plans/M8-review-bench.md` @`275db568`, sha256 `c27322961c02a828222e0481920c3536a77b348dccfb76b09327d08c266f1154`. Repository: `agent-harness@275db568`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `aad74bfc-cbb0-46c6-8f60-d14100c02bbf` | `67d722a6-ed32-4293-a004-11de47ac7129` | `61791f24-142f-45e2-a397-2312e010210f` | linked | **NO-GO** 0/2/0 (job `1ecc5289-a530-47c9-baff-d2c769470ea1`) |
| CLAUDE | `1145085d-80b2-4aec-8359-b2c115bf4c16` | `c3247036-d862-4d25-983c-32876e6e87ad` | `59d90fd1-2691-4241-b082-ff0268ecf545` | linked | **NO-GO** 0/1/8 (job `dffc3630-b96b-4013-9c54-330c44155c3d`) |

Beide reviewers vonden geen kandidaat om te schrappen. Alle claims over de tree hielden, en de MINORs van spec-ronde 2 landen zoals het plan zegt.

**Triage ronde 1.** Elke bevinding is tegen de tree gecontroleerd vóór de fix.

| # | Bevinding | Besluit en remedie |
|---|---|---|
| X-M1 | Betaalde weggevallen antwoorden (finishReason `other`) omzeilen de live kostenbewaking | Geaccepteerd. Gecontroleerd: `retry-client.ts:112-124` herhaalt intern, `run.ts:330` en `:404` roepen de guard alleen voor het teruggegeven antwoord, `cost.ts:94-109` telt alleen in `afterResponse`. Fix in S1-2 en S1-6: `createTrackedClient` krijgt een optionele `guard`. In `onRetry` gaat een weggevallen antwoord naar `guard.afterResponse`, daarna `beforeRequest`. Een stop gooit een `CostStopError` (een ModelError, kind `invalid`) vóór de herhaalaanvraag. runReviewBench zet die stop daarna in de run, zodat COST_LIMIT_EXCEEDED limiet wordt. Task-bench geeft geen guard mee en verandert niet. Drie regressietests in S1-6, drie in S1-2. |
| X-M2 / C-M1 | De preflight staat in `<out>`, maar rookproef en hoofdruns draaien in submappen; het rapport heeft geen bron voor preflight, rookproef en de redenen | Geaccepteerd (convergent). Gecontroleerd in P2/P3 en S2-2/S2-3. Fix: de driver krijgt `--preflight-file`, standaard `<out>/preflight.json`. P2 en P3 gebruiken `R/preflight.json` met eigen `--out`-mappen. P3 krijgt alle acht configuraties. De driver slaat een afgewezen preflight of CONFIGURATION_NOT_PROBED zelf over, zonder herhaling en zonder exit 3. `skipped.json` wordt een lijst `{label, run, reason}` voor elke verwachte run zonder resultaat, met "budget bereikt" en de stopredenen erbij. `score.py report` krijgt `--preflight`, `--models`, `--runs`, `--smoke-dir` en `--smoke-scores`. `score.py smoke` vervangt `report --smoke` als gate van P2. Er komt een end-to-end-test in de indeling van P2 en P3. |
| C-m1 | S1-5 hangt af van S1-4, en S1-8 (de push) van S1-1…7, maar dat staat er niet | Geaccepteerd. "Vereist" in S1-5 en S1-8; de volgordetabel is bijgewerkt. |
| C-m2 | De scoping van `retries`, `providers` en de tracked client in task-bench is open | Geaccepteerd. Gecontroleerd: `task-bench.ts:259-262`, `:324-351`, `:465-467`. Fix: `let tracked` vóór de try, met `?? []`-fallbacks in het resultaat. |
| C-m3 | De kosten van een weggevallen antwoord in bench-result.json zijn niet getest in S1-6 | Geaccepteerd, samen met X-M1. Correctie op de voorgestelde test: een HTTP 503 heeft geen bedrag; alleen een record met kind `finish_other` heeft `costUsd` (`retry-client.ts:114-121`). De test is daarom `other` à 0.02 en daarna een geldig antwoord à 0.05, wat 0.07 geeft. `deps.sleep` gaat naar `createTrackedClient`. Dezelfde fout stond in de S1-2-test ("tijdelijke fout met costUsd"); die is ook gecorrigeerd. |
| C-m4 | AC7 zoekt alleen de hele key, en de Python-kant heeft geen echotest | Geaccepteerd. Gecontroleerd: `__tests__/helpers.ts:25-50`. Fix: S1-6 en S1-7 gebruiken `DUMMY_KEY`, `leakedFragments` en `bodyWithKeyAt(190)`. S2-2 krijgt `leaked_fragments` en een nep-LiteLLM die een 400 geeft met de key in de body. `reason` gaat door mask_secrets. |
| C-m5 | De externe bronnen en de docs zijn voor een worker zonder context niet bereikbaar | Geaccepteerd. S1-1 vertakt van `origin/claude/remote-models-review-9a05f5`, waar spec, plan en records staan. S1-3 en S1-4 noemen de Forgejo-repo's en lokale clones, met `git show <sha>:<pad>`. |
| C-m6 | De kostenvoorwaarde in de preflight herhaalt het probe-verdict | Geaccepteerd als herformulering (de reviewer eiste niets). Gecontroleerd: `probe-gate.ts:93-97`. Review Focus 4 en S2-2 zeggen nu dat de probe dit al eist en de preflight het herhaalt bij `max_tokens` 64000. De controle blijft. |
| C-m7 | De `read_file`-telling hangt af van de vorm van het pad | Geaccepteerd. Fix in S2-3: een absoluut pad met `/<runId>/root/` wordt het deel daarna, en dan `posixpath.normpath`. Een fixture met `./sources/doc` en een absoluut pad. |
| C-m8 | De generalisatie van `requiredValues` vraagt een typewijziging | Geaccepteerd, met een ander type. Gecontroleerd: `src/cli.ts:556`. Het voorstel `keyof Values & string` breekt, want `cliArgsConfig` heeft boolean-opties (`help`, `all`, `once`, `skip-probe`, `retry-transient`, `check-case`), en dan is de waarde geen string. Fix: de union van `TASK_BENCH_FLAGS` en `REVIEW_BENCH_FLAGS`. |

**Scope-delta r3→r4.**
- Erbij:
  - een optionele `guard` op de tracked client, met `CostStopError`;
  - `--preflight-file` in de driver;
  - de lijst-vorm van `skipped.json` met vijf redenen;
  - `score.py smoke`, en de extra invoer van `score.py report`;
  - een end-to-end-test.
- Eruit: de handmatige voorfiltering in P3, en `report --smoke`.
- Eigen aanvulling, niet door een reviewer gevraagd: de redenen voor een ontbrekende run hebben een vaste volgorde (S2-2 en S2-3). Een run met CONFIGURATION_NOT_PROBED heeft een bench-result met status benchfout, en telt toch als "niet geprobed".
- Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.
- Om binnen de 64k te blijven: de MINOR-tabel van spec-ronde 2 is één alinea geworden, en Architecture, de PBI-tekst en enkele lijsten zijn ingekort.
- Plan: 56 756 → 62 945 tekens. De grootste `implementation_plan` is S2-2, met 6 337 tekens.

## Ronde 2: revisie 4 (`931208539e881b34d37866dbb600965d90ec10b8`)

**Pin:** `plan` @`93120853`, sha256 `a27a22d64286e2a6c93fce09b12ac32b87e9b898ea03ed3c2a4b2e3225be2f99`. Repository: `agent-harness@93120853`. De body had een nieuwe excerpt E3 (max2 `task_bench/run.py` @`a55ec379`, r. 530-552) en legde drie afwijkingen van een voorgestelde remedie (C-m3, C-m8, C-m5) aan beide reviewers voor.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `c94e5fc5-2054-4ff7-a274-80af391444ae` | `80b58724-9e71-4596-9976-7e2e043b4928` | `efc6fb47-1701-4e1f-9f26-4e588306dbe8` | linked | **NO-GO** 0/1/1 (job `08686032-ddd7-4d1c-9ef6-30d2cad9d11d`) |
| CLAUDE | `274c42fb-385c-4d85-baf9-99d00cd26da2` | `d5dba36d-ff09-473a-bdf5-809bcf848e6d` | `69bfb83d-2506-42af-a778-5bba4c0ec2a1` | linked | **GO** 0/0/6 (job `fdff3268-fc63-434d-8e68-9d136ac37f6f`) |

**Fixes van ronde 1.** Beide reviewers vonden dat ze houden, tegen de tree gecontroleerd. Het pad van X-M1 is apart nagelopen: de throw uit `onRetry` (`retry-client.ts:84-92`, `:119-124`), MODEL_ERROR in `run.ts:374-379`, en de volgorde `afterResponse` dan `beforeRequest`. Beide aanvaardden de drie afwijkingen (C-m3, C-m8, C-m5). Alle tien MINORs van spec-ronde 2 landen nog.

**Triage ronde 2.** Elke bevinding is tegen de tree of de spec gecontroleerd.

| # | Bevinding | Besluit en remedie |
|---|---|---|
| X2-M1 | `score.py smoke` geeft "door" als qwen ontbreekt, bijvoorbeeld na een afgewezen preflight | Geaccepteerd. Gecontroleerd: spec §4.8 stap 6 (r. 372-378) eist beide rookruns. Fix in S2-3 en P2: van beide configuraties moet een resultaat bestaan, en een ontbrekend resultaat betekent stop. Er zijn vier fixtures: beide aanwezig, qwen ontbreekt, sonnet ontbreekt, en een benchfout. |
| X2-m1 | Het rapport noemt een run met `limiet` of `resultaat_ongeldig` "niet gestart" | Geaccepteerd. Reden 3 is nu de status van het bench-result (benchfout, limiet of resultaat_ongeldig), met de foutcode. |
| C2-m1 | De driver kent geen run-identiteit: E3 sleutelt op `(label, case)`, en M8 heeft 3 runs per label. Oude CONFIGURATION_NOT_PROBED-resultaten tellen bij het hervatten als benchfout | Geaccepteerd. Gecontroleerd tegen E3 r. 533-539. Fix in S2-2: run n gaat naar `<out>/<label>/r<n>`. Hervatten, de teller en `skipped.json` werken per `(label, n)`, en NOT_PROBED telt net als `afgebroken` niet in `seen`. Er is een hervattest. S2-3 leest `<out>/<label>/r<n>/*/bench-result.json` en neemt per `(label, n)` het resultaat met een modelstatus. |
| C2-m2 | Een antwoord dat definitief wegvalt (`UnusableAnswerError`) bereikt de guard niet. De zin "elk antwoord telt één keer" is dan onwaar | Geaccepteerd, met de betere remedie. Gecontroleerd: `retry-client.ts:112-114`. In de catch gaat het ook als `dropped` naar de guard, met dezelfde stopregel, en de fout gaat ongewijzigd door. Er is een test: vier keer `other` à 0.30 geeft COST_LIMIT_EXCEEDED in `costStop()`. |
| C2-m3 | Bij de spawn-test in S1-7 ontbreken de probe-fixture en de `main()`-tak | Geaccepteerd. Gecontroleerd: de switch staat op `src/cli.ts:625-636`, niet op ~498-512 zoals de reviewer schreef. Fix: `case 'review-bench'`, een gedeelde helper `__tests__/fixtures/review-bench/probe.ts` uit S1-6, en een server die precies 1 verzoek telt. |
| C2-m4 | S1-6 mist de herkomst van `ModelSpec` en `NO_USAGE`, en `adaptReviewPrompt` draait pas na de run-map | Geaccepteerd. Gecontroleerd: `ModelSpec` staat op `task-bench.ts:20`, `NO_USAGE` is privé (`:188`), en spec §4.5 zegt "de bench draait niet". Fix: `adaptReviewPrompt` draait in stap 1, vóór de map. Er is een eigen `NO_USAGE`, en `run?.usage ?? NO_USAGE`. |
| C2-m5 | De volgordetabel laat S2-3 wachten op S2-1 in plaats van op S2-2 | Geaccepteerd. De rij is gesplitst. |
| C2-m6 | Een gedropt hosted antwoord zonder bedrag geeft meteen COST_UNKNOWN en dus een benchfout | Geaccepteerd als notitie, zoals de reviewer voorstelde; geen codewijziging. P3 stap 2 noemt het een provider-uitval, en JP kan het label overslaan. |

**Scope-delta r4→r5.**
- Erbij: een run-map per run (`r<n>`), en de guard ook voor het laatste weggevallen antwoord. De rest zijn verduidelijkingen en testgevallen.
- Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.
- Om onder de 64k te blijven:
  - Global Constraints, Review Focus, Vorm, Ceremonie en Risico's zijn ingekort tot proza;
  - de story-AC's verwijzen nu naar de codes;
  - korte geneste lijsten zijn op één regel gezet.
- Plan: 63 017 → 63 210 tekens. De grootste `implementation_plan` is S2-2, met 6 708 tekens.

## Ronde 3: revisie 5 (`f0f186157f9233abcd96e3aaf5b102ec4c9e7e5b`)

**Pin:** `plan` @`f0f18615`, sha256 `fe7b915198c0fa19b5d23782bba26018b39651d27f5c9f14d46af4c690610bec`. Repository: `agent-harness@f0f18615`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `cf1e6037-af59-43fd-8c37-b21d0f261c1e` | `5f8683d5-abe8-4682-af25-eeabdf9b41c4` | `96f671d8-576e-4ecb-9ebb-742f5c8f7dee` | linked | **NO-GO** 0/1/0 (job `c641eb38-25e0-4e73-9580-922418874fc0`) |
| CLAUDE | `545642ff-74f7-41fc-b794-89902b0a8eae` | `52d1ca8a-4ba0-46ca-948d-199521cd2535` | `c33124d7-aba2-461a-9155-385b0b8102c0` | linked | **GO** 0/0/6 (job `d885fd29-743f-4ba4-bf34-ef5fb0a9d096`) |

**Fixes van ronde 2.** Beide reviewers vonden dat ze landen. Alle tien MINORs van spec-ronde 2 staan er nog. Eén fix bleek fout: C2-m2, zie X3-M1.

**Triage ronde 3.**

| # | Bevinding | Besluit en remedie |
|---|---|---|
| X3-M1 / C3-m1 (convergent) | De catch voor `UnusableAnswerError` (C2-m2) meet ook de lege fout van een onderbroken wachttijd (`retry-client.ts:119-123`, `:91`). Dat geeft COST_UNKNOWN, en de override in S1-6 maakt dan van `timed_out` een benchfout | Geaccepteerd. Gecontroleerd: `retry-client.ts:91` en `:119-123`, en de bestaande test `__tests__/bench-retry-client.test.ts:466-482`. Remedie: de kleinste, dus C2-m2 teruggedraaid. De catch meet niets meer; alleen `onRetry` voedt de guard. De zin over "één keer" is nu waar, met de reden erbij. De override in S1-6 geldt alleen voor `failed` met MODEL_ERROR, zodat timed_out en afgebroken blijven staan. De test met vier keer 0.30 is vervangen door een test met een onderbroken wachttijd: `costStop()` blijft leeg en de guard zag één antwoord. Er is een deadline-test bij S1-6. Bewust geaccepteerd: een laatste weggevallen antwoord dat het plafond passeert, geeft benchfout (MODEL_ERROR) in plaats van limiet. De run eindigt daar, en het bedrag staat in usage en het grootboek. |
| C3-m2 | Na de extractie blijven in `task-bench.ts:16` imports ongebruikt, en dan faalt lint | Geaccepteerd. Gecontroleerd: `eslint.config.js:8` en `package.json` verify. S1-2 haalt `createRetryingClient` en `UnusableAnswerError` weg. |
| C3-m3 | MODEL_STATUSES is in S2-2 niet gedefinieerd, en "het laatste" in S2-3 is dubbelzinnig | Geaccepteerd. MODEL_STATUSES is nu beoordeeld, limiet en resultaat_ongeldig, en "het laatste" is het laatste op mtime. |
| C3-m4 | De diffs in S1-1 en S1-2 vergelijken met `origin/main`, maar de branch begint op een andere branch | Geaccepteerd, met een andere remedie. Gecontroleerd: `git diff origin/main...HEAD --stat` raakt alleen docs (4 bestanden). De diffs gebruiken nu de merge-base (`origin/main...HEAD`). Dat dekt ook een main die intussen verder is. |
| C3-m5 | P2 stap 2 noemt niet wie het sudo-commando draait | Geaccepteerd. JP draait het in een terminal, en `cat`/`echo` van het bestand mag niet. |
| C3-m6 | Kleine formuleringsgaten | Geaccepteerd: `message: { content: null, toolCalls: [] }`, `export type ReviewCase`, de body-case in S1-6 verwijst naar de echte modelclient in S1-7, en P2 stap 6 noemt "beide resultaten bestaan". |

**Scope-herbeoordeling vóór ronde 4.**
- Het ontwerppunt dat terugkomt, is de live guard voor weggevallen antwoorden: X-M1 in ronde 1, C2-m2 in ronde 2 en X3-M1 in ronde 3.
- Het kleinere alternatief is de guard helemaal schrappen. Dan zouden we vertrouwen op het zachte plafond, het grootboek na elke run en de marge van $2.
- Dat alternatief is afgewezen. X-M1 liet zien dat gerapporteerde kosten binnen één run de reserve kunnen passeren, terwijl de guard ze niet ziet.
- Gekozen is daarom de kleinste vorm die X-M1 dicht: alleen `onRetry`. De catch-uitbreiding van ronde 2 is weer weg.
- Geen nieuwe scope, en geen JP-beslissing nodig.

**Scope-delta r5→r6.**
- Eruit: het meten in de catch (C2-m2) en de 11 losse commit-regels. Die zijn vervangen door één regel in Global Constraints.
- Erbij: de MODEL_ERROR-voorwaarde op de override, en kleine verduidelijkingen.
- Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.
- Plan: 63 210 → 63 164 tekens.

## Ronde 4: revisie 6 (`36baadf7aac2af95edb4887de8f5d354753a428c`)

**Pin:** `plan` @`36baadf7`, sha256 `80ddacb015c6b7553b15f2c57ebebbfd90221851287cbc65bf3dd92a3bae5d54`, 693 regels, 63 164 tekens. Repository: `agent-harness@36baadf7`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `509288ab-afe4-4a2e-8b92-3293a40adf22` | `81934adf-2947-487a-bd5f-7ccdcb0ad07e` | `fd4a1cde-cbec-4cfb-8571-d8d09bf0d67c` | linked | **GO** 0/0/0 (job `15a02e95-f496-4dee-b66d-751eba8cf91b`) |
| CLAUDE | `8a9a0d9c-344b-4c48-b16d-c25946691dd3` | `5340cd89-22fa-4a8d-b65d-7fc4125bb7ec` | `9f8e109d-1e43-4ae1-938d-8e5616aa9f81` | linked | **GO** 0/0/3 (job `1f45a0f0-4cca-450b-8dab-d0f1ee413a39`) |

**Fixes van ronde 3.** Beide reviewers vonden dat ze houden, ook X3-M1. De catch meet niets, alleen `onRetry` voedt de guard, en de override geldt alleen bij MODEL_ERROR. X-M1 en X2-M1 bleven dicht. Alle tien MINORs van spec-ronde 2 landen nog. Beide vonden geen kleiner correct alternatief voor de guard alleen via `onRetry`.

**Dubbel GO: de plan-fase is klaar** (revisie 6, `36baadf7`).
- De MINORs van ronde 4 komen niet meer in het plan, zoals bij de spec: elke wijziging na de GO zou een delta-ronde vragen.
- Ze landen bij de ceremonie in de taakteksten, als de vervangingen hieronder.
- Alle drie zijn tegen de tree gecontroleerd.

| # | Bevinding | Landt bij de ceremonie in |
|---|---|---|
| C4-m1 | De deadline-case in S1-6 ("deadline al verstreken") kan zo geschreven worden dat hij niet kan falen. `run.ts:334` geeft timed_out vóór de eerste aanroep | S1-6: "met `deps.now` die pas na de derde drop voorbij de deadline springt (de nep-sleep zet de klok door): `timed_out`, niet limiet en niet benchfout" |
| C4-m2 | S1-6 en S1-7 vragen een nieuwe probe-helper, terwijl `__tests__/fakes/probe-seed.ts` (`seedProbe`) en `__tests__/fakes/worker-config.ts` (`testWorkerConfig`) al bestaan. Geen enkele cli-test spawnt; ze gebruiken `runMain` (`__tests__/cli.test.ts:201`) | S1-6: gebruik `seedProbe` en `testWorkerConfig`; de helper `probe.ts` vervalt. S1-7: "via `runMain` (zoals `__tests__/cli.test.ts`)" in plaats van "via spawn" |
| C4-m3 | De zin in S1-2 zegt dat elke `UnusableAnswerError` al via `onRetry` geteld is. Dat geldt alleen na een onderbroken wachttijd | S1-2: "Na een onderbroken wachttijd is het antwoord al via `onRetry` geteld (retry-client.ts:119-123). Na de laatste herhaling niet: de run eindigt als benchfout (MODEL_ERROR), ook als dit antwoord het plafond passeert; het bedrag staat via `droppedLast` in usage en het grootboek." |

**Scope-delta r4.** Geen. Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.

**Kosten van de loop.** 8 jobs in 4 rondes, plus een mislukte eerste dispatch zonder job. Het verbruik staat niet in de MCP-antwoorden.

## JP-gate na de GO (2026-10-20)

JP koos "Eerst delta-ronde": de drie MINORs van ronde 4 gaan alsnog in het plan (revisie 7), met één delta-review door Codex vóór de ceremonie. De claude-sessie schreef de wijziging, dus reviewt de andere modelfamilie. De tabel "Landt bij de ceremonie in" hierboven is daarmee vervangen door revisie 7.

## Delta-ronde 1: revisie 7 (`2895f254739f7d5a289d78f08ea5878d90c9b767`)

**Pins:** `plan` @`2895f254`, sha256 `c2e20f75c4af3c93c83b9bf1f18bb5ca2bf4676c9d2fd5c43e5018d5e2ba49ad`, 63 361 tekens; `plan-rev6` @`36baadf7`, sha256 `80ddacb015c6b7553b15f2c57ebebbfd90221851287cbc65bf3dd92a3bae5d54`. Repository: `agent-harness@2895f254`. Eén reviewer, de andere modelfamilie dan de auteur.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `0252dee1-bf64-435d-82ef-dc63c0608c18` | `b06e51a4-7909-4474-a3b9-6c2559773a39` | `8900c30d-4061-4c06-bacd-d07ced499305` | linked (PLAN) | **NO-GO** 0/1/0 |

**C4-m2 en C4-m3 houden.** De vier fakes bestaan met deze signaturen, en `seedProbe` schrijft waar `checkProbeForJob` leest. Via `over` op `configurations` kan een test hosted kiezen. `runMain` is een private helper: de nieuwe testfile bouwt dat wrappertje na ("zoals" staat dat toe). De C4-m3-zin klopt voor beide takken van retry-client.ts:117 en zet geen meting in de catch. X-M1, X2-M1 en X3-M1 blijven dicht. Er zijn geen restanten van `probe.ts`, "via spawn" of "deadline al verstreken".

| # | Bevinding | Oordeel | Remedie (revisie 8) |
|---|---|---|---|
| D1-M1 | De deadlinevariant in S1-6 zet de klok door in een sleep die nooit draait. Met `maxRetries` 3 (retry-client.ts:16, :78) gaat de derde drop nog door `onRetry` (:85). De guard gooit CostStopError vóór de sleep (:88). Zonder verlopen klok wordt het failed/MODEL_ERROR, en via de override limiet met COST_LIMIT_EXCEEDED. Daarnaast is "niet limiet" fout: mapReviewStatus regel 2 (plan:300, spec §4.1) maakt van timed_out limiet | Aanvaard; beide punten zijn tegen de tree en het plan gecontroleerd | S1-6: "deadlinevariant: de nepclient zet de klok van `deps.now` voorbij de deadline vlak vóór hij antwoord 3 teruggeeft, niet in `deps.sleep` (na de derde drop volgt geen wachttijd): `complete()` 3×, `usage.costUsd` 1.20, runStatus `timed_out`, status `limiet` en geen `error`". De catch ziet de verlopen klok (run.ts:373), en de override voor alleen MODEL_ERROR laat timed_out staan |

**Scope-delta d1.** Geen; één testregel is vervangen. Het eerste bruikbare resultaat en de praktijkproef blijven gelijk. Revisie 8 heeft 63 487 tekens, en S1-6 6 699.

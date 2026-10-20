---
title: "Agent-harness M8 — remote modellen op een echte review (review-bench)"
status: draft
last_updated: 2026-10-20
revision: 2
---

# Agent-harness M8 — remote modellen op een echte review (review-bench)

Voor IDEA-270. De grill met JP vond plaats op 2026-10-20 (ProductDoc `GRILLS/idea-270-grill`, revisie 2). Alle besluiten in §2 zijn van JP. De inventarisatie in §3 is gemeten aan de dispatch-run-logs van scrum4me-server.

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "Ik wil meerdere remote modellen gaan testen met de review taak (Queue-review)… eerst een aantal modellen uittesten met minimaal 128k context."

**Vraag van M8.** Kan een remote model met minstens 128k context een echte Scrum4Me-review (`QUEUE_REVIEW`) net zo goed doen als de huidige reviewers? En wat kost dat? De huidige reviewers zijn Claude Code met `claude-sonnet-5-5` en Codex met `gpt-6.1-sol`.

**Eerst bruikbare resultaat:** het rapport `llm-bench/results/review-bench-<datum>.md` in de max2-repo.
- Het bevat 24 runs: 8 modellen × 3 runs.
- Alle runs gaan over één bevroren case: de spec-review van ronde 5 van MacSearch IDEA-263 (§4.2).
- Elke run is gescoord met de rubric (§4.6).
- Per model staat er een oordeel volgens de beslisregel (§1, hieronder).

**Eerste praktijkproef:** halverwege het increment (§4.8, stap 6). Op max2 draaien twee runs via LiteLLM: `qwen3.8-or-128k` en de controle `claude-sonnet-5.5-or`. De proef bewijst drie dingen voordat de 24 runs starten:
- dat de prompt, de tools en de validator werken;
- wat een run echt kost;
- of de controle de bekende MAJOR vindt.

**Beslisregel per model.**
- Een run **voldoet** als:
  - de harness een geldige `DispatchResult` aanvaardt (§4.4);
  - `outcome` `succeeded` is. Een `failed` resultaat is in productie een mislukte job, ook met een verdict (`prompt` regel 47; `completion.ts:64-70`);
  - het verdict `NO-GO` is;
  - F1 gevonden is als MAJOR of BLOCKER;
  - er geen extra MAJOR of BLOCKER is die JP ongeldig verklaart.
- **Kandidaat:** 3 van de 3 runs voldoen. **Twijfel:** 2 van de 3. Anders **valt het model af**.
- Kosten en tijd staan in het rapport, zonder drempel.
- **Geldigheid van de bench.** Is geen van beide harness-controles (`claude-sonnet-5.5-or` en `gpt-6.1-sol-or`, via de harness) kandidaat, dan luidt het oordeel voor alle modellen **onbeslist: runtime**. Het verschil met de productie-reviewers ligt dan aan de harness: de prompt, de tools, of het ontbreken van Claude Code en de Codex CLI eromheen. Dat wordt eerst onderzocht, en de open modellen worden nog niet beoordeeld.

**Niet-doelen:**
- **Een productie-runner voor `QUEUE_REVIEW`.** HARNESS kan die jobs niet claimen (§3). Dat wordt een eigen idee, als M8 een kandidaat oplevert.
- **Wijzigingen aan dispatch, scrum4me-mcp, -shared of -docker.**
- **Skills in de harness.** Er zijn er nul gebruikt (§3).
- **Shell, git en code lezen.** De case is een review van alleen een document.
- **Andere cases:** plan r4 (contextdruk) en ISS-2 (code lezen).
- **Nieuwe open-weight modellen** (kimi, gpt-oss).
- **Een judge-model.** M5-besluit 4 scoorde alleen met automatische checks. M8 scoort met de hand, volgens een rubric (besluit 6), en ook zonder judge-model.
- **Een test die 128k context vraagt.** De minimale 128k is een eis aan de modelkeuze. De case zelf blijft ver onder het venster: Claude Code piekte op ~56k, waarvan ~18k de vaste basis van de CLI. Het rapport zet `peakInputTokens` naast het venster.
- **Gedrag van de productie-worker.** Er komen drie configuraties bij, maar `runTaskJob`, `runIdeaChatJob` en `runAgentChatJob` veranderen niet.

## 2. Besluiten

| # | Vraag | Besluit (JP, 2026-10-20) |
|---|---|---|
| 1 | Doel | Een offline review-bench. Productie valt erbuiten. |
| 2 | Case | Alleen de spec-review van ronde 5 van MacSearch IDEA-263. |
| 3 | Tools en uitvoer | Drie read-only tools zonder shell. Het eindantwoord is JSON en wordt gevalideerd, met één herhaalvraag. De prompt is de echte `review.md`, minimaal aangepast. |
| 4 | Route | LiteLLM op max2, dezelfde route als de productie-harness. |
| 5 | Modellen | De vijf bestaande open modellen, plus `gpt-6-luna`, `claude-sonnet-5.5` (controle) en `gpt-6.1-sol` (controle). |
| 6 | Score | Een rubric zonder judge-model. Extra MAJORs en BLOCKERs: Claude stelt een oordeel voor, JP beslist. |
| 7 | Budget | 3 runs per model. Plafond $1 per run en $10 voor de hele bench. |
| 8 | Increment | Eén increment, verdeeld zoals bij M7. De rookproef komt vroeg. |
| 9 | Beslisregel | Zie §1. |

## 3. Uitgangssituatie (gemeten)

**Zo draait een `QUEUE_REVIEW` nu.**
- De supervisor in `scrum4me-docker` claimt de job via `/dispatch/v1/attempts/claim`.
- Hij start een container:
  - `--read-only --network none --cap-drop ALL`;
  - de mappen `/sources` (de gepinde docs plus `__dispatch_input`), `/work` (een checkout op `base_sha`, of leeg) en `/output`;
  - egress alleen naar de modelgateway.
- **Claude-slot:** `claude -p` met de tools `Read,Glob,Grep,Bash,Write,Edit`, en `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.
- **Codex-slot:** `codex exec --sandbox danger-full-access -c project_doc_max_bytes=0`.
- **De prompt** is `scrum4me-mcp src/prompts/queue/review.md`: commit `e89c0961`, sha256 `f56fe0a6…4ead`, 48 regels. `$PAYLOAD_PATH` wordt vervangen door `/tmp/payload.json` (`dispatch-child.ts:78-80`).
- Er is geen MCP, er zijn geen skills, en er is geen max-turns- of kostenplafond.

**Hoe productie het resultaat aanneemt.**
- `finalizeChildResult` (`scrum4me-docker lib/dispatch-child.ts:197-222`; het bestand is laatst gewijzigd in `75d2888` en gelezen op HEAD `78e7347d`) controleert in deze volgorde:
  1. `/output/result.json` is een gewoon bestand van hooguit 256 KiB.
  2. JSON en het strikte `dispatchResultSchema` (`scrum4me-shared lib/queue-dispatch-validation.ts:117-124`, commit `7c41ddc`).
  3. Bij een review moet `review` aanwezig zijn, ook bij `outcome: failed`. `canonical(review.documents)` moet gelijk zijn aan `canonical(input.review_documents)`: de volgorde van sleutels telt niet, de volgorde in arrays wel.
  4. Daarna scrubt hij geheimen en schrijft hij de documenten byte-voor-byte terug.
  - Elke fout geeft `DISPATCH_CHILD_RESULT_INVALID`.
- De service (`scrum4me-mcp src/dispatch/completion.ts:64-80`) **kijkt niet naar `checks`**. De bronverificatie loopt via afleverbewijzen van de supervisor (`source_delivered`), niet via de evidence die het model opgeeft.
  - *Correctie op de grill:* daar stond dat de evidence in `checks` met de sha256 moest kloppen. Dat staat alleen in de prompt en wordt nergens afgedwongen.

**Verbruik in de MacSearch IDEA-263-loop** (28 jobs, 2026-10-16):
- Claude-spec (n=5): piek 57k context, waarvan ~18k de vaste basis van de CLI; 5 turns; $0,33–0,48.
- Codex-spec: ≈ $0,10.
- Gebruikte tools: bestanden lezen, `diff`, `sha256sum`, en een python-heredoc voor `result.json`.
- Niet gebruikt: git, tests, MCP en web. Er waren 0 skill-aanroepen.

**Wat de harness nu kan.**
- `harness task-bench` (M7) bestaat. Herbruikbaar daaruit:
  - `createRetryingClient` (`bench/retry-client.ts:74`);
  - de `afterAnswer`-hook (`run.ts:10-13`, `:434-440`);
  - de vorm van `bench-result.json` (`task-bench.ts:42-60`);
  - `withStopSignals` en `readJsonConfig` (`cli.ts`).
- De werktools staan in `worker/task-tools.ts`.
  - `createTaskTools` (`:553`) geeft altijd alle zes tools. Daarvan schrijven er twee (`write_file`, `edit_file`), en `run_tests` start de verify-container.
  - `tools.allow` wordt voor registries in het proces niet afgedwongen. Er is dus een eigen factory nodig.
  - `listFiles` (`:193`), `readFile` (`:234`) en `search` (`:389`) zijn losse functies in de module.
- `createCostGuard` (`cost.ts:77`) bestaat, maar de bench gebruikt hem niet.
- De probe-gate `checkProbeForJob` (`worker/probe-gate.ts:114`) bestaat.

**Productieroute.** HARNESS kan `QUEUE_REVIEW` niet claimen. In deze repo is dat te zien aan `worker.ts:123-137`: die routeert alleen `TASK_IMPLEMENTATION`, `AGENT_CHAT` en `IDEA_CHAT`. De blokkades in de andere repo's (claimfilter, runtime-enums, enqueue, resolver, kind-prompts) staan in de inventarisatienotitie van de grill (IDEA-270). Ze zijn informatief, geen eis voor M8.

## 4. Opzet

### 4.1 `harness review-bench`

```
harness review-bench --case <map> --config <harness.json> --configuration <naam> --probe-dir <map>
                     --label <label> --out <map> --api-key-env <VAR>
```

**Wat de vlaggen leveren.**
- **Het model komt uit de worker-config**, net als bij de worker:
  - `litellm.baseUrl` als base URL;
  - de configuratienaam als modelnaam;
  - `reasoningEffort` en `extraBody` van de configuratie;
  - `costMode`, voor de kostenbewaking.
- Zo draait de bench precies de configuratie die productie zou draaien, inclusief het provider-blok van LiteLLM.
- `--api-key-env` levert de masterkey van LiteLLM, met dezelfde regels als `worker`.
- **CLI-aanpassingen.** `cliArgsConfig` is `strict` (`cli.ts:42-66`), dus `--probe-dir` en de andere nieuwe sleutels moeten daar bij. `withStopSignals` (`:517`) noemt in zijn melding "task-bench", en `requiredValues` (`:556`) is getypeerd op `TASK_BENCH_FLAGS`. Beide worden gegeneraliseerd, zonder gedragswijziging voor task-bench.

**Probe-gate.**
- `checkProbeForJob(config, <probe-dir>, <naam>)` controleert vóór elke modelaanroep.
- De bench schrijft zelf geen probes. Op max2 is `--probe-dir` `/var/lib/agent-harness/runs`, waar `harness_probe` schrijft.
- Faalt de gate, dan is de status `benchfout` met `CONFIGURATION_NOT_PROBED: <reden>`, zonder modelaanroep en zonder kosten.

**De case** (§4.2) wordt geladen en geverifieerd:
- elk bestand tegen zijn sha256 in `case.json`;
- de payload tegen de lijst `sources`.
- Een afwijking is een `benchfout` met `CASE_INVALID: <bestand>`, nog vóór de run-map.

**Werkmap.** De harness kopieert `payload.json` en `sources/` naar een verse `<run>/root/`. De tools zien alleen die map.

**Limieten** komen uit `case.json` (`limits`).
- `contextTokens` komt **uit de case en niet uit de configuratie**: 131072, terwijl de bestaande deployments op 65536 staan.
- Een case zonder `contextTokens` wordt geweigerd: `read_file` met `offset`/`limit` heeft geen eigen grens, en alleen het venster begrenst dat.

**Kostenbewaking.** `createCostGuard({ mode: costMode, ceilingNanos: <case.maxCostUsd>, configuration })`.
- Bij `hosted` geeft een antwoord zonder bedrag `COST_UNKNOWN`.
- Bij het plafond met openstaande tool-aanroepen of een herhaalvraag geeft het `COST_LIMIT_EXCEEDED`.
- Het plafond is zacht: een eindantwoord kan erover gaan, en afgebroken aanvragen worden wel betaald maar niet geteld. Daarom houdt de driver een eigen grootboek (§4.7).

**Modelclient.** `createRetryingClient` met herhaling bij tijdelijke fouten, zoals in M7: netwerk, 408, 429 en 5xx, tot 3 keer. Weggevallen kosten telt `withDroppedCost` erbij.

**De run.**
- `runManifest` met profiel `tools`, de read-only registry (§4.3), de prompt (§4.5) als enige user-bericht en geen systeemprompt. Zo staat de prompt, net als bij `claude -p`, zelf aan het begin.
- `afterAnswer` is de validator (§4.4).

**`bench-result.json`** (in `<out>/<caseId>-<label>-<hex8>/`, naast `trace.jsonl`):
- `caseId`, `label`, `runId`, `configuration` (`name`, `costMode`, `reasoningEffort`), `contextTokens`;
- `status` en `runStatus`, `error?`;
- `result`: de aanvaarde `DispatchResult`, of `null`;
- `validation`: het aantal pogingen en de foutmeldingen;
- `usage`: tokens in, uit, cache-read, reasoning en `costUsd`;
- `peakInputTokens`: het grootste `inputTokens` van één respons;
- `turns`, `toolCalls`, `toolErrors`, `providers[]`, `retries[]`, `durationMs`, `benchError?`.

**Status** (eigen mapping, geen `mapStatus` van M7). De regels gelden in volgorde:
1. `benchfout`: de case of gate faalde, er is geen run, of `MODEL_ERROR`, `HARNESS_ERROR`, `TOOL_NOT_AVAILABLE` of `COST_UNKNOWN`.
2. `limiet`: `budget_exceeded`, `timed_out`, `TOO_MANY_TOOL_ERRORS`, `CONTEXT_EXHAUSTED` of `COST_LIMIT_EXCEEDED`.
3. `resultaat_ongeldig`: `failed` met `REVIEW_RESULT_INVALID`.
4. `beoordeeld`: `completed` met een aanvaarde `DispatchResult`, ongeacht het verdict en ongeacht `outcome`. Of de run voldoet, beslist de scorer (§1): die eist ook `outcome: succeeded`.
5. Al het andere: `benchfout`.

**Exitcode.** Exit 0 als `bench-result.json` geschreven is, ongeacht de status. Anders exit 1, zoals bij task-bench.

### 4.2 De case (max2 `llm-bench/review_bench/cases/macsearch-idea263-spec-r5/`)

| Bestand | Inhoud | Bewijs |
|---|---|---|
| `case.json` | id, `prompt` en `payload` (elk een bestand plus sha256), `sources[]` (key, bestand, sha256), `limits`, `contextTokens: 131072`, `maxCostUsd: "1"` | — |
| `review.md` | de productieprompt, onveranderd | sha256 `f56fe0a641ddb007e5216a2063b02460e60b9836c08cbc2229d8f8661fee4ead`, commit `e89c0961` |
| `payload.json` | `{dispatch:{input, source_artifacts}}` van de **Claude-job** `1a78c1b8` (6942 B): het paar dat bij `review.md` hoort | structureel gecontroleerd. Productie legde geen hash vast; de bevroren kopie krijgt nu sha256 `5a52a843cbca3f20cf9a6026a7764450b29217980aba4c9b70219c675aff4f8f` in `case.json` |
| `sources/doc` | spec revisie 5 (30 673 B) | sha256 `7d5e35872c417a5656ef53794aff95675f3ac0716f6e3c46951d509f029fadaf` = payload = `sha256sum` in het log |
| `sources/__dispatch_input` | `canonicalDispatchInput` van de input (6705 B) | sha256 `9f6580562a3d9847e49a82697782219f22ef949d4d1a4396040106b25aaef9e3` = `source_artifacts` |
| `ref-result-claude.json`, `ref-result-codex.json` | de productieresultaten, gereconstrueerd uit de logs | NO-GO 0/1/6 en NO-GO 0/2/2 |
| `rubric.md` | F1, F2, M1–M6 met hun herkenningscriteria (§4.6) | het review-record van r5 |
| `SOURCE.md` | de herkomst: job-ids, slot-ids, logpaden, hashes en de reconstructiestappen | — |

- **Opslag.** De case bevat de tekst van een private MacSearch-spec en staat daarom alleen in de private max2-repo, zoals de M7-cases. In agent-harness komen alleen synthetische testfixtures.
- **Logs.** De gekopieerde run-logs komen in geen enkele repo.
- **Payload onveranderd.** De `objective` in de payload is de rondebody van productie. Daarin staat "Write only scratch files under `/tmp/`". De bench zet die tekst niet om: het is wat de productie-reviewers zagen, en zonder schrijftools heeft hij geen effect. `SOURCE.md` vermeldt dit.
- **Limieten** in `case.json`:
  - `maxTurns: 30`;
  - `maxOutputTokens: 64000`, over de hele run (Claude gebruikte er hooguit 26k).
    - Het is ook de bovengrens van `max_tokens` per aanvraag (`run.ts:338-355`).
    - Op 64 000 valt van de FP8-endpoints alleen dat van deepseek-v4-pro met een maximum van 16 384 af. De endpoints met 65 536 blijven bruikbaar (OpenRouter, 2026-10-20).
    - Op 96 000 zouden ook de endpoints met 65 536 afvallen.
  - `maxWallSeconds: 1800`, het harde stoppunt van productie;
  - `maxToolErrors: 8`.

### 4.3 Read-only tools

**Factory.** `createReadOnlyTools({ root })` geeft `list_files`, `read_file` en `search`.
- Ze hebben precies de definities, limieten en padregels van `createTaskTools`:
  - `resolvePath` met containment via `realpath`;
  - `.git`-segmenten en symlinks als laatste component geweigerd;
  - 300 regels voor `list_files`;
  - 20 000 tekens voor `read_file` zonder `offset`/`limit`;
  - 100 treffers en een worker-thread voor `search`.
- `createReadOnlyTools` is een zusterfunctie in `task-tools.ts`:
  - ze hergebruikt `listFiles`, `readFile`, `search` en de drie bijbehorende definities uit `TOOL_DEFS`;
  - `createTaskTools` en de padbewaking blijven ongewijzigd, ook de foutteksten (die noemen "worktree");
  - de bestaande tests blijven ongewijzigd groen.
- **Waarom een factory en geen filter:** met een filter over `createTaskTools` blijven de schrijfpaden achter de registry bestaan. `allow` wordt niet afgedwongen (§3).
- **Geen dekkingsmeting in M8.** Een omhulsel rond `read_file` zou meten vóór `runManifest` het resultaat aan het venster aanpast (`run.ts:492-510`), dus niet wat het model echt zag. De trace bevat de argumenten van elke `tool_call` en de `tool_window`-events, zodat dekking later uit de trace te berekenen is.

### 4.4 Validator (`afterAnswer`)

De validator speelt de controles van `finalizeChildResult` na. De stappen gelden in volgorde:

1. **Het antwoord** is precies één JSON-object.
   - Eén omringende fence ` ```json … ``` ` wordt geaccepteerd. Tekst buiten het object of buiten de fence niet.
   - In productie staat het object in een bestand, dus een fence is daar geen issue.
2. **Hooguit 256 KiB** UTF-8.
3. **Het strikte `dispatchResultSchema`.**
   - Het schema is gekopieerd uit scrum4me-shared (commit `7c41ddc`, `queue-dispatch-validation.ts:117-124`, en `queue-review-documents.ts:56-69` voor `reviewDocumentsSchema`).
   - Het staat in `src/bench/dispatch-result.ts`, met een kopregel die de bron en de commit noemt.
4. **`review`** is aanwezig.
5. **`canonical(review.documents)`** is gelijk aan `canonical(payload.dispatch.input.review_documents)`, met dezelfde `canonical` als productie: sleutels gesorteerd, de volgorde in arrays telt.

**Uitkomst.**
- **Goed:** `ok`, en het object gaat naar `result`.
- **Fout bij de eerste poging:** `retry` met de foutmelding. Dat is het zod-pad, of "review.documents wijkt af van de input", plus de regel "Antwoord alleen met het gecorrigeerde JSON-object."
- **Fout bij de tweede poging:** `fail` met code `REVIEW_RESULT_INVALID`.
  - De union van `fail` in `run.ts:13` en `ErrorCode` in `types.ts` krijgen die code erbij.
  - De bestaande code `VERIFY_FAILED` blijft ongewijzigd.

**Bewust niet gecontroleerd:** de evidence van `checks`. Productie controleert die niet (§3), dus een fout daarin is geen ongeldig resultaat. De scorer telt het wel apart.

**Bekende interacties.**
- Een eindantwoord met `finishReason: length` geeft `budget_exceeded` en komt nooit bij de validator (`run.ts:414-415`).
- Een herhaalvraag kost een turn.

### 4.5 De prompt

`adaptReviewPrompt(original)` (`src/bench/review-prompt.ts`) voert een vaste lijst exacte vervangingen uit. Elke vervanging heeft een verwacht aantal treffers. Klopt een aantal niet, dan gooit de functie een fout: de prompt is dan veranderd, en de bench draait niet.

| # | Regel | Van | Naar |
|---|---|---|---|
| A1 | 5, 7 | `$PAYLOAD_PATH` (2×) | `payload.json` |
| A2 | 9 | `` `/sources/<key>` `` en `` from `/sources` `` | `` `sources/<key>` `` en `` from `sources/` `` |
| A3 | 11, 18 | `` `/work` `` (3×) | `` `work/` `` |
| A4 | 17 | ``Everything is read-only except `/output`.`` | ``Everything is read-only. Your tools are `list_files`, `read_file` and `search`; paths are relative to your workspace root (`payload.json`, `sources/<key>`).`` |
| A5 | 30 | ``Write exactly one file, `/output/result.json`, as a `DispatchResult`:`` | ``Give your final message as exactly one JSON object, a `DispatchResult`, and nothing else:`` |
| A6 | 48 | `Write the manifest last, and write it even when you could not finish.` | `Give the manifest as your last message, and give it even when you could not finish.` |

**Wat bewust blijft:**
- regel 1 ("runtime: CLAUDE", "sealed, read-only container"): `payload.json` draagt ook `runtime: CLAUDE`;
- regel 18 (het pakketregister), afgezien van `/work` (A3);
- alle regels over het oordeel.

**Test.** Op een fixture-kopie van de echte prompt (`__tests__/fixtures/queue-review.md`, met dezelfde sha256) zijn na de aanpassing alle regels buiten A1–A6 byte-gelijk aan het origineel, en is de uitkomst gelijk aan een vastgelegde verwachting. De prompt is een productieprompt van de reviewer en bevat geen private inhoud.

### 4.6 Modellen, configuratie en score

**Modellen.** Alle configuraties draaien met `costMode: hosted` en de case-waarde `contextTokens: 131072`.

| Configuratie | OpenRouter-model | Precisie | reasoningEffort | Status |
|---|---|---|---|---|
| `qwen3.8-or-128k` | `qwen/qwen3.8-27b` | BF16 | medium | bestaat |
| `deepseek-v4-flash-or` | `deepseek/deepseek-v4-flash` | FP8 | high | bestaat |
| `deepseek-v4-pro-or` | `deepseek/deepseek-v4-pro` | FP8 | high | bestaat |
| `glm-5.3-or` | `z-ai/glm-5.3` | FP8 | high | bestaat |
| `minimax-m3-or` | `minimax/minimax-m3` | FP8 | — | bestaat |
| `gpt-6-luna-or` | `openai/gpt-6-luna` | — | medium (standaard van het model) | nieuw |
| `claude-sonnet-5.5-or` | `anthropic/claude-sonnet-5.5` | — | high, zoals productie | nieuw (controle) |
| `gpt-6.1-sol-or` | `openai/gpt-6.1-sol` | — | medium, zoals productie | nieuw (controle) |

**Nieuwe configuraties in `deploy/max2`.**
- In `harness.json` krijgen ze `contextTokens: 131072`.
- In `config.yaml` krijgen ze `model_info: { supports_reasoning: true }` (ISS-5) en een nieuw anker `or-proprietary-extra`:
  - `data_collection: deny`, `require_parameters: true`, `allow_fallbacks: true`, `sort: price`;
  - geen `quantizations`;
  - `max_price` prompt 3 en completion 12, want sonnet en sol kosten $2 → $10 en vallen dus boven de FP8-grens van 2/5.
- Het bestaande anker `or-fp8-extra` blijft drie keer gebruikt. De test die dat vastlegt (`deploy-max2.test.ts:62`) blijft geldig.
- De lijst met namen en de waarden per configuratie in die test krijgen de drie erbij.

**Score.**
- **De scorer** (`llm-bench/review_bench/score.py`) maakt per run een blind scoreblad: alleen `report_markdown` en `summary`, onder een willekeurige id. De koppeling met het model staat apart.
- **Claude** vult daarna per blad `scores.jsonl` volgens `rubric.md`:
  - `f1`: `major` | `minor` | `nee`;
  - `f2`: `major` | `minor` | `nee`;
  - `minors`: een lijst uit M1–M6;
  - `extra`: elke andere BLOCKER of MAJOR, met een `key`, een voorstel `geldig` of `ongeldig` en één zin reden. De `key` is een korte genormaliseerde naam van de onderliggende bevinding (bijv. `x-temp-path-race`). Dezelfde bevinding in een andere run of bij een ander model krijgt dezelfde `key`.
- **JP** beslist één keer per `key` (`decisions.json`: `key` → `geldig` | `ongeldig`). Die beslissing geldt voor alle runs met die `key`.
- `score.py` voegt daarna `scores.jsonl`, `decisions.json` en de `bench-result.json`'s samen en past de beslisregel van §1 toe, inclusief `outcome: succeeded` uit `result`. Een `extra` zonder beslissing houdt het oordeel van dat model op "open".

**Herkenning volgens het review-record van r5:**
- **F1:** de crash- of startup-cleanup verwijdert een vastgelegd pad zonder identiteitscontrole, zodat een vreemd bestand op dat pad weg kan. Of de cleanup draait maar één keer, zodat een half bestand blijft staan. Eén van beide kernen telt.
- **F2:** route C herhaalt (`EEXIST`) voordat er een record bestaat. Dat botst met de algemene herhaalregel.
- **M1–M6:**
  - M1: herhaalbare startup-cleanup;
  - M2: een mislukte update `temp_path = NULL`;
  - M3: crash-tests via het foutpad;
  - M4: de capability-validbit en `EXDEV`;
  - M5: AppleDouble-sidecars;
  - M6: de formulering van de datum in F15.

### 4.7 Driver (`llm-bench/review_bench/run.py`, max2)

**Overgenomen uit `task_bench/run.py`**, met de standaardbibliotheek en `unittest`:
- het grootboek;
- `probe_cost`;
- `StopFlag`, `Harness.call` en `check_budget`;
- hervatten;
- één herhaling bij een `benchfout`. Is de tweede poging ook een `benchfout`, dan stopt de driver en beslist JP.
- de exitcodes.

**Niet overgenomen:**
- de controle `on_openrouter` en het ophalen van de endpointlijst: de pin staat in `config.yaml`;
- `PINNED_QUANTIZATIONS`.

**Preflight.** Vóór de rookproef stuurt `run.py --preflight` per configuratie één aanvraag naar LiteLLM, met de standaardbibliotheek:
- `max_tokens` 64 000, de echte grens van de case (§4.2);
- de `reasoning_effort` van de configuratie;
- één dummy-tool;
- de opdracht "Antwoord alleen: OK".

De preflight bewijst per configuratie dat er onder `max_price`, `data_collection: deny` en `require_parameters` een endpoint is dat deze aanvraag aanneemt. De probe bewijst dat niet: die gebruikt kleine aanvragen. Een configuratie die faalt, valt uit de bench (rapport) vóór er een venster loopt. De kosten tellen in het grootboek.

**Volgorde.** De runs wisselen per ronde over de modellen: ronde 1 draait alle 8, daarna ronde 2, daarna ronde 3. Zo vallen storingen die van het tijdstip afhangen niet steeds op hetzelfde model.

**Budget.** `--budget <USD>` is het plafond voor dit venster.
- Het is het minimum van de $10 van de bench en (het resterende tegoed van de OpenRouter-sleutel − $2 marge).
- Voor de start leest JP het tegoed op het OpenRouter-dashboard af. De sleutel is dezelfde als die van productie: raakt hij leeg, dan vallen ook de hosted productieconfiguraties uit.
- Het grootboek telt `costUsd` uit elk `bench-result.json`, ook van benchfouten. `check_budget` stopt vóór een run die het plafond zou overschrijden, met dezelfde vooruitschatting als M7.

**Sleutel.**
- De masterkey van LiteLLM staat op max2 in `/etc/agent-harness/harness-litellm.env` (`root:root 0600`).
- Aan het begin van het venster zet JP hem met `sudo` in `/run/user/1000/m8-litellm.key` (`umask 077`). Het run-script leest hem één keer in als `LITELLM_MASTER_KEY`.
- Na het venster verwijdert JP het bestand.
- De waarde staat nooit in argv, een log, een trace, een resultaat of een repo.

### 4.8 Volgorde

1. **agent-harness:**
   - `createReadOnlyTools`;
   - de validator en het gekopieerde schema;
   - `adaptReviewPrompt`;
   - de case-lader;
   - `harness review-bench`, met de CLI-generalisatie van §4.1;
   - `REVIEW_RESULT_INVALID`;
   - tests;
   - de README.

   Gate: `npm run verify`.
2. **agent-harness:** de drie configuraties in `deploy/max2` met de deploy-test, plus de regels in `harness-service-max2.md` en het README.
3. **max2:**
   - de case met `SOURCE.md`;
   - een controlescript dat alle hashes en de koppeling payload ↔ `sources` opnieuw controleert;
   - `rubric.md`;
   - `run.py` (met `--preflight`), `score.py` en `models.json`, met tests (een nep-harness zoals in M7).
4. **Merge naar `main`** van de agent-harness-wijzigingen (stap 1 en 2), op JP's go.
   - `release-update` bouwt de release van `origin/main` (runbook regel 43). Zonder merge kent productie `review-bench` en de drie configuraties niet.
   - De release brengt ook de nieuwe `createReadOnlyTools`, de uitgebreide `ErrorCode` en de CLI-generalisatie naar productie. Het gedrag van de jobs verandert niet: AC1 en de bestaande tests bewijzen dat.
5. **Release en herprobe op max2,** volgens `harness-service-max2.md` ("Upgrade"), in een venster zonder lopende HARNESS-jobs:
   1. `stop-check.sh`;
   2. `harness_release_update`;
   3. `litellm_upgrade`. Controleer daarna `allow` in `/etc/agent-harness/harness.json`: `litellm_upgrade` zet het bestand terug op de kopie uit `current`;
   4. `harness_probe` (alle configuraties);
   5. **Lees elke `probe-<naam>/probe.json`, ook als de actie niet met 0 eindigt.** `--all` geeft exit 0 alleen als alles aanvaard is, dus een afgewezen nieuwe configuratie geeft dezelfde exit als een afgewezen bestaande;
   6. `harness_start` alleen als alle negen bestaande configuraties een actuele aanvaarde probe hebben. Een afgewezen nieuwe configuratie valt uit de bench (rapport) en raakt productie niet.

   **Terugzetten**, als een bestaande configuratie niet meer aanvaard wordt: stop, en JP. De volgorde is `harness_release_rollback` → `litellm_upgrade` (die zet de bestanden uit de vorige `current` terug en maakt de container opnieuw) → `allow` controleren → `harness_probe` → per configuratie lezen → `harness_start`. Alleen `harness_release_rollback` volstaat niet: dan draait LiteLLM door met de nieuwe `config.yaml`, en de probe faalt opnieuw.
6. **Preflight** (§4.7) voor alle acht configuraties, daarna de **rookproef** (op JP's go): `qwen3.8-or-128k` en `claude-sonnet-5.5-or`, één run elk, ≈ $0,50.

   Doorgaan als:
   - geen van beide runs `benchfout` is. `limiet` en `resultaat_ongeldig` van qwen zijn modelgedrag, geen fout van de bench;
   - de sonnet-run `beoordeeld` is, met `outcome: succeeded`, verdict `NO-GO` en F1 als MAJOR of BLOCKER. De beoordeling van extra bevindingen volgt pas bij het scoren.

   Anders: stop en JP. Dat is juist het signaal waar de controle voor is (§1). De runs van de rookproef tellen niet mee in de 24.
7. **De 24 runs** (op JP's go), in één of meer vensters.
8. **Scoren:** blinde bladen, Claude vult in, JP beslist één keer per `key`, en `score.py` maakt het rapport.

### 4.9 Het rapport (`llm-bench/results/review-bench-<datum>.md`, max2)

- **Hoofdtabel.** Per model:
  - het oordeel;
  - de runs die voldoen;
  - de verdicts;
  - F1 en F2 per run;
  - het gemiddelde aantal minors;
  - de extra MAJORs (geldig of ongeldig);
  - gemiddelde en maximale kosten;
  - tokens en piekcontext;
  - wandtijd en turns;
  - toolfouten;
  - `outcome`.
- **Venster:** `peakInputTokens` naast de 131072 van het venster, zodat duidelijk is hoeveel context de case echt vroeg.
- **Eerste vergelijking:** de open modellen tegenover de **harness-controles**.
- **Context, als aparte rijen:** de productieruns `1a78c1b8` (Claude Code, $0,39) en `7146cbe9` (Codex CLI, ≈ $0,10).
- **Verder:** het venster of de vensters, het grootboek, de probe-uitslagen, afwijkingen en wat het oordeel betekent voor een vervolgidee (productie-runner).

## 5. Acceptatiecriteria

1. **Read-only.** De registry van `createReadOnlyTools` biedt precies `list_files`, `read_file` en `search`.
   - Een aanroep van `write_file`, `edit_file` of `run_tests` geeft `UNKNOWN_TOOL`.
   - Een pad buiten de root, via `..` of een symlink, wordt geweigerd.
   - `createTaskTools` is ongewijzigd: de diff raakt die functie en de padbewaking niet, en de bestaande tests blijven ongewijzigd groen.
2. **Validator.** Een geldig productieresultaat wordt aanvaard (een synthetische fixture in de vorm van `ref-result-*`). Elk van de volgende geeft precies één herhaalvraag en daarna `REVIEW_RESULT_INVALID`:
   - tekst rond het object;
   - een onbekende sleutel;
   - een ontbrekende `review` bij `outcome: failed`;
   - `documents` in een andere array-volgorde;
   - een resultaat boven 256 KiB.
   - Een object in één fence ` ```json ` wordt aanvaard.
3. **Prompt.** `adaptReviewPrompt` op de fixture geeft exact de vastgelegde verwachting. Buiten A1–A6 zijn alle regels byte-gelijk. Een prompt met één ontbrekende of extra treffer laat de functie gooien.
4. **Case.** Een gewijzigde byte in `sources/doc`, `review.md` of `payload.json` geeft `CASE_INVALID` zonder run-map. Een case zonder `contextTokens` wordt geweigerd.
5. **Gate en kosten.** Een configuratie zonder aanvaarde probe geeft `benchfout` met `CONFIGURATION_NOT_PROBED` en geen modelaanroep (nepclient). Met een nepclient geeft een antwoord zonder bedrag bij `hosted` `COST_UNKNOWN`, en een totaal boven `maxCostUsd` met openstaande tool-aanroepen `COST_LIMIT_EXCEEDED`.
6. **Statusmapping.** Elke regel van §4.1 heeft een test.
7. **Sleutel.** Een dummywaarde in de variabele van `--api-key-env` staat nergens in stdout, stderr, `trace.jsonl` of `bench-result.json`. De test loopt over paden die de waarde zouden lekken:
   - een nepclient die een `ModelError` gooit met de waarde in de melding;
   - een antwoordbody die de waarde bevat.
8. **Deploy.** `deploy-max2.test.ts` legt de 12 namen vast, en de waarden van de drie nieuwe configuraties, met een eigen anker. `npm run verify` is groen.
9. **max2.** Het controlescript bevestigt alle hashes van de case. De unittests van `review_bench` zijn groen, ook die van `--preflight` met een nep-LiteLLM. Die van `task_bench` blijven groen.
10. **Praktijk.** De preflight en de rookproef (§4.8, stap 6) staan met hun bewijs in het rapport.
11. **Beslisregel.** `score.py` wordt getest met synthetische `bench-result`-, `scores`- en `decisions`-fixtures:
    - 3/3 geeft kandidaat, 2/3 twijfel en 1/3 valt af;
    - een run met `outcome: failed` en `NO-GO` voldoet niet;
    - een extra MAJOR met `key` beslist als `ongeldig` laat de run niet voldoen, en dat geldt in elke run met die `key`;
    - een `extra` zonder beslissing geeft "open";
    - zijn beide controles geen kandidaat, dan is het oordeel voor alle modellen "onbeslist: runtime";
    - een blind scoreblad bevat geen configuratienaam en geen modelnaam. Het rapport heeft 24 runs, of legt per ontbrekende run uit waarom (benchfout, of een configuratie die niet geprobed was).

## 6. Risico's en open punten

- **Productiewijziging.** De herprobe raakt alle 12 configuraties. Die gaat in een venster zonder lopende HARNESS-jobs, met het runbook voor terugzetten.
- **Data.** De MacSearch-spec gaat naar OpenRouter-providers, ook OpenAI, Azure, Bedrock, Google en Anthropic, met `data_collection: deny`. Of een provider aan het filter voldoet, blijkt pas uit de probe en de preflight.
  - Dit wijkt af van M5-besluit 3, waar alleen Agent-harness-docs naar OpenRouter mochten.
  - JP koos in deze grill de MacSearch-case met de route via OpenRouter (besluiten 2 en 4).
- **Kosten van de controles.** Sonnet en sol schatten we op ~$0,35–0,45 per run. De bench zelf heeft geen prompt-cache-strategie, dus de kosten kunnen hoger uitvallen dan in productie. De rookproef meet het.
- **Vergelijkbaarheid.** De harness mist de systeemprompt van Claude Code en die van de Codex CLI. Juist daarom zijn er de controles en de geldigheidsregel (§1).
- **Eén case.** Het oordeel geldt voor een review van alleen een document, met één bekende MAJOR. Een kandidaat is nog geen bewijs voor plan-reviews of reviews met code. Dat staat in het rapport.
- **Scoren door Claude.** De bladen zijn blind, maar Claude scoort ook de output van Claude. JP beslist over elke extra MAJOR. F1 en F2 hebben vaste herkenningscriteria.
- **`provider` via LiteLLM.** Of LiteLLM het veld `provider` op het hoogste niveau doorgeeft, is niet bewezen. Dan blijft `providers[]` leeg. Dat is geen benchfout.

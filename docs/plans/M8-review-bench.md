---
title: "M8 — review-bench: remote modellen op een echte review — implementatieplan"
status: draft
last_updated: 2026-10-20
sprint:
  goal: "M8 review-bench: acht remote modellen draaien elk 3× de spec-r5-review van MacSearch IDEA-263 via LiteLLM op max2, gescoord met de rubric. Het rapport geeft een oordeel per model."
pbi:
  title: "M8 review-bench: remote modellen op een echte QUEUE_REVIEW (IDEA-270)"
  description: >-
    Een offline bench: doet een remote model met ≥ 128k context een echte Scrum4Me-review net zo goed als de huidige reviewers?
    agent-harness krijgt `harness review-bench` en drie configuraties in deploy/max2; de max2-repo de case, rubric, driver en scorer.
    Daarna de praktijkstappen op max2, steeds op JP's go. Spec: docs/specs/2026-10-20-review-bench-design.md revisie 2, dubbel GO
    (86628ea3). Plan: docs/plans/M8-review-bench.md.
  priority: 2
stories:
  - title: "S1 — harness review-bench (agent-harness)"
    description: >-
      Het subcommando `harness review-bench` met read-only tools, validator, prompt-aanpassing, case-lader, kostenbewaking en een
      eigen statusmapping. Daarbij de drie nieuwe configuraties in deploy/max2. Repo agent-harness, branch feat/m8-review-bench.
    acceptance_criteria: >-
      Spec AC1–AC8, aangevuld met de MINORs van ronde 2: C-m1 (gedeelde helper voor weggevallen kosten), C-m6 (de task-bench-teksten
      blijven byte-gelijk, AC1 en AC4 strenger) en X-m3 (geen `checks`-diagnose). `npm run verify` is groen. De bestaande tests van
      task-tools, bench-task-bench en bench-retry-client zijn ongewijzigd en groen. De branch is gepusht naar Forgejo; de PR wacht op
      JP (praktijkstap P1).
    priority: 2
    tasks:
      - title: "createReadOnlyTools: list_files, read_file en search zonder schrijfpad"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench, vanaf `origin/claude/remote-models-review-9a05f5`. Op die branch staan spec, plan en review-records; origin/main heeft ze nog niet. De PR naar main neemt ze mee.
          Spec: docs/specs/2026-10-20-review-bench-design.md §4.3 en AC1. Plan: docs/plans/M8-review-bench.md.

          Doel: een registry met precies drie read-only tools. Ze hebben dezelfde definities, limieten en padregels als in createTaskTools.

          Bestanden:
          - Wijzig src/worker/task-tools.ts. Voeg alleen code toe, ná `createTaskTools`:
            - `export type ReadOnlyToolsOptions = { root: string; searchLimits?: TaskToolsOptions['searchLimits'] }`
            - `export function createReadOnlyTools(opts: ReadOnlyToolsOptions): ToolRegistry`
          - Nieuw: __tests__/task-tools-readonly.test.ts.

          Interfaces:
          - Gebruikt de bestaande module-functies `listFiles(root, realRoot, rawPath)`, `readFile(root, realRoot, args)` en `search(root, realRoot, args, signal, bounds)`, plus `TOOL_DEFS`.
          - Levert `createReadOnlyTools({ root })`. De snapshot bevat precies `list_files`, `read_file` en `search`, gesorteerd. Taak 6 gebruikt dit.

          Opbouw:
          - Filter TOOL_DEFS op de drie namen.
          - Snapshot, hash, `toOpenAiTools`, `execute` en `close` volgen hetzelfde patroon als createTaskTools, met een eigen kopie van die ~20 regels.
          - `execute` kent alleen de drie cases. Al het andere geeft `{ ok: false, errorCode: 'UNKNOWN_TOOL', content: 'tool not in snapshot', truncated: false }`.
          - createTaskTools, resolvePath, de guards en de foutteksten (die "worktree" noemen) veranderen niet. Er komt geen gedeelde helper die createTaskTools raakt.

          Tests (eerst rood):
          - De snapshot-namen zijn exact `['list_files', 'read_file', 'search']`.
          - `write_file`, `edit_file` en `run_tests` geven UNKNOWN_TOOL, en er verschijnt geen bestand.
          - `read_file` met `../buiten.txt` wordt geweigerd. Een symlink in de root naar een bestand erbuiten ook.
          - `read_file` met het absolute pad `/sources/doc` wordt geweigerd en leest niets buiten de root (Review Focus 2).
          - `read_file` met offset/limit op een bestand van meer dan 20 000 tekens geeft het gevraagde stuk. Zonder offset/limit eindigt de uitvoer op `[afgekapt, gebruik offset/limit]`.
          - `search` vindt een regel in `sources/doc`.

          Acceptatie (AC1, C-m6):
          - `git diff origin/main -- src/worker/task-tools.ts` toont alleen toegevoegde regels, allemaal na het einde van createTaskTools.
          - `git diff origin/main --stat -- __tests__/task-tools.test.ts` is leeg, en die test is groen.

          Verificatie: `npx vitest run __tests__/task-tools-readonly.test.ts __tests__/task-tools.test.ts`, daarna `npm run verify`.

          Grenzen:
          - Het productiegedrag verandert niet.
          - In agent-harness komen geen private MacSearch-teksten; fixtures zijn synthetisch.

          Commit: `feat(bench): createReadOnlyTools voor review-bench (M8)`.
      - title: "Gedeelde tracked client: weggevallen kosten en providers (C-m1)"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Spec: §4.1 ("Modelclient"). Review-record ronde 2, C-m1. Plan: docs/plans/M8-review-bench.md.

          Doel: `withDroppedCost` en het bijhouden van weggevallen antwoorden staan nu privé in task-bench.ts (r. 188-199 en 326-351). Ze gaan naar een gedeelde helper, zodat review-bench dezelfde kostentelling krijgt. Het gedrag van task-bench verandert niet.

          Bestanden:
          - Nieuw: src/bench/tracked-client.ts.
          - Wijzig src/bench/task-bench.ts:
            - verwijder de lokale `withDroppedCost`;
            - vervang de wrapper uit r. 326-351 door de helper;
            - `retries`, `providers` en `droppedLastUsd` (r. 259-262) vervallen. Declareer `let tracked: TrackedClient | undefined` vóór de try. Het resultaat (r. 465-467) gebruikt `tracked?.providers ?? []`, `tracked?.retries ?? []` en `withDroppedCost(run?.usage ?? NO_USAGE, tracked?.droppedCosts() ?? [])`, ook op de paden die eindigen vóór de client bestaat.
          - Nieuw: __tests__/bench-tracked-client.test.ts.

          Interfaces (levert, voor taak 6):
          - `export function withDroppedCost(usage: RunResult['usage'], costs: Array<number | undefined>): RunResult['usage']`. De body wordt letterlijk verplaatst.
          - `export class CostStopError extends ModelError { constructor(readonly stop: CostStop) }`, met `super(stop.error.message, { kind: 'invalid' })`. Kind `invalid` is definitief voor de retrying client, en runManifest maakt er MODEL_ERROR van in plaats van te crashen (src/run.ts:374-379).
          - `export type TrackedClient = { client: ModelClient; retries: RetryRecord[]; providers: string[]; droppedCosts(): Array<number | undefined>; costStop(): CostStop | undefined }`
          - `export function createTrackedClient(base: ModelClient, o: { retryTransient: boolean; trace: TraceWriter; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; guard?: CostGuard }): TrackedClient`

          Gedrag zonder `guard` is precies de huidige wrapper (task-bench geeft geen guard mee):
          - met `retryTransient` komt er `createRetryingClient(base, { sleep, onRetry })` omheen; `onRetry` zet het record in `retries`, de provider in `providers`, en schrijft een trace-event `{ type: 'model_retry', ...r }`;
          - een `UnusableAnswerError` telt zijn `costUsd` bij `droppedLast` en zijn provider in `providers`, en gooit opnieuw; een geslaagde respons met `provider` gaat naar `providers`;
          - `droppedCosts()` geeft `[...retries.map(r => r.costUsd), droppedLast]`.

          Met `guard` (review-bench, plan-r1 X-M1). De live guard van runManifest ziet alleen het antwoord dat `complete()` teruggeeft (src/run.ts:330, :404; src/cost.ts:94-109). Een antwoord met finishReason `other` is betaald, maar valt weg in de retry-lus (src/bench/retry-client.ts:112-124). Daarom, in `onRetry`, ná de drie stappen hierboven, alleen voor een record met kind `finish_other`:
          - `stop = guard.afterResponse(dropped) ?? guard.beforeRequest()`;
          - `dropped` is het weggevallen antwoord als CompleteResult: `toolCalls: []`, `usage.costUsd = r.costUsd`, `provider = r.provider`, de rest nul of leeg;
          - bij een stop: bewaar hem voor `costStop()` en gooi `new CostStopError(stop)`. Dat is vóór de wachttijd en vóór de herhaalaanvraag.
          Zo telt elk antwoord één keer in de guard: een weggevallen antwoord hier, het teruggegeven antwoord in runManifest. Een weggevallen hosted antwoord zonder bedrag geeft COST_UNKNOWN, net als elk ander hosted antwoord.

          Tests (eerst rood):
          - Eerst een antwoord met finishReason `other` en `costUsd` 0.01, daarna succes: `retries` heeft 1 record, en `withDroppedCost({..., costUsd: 0.05}, droppedCosts())` geeft 0.06 (`toBeCloseTo`).
          - Een `UnusableAnswerError` met `costUsd` 0.02 en provider `P` geeft `droppedCosts()` met 0.02, en `providers` bevat `P`.
          - Zonder bedragen blijft `usage` ongewijzigd, en `costUsd` blijft afwezig.
          - Zonder `retryTransient` gaat er geen herhaling om de base heen.
          - Hosted guard met plafond "1", drie keer `other` à 0.40. Na de derde komt een CostStopError met COST_LIMIT_EXCEEDED. `base.complete` is 3× aangeroepen, `costStop()` is gezet en `droppedCosts()` telt op tot 1.20.
          - Hosted guard, één keer `other` zonder bedrag: CostStopError met COST_UNKNOWN, en `base.complete` 1×.
          - Zonder guard en vier keer `other`: na 3 herhalingen een UnusableAnswerError, en `base.complete` 4×, zoals nu.

          Acceptatie:
          - `git diff origin/main --stat -- __tests__/bench-task-bench.test.ts __tests__/bench-retry-client.test.ts` is leeg, en beide zijn groen.

          Verificatie: `npx vitest run __tests__/bench-tracked-client.test.ts __tests__/bench-task-bench.test.ts __tests__/bench-retry-client.test.ts`, daarna `npm run verify`.

          Commit: `refactor(bench): gedeelde tracked client voor dropped cost (M8, C-m1)`.
      - title: "DispatchResult-schema, validator en REVIEW_RESULT_INVALID"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Spec: §3 ("Hoe productie het resultaat aanneemt"), §4.4 en AC2. Plan: docs/plans/M8-review-bench.md (X-m3).

          Doel: een `afterAnswer`-hook die de controles van productie (`finalizeChildResult`) naspeelt, met één herhaalvraag.

          Bestanden:
          - Nieuw: src/bench/dispatch-result.ts.
            - Gekopieerd uit scrum4me-shared @7c41ddc:
              - `dispatchResultSchema` (strict), uit lib/queue-dispatch-validation.ts:117-124;
              - `reviewDocumentsSchema`, uit lib/queue-review-documents.ts:56-69;
              - de deelschema's waar die van afhangen.
            - Daarbij `export function canonicalJson(value: unknown): string`, gelijk aan de canonical die finalizeChildResult gebruikt (scrum4me-docker lib/dispatch-child.ts:197-222 @78e7347d): sleutels gesorteerd, undefined weggelaten, arrays in volgorde.
            - Een kopregel noemt per stuk de bronrepo, het pad en de commit.
            - Bronnen: Forgejo `git.jp-visser.nl/janpeter/scrum4me-shared` en `…/janpeter/scrum4me-docker`, lokaal `~/Development/scrum4me-shared` en `~/Development/scrum4me-docker`. Lees met `git -C <clone> fetch origin` en `git -C <clone> show <sha>:<pad>`, nooit een nieuwere versie.
          - Nieuw: src/bench/review-validator.ts.
          - Wijzig src/run.ts r. 13: de `fail`-union wordt `code: 'VERIFY_FAILED' | 'REVIEW_RESULT_INVALID'`.
          - Wijzig src/types.ts: `ErrorCode` krijgt `| 'REVIEW_RESULT_INVALID'`.
          - Nieuw: __tests__/bench-review-validator.test.ts.
          - Nieuw: __tests__/fixtures/review-bench/valid-result.json. Synthetisch, in de vorm van een productieresultaat (`outcome`, `summary`, `report_markdown`, `checks`, `review`), zonder MacSearch-tekst.

          Interfaces (levert, voor taak 6):
          - `export type DispatchResult = z.infer<typeof dispatchResultSchema>`
          - `export const REVIEW_RESULT_MAX_BYTES = 256 * 1024`
          - `export function parseReviewAnswer(answer: string, expectedDocuments: unknown): { ok: true; result: DispatchResult } | { ok: false; error: string }`
          - `export function createReviewValidator(expectedDocuments: unknown): { afterAnswer(answer: string, signal: AbortSignal): Promise<AfterAnswerResult>; accepted(): DispatchResult | undefined; attempts(): number; errors(): string[] }`

          Volgorde en fouttekst van parseReviewAnswer:
          1. Trim de witruimte en een eventuele BOM.
             - Precies één object: de tekst begint met `{` en eindigt met `}`.
             - Of precies één fence `^```json\n…\n```$`.
             - Al het andere geeft `antwoord is niet precies één JSON-object`. Dat geldt ook voor een lege tekst en voor een kale ``` zonder `json`.
          2. De objecttekst is hooguit REVIEW_RESULT_MAX_BYTES UTF-8, anders `resultaat groter dan 256 KiB`.
          3. JSON.parse en dan het schema. Een fout geeft `schema: <pad>: <melding>` per zod-issue, gescheiden door `; `.
          4. `review` ontbreekt: `review ontbreekt`.
          5. `canonicalJson(result.review.documents) !== canonicalJson(expectedDocuments)`: `review.documents wijkt af van de input`.

          createReviewValidator:
          - Een eerste fout geeft `{ kind: 'retry', message: `${error}\n\nAntwoord alleen met het gecorrigeerde JSON-object.` }`.
          - Een tweede fout geeft `{ kind: 'fail', code: 'REVIEW_RESULT_INVALID', message: `resultaat ongeldig na herhaalvraag: ${error}` }`.
          - Een geldig antwoord geeft `{ kind: 'accept' }`.
          - `outcome: failed` met `review` is geldig. De scorer beslist over `outcome`.

          Bewust niet (X-m3: SCHRAP): geen controle en geen telling van `checks` of hun evidence. De regel in spec §4.4, "De scorer telt het wel apart", vervalt in M8.

          Tests (eerst rood):
          - De fixture wordt aanvaard, ook in een ```json-fence en met witruimte of BOM eromheen (Review Focus 1).
          - Elk van deze gevallen geeft precies één herhaalvraag en daarna REVIEW_RESULT_INVALID:
            - tekst rond het object;
            - een onbekende sleutel;
            - `outcome: failed` zonder `review`;
            - `documents` in een andere array-volgorde;
            - meer dan 256 KiB;
            - een leeg antwoord (Review Focus 3);
            - een kale ```-fence.
          - Een fout gevolgd door een geldig antwoord geeft accept, met `attempts()` 2.
          - Een object met andere sleutelvolgorde in `documents` wordt aanvaard.

          Verificatie: `npx vitest run __tests__/bench-review-validator.test.ts`, daarna `npm run verify` (tsc vangt elke uitputtende switch over ErrorCode).

          Commit: `feat(bench): DispatchResult-validator voor review-bench (M8)`.
      - title: "adaptReviewPrompt met getelde vervangingen A1–A6"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Spec: §4.5 en AC3. Plan: docs/plans/M8-review-bench.md.

          Doel: van de productieprompt `review.md` een harness-prompt maken met een vaste lijst exacte vervangingen. Klopt een telling niet, dan gooit de functie een fout.

          Bestanden:
          - Nieuw: __tests__/fixtures/queue-review.md. Dit is de echte prompt: `git -C ~/Development/scrum4me-mcp-stable show e89c0961:src/prompts/queue/review.md` (Forgejo `janpeter/scrum4me-mcp`). Hij heeft sha256 f56fe0a641ddb007e5216a2063b02460e60b9836c08cbc2229d8f8661fee4ead en 48 regels. Bevat geen private inhoud.
          - Nieuw: __tests__/fixtures/queue-review.adapted.md. Maak het één keer met de functie, en controleer het met de hand tegen de tabel.
          - Nieuw: src/bench/review-prompt.ts.
          - Nieuw: __tests__/bench-review-prompt.test.ts.

          Interfaces (levert, voor taak 6):
          - `export const REVIEW_PROMPT_REPLACEMENTS: ReadonlyArray<{ id: string; from: string; to: string; count: number }>`
          - `export function adaptReviewPrompt(original: string): string`

          De vervangingen. De tellingen zijn gemeten op de fixture:
          - A1: `$PAYLOAD_PATH` → `payload.json`, 2×, op r. 5 en 7.
          - A2a: `` `/sources/<key>` `` → `` `sources/<key>` ``, 1×, op r. 9.
          - A2b: `` from `/sources` `` → `` from `sources/` ``, 1×, op r. 9.
          - A3: `` `/work` `` → `` `work/` ``, 3×, op r. 11 en 18.
          - A4: ``Everything is read-only except `/output`.`` → ``Everything is read-only. Your tools are `list_files`, `read_file` and `search`; paths are relative to your workspace root (`payload.json`, `sources/<key>`).``, 1×, op r. 17.
          - A5: ``Write exactly one file, `/output/result.json`, as a `DispatchResult`:`` → ``Give your final message as exactly one JSON object, a `DispatchResult`, and nothing else:``, 1×, op r. 30.
          - A6: `Write the manifest last, and write it even when you could not finish.` → `Give the manifest as your last message, and give it even when you could not finish.`, 1×, op r. 48.

          Werking per vervanging: tel de treffers met `split(from).length - 1`. Wijkt het aantal af van `count`, gooi dan `Error(`review-prompt: ${id} verwacht ${count}× ${JSON.stringify(from)}, gevonden ${n}`)`. Anders volgt `replaceAll`.

          Tests (eerst rood):
          - De sha256 van de fixture is gelijk aan f56fe0a6…4ead.
          - `adaptReviewPrompt(fixture)` is byte-gelijk aan queue-review.adapted.md.
          - Elke regel buiten r. 5, 7, 9, 11, 17, 18, 30 en 48 is byte-gelijk aan het origineel, en het aantal regels blijft 48.
          - De uitkomst bevat geen `$PAYLOAD_PATH`, `/sources`, `/output` of `/work` meer.
          - Met één `$PAYLOAD_PATH` minder gooit de functie, met een fout die A1 noemt.
          - Met één extra `` `/work` `` gooit de functie, met een fout die A3 noemt.

          Verificatie: `npx vitest run __tests__/bench-review-prompt.test.ts`, daarna `npm run verify`.

          Commit: `feat(bench): adaptReviewPrompt (M8)`.
      - title: "Review-case-lader met hashcontrole en werkmap"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Vereist: taak 4 (make-case.ts kopieert de prompt-fixture).
          Spec: §4.1 ("De case", "Werkmap", "Limieten"), §4.2 en AC4. Plan: docs/plans/M8-review-bench.md (C-m6).

          Doel: een case-map laden en elke byte controleren, vóórdat er een run-map bestaat. Daarna de werkmap `<run>/root/` vullen.

          Bestanden:
          - Nieuw: src/bench/review-case.ts.
          - Nieuw: __tests__/bench-review-case.test.ts.
          - Nieuw: __tests__/fixtures/review-bench/make-case.ts. Deze helper bouwt een synthetische case in een tmp-map: `case.json`, een `review.md` (kopie van de fixture uit taak 4), `payload.json` en `sources/doc` + `sources/__dispatch_input`. Taak 6 gebruikt hem ook.

          Interfaces (levert, voor taak 6):
          - `ReviewCaseSchema` (zod strict):
            - `id`: `^[a-z0-9][a-z0-9-]{0,39}$`;
            - `prompt` en `payload`: elk `{ file, sha256 }`;
            - `sources`: `{ key, file, sha256 }[]`, minstens 1;
            - `limits`: `{ maxTurns, maxOutputTokens, maxWallSeconds, maxToolErrors }`, alle vier verplicht, gehele getallen;
            - `contextTokens`: een positief geheel getal, verplicht;
            - `maxCostUsd`: een decimale string.
          - `export class CaseInvalidError extends Error`. De melding is `CASE_INVALID: <bestand>: <reden>`.
          - `export type LoadedReviewCase = { case: ReviewCase; dir: string; prompt: string; payload: unknown; expectedDocuments: unknown }`
          - `export function loadReviewCase(caseDir: string): LoadedReviewCase`
          - `export function stageReviewCase(loaded: LoadedReviewCase, runDir: string): string`. Geeft het pad van `<runDir>/root` terug.

          Controles in loadReviewCase, in deze volgorde (elke fout is een CaseInvalidError):
          1. `case.json` volgt het schema. Een ontbrekende `contextTokens` geeft `CASE_INVALID: case.json: contextTokens: …`.
          2. Elk genoemd bestand:
             - is relatief, zonder `..` en zonder absoluut pad;
             - is een gewoon bestand, geen symlink;
             - heeft de juiste sha256.
          3. In `payload.json`:
             - `dispatch.input.review_documents` bestaat; dat wordt `expectedDocuments`;
             - `dispatch.source_artifacts` bevat precies dezelfde sleutels met dezelfde sha256 als `sources[]` in case.json, in beide richtingen.

          stageReviewCase: maak `<runDir>/root/` aan, met `payload.json` en `sources/<key>` als byte-kopie.

          Tests (eerst rood):
          - De synthetische case laadt.
          - Eén gewijzigde byte in `sources/doc` geeft CASE_INVALID met `sources/doc`.
          - Hetzelfde voor `sources/__dispatch_input` (C-m6), `review.md` en `payload.json`.
          - Zonder `contextTokens` geeft het CASE_INVALID met `case.json`.
          - Een sleutel in case.json die niet in `source_artifacts` staat, of omgekeerd, geeft CASE_INVALID.
          - Een bronbestand dat een symlink is, wordt geweigerd.
          - `stageReviewCase` maakt een root met byte-gelijke bestanden.

          Verificatie: `npx vitest run __tests__/bench-review-case.test.ts`, daarna `npm run verify`.

          Commit: `feat(bench): review-case-lader (M8)`.
      - title: "runReviewBench: gate, run, statusmapping en bench-result.json"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Vereist: taken 1–5.
          Spec: §4.1 (alle punten), §4.4 ("Bekende interacties"), AC5, AC6 en AC7. Plan: docs/plans/M8-review-bench.md.

          Doel: één review-run van begin tot eind, met de statusregels van de spec.

          Bestanden:
          - Nieuw: src/bench/review-bench.ts.
          - Nieuw: __tests__/bench-review-bench.test.ts. Gebruikt make-case.ts uit taak 5, een nepclient via `deps.createClient`, en een probe-map met een aanvaarde probe zoals in __tests__/probe-gate.test.ts.

          Interfaces:
          - Gebruikt:
            - createReadOnlyTools (taak 1), createTrackedClient en withDroppedCost (taak 2), createReviewValidator (taak 3), adaptReviewPrompt (taak 4), loadReviewCase en stageReviewCase (taak 5);
            - checkProbeForJob(config, probeDir, name) uit src/worker/probe-gate.ts;
            - createCostGuard en parseCeilingNanos uit src/cost.ts. CostGuard past op RunDeps.costGuard.
          - Levert:
            - `export type ReviewBenchStatus = 'beoordeeld' | 'resultaat_ongeldig' | 'limiet' | 'benchfout'`;
            - `export type ReviewBenchResult`, met de velden uit spec §4.1: caseId, label, runId, configuration {name, costMode, reasoningEffort?}, contextTokens, status, runStatus (RunResult['status'] | 'not_run'), error?, result (DispatchResult | null), validation {attempts, errors}, usage, peakInputTokens, turns, toolCalls, toolErrors, providers, retries, durationMs en benchError?;
            - `export function mapReviewStatus(r: { benchError?: string; run?: RunResult; accepted: boolean }): ReviewBenchStatus`;
            - `export async function runReviewBench(o: { caseDir: string; config: WorkerConfig; configuration: string; probeDir: string; label: string; out: string; apiKey?: string; signal?: AbortSignal; deps?: { createClient?: (m: ModelSpec & { apiKey?: string }) => ModelClient; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } }): Promise<ReviewBenchResult>`.

          Verloop:
          1. `loadReviewCase(caseDir)`. Een CaseInvalidError gaat ongewijzigd naar de aanroeper, en er ontstaat geen map.
          2. Run-id en map:
             - `runId = ${case.id}-${label}-${hex8}`. Het label is de configuratienaam (punten mogen, zoals bij task-bench: `BENCH_LABEL` in src/cli.ts:550). runManifest valideert `Manifest.id` niet tegen ManifestSchema; alleen loadManifest doet dat;
             - de trace komt in `openTrace(out, runId)`, omhuld door een redigerende TraceWriter: redactText/redactDeep uit src/worker/redact.ts, met `[apiKey]` als die ≥ 8 tekens is.
          3. `checkProbeForJob(config, probeDir, configuration)`. Bij een fout:
             - `benchError: CONFIGURATION_NOT_PROBED: <detail>`;
             - runStatus `not_run`;
             - geen client.
          4. `stageReviewCase`. Daarna:
             - `guard = createCostGuard({ mode: costMode, ceilingNanos: parseCeilingNanos(case.maxCostUsd), configuration })`. Eén guard-object voor de client en voor runManifest;
             - de ModelSpec is `{ baseUrl: config.litellm.baseUrl, name: configuration, reasoningEffort, extraBody }` van de configuratie;
             - `createTrackedClient(base, { retryTransient: costMode === 'hosted', trace, sleep: deps.sleep, guard })`;
             - een wrapper houdt `peakInputTokens` bij: het maximum van `res.usage.inputTokens` per respons.
          5. Het manifest:
             - profiel `tools`;
             - de limieten uit de case, met contextTokens uit de case en niet uit de configuratie;
             - als enige bericht een user-bericht met `adaptReviewPrompt(prompt)`, zonder systeemprompt.
             - RunDeps:
               - `connectRegistry`: `createReadOnlyTools({ root })`;
               - `afterAnswer`: de validator;
               - `costGuard`: `guard`;
               - `signal`.
          6. Een stop door het signaal geeft `benchError: 'afgebroken'`, zoals bij M7. Heeft `tracked.costStop()` een stop, dan wordt de run `{ ...run, status: 'failed', error: stop.error }` vóór mapReviewStatus (plan-r1 X-M1). COST_LIMIT_EXCEEDED wordt zo limiet, COST_UNKNOWN benchfout.
          7. Schrijf `<out>/<runId>/bench-result.json` via redactDeep, met `usage: withDroppedCost(run.usage, tracked.droppedCosts())`.

          mapReviewStatus. De volgorde is de betekenis:
          1. `benchfout` bij:
             - een benchError, of geen run;
             - error.code MODEL_ERROR, HARNESS_ERROR, TOOL_NOT_AVAILABLE of COST_UNKNOWN.
          2. `limiet` bij runStatus budget_exceeded of timed_out, of bij error.code TOO_MANY_TOOL_ERRORS, CONTEXT_EXHAUSTED of COST_LIMIT_EXCEEDED.
          3. `resultaat_ongeldig` bij failed met REVIEW_RESULT_INVALID.
          4. `beoordeeld` bij completed met `accepted`, ongeacht verdict en outcome.
          5. Anders `benchfout`.

          Tests (eerst rood):
          - AC6: één test per regel van mapReviewStatus, inclusief de restregel. Daarnaast end-to-end:
            - een geldig antwoord, met `outcome: succeeded` en met `failed`, geeft beoordeeld;
            - twee ongeldige antwoorden geven resultaat_ongeldig;
            - `finishReason: 'length'` geeft limiet;
            - een ModelError geeft benchfout.
          - AC5:
            - zonder probe-uitslag: benchfout met CONFIGURATION_NOT_PROBED, en `complete()` wordt 0× aangeroepen;
            - hosted, een respons zonder bedrag: benchfout met COST_UNKNOWN;
            - tool-respons, totaal boven `maxCostUsd`: limiet met COST_LIMIT_EXCEEDED.
          - Weggevallen antwoorden (plan-r1 X-M1 en C-m3), hosted, `maxCostUsd` "1", met een directe `deps.sleep`:
            - twee keer finishReason `other` à 0.40, daarna een antwoord met een toolcall à 0.25: limiet met COST_LIMIT_EXCEEDED, `complete()` 3×, geen `tool_result` in de trace, en `usage.costUsd` 1.05 (`toBeCloseTo`);
            - drie keer `other` à 0.40: limiet met COST_LIMIT_EXCEEDED, `complete()` 3×, `usage.costUsd` 1.20;
            - één keer `other` à 0.02, daarna een geldig antwoord à 0.05: beoordeeld, en `usage.costUsd` 0.07 in bench-result.json.
          - AC4-aanvulling: een CaseInvalidError laat `out` leeg.
          - AC7, met `DUMMY_KEY` uit __tests__/helpers.ts. Na elk geval geeft `leakedFragments(inhoud)` een lege lijst voor elk bestand onder `out`; dat vangt ook een afgekapt prefix:
            - een nepclient gooit een ModelError met de key in de melding;
            - een antwoordbody van `bodyWithKeyAt(190)` bevat de key.

          Verificatie: `npx vitest run __tests__/bench-review-bench.test.ts`, daarna `npm run verify`.

          Grenzen:
          - Geen `checks`-diagnose (X-m3).
          - Geen dekkingsmeting. De trace houdt de tool_call-argumenten al bij, en score.py telt daaruit (C-m4).

          Commit: `feat(bench): runReviewBench (M8)`.
      - title: "CLI harness review-bench, task-bench-teksten byte-gelijk, README"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Vereist: taak 6.
          Spec: §4.1 ("CLI-aanpassingen", "Exitcode") en AC7. Review-record ronde 2, C-m6. Plan: docs/plans/M8-review-bench.md.

          Doel: het subcommando `review-bench` op de bestaande CLI. Voor task-bench verandert er niets.

          Bestanden:
          - Wijzig src/cli.ts.
          - Nieuw: __tests__/cli-review-bench.test.ts.
          - Wijzig README.md: een sectie review-bench met het gebruik, de invoer, de uitvoer, de vier statussen en de exitcode.

          CLI:
          - Usage-regel: `harness review-bench --case <dir> --config <harness.json> --configuration <name> --probe-dir <dir> --label <label> --out <dir> --api-key-env <VAR>`.
          - `cliArgsConfig.options` krijgt `'probe-dir': { type: 'string' }`.
          - `REVIEW_BENCH_FLAGS = ['case', 'config', 'configuration', 'probe-dir', 'label', 'out'] as const`.
          - Generaliseer `requiredValues(values, flags, command = 'task-bench')`. De melding blijft `${command} needs --${flag}`. `flags` krijgt het type `readonly ((typeof TASK_BENCH_FLAGS)[number] | (typeof REVIEW_BENCH_FLAGS)[number])[]`: `probe-dir` zit niet in de huidige union (src/cli.ts:556). Niet `keyof Values`, want dan valt een boolean-optie erin en is de waarde geen string meer.
          - Generaliseer `withStopSignals(work, stopMessage = TASK_BENCH_STOP_MESSAGE)`. Exporteer `TASK_BENCH_STOP_MESSAGE` met de huidige tekst, byte-gelijk: `task-bench stopt: containers worden opgeruimd (nogmaals Ctrl-C = direct afbreken)\n`. review-bench geeft `review-bench stopt: de run wordt afgebroken (nogmaals Ctrl-C = direct afbreken)\n`.
          - `rejectExtraBodyFile` kent 'review-bench'. De verwijzing is `the configuration in --config (extraBody)`.

          Het commando:
          1. `loadWorkerConfig(--config)`.
          2. De sleutel via `resolveWorkerApiKey(values['api-key-env'], process.env)`, met de regels van de worker. Zonder de vlag: UsageError `review-bench needs --api-key-env`.
          3. Het label wordt gecontroleerd met de bestaande `BENCH_LABEL` (src/cli.ts:550), met dezelfde melding als bij task-bench.
          4. `withStopSignals` met de import van runReviewBench.

          Exitcode en uitvoer:
          - Exit 0 met de regel `<status> <run-dir>` als bench-result.json geschreven is.
          - Een CaseInvalidError geeft de melding op stderr en exit 1.
          - Elke regel op stdout en stderr gaat door redactText met de sleutel.

          Tests (eerst rood):
          - Een ontbrekende vlag geeft `review-bench needs --probe-dir`.
          - C-m6, byte-gelijk:
            - task-bench zonder --case geeft exact `task-bench needs --case`;
            - `TASK_BENCH_STOP_MESSAGE` is exact gelijk aan de tekst hierboven;
            - de bestaande cli-tests van task-bench blijven ongewijzigd groen.
          - AC7 via spawn, met `DUMMY_KEY`. Een lokale http-server antwoordt met 400 (niet transient, dus geen backoff) en een body `bodyWithKeyAt(190)`. Daarna geeft `leakedFragments` een lege lijst voor stdout, stderr, trace.jsonl en bench-result.json.
          - Een label met een punt (`claude-sonnet-5.5-or`) wordt aanvaard. Een label met `/` geeft de UsageError van `BENCH_LABEL`.

          Verificatie: `npx vitest run __tests__/cli-review-bench.test.ts __tests__/cli.test.ts`, daarna `npm run verify`.

          Commit: `feat(cli): harness review-bench (M8)`.
      - title: "Drie nieuwe configuraties in deploy/max2, met deploy-test en runbook"
        priority: 2
        implementation_plan: |
          Repo: agent-harness. Branch: feat/m8-review-bench.
          Vereist: taken 1–7. Deze taak pusht de branch, dus ze komt als laatste.
          Spec: §4.6 ("Nieuwe configuraties in deploy/max2") en AC8. Review-record ronde 2, C-m3 (volgorde). Plan: docs/plans/M8-review-bench.md.

          Doel: de drie propriëtaire configuraties aanmaken. Bestaande configuraties en de productieworker veranderen niet.

          Bestanden:
          - Wijzig deploy/max2/harness.json. Achteraan in `configurations` (C-m3: de nieuwe staan achteraan) komen:
            - `"gpt-6-luna-or": { "costMode": "hosted", "contextTokens": 131072, "reasoningEffort": "medium" }`;
            - `"claude-sonnet-5.5-or": { "costMode": "hosted", "contextTokens": 131072, "reasoningEffort": "high" }`;
            - `"gpt-6.1-sol-or": { "costMode": "hosted", "contextTokens": 131072, "reasoningEffort": "medium" }`.
          - Wijzig deploy/max2/litellm/config.yaml. Na `minimax-m3-or` komen drie items:
            - model `openrouter/openai/gpt-6-luna`, `openrouter/anthropic/claude-sonnet-5.5` en `openrouter/openai/gpt-6.1-sol`;
            - elk met `api_key: os.environ/OPENROUTER_API_KEY`, `timeout: 600` en `model_info: *or-reasoning-info`;
            - het eerste item definieert `extra_body: &or-proprietary-extra` met `provider: { data_collection: "deny", require_parameters: true, allow_fallbacks: true, sort: "price", max_price: { prompt: 3, completion: 12 } }`, zonder `quantizations`;
            - de andere twee gebruiken `*or-proprietary-extra`;
            - erboven één commentaarblok: waarom er geen quantizations zijn (propriëtaire endpoints publiceren die niet), waarom de max_price boven de FP8-grens ligt, en dat dit voor M8 is.
          - Wijzig __tests__/deploy-max2.test.ts:
            - de namenlijst wordt 12 namen;
            - de waarden van de drie nieuwe configuraties worden vastgelegd;
            - een regex legt het anker `&or-proprietary-extra` vast, zonder `quantizations`;
            - `*or-proprietary-extra` komt 2× voor;
            - `*or-fp8-extra` blijft 3× (r. 62).
          - Wijzig docs/runbooks/harness-service-max2.md r. 92 (`litellm_up`): de afgedrukte modelnamen krijgen de drie nieuwe namen erbij, met "M8 review-bench, venster 131072".
          - Wijzig README.md op de plekken die de configuraties opsommen, als die er zijn.

          Erratum op spec §4.1 (X-m2): niet "alle bestaande deployments staan op 65536". De case overschrijft het venster van elke configuratie. Van de configuraties in de bench staan de vier FP8-configuraties nu op 65536, en `qwen3.8-or-128k` staat al op 131072.

          Tests (eerst rood): de nieuwe asserties in deploy-max2.test.ts. De bestaande asserties blijven staan.

          Verificatie:
          - `npx vitest run __tests__/deploy-max2.test.ts`, daarna `npm run verify`;
          - `git push -u origin feat/m8-review-bench`, en `git ls-remote --heads origin feat/m8-review-bench` toont de commit.

          Grenzen:
          - Geen merge. Die volgt in praktijkstap P1 van het plan, op JP's go.
          - Geen serveractie.

          Commit: `feat(deploy): drie propriëtaire configuraties voor M8`.
  - title: "S2 — review_bench in llm-bench (max2-repo)"
    description: >-
      De bevroren case met herkomst en controlescript, de rubric, de driver met preflight en de scorer met de beslisregel. Repo max2
      (privé), branch feat/m8-review-bench, gewerkt in een worktree ~/Development/max2-m8 op de Mac.
    acceptance_criteria: >-
      Spec AC9 en AC11, plus X-m1 (preflight afgewezen als reden voor een ontbrekende run), C-m4 (read_file-tellingen uit de trace)
      en C-m5 (het rookproefblad vraagt alleen f1). Een end-to-end-test volgt de indeling van P2 en P3 met één gedeelde preflight. Het controlescript bevestigt alle hashes. `python3 -m unittest` is groen voor
      review_bench, en task_bench blijft groen. De branch is gepusht; de PR wacht op JP.
    priority: 2
    tasks:
      - title: "Case macsearch-idea263-spec-r5, SOURCE.md, rubric en check_case.py"
        priority: 2
        implementation_plan: |
          Repo: max2 (privé). Worktree: `git -C ~/Development/max2 worktree add ~/Development/max2-m8 -b feat/m8-review-bench origin/main`.
          Alleen in een interactieve sessie op de Mac: de bron staat alleen daar. Dit is geen job voor een sprint-run.
          Spec: §4.2, §4.6 ("Herkenning") en AC9. Plan: docs/plans/M8-review-bench.md in agent-harness.

          Doel: de bevroren case in de max2-repo, met bewijs van herkomst en een herhaalbare hashcontrole.

          Bron: ~/Development/m8-case-staging op de Mac (0700). Daaruit gaan alleen deze bestanden mee:
          - `review.md`
          - `payload.json`
          - `sources/doc`
          - `sources/__dispatch_input`
          - `ref-result-claude.json`
          - `ref-result-codex.json`

          De map `logs/` komt in geen enkele repo, en gaat ook niet naar een subagent.

          Bestanden (alle in llm-bench/review_bench/):
          - Nieuw: `cases/macsearch-idea263-spec-r5/` met de zes bestanden hierboven, plus:
            - `case.json`:
              - `id` `macsearch-idea263-spec-r5`;
              - `prompt` `{file: "review.md", sha256: "f56fe0a641ddb007e5216a2063b02460e60b9836c08cbc2229d8f8661fee4ead"}`;
              - `payload` `{file: "payload.json", sha256: "5a52a843cbca3f20cf9a6026a7764450b29217980aba4c9b70219c675aff4f8f"}`;
              - `sources`: `doc` → `sources/doc` met `7d5e35872c417a5656ef53794aff95675f3ac0716f6e3c46951d509f029fadaf`, en `__dispatch_input` → `sources/__dispatch_input` met `9f6580562a3d9847e49a82697782219f22ef949d4d1a4396040106b25aaef9e3`;
              - `limits` `{maxTurns: 30, maxOutputTokens: 64000, maxWallSeconds: 1800, maxToolErrors: 8}`;
              - `contextTokens` 131072;
              - `maxCostUsd` `"1"`.
            - `SOURCE.md`, met:
              - de jobs `1a78c1b8` (Claude) en `7146cbe9` (Codex) van 2026-10-16;
              - de pin `doc` (product_doc, doc_id en revision_id uit de payload);
              - de vier hashes;
              - `review.md` uit scrum4me-mcp `e89c0961`;
              - dat de payload van de Claude-job komt;
              - hoe `__dispatch_input` is gereconstrueerd: met de canonicalJson van ~/Development/m8-case-staging/recon-dispatch-input.mjs, waarvan de code inline in SOURCE.md komt, en dat de uitkomst gelijk is aan `source_artifacts`;
              - dat de objective "Write only scratch files under /tmp/" bewust ongewijzigd is gelaten;
              - dat de logs buiten elke repo staan.
            - `rubric.md`, met F1, F2 en M1–M6 en hun herkenningscriteria, letterlijk uit spec §4.6. De bron is het review-record van r5 in MacSearch, `docs/reviews/2026-10-16-idea-263-spec-review-record.md` @4e9dfa5c. Per bevinding een korte sectie "telt als" en "telt niet als". `major` dekt MAJOR en BLOCKER.
          - Nieuw: `check_case.py <case-dir>`, met alleen de standaardbibliotheek. Het controleert:
            - elke sha256 in case.json;
            - dat de sleutels en hashes van `payload.dispatch.source_artifacts` in beide richtingen gelijk zijn aan `sources[]`;
            - dat `review_documents.items[*].sha256` van `doc` gelijk is aan die van `sources/doc`.
            Exit 0 als alles klopt. Anders exit 1, met per afwijking een regel.
          - Nieuw: `test_review_bench.py`, met unittest en de case-tests op een synthetische tmp-case (een gewijzigde byte per bestand geeft exit 1).

          Verificatie:
          - `python3 llm-bench/review_bench/check_case.py llm-bench/review_bench/cases/macsearch-idea263-spec-r5` geeft exit 0;
          - `python3 -m unittest discover -s llm-bench/review_bench -v` is groen.

          Grenzen:
          - De case-inhoud staat alleen in de private max2-repo.
          - Geen sleutel en geen log in de repo.

          Commit: `feat(review-bench): case macsearch-idea263-spec-r5 en rubric (M8)`.
      - title: "Driver run.py met preflight, grootboek en budget"
        priority: 2
        implementation_plan: |
          Repo: max2. Worktree: ~/Development/max2-m8, branch feat/m8-review-bench.
          Vereist: de case-taak.
          Spec: §4.7 en AC9. Review-record ronde 2, X-m1 en C-m2. Plan: docs/plans/M8-review-bench.md in agent-harness.

          Doel: een driver die `harness review-bench` per ronde over de modellen draait, met grootboek, budget, stopvlag en hervatten. Vóór de runs draait een preflight per configuratie.

          Bestanden (llm-bench/review_bench/):
          - Nieuw: `run.py`. Overgenomen uit task_bench/run.py:
            - read_ledger, ledger_total, append_ledger;
            - StopFlag en Harness.call;
            - check_budget, met één wijziging. M7 stopt pas als het totaal de grens bereikt (run.py:451-454) en kent geen vooruitschatting. Erratum op spec §4.7: daar staat "met dezelfde vooruitschatting als M7". M8 stopt vóór een run als `totaal + maxCostUsd van de case > --budget`. Het plafond van $1 per run is zacht; de marge van $2 dekt de overschrijding;
            - existing_results en hervatten;
            - de regel "één herhaling bij een benchfout, bij een tweede stoppen";
            - de exitcodes;
            - mask_secrets.
            Niet overgenomen: on_openrouter, fetch_endpoints en PINNED_QUANTIZATIONS.
          - Geen models.json: het model is de configuratie in harness.json. `--models` neemt configuratienamen, en het label is de configuratienaam. De driver weigert met exit 2 een naam die niet in `configurations` van `--config` staat. De acht namen zijn `qwen3.8-or-128k`, `deepseek-v4-flash-or`, `deepseek-v4-pro-or`, `glm-5.3-or`, `minimax-m3-or`, `gpt-6-luna-or`, `claude-sonnet-5.5-or` en `gpt-6.1-sol-or`.
          - Nieuw: `fake_review_bench.py`, een nep-harness zoals fake_task_bench.py. Het logt zijn argv en schrijft een bench-result.json met de status, het bedrag en eventueel de benchError die per label is ingesteld.
          - Wijzig `test_review_bench.py`.

          CLI:
          ```
          ./run.py --harness "<cmd>" --config <harness.json> --probe-dir <dir> --case <case-dir>
                   --models <configuraties…> --runs 3 --out <dir> --ledger <file> --budget <USD>
                   --key-file <file> [--preflight] [--preflight-file <file>]
          ```
          - `--preflight-file` is standaard `<out>/preflight.json`. De preflight schrijft dat bestand, en runs lezen het. Zo kunnen rookproef en hoofdruns elk een eigen `--out` hebben (hervatten telt de rookproef dan niet mee), met één gedeelde preflight (plan-r1 X-M2/C-M1).
          - `--key-file` wordt één keer gelezen, en de witruimte wordt gestript (Review Focus 5). In drie gevallen volgt een fout: de waarde is korter dan 8 tekens, ze begint met `LITELLM_MASTER_KEY=`, of ze bevat een aanhalingsteken.
          - De waarde gaat alleen als `LITELLM_MASTER_KEY` in de env van het kind. Naar de harness gaat `--api-key-env LITELLM_MASTER_KEY`, nooit de waarde.

          Preflight (`--preflight`):
          - Per configuratie één POST naar `<litellm.baseUrl uit --config>/chat/completions` met `model` = de configuratie, `max_tokens` 64000, `reasoning_effort` uit harness.json als die gezet is, één dummy-tool `noop` zonder parameters en het bericht "Antwoord alleen: OK".
          - Het bedrag komt als `preflight-<label>-<ts>` in het grootboek, null als het onbekend is.
          - Een configuratie is `ok` bij HTTP 200 én een eindig getal in `usage.cost` van de responsbody. Dat is hetzelfde veld dat `parseUsage` leest (agent-harness src/model-client.ts:98). De probe eist dat al (agent-harness src/worker/probe-gate.ts:93-97); de preflight herhaalt het bij `max_tokens` 64000 (Review Focus 4).
          - De uitkomst gaat naar `--preflight-file`: `{label: {ok, reason}}`. `reason` gaat door mask_secrets.

          Runs (zonder `--preflight`):
          - Lees `--preflight-file`. Een label dat ontbreekt geeft exit 2 ("geen preflight").
          - Een label met `ok: false` draait niet (X-m1).
          - Een bench-result met een benchError die begint met `CONFIGURATION_NOT_PROBED` telt niet als benchfout: geen herhaling, geen exit 3. Het label draait daarna niet meer.
          - De volgorde: ronde 1 over alle labels, dan ronde 2, dan ronde 3.
          - Vóór elke run eerst de stopvlag, dan hervatten, dan `check_budget`.
          - Het grootboek telt `usage.costUsd` uit elk bench-result.json, ook van een benchfout.
          - Aan het eind van elke aanroep, ook bij exit 3 of 4, schrijft de driver `<out>/skipped.json` opnieuw. Dat is een lijst `{label, run, reason}` met een regel voor elke verwachte run (`--models` × `--runs`) zonder bench-result.json. De reden is de eerste die past: `preflight afgewezen: <reden>`, `niet geprobed: <detail>`, `budget bereikt`, `gestopt (stopvlag)` of `gestopt na tweede benchfout op <label>`.

          Tests (unittest, eerst rood):
          - Het grootboek telt runs en preflight op.
          - Het budget stopt vóór een run als totaal + maxCostUsd boven `--budget` komt. Bijvoorbeeld bij budget 10: met totaal 9,10 en maxCostUsd 1 start er geen run meer, met totaal 8,90 nog wel.
          - Een naam die niet in harness.json staat, geeft exit 2.
          - De volgorde wisselt per ronde.
          - Hervatten slaat afgemaakte runs over.
          - Een benchfout wordt één keer herhaald, en bij een tweede stopt de driver met de exitcode van M7.
          - De stopvlag werkt.
          - Preflight met een nep-LiteLLM (`http.server` in een thread):
            - ok;
            - HTTP 400 geeft afgewezen, en `skipped.json` heeft voor dat label 3 regels "preflight afgewezen";
            - 200 zonder `usage.cost` geeft afgewezen;
            - het bedrag staat in het grootboek.
          - Preflight met `--out A`, daarna runs met `--out A/rook --preflight-file A/preflight.json`: geen exit 2. Zonder `--preflight-file` in `A/rook`: exit 2.
          - De nep-harness geeft voor één label CONFIGURATION_NOT_PROBED: 1 aanroep voor dat label, geen herhaling, exit 0, en `skipped.json` heeft runs 2 en 3 als "niet geprobed".
          - Een budgetstop (exit 4) geeft "budget bereikt" voor elke run die niet gestart is.
          - Lekken: een helper `leaked_fragments(text, key, min=6)` geeft elke stretch van 6 tekens van de key die nog in de tekst staat. Leeg voor de argv-log van de nep-harness en voor elk bestand onder `--out`, ook als de nep-LiteLLM een 400 geeft met de key in de body.
          - Een key-file met een afsluitende newline wordt gestript. `LITELLM_MASTER_KEY=…` en een waarde tussen aanhalingstekens worden geweigerd.

          Verificatie: `python3 -m unittest discover -s llm-bench/review_bench -v` en `python3 -m unittest discover -s llm-bench/task_bench -v`, beide groen.

          Grenzen:
          - De driver doodt de harness nooit. Hij zet alleen de stopvlag, zoals bij M7.
          - Geen sleutel in argv of in een bestand onder `--out`.

          Commit: `feat(review-bench): driver met preflight (M8)`.
      - title: "Scorer score.py: blinde bladen, beslisregel en rapport"
        priority: 2
        implementation_plan: |
          Repo: max2. Worktree: ~/Development/max2-m8, branch feat/m8-review-bench.
          Vereist: de driver-taak.
          Spec: §1 ("Beslisregel"), §4.6 ("Score"), §4.9 en AC11. Review-record ronde 2, X-m1, C-m4 en C-m5. Plan: docs/plans/M8-review-bench.md in agent-harness.

          Doel: per run blinde scorebladen maken, en daarna het oordeel per model en het rapport uitrekenen.

          Bestanden (llm-bench/review_bench/):
          - Nieuw: `score.py`.
          - Wijzig `test_review_bench.py`.
          - Nieuw: `fixtures/score/`, met synthetische bench-result-, scores-, decisions-, trace.jsonl- en skipped-fixtures.

          Subcommando's:
          - `score.py sheets <out> [--only-f1]`:
            - per run met status `beoordeeld` komt er `<out>/sheets/<uuid4-hex8>.md`, met alleen `result.report_markdown` en `result.summary`;
            - de koppeling id → run-map staat apart in `<out>/sheets-key.json`;
            - met `--only-f1` vraagt het blad alleen `f1` (C-m5, voor de rookproef);
            - zonder die vlag vraagt het blad `f1`, `f2`, `minors` en `extra`.
          - `score.py smoke <dir> --scores <scores.jsonl>`: per run de status, outcome, verdict en f1, en daarna `rookproef: door` (exit 0) of `rookproef: stop` (exit 1). Door betekent: geen run is benchfout, en `claude-sonnet-5.5-or` is beoordeeld met `outcome: succeeded`, NO-GO en f1 `major`.
          - `score.py report <out> --scores <scores.jsonl> --decisions <decisions.json> --ledger <file> --date <YYYY-MM-DD> --preflight <file> --models <configuraties…> --runs <n> [--smoke-dir <dir> --smoke-scores <file>]`. Dit schrijft `llm-bench/results/review-bench-<datum>.md`. `--models` en `--runs` geven de verwachte runs, ook van een configuratie die nooit gedraaid heeft (plan-r1 X-M2/C-M1).

          Formaten:
          - Een regel in `scores.jsonl`: `{sheet, f1: major|minor|nee, f2: major|minor|nee, minors: [M1..M6], extra: [{key, voorstel: geldig|ongeldig, reden}]}`. Voor de rookproef (`--only-f1`) alleen `{sheet, f1}`.
          - `decisions.json`: `{key: geldig|ongeldig}`.

          Beslisregel, als pure functies:
          - `run_voldoet(result, score, decisions)` is waar als:
            - status `beoordeeld`;
            - `result.outcome == "succeeded"`;
            - `result.review.verdict == "NO-GO"`;
            - `f1 == "major"`;
            - geen `extra` met beslissing `ongeldig`.
          - `model_oordeel(runs)`:
            - een `extra` zonder beslissing geeft `open`;
            - 3/3 geeft `kandidaat`;
            - 2/3 geeft `twijfel`;
            - anders `valt af`.
          - Is geen van `claude-sonnet-5.5-or` en `gpt-6.1-sol-or` kandidaat, dan geeft `oordelen()` voor alle modellen `onbeslist: runtime`.

          Rapport (spec §4.9):
          - Per model:
            - het oordeel en het aantal runs dat voldoet;
            - de verdicts;
            - F1 en F2 per run, en het gemiddelde aantal minors;
            - de extra's, geldig of ongeldig;
            - gemiddelde en maximale kosten;
            - tokens, `peakInputTokens` naast 131072, wandtijd, turns, toolfouten en outcome.
          - Per run, uit trace.jsonl (C-m4): het aantal `read_file`-aanroepen op `sources/doc`, totaal en met offset/limit. Het pad wordt eerst genormaliseerd: een absoluut pad met `/<runId>/root/` erin wordt het deel daarna, en dan `posixpath.normpath`. Zo telt `./sources/doc` ook mee.
          - Contextrijen voor `1a78c1b8` (Claude Code, $0,39) en `7146cbe9` (Codex CLI, ≈ $0,10).
          - De preflight uit `--preflight`: per configuratie ok of de reden, met het bedrag uit het grootboek.
          - De rookproef uit `--smoke-dir` en `--smoke-scores`: per run de status, outcome, verdict en f1.
          - Elke verwachte run die niet beoordeeld is, met de eerste reden die past, in deze volgorde:
            1. `preflight afgewezen` (X-m1), uit `--preflight` of skipped.json;
            2. `niet geprobed`, uit een benchError CONFIGURATION_NOT_PROBED of uit skipped.json;
            3. `benchfout`, uit bench-result.json;
            4. `budget bereikt` of `gestopt …`, uit skipped.json;
            5. `niet gestart`.
          - Het grootboek.

          Tests (AC11, eerst rood):
          - 3/3 geeft kandidaat, 2/3 twijfel, 1/3 valt af.
          - `outcome: failed` met NO-GO voldoet niet.
          - Een extra met een `key` die `ongeldig` is beslist, laat elke run met die key niet voldoen.
          - Een extra zonder beslissing geeft `open`.
          - Zijn beide controles geen kandidaat, dan krijgen alle modellen `onbeslist: runtime`.
          - Een blind blad bevat geen configuratienaam, geen label en geen modelnaam. Controleer dat tegen de acht configuratienamen en hun OpenRouter-modellen, zoals `anthropic/claude-sonnet-5.5`.
          - `--only-f1` vraagt alleen f1.
          - `smoke`: door en stop, elk met een fixture.
          - Een trace-fixture met 3 `read_file`-aanroepen op `sources/doc`, waarvan 2 met offset, geeft 3 en 2 (C-m4). Met `./sources/doc` en met een absoluut pad binnen de root telt het ook.
          - End-to-end, met de nep-LiteLLM en de nep-harness van de driver-taak, in de indeling van P2 en P3: preflight in `R`, rookproef in `R/rook`, hoofdruns in `R/runs`, steeds met `--preflight-file R/preflight.json`. Vier configuraties met `--runs 3`: één wijst de preflight af, één geeft CONFIGURATION_NOT_PROBED. `score.py report R/runs …` geeft voor de eerste 3× "preflight afgewezen" en voor de tweede 3× "niet geprobed". Het rapport heeft ook een preflight- en een rookproefsectie.

          Verificatie: `python3 -m unittest discover -s llm-bench/review_bench -v` is groen. Daarna `git push -u origin feat/m8-review-bench`.

          Grenzen:
          - Geen `checks`-diagnose (X-m3).
          - Een blad bevat nooit de koppeling met het model.

          Commit: `feat(review-bench): scorer en rapport (M8)`.
---

# M8 — review-bench: implementatieplan

_Status: draft (2026-10-20), revisie 4. Een technisch GO autoriseert geen ceremonie, venster, serveractie, merge of uitvoering._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** het rapport `llm-bench/results/review-bench-<datum>.md` in de max2-repo. Het geeft een oordeel per model over acht remote modellen met ≥ 128k context, elk 3× gedraaid op de spec-r5-review van MacSearch IDEA-263, volgens de beslisregel van spec §1.

**Architecture:** agent-harness krijgt `harness review-bench`: drie read-only tools, de echte `review.md` met getelde vervangingen, een validator die `finalizeChildResult` naspeelt, de probe-gate en kostenbewaking van de worker, en een eigen statusmapping. De max2-repo krijgt de bevroren case, een driver met preflight en grootboek, en een scorer met blinde bladen. Alles draait op max2 via LiteLLM, tegen de productie-release.

**Tech Stack:** TypeScript (Node 24), vitest, `npm run verify`; Python 3 met alleen de standaardbibliotheek, `unittest`; LiteLLM met OpenRouter.

**Spec:** `docs/specs/2026-10-20-review-bench-design.md` revisie 2, dubbel GO (`86628ea3`). Het review-record staat in `docs/reviews/2026-10-20-review-bench-spec-review-record.md`. De spec is bindend. Dit plan detailleert het hele increment (besluit 8).

**Vorm:**
- De sprint-taken (S1, S2) staan alleen in de yaml-frontmatter. Elke `implementation_plan` daar staat op zichzelf.
- De praktijkstappen op max2 staan hieronder, als sessiestappen en niet als sprint-taken. De reden: `verify_only` betekent alleen dat een lege diff mag (`scrum4me-mcp src/verify/gate.ts:11-12`). Het houdt een worker niet tegen.

## Global Constraints

Elke taak kopieert de grenzen die voor haar gelden. Hier staan alleen de grenzen die over alle taken heen gaan.

- **Productie verandert niet in gedrag:**
  - de jobpaden van de worker, `createTaskTools`, de padbewaking en de task-bench-teksten blijven gelijk;
  - wat er bijkomt, is additief.
- **Geheimen:**
  - de masterkey gaat alleen via `--api-key-env LITELLM_MASTER_KEY`;
  - de waarde komt nooit in argv, log, trace, resultaat, repo of Scrum4Me;
  - `FORGEJO_TOKEN` gaat alleen via `curl --config`.
- **Private inhoud:**
  - de MacSearch-case staat alleen in de private max2-repo;
  - agent-harness krijgt alleen synthetische fixtures en de echte `review.md`;
  - `~/Development/m8-case-staging/logs/` komt in geen repo en gaat niet naar een subagent.
- **Forgejo, nooit `gh`:**
  - geen merge zonder JP;
  - nooit `git branch -D`;
  - nooit een kale `git stash`.

## Review Focus

1. **Witruimte of BOM rond het JSON-object.** Dit moet aanvaard worden. Test in S1-3.
2. **Absolute paden uit gewoonte**, zoals `/sources/doc` of het `/tmp/` uit de objective. Die worden geweigerd zonder iets van de host te lezen, en tellen als toolfout. Test in S1-1.
3. **Een leeg eindantwoord**, zoals alleen reasoning. Dat geeft een herhaalvraag, geen crash. Test in S1-3.
4. **Een hosted configuratie zonder `usage.cost`.** Daarmee zou elke run COST_UNKNOWN geven. De probe wijst die al af (`probe-gate.ts:93-97`); de preflight herhaalt de controle bij `max_tokens` 64000. Test in S2-2.
5. **Een key-file met een newline, of in `NAAM=waarde`-vorm.** Een newline wordt gestript; de `NAAM=waarde`-vorm wordt geweigerd. Test in S2-2.

## Waar de MINORs van ronde 2 landen

Elke MINOR van spec-ronde 2 (X-m1 … C-m7, zie het spec-review-record) landt bij de taak of stap die zijn code noemt. C-m7 vraagt geen actie. De spec blijft na de GO ongewijzigd; een erratum staat in het plan.

## Volgorde

| Stap | Waar | Wat | Wacht op |
|---|---|---|---|
| S1-1 … S1-7 | agent-harness | bench-code | S1-5 op S1-4; S1-6 op 1–5; S1-7 op S1-6 |
| S1-8 | agent-harness | configuraties, deploy-test, push | S1-1 … S1-7 |
| S2-1 | max2, **alleen een Mac-sessie** | case (de bron staat alleen op de Mac) | — |
| S2-2, S2-3 | max2 | driver, scorer, push | S2-1 |
| P1–P4 | Forgejo, max2, Mac | praktijkstappen (hieronder) | S1 en S2 klaar; **elke stap op JP's go** |

## Praktijk op max2 (sessiestappen, geen sprint-taken)

Elke stap start alleen op JP's expliciete go, in een venster dat JP noemt. Het bewijs komt in het rapport en via log_test_result op de laatste S2-taak. Serveracties gaan alleen via de ops-acties uit `docs/runbooks/harness-service-max2.md`.

**P1 — Merge, release en herprobe** (spec §4.8, stap 4–5; C-m3).
1. PR's via de Forgejo-API: agent-harness en max2, `feat/m8-review-bench` → main. Mergen op JP's go.
2. `stop-check.sh`.
3. `harness_release_update`. Controleer daarna:
   - dat `/srv/agent-harness/current` op de merge-commit staat;
   - dat `node /srv/agent-harness/current/dist/cli.js review-bench` de usage toont.
4. `litellm_upgrade`. Noteer het eindtijdstip.
   - **Bij exit ≠ 0: opnieuw draaien, en niet proben voordat hij met 0 eindigt.**
   - Controleer daarna `allow` in `/etc/agent-harness/harness.json`.
5. `harness_probe`.
6. Lees elke `runs/probe-<naam>/probe.json`, ook bij een exit ≠ 0. "Actueel" betekent een mtime na het eindtijdstip van stap 4. Leg per configuratie `accepted` en de mtime vast.
7. `harness_start`, alleen als alle negen bestaande configuraties actueel en aanvaard zijn. Een afgewezen nieuwe configuratie valt uit de bench.

Terugzetten, als een bestaande configuratie niet meer aanvaard wordt: stop, en JP beslist. Dan in deze volgorde: `harness_release_rollback`, `litellm_upgrade`, `allow` controleren, `harness_probe`, elke probe.json lezen, `harness_start`.

**P2 — Preflight en rookproef** (spec §4.7 en §4.8, stap 6; C-m5).
1. JP leest het OpenRouter-tegoed af. Budget = `min(10, tegoed − 2)`.
2. Sleutel. Alleen het lezen gaat met sudo; het bestand wordt door janpeter geschreven, met 0600. Claude ziet de waarde nooit.
   ```bash
   sudo sed -n 's/^LITELLM_MASTER_KEY=//p' /etc/agent-harness/harness-litellm.env | install -m 0600 /dev/stdin /run/user/1000/m8-litellm.key
   ```
3. Draai op max2, in een clone of worktree `~/Development/max2-m8` van de gemergde main (buiten de worker-checkout), `run.py --preflight` met:
   `--harness "node /srv/agent-harness/current/dist/cli.js" --config /etc/agent-harness/harness.json --probe-dir /var/lib/agent-harness/runs`, de case, alle acht configuratienamen, `--out ~/m8-runs/review-bench-<datum>` (hierna `R`; de preflight schrijft `R/preflight.json`), `--ledger`, `--budget` en `--key-file /run/user/1000/m8-litellm.key`.
4. Rookproef: `--models qwen3.8-or-128k claude-sonnet-5.5-or --runs 1 --out R/rook --preflight-file R/preflight.json` (≈ $0,50). Deze runs tellen niet mee in de 24.
5. Maak het blad met `score.py sheets R/rook --only-f1`. Claude vult alleen f1 in, in `R/rook/scores.jsonl`.
6. Doorgaan mag alleen als `score.py smoke R/rook --scores R/rook/scores.jsonl` "rookproef: door" geeft:
   - geen van beide runs is `benchfout`;
   - sonnet is `beoordeeld`, met `outcome: succeeded`, `NO-GO` en f1 `major`.
   Anders stop, en JP beslist.

**P3 — De 24 runs** (spec §4.8, stap 7; C-m2).
1. Draai run.py met:
   - alle acht configuraties. De driver slaat een afgewezen preflight of een niet-geprobede configuratie zelf over, en legt de reden vast in `skipped.json`;
   - `--runs 3`;
   - `--out R/runs --preflight-file R/preflight.json`;
   - hetzelfde grootboek en hetzelfde budget.
2. Bij een tweede benchfout op dezelfde configuratie: stop, en JP beslist.
3. Na het venster:
   - JP verwijdert het key-bestand;
   - JP vergelijkt het verbruik op het dashboard met het grootboek. Een verschil komt in het rapport. Afgebroken aanvragen worden betaald maar niet geteld, en vallen binnen de marge van $2.
4. Kopieer de run-mappen naar `~/Development/m8-runs/`, buiten elke repo.

**P4 — Scoren en rapport** (spec §4.6, §4.9 en AC10; X-m1, C-m4).
1. `score.py sheets R/runs`.
2. Claude vult `scores.jsonl` in volgens rubric.md, zonder `sheets-key.json` te openen. Elke extra BLOCKER of MAJOR krijgt een genormaliseerde `key`.
3. JP beslist één keer per key in `decisions.json`.
4. `score.py report R/runs --preflight R/preflight.json --models <de acht> --runs 3 --smoke-dir R/rook --smoke-scores R/rook/scores.jsonl`, met scores, decisions, grootboek en datum, schrijft het rapport. Daarin staan:
   - het oordeel per model;
   - de preflight en de rookproef met hun bewijs;
   - de `read_file`-tellingen;
   - de grenzen: één case, alleen een document;
   - het vervolg.
   **AC10:** het rapport heeft 24 runs, of legt per ontbrekende run uit waarom: een benchfout, een configuratie die niet geprobed was, een preflight die afwees, het budget, een stop, of "niet gestart".
5. Commit in de max2-repo het rapport, de bladen, `scores.jsonl` en `decisions.json`, zonder run-mappen of logs. Dien het in als PR via de Forgejo-API, en merge op JP's go.

## Ceremonie

- Sprint en PBI komen onder **Agent-harness** (`cmuhjw9e80003mt7rq4w3sauu`), met het `idea_id` van IDEA-270. De S2-taken noemen hun repo, max2.
- Vóór de eerste `create_task` haal ik `get_estimate_history` op. Daarna krijgt elke taak een schatting.
- Het idee gaat naar PLANNED na het laatste ceremonie-increment, niet na de runs.

## Risico's

Zie spec §6. Daarbij:
- **De herprobe raakt alle 12 configuraties.** Het terugzetrecept staat in P1.
- **De bench draait tegen de productie-release** (`/srv/agent-harness/current`) en niet tegen een eigen build zoals bij M7. Dat is bewust: de bench meet de deployment die productie zou draaien.

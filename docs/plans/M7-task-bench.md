# M7 — task-bench: Qwen 3.8 voor een 96 GB-machine op echt werk — implementatieplan

_Status: draft, revisie 1 (2026-10-02). Een technisch GO autoriseert geen ceremonie, venster, serveractie, merge of uitvoering._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** een rapport `llm-bench/results/task-bench-<datum>.md` (repo max2) dat voor 12 oude Scrum4Me-taken laat zien hoeveel `qwen/qwen3.8-27b` op 16-bit via OpenRouter en `gsq-lokaal` op max2 er elk halen, met het oordeel en de betekenis voor de aankoop volgens spec §1.

**Architecture:** een nieuw subcommando `harness task-bench` in agent-harness.
- Het stelt de lus van de productieworker samen uit bestaande onderdelen: prompt, tools, recept, gate en limieten.
- Het draait die lus op een wegwerpclone van een oude begincommit, met de gitdir buiten de containermount.
- Daarna toetst het de uitkomst met de verborgen tests van de echte oplossing.
- Een driver en scorer in llm-bench (Python, alleen de standaardbibliotheek) draaien de 12 taken per model op max2, in vensters, en rekenen het oordeel uit.

**Tech Stack:**
- agent-harness: TypeScript (Node 24), vitest, `npm run verify`.
- max2 llm-bench: Python 3, alleen de standaardbibliotheek, `unittest`.
- Docker op max2 (`node:24-bookworm`), Ollama 0.34.4 en OpenRouter.

**Spec:** `docs/specs/2026-10-02-task-bench-design.md`, revisie 5 (status reviewed; dubbel GO in ronde 4). De spec is bindend; dit plan argumenteert eruit. Voorgangers: M3 (het workerpad), M5 (driverpatroon, provider-blok, `check_key.py`) en M6 (Vensterprocedure).

## Global Constraints

- **De productieworker blijft ongewijzigd in gedrag** (spec §1):
  - geen ander model, geen andere config, geen gedragswijziging aan `runTaskJob`;
  - in `src/worker/task-impl.ts` alleen twee exports (`isGreen`, `verifyText`) en een optie in `renderTaskPrompt`, met het huidige gedrag als standaard;
  - in `src/model-client.ts` alleen een extra veld `detail` op `ModelError`, dat de foutsoort vastlegt vóór het maskeren (spec §4.1, "Herkenning"). De meldingen blijven letterlijk gelijk.
- **Eén bench-lus, gelijk aan de worker** (spec §4.1):
  - de systeemprompt is `TASK_SYSTEM_PROMPT` zonder de bijzin `, en je kunt productdocumentatie lezen met de doc-tools`;
  - de taakprompt is `renderTaskPrompt` zonder het blok `## Product`;
  - tools: alleen `list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run_tests`;
  - de gate is `recipe.verify` via `afterAnswer`, met `maxVerifyRepairs`;
  - de limieten zijn het `task`-blok van `/etc/agent-harness/worker.json`.
- **De taakconfig** (spec §3) is een kopie van dat `task`-blok:
  - `limits: {maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8, contextTokens: 65536}`;
  - `image: node:24-bookworm`, `uid/gid: 1000`, `npmCacheDir: /var/lib/agent-harness/npm-cache`;
  - `maxVerifyRepairs` standaard 3;
  - de recepten van agent-harness en scrum4me-mcp.
- **Modellen** (spec §4.3):
  - `gsq-lokaal`: `qwen3.8-gsq-rco:27b-iq3_s-text` op `http://127.0.0.1:11434/v1`, zonder extra instellingen, en zonder herhaling bij storingen.
  - `qwen3.8-openrouter`: `qwen/qwen3.8-27b` op `https://openrouter.ai/api/v1`, met `extraBody: {provider: {data_collection: "deny", require_parameters: true, quantizations: ["bf16", "fp16"]}, reasoning: {effort: "medium"}}`, de sleutel via `--api-key-env OPENROUTER_API_KEY`, en herhaling bij storingen aan.
  - Temperatuur en seed blijven op de standaard. Eén run per taak.
- **Uitkomsten** (spec §4.1): `geslaagd`, `verborgen_tests_rood`, `verify_rood`, `limiet`, `geen_wijzigingen`, `benchfout`.
  - Een benchfout draait één keer opnieuw.
  - Een tweede benchfout op dezelfde taak stopt de driver voor JP.
  - Een onvolledige set wordt nooit gescoord.
- **Beslisregel** (spec §1): drempel 9 van 12, verschil minstens 3, en de grensregels. De code staat in Taak 7.
- **Budget** (spec §4.6):
  - één grootboek voor de proef, alle runs en alle herhalingen;
  - geen nieuwe run als het totaal $14 of meer is;
  - de proef mag hooguit $1,00 kosten, anders stopt M7 voor JP;
  - de sleutellimiet van $20 is de enige harde grens.
- **Geheimen:**
  - `OPENROUTER_API_KEY` komt alleen via `--api-key-env` binnen. De waarde staat nooit in argv, een log, een config, een trace, een resultaat of een repo.
  - Op max2 staat hij alleen tijdens een gehost venster in `/run/user/1000/m7-openrouter.key` (modus 0600, via stdin geschreven). Na het venster wordt dat bestand verwijderd.
  - `check_key.py` vindt nul treffers. `FORGEJO_TOKEN` gaat alleen via `GIT_ASKPASS` of `curl --config`.
- **max2:**
  - serveracties alleen op JP's go, binnen het venster dat JP noemt, volgens de Vensterprocedure hieronder;
  - de bench draait uit een eigen clone `~/Development/agent-harness-m7` met een eigen build. De worker-checkout `~/Development/agent-harness` en zijn git-administratie blijven onaangeroerd;
  - uitvoer naar `~/m7-runs/task-bench-<datum>/` (`$R`), en een kopie op de Mac in `~/Development/m7-runs/task-bench-<datum>/` (`$M`);
  - de Ollama-config, de productieconfig en het model van de worker niet wijzigen.
- **Host-git in de bench:**
  - Elke git-aanroep op de host gebruikt `SAFE_GIT_CONFIG` uit `src/worker/host-git.ts` en altijd expliciet `--git-dir=<gitdir>` en `--work-tree=<work>`.
  - De gitdir staat buiten de map die in een container wordt gemount. Zo kan testcode in een container geen hooks of config planten die git op de host uitvoert.
- **Forgejo is de forge, nooit `gh`.**
  - Geen merge zonder JP.
  - Nooit `git branch -D`, nooit een kale `git stash`, geen `--force` bij `git worktree remove`.
- **Gates:**
  - in agent-harness vóór elke commit `npm run verify` groen;
  - in max2 vóór elke commit `python3 -m unittest discover -s llm-bench/task_bench -p 'test_*.py'` en `python3 -m unittest llm-bench/refiner/test_refiner.py` groen.

## Vensterprocedure

Bindend is de sectie "Vensterprocedure" van `docs/plans/M6-local-precision-refiner.md`. Die geldt ongewijzigd voor elk M7-venster:
- de dienststand vooraf en na;
- de M4-stop als fail-closed script;
- de containers stoppen volgens de dienststand;
- starten in tmux met `sid=$(tmux new-session -d -P -F '#{pane_pid}' …)`;
- wachten tot `tmux has-session -t "=m6-<map>"` faalt en `pgrep -s "$sid"` met 1 eindigt;
- Afbreken (INT, twee minuten, TERM, één minuut, dan JP);
- Herstellen.

Alleen de namen en vier punten zijn anders voor M7:
- **Namen:** `R=/home/janpeter/m7-runs/task-bench-<datum>` en tmux-sessies `m7-<map>`. `<datum>` is de UTC-datum van het venster van de praktijkproef (Taak 6). Alle M7-bestanden gebruiken die ene datum.
- **Sleutel bij een gehost venster:**
  - Vóór de start, vanaf de Mac: `printf '%s' "$OPENROUTER_API_KEY" | ssh max2 'umask 077; cat > /run/user/1000/m7-openrouter.key'`. `printf` is een shell-builtin, dus de waarde komt niet in een procesargument.
  - Het run-script leest het bestand één keer in met `export OPENROUTER_API_KEY="$(cat /run/user/1000/m7-openrouter.key)"`.
  - Na Herstellen: `ssh max2 'rm -f /run/user/1000/m7-openrouter.key'`. Dat is een tijdelijke kopie van een geheim die M7 zelf maakte.
  - Daarna `test ! -e` als controle.
- **Taakconfig-controle per venster:** het `task`-blok van `/etc/agent-harness/worker.json` moet gelijk zijn aan `llm-bench/task_bench/task-config.json`. Python vergelijkt beide als JSON-objecten. Wijken ze af, dan stoppen en JP.
- **Nachtvenster:** een vangnet volgens het voorbeeld `llm-bench/results/refiner-precisie-2026-10-01/q8-docs-vangnet.sh` in max2.
  - Het doet niets tot 20 minuten vóór het einde van het venster. Leeft de run dan nog, dan Afbreken en Herstellen.
  - De tijd en de dienststand komen van het venster in kwestie.
  - Na een eigen herstel haalt de operator het vangnet weg.

## Review Focus

1. **Een model dat tests of runnerconfig aanpast om de gate groen te krijgen.**
   - Verwacht: de verborgen toets zet `__tests__/` en de runnerconfig exact terug naar `ref_commit` en eist uit de vitest-JSON dat elk verborgen bestand draaide. Een aangepaste `vitest.config.ts`, een `it.skip` of een verwijderde test telt dus niet als geslaagd.
   - Gedekt in Taak 3.
2. **Een storing tegenover een modelfout.**
   - Verwacht: alleen netwerkfouten, 408, 429 en 5xx, of een foutbody met zo'n code, worden herhaald, hooguit 3 keer, binnen de deadline, nooit na een afgebroken signaal, en alleen op de gehoste route.
   - Ongeldige JSON, tool- of schemafouten en rode tests worden nooit herhaald.
   - Gedekt in Taak 2.
3. **Een container die niet aantoonbaar stopt, of host-git na een container.**
   - Verwacht: de run stopt als benchfout en er start geen container meer.
   - Host-git leest nooit een `.git` in de werkmap: de gitdir staat erbuiten, met `SAFE_GIT_CONFIG`.
   - Gedekt in Taak 3 en Taak 4.
4. **Een sleutel die lekt.**
   - Verwacht: met een dummywaarde in `OPENROUTER_API_KEY` staat die waarde nergens in stdout, stderr, de trace, de resultaat-JSON of het patchbestand van de bench, en ook niet in de uitvoer van de driver.
   - Gedekt in Taak 4 en Taak 7.
5. **Een onvolledige of te dure set.**
   - Verwacht: de driver stopt bij een tweede benchfout op dezelfde taak, of als het grootboek $14 haalt. De scorer weigert een set die niet uit 12 geldige runs per model bestaat.
   - Gedekt in Taak 7.

## Bouwvolgorde

Spec §4.7. Spec en plan gaan vooraf als docs-PR (branch `docs/m7-task-bench-spec` in agent-harness); JP merget.

1. **Increment 1, bench plus praktijkproef:** Taak 1–5 in agent-harness (één PR), dan Taak 6: build op max2 en de proef, op JP's go.
2. **Increment 2, takenset en driver:** Taak 7 (driver en scorer), dan Taak 8 (selectie met bewijs, op JP's go voor een venster). Daarna JP's akkoord op de lijst, en één PR in max2.
3. **Increment 3:** Taak 9, gehost op alle 12, op JP's go.
4. **Increment 4:** Taak 10, gsq op alle 12, op JP's go, in een nachtvenster.
5. **Increment 5:** Taak 11, het rapport en het oordeel, als PR in max2.

## Bestandsstructuur

| Repo | Bestand | Verantwoordelijkheid | Taak |
|---|---|---|---|
| agent-harness | `src/worker/task-impl.ts` | exports `isGreen`, `verifyText`; optie `productBlock` in `renderTaskPrompt` | 1 |
| agent-harness | `src/bench/case.ts` (nieuw) | het schema van een case | 1 |
| agent-harness | `src/bench/task-prompt.ts` (nieuw) | systeem- en taakprompt van de bench uit een case | 1 |
| agent-harness | `src/model-client.ts` | `ModelError.detail` | 2 |
| agent-harness | `src/bench/retry-client.ts` (nieuw) | herhaling bij storingen | 2 |
| agent-harness | `src/bench/workspace.ts` (nieuw) | clone met gitdir buiten de werkmap, submodules, patch, terugzetten | 3 |
| agent-harness | `src/bench/hidden-check.ts` (nieuw) | script en beoordeling van de verborgen toets | 3 |
| agent-harness | `src/bench/task-bench.ts` (nieuw) | één run: containers, gate, lus, status, resultaat; `--check-case` | 4, 5 |
| agent-harness | `src/cli.ts` | subcommando `task-bench` | 4, 5 |
| agent-harness | `__tests__/bench-*.test.ts` (nieuw) | tests per module | 1–5 |
| max2 | `llm-bench/task_bench/run.py` (nieuw) | driver: probe, endpointlijst, runs, grootboek, stopregels | 7 |
| max2 | `llm-bench/task_bench/score.py` (nieuw) | tabel en oordeel | 7 |
| max2 | `llm-bench/task_bench/models.json` (nieuw) | de twee labels | 7 |
| max2 | `llm-bench/task_bench/task-config.json` (nieuw) | kopie van het `task`-blok | 7 |
| max2 | `llm-bench/task_bench/cases.jsonl` (nieuw) | de 12 bevroren taken | 8 |
| max2 | `llm-bench/task_bench/test_task_bench.py` (nieuw) | tests van driver en scorer | 7 |
| max2 | `llm-bench/README.md` | een sectie task-bench | 7 |
| max2 | `llm-bench/results/task-bench-<datum>.md` en `…/task-bench-<datum>/` (nieuw) | rapport en bewijs | 8–11 |

## Increment 1 — de bench en de praktijkproef

Werkplek: de Mac, worktree `~/Development/agent-harness-m7-code` op branch `feat/m7-task-bench`, vanaf `origin/main` na de merge van de docs-PR. De docs-worktree `agent-harness-m7` is iets anders.

### Taak 1: de prompts van de bench

**Files:**
- Modify: `src/worker/task-impl.ts` (`isGreen` r. 124 en `verifyText` r. 127 exporteren; `renderTaskPrompt` r. 52 krijgt een optionele tweede parameter)
- Create: `src/bench/case.ts`, `src/bench/task-prompt.ts`
- Test: `__tests__/bench-prompt.test.ts`; bestaande `__tests__/task-impl.test.ts` blijft groen

**Interfaces:**
- Produces:
  - `export const isGreen: (run: VerifyRun) => boolean`;
  - `export function verifyText(run: VerifyRun): string`;
  - `renderTaskPrompt(p: TaskPayload, opts?: { productBlock?: boolean }): string`, waarbij de standaard `true` het huidige gedrag is;
  - in `src/bench/case.ts`: `BenchCaseSchema` (zod) en `type BenchCase = z.infer<typeof BenchCaseSchema>`. Het schema is `{ id: /^[A-Z]{2}-\d{2}$/, repo_url, base_commit: /^[0-9a-f]{40}$/, ref_commit: /^[0-9a-f]{40}$/, task: { code, title, description: string|null, implementation_plan: string|null }, story: { title, description: string|null, acceptance_criteria: string|null }, hidden_tests: string[] (min 1, elk /^__tests__\/.+\.test\.ts$/), lines: number, kind: 'feat'|'fix' }`;
  - in `src/bench/task-prompt.ts`: `BENCH_SYSTEM_PROMPT: string` en `benchTaskPrompt(c: BenchCase): string`.

- [ ] **Eerst de tests** (`__tests__/bench-prompt.test.ts`):
  - `BenchCaseSchema` accepteert een voorbeeldcase en weigert:
    - een `base_commit` van 7 tekens;
    - een leeg `hidden_tests`;
    - een verborgen test buiten `__tests__/`;
    - een `id` als `ah-1`.
  - `BENCH_SYSTEM_PROMPT` is gelijk aan `TASK_SYSTEM_PROMPT` met precies één wijziging: de bijzin `, en je kunt productdocumentatie lezen met de doc-tools` is weg. Toets dat met `TASK_SYSTEM_PROMPT.replace(CLAUSE, '') === BENCH_SYSTEM_PROMPT`, en dat `TASK_SYSTEM_PROMPT.includes(CLAUSE)`. Zo wordt een latere wijziging van de workerprompt zichtbaar.
  - Voor een voorbeeldcase bevatten `BENCH_SYSTEM_PROMPT` en `benchTaskPrompt(case)` geen van de namen `search_product_docs`, `get_product_doc`, `list_product_docs`, `related_product_docs`, en ook niet `doc-tools` of `## Product`.
  - `benchTaskPrompt(case)` bevat `## Taak`, de titel, de beschrijving, `## Plan` met het implementatieplan, `## Story` met de acceptatiecriteria, en `## Repository` met de repo-URL.
  - `renderTaskPrompt(payload)` zonder opties levert nog steeds `## Product` met `product_id: \`…\` — gebruik exact dit id voor search_product_docs en list_product_docs`, zoals de bestaande worker-test pint.
- [ ] De tests falen.
- [ ] **De implementatie:**
  - `renderTaskPrompt`: `if (opts?.productBlock !== false) sections.push(block('## Product', …))`. De rest van de functie blijft ongewijzigd.
  - `benchTaskPrompt(c)` bouwt een `TaskPayload` uit de case en roept `renderTaskPrompt(payload, { productBlock: false })` aan. Die payload heeft:
    - `job_id: 'bench'`, `kind: 'TASK_IMPLEMENTATION'`;
    - `task: {id: c.task.code, title, description, implementation_plan, repo_url: c.repo_url}`;
    - `story: {id: 'bench', title, description, acceptance_criteria}`;
    - `product: {id: 'bench', repo_url: c.repo_url}`;
    - `worktree_path: '.'` en `branch_name: 'bench/' + c.id`.
  - `BENCH_SYSTEM_PROMPT = TASK_SYSTEM_PROMPT.replace(CLAUSE, '')`, met een `if (!TASK_SYSTEM_PROMPT.includes(CLAUSE)) throw` bij het laden.
- [ ] `npm run verify` is groen. Commit: `feat(bench): prompts zonder doc-tools voor task-bench (M7)`.

### Taak 2: herhaling bij storingen

**Files:**
- Modify: `src/model-client.ts` (`ModelError` r. 35-41 en de throw-plaatsen in `complete`)
- Create: `src/bench/retry-client.ts`
- Test: `__tests__/bench-retry-client.test.ts`; bestaande `__tests__/model-client.test.ts` blijft groen

**Interfaces:**
- Produces:
  - `ModelErrorDetail = { kind: 'network' | 'aborted' | 'http' | 'error_body' | 'invalid'; status?: number; bodyCode?: number }`;
  - `ModelError.detail?: ModelErrorDetail`, als een optionele tweede constructorparameter;
  - `isTransient(err: unknown, signal: AbortSignal): boolean`;
  - `createRetryingClient(inner: ModelClient, opts: { maxRetries?: number; delaysMs?: number[]; onRetry?: (r: RetryRecord) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): ModelClient`;
  - `RetryRecord = { attempt: number; kind: string; status?: number; bodyCode?: number }`.

- [ ] **Eerst de tests:**
  - **`model-client.ts`:**
    - een netwerkfout geeft `detail.kind 'network'`;
    - dezelfde fout met een afgebroken signaal geeft `'aborted'`;
    - HTTP 503 geeft `'http'` met `status 503`;
    - een 200 met `{"error":{"code":429,"message":"…"}}` geeft `'error_body'` met `bodyCode 429`;
    - ongeldige JSON geeft `'invalid'`;
    - elke `message` is letterlijk gelijk aan wat de bestaande tests pinnen.
  - **`isTransient`:**
    - `true` voor `network`, voor `http` 408, 429, 500 tot en met 599, en voor `error_body` met `bodyCode` 408, 429 of 5xx;
    - `false` voor `aborted`, `invalid`, `http` 400, 401, 404, `error_body` zonder code, en voor een andere fout dan een `ModelError`;
    - `false` voor alles zodra `signal.aborted` waar is.
  - **`createRetryingClient`** (met een nep-`inner` en een nep-`sleep` die direct oplost):
    - twee keer 503 en dan succes geeft het antwoord, met twee `onRetry`-records;
    - vier keer 503 geeft de vierde fout na 3 herhalingen;
    - 400 wordt niet herhaald;
    - een afbreking tijdens `sleep` geeft de laatste fout door, zonder nieuwe aanroep;
    - de tweede aanroep krijgt hetzelfde `messages`- en `options`-object.
- [ ] De tests falen.
- [ ] **De implementatie:** in `complete` zet elke `throw new ModelError(...)` er de `detail` bij. De `status` en de `bodyCode` worden bepaald uit `status` en `json.error.code` vóór `excerpt()` en `maskKey()`:

```ts
// model-client.ts
export type ModelErrorDetail = { kind: 'network' | 'aborted' | 'http' | 'error_body' | 'invalid'; status?: number; bodyCode?: number }
export class ModelError extends Error {
  readonly code = 'MODEL_ERROR' as const
  constructor(message: string, readonly detail?: ModelErrorDetail) {
    super(message)
    this.name = 'ModelError'
  }
}
// catch van fetch:   new ModelError(`model request failed: …`, { kind: options.signal.aborted ? 'aborted' : 'network' })
// status buiten 2xx: new ModelError(`model HTTP ${status}: …`, { kind: 'http', status })
// json.error:        const c = (json.error as { code?: unknown }).code
//                    new ModelError(`… error body: …`, { kind: 'error_body', status, ...(typeof c === 'number' ? { bodyCode: c } : {}) })
// overige parsefouten: { kind: 'invalid', status }
```

```ts
// bench/retry-client.ts
const RETRY_STATUS = (s: number | undefined) => s === 408 || s === 429 || (s !== undefined && s >= 500 && s <= 599)
export function isTransient(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(err instanceof ModelError) || !err.detail) return false
  const d = err.detail
  if (d.kind === 'network') return true
  if (d.kind === 'http') return RETRY_STATUS(d.status)
  if (d.kind === 'error_body') return RETRY_STATUS(d.bodyCode)
  return false
}
// createRetryingClient: maxRetries 3, delaysMs [2000, 8000, 30000]; per poging: try inner.complete; bij een fout:
// als !isTransient(err, options.signal) of de herhalingen op zijn: throw err; anders onRetry(...), await sleep(delay, signal)
// (een afbreking tijdens sleep: throw err), en opnieuw.
```

- [ ] `npm run verify` is groen. Commit: `feat(bench): herhaling bij storingen, alleen tijdelijke fouten (M7)`.

### Taak 3: werkruimte en verborgen toets

**Files:**
- Create: `src/bench/workspace.ts`, `src/bench/hidden-check.ts`
- Test: `__tests__/bench-workspace.test.ts`, `__tests__/bench-hidden-check.test.ts`

**Interfaces:**
- Produces:
  - `type Workspace = { work: string; gitdir: string }`;
  - `createWorkspace(o: { repoUrl: string; commit: string; dir: string }): Promise<Workspace>`, die `<dir>/work` en `<dir>/gitdir` maakt;
  - `capturePatch(ws: Workspace, base: string): Promise<{ patch: string; empty: boolean }>`;
  - `restoreForHiddenCheck(ws: Workspace, ref: string): Promise<void>`;
  - `hiddenCheckScript(files: string[]): string`;
  - `evaluateHidden(o: { exitCode: number | null; json: unknown; work: string; files: string[] }): HiddenResult`;
  - `HiddenResult = { pass: boolean; reason: string; files: Array<{ file: string; ran: boolean; passed: number; failed: number; other: number }> }`.

- [ ] **Eerst de tests.** Ze maken in een tijdelijke map een fixture-repo met `git init`. Die heeft een commit A (`src/x.ts`, `__tests__/a.test.ts`, `vitest.config.ts`) en een commit B, die `src/y.ts`, `__tests__/b.test.ts` en een gewijzigde `__tests__/a.test.ts` toevoegt.
  - **`createWorkspace`** (clone vanaf `file://…`):
    - `work/.git` is een bestand en geen map, met de gitdir buiten `work`;
    - HEAD staat op A;
    - een submodule in de fixture wordt op de gitlink van A gezet.
  - **Host-git:** elke host-git-aanroep loopt via `SAFE_GIT_CONFIG` en `--git-dir`/`--work-tree`. Toets dat met een hook die een bestand zou maken:
    - zet `gitdir/hooks/post-checkout`;
    - zet ook een kwaadaardig `work/.git`-bestand dat naar een andere gitdir wijst;
    - na `capturePatch` en `restoreForHiddenCheck` bestaat het hook-bestand niet, en is de echte gitdir gebruikt.
  - **`capturePatch`:**
    - zonder wijziging `empty: true`;
    - na een nieuw bestand en een wijziging staan beide in `patch`;
    - een map `.task-bench/` telt niet mee.
  - **`restoreForHiddenCheck(ws, B)`:**
    - een door het "model" aangepaste `__tests__/a.test.ts` is weer gelijk aan B;
    - een door het model toegevoegde `__tests__/extra.test.ts` is weg;
    - een aangepaste `vitest.config.ts` is gelijk aan B;
    - een door het model toegevoegde `tsconfig.extra.json` in de root is weg.
  - **`evaluateHidden`** met handgemaakte vitest-JSON in het formaat van de vitest-reporter (`testResults[].name` absoluut, `assertionResults[].status`):
    - alles `passed` en exit 0 geeft `pass: true`;
    - één `failed` geeft `false`;
    - één `skipped`, `pending` of `todo` geeft `false`;
    - een verborgen bestand dat niet in `testResults` staat geeft `false`, met als reden "niet gedraaid";
    - een bestand zonder `assertionResults` (bijvoorbeeld een importfout) geeft `false`;
    - exit 0 met ontbrekende of onleesbare JSON geeft `false`.
  - **`hiddenCheckScript(['__tests__/b.test.ts'])`** is `npx vitest run --reporter=json --outputFile=.task-bench/hidden.json '__tests__/b.test.ts'`, met elk pad shell-veilig gequote.
- [ ] De tests falen.
- [ ] **De implementatie.** Elke host-git-aanroep gaat via `execFile('git', [...SAFE_GIT_CONFIG, '--git-dir', ws.gitdir, '--work-tree', ws.work, ...args])`, ook als argv en nooit via een shell.
  - **Clone:** `git clone --no-checkout --separate-git-dir <dir>/gitdir <repoUrl> <dir>/work`, daarna `checkout --detach <commit>` en `submodule update --init --recursive`.
  - **Patch:** `add -A -- . ':(exclude).task-bench'`, daarna `diff --cached --binary <base>`.
  - **Terugzetten** (exact, spec §4.1 stap 5):

```ts
// 1. rm -rf <work>/__tests__ en de rootbestanden die passen op /^(vitest\.config\..+|package\.json|tsconfig.*\.json)$/
// 2. const keep = (await git(ws, ['ls-tree', '--name-only', ref])).split('\n').filter(n => n === '__tests__' || ROOT_CONFIG.test(n))
// 3. if (keep.length > 0) await git(ws, ['checkout', ref, '--', ...keep])
```

  - **`evaluateHidden`:** zoek per verborgen bestand de `testResults`-regel waarvoor `path.relative(work, name) === file`. Geslaagd als `exitCode === 0` en voor elk bestand geldt: `ran`, minstens één assertie, alles `passed`.
- [ ] `npm run verify` is groen. Commit: `feat(bench): werkruimte buiten de containermount en verborgen toets (M7)`.

### Taak 4: `harness task-bench`

**Files:**
- Create: `src/bench/task-bench.ts`
- Modify: `src/cli.ts` (USAGE, `cliArgsConfig.options`, `switch`)
- Test: `__tests__/bench-task-bench.test.ts`, `__tests__/cli.test.ts` (USAGE en argumentfouten)

**Interfaces:**
- Consumes:
  - Taak 1: `BenchCaseSchema`, `BenchCase`, `BENCH_SYSTEM_PROMPT`, `benchTaskPrompt`, `isGreen`, `verifyText`;
  - Taak 2: `createRetryingClient`, `RetryRecord`;
  - Taak 3: `createWorkspace`, `capturePatch`, `restoreForHiddenCheck`, `hiddenCheckScript`, `evaluateHidden`, `HiddenResult`;
  - bestaand: `runManifest`, `openTrace`, `createTaskTools`, `runInContainer`, `containerName`, `buildScript`, `TaskConfigSchema`, `ModelSpecSchema`, `findRecipe`, `createModelClient`, `ContainerDeps`.
- Produces:
  - `type ModelSpec = z.infer<typeof ModelSpecSchema>`;
  - `type BenchStatus = 'geslaagd' | 'verborgen_tests_rood' | 'verify_rood' | 'limiet' | 'geen_wijzigingen' | 'benchfout'`;
  - `type BenchDeps = { containerDeps?: ContainerDeps; createClient?: (m: ModelSpec & { apiKey?: string }) => ModelClient; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }`. Tests zetten hier een nep-`spawn` en een nep-`sleep`; standaard gelden de echte `docker` en `createModelClient`;
  - `runTaskBench(o: { case: BenchCase; model: ModelSpec; label: string; task: TaskConfig; out: string; apiKey?: string; retryTransient: boolean; deps?: BenchDeps }): Promise<BenchResult>`;
  - `mapStatus(…): BenchStatus` (code hieronder);
  - `BenchResult`, geschreven naar `<out>/<runId>/bench-result.json`: `{ caseId, label, runId, model: {name, baseUrl}, status, runStatus, error?: {code, message}, gate: {reds, lastTail?}, hidden?: HiddenResult, usage: RunResult['usage'], providers: string[], retries: RetryRecord[], patchBytes: number, durationMs, benchError?: string }`;
  - CLI: `harness task-bench --case <json> --model-config <json> --task-config <json> --label <label> --out <dir> [--api-key-env <VAR>] [--retry-transient]`. Exit 0 als `bench-result.json` geschreven is, ook bij elke status; anders 1.

- [ ] **Eerst de tests** (met de bestaande `__tests__/fakes/fake-model-server.ts`, een nep-`spawn` voor `docker` uit `ContainerDeps`, en de fixture-repo uit Taak 3):
  - **De lus is gelijk aan die van de worker.** De manifest die `runManifest` krijgt heeft:
    - `profile: 'tools'`, `system: BENCH_SYSTEM_PROMPT`, `prompt: benchTaskPrompt(case)`;
    - `tools.allow` precies de zes taaktools;
    - `limits` gelijk aan `task.limits`.
    - De registry heeft alleen de zes taaktools.
  - **De gate:**
    - nep-verify groen geeft `accept`;
    - rood geeft `retry` met de tekst `Verify faalt (poging 1 van 3): …`;
    - de derde rode geeft `fail VERIFY_FAILED`, en dus de status `verify_rood`.
  - **De statusmapping (spec §4.1):**
    - `completed` met een lege patch geeft `geen_wijzigingen`;
    - `completed` met een patch en een geslaagde verborgen toets geeft `geslaagd`, en met een gezakte toets `verborgen_tests_rood`;
    - `budget_exceeded`, `timed_out` en `failed TOO_MANY_TOOL_ERRORS` geven `limiet`;
    - `failed MODEL_ERROR`, `HARNESS_ERROR` en `TOOL_NOT_AVAILABLE` geven `benchfout`;
    - een clone- of prepare-fout geeft `benchfout` met `benchError`;
    - een container met `cleanup: 'uncertain'` stopt de run met `benchfout`, en daarna start er geen container meer;
    - een fout in de container van de verborgen toets (`runnerError`) geeft `benchfout`.
  - **Herhaling:** met `retryTransient: true` geeft de nep-server eerst 503 en dan een antwoord. De run gaat door, en `retries` heeft één record. Met `false` eindigt dezelfde run op `MODEL_ERROR` en dus `benchfout`.
  - **Aanbieders:** `providers` bevat het `provider`-veld van elke respons, in volgorde.
  - **Geheimen:** met `apiKey` gelijk aan een dummywaarde komt die waarde niet voor in `bench-result.json`, `trace.jsonl`, `patch.diff`, stdout of stderr. De manifest in de trace heeft geen `apiKey`.
  - **CLI:**
    - `task-bench` zonder `--case` geeft een gebruiksfout met exit 1;
    - `--api-key-env` met een lege variabele geeft exit 1, zonder run-map;
    - een case die niet door `BenchCaseSchema` komt geeft exit 1, met het veld in de melding.
- [ ] De tests falen.
- [ ] **De implementatie** van `runTaskBench`, in deze volgorde:
  1. `runId = \`${case.id}-${label}-${hex8}\``, met `hex8` uit 4 willekeurige bytes. `containerName` krijgt `hex8`, want die gebruikt de eerste 8 tekens.
  2. `trace = openTrace(out, runId)`, de werkruimte in `join(trace.dir, 'ws')`, en `recipe = findRecipe(task, case.repo_url)`. Geen recept geeft een benchfout.
  3. **Containers** zoals in `runTaskJob` (`src/worker/task-impl.ts` r. 232-262):
     - een `inFlight`-set en `settleContainers()`;
     - een `uncertain`-vlag die `inner.abort()` doet en elke volgende container weigert;
     - `trace.containerOutput` en het `container`-event per run.
  4. Prepare met `buildScript(recipe.prepare)`. Niet groen geeft een benchfout.
  5. De gate is een letterlijke kopie van `afterAnswer` uit `runTaskJob` (r. 337-345), met de geëxporteerde `isGreen` en `verifyText`.
  6. De modelclient is `createModelClient({ ...model, apiKey })`, gewikkeld in `createRetryingClient` als `retryTransient` aan staat. `onRetry` schrijft een `trace.event({ type: 'model_retry', … })` en vult `retries`.
  7. `runManifest(manifest, { client, trace, connectRegistry: async () => createTaskTools({ root: ws.work, runVerify: (s) => runVerify('run_tests', s) }), signal: inner.signal, afterAnswer })`.
  8. `settleContainers()`. `uncertain` geeft een benchfout.
  9. `capturePatch` naar `<trace.dir>/patch.diff`.
  10. Als de run `completed` is en de patch niet leeg: `restoreForHiddenCheck`, een verify-container met `hiddenCheckScript(case.hidden_tests)`, `.task-bench/hidden.json` lezen, kopiëren naar `<trace.dir>/hidden-vitest.json`, en `evaluateHidden`.
  11. `mapStatus` (hieronder), daarna `bench-result.json` schrijven.

  **De statusmapping** (een kwetsbaar contract):

```ts
export function mapStatus(r: { benchError?: string; run?: RunResult; patchEmpty?: boolean; hidden?: HiddenResult; hiddenRunnerError?: boolean }): BenchStatus {
  if (r.benchError || !r.run) return 'benchfout'
  const code = r.run.error?.code
  if (r.run.status === 'failed' && (code === 'MODEL_ERROR' || code === 'HARNESS_ERROR' || code === 'TOOL_NOT_AVAILABLE')) return 'benchfout'
  if (r.run.status === 'budget_exceeded' || r.run.status === 'timed_out' || code === 'TOO_MANY_TOOL_ERRORS') return 'limiet'
  if (code === 'VERIFY_FAILED') return 'verify_rood'
  if (r.run.status !== 'completed') return 'benchfout' // een onbekende eindcode: nooit stil als modelfout tellen
  if (r.patchEmpty) return 'geen_wijzigingen'
  if (r.hiddenRunnerError || !r.hidden) return 'benchfout'
  return r.hidden.pass ? 'geslaagd' : 'verborgen_tests_rood'
}
```

  **De CLI:**
  - Lees `--case` met `BenchCaseSchema`, `--model-config` met `ModelSpecSchema` zonder `apiKey` (een `apiKey` in het bestand is een fout), en `--task-config` met `TaskConfigSchema`.
  - `readApiKey(values['api-key-env'])` vóór er iets start.
  - Druk één regel af: `<status> — <runId> → <pad naar bench-result.json>`.
- [ ] `npm run verify` is groen. Commit: `feat(bench): harness task-bench (M7)`.

### Taak 5: `harness task-bench --check-case`

**Files:**
- Modify: `src/bench/task-bench.ts`, `src/cli.ts`
- Test: `__tests__/bench-check-case.test.ts`

**Interfaces:**
- Produces:
  - `checkCase(o: { case: BenchCase; task: TaskConfig; out: string; deps?: BenchDeps }): Promise<CaseCheck>`;
  - `CaseCheck`, geschreven naar `<out>/<case.id>-check-<hex8>/case-check.json`: `{ caseId, ok: boolean, baseVerifyGreen, hiddenOnBase: HiddenResult, hiddenOnRef: HiddenResult, refChangesRunnerConfig: boolean, hiddenMatchesRef: boolean, lines, problems: string[] }`;
  - CLI: `harness task-bench --check-case --case <json> --task-config <json> --out <dir>`. Er is geen model en geen sleutel. Exit 0 bij `ok`, anders 1.

- [ ] **Eerst de tests**, met de fixture-repo en de nep-containers:
  - een geldige case (verify groen op A, b-test rood op A, groen op B) geeft `ok: true`;
  - een rode verify op A geeft `false`, met als probleem "verify rood op base_commit";
  - een verborgen test die al slaagt op A geeft `false`, met als probleem "verborgen test slaagt al op base_commit";
  - een `ref_commit` die `vitest.config.ts` of `package.json` wijzigt geeft `false`, met als probleem "ref_commit wijzigt de runnerconfig";
  - `hidden_tests` die niet gelijk zijn aan de `*.test.ts` onder `__tests__/` die `ref_commit` toevoegt of wijzigt, gaan op `false`.
- [ ] De tests falen.
- [ ] **De implementatie:**
  - **Werkruimte 1 op `base_commit`:** prepare, verify. Daarna `restoreForHiddenCheck(ws, ref)` en de verborgen toets; die moet zakken.
  - **Werkruimte 2 op `ref_commit`:** prepare en de verborgen toets; die moet slagen.
  - **Vanuit werkruimte 1:**
    - `diff --name-only base ref` levert de gewijzigde paden: die bepalen `refChangesRunnerConfig` en `hiddenMatchesRef`;
    - `diff --shortstat base ref` levert de omvang (`lines`).
  - Criterium 4 (alleen wat de taaktekst vastlegt) en 5 (geen volledige implementatie in het plan) blijven mensenwerk bij de selectie (Taak 8). `checkCase` noemt ze niet.
- [ ] `npm run verify` is groen. Commit: `feat(bench): --check-case voor het bewijs van een case (M7)`.

### Taak 6: PR, build op max2 en de praktijkproef

**Files:**
- Op max2, buiten elke repo: de clone `~/Development/agent-harness-m7`, en `$R` met `proef/`, `cases-proef.jsonl`, `task-config.json`, `model-qwen3.8-openrouter.json`, de probe, de endpointlijst, `proef.sh`, `proef.log`, `proef.sid` en de dienststand.
- Op de Mac: de kopie in `$M`.

**Interfaces:**
- Consumes: de branch `feat/m7-task-bench` (Taak 1–5) en de Vensterprocedure.
- Produces: de echte kosten en tijd van één run, en het bewijs dat route en toets werken. Taak 8 gebruikt het; Taak 9 het grootboek.

- [ ] **PR:**
  - Push `feat/m7-task-bench` met `GIT_ASKPASS`.
  - Open de PR op Forgejo via de API (`curl --config`, de token niet in argv). De body noemt de spec, de vijf taken en de groene `npm run verify`.
  - JP merget. Wacht daarop.
- [ ] **Build op max2** (geen venster nodig: er draait geen container, en de worker merkt het niet):
  - `git clone https://git.jp-visser.nl/janpeter/agent-harness ~/Development/agent-harness-m7`, daarna `checkout` van de merge-commit, `npm ci` en `npm run build`.
  - Leg `git rev-parse HEAD` vast in `$R/voorbereiding.txt`.
  - De worker-checkout blijft op zijn commit; `git -C ~/Development/agent-harness rev-parse HEAD` is vóór en na gelijk.
- [ ] **De proeftaak:** kies met de hand één taak volgens spec §4.2, criteria 1–7. Maak er een case van met `BenchCaseSchema` en leg die vast in `$R/cases-proef.jsonl`.
- [ ] **De taakconfig:** `task-config.json` is het `task`-blok uit `/etc/agent-harness/worker.json`, met `python3 -c 'import json; print(json.dumps(json.load(open("/etc/agent-harness/worker.json"))["task"], indent=2))'`.
- [ ] **Het venster van ongeveer een uur, op JP's go** (Vensterprocedure, met de sleutelstap):
  1. **Check-case:** `node ~/Development/agent-harness-m7/dist/cli.js task-bench --check-case --case <case> --task-config $R/task-config.json --out $R/proef-check`. Niet `ok`: dan geen modelrun, herstellen en JP.
  2. **De endpointlijst:** `curl -s https://openrouter.ai/api/v1/models/qwen/qwen3.8-27b/endpoints > $R/endpoints-proef.json`. Dit is publiek, zonder sleutel. Er moet een endpoint zijn met `quantization` `bf16` of `fp16` en tools in `supported_parameters`. Anders stoppen en JP.
  3. **De probe:** `harness probe --base-url https://openrouter.ai/api/v1 --model qwen/qwen3.8-27b --out $R/probes --api-key-env OPENROUTER_API_KEY --extra-body-file <extraBody van het label>`. Het oordeel moet `reliable` zijn. Anders stoppen en JP.
  4. **De run** in tmux, in een script dat de sleutel inleest: `node …/cli.js task-bench --case <case> --model-config $R/model-qwen3.8-openrouter.json --task-config $R/task-config.json --label qwen3.8-openrouter --out $R/proef --api-key-env OPENROUTER_API_KEY --retry-transient`.
  5. Wachten, Herstellen, de sleutel verwijderen, de dienststand na.
- [ ] **Controle op de Mac** na `rsync -a max2:m7-runs/task-bench-<datum>/ "$M/"`:
  - `bench-result.json` bestaat, en de status is een van de zes;
  - elke `providers`-waarde is een aanbieder die in `endpoints-proef.json` met `bf16` of `fp16` staat;
  - `retries` is geteld;
  - `hidden-vitest.json` bestaat als de run `completed` was;
  - `check_key.py --env OPENROUTER_API_KEY "$M"` geeft `with_key=0` en exit 0.
- [ ] **Melden aan JP:** de status, de kosten (`usage.costUsd`), de tijd, de modelbeurten, de herhalingen en de aanbieders.
  - Kost de run meer dan $1,00, dan stopt M7 voor JP's besluit.
  - De kosten openen het grootboek: `$R/ledger.jsonl` krijgt `{"run": "<runId>", "cost_usd": <x>}`.

## Increment 2 — de takenset en de driver

Werkplek: de Mac, worktree `~/Development/max2-m7` op branch `feat/m7-task-bench`, vanaf `origin/main` van max2.

### Taak 7: driver en scorer

**Files:**
- Create in `llm-bench/task_bench/`: `run.py`, `score.py`, `models.json`, `task-config.json` en `test_task_bench.py`, plus een nep-harness `fake_task_bench.py` voor de tests
- Modify: `llm-bench/README.md` (sectie `## Task-bench (task_bench/)` na de sectie van de promptverfijner)

**Interfaces:**
- Consumes: de CLI van `harness task-bench` (Taak 4), `bench-result.json`, en `refiner/check_key.py`.
- Produces:
  - `run.py --harness "<cmd>" --models <labels…> [--models-file models.json] --cases cases.jsonl --task-config task-config.json --out <dir> --ledger <ledger.jsonl> [--budget-stop 14]`;
  - stopcodes: 0 klaar, 3 tweede benchfout, 4 budget, 5 probe of endpoint, 2 gebruiksfout;
  - `score.py <dir> --models <hosted> <gsq>`: schrijft `summary.csv` en print de tabel en het oordeel;
  - `verdict(h: int, g: int) -> str`.

- [ ] **Eerst de tests** (`unittest`, met `fake_task_bench.py`, dat per case een geconfigureerde status en kosten schrijft, en de sleutel via `clean_env()` zoals in `refiner/test_refiner.py`):
  - **`models.json`:**
    - het label `qwen3.8-openrouter` heeft het provider-blok met `data_collection: "deny"`, `require_parameters: true` en `quantizations: ["bf16","fp16"]`, `api_key_env: OPENROUTER_API_KEY` en `retry_transient: true`;
    - het label `gsq-lokaal` heeft geen sleutel en `retry_transient: false`;
    - zonder het provider-blok, of met een andere `quantizations`, weigert `load_models` het label met een `RunError`.
  - **Hervatten:** een case met een geldige `bench-result.json` (een van de vijf modelstatussen) draait niet opnieuw.
  - **Benchfout:**
    - een eerste benchfout draait één keer opnieuw;
    - een tweede benchfout op dezelfde case geeft exit 3, met de case-id in de melding, en de volgende cases draaien niet.
  - **Grootboek:**
    - elke run voegt `{"run", "label", "case", "cost_usd"}` toe aan `--ledger`, en een ontbrekend bedrag telt als 0;
    - staat het totaal (`math.fsum`) op $14 of meer, dan start er geen run meer: exit 4;
    - het grootboek van de proef telt mee.
  - **Probe en endpointlijst:**
    - voor elk label draait eerst `harness probe` (de nep-harness schrijft een oordeel);
    - niet `reliable` geeft exit 5;
    - voor een OpenRouter-label haalt de driver de publieke endpointlijst op via een te vervangen functie (in de test een nep-respons) en schrijft die naar `<out>/endpoints-<label>-<ts>.json`;
    - zonder 16-bit-endpoint met tools: exit 5.
  - **De sleutel:** met `OPENROUTER_API_KEY` als dummywaarde staat die waarde niet in stdout, stderr, het grootboek of een bestand onder `--out`. De driver geeft alleen `--api-key-env OPENROUTER_API_KEY` door.
  - **`verdict`:**
    - over alle 169 paren (0..12 × 0..12) zijn de aantallen precies 104 `gezakt`, 33 `onbeslist`, 23 `meerwaarde` en 9 `max2 volstaat`. Dat is de telling van beide reviewers in spec-ronde 1;
    - daarnaast de gevallen (8,0) onbeslist, (9,9) onbeslist, (12,9) onbeslist, (12,8) onbeslist, (12,7) meerwaarde, (10,6) meerwaarde, (10,7) onbeslist, (11,11) max2 volstaat en (7,0) gezakt.
  - **De scorer** weigert met exit 2 een map waarin een label minder dan 12 geldige runs heeft, of een benchfout als laatste status.
- [ ] De tests falen.
- [ ] **De implementatie.** `verdict` is een kwetsbaar contract:

```python
THRESHOLD = 9  # van 12 (spec §1)

def verdict(h, g):
    """Spec §1: oordeel voor gehost h en gsq g (geslaagd van 12), met de grensregels."""
    if h < THRESHOLD:
        row, base = 1, "gezakt"
    elif g >= THRESHOLD:
        row, base = 2, "max2 volstaat"
    elif h - g >= 3:
        row, base = 3, "meerwaarde"
    else:
        return "onbeslist"  # rij 4: verschil te klein
    boundary = h in (THRESHOLD, THRESHOLD - 1)                                 # gehost precies 9 of 8
    boundary |= row in (2, 3) and g in (THRESHOLD, THRESHOLD - 1)               # gsq 9 of 8 waar die beslist
    boundary |= row == 3 and h - g == 3                                          # verschil precies 3, alleen rij 3
    return "onbeslist" if boundary else base
```

  **`run.py`:**
  - Per label: probe (en voor OpenRouter eerst de endpointlijst).
  - Daarna per case in de volgorde van `cases.jsonl`:
    - hervatten of overslaan;
    - de grootboekstop;
    - `harness task-bench … --label <label> --out <out>/<label>` met `--api-key-env` en `--retry-transient` volgens het label;
    - het resultaat lezen;
    - het grootboek bijwerken;
    - de benchfoutregel.
  - De modelconfig per label schrijft hij als JSON naar `<out>/model-<label>.json`: `baseUrl`, `name`, `extraBody`, zonder sleutel.
  - Alleen de standaardbibliotheek, zoals `refiner/run.py`.
  - **`task-config.json`:** de kopie van het `task`-blok (Taak 6).
  - **README:** doel, de twee commando's, de stopcodes, de beslisregel, en een verwijzing naar de spec.
- [ ] Beide unittest-gates zijn groen (Global Constraints). Commit: `feat(task_bench): driver en scorer voor M7`.

### Taak 8: de selectie van 12 taken, met bewijs

**Files:**
- Create: `llm-bench/task_bench/cases.jsonl`
- Create: `llm-bench/results/task-bench-<datum>/selectie/` met `case-check.json` per taak, de bron-pin en het filter
- Op max2 in `$R`: `selectie.sh`, `selectie.log`, `selectie.sid` en de dienststand

**Interfaces:**
- Consumes: `harness task-bench --check-case` (Taak 5) en de Scrum4Me-MCP (`get_sprint_context` met `task_id` voor de taaktekst).
- Produces: de bevroren `cases.jsonl` voor Taak 9 en 10.

- [ ] **Kandidaten:**
  - Leg de bron-pin vast: `git rev-parse origin/main` per repo op de Mac.
  - Pas het grove filter uit spec §3 toe: commits sinds 2026-08-01, zonder merges, die `src/` en een test raken, `package.json`, de lockfile en Prisma niet raken, met 20–400 regels.
  - Koppel elke commit aan een afgeronde Scrum4Me-taak. Gebruik daarvoor de COMMIT-logs van de story, of een taakcode in de commitboodschap.
  - Haal de taaktekst op met `get_sprint_context(sprint_id, task_id)`. Zonder taaktekst valt de commit af.
- [ ] **Criteria 4 en 5** (mensenwerk): toets de verborgen tests en het plan.
  - Toetsen de tests alleen wat de taaktekst vastlegt?
  - Bevat het plan in de taak, of op `base_commit` in de repo (`docs/plans/`), niet de volledige implementatie?
  - Leg per kandidaat één regel reden vast.
- [ ] **De mix:** stel 12 voor plus 4 reserves, met 6 per repo, features en fixes, en qua omvang 4 klein (20–80), 4 middel (81–200) en 4 groot (201–400).
- [ ] **Het venster, op JP's go**, van ongeveer 1,5 uur: `--check-case` voor alle voorgestelde taken en de reserves, volgens de Vensterprocedure, zonder sleutel. Een taak die niet `ok` is, valt af; een reserve van dezelfde repo en omvangklasse neemt zijn plaats in.
- [ ] **Het voorstel aan JP:** een tabel met repo, taakcode, `ref_commit`, omvang, soort, de verborgen tests, de bewijsregels uit `case-check.json` en de reden voor criteria 4 en 5.
  - JP keurt goed.
  - Daarna `cases.jsonl` committen. Dat is de bevriezing: na deze commit verandert hij niet meer.
- [ ] **PR in max2:** push `feat/m7-task-bench` met `GIT_ASKPASS` en open de PR via de API. De body noemt Taak 7 en 8, de groene gates en de goedgekeurde lijst. JP merget.

## Increment 3 — gehost op alle 12

### Taak 9: `qwen3.8-openrouter` op de 12 taken

**Files:**
- Op max2 in `$R`: `gehost.sh`, `gehost.log`, `gehost.sid`, `gehost/`, `endpoints-qwen3.8-openrouter-*.json`, `probes/`, `ledger.jsonl` en de dienststand
- Op de Mac: de kopie in `$M`

**Interfaces:**
- Consumes: de gemergde driver, `cases.jsonl`, de bench-build op max2, het grootboek uit Taak 6.
- Produces: 12 geldige runs van het gehoste label. Taak 11 gebruikt ze.

- [ ] **Controle:**
  - de bench-clone staat op de gemergde commit uit Taak 6;
  - de taakconfig is gelijk aan `worker.json` (Vensterprocedure);
  - de max2-worktree staat op de gemergde `main` met `cases.jsonl`. Gebruik op max2 een losse clone of worktree van max2 (`~/Development/max2-m7`), buiten de checkout van de worker.
- [ ] **Het venster van ongeveer 3 uur, op JP's go**, volgens de Vensterprocedure met de sleutelstap: `run.py --harness "node /home/janpeter/Development/agent-harness-m7/dist/cli.js" --models qwen3.8-openrouter --cases llm-bench/task_bench/cases.jsonl --task-config llm-bench/task_bench/task-config.json --out $R/gehost --ledger $R/ledger.jsonl`, in tmux.
- [ ] **Bij exit 3, 4 of 5:**
  - herstellen;
  - de sleutel verwijderen;
  - JP melden met de reden;
  - een volgend venster hervat de set, want geldige runs worden overgeslagen.
- [ ] **Kopie en controle op de Mac:**
  - `rsync -a`;
  - `check_key.py` op `$M` geeft `with_key=0` en exit 0;
  - per run staan de aanbieders in de endpointlijst met 16-bit.

## Increment 4 — gsq op alle 12

### Taak 10: `gsq-lokaal` op de 12 taken

**Files:**
- Op max2 in `$R`: `gsq.sh`, `gsq.log`, `gsq.sid`, `gsq-vangnet.sh`, `gsq/` en de dienststand
- Op de Mac: de kopie in `$M`

**Interfaces:**
- Consumes: hetzelfde als Taak 9, zonder sleutel.
- Produces: 12 geldige runs van `gsq-lokaal`.

- [ ] **Controle:** gelijk aan Taak 9, plus `ollama list` toont `qwen3.8-gsq-rco:27b-iq3_s-text`.
- [ ] **Het nachtvenster, op JP's go**, volgens de Vensterprocedure met het vangnet: `run.py … --models gsq-lokaal --out $R/gsq --ledger $R/ledger.jsonl`. Het grootboek blijft voor gsq op 0, maar de driver gebruikt hetzelfde bestand.
- [ ] **Bij een stopcode:** gelijk aan Taak 9.
- [ ] **Kopie en controle:** gelijk aan Taak 9, zonder de aanbiederscontrole.

## Increment 5 — het rapport en het oordeel

### Taak 11: rapport, oordeel en PR

**Files:**
- Create: `llm-bench/results/task-bench-<datum>.md`
- Create: `llm-bench/results/task-bench-<datum>/` met:
  - per run `bench-result.json`, `patch.diff`, `hidden-vitest.json` en `trace.jsonl`; niet `ws/`, `tools/` of `containers/`;
  - verder `ledger.jsonl`, `summary.csv`, de endpointlijsten, `probes/*/probe.json`, de scripts, logs, `.sid`-bestanden en de dienststand.

**Interfaces:**
- Consumes: `$M/gehost/`, `$M/gsq/`, `score.py` en de selectie uit Taak 8.

- [ ] **De score:** `score.py $M --models qwen3.8-openrouter gsq-lokaal` geeft `summary.csv`, de tabel en het oordeel.
- [ ] **Het rapport** volgt spec §4.8. Het bevat:
  - de takenset met de bron-pin;
  - per taak de uitkomst van beide modellen, met de reden van elk falen en bij `verborgen_tests_rood` de falende tests uit `hidden-vitest.json`;
  - elke benchfout en elke herhaling apart, met de reden;
  - de tellingen, het oordeel van `verdict` en de betekenis voor de aankoop uit spec §1, met de grensgevallen;
  - de kosten uit het grootboek, en de tijd, modelbeurten, toolfouten, aanbieders en verzoekherhalingen per run;
  - de verschillen met productie (spec §4.1) en de kanttekeningen (spec §6);
  - per venster de dienststand vooraf en achteraf, en elke afgebroken run met de reden;
  - de commits: de bench, de driver, de worker-checkout, en `ollama --version`.
- [ ] **De acceptatiecriteria** uit spec §5 met het bewijs per criterium. Criterium 6 is de nul treffers van `check_key.py` op `$M` en op de map in de repo.
- [ ] Beide unittest-gates zijn groen. Commit, en een PR in max2 via de API. JP merget.
- [ ] **Opruimen:**
  - de worktrees op de Mac gaan weg zonder `--force`;
  - de clone `~/Development/agent-harness-m7` op max2 en `$R` blijven staan; verwijderen is aan JP.

## Buiten dit plan

Spec §1, de niet-doelen:
- snelheid of geheugen op een Mac;
- de webrepo;
- andere werksoorten;
- live taken;
- andere modellen;
- de productieworker wijzigen.

De ceremonie voor dit plan volgt pas na JP's akkoord.

## Review record

_Nog geen rondes._

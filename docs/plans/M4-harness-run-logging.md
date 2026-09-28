# M4 — harness-runs volgen in Worker Logs: implementatieplan

_Status: concept, revisie 1 (2026-09-28). Nog niet gereviewd. Een technisch GO autoriseert geen ceremonie, implementatie, merge of uitrol._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** elke harness-job op max2 verschijnt in Worker Logs (Ops-dashboard en scrum4me-workers), met denk-tekst, beurten, toolcalls, containers, jobstappen en een meetregel per beurt, en een mislukte run krijgt een triage-oordeel.

**Architecture:** het harness schrijft per geclaimde job een run-log in het bestaande worker-log-formaat: meta-regels met tag `[harness]` en JSON-regels `harness.*`, naast de ongewijzigde `trace.jsonl`. De parser van het Ops-dashboard leert die derde vorm, zoals eerder Codex. Ingest, database, triage en beide UI's blijven ongewijzigd.

**Tech Stack:** agent-harness (Node ≥ 22, TypeScript strict, vitest, zod 4, undici); Ops-dashboard (Next.js 16, TypeScript, vitest); max2 (Ubuntu, systemd, Ollama).

**Spec:** `docs/specs/2026-09-28-harness-run-logging-design.md` (revisie 3, dubbel GO). Voorganger: `docs/plans/M3-task-implementation-local-llm.md`.

## Global Constraints

- Run-log-pad `<dir>/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log`. Op max2: `dir` `/srv/scrum4me/worker-logs`, `pool` `harness`, `instance` `max2`. `pool` en `instance` voldoen aan `^[A-Za-z0-9._-]{1,64}$`. De naam is het UTC-tijdstip direct na de claim; aanmaken met `wx`, bij een bestaand bestand één nieuwe poging na de volgende seconde, anders geen run-log. Rechten 0644.
- Meta-regel: `<new Date().toISOString()> [harness] <tekst>`, zonder regeleinde in `<tekst>`. JSON-regel: `JSON.stringify(obj)` op één regel, `type` als eerste sleutel (`harness.<naam>`), `timestamp` (ISO) als tweede.
- De claim-regel is exact `claimed job_id=<jobId>`, zonder iets erachter.
- Het afsluitblok is één schrijfactie: `harness.run_end`, bij een fout `ERROR <CODE>: <bericht>`, `harness done job_id=<jobId> exit_code=<0|1> duration_ms=<ms>`, `exit code=<0|1>`. Precies één keer per job, ook na een eerdere schrijffout.
- Een harness-log is alleen afgesloten bij `exit code=`. Een `ERROR`-regel of `harness.run_end` sluit hem niet af.
- Grenzen, toegepast ná de redactie, met vlag of volledige lengte: `reasoning`, `content` en `answer` 16 384 tekens; `arguments` 4 096; tool-`content` en container-`outputTail` 8 192 (de staart).
- Redactie volgens scrum4me-docker `lib/log-redact.ts` (52ded13): de volledige waarde van variabelen waarvan de naam matcht op `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$|DSN|CREDENTIAL)/i`, en het wachtwoord uit elke URL-waarde (ruw en gedecodeerd); alleen waarden vanaf 8 tekens; langste eerst; vervangen door `***`. Bronnen: `process.env`, `workerMcpEnv(config)`, `model.apiKey`, `model.baseUrl`.
- Het run-log verandert nooit een jobuitkomst: elke uitzondering in de volger en in de `RunLog`-methodes wordt opgevangen.
- `trace.jsonl` blijft de volledige bron; bestaande trace-velden veranderen niet, oude traces blijven leesbaar.
- Geen wijziging in scrum4me-workers, in het ops_dashboard-schema, in de ingest, in de triage of in een UI.
- Forgejo is de forge; nooit `gh`. Push via `GIT_ASKPASS` met `$FORGEJO_TOKEN`. Geen merge, serveractie of uitrol zonder JP. Geheimen nooit printen of loggen.
- Gates vóór elke commit: agent-harness `npm run verify`; Ops-dashboard `npm run typecheck && npm test` (er is geen lint-script).

## Review Focus

1. **Een geheim dat terugkomt in tooluitvoer of denk-tekst**, bijvoorbeeld een Prisma-fout met `DATABASE_URL`, ook als het over een afkapgrens valt. Verwacht: gemaskeerd, want de redactie gaat vóór het afkappen. → Taak 3 en Taak 4.
2. **Een ingest-ronde die midden in een taakjob of midden in het afsluitblok leest.** Verwacht: `running`, en de volgende ronde leest het bestand opnieuw. → Taak 8.
3. **Eén stopsignaal (systemd-stop) tijdens een taakjob.** Verwacht: afsluitblok met `STOPPED`, nooit blijvend `running`. → Taak 6.
4. **Een volle schijf of een onschrijfbare worker-logs-map.** Verwacht: de job loopt ongehinderd, er komt één regel in journald en er is geen run-log. → Taak 4 en Taak 5.
5. **Een model dat `null`, een getal of een string als toolargumenten stuurt.** Verwacht: de run wordt toch ingelezen, met de argumenten als `{"arguments": …}`. → Taak 8.

## Bouwvolgorde

Spec §8: eerst het harness (PR, merge, max2), dan één echte idee-chat-job voor de fixture, dan de parser in het Ops-dashboard (PR, merge, uitrol op max2), dan de taakjob en de foutproef. Spec en plan gaan vooraf als docs-PR (branch `docs/m4-run-logging-spec`). Tussen de harness-uitrol en de parser-uitrol slaat de ingest de harness-bestanden over als `idle`; dat is onschadelijk.

## Bestandsstructuur

| Repo | Bestand | Verantwoordelijkheid | Taak |
|---|---|---|---|
| agent-harness | `src/types.ts`, `src/model-client.ts`, `src/run.ts`, `src/trace.ts` | denk-tekst, cachetokens, duur, fingerprint | 1 |
| agent-harness | `__tests__/fixtures/ollama-v1-*.json` (nieuw) | echte Ollama-antwoorden | 1 |
| agent-harness | `src/trace.ts`, `src/worker/task-impl.ts` | containeruitvoer in de trace | 2 |
| agent-harness | `src/worker/redact.ts` (nieuw) | redactieregels van de runner | 3 |
| agent-harness | `src/worker/run-log.ts` (nieuw), `src/worker/config.ts`, `examples/worker.json` | run-log-schrijver, config | 4 |
| agent-harness | `src/worker/worker.ts`, `src/cli.ts`, `docs/runbooks/idea-chat-worker.md` | bedrading, idee-chat, runbook | 5 |
| agent-harness | `src/worker/task-impl.ts` | bedrading taakjob, foutcodes, jobstappen | 6 |
| max2 | `/etc/agent-harness/worker.json`, `/srv/scrum4me/worker-logs/harness/` | uitrol, eerste echte run-log | 7 |
| Ops-dashboard | `lib/parse-worker-log.ts`, `test/parse-worker-log.test.ts`, `test/fixtures/worker-logs/harness-idea-chat.log` (nieuw) | parser met harness-tak | 8 |
| max2, scrum4me-srv | Ops-dashboard, triage | uitrol parser, acceptatie | 9, 10 |

## Increment 1 — agent-harness

Werkplek, na merge van de docs-PR: `git -C ~/Development/agent-harness worktree add ../agent-harness-m4-code -b feat/m4-run-logging origin/main`, dan `npm ci`. Nieuwe dependencies zijn niet nodig.

### Taak 1: model-client en trace — denk-tekst, cachetokens, duur, fingerprint

**Files:** Modify `src/types.ts`, `src/model-client.ts`, `src/run.ts` (model_response-event ~258–261, eindresultaat ~352–364), `src/trace.ts` (`TraceEvent`, `RunResult`). Create `__tests__/fixtures/ollama-v1-reasoning.json`, `__tests__/fixtures/ollama-v1-cached.json`. Modify `__tests__/model-client.test.ts`, `__tests__/run-answer.test.ts`.

**Interfaces:**
- Produces:

```ts
// src/types.ts
export type Usage = { source: 'provider_reported' | 'missing'; inputTokens: number; outputTokens: number; cachedTokens?: number }
export type CompleteResult = {
  message: { content: string | null; toolCalls: ToolCall[] }
  finishReason: 'stop' | 'length' | 'tool_calls' | 'other'
  usage: Usage
  model: string | undefined
  reasoning?: string          // message.reasoning, anders message.reasoning_content; alleen een niet-lege string
  durationMs: number          // van vóór fetch tot na het lezen van de body
  systemFingerprint?: string  // system_fingerprint
}
// src/model-client.ts
export type ModelClientOptions = { /* bestaand */ now?: () => number } // testnaad, standaard Date.now
// src/trace.ts: model_response krijgt reasoning?: string, durationMs: number, systemFingerprint?: string
//               (de usage erin draagt cachedTokens?); RunResult.usage krijgt cachedTokens?: number
```

- `cachedTokens` komt uit `usage.prompt_tokens_details.cached_tokens` als dat een getal is; anders ontbreekt het veld. `RunResult.usage.cachedTokens` is de som over de antwoorden die het meldden, en ontbreekt als geen enkel antwoord het meldde.
- De denk-tekst gaat niet terug naar het model: `toWire` blijft ongewijzigd.

**Fixtures** (echte antwoorden van `http://127.0.0.1:11434/v1/chat/completions` op max2, 2026-09-28, model `qwen3.8-gsq-rco:27b-iq3_s-text`; geen geheimen, letterlijk overnemen):

`__tests__/fixtures/ollama-v1-reasoning.json`:
```json
{"id":"chatcmpl-25","object":"chat.completion","created":1790606519,"model":"qwen3.8-gsq-rco:27b-iq3_s-text","system_fingerprint":"fp_ollama","choices":[{"index":0,"message":{"role":"assistant","content":"51","reasoning":"The user asks \"Wat is 17*3?\" (What is 17*3?) and asks to answer with only the number.\n\n17 * 3 = 51\n\nThey want only the number as the answer."},"finish_reason":"stop"}],"usage":{"prompt_tokens":26,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens":56,"total_tokens":82}}
```

`__tests__/fixtures/ollama-v1-cached.json` (tweede beurt van hetzelfde gesprek):
```json
{"id":"chatcmpl-340","object":"chat.completion","created":1790606530,"model":"qwen3.8-gsq-rco:27b-iq3_s-text","system_fingerprint":"fp_ollama","choices":[{"index":0,"message":{"role":"assistant","content":"54","reasoning":"The user is asking for 18*3. Let me calculate: 18*3 = 54.\nThey previously asked me to answer with only the number, so I'll do the same."},"finish_reason":"stop"}],"usage":{"prompt_tokens":49,"prompt_tokens_details":{"cached_tokens":22},"completion_tokens":50,"total_tokens":99}}
```

- [ ] Tests (via `startFakeModelServer`, dat een `body`-string letterlijk teruggeeft):
  - reasoning-fixture: `reasoning` is de tekst uit de fixture, `usage.cachedTokens` 0, `systemFingerprint` `fp_ollama`, content `51`;
  - cached-fixture: `usage.cachedTokens` 22;
  - de reasoning-fixture met `reasoning` hernoemd naar `reasoning_content`: `reasoning` wordt gelezen;
  - een antwoord zonder die velden (de bestaande fakes): `reasoning`, `cachedTokens` en `systemFingerprint` zijn `undefined`, geen fout;
  - `durationMs` met `now` die eerst 1000 en daarna 1450 teruggeeft: precies 450;
  - `runManifest` met de twee fixtures als opeenvolgende beurten: de `model_response`-events dragen `reasoning`, `durationMs` en `systemFingerprint`, en `RunResult.usage.cachedTokens` is 22; met antwoorden zonder cachetokens ontbreekt het veld.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(model): denk-tekst, cachetokens, duur en fingerprint per beurt`

### Taak 2: containeruitvoer in de trace

**Files:** Modify `src/trace.ts` (`TraceWriter`, `openTrace`, `container`-event), `src/worker/task-impl.ts` (`runContainer`). Modify `__tests__/trace.test.ts`, `__tests__/task-impl.test.ts`.

**Interfaces:**
- Produces: `TraceWriter.containerOutput(n: number, text: string): void` schrijft `<runDir>/containers/<n>.txt`. Het `container`-event krijgt `n: number` en `outputBytes: number` (`Buffer.byteLength` van de uitvoer).
- `runContainer` geeft zijn volgnummer (`containerNo`) als `n` mee en roept `containerOutput(n, run.output)` aan vóór het event. De uitvoer is de staart van hooguit 64 KiB die `runInContainer` al teruggeeft (`containers.ts:23`).

- [ ] Tests: `containerOutput` schrijft het bestand; het `container`-event heeft `n` en `outputBytes`; met de nep-docker uit de bestaande task-impl-tests is `containers/1.txt` gelijk aan de uitvoer van de eerste container.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(trace): containeruitvoer per container in de run-map`

### Taak 3: redactie (`src/worker/redact.ts`)

**Files:** Create `src/worker/redact.ts`, `__tests__/redact.test.ts`.

**Interfaces:**
- Produces:

```ts
export const REDACTED = '***'
export function collectSecretValues(...envs: Array<Record<string, string | undefined>>): string[] // langste eerst
export function redactText(text: string, secrets: readonly string[]): string
/** Redigeert elke string in een JSON-waarde (objecten en arrays recursief); andere waarden blijven gelijk. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T
```

- `collectSecretValues` en `redactText` zijn een kopie van scrum4me-docker `lib/log-redact.ts:9-58` (52ded13), met een verwijzing in het commentaar. De regelbuffer voor streams (`:60-88`) is niet nodig.

- [ ] Tests, dezelfde gevallen als scrum4me-docker `__tests__/log-redact.test.ts`: secret-achtige sleutels worden gepakt en gewone waarden blijven staan; het wachtwoord uit een URL-waarde onder een niet-secret sleutel, ook gedecodeerd; meerdere omgevingen, langste eerst; meerdere secrets op één regel; tekst zonder secrets blijft byte-identiek. Daarnaast: `redactDeep` over geneste objecten en arrays; een wachtwoord in een URL onder de sleutel `MODEL_BASE_URL` wordt gevonden.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): redactieregels van de runner`

### Taak 4: run-log-schrijver en config

**Files:** Create `src/worker/run-log.ts`, `__tests__/run-log.test.ts`. Modify `src/worker/config.ts` (`WorkerConfigSchema`), `examples/worker.json`, `__tests__/worker-config.test.ts`.

**Interfaces:**
- Consumes: `TraceWriter`, `TraceEvent`, `RunResult` (Taak 1 en 2); `redactText`, `redactDeep` (Taak 3).
- Produces:

```ts
export type WorkerLogConfig = { dir: string; pool: string; instance: string } // WorkerConfig.workerLog?
export type RunLogOutcome = 'done' | 'failed' | 'abandoned'
export type RunLogInit = {
  jobId: string
  kind: string                       // claim.kind
  model: { name: string; baseUrl: string }
  version: string                    // 'agent-harness@<package.json-versie>'
  secrets: readonly string[]         // uit collectSecretValues
  now?: () => Date                   // testnaad
  log?: (line: string) => void       // stderr; standaard process.stderr
}
export interface RunLog {
  meta(text: string): void                  // "<iso> [harness] <text>"
  step(text: string): void                  // meta(`step ${text}`)
  worktree(path: string): void              // meta(`worktree path=${path}`) en cwd voor harness.run_start
  follow(trace: TraceWriter): TraceWriter   // tee: eerst de echte trace, dan het run-log
  fail(code: string, message: string, opts?: { override?: boolean }): void
  end(outcome: RunLogOutcome, durationMs: number): void
}
export function openRunLog(cfg: WorkerLogConfig | undefined, init: RunLogInit): RunLog | null
```

**Gedrag** (spec §5):
- `openRunLog` geeft `null` zonder config. Anders maakt hij `<dir>/<pool>/<instance>/runs` aan (recursief), en daarin het bestand met `openSync(pad, 'wx', 0o644)`. Bij `EEXIST` wacht hij tot de volgende seconde en probeert hij het één keer opnieuw. Mislukt het, dan komt er één regel op `log` en is het resultaat `null`. Direct na het aanmaken schrijft hij `claimed job_id=<jobId>` en `config job_id=<jobId> runtime=HARNESS kind=<kind> model=<name> base_url=<baseUrl>` (geredigeerd).
- Elke schrijfactie is één `appendFileSync` met complete regels. Een regeleinde in meta-tekst wordt een spatie.
- `follow()` is de volger uit spec §6.3: de `event`- en `result`-stroom van die paragraaf loopt via de tee, zodat `run.ts` en `task-impl.ts` hun bestaande `trace`-aanroepen houden.
- `follow(trace)` geeft een `TraceWriter` terug die elke aanroep eerst aan `trace` doorgeeft (fouten daarvan gaan door zoals nu) en daarna in een `try/catch` omzet volgens de tabel hieronder.

| Trace | Run-log |
|---|---|
| `run_start` | onthouden; `harness.run_start` volgt bij `tool_snapshot`, of bij het eerstvolgende andere event met lege `tools` |
| `tool_snapshot` | `harness.run_start {runId, model, baseUrl, tools, mcpServers: ['scrum4me'], cwd, version}` |
| `model_request` | onthoud `promptEstimate` voor de volgende beurt |
| `model_response` | `harness.turn {turn, durationMs, finishReason, usageSource, usage: {input, output, cached?}, promptEstimate?, reasoning?, content?, systemFingerprint?}` |
| `tool_call` | `harness.tool_call {callId, name, arguments}` |
| `toolContent(callId, text)` | onthouden tot het bijbehorende `tool_result` |
| `tool_result` | `harness.tool_result {callId, ok, errorCode?, content, contentLength}` |
| `containerOutput(n, text)` + `container` | `harness.container {n, kind, source, exitCode, timedOut, durationMs, outputTail, outputLength}` |
| `context_compacted` | `harness.compacted {turn, messages, bytes, estimateBefore, estimateAfter}` |
| `after_answer` | `harness.gate {turn, outcome}` |
| `run_end` | niets (spec §5.4) |
| `result(runResult)` | `harness.loop_end {status, error?, turns, toolCalls, toolErrors, usageSource, inputTokens, outputTokens, cachedTokens?, durationMs}`; onthoud `answer` en `turns` voor `end` |

- Elke string gaat door `redactDeep` vóór het afkappen (Global Constraints); daarna afkappen met de vlaggen `reasoningTruncated`, `contentTruncated`, `argumentsTruncated`, `answerTruncated` en de lengtes `contentLength` (volledige tooluitvoer) en `outputLength` (bewaarde staart).
- `fail(code, message, {override})`: bewaart de eerste `fail`; een latere vervangt hem alleen met `override: true` (vanuit `abandon` en `uncertainPath`).
- `end(outcome, durationMs)` schrijft het afsluitblok in één `appendFileSync`, precies één keer (een tweede aanroep doet niets), ook als eerdere schrijfacties mislukten:

```
{"type":"harness.run_end","timestamp":…,"outcome":…,"code"?,"message"?,"answer"?,"answerTruncated"?,"turns"?,"durationMs":…}
<iso> [harness] ERROR <CODE>: <bericht>                 ← alleen als outcome ≠ done
<iso> [harness] harness done job_id=<id> exit_code=<0|1> duration_ms=<n>
<iso> [harness] exit code=<0|1>
```

  Bij `outcome` ≠ `done` zonder eerdere `fail` gebruikt `end` `JOB_FAILED` (bij `failed`) of `ABANDONED` (bij `abandoned`), met de tekst `geen reden vastgelegd`. `answer` staat er alleen bij `done`; `exit_code` is 0 alleen bij `done`.
- Best-effort: elke publieke methode vangt elke uitzondering op. Bij de eerste fout gaat er één regel naar `log` (`run-log uitgeschakeld voor job <id>: <fout>`) en stoppen alle tussentijdse regels; `end` probeert zijn blok daarna nog één keer.
- Config: `WorkerConfigSchema` krijgt `workerLog: z.object({ dir: z.string().min(1), pool: z.string().regex(SEGMENT), instance: z.string().regex(SEGMENT) }).optional()` met `SEGMENT = /^[A-Za-z0-9._-]{1,64}$/`. `examples/worker.json` krijgt `"workerLog": { "dir": "/srv/scrum4me/worker-logs", "pool": "harness", "instance": "max2" }`.

- [ ] Tests (`__tests__/run-log.test.ts`, met een tijdelijke map en een vaste `now`):
  - zonder config `null`; met config het pad `<dir>/harness/max2/runs/<YYYYMMDDTHHMMSSZ>.log` en rechten 0644;
  - de eerste twee regels exact, met `claimed job_id=<id>` zonder aanhangsel;
  - elke JSON-regel begint met `{"type":"harness.` en heeft `timestamp` als tweede sleutel; elke meta-regel matcht `^\S+ \[harness\] `;
  - de afbeelding van elk trace-event uit de tabel, inclusief `run_start` bij en zonder `tool_snapshot`;
  - afkappen met vlaggen en lengtes, op de drie grenzen;
  - redactie in meta-regels, `reasoning`, tool-content en `base_url`, en een geheim dat over de afkapgrens valt, wordt toch gemaskeerd;
  - `wx`-botsing: een tweede open in dezelfde seconde wacht en slaagt; een blijvende botsing geeft `null` en één logregel;
  - een schrijffout (map verwijderd of alleen-lezen na het openen) schakelt de tussenregels uit, geeft één logregel en `end` probeert het nog één keer; geen enkele methode gooit;
  - `end` voor `done`, `failed` met en zonder `fail`, en `abandoned`: exact de regels uit het blok, één keer; een tweede `end` schrijft niets;
  - `fail`-voorrang: `VERIFY_FAILED` gevolgd door `JOB_FAILED` houdt `VERIFY_FAILED`; gevolgd door `ABANDONED` met `override` wordt `ABANDONED`;
  - config: een ongeldige `pool` of `instance` wordt geweigerd; zonder `workerLog` blijft de config geldig.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): run-log in het worker-log-formaat`

### Taak 5: bedrading in de worker, idee-chat, CLI en runbook

**Files:** Modify `src/worker/worker.ts` (`WorkerDeps`, `runOneJob`, `runIdeaChatJob`), `src/cli.ts` (`cmdWorker`), `docs/runbooks/idea-chat-worker.md`. Modify `__tests__/worker.test.ts`, `__tests__/cli-worker.test.ts`.

**Interfaces:**
- Consumes: `openRunLog`, `RunLog` (Taak 4); `collectSecretValues` (Taak 3).
- Produces: `WorkerDeps.runLogFor?: (claim: Claim) => RunLog | null`. `runTaskJob` krijgt een vierde parameter `runLog: RunLog | null` (Taak 6 gebruikt hem).

```ts
export async function runOneJob(deps: WorkerDeps, claim: Claim, taskCtx?: TaskJobContext): Promise<JobOutcome> {
  const started = Date.now()
  const runLog = deps.runLogFor?.(claim) ?? null
  let outcome: JobOutcome = 'failed'
  try {
    outcome = claim.kind === 'TASK_IMPLEMENTATION'
      ? await runTaskJob(deps, claim, taskCtx, runLog)
      : await runIdeaChatJob(deps, claim, runLog)
    return outcome
  } catch (err) {
    if (err instanceof ContainerUncertainError) outcome = err.outcome
    else if (!(err instanceof ClaimFilterError)) runLog?.fail('HARNESS_ERROR', err instanceof Error ? err.message : String(err))
    throw err // de worker-lus handelt de fout af zoals nu
  } finally {
    runLog?.end(outcome, Date.now() - started)
  }
}
```

- `runIdeaChatJob(deps, claim, runLog)`: de trace wordt `runLog ? runLog.follow(openTrace(…)) : openTrace(…)`. Foutcodes (spec §5.6), op de plek waar de reden bekend is. Na de run wordt de code één keer bepaald, vlak vóór `close(update)` en ná de bestaande stop-regel (`worker gestopt`): anders zou een eerdere `fail` met de code van de afgebroken run `STOPPED` blokkeren.

| Plek in `runIdeaChatJob` | Code |
|---|---|
| `claim.kind !== 'IDEA_CHAT'` en payload ongeldig (vóór de `throw new ClaimFilterError`) | `CLAIM_FILTER` |
| geen onbeantwoord USER-bericht | `JOB_FAILED` |
| `running` geweigerd | `ABANDONED` |
| `closingUpdate` geeft `failed`: leeg antwoord | `JOB_FAILED` |
| `closingUpdate` geeft `failed`: run niet `completed` | `result.error.code`, anders `BUDGET_EXCEEDED` of `TIMED_OUT`, anders `JOB_FAILED` |
| `runManifest` gooit (de bestaande `catch`) | `HARNESS_ERROR` |
| `lost` | `ABANDONED` |
| stop na een niet-voltooide beurt (`worker gestopt`) | `STOPPED` |

- Jobstappen in idee-chat: `step job_status running`, en na `close` `step job_status <done|failed>`.
- `cmdWorker`: leest de versie uit `package.json` (via `new URL('../package.json', import.meta.url)`), berekent één keer `secrets = collectSecretValues(process.env, env, { MODEL_API_KEY: config.model.apiKey, MODEL_BASE_URL: config.model.baseUrl })` en geeft `runLogFor: (claim) => openRunLog(config.workerLog, { jobId: claim.jobId, kind: claim.kind, model: config.model, version, secrets })` mee.
- Runbook `docs/runbooks/idea-chat-worker.md`, nieuwe sectie "Run-logs in Worker Logs": het `workerLog`-blok, waar de bestanden staan, hoe je ze controleert (eerste regels, afsluitblok), de controle op geheimen uit spec §10 criterium 4 (zonder waarden te tonen), en terugdraaien (blok weg, service herstarten).

- [ ] Tests (`__tests__/worker.test.ts`, met `config.workerLog` naar een tijdelijke map):
  - idee-chat `done`: run-log met `claimed`, `config`, `harness.run_start`, `harness.turn`, `harness.loop_end` en een afsluitblok met `outcome` `done`, `exit code=0` en het antwoord;
  - leeg antwoord → `ERROR JOB_FAILED: …`; `running` geweigerd → `ABANDONED`; `lost` → `ABANDONED`; stop → `STOPPED`;
  - verkeerde kind en ongeldige payload → `ERROR CLAIM_FILTER: …`, precies één blok, en de `ClaimFilterError` bereikt de worker-lus zoals nu;
  - een geïnjecteerde onverwachte fout in de handler → precies één blok met `HARNESS_ERROR`, en de fout gaat ongewijzigd verder;
  - zonder `workerLog` gedraagt de worker zich als nu (de bestaande tests blijven groen);
  - een onschrijfbare `workerLog.dir` → dezelfde jobuitkomst en één logregel.
- [ ] `__tests__/cli-worker.test.ts`, naar het voorbeeld van de bestaande test "runs one job with the expanded token only in the MCP env": met `workerLog` in de config staat na één job een run-log in `<dir>/harness/max2/runs/`, `harness.run_start` draagt `version` `agent-harness@<versie uit package.json>`, en het uitgebreide token komt nergens in het run-log voor.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): run-log voor idee-chat, CLI-bedrading en runbook`

### Taak 6: bedrading in de taakjob

**Files:** Modify `src/worker/task-impl.ts` (`runTaskJob`, `closeFailed`, `failPath`, `abandon`, `uncertainPath`, `interrupted`), `__tests__/task-impl.test.ts`.

**Interfaces:**
- Consumes: `RunLog` (Taak 4), de vierde parameter van `runTaskJob` (Taak 5).
- Produces: `closeFailed(error: string, code: string)` en `failPath(reason: string, code: string, scanned = false)`; `failPath` geeft zijn code door aan `closeFailed`, en `closeFailed` roept `runLog?.fail(code, error)` aan.

- De trace wordt `runLog ? runLog.follow(openTrace(deps.out, runId)) : openTrace(deps.out, runId)`. Na het parsen van de payload: `runLog?.worktree(p.worktree_path)`.
- Codes per plek (spec §5.6):

| Plek in `runTaskJob` | Code |
|---|---|
| `openTrace` gooit | `HARNESS_ERROR` |
| payload ongeldig | `PAYLOAD_INVALID` |
| geen `task`-config | `NO_TASK_CONFIG` |
| achtergebleven containers | `CONTAINERS_LEFTOVER` |
| snapshot van de git-administratie mislukt (vóór en na de loop) | `GIT_SCAN_FAILED` |
| geen recept | `NO_RECIPE` |
| `running` geweigerd | `ABANDONED` |
| `update_task_status in_progress` mislukt | `JOB_FAILED` |
| prepare niet groen | `PREPARE_FAILED` |
| `runManifest` gooit | `HARNESS_ERROR` |
| run niet `completed` | `result.error.code`, anders `BUDGET_EXCEEDED` of `TIMED_OUT`; `STOPPED` als de service stopte |
| `interrupted()` met `deps.signal.aborted` | `STOPPED` |
| git-administratie gewijzigd | `GIT_ADMIN_CHANGED` |
| commit mislukt | `COMMIT_FAILED` |
| geen wijzigingen | `NO_CHANGES` |
| `verify_task_against_plan` mislukt of niet `aligned`/`partial` | `PLAN_CHECK_FAILED` |
| `done` geweigerd | `DONE_REFUSED` |
| uitkomst van `done` onbekend | `DONE_UNKNOWN` |
| `done` eindigde als FAILED na een pushfout | `DONE_ENDED_FAILED` |
| `abandon()` | `ABANDONED`, met `override` |
| `uncertainPath()` | `CONTAINER_UNCERTAIN`, met `override`, vóór de `throw` |

- Jobstappen: `step task_status in_progress`, `step commit sha=<sha>`, `step plan_check <result>`, `step job_status done pushed_at=<ja|nee>`, `step task_status review <ok|mislukt>`.

- [ ] Tests (`__tests__/task-impl.test.ts`, met de bestaande nep-docker en het nepstuurkanaal, en `workerLog` naar een tijdelijke map):
  - groen pad: `worktree path=`, `harness.run_start` met `cwd` = worktree, containerblokken voor prepare en gate, de stappen, en een blok met `done`;
  - geen recept → `NO_RECIPE`; prepare rood → `PREPARE_FAILED`;
  - gate drie keer rood → `VERIFY_FAILED` blijft staan na `closeFailed`;
  - een geslaagde loop gevolgd door een fout na de loop: commit mislukt → `COMMIT_FAILED`, plancontrole mislukt → `PLAN_CHECK_FAILED`, `done` geweigerd → `DONE_REFUSED`, telkens `outcome` `failed`;
  - `done` onbekend → `DONE_UNKNOWN` met `outcome` `abandoned`;
  - heartbeat geweigerd na een eerdere `fail` → `ABANDONED` (override);
  - container niet aantoonbaar gestopt → `CONTAINER_UNCERTAIN`, één blok, en de `ContainerUncertainError` bereikt de worker-lus zoals nu;
  - stop tijdens de verify → `STOPPED`.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): run-log voor taakjobs met foutcodes en jobstappen`

Na Taak 6: push `feat/m4-run-logging` naar Forgejo en open een PR (JP merget).

## Increment 2 — max2: uitrol harness en de eerste echte run-log (op JP's go)

### Taak 7: uitrol harness en de eerste echte run-log

Alleen na merge van de harness-PR en op JP's go. Geheimen nooit printen of loggen.

- [ ] Harness op max2 bijwerken volgens `docs/runbooks/task-worker.md`: pull (PAT via stdin-askpass), `npm ci`, `npm run build`. `/etc/agent-harness/worker.json`: backup naar `*.bak-pre-m4`, dan het blok `"workerLog": { "dir": "/srv/scrum4me/worker-logs", "pool": "harness", "instance": "max2" }`. `systemctl restart agent-harness-worker`; `journalctl -u agent-harness-worker` toont geen fout.
- [ ] Eén idee-chat-job: JP stuurt een chatbericht op een idee van het product Agent-harness (zoals in M2). Controle op max2:
  - er staat één bestand in `/srv/scrum4me/worker-logs/harness/max2/runs/`;
  - de eerste twee regels zijn `claimed job_id=…` en `config …`;
  - elke JSON-regel begint met `{"type":"harness.`;
  - het bestand eindigt op het afsluitblok.
- [ ] Criterium 5: de ingest-ronde daarna geeft geen fout op het bestand; de reden is `idle`.
- [ ] Criterium 4 op dit bestand, volgens de runbook.
- [ ] Fixture voor Taak 8: kopieer het bestand naar `test/fixtures/worker-logs/harness-idea-chat.log` in de Ops-dashboard-werkplek. Schonen: de controle uit criterium 4 geeft 0 treffers; tekst van het idee en lange denk-tekst mogen worden ingekort, maar regelvolgorde, sleutels, tags en de vorm van elke regel blijven exact.

## Increment 3 — Ops-dashboard

Werkplek: `git -C ~/Development/Ops-dashboard worktree add ../Ops-dashboard-m4 -b feat/harness-run-logs origin/main`, dan `npm ci`.

### Taak 8: de parser leert het harness-formaat

**Files:** Modify `lib/parse-worker-log.ts`, `test/parse-worker-log.test.ts`. Create `test/fixtures/worker-logs/harness-idea-chat.log` (uit Taak 7).

**Interfaces:**
- Consumes: het run-log-contract (spec §5; Global Constraints).
- Produces: geen nieuwe export; `summarizeRunLog` en `parseRunLog` houden hun handtekening.

Wijzigingen (spec §7):
- `META_RE` wordt `/^(\S+)\s+\[(run-one-job|harness)\]\s+(.*)$/`. Op beide plekken die hem gebruiken (`summarizeRunLog` ~`:179-181`, `parseRunLog` ~`:551-553`) wordt de tekst `m[3]` in plaats van `m[2]`; `m[1]` blijft de tijd. Tag `harness` zet `harnessLog = true`.
- De done-regel wordt `/^(claude|codex|harness) done\b/`, in `classifyMeta` en in `summarizeRunLog`.
- `summarizeRunLog`, alleen voor harness-logs:

```ts
// in de JSON-tak, naast de bestaande {"type":"result"-tak
if (trimmed.startsWith('{"type":"harness.run_end"')) {
  try {
    const obj = JSON.parse(trimmed)
    harnessResult = true
    resultIsError = obj.outcome !== 'done'
    resultSubtype = typeof obj.outcome === 'string' ? obj.outcome : null
    if (typeof obj.turns === 'number') numTurns = obj.turns
    if (durationMs == null && typeof obj.durationMs === 'number') durationMs = obj.durationMs
  } catch { /* half geschreven regel: negeren */ }
}
// na de lus
const terminal = harnessLog
  ? runExit != null
  : runExit != null || hasResult || hasErrorLine || tokenExpired
```

- `pushHarnessEvent(events, obj, ts)` wordt vóór `pushCodexEvent` aangeroepen in `pushJsonEvent` en handelt elk `type` dat met `harness.` begint af (`ts` = `obj.timestamp`):

| `type` | LogEvent(s) |
|---|---|
| `harness.run_start` | `system-init`: model, permissionMode `—`, tools, mcpServers, sessionId = runId, cwd, version |
| `harness.turn` | `thinking` (reasoning), `assistant-text` (content, alleen niet leeg), `raw` `turn <n> · <s> s · in <x> · cached <y> · out <z> · <finish>`; `in`/`out` alleen bij `usageSource` `provider_reported`, `cached` alleen als aanwezig |
| `harness.tool_call` | `tool-call` (id = callId, name); input is de opgemaakte JSON als `arguments` naar een object parst, anders `JSON.stringify({ arguments: <ruwe string> }, null, 2)` |
| `harness.tool_result` | `tool-result` (toolUseId = callId, isError = !ok, body met `[<errorCode>] ` ervoor, fullLength = contentLength) |
| `harness.container` | `source` `prepare` of `gate`: `tool-call` (name `container:<kind>/<source>`, id `container-<n>`, input `{exitCode, timedOut, durationMs}`) plus `tool-result` (body = outputTail, isError = exitCode ≠ 0 of timedOut, fullLength = outputLength); `source` `run_tests`: alleen `raw` `container verify/run_tests · exit <code> · <s> s` |
| `harness.compacted`, `harness.gate`, `harness.loop_end` | `raw`, één regel (`loop_end`: `model loop <status>[ <code>] · <turns> turns · <toolCalls> tool calls · in <x> · out <z> · <s> s`) |
| `harness.run_end` | `result`: subtype = outcome, isError = outcome ≠ `done`, durationMs, numTurns = turns, totalCostUsd `null`, resultText = `<code>: <message>` bij een fout, anders answer |
| ander `harness.*` | `raw`, JSON afgekapt op 2048 tekens |

- `truncated` wordt waar als de parser afkapt of als de regel de bijbehorende vlag draagt.
- Het commentaar over pools (`:21`) wordt bijgewerkt.

- [ ] Tests (`test/parse-worker-log.test.ts`):
  - de fixture: samenvatting (`jobId`, status `success`, `model`, `numTurns`, `durationMs`, `exitCode` 0, `inProgress` false) en de eventsoorten in volgorde;
  - `META_RE` op beide tags; de done-regel met `harness`;
  - een harness-log zonder afsluitblok is `running`; ook `running` met `harness.run_end` en een `ERROR`-regel maar zonder `exit code=` (groeiend bestand), en met een afgekapte `exit code=`-regel zonder cijfer;
  - `error` met een `ERROR`-regel gevolgd door `exit code=1`, en `error` met een `harness.run_end` waarvan `outcome` ≠ `done`, gevolgd door `exit code=1`; `errorSummary` is dan `<CODE>: …`;
  - argumenten `null`, een getal, een JSON-string, een array en ongeldige JSON worden `{"arguments": …}`; alleen een object wordt opgemaakt;
  - een onbekend `harness.*`-type wordt `raw`;
  - de bestaande Claude- en Codex-tests blijven groen zonder aanpassing.
- [ ] FAIL → implementeer → PASS; `npm run typecheck && npm test` groen.
- [ ] Commit: `feat(worker-logs): parser leert het run-log van agent-harness`; push en PR op Forgejo (JP merget).

## Increment 4 — uitrol Ops-dashboard en acceptatie (op JP's go)

### Taak 9: uitrol parser op max2, criteria 1, 5 en 6

- [ ] Na merge: `redeploy_ops_dashboard` op max2 via de ops-agent-flow (JP's go).
- [ ] Criterium 1: bij de volgende ingest-ronde verschijnt de run uit Taak 7 als `WorkerRun` met pool `harness`, host `max2`, status success, `job_id`, `model`, `num_turns` en `duration_ms`. Het detail in scrum4me-workers `/worker-logs` toont denk-tekst, antwoord, toolblokken en de meetregel per beurt; het Ops-dashboard op max2 toont hetzelfde van schijf.
- [ ] Criterium 6: nieuwe idea- en codex-runs verschijnen zoals voorheen.

### Taak 10: taakjob, foutproef en triage (criteria 2, 3 en 4)

- [ ] Criterium 2: een kleine echte taak via `dispatch_job` met `required_capability: 'local_llm'`. De run toont `worktree path=`, containerblokken voor prepare en gate met uitvoer, de `run_tests`-regels en de jobstappen. Het geschoonde run-log wordt de tweede fixture in het Ops-dashboard (kleine vervolg-PR, JP merget).
- [ ] Criterium 3: tijdelijk het altijd-rode recept uit M3-criterium 2 (backup van `worker.json`, herstart), een kleine proeftaak dispatchen: de run staat op error met `error_summary` `VERIFY_FAILED: …`. Daarna start JP `worker-insights-triage.service` op scrum4me-srv, zo nodig herhaald (hooguit vijf keer) tot de run een `WorkerInsight` heeft of een ronde niets meer verwerkt; aantal starts en tijden vastleggen. Normale config terug en herstarten.
- [ ] Criterium 4 over alle bestanden in `/srv/scrum4me/worker-logs/harness/`.
- [ ] Bewijs per criterium (job-id, run-id, relevante regels) in `docs/runbooks/idea-chat-worker.md`, in een docs-PR.

## Buiten dit plan

Streaming en de splitsing prompt-verwerking/generatie, vergelijken tussen endpoints (stap 2), een eigen triage-indeling, bewaartermijn van harness-run-logs, CLI-runs in Worker Logs, backfill van oude traces, een gateway.

## Review record

Nog geen rondes.

# M4 — harness-runs volgen in Worker Logs: implementatieplan

_Status: reviewed, revisie 8 (2026-09-28), dubbel GO in planronde 7. Een technisch GO autoriseert geen ceremonie, implementatie, merge of uitrol._

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
- Een controle op geheimen zet nooit een waarde in argv, uitvoer of een log; alleen namen en tellingen.
- **Stopprocedure voor de worker op max2**, vóór elke herstart of stop (journal en containers alleen tonen geen claim; die zijn aanvullend bewijs, geen toets). De procedure vergelijkt twee opnames van dezelfde read-only query, op scrum4me-srv via `docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me -Atc "select id, kind, status, retry_count from claude_jobs where required_capability = 'local_llm' order by id"`, in één tijdelijke map (`mktemp -d`). Een opname telt alleen als `psql` met exitcode 0 eindigt: schrijf hem eerst naar een tussenbestand en hernoem hem pas daarna. Een mislukt commando is nooit een schone uitkomst: vóór de stop wordt er dan niet gestopt, erna blijft de service gestopt en gaat de fout naar JP. Er komt bewust geen tijdsgrens aan te pas: `claimed_at` krijgt `NOW()`, de starttijd van de claimtransactie (scrum4me-mcp `src/tools/wait-for-job.ts:764,846`), dus een claim die bij de eerste opname nog niet gecommit is, kan een claimtijd van vóór die opname krijgen. De kolom `error` wordt nooit geselecteerd: die kan ongeredigeerde model- of tooltekst bevatten (`src/model-client.ts:97`, via `closeFailed` in `src/worker/task-impl.ts:161`).
  1. Opname `voor.txt`. Geen regel heeft status `CLAIMED` of `RUNNING`.
  2. `systemctl stop agent-harness-worker` moet slagen, en daarna geeft `systemctl is-active agent-harness-worker` `inactive` of `failed`. De stop keert pas terug als de control group leeg is (`KillMode=mixed`, `TimeoutStopSec=180`, `docs/runbooks/task-worker.md:64-65,84`), dus daarna claimt deze worker niets meer. Dan opname `na.txt`. De stop is schoon als `diff voor.txt na.txt` met exitcode 0 eindigt; 1 betekent verschil, hoger een fout. Elke verschilregel wijst een job aan die na `voor.txt` is geclaimd, afgesloten, teruggezet of nieuw gedispatcht. Een afgebroken `wait_for_job` kan een claim achterlaten die pas via de lease-reset weer `QUEUED` wordt (`src/worker/control.ts:84-97`, `src/worker/worker.ts:201-219`); die reset verhoogt `retry_count` (`wait-for-job.ts:620-627`), dus ook zo'n rij verschilt. Alleen een claim die de MCP zelf terugdraait voordat de worker de job krijgt (`rollbackClaim`, `wait-for-job.ts:254`, alleen aangeroepen binnen `wait_for_job`), laat een gelijke regel achter; zo'n job staat weer in de rij en de worker is er niet aan begonnen. Is de diff niet leeg, dan blijft de service gestopt, gaan de ID's uit de diff met hun regels naar JP, en wordt er niets opnieuw gedispatcht. Daarna wordt alleen `select id, kind, status, retry_count from claude_jobs where id in ('<id>', …)` met die ID's herhaald. Stap 3 volgt pas als elk ervan terminaal of weer `QUEUED` is en JP over een eventuele herdispatch heeft beslist. Blijft een ID op `CLAIMED` staan, dan beslist JP of stap 3 toch volgt: de lease-reset draait alleen binnen `wait_for_job` (scrum4me-mcp `wait-for-job.ts:586,2101,2153`), met deze worker gestopt dus alleen als een andere worker van dezelfde gebruiker pollt; na de start zet de eerste `wait_for_job` van deze worker zo'n claim zelf terug zodra de lease van 5 minuten (`:849`) is verlopen. Een nieuw gedispatchte job die nog op `QUEUED` staat, is geen claim; JP kan hem laten staan.
  3. De wijziging, en daarna `systemctl start agent-harness-worker` en controle dat de service `active` is.

## Review Focus

1. **Een geheim dat terugkomt in tooluitvoer of denk-tekst**, bijvoorbeeld een Prisma-fout met `DATABASE_URL`, ook als het over een afkapgrens valt. Verwacht: gemaskeerd, want de redactie gaat vóór het afkappen. → Taak 3 en Taak 4.
2. **Een ingest-ronde die midden in een taakjob of midden in het afsluitblok leest.** Verwacht: `running`, en de volgende ronde leest het bestand opnieuw. → Taak 9.
3. **Eén stopsignaal (systemd-stop) tijdens een taakjob.** Verwacht: afsluitblok met `STOPPED`, nooit blijvend `running`. → Taak 6.
4. **Een volle schijf of een onschrijfbare worker-logs-map.** Verwacht: de job loopt ongehinderd, er komt één regel in journald en er is geen run-log. → Taak 4 en Taak 5.
5. **Een model dat `null`, een getal of een string als toolargumenten stuurt.** Verwacht: de run wordt toch ingelezen, met de argumenten als `{"arguments": …}`. → Taak 9.

## Bouwvolgorde

Spec §8: eerst het harness (PR, merge, max2), dan één echte idee-chat-job voor de fixture, dan de parser in het Ops-dashboard (PR, merge, uitrol op max2), dan de taakjob. Het bewijs voor een mislukte run volgt bij de eerste echte fout (spec §8 stap 4, tweede optie). Spec en plan gaan vooraf als docs-PR (branch `docs/m4-run-logging-spec`). Tussen de harness-uitrol en de parser-uitrol slaat de ingest de harness-bestanden over als `idle`; dat is onschadelijk.

## Bestandsstructuur

| Repo | Bestand | Verantwoordelijkheid | Taak |
|---|---|---|---|
| agent-harness | `src/types.ts`, `src/model-client.ts`, `src/run.ts`, `src/trace.ts` | denk-tekst, cachetokens, duur, fingerprint | 1 |
| agent-harness | `__tests__/fixtures/ollama-v1-*.json` (nieuw) | echte Ollama-antwoorden | 1 |
| agent-harness | `src/trace.ts`, `src/worker/task-impl.ts` | containeruitvoer in de trace | 2 |
| agent-harness | `src/worker/redact.ts` (nieuw) | redactieregels van de runner | 3 |
| agent-harness | `src/worker/run-log.ts` (nieuw), `src/worker/config.ts`, `examples/worker.json` | run-log-schrijver, config | 4 |
| agent-harness | `src/worker/worker.ts`, `src/worker/task-impl.ts` (signatuur, trace), `src/cli.ts`, `docs/runbooks/idea-chat-worker.md` | bedrading, idee-chat, runbook | 5 |
| agent-harness | `src/worker/task-impl.ts` | foutcodes en jobstappen van de taakjob | 6 |
| agent-harness | `src/worker/check-run-logs.ts` (nieuw), `src/cli.ts`, `docs/runbooks/idea-chat-worker.md` | controle op geheimen zonder waarden te tonen | 7 |
| max2 | `/etc/agent-harness/worker.json`, `/srv/scrum4me/worker-logs/harness/` | uitrol, eerste echte run-log | 8 |
| Ops-dashboard | `lib/parse-worker-log.ts`, `test/parse-worker-log.test.ts`, `test/fixtures/worker-logs/harness-idea-chat.log` (nieuw) | parser met harness-tak | 9 |
| max2, scrum4me-srv | Ops-dashboard, triage | uitrol parser, acceptatie | 10, 11 |

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

**Files:** Create `src/worker/redact.ts`, `__tests__/redact.test.ts`. Consumes `workerMcpEnv` uit `src/worker/config.ts`.

**Interfaces:**
- Produces:

```ts
export const REDACTED = '***'
/** Alle kandidaten met hun bron: de waarde van een variabele met een geheim-achtige naam, en het wachtwoord uit elke URL-waarde (ruw en gedecodeerd). Zonder lengtefilter; lege waarden vallen weg. */
export function collectSecretEntries(...envs: Array<Record<string, string | undefined>>): { name: string; value: string }[]
/** De redactieset: de waarden uit collectSecretEntries vanaf 8 tekens, uniek, langste eerst (= de runnerregel). */
export function collectSecretValues(...envs: Array<Record<string, string | undefined>>): string[]
export function redactText(text: string, secrets: readonly string[]): string
/** Redigeert elke string in een JSON-waarde (objecten en arrays recursief); andere waarden blijven gelijk. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T
```

- De selectieregels en `redactText` zijn een kopie van scrum4me-docker `lib/log-redact.ts:9-58` (52ded13), met een verwijzing in het commentaar; `collectSecretEntries` levert dezelfde selectie met de naam erbij (voor een URL-wachtwoord `<SLEUTEL> (url-wachtwoord)`), en `collectSecretValues` is daarvan afgeleid, zodat de redactie en de controle van Taak 7 dezelfde selectie delen. De regelbuffer voor streams (`:60-88`) is niet nodig.
- `workerSecretSources(config, processEnv)` geeft de vier bronnen als lijst: `processEnv`, `workerMcpEnv(config, processEnv)` en `{ MODEL_API_KEY: config.model.apiKey, MODEL_BASE_URL: config.model.baseUrl }`. De worker (Taak 5) en de controle (Taak 7) gebruiken allebei deze functie.

- [ ] Tests, dezelfde gevallen als scrum4me-docker `__tests__/log-redact.test.ts`: secret-achtige sleutels worden gepakt en gewone waarden blijven staan; het wachtwoord uit een URL-waarde onder een niet-secret sleutel, ook gedecodeerd; meerdere omgevingen, langste eerst; meerdere secrets op één regel; tekst zonder secrets blijft byte-identiek. Daarnaast: `redactDeep` over geneste objecten en arrays; een wachtwoord in een URL onder de sleutel `MODEL_BASE_URL` wordt gevonden; `collectSecretEntries` houdt korte waarden en namen, en laat lege waarden weg; elke waarde uit `collectSecretValues` zit ook in `collectSecretEntries` (pariteit); `workerSecretSources` levert een waarde uit elk van de vier bronnen.
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
  cwd?: string                       // voor harness.run_start; standaard process.cwd(), worktree() overschrijft het
  now?: () => Date                   // testnaad
  sleep?: (ms: number) => void       // testnaad voor de wx-poging; standaard synchroon wachten met Atomics.wait
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
- `openRunLog` geeft `null` zonder config. Anders maakt hij `<dir>/<pool>/<instance>/runs` aan (recursief), en daarin het bestand met `openSync(pad, 'wx', 0o644)`. Bij `EEXIST` wacht hij met `sleep` tot de volgende seconde (hooguit één seconde, vóór de job begint) en probeert hij het één keer opnieuw. Mislukt het, dan komt er één regel op `log` en is het resultaat `null`. Direct na het aanmaken schrijft hij `claimed job_id=<jobId>` en `config job_id=<jobId> runtime=HARNESS kind=<kind> model=<name> base_url=<baseUrl>` (geredigeerd).
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

- [ ] Tests (`__tests__/run-log.test.ts`, met een tijdelijke map, een vaste `now` en een `sleep` die die klok vooruitzet):
  - zonder config `null`; met config het pad `<dir>/harness/max2/runs/<YYYYMMDDTHHMMSSZ>.log` en rechten 0644;
  - de eerste twee regels exact, met `claimed job_id=<id>` zonder aanhangsel;
  - elke JSON-regel begint met `{"type":"harness.` en heeft `timestamp` als tweede sleutel; elke meta-regel matcht `^\S+ \[harness\] `;
  - de afbeelding van elk trace-event uit de tabel, inclusief `run_start` bij en zonder `tool_snapshot`; `cwd` is standaard de werkmap en na `worktree()` de worktree;
  - afkappen met vlaggen en lengtes, op de drie grenzen;
  - redactie in meta-regels, `reasoning`, tool-content en `base_url`, en een geheim dat over de afkapgrens valt, wordt toch gemaskeerd;
  - `wx`-botsing: een tweede open in dezelfde seconde wacht en slaagt; een blijvende botsing geeft `null` en één logregel;
  - een schrijffout (map verwijderd of alleen-lezen na het openen) schakelt de tussenregels uit, geeft één logregel en `end` probeert het nog één keer; geen enkele methode gooit;
  - een uitzondering in de omzetting, ná een geslaagde trace-write: een event met een getter op `usage` die de eerste keer een waarde geeft (de spread in `trace.event` leest hem één keer) en daarna gooit, via `follow(trace)`: de echte trace heeft het event, de aanroep gooit niet, het run-log gaat uit met één logregel, en `end` schrijft het blok toch;
  - `end` voor `done`, `failed` met en zonder `fail`, en `abandoned`: exact de regels uit het blok, één keer; een tweede `end` schrijft niets;
  - `fail`-voorrang: `VERIFY_FAILED` gevolgd door `JOB_FAILED` houdt `VERIFY_FAILED`; gevolgd door `ABANDONED` met `override` wordt `ABANDONED`;
  - config: een ongeldige `pool` of `instance` wordt geweigerd; zonder `workerLog` blijft de config geldig.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): run-log in het worker-log-formaat`

### Taak 5: bedrading in de worker, idee-chat, CLI en runbook

**Files:** Modify `src/worker/worker.ts` (`WorkerDeps`, `runOneJob`, `runIdeaChatJob`), `src/worker/task-impl.ts` (signatuur van `runTaskJob`, de trace, `worktree`), `src/cli.ts` (`cmdWorker`), `docs/runbooks/idea-chat-worker.md`. Modify `__tests__/worker.test.ts`, `__tests__/task-impl.test.ts` (alleen de testhulp), `__tests__/cli-worker.test.ts`.

**Interfaces:**
- Consumes: `openRunLog`, `RunLog` (Taak 4); `collectSecretValues` (Taak 3).
- Produces: `WorkerDeps.runLogFor?: (claim: Claim) => RunLog | null`. `runTaskJob` krijgt een vierde parameter `runLog: RunLog | null`, en gebruikt hem in deze taak al op twee plekken (anders faalt de lint-regel `no-unused-vars` op de ongebruikte laatste parameter): de trace wordt `runLog ? runLog.follow(openTrace(deps.out, runId)) : openTrace(deps.out, runId)`, en na het parsen van de payload volgt `runLog?.worktree(p.worktree_path)`. Taak 6 voegt de codes en stappen toe.

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
- `cmdWorker`: leest de versie uit `package.json` (via `new URL('../package.json', import.meta.url)`), berekent één keer `secrets = collectSecretValues(...workerSecretSources(config, process.env))` en geeft `runLogFor: (claim) => openRunLog(config.workerLog, { jobId: claim.jobId, kind: claim.kind, model: config.model, version, secrets })` mee.
- Runbook `docs/runbooks/idea-chat-worker.md`, nieuwe sectie "Run-logs in Worker Logs": het `workerLog`-blok, waar de bestanden staan, hoe je ze controleert (eerste regels, afsluitblok), de controle op geheimen uit spec §10 criterium 4 (zonder waarden te tonen), en terugdraaien (blok weg, service herstarten).

- [ ] Tests (`__tests__/worker.test.ts`). De testhulp van `worker.test.ts` en `task-impl.test.ts` zet `deps.runLogFor = (claim) => openRunLog({ dir: <tijdelijke map>, pool: 'harness', instance: 'test' }, { jobId: claim.jobId, kind: claim.kind, model: config.model, version: 'agent-harness@test', secrets: [] })`; alleen `cli-worker.test.ts` loopt via `config.workerLog`.
  - idee-chat `done`: run-log met `claimed`, `config`, `harness.run_start`, `harness.turn`, `harness.loop_end` en een afsluitblok met `outcome` `done`, `exit code=0` en het antwoord;
  - leeg antwoord → `ERROR JOB_FAILED: …`; `running` geweigerd → `ABANDONED`; `lost` → `ABANDONED`; stop → `STOPPED`;
  - verkeerde kind en ongeldige payload → `ERROR CLAIM_FILTER: …`, precies één blok, en de `ClaimFilterError` bereikt de worker-lus zoals nu;
  - een geïnjecteerde onverwachte fout in de handler → precies één blok met `HARNESS_ERROR`, en de fout gaat ongewijzigd verder;
  - zonder `runLogFor` gedraagt de worker zich als nu (de bestaande tests blijven groen);
  - een onschrijfbare map → dezelfde jobuitkomst en één logregel.
- [ ] `__tests__/cli-worker.test.ts`, naar het voorbeeld van de bestaande test "runs one job with the expanded token only in the MCP env": met `workerLog` in de config staat na één job een run-log in `<dir>/harness/max2/runs/`, en `harness.run_start` draagt `version` `agent-harness@<versie uit package.json>`. Een aparte test (naast de bestaande op `:115`, die over de run-map gaat; de trace is bewust ongeredigeerd) laat het gescripte modelantwoord drie testgeheimen dragen, in `content` en in `reasoning`: een geheim-achtige variabele in `process.env`, het uitgebreide token in de MCP-omgeving en `model.apiKey`. Geen van de drie staat in het run-log, `***` wel. Het vierde, een wachtwoord in `model.baseUrl`, dekken de `base_url`-test van Taak 4 en de bronnentest van Taak 3, want met zo'n URL faalt de modelaanroep al in `fetch` en komt er geen beurt.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(worker): run-log voor idee-chat, CLI-bedrading en runbook`

### Taak 6: bedrading in de taakjob

**Files:** Modify `src/worker/task-impl.ts` (`runTaskJob`, `closeFailed`, `failPath`, `abandon`, `uncertainPath`, `interrupted`), `__tests__/task-impl.test.ts`.

**Interfaces:**
- Consumes: `RunLog` (Taak 4), de vierde parameter van `runTaskJob` (Taak 5).
- Produces: `closeFailed(error: string, code: string)` en `failPath(reason: string, code: string, scanned = false)`; `failPath` geeft zijn code door aan `closeFailed`, en `closeFailed` roept `runLog?.fail(code, error)` aan.

- De trace en `worktree()` zijn al bedraad in Taak 5. Codes per plek (spec §5.6):

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

- [ ] Tests (`__tests__/task-impl.test.ts`, met de bestaande nep-docker, het nepstuurkanaal en de `runLogFor` uit de testhulp van Taak 5):
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

### Taak 7: controle op geheimen in de run-logs

**Files:** Create `src/worker/check-run-logs.ts`, `__tests__/check-run-logs.test.ts`. Modify `src/cli.ts` (subcommando `check-run-logs`, gebruikstekst), `docs/runbooks/idea-chat-worker.md` (de sectie uit Taak 5).

**Interfaces:**
- Consumes: `loadWorkerConfig` (`src/worker/config.ts`); `collectSecretEntries`, `workerSecretSources` (Taak 3).
- Produces: `harness check-run-logs --config <worker.json> --dir <map>` (optie `dir` erbij in de `parseArgs`-config van `src/cli.ts`, die `strict` is), en `checkRunLogs(config, processEnv, dir): { checked: number; results: { name: string; hits: number; short: boolean }[] }`.

- De controle leest de geheimen zelf, met `collectSecretEntries(...workerSecretSources(config, process.env))`: dezelfde selectie als de redactie, maar ook korter dan 8 tekens. Lege waarden doen niet mee.
- Hij doorzoekt elk bestand onder `--dir` en drukt eerst het aantal gecontroleerde geheimen af, daarna per geheim alleen de naam, het aantal treffers en of de waarde korter is dan 8 tekens. Nooit een waarde. Exitcode 1 bij minstens één treffer, en ook als er nul geheimen gecontroleerd zijn (dan draait hij waarschijnlijk zonder de service-omgeving).
- Een kort geheim dat in een run-log staat, betekent dat criterium 4 niet gehaald is: dan wordt de redactie versterkt of JP beslist over een spec-delta. Zo'n waarde wordt niet stil overgeslagen.
- Runbook: de controle draait met de omgeving van de service, zonder dat een waarde in argv komt: `sudo systemd-run --wait --pipe --uid=janpeter -p EnvironmentFile=/etc/agent-harness/worker.env /usr/bin/node /home/janpeter/Development/agent-harness/dist/cli.js check-run-logs --config /etc/agent-harness/worker.json --dir /srv/scrum4me/worker-logs/harness`. De namencontrole van criterium 4 gebruikt alleen `sudo cut -d= -f1 /etc/agent-harness/worker.env`.

- [ ] Tests: een tijdelijke map met een bestand dat één geheim bevat → die naam met 1 treffer en exitcode 1; zonder treffers exitcode 0; nul gecontroleerde geheimen → exitcode 1; een geheim van 5 tekens wordt gecontroleerd en als kort gemarkeerd; een lege geheim-achtige variabele doet niet mee (geen vals alarm); een URL-wachtwoord wordt ook in gedecodeerde vorm gevonden; de uitvoer bevat geen enkele geheime waarde.
- [ ] FAIL → implementeer → PASS; `npm run verify` groen.
- [ ] Commit: `feat(cli): check-run-logs — controle op geheimen zonder waarden te tonen`

Na Taak 7: push `feat/m4-run-logging` naar Forgejo en open een PR (JP merget).

## Increment 2 — max2: uitrol harness en de eerste echte run-log (op JP's go)

### Taak 8: uitrol harness en de eerste echte run-log

Alleen na merge van de harness-PR en op JP's go. Geheimen nooit printen of loggen.

- [ ] Harness op max2 bijwerken volgens `docs/runbooks/task-worker.md`: pull (PAT via stdin-askpass), `npm ci`, `npm run build`. `/etc/agent-harness/worker.json`: backup met behoud van eigenaar en rechten (`cp -p` naar `*.bak-pre-m4`), dan het blok `"workerLog": { "dir": "/srv/scrum4me/worker-logs", "pool": "harness", "instance": "max2" }`. Stoppen en starten volgens de stopprocedure (Global Constraints); daarna toont `journalctl -u agent-harness-worker` geen fout.
- [ ] Eén idee-chat-job: JP stuurt een chatbericht op een idee van het product Agent-harness (zoals in M2). Controle op max2:
  - er staat één bestand in `/srv/scrum4me/worker-logs/harness/max2/runs/`;
  - de eerste twee regels zijn `claimed job_id=…` en `config …`;
  - elke JSON-regel begint met `{"type":"harness.`;
  - het bestand eindigt op het afsluitblok.
- [ ] Criterium 5: de respons van de ingest-ronde daarna (journal van `worker-logs-ingest.service`) heeft een lege `errors`-lijst. `skippedIdle` is een totaal over alle bestanden en bewijst niets per bestand; dat de huidige parser dit bestand als `idle` overslaat, volgt uit zijn code (`parse-worker-log.ts:243-246`, `ingest-worker-log.ts:248-249`).
- [ ] Criterium 4 op dit bestand met `harness check-run-logs` (Taak 7), volgens de runbook.
- [ ] Fixture voor Taak 9: kopieer het bestand naar de Mac, naar `~/Development/m4-fixtures/harness-idea-chat.log` (buiten elke repo; Taak 9 neemt het over). Schonen: `check-run-logs` gaf 0 treffers; tekst van het idee en denk-tekst mogen alleen worden vervangen door neutrale tekst van precies dezelfde lengte, zodat `…Length`-velden en vlaggen blijven kloppen. Regelvolgorde, sleutels, tags en de vorm van elke regel blijven exact; er wordt niets ingekort.

## Increment 3 — Ops-dashboard

Werkplek: `git -C ~/Development/Ops-dashboard worktree add ../Ops-dashboard-m4 -b feat/harness-run-logs origin/main`, dan `npm ci`.

### Taak 9: de parser leert het harness-formaat

**Files:** Modify `lib/parse-worker-log.ts`, `test/parse-worker-log.test.ts`. Create `test/fixtures/worker-logs/harness-idea-chat.log` (uit `~/Development/m4-fixtures/`, Taak 8).

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
  - `error` met een `ERROR`-regel gevolgd door `exit code=1` (`errorSummary` is `<CODE>: …`), en `error` met alleen een `harness.run_end` waarvan `outcome` ≠ `done`, gevolgd door `exit code=1` (`errorSummary` is `result: failed`);
  - argumenten `null`, een getal, een JSON-string, een array en ongeldige JSON worden `{"arguments": …}`; alleen een object wordt opgemaakt;
  - een onbekend `harness.*`-type wordt `raw`;
  - de bestaande Claude- en Codex-tests blijven groen zonder aanpassing.
- [ ] FAIL → implementeer → PASS; `npm run typecheck && npm test` groen.
- [ ] Commit: `feat(worker-logs): parser leert het run-log van agent-harness`; push en PR op Forgejo (JP merget).

## Increment 4 — uitrol Ops-dashboard en acceptatie (op JP's go)

### Taak 10: uitrol parser op max2, criteria 1 en 6

- [ ] Na merge: `redeploy_ops_dashboard` op max2 via de ops-agent-flow (JP's go). Leg in UTC vast: T0 = de flow is geslaagd afgerond.
- [ ] Criterium 1: bij de eerste ingest-tick na T0 (timer `*:0/5`) verschijnt de run uit Taak 8 als `WorkerRun` met pool `harness`, host `max2`, status success, `job_id`, `model`, `num_turns` en `duration_ms`. Het detail in scrum4me-workers `/worker-logs` toont denk-tekst, antwoord, toolblokken en de meetregel per beurt; het Ops-dashboard op max2 toont hetzelfde van schijf. Leg de tijd van die tick en T1 (rij en weergave zichtbaar) vast. Gehaald als T1 − T0 ≤ 300 seconden; een handmatige ingest-start telt niet als bewijs. Is het meer, dan gaat de gemeten tijd naar JP, die over de grens beslist; het plan verandert de grens niet.
- [ ] Criterium 6: nieuwe idea- en codex-runs verschijnen zoals voorheen.

### Taak 11: taakjob, eerste echte fout en triage (criteria 2, 3 en 4)

- [ ] Criterium 2: een kleine echte taak via `dispatch_job` met `required_capability: 'local_llm'`. De run toont `worktree path=`, containerblokken voor prepare en gate met uitvoer, de `run_tests`-regels en de jobstappen; de push blijkt uit `step job_status done pushed_at=ja` (de MCP pusht bij `done`, het harness niet). Het geschoonde run-log wordt de tweede fixture in het Ops-dashboard (kleine vervolg-PR, JP merget).
- [ ] Criterium 3 met de eerste echte mislukte harness-job na de uitrol, zoals spec §8 stap 4 als tweede optie toestaat. Er wordt geen config gemanipuleerd en de productieworker hoeft niet stil (planrondes 1–3 lieten zien dat de altijd-rode proef dat wel vraagt, met een eigen reeks risico's rond claims en herstarts).
  1. De run staat op error met `error_summary` `<CODE>: …`, voor welke code ook.
  2. Na de ingest start JP `worker-insights-triage.service` op scrum4me-srv, zo nodig herhaald (hooguit vijf keer), tot de run een `WorkerInsight` heeft of een ronde niets meer verwerkt. Aantal starts en tijden vastleggen.
  3. Tot die fout er is, blijft criterium 3 open; de rest van M4 wacht daar niet op. De bewijs-PR noemt criterium 3 als open, en er blijft één open taak in de M4-sprint staan tot de eerste mislukte run een `WorkerInsight` heeft.
- [ ] Criterium 4 met `harness check-run-logs` over alle bestanden in `/srv/scrum4me/worker-logs/harness/`, plus de namencontrole, volgens de runbook.
- [ ] Bewijs per criterium (job-id, run-id, relevante regels) in `docs/runbooks/idea-chat-worker.md`, in een docs-PR.

## Buiten dit plan

Streaming en de splitsing prompt-verwerking/generatie, vergelijken tussen endpoints (stap 2), een eigen triage-indeling, bewaartermijn van harness-run-logs, CLI-runs in Worker Logs, backfill van oude traces, een gateway.

## Review record

### Planronde 1 — revisie 1 (`22b6be2`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 7 MINOR; GO) en `mac:codex` (0 BLOCKER, 3 MAJOR, 5 MINOR; NO-GO). Beide: geen taak om te schrappen.

Bevindingen, allemaal gecontroleerd tegen de bomen en overgenomen:
- **MAJOR codex:** de vijfminuteneis had geen meetmoment → T0, de eerste tick en T1 vastleggen; gehaald bij de eerste tick na T0; handmatige ingest telt niet (Taak 10).
- **MAJOR codex:** het rode recept werd pas na de triage teruggezet → vast herstelpad direct na de foutjob, vóór de triage (Taak 11).
- **MAJOR codex:** de geheimcontrole kon een waarde in argv zetten en keek niet naar korte waarden → nieuwe Taak 7 `harness check-run-logs`, draaiend met de service-omgeving via `systemd-run`; korte waarden worden ook gecontroleerd (Global Constraints, Taak 7, 8, 11).
- **MINOR beide:** `runLog` bleef in Taak 5 een ongebruikte parameter (lint `no-unused-vars` met alleen `^_` uitgezonderd, `eslint.config.js:8`) → de trace-wrap en `worktree()` verhuizen naar Taak 5.
- **MINOR beide:** de unit-tests kregen via `config.workerLog` geen run-log → testhulp zet `deps.runLogFor` (Taak 5, 6).
- **MINOR beide:** `harnessResult` was niet gedeclareerd → geschrapt (Taak 9).
- **MINOR claude:** de `wx`-poging moest synchroon wachten → `sleep`-naad (Taak 4).
- **MINOR claude:** test voor een uitzondering in de omzetting ontbrak → toegevoegd (Taak 4).
- **MINOR claude:** `errorSummary` zonder `ERROR`-regel is `result: failed` → verwachting aangepast (Taak 9).
- **MINOR claude:** bewijs voor criteria 2 en 5 paste niet bij wat het systeem toont → `errors` leeg en `skippedIdle` (Taak 8); push via `pushed_at=ja` (Taak 11); criterium 5 uit de titel van Taak 10.
- **MINOR claude:** herstarts zonder te checken of de worker stil is → Global Constraints en elke herstart.
- **MINOR codex:** `cwd` voor idee-chat had geen bron → `RunLogInit.cwd`, standaard de werkmap (Taak 4).
- **MINOR codex:** de fixture had geen bestemming vóór de Ops-werkplek bestond, en inkorten kon lengtes en vlaggen breken → vast pad buiten de repo's, alleen vervangen met dezelfde lengte (Taak 8, 9).
- **MINOR codex:** de vier redactiebronnen werden niet samen getest → één CLI-test met vier bronnen (Taak 5).

Afgewezen: geen. Scope: toegevoegd zijn Taak 7 (controle op geheimen), een herstelpad voor de rode config, meetmomenten voor criterium 1 en een stilte-check vóór herstarts; niets geschrapt. Het eerste bruikbare resultaat en de praktijkproef blijven gelijk. Bewuste afwijking van de spec-mechaniek, door claude bevestigd: `follow()` wikkelt de trace in plaats van `openTrace` een volger te geven; dezelfde stroom en volgorde.

### Planronde 2 — revisie 2 (`bc99673`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 3 MINOR; GO) en `mac:codex` (0 BLOCKER, 3 MAJOR, 4 MINOR; NO-GO). Beide: geen taak om te schrappen; Taak 7 is terecht.

Bevindingen, allemaal gecontroleerd tegen de bomen en overgenomen:
- **MAJOR codex:** na de foutjob kon de doorlopende worker nog een job onder het rode recept claimen (`worker.ts:234-237`) → de proef draait als eenmalige `worker --once` met een tijdelijke config in `/run`, terwijl de service stilstaat; de productieconfig blijft onaangeroerd, en de service start altijd weer (Taak 11).
- **MAJOR codex, MINOR claude:** de stilte-check via journal en containers ziet een lopende idee-chat niet → stopprocedure met een autoritatieve query op `CLAIMED`/`RUNNING`, na de uitrol ook het nieuwste run-log, en een tweede toets na het stoppen (Global Constraints, Taak 8, 11).
- **MAJOR codex:** "binnen 5 minuten plus de verwerkingstijd" rekte de spec op → gehaald bij T1 − T0 ≤ 300 s; anders beslist JP (Taak 10).
- **MINOR codex:** de omzettingsfouttest gooide al in de echte trace (de spread leest de getter) → getter die pas bij de tweede lezing gooit (Taak 4).
- **MINOR codex:** een lege geheim-achtige variabele zou op elke regel matchen → lege waarden doen niet mee, met test (Taak 3, 7).
- **MINOR codex:** `skippedIdle` is een totaal → alleen `errors` leeg als bewijs, plus de parsercode (Taak 8).
- **MINOR beide:** de vierbronnentest kon groen zijn zonder dat drie bronnen ooit werden gelogd → het modelantwoord draagt drie geheimen, `model.baseUrl` via de unit-tests (met zo'n URL faalt `fetch` al vóór een beurt) (Taak 3, 4, 5).
- **MINOR claude:** Taak 7 kon niet op `collectSecretValues` bouwen (geen namen, lengtefilter) en meldde 0 treffers zonder iets te controleren → `collectSecretEntries` en `workerSecretSources` in Taak 3, pariteitstest, `dir` in de CLI-opties, exitcode 1 bij nul gecontroleerde geheimen (Taak 3, 7).

Afgewezen: geen. Scope: de rode proef raakt de productieconfig niet meer en de stop is aan een toets gebonden; de rest zijn verduidelijkingen. Niets toegevoegd aan het eerste resultaat, niets geschrapt.

### Planronde 3 — revisie 3 (`076a754`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 2 MINOR; GO) en `mac:codex` (0 BLOCKER, 3 MAJOR, 1 MINOR; NO-GO).

Bevindingen, gecontroleerd tegen de bomen:
- **MAJOR codex:** een claim die tijdens het stoppen landt, is niet vanzelf `STOPPED`, want een afgebroken `wait_for_job` kan een claim achterlaten tot de lease-reset → een niet-nul tweede toets betekent: vastleggen, niets opnieuw dispatchen, wachten tot terminaal of weer `QUEUED`, opnieuw beginnen (Global Constraints). Overgenomen.
- **MAJOR codex, MINOR claude:** de eenmalige worker kan een wachtende idee-chat claimen in plaats van de proeftaak. **MAJOR codex:** de hoofdservice mag niet herstarten zolang de rode proeftaak open is. **MINOR codex:** "altijd herstellen" had geen uitvoerbaar mechanisme. **MINOR claude:** `--pipe` bindt een run van 40 minuten aan de sessie. → Alle vier opgelost door de altijd-rode proef te schrappen. Spec §8 stap 4 staat als tweede optie de eerstvolgende echte fout toe; criterium 3 wordt daarmee bewezen, zonder configwijziging en zonder de productieworker stil te leggen (Taak 11).

Afgewezen: geen. Scope, beoordeeld vóór ronde 4 omdat dezelfde procedure drie rondes terugkwam: geschrapt is de altijd-rode proef met stilgelegde service. Het bewijs voor criterium 3 hangt nu af van de eerste echte fout, en kan dus later komen dan de rest; de afgesproken acceptatie zelf verandert niet.

### Planronde 4 — revisie 4 (`bfac184`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 2 MINOR; GO) en `mac:codex` (0 BLOCKER, 1 MAJOR, 1 MINOR; NO-GO). Beide: het schrappen van de rode proef houdt stand; spec §8 stap 4 staat de eerstvolgende echte fout letterlijk toe.

Bevindingen, gecontroleerd tegen de bomen en overgenomen:
- **MAJOR codex:** een job die in het stopgat wordt geclaimd en snel als FAILED eindigt, staat bij de tweede telling niet meer op `CLAIMED`/`RUNNING` → de tweede toets wordt een audit over het stopmoment met `claimed_at >= T0` (kolommen `claimed_at`, `status`, `error` bestaan in `ClaudeJob`, scrum4me-mcp `prisma/schema.prisma`) (Global Constraints).
- **MINOR codex:** een telling levert geen job-id's → beide queries geven rijen (Global Constraints).
- **MINOR claude:** "begin de procedure opnieuw" terwijl de service al stilstaat → de service blijft gestopt en alleen de audit wordt herhaald (Global Constraints).
- **MINOR claude:** het open criterium 3 had geen plek → de bewijs-PR noemt het open en één taak in de sprint blijft staan (Taak 11).

Afgewezen: geen. Scope: onveranderd; alleen de stoptoets is aangescherpt.

### Planronde 5 — revisie 5 (`35238ff`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 1 MINOR; GO) en `mac:codex` (0 BLOCKER, 1 MAJOR, 1 MINOR; NO-GO). Beide: de audit met `claimed_at >= T0` vindt ook de snel afgesloten claim uit het stopgat; de rijen en de plek van het open criterium 3 houden stand.

Bevindingen, gecontroleerd tegen de bomen:
- **MAJOR codex:** de audit selecteerde `error`, en die kolom kan ongeredigeerde tekst bevatten: een modelfout neemt een uittreksel van de responsbody op (`src/model-client.ts:97`) en `closeFailed` stuurt die naar `update_job_status` (`src/worker/task-impl.ts:161`) → geen enkele query in de stopprocedure selecteert `error` (Global Constraints). Overgenomen.
- **MINOR codex:** de brede audit wordt nooit leeg, want een terminale rij houdt zijn `claimed_at`; een rij die via de lease-reset weer `QUEUED` wordt, verdwijnt er juist uit, want de reset wist `claimed_at` (scrum4me-mcp `390c391`, `src/tools/wait-for-job.ts:620-627`) → de ID's uit de eerste audit worden vastgelegd en per ID gevolgd tot terminaal of `QUEUED`, plus JP's besluit (Global Constraints). Overgenomen, behalve de slotaudit met een nieuwe T1.
- **MINOR claude:** `T0` uit `select now()` draagt de tijdzone van de sessie, terwijl `claimed_at` `timestamp(3)` zonder zone is en in UTC wordt gevuld; PostgreSQL negeert de zone in de letterlijke waarde → `select now() at time zone 'utc'` (Global Constraints). Overgenomen.

Afgewezen: de slotaudit met een nieuwe T1 (uit de MINOR van codex). `systemctl stop` keert pas terug als de control group leeg is (`KillMode=mixed`, `TimeoutStopSec=180`, `docs/runbooks/task-worker.md:64-65,84`), en `Restart=always` herstart niet na een `stop`. Tot stap 3 kan dus geen proces van deze worker meer claimen. De vastgelegde ID's geven al een eindconditie die af te lezen is. Scope: onveranderd; alleen de stopprocedure is aangepast.

### Planronde 6 — revisie 6 (`2098319`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 1 MINOR; GO) en `mac:codex` (0 BLOCKER, 1 MAJOR, 0 MINOR; NO-GO). Beide: geen `error` in de uitvoer en het volgen van vastgelegde ID's houden stand, en de afwijzing van de slotaudit met T1 houdt stand.

Bevindingen, gecontroleerd tegen de bomen en overgenomen:
- **MAJOR codex:** `claimed_at` krijgt `NOW()`, de starttijd van de claimtransactie (scrum4me-mcp `src/tools/wait-for-job.ts:764,846`). Een claim die bij de eerste toets nog niet gecommit was, kan een claimtijd van vóór T0 hebben en na de stop al terminaal zijn; dan valt hij buiten beide takken van de audit → de tijdsgrens vervalt. De stoptoets vergelijkt nu twee opnames van `id, kind, status, retry_count` van alle `local_llm`-jobs, vóór en na de stop; elke verschilregel gaat naar JP. T0 en de UTC-regel vervallen daarmee (Global Constraints).
- **MINOR claude:** de run-log-toets in stap 1 beschermt niets wat de query niet al beschermt, geldt niet bij het enige gebruik (Taak 8), en kan na een harde crash nooit slagen → geschrapt (Global Constraints, Taak 8).

Afgewezen: geen. Scope, opnieuw beoordeeld omdat de stopprocedure in vijf rondes terugkwam: de procedure blijft nodig voor de ene herstart in Taak 8, maar is kleiner geworden. Er is geen tijdsgrens, geen T0 en geen run-log-toets meer; wat overblijft zijn twee opnames, één diff en het volgen van ID's. Het eerste resultaat en de praktijkproef veranderen niet.

### Planronde 7 — revisie 7 (`7d97735`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 1 MINOR; GO) en `mac:codex` (0 BLOCKER, 0 MAJOR, 1 MINOR; GO). **Dubbel GO.** Beide: de stoptoets zonder tijdsgrens en het schrappen van de run-log-toets houden stand. Geen van beide vond een claimpad van deze worker dat de diff mist en werk verliest of onderbreekt; de enige niet-detectie is `rollbackClaim`, vóór de job de worker bereikt.

Bevindingen, gecontroleerd tegen de bomen en overgenomen in revisie 8:
- **MINOR claude:** blijft een vastgelegd ID op `CLAIMED` staan, dan komt de eindconditie nooit, want de lease-reset draait alleen binnen `wait_for_job` (scrum4me-mcp `wait-for-job.ts:586,2101,2153`; `job-heartbeat.ts` noemt hem alleen in commentaar) → JP beslist dan of stap 3 toch volgt; na de start zet de worker de claim zelf terug (Global Constraints).
- **MINOR codex:** een mislukt `psql`-commando kan via de redirect een leeg bestand achterlaten, en twee lege opnames vergelijken gelijk → een opname telt alleen bij exitcode 0 (eerst naar een tussenbestand), `systemctl stop` moet slagen en de unit is daarna `inactive` of `failed`, en alleen `diff`-exitcode 0 is schoon (Global Constraints).

Kanttekening claude, alleen over het reviewverzoek: de lijst aanroepers van `rollbackClaim` daarin was onvolledig. Het plan noemt geen lijst, en de conclusie dat ze allemaal binnen `wait_for_job` vallen, klopt.

Afgewezen: geen. Scope: onveranderd; twee verduidelijkingen in de stopprocedure. Revisie 8 is niet opnieuw gereviewd: beide MINORs zijn uitvoeringsdetails zonder nieuwe eis.

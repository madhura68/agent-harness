---
title: "Agent-harness M4 — harness-runs volgen in Worker Logs"
status: reviewed
last_updated: 2026-09-28
revision: 3
---

# Agent-harness M4 — harness-runs volgen in Worker Logs

Vervolg op [M3](2026-09-27-task-implementation-local-llm-design.md). Brainstorm met JP op 2026-09-28; beide ontwerpdelen (opbouw en techniek) goedgekeurd.

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "meer inzicht hebben in wat er precies gebeurt" bij harness-jobs, zoals Worker Logs en Worker Insights dat nu voor Claude- en Codex-jobs doen. Later wil JP het harness testen met andere interfaces: andere servers en andere hardware, onder meer als input voor de keuze tussen een Mac Studio M5 Max 36 GB en een M5 Ultra 96 GB. Deze stap kiest de meetpunten daarom zo dat vergelijken later zonder ombouw kan.

**Eerst bruikbare resultaat:** een echte harness-job op max2 staat binnen 5 minuten in `/worker-logs` van scrum4me-workers, en (van schijf) in het Ops-dashboard op max2. Per beurt zie je de denk-tekst, het antwoord, de toolcalls met uitvoer en een meetregel (duur, tokens in/uit/cache). Bij een taakjob zie je ook de containerstappen met uitvoer en de jobstappen. Een mislukte run krijgt via de bestaande triage een oordeel in `/worker-insights`.

**Niet-doelen:**
- streaming, time-to-first-token en de splitsing tussen prompt-verwerking en generatie (stap 2, vergelijken);
- een vergelijkings- of benchmarkmodus over modellen of endpoints;
- een eigen triage-indeling voor harness-fouten;
- wijzigingen in scrum4me-workers, in het schema van de ops_dashboard-database of in de UI van beide apps;
- opruimen of een bewaartermijn voor harness-run-logs;
- CLI-runs (`probe`, `answer`, `tools`) in Worker Logs, want de ingest slaat runs zonder job over;
- de bestaande traces met terugwerkende kracht inlezen;
- een gateway (LiteLLM of anders) tussen harness en Ollama.

**Zichtbaar bewijs:** de runs in scrum4me-workers `/worker-logs` (pool `harness`, host `max2`) met hun detailweergave, het run-log-bestand op max2, en een triage-oordeel voor een mislukte run.

## 2. Besluiten

| # | Vraag | Besluit |
|---|---|---|
| 1 | Wat levert de eerste stap op | Runs volgen; vergelijken is stap 2 (JP) |
| 2 | Aanpak | Een derde logformaat in de bestaande worker-log-pipeline; geen eigen tabel of pagina (JP, aanpak 1 van 3) |
| 3 | Triage | Aan: harness-runs doen mee met de bestaande triage, dus Claude Haiku 4.5 via de Anthropic-API, met de bestaande redactie (JP) |
| 4 | Bron en afgeleide | `trace.jsonl` blijft de volledige bron op max2; het run-log is een afgeleide weergave, geredigeerd en begrensd |
| 5 | Pool en instance | Pool `harness` (een pool staat voor de runtime, zoals `idea` voor Claude en `codex`); instance uniek per host en per worker, op max2 `max2`. Review ronde 1: `run_id` is globaal uniek en bevat de host niet |
| 6 | Review | Review-loop met `mac:codex` en `mac:claude` tot beide GO geven (JP) |

## 3. Uitgangssituatie

Gelezen op Ops-dashboard `origin/main` 513dfa1b4, scrum4me-docker `origin/master` 52ded13, scrum4me-workers `origin/main` e819a35 en agent-harness `main` 652617f.

**Worker-log-pipeline (Claude en Codex).**
- De runner schrijft per run één bestand `/srv/scrum4me/worker-logs/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log` (scrum4me-docker `bin/run-agent.sh:101`). Daarin staan meta-regels `<ISO-tijd> [run-one-job] <tekst>` (`bin/run-one-job.ts:79`) en daartussen de JSON-regels van de agent, geredigeerd door `lib/log-redact.ts`.
- Een systemd-timer per host (`worker-logs-ingest.timer`, elke 5 min; actief op max2) roept het lokale Ops-dashboard aan. Dat parset elk bestand dat nog niet als afgesloten is ingelezen (`lib/parse-worker-log.ts`) en schrijft `WorkerRun` plus `WorkerEvent` in de ops_dashboard-database. De events worden bij elke ronde volledig vervangen (`lib/ingest-worker-log.ts:256-270`). Runs zonder `job_id` of met status idle slaat de ingest over (`:248-249`).
- Pools worden vanzelf ontdekt: elke submap met een geldige naam (`lib/worker-logs.ts:126`, `NAME_SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/` op `:46`). De bestandsnaam moet voldoen aan `NAME_RE = /^\d{8}T\d{6}Z\.log(\.gz)?$/` (`:41`).
- De parser kent Claude `stream-json` en `codex exec --json`. Codex wordt op dezelfde eventsoorten afgebeeld (`pushCodexEvent`, `parse-worker-log.ts:305-401`), zodat ingest en UI geen Codex-specifieke takken nodig hebben.
- scrum4me-workers leest `/worker-logs` en `/worker-insights` uit de database. Het Ops-dashboard toont het detail door het bestand opnieuw te parsen.
- Triage selecteert runs met status error of token_expired, of met een tool-result met `is_error` (`lib/worker-insights/triage.ts:99-106`), zonder filter op pool. De beoordeling doet `claude-haiku-4-5-20251001` (`:22`), na redactie: denk-tekst en raw vallen weg (`lib/worker-insights/redaction.ts:7,20`), geheimpatronen en paden worden geschoond. De timer (elke 30 min) draait alleen op scrum4me-srv; een ronde neemt hooguit tien kandidaten (`:26`, `:148`) binnen een kostenplafond (`:27`), en na een API-fout volgt een nieuwe poging pas na 30 minuten (`:25`).

**Harness nu.**
- Per run staan `trace.jsonl`, `tools/<callId>.txt` en `result.json` in `/var/lib/agent-harness/runs/<runId>/` (`src/trace.ts`). Niets leest dat in.
- `model_response` bevat content, toolcalls, finish-reden en tokens. De client leest geen denk-tekst, geen cachetokens en geen server-identiteit, en meet geen duur per verzoek (`src/model-client.ts:69-126`, `stream: false`).
- Het `container`-event heeft exitcode, time-out en duur, maar niet de uitvoer (`src/worker/task-impl.ts:239`). De uitvoer bestaat wel, als staart van hooguit 64 KiB (`src/worker/containers.ts:23`).
- Jobstappen (claim, worktree, commit, push, afsluiten) gaan alleen naar stderr, dus journald (`src/worker/worker.ts:108,186`).
- De worker leidt een claim via `runOneJob` (`src/worker/worker.ts:101`) naar `runIdeaChatJob` (`:106`) of `runTaskJob` (`src/worker/task-impl.ts:155`). De uitkomst is `JobOutcome = 'done' | 'failed' | 'abandoned'` (`worker.ts:31`).

**Proef op max2 (2026-09-28).** Eén verzoek aan `http://127.0.0.1:11434/v1/chat/completions` met model `qwen3.8-gsq-rco:27b-iq3_s-text` gaf `message.reasoning` (de denk-tekst), `usage.prompt_tokens_details.cached_tokens` en `system_fingerprint` terug. Op max2 draait geen LiteLLM: het harness praat rechtstreeks met de OpenAI-compatibele `/v1` van Ollama.

## 4. Architectuur en stroom

```
agent-harness-worker (max2, systemd, gebruiker janpeter)
  ├─ claim → run-log /srv/scrum4me/worker-logs/harness/max2/runs/<tijd>.log
  ├─ jobstappen  → meta-regels "<tijd> [harness] …"
  ├─ modelloop   → trace.jsonl (volledig) ──┬─→ JSON-regels "harness.*" (geredigeerd, begrensd)
  ├─ containers  → trace + containers/<n>.txt ┘
  └─ afloop      → afsluitblok in één schrijfactie: run_end, ERROR, done, exit
worker-logs-ingest.timer (max2, elke 5 min) → Ops-dashboard max2 (parser met harness-tak)
  → ops_dashboard: WorkerRun (pool harness, host max2) + WorkerEvent
      ├─ scrum4me-workers /worker-logs (database) en Ops-dashboard max2 /worker-logs (schijf)
      └─ triage (elke 30 min) → WorkerInsight → /worker-insights
```

## 5. Run-log-contract

Dit contract is de afspraak tussen het harness (schrijver) en het Ops-dashboard (lezer). Beide kanten testen ertegen.

### 5.1 Bestand

- Pad: `<dir>/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log`. Op max2 is `dir` `/srv/scrum4me/worker-logs`, `pool` `harness` en `instance` `max2`. `pool` en `instance` moeten voldoen aan `NAME_SEGMENT_RE`; de config controleert dat. De instance is uniek per host en per worker: de `run_id` wordt `harness/<instance>/<tijd>` en is globaal uniek over alle hosts (`ingest-worker-log.ts:43-47`, `prisma/schema.prisma` `WorkerRun.run_id @unique`).
- De naam is het UTC-tijdstip direct na de claim, op de seconde. De schrijver maakt het bestand exclusief aan (`wx`). Bestaat het al, dan wacht hij tot de volgende seconde en probeert het één keer opnieuw; lukt dat niet, dan draait de job zonder run-log. Rechten 0644; ontbrekende mappen maakt hij aan.
- Eén bestand per geclaimde job. Wachten zonder job schrijft niets.

### 5.2 Regels

- UTF-8, één record per regel, afgesloten met `\n`.
- **Meta-regel:** `<new Date().toISOString()> [harness] <tekst>`. Een regeleinde in `<tekst>` wordt een spatie.
- **JSON-regel:** `JSON.stringify(obj)` op één regel, met `type` als eerste sleutel (`harness.<naam>`) en `timestamp` (ISO) als tweede. Elke JSON-regel begint dus met `{"type":"harness.`.

### 5.3 Meta-regels

| Moment | Tekst (exact) | MetaTag in de parser | Effect op `WorkerRun` |
|---|---|---|---|
| Na de claim | `claimed job_id=<jobId>`, zonder iets erachter: de parser neemt de hele rest als id (`parse-worker-log.ts:182-183`) | claimed | `job_id` |
| Na de claim | `config job_id=<jobId> runtime=HARNESS kind=<IDEA_CHAT\|TASK_IMPLEMENTATION> model=<naam> base_url=<url>` | config | `model` via `\bmodel=(\S+)` (`:185`) |
| Taakjob, worktree bekend | `worktree path=<pad>` | worktree | — |
| Jobstap | `step <tekst>`, bijvoorbeeld `step prepare exit=0 duration_ms=…`, `step commit sha=<sha>`, `step push branch=<naam>`, `step job_status done` | other | — |
| Mislukte of afgebroken job, in het afsluitblok (§5.6) | `ERROR <CODE>: <bericht>`, één per job; codes in §5.6 | error | status error, `error_summary` (eerste 300 tekens) |
| Einde, in het afsluitblok | `harness done job_id=<jobId> exit_code=<0\|1> duration_ms=<ms>` | claude-done, na de parserwijziging uit §7 | `exit_code`, `duration_ms` (van claim tot einde) |
| Einde, laatste regel van het afsluitblok | `exit code=<0\|1>` | exit | afgesloten (`in_progress = false`); voor een harness-log de enige afsluitmarkering (§7) |

Het voorvoegsel `step` voorkomt dat vrije tekst per ongeluk begint met een ander herkend voorvoegsel, zoals `cleanup`, `config ` of `ERROR`.

### 5.4 JSON-regels

| `type` | Velden naast `type` en `timestamp` | Afbeelding in de parser |
|---|---|---|
| `harness.run_start` | `runId`, `model`, `baseUrl`, `tools` (namen), `mcpServers`, `cwd`, `version` | `system-init`: model, tools, mcpServers, sessionId = runId, cwd, version; permissionMode `—` |
| `harness.turn` | `turn`, `durationMs`, `finishReason`, `usageSource` (`provider_reported` of `missing`), `usage {input, output, cached?}`, `promptEstimate?`, `reasoning?` + `reasoningTruncated?`, `content?` + `contentTruncated?`, `systemFingerprint?` | `thinking` (reasoning), `assistant-text` (content, alleen als niet leeg) en een `raw`-regel `turn <n> · <s> s · in <x> · cached <y> · out <z> · <finish>`. `in` en `out` staan er alleen bij `usageSource` `provider_reported` (anders zou een ontbrekende meting als 0 lezen, `model-client.ts:36-42`); `cached` alleen als de server die waarde meldde |
| `harness.tool_call` | `callId`, `name`, `arguments` (string) + `argumentsTruncated?` | `tool-call`, id = callId. Argumenten die als JSON-object parsen worden opgemaakt; al het andere (ongeldige JSON, `null`, een getal, een string of een array) wordt `{"arguments": "<ruwe string>"}`, want de ingest zet de invoer als JSON-waarde in `payload` (`ingest-worker-log.ts:84-91,141-151`) en `null` weigert die kolom |
| `harness.tool_result` | `callId`, `ok`, `errorCode?`, `content` + `contentLength` | `tool-result`: isError = !ok; body met `[<errorCode>] ` ervoor als die er is; fullLength = contentLength, de lengte van de volledige tooluitvoer (`fullContent` als die er is, anders `content`) |
| `harness.container` | `n`, `kind`, `source`, `exitCode`, `timedOut`, `durationMs`, `outputTail`, `outputLength` | Bij `prepare` en `gate`: `tool-call` (name `container:<kind>/<source>`, id `container-<n>`) plus `tool-result` (body = outputTail, isError = exitCode ≠ 0 of timedOut; `outputLength` is de lengte van de bewaarde staart). Bij `run_tests` alleen een `raw`-regel, want die uitvoer staat al in het tool-result van de modelaanroep |
| `harness.compacted` | `turn`, `messages`, `bytes`, `estimateBefore`, `estimateAfter` | `raw` |
| `harness.gate` | `turn`, `outcome` (`accept`, `retry` of `fail`) | `raw` |
| `harness.loop_end` | `status`, `error? {code, message}`, `turns`, `toolCalls`, `toolErrors`, `usageSource`, `inputTokens`, `outputTokens`, `cachedTokens?`, `durationMs` (van de modelloop) | `raw`: `model loop <status>[ <code>] · <turns> turns · <toolCalls> tool calls · in <x> · out <z> · <s> s` (`in`/`out` alleen bij `provider_reported`) |
| `harness.run_end` | `outcome` (`done`, `failed` of `abandoned`), `code?`, `message?`, `answer?` + `answerTruncated?`, `turns?`, `durationMs` (van claim tot einde) | `result`: subtype = outcome, isError = outcome ≠ `done`, numTurns = turns, durationMs, totalCostUsd `null`; resultText is `<code>: <message>` bij een fout, anders `answer`. Staat alleen in het afsluitblok (§5.6) en sluit de run niet af |
| Onbekend `harness.*` | — | `raw`, JSON afgekapt op 2048 tekens |

- De schrijver schrijft `harness.run_start` zodra de toolsnapshot bekend is. Komt er vóór het volgende event geen snapshot, dan schrijft hij hem met een lege `tools`.
- `version` is `agent-harness@<versie uit package.json>`. Die komt terecht in `WorkerRun.claude_code_version`: de kolom heet zo, de inhoud is de runtimeversie.
- Het trace-event `run_end` gaat niet naar het run-log: dat schrijft `runManifest` al als de modelloop eindigt (`run.ts:351`), terwijl een taakjob daarna nog scant, commit, het plan controleert en de jobstatus zet (`task-impl.ts:364-423`). `harness.loop_end` komt uit `trace.result()` (`run.ts:365`), want de tellers staan in `RunResult` en niet in het `run_end`-event (`trace.ts:16`). `harness.run_end` beschrijft de jobuitkomst en komt pas in het afsluitblok.
- In scrum4me-workers toont de resultaatkaart alleen subtype, fout-vlag en tekst: de ingest bewaart duur en beurten niet op de eventrij (`ingest-worker-log.ts:171-181`). Duur en beurten staan in de run-rij (`duration_ms`, `num_turns`).

### 5.5 Grenzen

De schrijver kapt af op de grenzen die de weergave toont (`parse-worker-log.ts:106-108`), altijd ná de redactie, en zet dan de bijbehorende `…Truncated`-vlag of de volledige lengte:
- `reasoning`, `content` en `answer`: 16 384 tekens;
- `arguments`: 4 096 tekens;
- tool-`content` en container-`outputTail`: 8 192 tekens, waarbij `outputTail` het laatste deel is.

De parser zet `truncated` als hij zelf afkapt of als de regel de vlag draagt. Met `maxTurns` 40 blijft een run-log binnen enkele MB. De parser heeft daarnaast een eigen plafond van 1,5 miljoen tekens per weergave (`:109`, `:528-542`).

### 5.6 Afsluitblok en foutcodes

- Het run-log eindigt met één afsluitblok, geschreven in één schrijfactie: `harness.run_end`, bij een fout `ERROR <CODE>: <bericht>`, dan `harness done job_id=<jobId> exit_code=<0|1> duration_ms=<ms>` en als laatste `exit code=<0|1>`.
- `runOneJob` schrijft het blok precies één keer, in een `finally` rond de job, ook als een eerdere schrijfactie mislukte (§6.3).
- De parser beschouwt een harness-log pas als afgesloten bij `exit code=` (§7). Een ingest-ronde die midden in de job of midden in het blok leest, ziet dus `running`, en de volgende ronde leest het bestand opnieuw.

| Afloop | `outcome` in `harness.run_end` | ERROR-regel | `exit_code` |
|---|---|---|---|
| `done` | `done` | — | 0 |
| `failed` | `failed` | `ERROR <CODE>: <bericht>` | 1 |
| `abandoned` | `abandoned` | `ERROR <CODE>: <bericht>` | 1 |
| Onverwachte fout in de job | `failed` | `ERROR HARNESS_ERROR: <bericht>` | 1 |
| Harde crash (SIGKILL, OOM) of een tweede SIGINT/SIGTERM (`src/cli.ts:143`: `process.exit(130)` slaat elke `finally` over) | — | — | geen blok: de run blijft `running` in de tabel. Er is geen apart overzicht voor; het bestaande "vastgelopen runs" telt herhaalde toolfouten binnen één run |

**Foutcodes.** De handler geeft code en bericht door met `RunLog.fail(code, bericht)`, op de plek waar hij de reden al kent: `failPath`, `closeFailed`, `abandon`, `uncertainPath` en de claim-filtercontrole.
- `failPath` en `closeFailed` krijgen de code als parameter, en `failPath` geeft hem door aan `closeFailed` (`task-impl.ts:289`). Een latere `fail()` vervangt een eerdere alleen als hij uit `abandon` of `uncertainPath` komt; zo blijft bijvoorbeeld `VERIFY_FAILED` staan.
- De plekken die nu een uitkomst teruggeven zonder een van die functies, roepen `fail()` zelf aan: `running` geweigerd (`task-impl.ts:199-201`, `worker.ts:132-135`, code `ABANDONED`), eigendom kwijt in idee-chat (`worker.ts:174-177`, `ABANDONED`), uitkomst van `done` onbekend (`task-impl.ts:410-415`, `DONE_UNKNOWN`) en `done` die na een pushfout als FAILED eindigde (`task-impl.ts:426-427`, `DONE_ENDED_FAILED`).
- Is de uitkomst niet `done` en is er geen `fail()` geweest, dan schrijft `end()` `JOB_FAILED` of `ABANDONED` met een vaste tekst.

Codes:
- de `ErrorCode` van de modelloop als die faalde (bijvoorbeeld `VERIFY_FAILED`, `CONTEXT_EXHAUSTED`, `MODEL_ERROR`, `TOO_MANY_TOOL_ERRORS`), of `BUDGET_EXCEEDED` en `TIMED_OUT` bij die statussen;
- vóór de modelloop: `PAYLOAD_INVALID`, `NO_TASK_CONFIG`, `CONTAINERS_LEFTOVER`, `GIT_SCAN_FAILED`, `NO_RECIPE`, `PREPARE_FAILED`;
- na de modelloop: `GIT_ADMIN_CHANGED`, `COMMIT_FAILED`, `NO_CHANGES`, `PLAN_CHECK_FAILED`, `DONE_REFUSED`;
- verder: `STOPPED` (service gestopt tijdens de job), `ABANDONED` (eigendom kwijt), `DONE_UNKNOWN` (uitkomst van `done` onbekend), `DONE_ENDED_FAILED`, `CONTAINER_UNCERTAIN`, `CLAIM_FILTER` en `HARNESS_ERROR`;
- `JOB_FAILED` als restcategorie.

Het plan koppelt elke aanroepplek in `task-impl.ts` en `worker.ts` aan een code.

### 5.7 Redactie

- De schrijver maskeert elke string in meta- en JSON-regels, vóór het afkappen, met dezelfde regels als de runner (scrum4me-docker `lib/log-redact.ts:12-58`). Gemaskeerd worden:
  - de volledige waarde van elke omgevingsvariabele waarvan de naam matcht op `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$|DSN|CREDENTIAL)/i`;
  - het wachtwoord uit elke URL-waarde, ook in URL-gedecodeerde vorm.

  Alleen waarden vanaf 8 tekens tellen mee; de langste wordt eerst vervangen, door `***`.
- De waarden komen uit `process.env` van de worker, de opgeloste MCP-omgeving (`workerMcpEnv`), `model.apiKey` als die gezet is, en het wachtwoord uit `model.baseUrl`: dat is een zelfstandig configveld (`src/manifest.ts:6-10`) dat in de `config`-regel en in `harness.run_start` terechtkomt, ook als het in geen enkele omgeving staat.
- De functies worden overgenomen, niet gedeeld. De tests leggen dezelfde gevallen vast als die van de runner.
- De trace zelf verandert hierin niet: die blijft lokaal op max2, zoals nu.

## 6. Wijzigingen in agent-harness

### 6.1 Model-client (`src/model-client.ts`, `src/types.ts`)

- `CompleteResult` krijgt drie velden:
  - `reasoning?: string`, uit `message.reasoning` en anders `message.reasoning_content`;
  - `durationMs: number`, gemeten van vóór `fetch` tot na het lezen van de body;
  - `systemFingerprint?: string`, uit `system_fingerprint`.
- `Usage` krijgt `cachedTokens?: number`, uit `usage.prompt_tokens_details.cached_tokens` als dat een getal is.
- De denk-tekst gaat niet terug naar het model; `toWire` blijft ongewijzigd.

### 6.2 Trace (`src/trace.ts`, `src/run.ts`, `src/worker/task-impl.ts`)

- `model_response` krijgt `reasoning?`, `durationMs` en `systemFingerprint?`; de `usage` erin krijgt `cachedTokens?`.
- `container` krijgt `n` en `outputBytes`. De uitvoer zelf (de staart van hooguit 64 KiB) komt in `<runDir>/containers/<n>.txt`.
- `RunResult.usage` krijgt `cachedTokens?`: de som, alleen als minstens één antwoord de waarde meldde.
- `trace.result()` geeft het `RunResult` ook aan de volger, voor `harness.loop_end`.
- Bestaande velden blijven ongewijzigd, dus oude traces blijven leesbaar.

### 6.3 Run-log-schrijver (`src/worker/run-log.ts`, nieuw)

- `openRunLog(cfg, jobId, now)` geeft een `RunLog` terug met `meta(text)`, `event(traceEvent, extra?)`, `result(runResult)`, `fail(code, bericht)` en `end(outcome, durationMs)`. Het resultaat is `null` als `workerLog` ontbreekt of het aanmaken mislukt.
- De trace-schrijver krijgt een optionele volger. Elk trace-event en het `RunResult` gaan ook naar het run-log, dat ze omzet volgens §5.4. Tool-content en container-uitvoer geeft de trace mee op het moment dat hij ze zelf wegschrijft.
- Best-effort: elke uitzondering in de volger en in de `RunLog`-methodes wordt opgevangen, niet alleen I/O-fouten; er gaat nooit een fout terug de modelloop of de job in. Na de eerste fout gaat er één regel naar stderr en stoppen de tussentijdse regels voor die job. `end()` probeert het afsluitblok daarna nog één keer te schrijven. Een fout in het run-log verandert nooit de uitkomst van de job.

### 6.4 Integratie

- `runOneJob` (`worker.ts:101`) opent het run-log direct na de claim, schrijft `claimed` en `config`, en geeft het door aan `runIdeaChatJob` en `runTaskJob`.
- Die handlers geven het run-log mee aan hun trace, schrijven hun jobstappen als `step …` (naast de bestaande regel in journald) en roepen `fail()` aan op hun foutplekken (§5.6).
- `runOneJob` sluit af volgens §5.6. Bij `ClaimFilterError` en `ContainerUncertainError` staat de code al via `fail()`; het `finally` schrijft het blok, daarna gaat de fout verder zoals nu.
- Elke andere uitzondering uit de handler vangt `runOneJob` op: `fail('HARNESS_ERROR', bericht)`, uitkomst `failed`, het `finally` schrijft het blok, en daarna gaat de oorspronkelijke fout verder naar de bestaande afhandeling in de worker-lus (`worker.ts:219-232`).

### 6.5 Config (`src/worker/config.ts`)

- Optioneel blok `workerLog: { dir: string, pool: string, instance: string }`. `pool` en `instance` worden gecontroleerd tegen `^[A-Za-z0-9._-]{1,64}$`. Zonder dit blok werkt de worker zoals nu.
- `examples/worker.json` krijgt het blok voor max2, met `instance` `max2`.

## 7. Wijzigingen in het Ops-dashboard (`lib/parse-worker-log.ts`)

- `META_RE` (`:111`) wordt `/^(\S+)\s+\[(run-one-job|harness)\]\s+(.*)$/`. De tag wordt een eigen groep: de tijd blijft groep 1, de tekst schuift van groep 2 naar groep 3, op alle plekken die `META_RE` gebruiken (`:179-181`, `:551-553`). Ziet de parser een meta-regel met tag `harness`, dan is het bestand een harness-log.
- De done-regel `/^(claude|codex) done\b/` wordt `/^(claude|codex|harness) done\b/`, zowel in `classifyMeta` (`:142`) als in `summarizeRunLog` (`:187`).
- `summarizeRunLog`, alleen voor harness-logs:
  - afgesloten is het log alleen bij `exit code=` (`runExit`). Een `ERROR`-regel of `harness.run_end` sluit het niet af; de huidige regel (`:224`) blijft gelden voor Claude- en Codex-logs;
  - `{"type":"harness.run_end"` vult `resultIsError` (outcome ≠ `done`), `resultSubtype` (outcome), `numTurns` (turns) en, als de done-regel die nog niet gaf, `durationMs`.
- `pushJsonEvent` (`:403`) roept vóór `pushCodexEvent` een nieuwe `pushHarnessEvent` aan. Die handelt alle `harness.*`-regels af volgens §5.4 en geeft `true` terug.
- Het commentaar over pools (`:21`) wordt bijgewerkt.
- Ingest, schema, triage en UI veranderen niet. `harness done` valt onder de bestaande MetaTag `claude-done`.

## 8. Inrichting max2 en uitrol (elke stap op JP's go)

1. **Harness.** PR in agent-harness en merge.
   - Werk max2 bij volgens het runbook: pull, `npm ci`, `npm run build`, herstart `agent-harness-worker`.
   - Zet het blok `workerLog` in `/etc/agent-harness/worker.json`, na een backup.
   - Draai één idee-chat-job. Het bestand verschijnt. De huidige parser herkent de `[harness]`-regels niet en ziet dus geen `job_id`. De status wordt `idle` (`parse-worker-log.ts:243-246`) en de ingest slaat het bestand over met reden `idle` (`ingest-worker-log.ts:248-249`): geen fout, geen rij.
2. **Ops-dashboard.** Het run-log uit stap 1 wordt, geschoond, de fixture voor de parser-PR; daarna merge.
   - Rol uit op max2 met de flow `redeploy_ops_dashboard`.
   - Bij de volgende ingest-ronde verschijnt de run uit stap 1, omdat hij nog niet als afgesloten was ingelezen.
3. **Taakjob.** Een echte kleine taak via `dispatch_job` met `required_capability: 'local_llm'`.
4. **Mislukte job en triage.** Met het altijd-rode recept uit M3-criterium 2 (een tijdelijke configwijziging), of de eerstvolgende echte fout. Na de ingest start JP de triage-service `worker-insights-triage.service` op scrum4me-srv (de timer draait alleen daar) en leest het `WorkerInsight` van de run terug. Een ronde neemt hooguit tien kandidaten, zonder vaste volgorde (`triage.ts:101-108,148`); heeft de run nog geen oordeel, dan wordt de start herhaald, hooguit vijf keer, tot de run een `WorkerInsight` heeft of een ronde niets meer verwerkt. Het aantal starts en de tijden worden vastgelegd; ontbrekende configuratie wordt gemeld in plaats van omzeild. Een triage binnen een vaste tijd is geen eis van deze stap (§11).

## 9. Tests (zonder netwerk)

**agent-harness** (`npm run verify`):
- **Model-client.**
  - De fixture is de geschoonde echte Ollama-respons van 2026-09-28, met `reasoning`, `cached_tokens` en `system_fingerprint`.
  - Een variant met `reasoning_content`.
  - Een variant zonder deze velden: alles `undefined`, geen fout.
  - `durationMs` gemeten met een ingespoten klok: de test verwacht de exacte waarde.
- **Run-log.**
  - Exacte meta-regels, vooral `claimed job_id=<id>` zonder aanhangsel.
  - Elke JSON-regel begint met `{"type":"harness.` en heeft een `timestamp`.
  - De afbeelding van elk trace-event, en het afkappen met vlaggen.
  - Redactie:
    - via de sleutelnaam;
    - via het URL-wachtwoord, ook in gedecodeerde vorm;
    - de langste waarde eerst;
    - vóór het afkappen;
    - ook in reasoning en tool-content.
  - Een `wx`-botsing met een nieuwe poging.
  - Een schrijffout schakelt het log uit zonder de job te raken.
  - Het afsluitblok per afloop uit §5.6: precies één keer, in één schrijfactie, ook na een eerdere schrijffout.
  - Een geslaagde modelloop gevolgd door een fout na de loop (commit, plancontrole, `done` geweigerd) geeft `outcome` `failed` met de juiste code.
  - Een uitzondering in de omzetting bereikt de modelloop en de job niet.
  - Een wachtwoord in `model.baseUrl` dat in geen omgeving staat, wordt gemaskeerd.
  - De voorrang van `fail()`: `VERIFY_FAILED` uit `failPath` blijft staan na `closeFailed`; een latere `abandon` vervangt hem wel.
  - Een geïnjecteerde onverwachte uitzondering in de handler geeft precies één blok met `HARNESS_ERROR` en laat het foutgedrag van de worker-lus ongewijzigd.
- **Trace.** De nieuwe velden in `model_response`, en `containers/<n>.txt`.

**Ops-dashboard** (`npm test`):
- De fixture is het geschoonde echte run-log van max2 (stap 1 van §8). Getest wordt:
  - de samenvatting: job_id, status, model, num_turns, duration en exit_code;
  - de eventsoorten en hun volgorde.

  Deze fixture bewijst dat schrijver en lezer het eens zijn over de werkelijke uitvoer. De foutpaden zijn kleine gevallen, afgeleid uit §5.6.
- `META_RE` voor beide tags, en de done-regel met `harness`.
- `running` zonder afsluitregels, en ook `running` bij `harness.run_end` en een `ERROR`-regel zonder `exit code=` (een groeiend bestand).
- `error` met een `ERROR`-regel gevolgd door `exit code=1`, en `error` met een `harness.run_end` waarvan `outcome` ≠ `done`, gevolgd door `exit code=1`.
- Een onbekend `harness.*`-type wordt raw.
- Argumenten `null`, een getal, een JSON-string, een array of ongeldige JSON worden `{"arguments": …}`; alleen een JSON-object wordt opgemaakt.
- Het geschoonde run-log van de eerste echte taakjob (stap 3 van §8) wordt een tweede fixture zodra het bestaat; dat blokkeert stap 1 en 2 niet.
- De bestaande Claude- en Codex-tests blijven groen.

## 10. Acceptatiecriteria

1. Na een idee-chat-job op max2 staat, binnen 5 minuten na de uitrol van het Ops-dashboard, een `WorkerRun` met pool `harness`, host `max2` en status success, met `job_id`, `model`, `num_turns` en `duration_ms`. Het detail in scrum4me-workers toont denk-tekst, antwoord, toolblokken en de meetregel per beurt.
2. Een taakjob toont daarnaast `worktree path=`, containerblokken voor prepare en gate met uitvoer, de `run_tests`-regels en de jobstappen: commit, push en jobstatus.
3. Een mislukte job staat op status error met `error_summary` `<CODE>: …`. Na de ingest start JP de triage-service op scrum4me-srv, zo nodig herhaald zoals in §8 stap 4; daarna heeft de run een `WorkerInsight`.
4. Geen geheim komt voor in de run-logs. Per variabele in `worker.env` en de MCP-omgeving, over `/srv/scrum4me/worker-logs/harness`:
   - matcht de naam op het redactiepatroon, dan geeft `grep -F` op de hele waarde 0 treffers;
   - is de waarde een URL met wachtwoord (zoals `DATABASE_URL` en `DIRECT_URL`, `docs/runbooks/idea-chat-worker.md:29`), dan geeft `grep -F` op dat wachtwoord, ruw en gedecodeerd, 0 treffers.

   Daarnaast een eenmalige controle op alleen de namen: elke variabele die een geheim bevat, valt onder een van beide regels. De controle draait op max2 en toont geen waarden.
5. Tussen stap 1 en stap 2 van §8 geeft de ingest geen fouten op het harness-bestand.
6. Bestaande Claude- en Codex-runs worden ongewijzigd geparst: de tests zijn groen, en na de uitrol verschijnen nieuwe idea- en codex-runs zoals voorheen.

## 11. Risico's en open punten

- De triage-indeling is gemaakt voor Claude-jobs en kan harness-fouten grof indelen; `VERIFY_FAILED` wordt waarschijnlijk VALIDATION of OTHER. Herijken hoort bij stap 2.
- Triage stuurt fragmenten van harness-runs naar de Anthropic-API: tooluitvoer en antwoorden, geen denk-tekst. JP heeft dat geaccepteerd.
- Er zijn nu twee kopieën van de redactieregels, in de runner en in het harness, en die kunnen uit elkaar lopen. De tests pinnen dezelfde gevallen; later kan dit eventueel naar scrum4me-shared.
- `WorkerRun.claude_code_version` bevat de harnessversie en `total_cost_usd` blijft leeg. Kosteninzichten tonen harness-runs dus zonder kosten.
- Na een harde crash of een tweede stopsignaal blijft een run op `running` staan, en de ingest leest zo'n bestand elke 5 minuten opnieuw. Er is geen overzicht dat zulke runs apart toont.
- Triage is niet tijdgebonden: de timer draait elke 30 minuten op scrum4me-srv, neemt hooguit tien kandidaten per ronde, heeft een kostenplafond en probeert na een API-fout pas na 30 minuten opnieuw.
- Harness-run-logs blijven bewaard: de host-prune laat bestanden met `claimed job_id=` staan (Ops-dashboard `deploy/worker-logs-prune/`). Het gaat om enkele MB per maand.
- De trace bevat voortaan ook de volledige denk-tekst, ongeredigeerd en lokaal op max2, net als de tooluitvoer nu al.
- Andere servers dan Ollama leveren misschien geen `reasoning`, `cached_tokens` of `system_fingerprint`. De velden zijn optioneel en ontbreken dan gewoon.

## Review record

### Ronde 1 — revisie 1 (`3bbd226`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 1 MAJOR, 9 MINOR; NO-GO) en `mac:codex` (0 BLOCKER, 4 MAJOR, 1 MINOR; NO-GO). Beide vonden geen onderdeel dat geschrapt moet worden; claude noemde `containers/<n>.txt` en de herhaalde `wx`-poging als optioneel.

Bevindingen, allemaal gecontroleerd tegen de bomen en overgenomen:
- **MAJOR, beide:** `harness.run_end` als afsluitmarkering zou een half geschreven taakjob definitief als afgesloten opslaan, want `terminal` omvat `hasResult` (`parse-worker-log.ts:224`) en de route leest afgesloten runs niet opnieuw. Oplossing: `harness.loop_end` voor het einde van de modelloop, `harness.run_end` alleen in één afsluitblok met de jobuitkomst, en voor harness-logs is alleen `exit code=` afsluitend (§5.4, §5.6, §7).
- **MAJOR codex, MINOR claude:** wachtwoord in `model.baseUrl` viel buiten de redactie → toegevoegd (§5.7).
- **MAJOR codex, MINOR claude:** vaste instance `worker` botst over hosts op de globale `run_id` → instance per host, `max2` (§2, §5.1, §6.5).
- **MAJOR codex:** "triage binnen een uur" volgt niet uit timer, batch en backoff → gecontroleerde proef met een handmatige start van de triage-service; geen tijdseis (§8, §10, §11).
- **MINOR claude:** foutcodes en -berichten hadden geen weg naar het einde → `RunLog.fail()` en een codelijst (§5.6, §6.3, §6.4).
- **MINOR claude:** het overzicht "vastgelopen runs" toont geen gecrashte runs → zin gecorrigeerd (§5.6, §11).
- **MINOR claude:** na een schrijffout, bij een tweede signaal of bij een niet-I/O-fout kon een run `running` blijven of de job raken → alle uitzonderingen opvangen, `end()` probeert altijd, tweede signaal benoemd (§5.6, §6.3).
- **MINOR claude:** reden bij stap 1 is `idle`, niet `no-job` → tekst (§8).
- **MINOR claude:** `in 0 · out 0` bij ontbrekende usage → `usageSource` (§5.4).
- **MINOR claude:** criterium 4 was dubbelzinnig → herschreven (§10).
- **MINOR claude:** `durationMs ≥ 0` kan niet falen; alleen een idee-chat-fixture → ingespoten klok, tweede fixture uit stap 3 (§9).
- **MINOR claude:** argumenten `null` of scalar kunnen de ingest breken → omhullen in de parser (§5.4, §9).
- **MINOR codex:** de resultaatkaart in scrum4me-workers toont geen duur of beurten → verduidelijkt (§5.4).

Afgewezen: geen. Scope: toegevoegd zijn foutcodes met `fail()`, het afsluitblok in één schrijfactie, de afsluitregel voor harness-logs, `model.baseUrl` in de redactie en een gecontroleerde triageproef; de `wx`-poging is teruggebracht tot één. Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.

### Ronde 2 — revisie 2 (`354d752`), 2026-09-28

Reviewers: `mac:claude` (0 BLOCKER, 0 MAJOR, 4 MINOR; GO) en `mac:codex` (0 BLOCKER, 0 MAJOR, 3 MINOR; GO). Beide: de reparaties uit ronde 1 houden stand (de afsluitmarkering, `META_RE` op beide aanroepplekken, redactie van `model.baseUrl`, instance per host, robuustheid); geen onderdeel om te schrappen.

MINOR-bevindingen, gecontroleerd en verwerkt in revisie 3 zonder nieuwe ronde, want het zijn verduidelijkingen binnen de bestaande scope:
- **claude:** "de laatste `fail` telt" verloor de specifieke code, en vijf returnplekken riepen geen foutfunctie aan → voorrangsregel, `fail()` op die plekken, terugvalcode in `end()`, `DONE_ENDED_FAILED` (§5.6).
- **codex:** een onverwachte uitzondering had geen expliciete classificatie → `catch` in `runOneJob` met `HARNESS_ERROR`, daarna de fout ongewijzigd verder (§6.4, §9).
- **beide:** één handmatige triagestart garandeert de selectie niet → begrensde herhaling (hooguit vijf starts) met vastlegging (§8, §10).
- **claude:** criterium 4 faalde op `DATABASE_URL` en `DIRECT_URL`, waarvan de naam niet matcht maar het URL-wachtwoord wel wordt gemaskeerd → criterium naar beide regels herschreven (§10).
- **beide:** testregels liepen achter op het nieuwe contract → `outcome` ≠ `done` met `exit code=1`; JSON-string en array bij de argumenten (§5.4, §9).

Afgewezen: geen. Scope: onveranderd; alleen verduidelijkingen.

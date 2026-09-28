---
title: "Agent-harness M4 — harness-runs volgen in Worker Logs"
status: draft
last_updated: 2026-09-28
revision: 1
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
| 5 | Pool en instance | Pool `harness` (een pool staat voor de runtime, zoals `idea` voor Claude en `codex`), instance `worker` |
| 6 | Review | Review-loop met `mac:codex` en `mac:claude` tot beide GO geven (JP) |

## 3. Uitgangssituatie

Gelezen op Ops-dashboard `origin/main` 513dfa1b4, scrum4me-docker `origin/master` 52ded13, scrum4me-workers `origin/main` e819a35 en agent-harness `main` 652617f.

**Worker-log-pipeline (Claude en Codex).**
- De runner schrijft per run één bestand `/srv/scrum4me/worker-logs/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log` (scrum4me-docker `bin/run-agent.sh:101`). Daarin staan meta-regels `<ISO-tijd> [run-one-job] <tekst>` (`bin/run-one-job.ts:79`) en daartussen de JSON-regels van de agent, geredigeerd door `lib/log-redact.ts`.
- Een systemd-timer per host (`worker-logs-ingest.timer`, elke 5 min; actief op max2) roept het lokale Ops-dashboard aan. Dat parset elk bestand dat nog niet als afgesloten is ingelezen (`lib/parse-worker-log.ts`) en schrijft `WorkerRun` plus `WorkerEvent` in de ops_dashboard-database. De events worden bij elke ronde volledig vervangen (`lib/ingest-worker-log.ts:256-270`). Runs zonder `job_id` of met status idle slaat de ingest over (`:248-249`).
- Pools worden vanzelf ontdekt: elke submap met een geldige naam (`lib/worker-logs.ts:126`, `NAME_SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/` op `:46`). De bestandsnaam moet voldoen aan `NAME_RE = /^\d{8}T\d{6}Z\.log(\.gz)?$/` (`:41`).
- De parser kent Claude `stream-json` en `codex exec --json`. Codex wordt op dezelfde eventsoorten afgebeeld (`pushCodexEvent`, `parse-worker-log.ts:305-401`), zodat ingest en UI geen Codex-specifieke takken nodig hebben.
- scrum4me-workers leest `/worker-logs` en `/worker-insights` uit de database. Het Ops-dashboard toont het detail door het bestand opnieuw te parsen.
- Triage selecteert runs met status error of token_expired, of met een tool-result met `is_error` (`lib/worker-insights/triage.ts:99-106`), zonder filter op pool. De beoordeling doet `claude-haiku-4-5-20251001` (`:22`), elke 30 minuten, na redactie: denk-tekst en raw vallen weg (`lib/worker-insights/redaction.ts:7,20`), geheimpatronen en paden worden geschoond.

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
  ├─ claim → run-log /srv/scrum4me/worker-logs/harness/worker/runs/<tijd>.log
  ├─ jobstappen  → meta-regels "<tijd> [harness] …"
  ├─ modelloop   → trace.jsonl (volledig) ──┬─→ JSON-regels "harness.*" (geredigeerd, begrensd)
  ├─ containers  → trace + containers/<n>.txt ┘
  └─ afloop      → ERROR-, done- en exit-regel
worker-logs-ingest.timer (max2, elke 5 min) → Ops-dashboard max2 (parser met harness-tak)
  → ops_dashboard: WorkerRun (pool harness, host max2) + WorkerEvent
      ├─ scrum4me-workers /worker-logs (database) en Ops-dashboard max2 /worker-logs (schijf)
      └─ triage (elke 30 min) → WorkerInsight → /worker-insights
```

## 5. Run-log-contract

Dit contract is de afspraak tussen het harness (schrijver) en het Ops-dashboard (lezer). Beide kanten testen ertegen.

### 5.1 Bestand

- Pad: `<dir>/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log`. Op max2 is `dir` `/srv/scrum4me/worker-logs`, `pool` `harness` en `instance` `worker`. `pool` en `instance` moeten voldoen aan `NAME_SEGMENT_RE`; de config controleert dat.
- De naam is het UTC-tijdstip direct na de claim, op de seconde. De schrijver maakt het bestand exclusief aan (`wx`). Bestaat het al, dan wacht hij tot de volgende seconde en probeert het opnieuw, hooguit drie keer. Rechten 0644; ontbrekende mappen maakt hij aan.
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
| Mislukte of afgebroken job | `ERROR <CODE>: <bericht>`, één per job | error | status error, `error_summary` (eerste 300 tekens) |
| Einde | `harness done job_id=<jobId> exit_code=<0\|1> duration_ms=<ms>` | claude-done, na de parserwijziging uit §7 | `exit_code`, `duration_ms` (van claim tot einde) |
| Einde | `exit code=<0\|1>` | exit | afgesloten (`in_progress = false`) |

Het voorvoegsel `step` voorkomt dat vrije tekst per ongeluk begint met een ander herkend voorvoegsel, zoals `cleanup`, `config ` of `ERROR`.

### 5.4 JSON-regels

| `type` | Velden naast `type` en `timestamp` | Afbeelding in de parser |
|---|---|---|
| `harness.run_start` | `runId`, `model`, `baseUrl`, `tools` (namen), `mcpServers`, `cwd`, `version` | `system-init`: model, tools, mcpServers, sessionId = runId, cwd, version; permissionMode `—` |
| `harness.turn` | `turn`, `durationMs`, `finishReason`, `usage {input, output, cached?}`, `promptEstimate?`, `reasoning?` + `reasoningTruncated?`, `content?` + `contentTruncated?`, `systemFingerprint?` | `thinking` (reasoning), `assistant-text` (content, alleen als niet leeg) en een `raw`-regel `turn <n> · <s> s · in <x> · cached <y> · out <z> · <finish>`; het deel `cached <y>` alleen als de server die waarde meldde |
| `harness.tool_call` | `callId`, `name`, `arguments` (string) + `argumentsTruncated?` | `tool-call`, id = callId |
| `harness.tool_result` | `callId`, `ok`, `errorCode?`, `content` + `contentLength` | `tool-result`: isError = !ok; body met `[<errorCode>] ` ervoor als die er is; fullLength = contentLength, de lengte van de volledige tooluitvoer (`fullContent` als die er is, anders `content`) |
| `harness.container` | `n`, `kind`, `source`, `exitCode`, `timedOut`, `durationMs`, `outputTail`, `outputLength` | Bij `prepare` en `gate`: `tool-call` (name `container:<kind>/<source>`, id `container-<n>`) plus `tool-result` (body = outputTail, isError = exitCode ≠ 0 of timedOut; `outputLength` is de lengte van de bewaarde staart). Bij `run_tests` alleen een `raw`-regel, want die uitvoer staat al in het tool-result van de modelaanroep |
| `harness.compacted` | `turn`, `messages`, `bytes`, `estimateBefore`, `estimateAfter` | `raw` |
| `harness.gate` | `turn`, `outcome` (`accept`, `retry` of `fail`) | `raw` |
| `harness.run_end` | `status`, `error? {code, message}`, `answer?` + `answerTruncated?`, `turns`, `toolCalls`, `toolErrors`, `inputTokens`, `outputTokens`, `cachedTokens?`, `durationMs` | `result`: subtype = status, isError = status ≠ `completed`, numTurns = turns, durationMs, totalCostUsd `null`; resultText is `<code>: <message>` als de status niet `completed` is, anders `answer` |
| Onbekend `harness.*` | — | `raw`, JSON afgekapt op 2048 tekens |

- De schrijver schrijft `harness.run_start` zodra de toolsnapshot bekend is. Komt er vóór het volgende event geen snapshot, dan schrijft hij hem met een lege `tools`.
- `version` is `agent-harness@<versie uit package.json>`. Die komt terecht in `WorkerRun.claude_code_version`: de kolom heet zo, de inhoud is de runtimeversie.

### 5.5 Grenzen

De schrijver kapt af op de grenzen die de weergave toont (`parse-worker-log.ts:106-108`), altijd ná de redactie, en zet dan de bijbehorende `…Truncated`-vlag of de volledige lengte:
- `reasoning`, `content` en `answer`: 16 384 tekens;
- `arguments`: 4 096 tekens;
- tool-`content` en container-`outputTail`: 8 192 tekens, waarbij `outputTail` het laatste deel is.

De parser zet `truncated` als hij zelf afkapt of als de regel de vlag draagt. Met `maxTurns` 40 blijft een run-log binnen enkele MB. De parser heeft daarnaast een eigen plafond van 1,5 miljoen tekens per weergave (`:109`, `:528-542`).

### 5.6 Afsluitregels per afloop

| Afloop | Regels |
|---|---|
| `done` | `harness.run_end` (status `completed`), `harness done … exit_code=0`, `exit code=0` |
| `failed`: verify, context, budget, model, of een stap na de modelloop | `harness.run_end` (als de modelloop liep), `ERROR <CODE>: <bericht>`, `harness done … exit_code=1`, `exit code=1` |
| `abandoned`, zoals `JobOutcome` dat nu kent: onder meer eigendom kwijt of een container die niet aantoonbaar gestopt is | `ERROR ABANDONED: <reden>`, `harness done … exit_code=1`, `exit code=1` |
| De job gooit een onverwachte fout | `ERROR HARNESS_ERROR: <bericht>`, `harness done … exit_code=1`, `exit code=1` |
| Harde crash (SIGKILL, OOM) | geen regels; de run blijft `running` en verschijnt in het bestaande overzicht met vastgelopen runs |

`runOneJob` schrijft deze regels precies één keer, in een `finally` rond de job.

### 5.7 Redactie

- De schrijver maskeert elke string in meta- en JSON-regels, vóór het afkappen, met dezelfde regels als de runner (scrum4me-docker `lib/log-redact.ts:12-58`). Gemaskeerd worden:
  - de volledige waarde van elke omgevingsvariabele waarvan de naam matcht op `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$|DSN|CREDENTIAL)/i`;
  - het wachtwoord uit elke URL-waarde, ook in URL-gedecodeerde vorm.

  Alleen waarden vanaf 8 tekens tellen mee; de langste wordt eerst vervangen, door `***`.
- De waarden komen uit `process.env` van de worker, de opgeloste MCP-omgeving (`workerMcpEnv`) en `model.apiKey` als die gezet is.
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
- Bestaande velden blijven ongewijzigd, dus oude traces blijven leesbaar.

### 6.3 Run-log-schrijver (`src/worker/run-log.ts`, nieuw)

- `openRunLog(cfg, jobId, now)` geeft een `RunLog` terug met `meta(text)`, `event(traceEvent, extra?)` en `end(outcome)`. Het resultaat is `null` als `workerLog` ontbreekt of het aanmaken mislukt.
- De trace-schrijver krijgt een optionele volger. Elk trace-event gaat ook naar het run-log, dat het omzet volgens §5.4. Tool-content en container-uitvoer geeft de trace mee op het moment dat hij ze zelf wegschrijft.
- Best-effort: elke I/O-fout wordt opgevangen. Bij de eerste fout gaat er één regel naar stderr en stopt het run-log voor die job. Een fout in het run-log verandert nooit de uitkomst van de job.

### 6.4 Integratie

- `runOneJob` (`worker.ts:101`) opent het run-log direct na de claim, schrijft `claimed` en `config`, en geeft het door aan `runIdeaChatJob` en `runTaskJob`.
- Die handlers geven het run-log mee aan hun trace en schrijven hun jobstappen als `step …`, naast de bestaande regel in journald.
- `runOneJob` sluit af volgens §5.6.

### 6.5 Config (`src/worker/config.ts`)

- Optioneel blok `workerLog: { dir: string, pool: string, instance: string }`. `pool` en `instance` worden gecontroleerd tegen `^[A-Za-z0-9._-]{1,64}$`. Zonder dit blok werkt de worker zoals nu.
- `examples/worker.json` krijgt het blok voor max2.

## 7. Wijzigingen in het Ops-dashboard (`lib/parse-worker-log.ts`)

- `META_RE` (`:111`) wordt `/^(\S+)\s+\[(?:run-one-job|harness)\]\s+(.*)$/`. De groepsnummers blijven gelijk.
- De done-regel `/^(claude|codex) done\b/` wordt `/^(claude|codex|harness) done\b/`, zowel in `classifyMeta` (`:142`) als in `summarizeRunLog` (`:187`).
- `summarizeRunLog` herkent naast `{"type":"result"` (`:207`) ook `{"type":"harness.run_end"` als resultaat. Daaruit leest hij:
  - `hasResult`;
  - `resultIsError`: status ≠ `completed`;
  - `resultSubtype`: de status;
  - `numTurns`: `turns`;
  - `durationMs`: alleen als de done-regel die nog niet gaf.
- `pushJsonEvent` (`:403`) roept vóór `pushCodexEvent` een nieuwe `pushHarnessEvent` aan. Die handelt alle `harness.*`-regels af volgens §5.4 en geeft `true` terug.
- Het commentaar over pools (`:21`) wordt bijgewerkt.
- Ingest, schema, triage en UI veranderen niet. `harness done` valt onder de bestaande MetaTag `claude-done`.

## 8. Inrichting max2 en uitrol (elke stap op JP's go)

1. **Harness.** PR in agent-harness en merge.
   - Werk max2 bij volgens het runbook: pull, `npm ci`, `npm run build`, herstart `agent-harness-worker`.
   - Zet het blok `workerLog` in `/etc/agent-harness/worker.json`, na een backup.
   - Draai één idee-chat-job. Het bestand verschijnt. De huidige parser herkent de `[harness]`-regels niet, ziet dus geen `job_id`, en de ingest slaat het bestand over als `no-job`: geen fout, geen rij.
2. **Ops-dashboard.** Het run-log uit stap 1 wordt, geschoond, de fixture voor de parser-PR; daarna merge.
   - Rol uit op max2 met de flow `redeploy_ops_dashboard`.
   - Bij de volgende ingest-ronde verschijnt de run uit stap 1, omdat hij nog niet als afgesloten was ingelezen.
3. **Taakjob.** Een echte kleine taak via `dispatch_job` met `required_capability: 'local_llm'`.
4. **Mislukte job.** Met het altijd-rode recept uit M3-criterium 2 (een tijdelijke configwijziging), of de eerstvolgende echte fout.

## 9. Tests (zonder netwerk)

**agent-harness** (`npm run verify`):
- **Model-client.**
  - De fixture is de geschoonde echte Ollama-respons van 2026-09-28, met `reasoning`, `cached_tokens` en `system_fingerprint`.
  - Een variant met `reasoning_content`.
  - Een variant zonder deze velden: alles `undefined`, geen fout.
  - `durationMs` is altijd ≥ 0.
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
  - De afsluitregels per afloop uit §5.6, precies één keer.
- **Trace.** De nieuwe velden in `model_response`, en `containers/<n>.txt`.

**Ops-dashboard** (`npm test`):
- De fixture is het geschoonde echte run-log van max2 (stap 1 van §8). Getest wordt:
  - de samenvatting: job_id, status, model, num_turns, duration en exit_code;
  - de eventsoorten en hun volgorde.

  Deze fixture bewijst dat schrijver en lezer het eens zijn over de werkelijke uitvoer. De foutpaden zijn kleine gevallen, afgeleid uit §5.6.
- `META_RE` voor beide tags, en de done-regel met `harness`.
- `running` zonder afsluitregels.
- `error` met een `ERROR`-regel, en `error` met een `run_end` waarvan de status ≠ `completed`.
- Een onbekend `harness.*`-type wordt raw.
- De bestaande Claude- en Codex-tests blijven groen.

## 10. Acceptatiecriteria

1. Na een idee-chat-job op max2 staat, binnen 5 minuten na de uitrol van het Ops-dashboard, een `WorkerRun` met pool `harness`, host `max2` en status success, met `job_id`, `model`, `num_turns` en `duration_ms`. Het detail in scrum4me-workers toont denk-tekst, antwoord, toolblokken en de meetregel per beurt.
2. Een taakjob toont daarnaast `worktree path=`, containerblokken voor prepare en gate met uitvoer, de `run_tests`-regels en de jobstappen: commit, push en jobstatus.
3. Een mislukte job staat op status error met `error_summary` `<CODE>: …`, en heeft binnen een uur na de ingest een `WorkerInsight`.
4. Geen bekend geheim komt voor in de run-logs. `grep -F` op de waarden uit `worker.env` en de MCP-omgeving over `/srv/scrum4me/worker-logs/harness` geeft 0 treffers. De controle draait op max2 en toont de waarden niet.
5. Tussen stap 1 en stap 2 van §8 geeft de ingest geen fouten op het harness-bestand.
6. Bestaande Claude- en Codex-runs worden ongewijzigd geparst: de tests zijn groen, en na de uitrol verschijnen nieuwe idea- en codex-runs zoals voorheen.

## 11. Risico's en open punten

- De triage-indeling is gemaakt voor Claude-jobs en kan harness-fouten grof indelen; `VERIFY_FAILED` wordt waarschijnlijk VALIDATION of OTHER. Herijken hoort bij stap 2.
- Triage stuurt fragmenten van harness-runs naar de Anthropic-API: tooluitvoer en antwoorden, geen denk-tekst. JP heeft dat geaccepteerd.
- Er zijn nu twee kopieën van de redactieregels, in de runner en in het harness, en die kunnen uit elkaar lopen. De tests pinnen dezelfde gevallen; later kan dit eventueel naar scrum4me-shared.
- `WorkerRun.claude_code_version` bevat de harnessversie en `total_cost_usd` blijft leeg. Kosteninzichten tonen harness-runs dus zonder kosten.
- Na een harde crash blijft een run op `running` staan, en de ingest leest zo'n bestand elke 5 minuten opnieuw.
- Harness-run-logs blijven bewaard: de host-prune laat bestanden met `claimed job_id=` staan (Ops-dashboard `deploy/worker-logs-prune/`). Het gaat om enkele MB per maand.
- De trace bevat voortaan ook de volledige denk-tekst, ongeredigeerd en lokaal op max2, net als de tooluitvoer nu al.
- Andere servers dan Ollama leveren misschien geen `reasoning`, `cached_tokens` of `system_fingerprint`. De velden zijn optioneel en ontbreken dan gewoon.

## Review record

Nog geen rondes.

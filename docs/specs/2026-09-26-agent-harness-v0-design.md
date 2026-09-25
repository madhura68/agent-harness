# Agent-harness v0 — ontwerp

Datum: 2026-09-26 · Status: ter review (JP) · Product: Agent-harness (`cmuhjw9e80003mt7rq4w3sauu`) · Repo: https://git.jp-visser.nl/janpeter/agent-harness

Afgeleid van de "Visser Intelligent Systems — Agent-harness specificatie" v0.1 (26-09-2026). Dit document kleedt die spec uit tot het kleinste bruikbare increment; waar het afwijkt staat dat expliciet.

## 1. Doel, eerst bruikbare resultaat, niet-doelen

**Doel in JP's woorden.** Een Ollama-model op max2 testen en daarna gebruiken om Scrum4Me-jobs uit te voeren, met het harness-concept uit de spec als basis; hetzelfde concept later hergebruiken in Scrum4U.

**Eerst bruikbare resultaat (v0).** Een standalone CLI die (a) met een capaciteitsprobe vaststelt of een gegeven model betrouwbaar gestructureerde toolcalls doet, en (b) één run uit een taakmanifest uitvoert in twee profielen: `answer` (prompt in, tekst uit) en `tools` (read-only scrum4me-MCP-tools via allowlist). Elke run levert een trace en een `result.json` op.

**Hoe het resultaat wordt getoond.** `harness probe` tegen het echte Ollama op max2 met `probe.json` als bewijs in de runbook; `harness run examples/sprint-summary.json` tegen max2 + de scrum4me-MCP met een leesbare trace en een antwoord dat aantoonbaar uit toolresultaten komt.

**Niet-doelen v0 (expliciet buiten scope).** Koppeling aan `ClaudeJob`/de worker-pipeline; bash-sandbox; Scrum4U/LiteLLM-gateway en gateway-keys; tenant-/user-context; kosten (USD); streaming; muterende tools; retries; benchmarkmanifest met repo-checkout; kennisbank, citaties en promptinjectie-tests uit spec §4/§9; annulering door een gebruiker.

## 2. Positionering en beslissingen

- **Eigen repo `agent-harness`** (Node 22, ESM, TypeScript strict, vitest). Later een dependency van `scrum4me-docker` (runner) en `Scrum4Us/apps/worker`. Geen koppeling aan een app-repo en geen enum-lockstep in v0.
- **Zelfgeschreven loop**, geen agent-SDK: `fetch` naar `/v1/chat/completions`, `@modelcontextprotocol/sdk` als MCP-client, `zod` voor manifest- en toolcallvalidatie. De beleids- en validatielaag is de kern van de spec en blijft in eigen hand; een misvormde toolcall wordt een begrensde fout, geen automatische reparatie (spec §3).
- **Modelroute v0 = rechtstreeks Ollama** op max2 (`/v1/chat/completions` over de tailnet). De harness kent alleen een OpenAI-compatibele `ModelClient` met `baseUrl`; wijzen naar de LiteLLM-gateway van Scrum4Us is later een configwijziging. De spec-regel "nooit rechtstreeks naar een provider" gaat gelden bij de pipeline-koppeling.
- **Tools v0 = bestaande scrum4me-MCP via stdio**, harness als MCP-client, allowlist in het manifest. Volgt spec §2 (tools/list-snapshot + allowlist) zonder eigen toolcode.

Wat in de bestaande repo's al bestaat en hier bewust niet wordt gedupliceerd: de Scrum4Us LiteLLM-gateway (enige sleutelhouder, per-job keys), de Scrum4Us Docker-sandbox met egress-proxy, en het M26b-ontwerp voor self-hosted endpoints. De `gateway-chat`-adapter in Scrum4Us is tekst-only; een tool-loop bestaat nog nergens.

## 3. Componenten en dataflow

```
manifest.json ─► CLI (`harness run`) ─► Run
                                        ├─ ModelClient   (OpenAI-compat, baseUrl+model uit manifest)
                                        ├─ ToolRegistry  (MCP tools/list → allowlist → snapshot)
                                        ├─ Policy        (naam+schema-check, max turns/tokens/tijd)
                                        └─ Trace         (JSONL per run + result.json)
                                               │
                              scrum4me-MCP (stdio) ◄─┘  alleen bij profiel 'tools'
```

- **Run** is de enige stateful eenheid. Statusmodel: `queued → running → completed | failed | budget_exceeded | timed_out`.
- **ModelClient** heeft één methode `complete(messages, tools?, signal)` → `{ message, usage, model }`. Geen streaming; toolcalls worden pas uitgevoerd als de volledige response binnen is (spec §6).
- **ToolRegistry** maakt bij start een snapshot van de MCP-catalogus, gefilterd op de allowlist. Bij profiel `answer` wordt de MCP-server niet gestart.
- **Policy** zit vóór elke tooluitvoering (§5).
- **Trace** is append-only JSONL plus `result.json` (§7).

## 4. Contracten

```ts
// manifest.json — input van één run (spec §3 AgentRunRequest, uitgekleed)
type Manifest = {
  id: string                      // run-id; bestaand runs/<id>/ ⇒ weigeren (idempotent)
  profile: 'answer' | 'tools'     // 'answer' start geen MCP
  prompt: string
  system?: string                 // optioneel; staat altijd buiten tooloutput (spec §7)
  model: { baseUrl: string; name: string; apiKey?: string }
  tools?: {                       // verplicht bij profile 'tools', verboden bij 'answer'
    server: { command: string; args: string[]; env?: Record<string, string> }
    allow: string[]
  }
  limits: {
    maxTurns: number; maxOutputTokens: number; maxWallSeconds: number; maxToolErrors: number
  }
}

// result.json — output van één run (spec §3 AgentRunResult, zonder citations)
type RunResult = {
  runId: string
  status: 'completed' | 'failed' | 'budget_exceeded' | 'timed_out'
  answer?: string
  error?: { code: string; message: string }
  model: { name: string; baseUrl: string; reported?: string }   // reported = wat de server terugmeldt
  usage: {
    source: 'provider_reported' | 'missing'
    inputTokens: number; outputTokens: number
    turns: number; toolCalls: number; toolErrors: number
  }
  durationMs: number
  toolSnapshotHash?: string       // sha256 over de gefilterde toolcatalogus
}
```

- Geen `tenantId`/`userId`/`costUsd`: er is geen app die de context ondertekent en een lokaal model heeft geen API-prijs. Deze velden komen bij de pipeline-koppeling.
- `apiKey` is optioneel (Ollama vraagt er geen); bij een gateway wordt hij verplicht. Hij staat nooit in trace of result.
- `env` in `tools.server` mag verwijzingen bevatten naar procesomgeving (`${VAR}`), zodat een MCP-token niet in het manifest hoeft te staan.

## 5. Toolbeleid

1. **Snapshot.** Bij start `tools/list` via stdio; filter op `allow`; bewaar naam, beschrijving en inputschema. Een naam in `allow` die de server niet levert is `failed` bij start (`TOOL_NOT_AVAILABLE`), geen stille leegte. De sha256 van de snapshot gaat in `result.json`.
2. **Aanbieden.** De snapshot wordt één-op-één vertaald naar OpenAI-`tools[]` (`type: 'function'`, naam, beschrijving, JSON-schema). Geen `mcp.call(server, tool)`-passthrough.
3. **Controle per call, in deze volgorde:** naam in snapshot → argumenten zijn geldige JSON (string per OpenAI-contract; een object wordt geaccepteerd en genormaliseerd, met een trace-notitie) → argumenten valideren tegen het inputschema → pas dan uitvoeren. Afwijzing levert `ToolResult { ok: false, errorCode: 'UNKNOWN_TOOL' | 'MALFORMED_ARGS' | 'SCHEMA_MISMATCH' }` terug aan het model en telt mee voor `maxToolErrors`.
4. **Uitvoering en normalisatie.** Het MCP-resultaat wordt platgeslagen naar tekst; boven 16 kB afgekapt met `truncated: true`. Een MCP-fout of timeout wordt `ok: false, errorCode: 'TOOL_ERROR' | 'TOOL_TIMEOUT'`. Tooltekst gaat als `role: 'tool'`-bericht terug, nooit in het systeembericht. Tooltekst en documentinhoud zijn data, geen instructies.
5. **Alleen leestools in v0.** De allowlist is de enige rem; de MCP-token bepaalt wat de server toestaat. Muterende tools komen pas met idempotency keys (spec §7).

Meerdere toolcalls in één modelbeurt worden sequentieel uitgevoerd, in de volgorde van het model. Een toolresultaat kan de rechten van een volgende call nooit uitbreiden: de snapshot is bevroren voor de run.

## 6. De loop, limieten en foutafhandeling

```
messages = [system?, user(prompt)]
turn = 0
loop:
  turn++                                   → turn > maxTurns          ⇒ budget_exceeded
  check klok                               → elapsed > maxWallSeconds ⇒ timed_out
  res = model.complete(messages, tools, signal)
                                           → netwerk/5xx/parse-fout   ⇒ failed (MODEL_ERROR)
  tel usage op                             → outputTokens > maxOutputTokens ⇒ budget_exceeded
  geen tool_calls: answer = content        ⇒ completed
  anders per call: policy → exec → tool-bericht toevoegen
                                           → toolErrors > maxToolErrors ⇒ failed (TOO_MANY_TOOL_ERRORS)
```

- **Deadline geldt ook binnen een beurt.** Modelaanroep en elke tooluitvoering krijgen een `AbortSignal` afgeleid van de resterende tijd; een vastgelopen tool of model kan de run niet over `maxWallSeconds` trekken.
- **`maxOutputTokens` is cumulatief over de run.** Per aanroep gaat `max_tokens = maxOutputTokens − outputTokens tot nu toe` mee, zodat één beurt de grens niet kan overschrijden; komt de teller er toch overheen (server negeert `max_tokens`), dan `budget_exceeded`.
- **Geen retries in v0.** Eén mislukte modelaanroep is `failed`.
- **Lege eindtekst** zonder toolcalls is `completed` met `answer: ''`: een modelkwaliteitsprobleem hoort zichtbaar in de trace, niet verstopt als harnessfout.
- **Terminale status is eenmalig.** Na de eerste terminale beslissing wordt geen tool meer uitgevoerd en geen modelaanroep meer gedaan. De MCP-client wordt in `finally` gesloten.
- **Exit-code CLI:** 0 bij `completed`, 1 bij elke andere status of harnessfout.

## 7. Trace, usage en capaciteitsprobe

- **Trace** = `runs/<id>/trace.jsonl`, één regel per event met `ts`, `type` en payload: `run_start` (manifest zonder `apiKey`), `tool_snapshot` (namen + hash), `model_request` (aantal berichten, tools-count), `model_response` (content, tool_calls, usage, finish_reason), `tool_call` (callId, naam, argumenten), `tool_result` (ok, errorCode, truncated, sha256 van de inhoud, bytes), `run_end` (status). De volledige toolinhoud staat in `runs/<id>/tools/<callId>.txt`.
- **Usage** komt uit `usage` in de response. Ontbreekt het veld, dan `usage.source = 'missing'` en tellingen 0; nooit schatten en als feit presenteren (spec §6: `estimated` versus `provider_reported`).
- **Capaciteitsprobe** `harness probe --base-url … --model … --out …` draait zonder MCP een vaste reeks tegen het model met een ingebouwde dummy-tool `echo(text)`:
  (a) plain antwoord zonder tools; (b) één verplichte toolcall; (c) twee opeenvolgende toolcalls in aparte beurten; (d) een prompt die verleidt tot een niet-bestaande tool (verwacht: geen call of een `UNKNOWN_TOOL`-afwijzing die het model netjes verwerkt).
  Uitkomst `probe.json`: per stap pass/fail met de ruwe response, plus eindoordeel `tool_calling: 'reliable' | 'unreliable' | 'none'` (`reliable` = b, c en d geslaagd; `none` = b faalt; anders `unreliable`) en `usage_reported: boolean`.
- **Handhaving.** `harness run` met profiel `tools` weigert zonder `probe.json` met `reliable` voor hetzelfde `baseUrl`+`model` (`PROBE_REQUIRED`), tenzij `--skip-probe` is meegegeven; dat is de spec §3-regel, met een bewuste ontsnapping voor tests.

## 8. CLI, repo-indeling en tests

```bash
harness probe --base-url http://<max2>:11434/v1 --model <naam> --out runs/probe-<naam>
harness run examples/sprint-summary.json --out runs/
```

```
src/cli.ts              commando's, exit-codes
src/manifest.ts         zod-schema + laden (+ ${VAR}-expansie voor tools.server.env)
src/model-client.ts     OpenAI-compat fetch, AbortSignal, usage-parsing
src/tools/registry.ts   MCP-client, snapshot, allowlist, hash
src/tools/policy.ts     naam-, JSON- en schemacontrole
src/run.ts              de loop uit §6
src/trace.ts            JSONL + result.json
src/probe.ts            capaciteitsprobe met ingebouwde echo-tool
examples/answer.json            profiel 'answer'
examples/sprint-summary.json    profiel 'tools', allow: get_context, get_sprint_context
docs/specs/                     dit document
docs/runbooks/probe-and-run-max2.md   recept + bewijs (geen CI)
```

`npm run verify` = lint + typecheck + test, zoals in Scrum4Me.

**Tests, zonder netwerk:**
- Unit: manifestvalidatie (incl. `tools` verplicht/verboden per profiel), policy (de drie afwijzingscodes), truncatie, usage-parsing met en zonder `usage`-veld, argumentnormalisatie string/object.
- Integratie: de hele loop tegen een in-process fake chat-completions-server (`node:http`) en een in-process fake MCP-server via `InMemoryTransport` van de SDK. Scenario's: answer-profiel; één toolcall; twee toolcalls in één beurt; onbekende tool; schema-mismatch; `maxTurns`; deadline halverwege een toolcall; `maxToolErrors`; `TOOL_NOT_AVAILABLE` bij start; `PROBE_REQUIRED`.
- Fixtures vullen het te bewijzen feit niet alvast in: de fake modelserver speelt scripts af (welke response op welke beurt), hij "begrijpt" niets.

## 9. Integratieaannames (te verifiëren in increment 1)

Uit de Ollama-documentatie (openai-compatibility, gecontroleerd 2026-09-26): `POST /v1/chat/completions` ondersteunt `tools`, `max_tokens`, `seed` en `response_format`, en retourneert `usage { prompt_tokens, completion_tokens, total_tokens }`. Aannames die de probe hard maakt: (1) `tool_calls[].function.arguments` komt als JSON-string; (2) `usage` is ook bij tool-call-responses gevuld; (3) het gekozen model op max2 doet betrouwbare toolcalls. Welk model dat wordt is nog open; de probe is model-agnostisch.

## 10. Acceptatiecriteria v0

1. `harness probe` tegen Ollama op max2 levert `probe.json` met een eindoordeel; het bewijs staat in de runbook.
2. `harness run examples/answer.json` tegen max2 eindigt `completed` met antwoord, trace en `result.json` met `usage.source = 'provider_reported'` (of aantoonbaar `missing`).
3. `harness run examples/sprint-summary.json` tegen max2 + scrum4me-MCP eindigt `completed`; de trace toont ten minste één geslaagde `get_sprint_context`-call en het antwoord bevat gegevens die alleen uit dat toolresultaat kunnen komen.
4. Een toolcall naar een niet-geallowliste tool wordt geweigerd, gelogd (`UNKNOWN_TOOL`) en niet uitgevoerd; de MCP-server ontvangt hem niet (integratietest).
5. `maxTurns`, `maxWallSeconds`, `maxOutputTokens` en `maxToolErrors` leiden elk tot de juiste terminale status zonder verdere tool- of modelaanroep (integratietests).
6. Bij profiel `answer` wordt geen MCP-proces gestart (integratietest).
7. `apiKey` komt nergens in trace, result of logs terecht (test).
8. `npm run verify` groen.

## 11. Bouwvolgorde

1. **Increment 1 — probe + model-client + trace:** `model-client.ts`, `trace.ts`, `probe.ts`, `cli probe`. Eerste praktijkproef: probe tegen max2, resultaat in de runbook. Hier valt de beslissing of het gekozen model een tool-profiel krijgt.
2. **Increment 2 — run, profiel `answer`:** `manifest.ts`, `run.ts` zonder tools, `cli run`, `examples/answer.json`. Praktijkproef tegen max2.
3. **Increment 3 — run, profiel `tools`:** `tools/registry.ts`, `tools/policy.ts`, MCP-integratie, `examples/sprint-summary.json`, `PROBE_REQUIRED`. Praktijkproef tegen max2 + scrum4me-MCP.
4. **Daarna, apart te besluiten:** koppeling aan `ClaudeJob` (nieuwe `AgentRuntime`, runner-integratie), gateway-route, sandbox.

## 12. Open punten voor JP

- Welk model op max2 (bepaalt de probe-uitkomst, niet het ontwerp).
- Waar de scrum4me-MCP voor de tools-proef draait: op de Mac (harness en MCP lokaal, model op max2) is het eenvoudigst; op max2 vereist een scrum4me-token daar.

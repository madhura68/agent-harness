---
title: "Probe en run tegen Ollama op max2"
status: active
last_updated: 2026-09-26
---

# Probe en run tegen Ollama op max2

Recept en praktijkbewijs voor de drie incrementen van agent-harness v0 (spec `docs/specs/2026-09-26-agent-harness-v0-design.md`, §10–§11). Geen CI: dit document is het bewijs.

## Verbinding met max2

Ollama op max2 luistert alleen op `127.0.0.1:11434` (systemd-unit, `OLLAMA_HOST=127.0.0.1:11434`). Poort 11434 op het tailnet-adres is dus niet bereikbaar. De harness praat daarom via een SSH-tunnel; op max2 verandert niets.

```bash
ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2
```

Daarna is de base-URL `http://127.0.0.1:11434/v1`. Controle: `curl -s http://127.0.0.1:11434/api/version`.

| Gegeven | Waarde (2026-09-26) |
|---|---|
| Ollama-versie | 0.34.4 |
| GPU | NVIDIA GeForce RTX 5070 Ti, 16 GB; `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_CONTEXT_LENGTH=65536` (tot 2026-09-27 `32768`; zie [meetproef](#meetproef-contextvenster-2026-09-27)) |
| Gekozen model | `qwen3-coder:30b` (Q4_K_M, 30.5B MoE, capabilities `completion, tools`, geen thinking-modus) |

**Modelkeuze.** JP liet het model open (spec §12). `qwen3-coder:30b` was bij de proef al op de GPU geladen, meldt `tools` als capability en heeft geen thinking-modus die content in een apart redeneerveld zou zetten. Andere geïnstalleerde kandidaten (`qwen3.6:35b-a3b-coding`, `qwen3.8:27b`, `qwen3.5:9b`) zijn niet geprobed omdat het eerste verdict al `reliable` was. Een ander model kiezen is één probe-run: de harness is model-agnostisch.

## Increment 1 — capaciteitsprobe

```bash
npm run dev -- probe --base-url http://127.0.0.1:11434/v1 --model qwen3-coder:30b --out runs
```

Resultaat (`runs/probe-qwen3-coder-30b/probe.json`, kopie in [evidence/probe-qwen3-coder-30b.json](evidence/probe-qwen3-coder-30b.json)): **`tool_calling: reliable`, `usage_reported: true`**, looptijd 74 s inclusief laden.

| Stap | Pass | Wat het model deed | finish_reason | Tokens in/uit |
|---|---|---|---|---|
| a_plain | ja | content `pong`, geen toolcall | stop | 19 / 2 |
| b_single_tool | ja | één call `echo({"text":"ping"})` | tool_calls | 302 / 21 |
| c_two_tools | ja | beurt 1 `echo("ping")`, na het tool-bericht beurt 2 `echo("pong")` | tool_calls | 302 / 21, 354 / 21 |
| d_nonexistent_tool | ja | geen toolcall; antwoord "Ik kan de tool `delete_everything` niet vinden. Wil je dat ik iets anders doe?" | stop | 299 / 21 |

**Spec §9-aannames, gemeten:**

1. `tool_calls[].function.arguments` komt als **JSON-string** (`argumentsWasObject: false` in alle stappen). Een losse curl bevestigt de wire-vorm: `{"id":"call_tyhwi04d","index":0,"type":"function","function":{"name":"echo","arguments":"{\"text\":\"ping\"}"}}`.
2. `usage` is **ook bij tool-call-responses gevuld** (`prompt_tokens`, `completion_tokens`, `total_tokens`, plus `prompt_tokens_details.cached_tokens`).
3. Het model doet betrouwbare toolcalls: verdict `reliable`. Increment 3 mag dit model gebruiken.

Opvallend: bij een toolcall is `content` een lege string, niet `null`.

## Increment 2 — `harness run`, profiel `answer`

```bash
npm run dev -- run examples/answer.json --out runs/
```

Resultaat: **`completed`**, exit 0, 1 beurt, tokens in/uit 23/110 met `usage.source = provider_reported`, 4,4 s. Volledige `result.json` en `trace.jsonl` staan in [evidence/answer-smoke.result.json](evidence/answer-smoke.result.json) en [evidence/answer-smoke.trace.jsonl](evidence/answer-smoke.trace.jsonl).

De trace bevat vier events in deze volgorde: `run_start` (manifest zonder `apiKey`), `model_request` (1 bericht, 0 tools, `maxTokens` 512), `model_response` (`finishReason: stop`) en `run_end`.

Het antwoord is inhoudelijk redelijk. De zin "een potentiël bepaalde productuitvoer" is kromme taal van het model, geen harnessfout.

Een run-id is eenmalig: `runs/<id>/` bestaat na de eerste run, dus een tweede run met hetzelfde manifest weigert. Verwijder de map of kies een andere `id` om opnieuw te draaien.

## Increment 3 — `harness run`, profiel `tools` met de scrum4me-MCP

Het model draait op max2 (via de tunnel), de scrum4me-MCP als stdio-kindproces op de Mac. `SCRUM4ME_TOKEN`, `DATABASE_URL` en `DIRECT_URL` moeten in de omgeving van `harness run` staan; het manifest bevat alleen `${VAR}`-verwijzingen. Voor de proef kwamen de waarden uit de `scrum4me`-entry in `~/.claude.json`, via een klein script dat ze als omgeving doorgeeft zonder ze te printen.

```bash
SCRUM4ME_TOKEN=… DATABASE_URL=… DIRECT_URL=… npm run dev -- run examples/sprint-summary.json --out runs/
```

De probe-gate vond `runs/probe-qwen3-coder-30b/probe.json` met hetzelfde `baseUrl` en model en verdict `reliable`, dus `--skip-probe` was niet nodig.

Resultaat: **`completed`**, exit 0, 3 beurten, 2 toolcalls, 0 toolfouten, tokens in/uit 10 732/257 (`provider_reported`), 59 s. Bewijs: [evidence/sprint-summary-smoke.result.json](evidence/sprint-summary-smoke.result.json) en [evidence/sprint-summary-smoke.trace.jsonl](evidence/sprint-summary-smoke.trace.jsonl).

| Beurt | Toolcall | Resultaat |
|---|---|---|
| 1 | `get_context({"product_id":"cmohrysyj0000rd17clnjy4tc"})` | ok, 5 238 bytes, niet afgekapt |
| 2 | `get_sprint_context({"sprint_id":"cmu296u6b0002j9170fcqfl0r"})` | ok, 14 563 bytes, niet afgekapt |
| 3 | geen, eindantwoord | `finishReason: stop` |

Snapshot-hash van `get_context` + `get_sprint_context`: `7f76236720ff16b66cd5c2313b05ee920cab0c6cc04420b1cd3e88ce41722b61`.

Het antwoord van het model:

> In sprint S-2026-09-15-1 worden automatische uitvoering van queue-opdrachten en reviews geïmplementeerd, waarbij de watcherkeuze behouden blijft. De sprint richt zich op het bouwen van een duurzaam systeem met behulp van dispatching, capaciteitsreservering en betrouwbare jobuitvoering. Er vinden diverse review-fixes plaats voor het verbeteren van stabiliteit en regressieproblemen. Deze taken zijn gericht op het verbeteren van zowel de infrastructuur als de gebruikerservaring binnen de applicatie. De meeste taken zijn in een review-status, wat suggereert dat de functionaliteiten vrijwel voltooid zijn en klaar zijn voor evaluatie.

**Spec-criterium 3.** Het model koos de juiste sprint: S-2026-09-15-1 heeft de meest recente `start_date` van de drie open sprints. Deze gegevens staan alleen in de `get_sprint_context`-uitvoer, niet in die van `get_context`:

- "review-fixes" en "regressieproblemen" komen uit taaktitels als "Review-fix R1: Task.dispatch_request_id opnemen in schema.prisma" en "Sluit alle consumenten aan en bewijs contractregressies".
- "capaciteitsreservering" en "dispatching" komen uit taaktitels als "Selecteer geschikte capaciteit en reserveer atomisch" en "Voeg MCP- en CLI-dispatchingangen en context toe".
- "De meeste taken zijn in een review-status" klopt met de taakstatussen: 35 van de 49 taken staan op `review`, 11 op `done` en 3 op `todo`.

De zin over "gebruikerservaring" is een algemene opvulling van het model zonder duidelijke bron.

**Geen secrets.** Een scan op de tokenwaarde en de DB-wachtwoorden vond nul treffers in de run-dir, in `docs/` en in de volledige console-uitvoer. `run_start` toont `tools.server.env` als `<redacted>`.

**Verwachte bijwerking.** De scrum4me-MCP registreert bij elke start onder het gebruikte token een `ClaudeWorker`-rij en stuurt heartbeats (`src/stdio-server.ts`: authenticate, registerWorker, startHeartbeat). Bij afsluiten (`client.close()`, stdin-EOF) deregistreert hij. Een kortstondige workerrij in presence tijdens een tools-run is dus geen storing. De MCP-stderr verschijnt met het voorvoegsel `[mcp]`; de melding over `module.register()` komt van tsx in de MCP-checkout, niet van de harness.

### Waarneming: concurrentie op max2 en de deadline

Een herhaling van dezelfde run om 00:25 UTC eindigde als **`timed_out`** na precies 300 s. Oorzaak: een andere gebruiker draaide tegelijk `qwen3.6:35b-a3b-coding` op max2, en met `OLLAMA_MAX_LOADED_MODELS=1` laadt Ollama per verzoek het gevraagde model opnieuw. Beurt 1 duurde daardoor 75 s en beurt 2 155 s, tegen 21 s in de eerste run. Beide toolcalls slaagden. Beurt 3 werd bij de deadline afgebroken; er volgde geen verdere aanroep. Bewijs: [evidence/sprint-summary-contention.trace.jsonl](evidence/sprint-summary-contention.trace.jsonl).

Dit is het gedrag dat de spec eist (§6: een vastgelopen model trekt de run niet over `maxWallSeconds`). Voor proeven: kijk eerst met `ssh max2 'curl -s localhost:11434/api/ps'` of er een ander model geladen is.

### Contextvenster en lange beurten

Ollama op max2 draaide tijdens de spike met `OLLAMA_CONTEXT_LENGTH=32768`. Een prompt die groter wordt, kapt Ollama van voren af; de chat-template vindt dan geen gebruikersbericht meer en het verzoek faalt met HTTP 500 `no user query found in messages`. In de spike van 2026-09-27 gebeurde dat bij ongeveer 30,8k prompt-tokens.

Zet daarom `limits.contextTokens` op de contextlengte van de server (nu `65536` op max2). De harness schat dan vóór elke beurt de promptgrootte: de laatste door de provider gemelde `prompt_tokens`, plus de sindsdien toegevoegde tekens gedeeld door 1,7, min de door compactie verwijderde tekens gedeeld door 4. Die delers komen uit 114 beurten van de spike (tekens per token: p0 1,72, mediaan 3,06, p95 3,89); zo valt de schatting aan beide kanten hoog uit. Tekst die veel dichter is dan code of Nederlands en Engels proza (bijvoorbeeld CJK) valt daarbuiten. Past de prompt samen met een outputreserve (een kwart van het venster, of minder als het outputbudget kleiner is) niet, dan vervangt de harness de oudste toolresultaten die het model al gezien heeft door een korte stub (`{"compacted": true, …}`) en meldt dat met een `context_compacted`-event in de trace. `max_tokens` per verzoek wordt begrensd op de ruimte die over is. Blijft er minder dan 1024 tokens over, dan eindigt de run als `budget_exceeded` met `CONTEXT_EXHAUSTED`, zonder nog een verzoek.

De model-client heeft geen eigen transporttimeout meer. Node's fetch (undici) brak een verzoek na 300 s zonder headers af, en met `stream: false` komen de headers pas na de hele generatie: een denkende beurt van meer dan vijf minuten eindigde als `fetch failed`. `maxWallSeconds` begrenst nu elk verzoek.

### Meetproef contextvenster (2026-09-27)

Vraag: hoe groot kan het venster voor `qwen3.8-gsq-rco:27b-iq3_s-text` op max2, zonder dat Ollama lagen naar de CPU verplaatst? Opzet: RTX 5070 Ti 16 GiB, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, TEI uit. Per grootte het model laden met `options.num_ctx` via `/api/generate` (de serverconfig bleef ongewijzigd), `size_vram` tegen `size` aflezen in `/api/ps`, en daarna een prompt van echte TypeScript uit de scrum4me-MCP met drie verstopte feiten (`DEPLOY-NOTE`-regels op 25, 50 en 75%), thinking uit en temperatuur 0.

| Venster | Op GPU | Model + KV | Prompt | Inlezen | Genereren | Terugvinden |
|---|---|---|---|---|---|---|
| 32k | 100% | 12,90 GB | 18,8k | 1698 tok/s | 50 tok/s | 3/3 |
| 48k | 100% | 13,56 GB | 38,3k | 1431 tok/s | 45 tok/s | 3/3 |
| 64k | 100% | 14,21 GB | 52,4k | 1285 tok/s | 42 tok/s | 3/3 |
| 72k | 100% | 14,54 GB | 41,3k | 1396 tok/s | 44 tok/s | 3/3 |
| 80k | 96% | 15,41 GB | – | – | – | – |
| 96k | 91% | 16,28 GB | 54,8k | 1041 tok/s | 12,5 tok/s | 3/3 |
| 128k | 82% | 17,83 GB | – | – | – | – |

- Model plus KV-cache groeit met ongeveer 0,65 GB per 16k tokens: KV-cache en rekenbuffers samen. Het model is hybride (1 op 4 lagen heeft attention), dus de KV-cache is klein, ongeveer 35 KB per token in q8_0.
- Ollama zet op deze kaart hooguit ongeveer 14,8 GB op de GPU. Wat erboven komt, draait op de CPU: bij 96k blijft terugvinden goed, maar genereren wordt 3,4 keer trager.
- De 72k-prompt vulde maar 56% van het venster; de marge daar is 0,23 GB.
- Niet gemeten: `OLLAMA_KV_CACHE_TYPE=q4_0`. Dat halveert de KV-cache (waarschijnlijk richting 96–128k), maar geldt voor alle modellen, vraagt een Ollama-herstart en kan kwaliteit kosten bij lang terugzoeken.

Besluit: 64k, met ongeveer 0,55 GB marge. Sinds 2026-09-27 18:30 staat `OLLAMA_CONTEXT_LENGTH=65536` in `/etc/systemd/system/ollama.service.d/override.conf` en stond `contextTokens: 65536` in de toenmalige worker-config (sinds M45-2d staat het in `harness.json`). Controle: een `/v1`-verzoek zonder `num_ctx` laadt het model met `context_length` 65536, 100% op de GPU. Staat er iets anders op de GPU, zoals TEI, dan eerst opnieuw meten.

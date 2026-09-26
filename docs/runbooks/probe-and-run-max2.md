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
| GPU | NVIDIA GeForce RTX 5070 Ti, 16 GB; `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_CONTEXT_LENGTH=32768` |
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

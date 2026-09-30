---
title: "Modellen vergelijken via OpenRouter: eerste contact en recept"
status: active
last_updated: 2026-09-30
---

# Modellen vergelijken via OpenRouter

Runbook voor M5 (spec `docs/specs/2026-09-30-model-comparison-refiner-design.md`, plan `docs/plans/M5-model-comparison-refiner.md`). Dit deel legt het eerste contact vast (Taak 2); Taak 7 vult het aan met de eerste run met docs.

## Sleutel en limiet

- De sleutel staat als `OPENROUTER_API_KEY` in `~/.zshenv` en komt alleen als naam van die variabele voor: nooit in argv, een bestand, een commit of deze runbook.
- De sleutel heeft een limiet van $20. Controle zonder de sleutel te tonen: `GET https://openrouter.ai/api/v1/key` en alleen `limit`, `limit_remaining` en `usage` printen.
- Stand op 2026-09-30, vóór het eerste contact: `limit` 20, `limit_remaining` 20, `usage` 0. Na het eerste contact: `limit_remaining` 19,99281, `usage` $0,00719.

## Eerste contact (2026-09-30, Taak 2)

Vanaf branch `feat/m5-model-comparison` op `6766d74` (met de sleutelmaskering uit Taak 1), na `npm run build`. Werkmap buiten de repo: `~/Development/m5-first-contact/`, met twee kleine scripts:

- `check.py <map> …`: de limietcontrole hierboven, plus een telling van de bestanden waarin de sleutel voorkomt. Print alleen getallen en eindigt met 1 bij een treffer.
- `raw_request.py <label> <model> '<reasoning>' ['<provider>']`: één chat-completion met het `provider`-blok, `max_tokens` 512, één tool (`echo`) en de vraag "Antwoord met alleen het getal: 17*3". De sleutel gaat in-process in de header, dus niet in argv, en de respons wordt gemaskeerd voordat hij naar `response-<label>.json` gaat. Dat vervangt de `curl`-pijplijn uit het plan met dezelfde waarborgen.

### Probe per model (zonder `provider`-blok en zonder reasoning-instelling)

`node dist/cli.js probe --base-url https://openrouter.ai/api/v1 --model <id> --api-key-env OPENROUTER_API_KEY --out ~/Development/m5-first-contact/runs`

| Model | Oordeel |
|---|---|
| `qwen/qwen3.6-35b-a3b` | reliable, usage gemeld |
| `qwen/qwen3.8-27b` | reliable, usage gemeld |
| `google/gemma-4-31b-it` | reliable, usage gemeld |
| `qwen/qwen3.5-122b-a10b` | reliable, usage gemeld |
| `nvidia/nemotron-3-super-120b-a12b` | reliable, usage gemeld |

Dit oordeel is voorlopig (spec §6): de probe kon het `provider`-blok en de reasoning-instelling nog niet meesturen. Het oordeel voor het rapport komt uit de probe met `--extra-body-file` (Taak 14).

### Losse aanvragen met het `provider`-blok

`provider: { "data_collection": "deny", "require_parameters": true }`. Per model twee aanvragen: reasoning uit en reasoning op `medium`.

| Model | `reasoning` | Aanbieder | Reasoning-tokens | Kosten ($) |
|---|---|---|---|---|
| `qwen/qwen3.6-35b-a3b` | `{"effort": "none"}` | AkashML | 0 | 0,0000369 |
| | `{"effort": "medium"}` | AkashML | 27 | 0,0000795 |
| `qwen/qwen3.8-27b` | `{"effort": "none"}` | Reka | 0 | 0,0000200 |
| | `{"effort": "medium"}` | Reka | 37 | 0,0001896 |
| `google/gemma-4-31b-it` | `{"effort": "none"}` | ModelRun | 0 | 0,0000548 |
| | `{"effort": "medium"}` | DeepInfra | 123 | 0,0000574 |
| `qwen/qwen3.5-122b-a10b` | `{"effort": "none"}` | Alibaba | 0 | 0,0000767 |
| | `{"effort": "medium"}` | Alibaba | 45 | 0,0002280 |
| `nvidia/nemotron-3-super-120b-a12b` | `{"effort": "none"}` | DekaLLM | 0 | 0,0000333 |
| | `{"effort": "medium"}` | DekaLLM | 64 | 0,0000648 |

Bevindingen:

- **Aanbieders:** alle vijf modellen hebben een aanbieder onder het `provider`-blok met tools. De aanbieder kan per aanvraag wisselen; bij gemma antwoordde ModelRun op de ene aanvraag en DeepInfra op de andere.
- **Reasoning uit:** `{"reasoning": {"effort": "none"}}` gaf bij alle vijf nul reasoning-tokens.
- **Reasoning aan:** `{"reasoning": {"effort": "medium"}}` gaf bij alle vijf reasoning-tokens, plus `message.reasoning` en `message.reasoning_details` in de respons.
- **Voor `models.json` (Taak 11):** `nodocs` en `probe` krijgen `"reasoning": {"effort": "none"}`, `docs` krijgt `"reasoning": {"effort": "medium"}`, voor alle vijf.
- **Responsvelden:** elke respons draagt:
  - een top-level `provider` (string);
  - `usage.cost` (dollar);
  - `usage.completion_tokens_details.reasoning_tokens`;
  - `usage.prompt_tokens_details.cached_tokens`;
  - `usage.cost_details`.
- **Geen aanbieder:** een aanvraag met `provider.only: ["no-such-provider"]` gaf HTTP 404, zonder kosten. De melding: `{"error":{"message":"No allowed providers are available for the selected model. Providers serving …","code":404,…}}`. Via de harness wordt dat de reden `model HTTP 404: …`, met een melding die providers noemt. Dat past op de regel "geen aanbieder" in Taak 11 (404 of 503 met een providermelding).
- **Sleutelcontrole:** `check.py` over `~/Development/m5-first-contact/` na afloop: 29 bestanden, 0 met de sleutel.

### Aanvulling: temperature en seed onder `require_parameters`

De runs sturen ook `temperature` 0,7 en een `seed`, en `require_parameters: true` routeert alleen naar aanbieders die elk meegestuurd veld ondersteunen. Daarom per model nog één aanvraag met reasoning uit, `"temperature": 0.7` en `"seed": 1`. Alle vijf gaven HTTP 200:

| Model | Aanbieder | Kosten ($) |
|---|---|---|
| `qwen/qwen3.6-35b-a3b` | AkashML | 0,0000369 |
| `qwen/qwen3.8-27b` | Reka | 0,0000200 |
| `google/gemma-4-31b-it` | Friendli | 0,0000109 |
| `qwen/qwen3.5-122b-a10b` | DeepInfra | 0,0000881 |
| `nvidia/nemotron-3-super-120b-a12b` | DekaLLM | 0,0000333 |

Bij `qwen3.5-122b` antwoordde met seed een andere aanbieder (DeepInfra) dan zonder (Alibaba): de seed verkleint de kring van aanbieders. Stand daarna: `limit_remaining` 19,99235; sleutelcontrole over 39 bestanden: 0 met de sleutel.

### Kanttekeningen

- **Reasoning-niveau:** dat `{"effort": "medium"}` reasoning aanzet, is aangetoond; of het niveau `medium` ook als zodanig wordt gehonoreerd, is met één korte vraag niet te zien. Het rapport noemt de instelling, niet een gemeten niveau.
- **"Geen aanbieder":** de 404 hierboven komt van een `provider.only`-filter. De variant waarin `data_collection` of `require_parameters` de laatste aanbieder uitsluit (en de 503 uit de docs) is niet waargenomen; de regel in Taak 11 dekt 404 en 503 met een providermelding.
- **Probe van qwen3.6:** stap d werd afgekapt op 512 tokens (`finishReason` `length`, `content` leeg) en slaagde omdat er geen vreemde toolaanroep was. Zonder reasoning-instelling denkt dit model standaard; de probe van Taak 14 draait daarom met reasoning uit.

### Fixture voor de kostenparser (Taak 5)

`__tests__/fixtures/openrouter-chat-completion.json` is de respons `qwen36-medium` (AkashML, reasoning `medium`). Alleen `id` (`gen-fixture-0001`) en `created` (`1790000000`) zijn vervangen door vaste waarden; de rest is ongewijzigd, met `provider`, `usage.cost` (0,0000795) en `reasoning_tokens` (27).

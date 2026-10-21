---
title: "M9 — review-bench: open modellen met een ruimere output-limiet — spec en plan"
status: draft
last_updated: 2026-10-21
---

# M9 — review-bench: open modellen met een ruimere output-limiet (IDEA-272)

Revisie 1, 2026-10-21. Spec en plan staan in één document (grill-besluit 9).

Bronnen:
- de grill: Scrum4Me IDEA-272, ProductDoc `idea-272-grill`;
- het M8-plan: `docs/plans/M8-review-bench.md`, revisie 9;
- de M8-spec: `docs/specs/2026-10-20-review-bench-design.md`, revisie 3;
- het M8-rapport: max2 `llm-bench/results/review-bench-2026-10-21.md` @`52eecbf`.

Alle bouw gebeurt in de max2-repo. agent-harness krijgt alleen dit document en het review-record.

## 1. Doel

**Vraag.** Halen deepseek-v4-flash-or, deepseek-v4-pro-or en qwen3.8-or-128k het oordeel kandidaat of twijfel als de output-limiet ruimer is?
- Ze draaien op dezelfde case, met dezelfde rubric en dezelfde beslisregel als M8.
- De output-limiet is de enige variabele.

**Aanleiding.** In M8 eindigden zes runs als `limiet`, alle met runStatus `budget_exceeded`:
- flash 3/3;
- pro 2/3;
- qwen 1/3.

In elk van die runs ging ~63k van de 64k output naar reasoning.

**Eerste bruikbare resultaat.** Het rapport van het 128k-venster, met per model een oordeel en een geldige controle (sol).

**Eerste praktijkproef.** De preflight van de vier configuraties tegen de 128k-variant. Die stuurt de echte `max_tokens` van de eerste request (§4.2). Vooral qwen moet die aanvaarden: zijn maximum per request op OpenRouter is 65 536.

**Niet-doelen** (grill, "Buiten scope"):
- glm-5.3, minimax-m3 en sonnet;
- een lagere reasoning-effort;
- wijzigingen aan de harness, en een release;
- een gecombineerd rapport;
- een andere case.

## 2. Vast uit de grill (JP, 2026-10-21)

| # | Besluit |
|---|---|
| 1 | Alleen flash, pro en qwen. glm en minimax houden hun M8-oordeel. |
| 2 | gpt-6.1-sol-or draait als controle 3× in elk venster. Sonnet draait niet mee. |
| 3 | De reasoning-effort blijft als in M8: qwen medium, flash en pro high. Dezelfde configuraties, en geen nieuwe probes. |
| 4 | Getrapt. Stap 1: 128k output en 3600 s wandtijd. Stap 2: 256k en 7200 s, alleen voor een model met minstens één `limiet`-run in stap 1. maxTurns blijft 30. |
| 5 | De preflight bewijst eerst wat de provider aanvaardt. Weigert de provider qwen, dan beslist JP: qwen laten vallen, of een plafond per request in de harness (een eigen idee). |
| 6 | De limieten staan in twee case-varianten in max2, met byte-kopieën en een gedeelde rubric. Een test bewaakt de gelijkheid met het origineel. |
| 7 | Dezelfde rubric, blinde bladen en beslisregel. JP beslist per extra-key. Elk venster krijgt een eigen rapport, en runs worden nooit gemengd. Het laatste rapport krijgt in zijn notes een tabel 64k / 128k / 256k. |
| 8 | Geen rookproef. De preflight is de eerste praktijkproef, daarna start meteen het 128k-venster. De stopregel is die van M8: een tweede benchfout op dezelfde configuratie. |
| 9 | Eén document, één Codex-reviewronde, een delta-ronde bij een MAJOR. Daarna de ceremonie. De vensters starten op JP's go. |

Overgenomen uit M8:
- **Budget per venster:** `min(10, tegoed − 2)`. JP leest het tegoed af en plaatst het key-bestand, en verwijdert het na het venster.
- **Kosten per run:** `maxCostUsd` blijft "1".
- **Release:** de runs gaan tegen de productie-release `/srv/agent-harness/current`, met de bestaande probes.

## 3. Gemeten (2026-10-21)

**Harness** (agent-harness @`8169c93`):
- **Limieten uit de case.** De limieten komen alleen uit `case.json` (`src/bench/review-bench.ts:179`). Er is geen CLI-override (`src/cli.ts:560`).
- **Case-id.** Het case-id moet aan `^[a-z0-9][a-z0-9-]{0,39}$` voldoen (`src/bench/review-case.ts:21`). Het id bepaalt de run-map: `${c.id}-${label}-<8hex>` (`review-bench.ts:131`).
- **max_tokens per request.** Review-bench geeft geen `chatBudget` mee. Per request is `maxTokens = min(maxOutputTokens − outputTokens, contextTokens − promptEstimate)` (`src/run.ts:338-357`). De trace logt beide waarden in `model_request`.
- **Statussen.** `budget_exceeded` en `timed_out` worden `limiet` (`review-bench.ts:67`), `MODEL_ERROR` wordt `benchfout` (`review-bench.ts:55, 65`).
- **Retries.** Een request met HTTP 408, 429, 5xx of een netwerkfout krijgt maximaal 3 retries (`src/bench/retry-client.ts:16-19`).

**M8-traces op max2** (`~/m8-runs/review-bench-2026-10-21`, 24 runs plus 4 rookruns):
- **De eerste request.** In alle 28 traces heeft turn 1 `promptEstimate` 3198 en `maxTokens` 64000.
- **Latere turns.** De laagste `promptEstimate` na turn 1 per configuratie:

  | Configuratie | Laagste `promptEstimate` na turn 1 |
  |---|---|
  | sol | 5792 |
  | flash | 6121 |
  | pro | 3962 |
  | qwen | 6143 |

  Alle vier liggen boven 3198. Bij deze vier is turn 1 dus de request met de grootste `max_tokens`.
- **Output per turn.** De grootste output in één turn:

  | Configuratie | Grootste output in één turn |
  |---|---|
  | qwen | 16 064 |
  | flash | 23 936 |
  | pro | 28 584 |
  | sol | 3 318 |
- **Duur per request.** De langste request duurde 651 s (glm r3). Die request werd afgemaakt, zonder retry. Pro r2 deed 553 s over 28,6k output. Geen enkele M8-trace heeft een retry. De LiteLLM-config heeft `timeout: 600`, maar dat bleek geen harde grens voor een lopende request.
- **Doorvoer.** De limietruns haalden 38–154 tok/s:

  | Output | Duur bij 38 tok/s | Grens |
  |---|---|---|
  | 128k | ≈ 3370 s | onder 3600 |
  | 256k | ≈ 6740 s | onder 7200 |

**max2** (@`52eecbf`):
- **De case-checker.** `check_case.py` controleert de hashes en de payload-pins. Het id en de limieten bekijkt hij niet. Een variant met byte-kopieën komt er dus door.
- **De preflight van `run.py`.** De preflight stuurt altijd `MAX_TOKENS = 64000` (r. 94, 381). `load_case` leest alleen `id` en `maxCostUsd` (r. 206-217). Een ander case-id geeft eigen run-mappen en grootboekregels (r. 300-302, 586, 592).
- **Geen time-out.** `run.py` heeft geen time-out op de harness (r. 352). `PREFLIGHT_TIMEOUT` is 300 (r. 95).
- **`score.py` en het case-id.** `score.py` heeft `CASE_ID = "macsearch-idea263-spec-r5"` als constante (r. 86). Die dient voor het rubric-pad (r. 87) en voor de kop van het rapport (r. 910).
- **De geldigheid met alleen sol.** Die werkt: `bench_geldig` vraagt één controle die kandidaat is (r. 172-175). Een ontbrekende sonnet geeft de regel "Controle niet in --models" (r. 770-772).
- **De rapportnaam.** `--date` moet `YYYY-MM-DD` zijn (r. 942-944). Het rapport komt in `<results-dir>/review-bench-<date>.md` (r. 981).
- **De tests.** `test_review_bench.py` pint de limieten van de echte case (r. 265-276) en de preflight-`max_tokens` 64000 op een synthetische case met 64000/131072 (r. 1002).

## 4. Ontwerp

### 4.1 Twee case-varianten (max2)

Er komen twee mappen naast `llm-bench/review_bench/cases/macsearch-idea263-spec-r5/`:

| Map (= `id`) | `limits` |
|---|---|
| `macsearch-idea263-spec-r5-out128k` | `{"maxTurns": 30, "maxOutputTokens": 128000, "maxWallSeconds": 3600, "maxToolErrors": 8}` |
| `macsearch-idea263-spec-r5-out256k` | `{"maxTurns": 30, "maxOutputTokens": 256000, "maxWallSeconds": 7200, "maxToolErrors": 8}` |

**Inhoud van elke variant:**
- **Byte-kopieën** van `review.md`, `payload.json`, `sources/doc` en `sources/__dispatch_input`.
- **`case.json`:** gelijk aan het origineel, op `id` en `limits` na. De volgorde van de sleutels en de opmaak volgen het origineel. `contextTokens` blijft 131072 en `maxCostUsd` blijft "1".
- **`SOURCE.md`:** een korte verwijzing.
  - Dit is een variant van `macsearch-idea263-spec-r5` voor M9 (IDEA-272), met dezelfde bytes. Alleen `id` en `limits` verschillen.
  - De herkomst en de hashes staan in `../macsearch-idea263-spec-r5/SOURCE.md`.
  - De rubric is `../macsearch-idea263-spec-r5/rubric.md`.
- **Geen** `rubric.md` en geen `ref-result-*.json`. `score.py` leest de rubric van het origineel.

### 4.2 Het preflight-plafond (max2 `run.py`)

De preflight stuurt de `max_tokens` die de harness bij de eerste request van de case stuurt:

```
FIRST_PROMPT_TOKENS = 3198   # promptEstimate van turn 1 in alle 28 M8-traces (release a68a746, deze prompt, drie tools)
preflight max_tokens = min(maxOutputTokens, contextTokens − FIRST_PROMPT_TOKENS)
```

| Case | max_tokens |
|---|---|
| origineel | 64 000 (ongewijzigd) |
| out128k | 127 874 |
| out256k | 127 874 |

**Waarom niet `min(maxOutputTokens, contextTokens)`.** Bij out256k zou dat 131 072 geven.
- Dat ligt boven het maximum van sol per request (128 000). Sol zou dan een preflight weigeren die hij in de echte runs haalt.
- Ook een route met een venster van 131 072 zou weigeren, want de prompt komt er nog bij.

127 874 is de grootste `max_tokens` die de harness in deze case stuurt (§3: turn 1 is de grootste request).

**Wat de preflight niet ziet.**
- Een provider die `max_tokens` stil verlaagt, aanvaardt de request, en de preflight is dan ok.
- Voor qwen maakt dat in de praktijk niet uit: zijn grootste turn in M8 was 16 064 output, ver onder 65 536.

**De constante is gekoppeld aan release en case.** Bij een andere release of prompt kan 3198 verschuiven. Daarom geldt in elk venster een controle:
- In de trace van de eerste run van elke configuratie moet turn 1 `maxTokens` gelijk zijn aan de preflight-waarde.
- Wijkt die af, dan stopt het venster na die run en beslist JP.

### 4.3 De vensters (max2, op JP's go)

| | 128k-venster | 256k-venster |
|---|---|---|
| Case | `…-out128k` | `…-out256k` |
| Configuraties | flash, pro, qwen, sol | elk model met ≥ 1 `limiet`-run bij 128k, en sol |
| Runs | 3 per configuratie, ronde voor ronde zoals M8 | idem |
| `--out` | `~/m9-runs/out128k` | `~/m9-runs/out256k` |
| Grootboek | eigen `ledger.jsonl` onder `--out` | idem |
| Budget | `min(10, tegoed − 2)` | idem, opnieuw afgelezen |
| Wandtijd, hoogstens | 12 × 3600 s ≈ 12 u | (n + 3) × 7200 s |
| Wandtijd, verwacht | ≈ 5–8 u (M8-limietruns duurden 20–28 min bij 64k) | ≈ 2–4 u per model |
| Verwachte kosten | ≈ $1,5–3 | pro ≈ $0,35, qwen ≈ $0,40 en flash < $0,10 per run |

**Regel voor stap 2.** Een `limiet`-run is `budget_exceeded` of `timed_out` (wandtijd).
- Een model dat bij 128k kandidaat of twijfel is, stopt.
- Een model dat afvalt zonder `limiet`-run, stopt ook.
- Heeft geen model een `limiet`-run, dan vervalt het 256k-venster. Het 128k-rapport is dan het laatste.

**Stoppen.** De stopregel is die van M8: een tweede benchfout op dezelfde configuratie. Een stop vanwege de controle in §4.2 hoort daar ook bij. JP beslist hoe het verder gaat.

### 4.4 Scoren en rapport

Het scoren werkt zoals in M8 (plan rev 9, P4):
- `score.py sheets` maakt de bladen;
- Claude scoort de bladen blind, zonder `sheets-key.json`;
- JP beslist per extra-key in `decisions.json`;
- `score.py report` maakt het rapport.

Per venster:
- **Bestanden:** `--results-dir llm-bench/results/review-bench-out128k` (of `-out256k`). Het rapport is `review-bench-<date>.md` in die map, met `sheets/`, `scores.jsonl` en `decisions.json` ernaast.
- **`--notes`:**
  - het venster;
  - de preflight, met de `max_tokens` die zij stuurde;
  - de controle van §4.2;
  - de afwijkingen;
  - in het laatste rapport de tabel per model met het oordeel bij 64k (M8), 128k en 256k.

**Afwijking: de kop van het rapport.** `score.py` blijft ongewijzigd (grill 7). Daardoor zegt de kop "Case `macsearch-idea263-spec-r5`" (r. 910), niet het id van de variant.
- **Wat het opvangt:** de bytes die het model ziet, zijn identiek. De grootboektabel van het rapport noemt per run het case-id van de variant. De notes noemen de variant en zijn limieten.
- **Aanbeveling:** accepteren.
- **Alternatief:** een vlag `--case-id` in `score.py`. Dat is een kleine wijziging, maar die gaat tegen grill 7 in. JP kiest.

## 5. Acceptatie

- **AC1.** Beide varianten:
  - komen door `check_case.py` (exit 0);
  - zijn byte-gelijk aan het origineel in de vier gepinde bestanden;
  - hebben een `case.json` gelijk aan het origineel, op `id` en `limits` na, met de waarden van §4.1.

  Een test bewaakt dit.
- **AC2.** De preflight stuurt `min(maxOutputTokens, contextTokens − 3198)`. Dat is 64000 op de synthetische case en 127 874 op een case met 128000 of 256000. De bestaande test op r. 1002 blijft ongewijzigd groen.
- **AC3.** Een `case.json` zonder geldige `limits.maxOutputTokens` of `contextTokens` geeft een `RunError`. Dat geldt ook als het plafond ≤ 0 uitkomt. Er gaat dan geen request uit.
- **AC4.** `python3 -m unittest discover -s llm-bench/review_bench -v` is groen. De bestaande tests blijven ongewijzigd.
- **AC5** (praktijk). De preflight van flash, pro, qwen en sol tegen out128k:
  - geeft per configuratie ok of een reden in `preflight.json`;
  - de uitkomst voor qwen gaat hoe dan ook naar JP.
- **AC6** (praktijk). Het 128k-venster:
  - geeft een rapport in een eigen map, zonder runs van M8 of van het andere venster;
  - de controle van §4.2 is per configuratie vastgelegd in de notes;
  - de geldigheid via sol staat in het rapport.
- **AC7** (praktijk). De beslissing voor stap 2 staat per model in de notes. Het 256k-venster draait alleen voor die modellen, plus sol.
- **AC8.** Het laatste rapport heeft de tabel 64k / 128k / 256k.
- **AC9.** Het key-bestand gaat alleen via `--key-file`, en de waarde komt nooit in argv, log, trace, resultaat, repo of Scrum4Me.

## 6. Taken (ceremonie: 1 story, 2 taken)

**Story.** "M9: open modellen opnieuw met een ruimere output-limiet (IDEA-272)", repo max2.

### T1 — case-varianten en preflight-plafond (max2, één PR)

**Werkplek.** Repo max2, branch `feat/m9-output-limit` vanaf `origin/main` (`52eecbf`). Dit werk gebeurt op de Mac: de case-bestanden zijn privé, en er is geen netwerk of sleutel nodig.

**Bestanden:**
- **Maken:**
  - `llm-bench/review_bench/cases/macsearch-idea263-spec-r5-out128k/{case.json,SOURCE.md,review.md,payload.json,sources/doc,sources/__dispatch_input}`;
  - hetzelfde voor `-out256k`.

  Kopieer de vier gepinde bestanden met `cp`, zodat ze byte-gelijk blijven.
- **Wijzigen:** `llm-bench/review_bench/run.py`:
  - `FIRST_PROMPT_TOKENS` vervangt `MAX_TOKENS`;
  - `load_case` geeft ook het preflight-plafond terug;
  - `Plan` krijgt een veld voor dat plafond;
  - `ask_litellm` krijgt het plafond als parameter;
  - de preflight meldt het plafond één keer op stdout, als "preflight max_tokens N".
- **Testen:** `llm-bench/review_bench/test_review_bench.py`:
  - een nieuwe `VariantCaseTest` (AC1);
  - in `PreflightTest` twee tests: één met een case van 128000 die 127 874 verwacht (AC2), en één met een ongeldige `contextTokens` die een `RunError` geeft zonder request (AC3).

**Interfaces.** `load_case(case_dir) -> (id, max_cost, preflight_max_tokens)`. `ask_litellm` krijgt `max_tokens` als parameter. Verder blijft alles gelijk.

**Verificatie:**
```
python3 llm-bench/review_bench/check_case.py llm-bench/review_bench/cases/macsearch-idea263-spec-r5-out128k
python3 llm-bench/review_bench/check_case.py llm-bench/review_bench/cases/macsearch-idea263-spec-r5-out256k
python3 -m unittest discover -s llm-bench/review_bench -v
```

**Klaar.** AC1–AC4 houden. De PR in max2 is open via de Forgejo-API, en de merge wacht op JP.

### T2 — de vensters en de rapporten (max2-host, op JP's go)

**Werkplek.** max2-host. Het venster draait detached (`setsid nohup … </dev/null & disown`).

1. **Voorbereiden.**
   - Werk de clone `~/Development/max2-m8` op max2 bij naar main, met T1 gemerged.
   - Ruim daarbij de restanten van M8 op: het ongetrackte rapport en `__pycache__`. Kijk eerst wat er staat.
   - Lees de revisie van `/srv/agent-harness/current` af en zet die in de notes.
2. **Budget en sleutel.** JP leest het tegoed af en plaatst het key-bestand. Het budget is `min(10, tegoed − 2)`.
3. **Preflight tegen out128k.**
   - `run.py --preflight` met `--models deepseek-v4-flash-or deepseek-v4-pro-or qwen3.8-or-128k gpt-6.1-sol-or`, `--case …-out128k`, `--out ~/m9-runs/out128k` en een eigen `--ledger`.
   - Weigert de provider qwen, dan beslist JP (grill 5). Bij een weigering van sol is het venster niet geldig te maken, en beslist JP ook.
4. **Het 128k-venster.**
   - Draai de runs.
   - Controleer na de eerste run van elke configuratie §4.2: turn 1 `maxTokens` moet 127 874 zijn.
   - Stop volgens §4.3.
   - JP verwijdert het key-bestand na het venster.
5. **Scoren en rapporteren** volgens §4.4. Daarna volgt de beslissing voor stap 2, per model in de notes.
6. **Het 256k-venster**, alleen als §4.3 dat geeft en op JP's go. Het volgt stap 2–5 met out256k (`~/m9-runs/out256k`): preflight, runs, controle (127 874), scoren en rapport. In de notes van het laatste rapport komt de tabel 64k / 128k / 256k.
7. **Afronden.** Commit de rapportmappen op een branch in max2 en open een PR via de Forgejo-API. De merge wacht op JP.

**Klaar.** AC5–AC9 houden. De PR is open, en de restanten op max2 zijn genoemd of opgeruimd.

## 7. Risico's en open punten

- **Lange requests.** Met een groter budget kan één turn langer duren dan in M8 (hoogstens 651 s).
  - Een time-out van LiteLLM of OpenRouter krijgt tot 3 retries, die elk tijd en tokens kosten. Daarna volgt `MODEL_ERROR`, en dat is een `benchfout`.
  - Twee benchfouten stoppen de configuratie (§4.3), en JP beslist.
  - Een andere LiteLLM-timeout is een configuratiewijziging. Die valt buiten deze scope (grill 3).
- **Wandtijd.** Bij de traagste M8-doorvoer haalt een 128k-run net de 3600 s. Een `timed_out` telt als `limiet` en voert dus naar stap 2. Dat is zo bedoeld (grill 4).
- **qwen boven 65 536.** Weigert de provider dat, dan volgt grill 5. Verlaagt hij het stil, dan maakt dat in de praktijk niets uit (§4.2).
- **Kosten.** Het plafond per run blijft $1. Een 256k-run van pro of qwen kan tegen ≈ $0,40 lopen, ruim onder het plafond.
- **Open voor JP:** de kop van het rapport (§4.4). De aanbeveling is accepteren.

## 8. Review

Er komt één Codex-reviewronde via dispatch, met `idea_phase` PLAN, want dit document gaat vóór de ceremonie. Bij een MAJOR volgt een delta-ronde.

Het review-record staat in `docs/reviews/2026-10-21-review-bench-output-limit-review-record.md`.

---
title: "M9 — review-bench met ruimere output-limiet — review-record"
status: draft
last_updated: 2026-10-21
---

# Review-record: M9 spec en plan (IDEA-272)

Dit record hoort bij `docs/plans/M9-review-bench-output-limit.md`. Dat document bevat spec en plan samen.

Volgens grill-besluit 9 krijgt het één Codex-ronde via dispatch, en een delta-ronde als er een MAJOR is.

| | |
|---|---|
| Idee | IDEA-272 (`cmvi9gqc9006kfl17peq1yxjz`) |
| `idea_phase` | PLAN |
| Product | agent-harness (`cmuhjw9e80003mt7rq4w3sauu`) |

## Ronde 1: revisie 1 (`2a89b2d70ed0e67b44c637c7a0098cb455e7bc31`)

**Mislukte dispatches.** Twee pogingen kregen `DISPATCH_INVALID_INPUT`, omdat de pins geen `title` hadden. Er is geen request aangemaakt. De keys waren `2bb686a6-452c-4d2b-8dfe-35e8e158c92c` en `1efcee0d-3f1d-4310-a55e-bb4ae75c4fdb`.

**Pins:**
- `plan`: `docs/plans/M9-review-bench-output-limit.md` @`2a89b2d7`, sha256 `38ceb83bca157f52d97210dc5889390caf4f72c7213e45efb6b6758ac257b929`;
- `m8-rapport` (context): max2 `llm-bench/results/review-bench-2026-10-21.md` @`52eecbf9`, sha256 `027c04dbb120dbd8dc5351f518963b5f286d83363ffe4c93a6329216feef18e1`.

Repository: `agent-harness@2a89b2d7`. De body bevatte excerpts van max2 `run.py`, `test_review_bench.py`, `score.py` en `case.json` @`52eecbf`, plus de meetwaarden uit de M8-traces.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `5d58342c-89eb-4e1a-b55a-21e2b23873eb` | `ea46053f-9e51-4de1-9863-c7d32d49ded1` | `497ca2d7-2b7a-4b40-bf55-5b0980ee4573` | linked (PLAN) | **NO-GO** 0/2/3 |

### Triage

| # | Bevinding | Oordeel en remedie |
|---|---|---|
| C-M1 | Een stille verlaging van `max_tokens` door de provider (qwen, 65 536) werd zonder voorbehoud aanvaard. Een length-stop zonder toolcalls eindigt de run als `budget_exceeded`, ook met budget over. Zo'n run zou ten onrechte naar 256k gaan. | **Geaccepteerd, gerepareerd.** Gecontroleerd in `src/run.ts:412-415`: zonder `chatBudget` geeft `finishReason` `length` zonder toolcalls direct `budget_exceeded`. Fix: elke `limiet`-run krijgt een oorzaak (budget, wandtijd, length met budget over, anders) in §4.3. Alleen budget en wandtijd tellen vanzelf mee voor stap 2. De rest gaat met cijfers naar JP. De bewering "maakt in de praktijk niet uit" is geschrapt (§4.2, §7). |
| C-M2 | T2 noteerde de release alleen. Er was geen controle dat M9 dezelfde release draait als M8, en niets tegen een wissel van `current` binnen een venster. | **Geaccepteerd, gerepareerd.** Gecontroleerd: `deploy/max2/ops/agent-harness-ops.sh:36, 208-215` (een symlink die omgezet kan worden). Gemeten: `current` wijst naar `releases/a68a74627660f2afd355e2f11d54be582466db7a`, en `git log a68a746..origin/main -- src deploy package.json` is leeg. Fix: een nieuwe §4.5, met een releasecontrole vóór de preflight, ná de laatste run en bij elke hervatting. Bij een afwijking stopt het venster en beslist JP. T2 stap 1 en 4, en AC6, verwijzen ernaar. |
| C-m3 | Tabel en tekst gaven voor stap 2 verschillende regels. | **Geaccepteerd.** Eén regel, gelijk aan grill 4: een model gaat door als het afvalt en minstens één `limiet`-run met oorzaak budget of wandtijd heeft. Tabel, tekst en AC7 zijn gelijkgetrokken. |
| C-m4 | "Turn 1 is de grootste request" werd als invariant gepresenteerd. Kalibratie en `fitContext` kunnen de schatting later verlagen. | **Geaccepteerd.** Gecontroleerd: `run.ts:263, 384` en `274-293`. Fix: §3 en §4.2 noemen het nu een meting, met het rekenvoorbeeld. Bij een `benchfout` controleert T2 de `maxTokens` van de mislukte request tegen het providermaximum. |
| C-m5 | Niet alle aangehaalde bewijsstukken waren meegeleverd: de grill, het record en de traces. | **Deels geaccepteerd.** §3 zegt nu dat de trace-waarden metingen van de auteur zijn, uit traces die in geen repo staan. Dit record bestaat nu. De grill-besluiten zijn JP's besluiten en worden niet opnieuw gepind. |

**Scope-delta.** Er komt geen bouwwerk bij.
- T2 krijgt twee controles: de release, en de oorzaak per `limiet`-run.
- Er komt een extra JP-beslissing bij "length met budget over".

Het eerste bruikbare resultaat en de eerste praktijkproef blijven gelijk.

## Ronde 2 (delta): revisie 2 (`97902ddf44aa36b4ec104e31483874410515a53a`)

Een delta-ronde door dezelfde modelfamilie (Codex), omdat de claude-sessie de wijziging schreef.

**Pins:**
- `plan` @`97902ddf`, sha256 `6d3a6686b7dffb8ac7ed7d4dc5440596c2f95c7c680b440fe857f00fcd304b62`;
- `plan-rev1` @`2a89b2d7`, sha256 `38ceb83bca157f52d97210dc5889390caf4f72c7213e45efb6b6758ac257b929`.

Repository: `agent-harness@97902ddf`. De body bevatte de delta en de remedies van ronde 1.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `a644ff3f-0f3d-4cd1-a020-a40b79a16c23` | `0e2a22ef-fd9b-469c-8806-07451e061235` | `2edcd4b2-8a84-4dd3-a84d-800c1c2200df` | linked (PLAN) | **NO-GO** 0/1/2 |

**Ronde 1 volgens de reviewer:**
- C-m3 en C-m4: opgelost.
- C-M1: gedeeltelijk opgelost, zie D-M1.
- C-M2: opgelost, onder de releasefreeze, zie D-m2.
- C-m5: gedeeltelijk opgelost, zie D-m3.

### Triage

| # | Bevinding | Oordeel en remedie |
|---|---|---|
| D-M1 | De oorzaak-indeling was niet exclusief. Neem een `length`-antwoord mét toolcalls, gevolgd door `timed_out`. Die run voldoet aan zowel "wandtijd" als "length met budget over", en dan is de route naar stap 2 niet eenduidig. | **Geaccepteerd, gerepareerd.** Gecontroleerd: `src/run.ts:412-415` (de length-stop alleen zonder toolcalls), `:373` (`timed_out`) en `review-bench.ts:213-222` (de velden `runStatus`, `error` en `usage` van `bench-result.json`). Fix: §4.3 heeft nu zes geordende regels op de terminale `runStatus` en `error.code`, met de velden erbij en de grens output ≥ B. "Length met budget over" vraagt `budget_exceeded`, output < B, en een `length`-antwoord zonder toolcalls in de laatste turn. Een onvolledige meting valt onder "anders". |
| D-m2 | De releasecontrole zag een wissel heen en terug (A→B→A) niet. De claim "nooit stil" was te sterk. | **Geaccepteerd, gerepareerd.** `swap_current` maakt bij elke wissel een nieuwe link (`agent-harness-ops.sh:211-215`). De mtime van de link is dus het moment van de laatste wissel. Gemeten op max2: 2026-10-21 06:50:18 UTC, de uitrol van P1 in M8. Fix: §4.5 legt die mtime vóór en na elk venster vast. Het venster is alleen zuiver als `readlink` en mtime gelijk zijn, en als JP geen wissel kent. |
| D-m3 | Externe claims blijven ongeverifieerd: de traces, max2, de grill en de release-historie. De checkout is shallow. | **Geaccepteerd als beperking.** §8 zegt nu welke feiten de review tegen code kon controleren, welke metingen van de auteur zijn, en welke zich pas in T2 bewijzen. Er zijn geen extra pins: de controles van §4.2 en §4.5 vangen een afwijking in T2 op. |

**Scope-delta.** De indeling wordt preciezer, en de releasecontrole krijgt één extra `stat`. Er komt geen bouwwerk bij. Het eerste bruikbare resultaat en de eerste praktijkproef blijven gelijk.

**Nog een delta-ronde.** Grill-besluit 9 vraagt een delta-ronde bij een MAJOR, en ronde 2 gaf er één (D-M1). Ronde 3 is daarom weer een delta-ronde.

## Ronde 3 (delta): revisie 3 (`a8e85dbfd3f372d9cfac31ec406793ab8172ca01`)

**Pins:**
- `plan` @`a8e85dbf`, sha256 `9e76a9138dd21788f0fa1b472d58689b06c127b52b3fcb0e7786a18aa63ef214`;
- `plan-rev2` @`97902ddf`, sha256 `6d3a6686b7dffb8ac7ed7d4dc5440596c2f95c7c680b440fe857f00fcd304b62`.

Repository: `agent-harness@a8e85dbf`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `38658448-8706-452e-9013-b58ee340ca94` | `82242645-61c6-4ae7-a621-349d36b73ce1` | `eb33cb73-2660-4a2b-b95d-2d769dfc6122` | linked (PLAN) | **GO** 0/0/0 |

**D-M1, D-m2 en D-m3 zijn opgelost.** De reviewer controleerde ze tegen de tree.
- **D-M1.** Elk terminaal limietpad valt onder precies één regel van §4.3 (`src/run.ts:248, 333-353, 373, 384-391, 412-415, 464, 497-499, 513-514`, en `src/cost.ts:84-87`). De output-telling past bij de grens ≥ B. Een length-antwoord mét toolcalls dat eindigt in een time-out valt alleen onder regel 1.
- **D-m2.** De link-mtime maakt een A→B→A-wissel via `swap_current` zichtbaar (`agent-harness-ops.sh:211-224`).
- **D-m3.** §8 legt de verificatiegrens vast.

Er zijn geen nieuwe bevindingen. De reviewer heeft geen tests of build gedraaid: de container heeft geen `node_modules` en geen registry. Ook de max2-checks heeft hij niet gedraaid.

**Uitkomst.** Plan revisie 3 (`a8e85dbf`) heeft GO. Volgens de methodiek wachten nu de ceremonie (1 story, 2 taken) en de vensters op JP.

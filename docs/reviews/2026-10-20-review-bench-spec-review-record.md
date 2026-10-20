# Review record: M8 review-bench spec (IDEA-270)

Document: `docs/specs/2026-10-20-review-bench-design.md`. Phase: spec. Idea: IDEA-270 (`cmvgl078e00xozr7rv79oeck3`), `idea_phase: SPEC`. Product: Agent-harness (`cmuhjw9e80003mt7rq4w3sauu`). Orchestrator: mac:claude (Claude Opus 5.5).

## Round 1: revision 1 (`cb26599c755ae2e82e028d68b57fb74cec51f2b4`)

**Pins**, the same for both jobs:

| Key | Path | Product | Commit | sha256 |
|---|---|---|---|---|
| `spec` | `docs/specs/2026-10-20-review-bench-design.md` | agent-harness | `cb26599c` | `b22d7646…d149` |
| `prompt` | `src/prompts/queue/review.md` | scrum4me-mcp | `e89c0961` | `f56fe0a6…4ead` |
| `record` | `docs/reviews/2026-10-16-idea-263-spec-review-record.md` | MacSearch | `4e9dfa5c` | `6bd28635…af1` |

The `repository` field is `agent-harness@cb26599c`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `8ed76988-b1eb-4c97-8591-4fd0f00dc267` | `4df111a6-512a-4e17-bbdb-82c214f13dc5` | `9d0836b4-6ff6-4922-9c0b-e370362c08cb` | linked | **GO** 0/0/4 |
| CLAUDE | `279c4458-bb55-4eb6-a477-ac4c60690338` | `ac5c2860-9833-4fa9-a1da-daa7b0a355dd` | `d376722d-8178-4156-bf45-9d311bc37590` | linked | **NO-GO** 0/1/9 (job `cd2e6bf7-413b-45a9-8123-c504b0cd81d2`) |

**Uitslag ronde 1.**
- CODEX: **GO**, 0 BLOCKER / 0 MAJOR / 4 MINOR.
- CLAUDE: **NO-GO**, 0 BLOCKER / 1 MAJOR / 9 MINOR.

**Triage ronde 1** (elke bevinding is tegen de tree of de bronnen gecontroleerd vóór de fix):

| # | Bevinding | Besluit en remedie |
|---|---|---|
| C-M1 | De beslisregel negeert `outcome`: een `failed` resultaat met NO-GO telt als pass | Geaccepteerd. Gecontroleerd tegen `prompt:47` en `completion.ts:64-70`. Fix: `outcome: succeeded` is een voldoet-eis (§1). `beoordeeld` blijft ongeacht `outcome`, en de scorer eist het (§4.1, regel 4). AC11 test het. |
| X-m1 / C-m4 | `sourceCoverage` meet vóór de venster-afkapping (`run.ts:492-510`), heeft geen AC en speelt geen rol in het oordeel | Geaccepteerd, SCHRAP. Uit §4.1, §4.3 en §4.9 gehaald. De trace houdt de `tool_call`-argumenten en `tool_window` bij, dus dekking is later te berekenen. |
| X-m2 | Het criterium van de rookproef liet een GO toe, of F1 als MINOR | Geaccepteerd. Fix: sonnet moet `outcome: succeeded`, NO-GO en F1 ≥ MAJOR geven (§4.8, stap 6). |
| X-m3 | Een probe met `--all` geeft dezelfde nonzero exit voor een afgewezen nieuwe als voor een afgewezen bestaande configuratie | Geaccepteerd. Fix: na de probe elke `probe.json` lezen. `harness_start` alleen als alle negen bestaande configuraties aanvaard zijn (§4.8, stap 5). |
| X-m4 / C-m9a | De lijst van zeven blokkades is in deze checkout niet verifieerbaar. Commit `75d2888` tegenover `78e7347d` | Deels geaccepteerd. De lijst is ingekort tot de verifieerbare `worker.ts:123-137` plus een verwijzing naar de grill-notitie (informatief). Over de commit: `75d2888` is de laatste commit die het bestand wijzigde en `78e7347d` de HEAD waarop het gelezen is. Beide staan nu in §3. |
| C-m2 | De beslisregel heeft geen AC | Geaccepteerd. Nieuwe AC11 met synthetische fixtures. |
| C-m3 | De variant met eigen foutteksten raakt de gedeelde padbewaking | Geaccepteerd, SCHRAP. `createReadOnlyTools` wordt een zusterfunctie die `listFiles`, `readFile` en `search` hergebruikt (`task-tools.ts:193`, `:234`, `:389`). `createTaskTools` blijft ongewijzigd (§4.3, AC1). |
| C-m5 | Terugzetten via het runbook dekt de LiteLLM-bestanden niet. Merge naar main ontbreekt | Geaccepteerd. Gecontroleerd: runbook `:43` (`release-update` bouwt `origin/main`) en `:142`. Fix: §4.8 kreeg een mergestap (stap 4), de `allow`-controle en de volledige terugzetvolgorde (stap 5). |
| C-m6 | De rookproef test `max_tokens` 64 000 niet voor de andere zes configuraties | Geaccepteerd. Fix: `run.py --preflight`, met per configuratie één aanvraag op de echte `max_tokens` (§4.7). Dat dekt ook de data-policy. |
| C-m7 | Extra MAJORs hebben geen identiteit | Geaccepteerd. Fix: `extra.key`, en JP beslist één keer per `key` (`decisions.json`, §4.6). |
| C-m8 | `payload.json` heeft geen hash. Absolute paden in de payload. De 128k-claim | Geaccepteerd. sha256 `5a52a843…f8f` staat nu in `case.json`. Het pad `/tmp/` in de objective blijft onveranderd en staat in `SOURCE.md`. De 128k-eis geldt de modelkeuze, en het rapport zet `peakInputTokens` naast het venster (§1 niet-doelen, §4.9). |
| C-m9 | Overige namen en tekst | Geaccepteerd. De controles heten nu overal `…-or`. "Drie schrijven" is gecorrigeerd. De afwijking van M5-besluit 4 staat er, net als de afwijking van M5-besluit 3 (data, §6). De CLI-generalisatie staat in §4.1 en §4.8, stap 1. |
| C-m10 | AC7 kan slagen zonder een lekpad | Geaccepteerd. AC7 test nu een `ModelError` met de waarde, en een antwoordbody met de waarde. |

**Scope-delta r1→r2.**
- Eruit: `sourceCoverage` en de variant met eigen foutteksten.
- Erbij:
  - de preflight per configuratie (één goedkope aanvraag);
  - een mergestap;
  - de terugzetvolgorde;
  - AC11;
  - finding-keys.
- Het eerste bruikbare resultaat en de rookproef zijn ongewijzigd. De rookproef is wel strenger: sonnet moet NO-GO geven met F1 ≥ MAJOR.
- Spec: 415 → 442 regels.

## Ronde 2: revisie 2 (`86628ea3496994f5a8b99d05c49db875b73bdc0a`)

**Pins.**
- `spec`: `86628ea3`, sha256 `d7037994…d033`.
- `prompt` en `record`: ongewijzigd ten opzichte van ronde 1.
- Repository: `agent-harness@86628ea3`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `a7df8640-51e2-4089-96ad-df98fc49c904` | `a4e12304-eea7-4e50-857a-ea555d5337ac` | `78673902-8a72-4fb5-9295-2edd9e73d809` | linked | **GO** 0/0/3 |
| CLAUDE | `e1831589-ffe1-4c86-8a07-d3a0c97cf47c` | `1990cf27-342c-4b9f-b3d0-d137c42fbdf7` | `7d24a284-35a2-46fc-b900-71ff0fbf4e66` | linked | **GO** 0/0/7 |

**Fixes van ronde 1.**
- Codex: alle 13 hielden.
- Claude: 12 hielden. Nummer 5 hield deels, omdat `dispatch-child.ts:78-80` buiten de excerpts valt en daardoor niet te verifiëren is. Daaraan verandert niets.

**Dubbel GO: de spec-fase is klaar** (revisie 2, `86628ea3`).
- De MINORs van ronde 2 worden niet in de spec verwerkt. Elke wijziging na de GO zou een delta-ronde vragen.
- Ze gaan als vaste punten naar het plan (M8), dat ze per taak uitwerkt. Het plan noemt per punt waar het geland is.

| # | Bevinding | Naar het plan |
|---|---|---|
| X-m1 | AC10 noemt de preflight niet als reden voor een ontbrekende run | Het rapport en AC10/11 krijgen "preflight afgewezen" als reden, met een fixture. |
| X-m2 | "Bestaande deployments op 65536" klopt niet: de qwen-varianten staan op 16k, 32k en 128k | Erratum: de case overschrijft het venster van elke configuratie. De vier FP8-configuraties staan nu op 65536. |
| X-m3 | De belofte "de scorer telt `checks` apart" is niet gedefinieerd | SCHRAP in het plan: geen `checks`-diagnose in M8. |
| C-m1 | `withDroppedCost` en de tracking van dropped answers zijn niet geëxporteerd (`task-bench.ts:194`, `:326-362`) | Het plan extraheert ze naar een gedeelde helper, met een test dat de kosten van een dropped answer in `usage.costUsd` belanden. |
| C-m2 | De motivering van het grootboek klopt niet: ook het grootboek telt afgebroken aanvragen niet | Erratum: het grootboek begrenst de som over runs; afgebroken aanvragen dekken de marge en een dashboardcontrole na het venster. |
| C-m3 | "Actuele aanvaarde probe" is niet te controleren, en een mislukte `litellm_upgrade` is niet afgehandeld | Het plan definieert "actueel" als: `probe.json` is geschreven na de `litellm_upgrade` van dit venster (mtime). Bij exit ≠ 0 van `litellm_upgrade`: opnieuw draaien, niet proben. De nieuwe configuraties staan achteraan in `harness.json`. |
| C-m4 | De grens van 20 000 tekens in `read_file` betekent dat de bron van 30 KB in stukken gelezen moet worden | Het rapport krijgt per run het aantal `read_file`-aanroepen met `offset`/`limit` op `sources/doc`, uit de trace. |
| C-m5 | De rookproef-gate heeft een F1-score nodig vóór stap 8 | Het plan laat `score.py` voor de rookproef een blad maken, waarop Claude alleen `f1` invult. |
| C-m6 | AC1, AC4 en de CLI-generalisatie kunnen slagen terwijl het defect er is | AC1: de bestaande `task-tools`-tests slagen ongewijzigd. AC4: ook `sources/__dispatch_input`. Gate van stap 1: de gebruiksfout en de stopmelding van task-bench blijven byte-gelijk. |
| C-m7 | Verwijzingen buiten de tree zijn niet te verifiëren | Geen actie. `case-check` controleert de hashes op max2. |

**Scope-delta r2.** Geen. Het eerste bruikbare resultaat en de praktijkproef zijn ongewijzigd.

**Kosten van de loop.** 4 jobs, 2 rondes. Het verbruik staat niet in de MCP-antwoorden.

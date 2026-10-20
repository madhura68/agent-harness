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
| CODEX | `8ed76988-b1eb-4c97-8591-4fd0f00dc267` | `4df111a6-512a-4e17-bbdb-82c214f13dc5` | `9d0836b4-6ff6-4922-9c0b-e370362c08cb` | linked | pending |
| CLAUDE | `279c4458-bb55-4eb6-a477-ac4c60690338` | `ac5c2860-9833-4fa9-a1da-daa7b0a355dd` | `d376722d-8178-4156-bf45-9d311bc37590` | linked | pending |

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

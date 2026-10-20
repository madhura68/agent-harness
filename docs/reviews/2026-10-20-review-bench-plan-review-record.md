# Review record: M8 review-bench plan (IDEA-270)

Document: `docs/plans/M8-review-bench.md`. Phase: plan. Idea: IDEA-270 (`cmvgl078e00xozr7rv79oeck3`), `idea_phase: PLAN`. Product: Agent-harness (`cmuhjw9e80003mt7rq4w3sauu`). Orchestrator: mac:claude (Claude Opus 5.5). Spec: revisie 2, dubbel GO (`86628ea3`); het spec-record staat in `2026-10-20-review-bench-spec-review-record.md`.

## Vóór ronde 1

**Revisies 1 → 3, vóór de dispatch.**
- Rev 1 (`6559730`) zat op 63k van de 64k tekens. De bestandstabel ging eruit, en S3 (de praktijkstappen) verhuisde naar de body. `verify_only` houdt een worker niet tegen (`scrum4me-mcp src/verify/gate.ts:11-12`), dus de praktijkstappen zijn sessiestappen en geen sprint-taken. Dat werd rev 2 (`ef152fb`), en die is als ProductDoc PLANS `idea-270-plan` revisie 2 geüpload.
- Rev 3 (`275db568`) herstelde twee claims die bij de eigen controle fout bleken:
  - "labels zonder punt vanwege `Manifest.id`" klopte niet. `runManifest` valideert `Manifest.id` niet, en `BENCH_LABEL` (`src/cli.ts:550`) staat punten toe. Het label is nu de configuratienaam, en models.json is geschrapt;
  - "`check_budget` met dezelfde vooruitschatting als M7" klopte niet. M7 stopt op `total >= budget_stop`, zonder vooruitschatting. Fix: M8 stopt als `totaal + maxCostUsd > --budget`, met een erratum op spec §4.7.

**Mislukte eerste dispatch.** Beide aanvragen kregen DISPATCH_INVALID_INPUT, omdat `gate.ts` en `run.py` als git-pin waren meegegeven en die moeten `.md` zijn. Er is geen request aangemaakt. De keys waren `69c5d2b5-d8d4-40f7-bdd9-73428451752f` en `10470b2c-8e9e-4420-9347-c63be48d8559`. Daarna is alleen het plan gepind, met de code-excerpts E1 (gate.ts) en E2 (M7 run.py) in de body.

## Ronde 1: revisie 3 (`275db5689c366f217012d348adc5d3529739360e`)

**Pin:** `plan`, `docs/plans/M8-review-bench.md` @`275db568`, sha256 `c27322961c02a828222e0481920c3536a77b348dccfb76b09327d08c266f1154`. Repository: `agent-harness@275db568`.

| Slot | Request id | root_message_id | Idempotency key | idea_link | Verdict |
|---|---|---|---|---|---|
| CODEX | `aad74bfc-cbb0-46c6-8f60-d14100c02bbf` | `67d722a6-ed32-4293-a004-11de47ac7129` | `61791f24-142f-45e2-a397-2312e010210f` | linked | **NO-GO** 0/2/0 |
| CLAUDE | `1145085d-80b2-4aec-8359-b2c115bf4c16` | `c3247036-d862-4d25-983c-32876e6e87ad` | `59d90fd1-2691-4241-b082-ff0268ecf545` | linked | **NO-GO** 0/1/8 |

Beide reviewers vonden geen kandidaat om te schrappen. Alle claims over de tree hielden, en de MINORs van spec-ronde 2 landen zoals het plan zegt.

**Triage ronde 1.** Elke bevinding is tegen de tree gecontroleerd vóór de fix.

| # | Bevinding | Besluit en remedie |
|---|---|---|
| X-M1 | Betaalde weggevallen antwoorden (finishReason `other`) omzeilen de live kostenbewaking | Geaccepteerd. Gecontroleerd: `retry-client.ts:112-124` herhaalt intern, `run.ts:330` en `:404` roepen de guard alleen voor het teruggegeven antwoord, `cost.ts:94-109` telt alleen in `afterResponse`. Fix in S1-2 en S1-6: `createTrackedClient` krijgt een optionele `guard`. In `onRetry` gaat een weggevallen antwoord naar `guard.afterResponse`, daarna `beforeRequest`. Een stop gooit een `CostStopError` (een ModelError, kind `invalid`) vóór de herhaalaanvraag. runReviewBench zet die stop daarna in de run, zodat COST_LIMIT_EXCEEDED limiet wordt. Task-bench geeft geen guard mee en verandert niet. Drie regressietests in S1-6, drie in S1-2. |
| X-M2 / C-M1 | De preflight staat in `<out>`, maar rookproef en hoofdruns draaien in submappen; het rapport heeft geen bron voor preflight, rookproef en de redenen | Geaccepteerd (convergent). Gecontroleerd in P2/P3 en S2-2/S2-3. Fix: de driver krijgt `--preflight-file`, standaard `<out>/preflight.json`. P2 en P3 gebruiken `R/preflight.json` met eigen `--out`-mappen. P3 krijgt alle acht configuraties. De driver slaat een afgewezen preflight of CONFIGURATION_NOT_PROBED zelf over, zonder herhaling en zonder exit 3. `skipped.json` wordt een lijst `{label, run, reason}` voor elke verwachte run zonder resultaat, met "budget bereikt" en de stopredenen erbij. `score.py report` krijgt `--preflight`, `--models`, `--runs`, `--smoke-dir` en `--smoke-scores`. `score.py smoke` vervangt `report --smoke` als gate van P2. Er komt een end-to-end-test in de indeling van P2 en P3. |
| C-m1 | S1-5 hangt af van S1-4, en S1-8 (de push) van S1-1…7, maar dat staat er niet | Geaccepteerd. "Vereist" in S1-5 en S1-8; de volgordetabel is bijgewerkt. |
| C-m2 | De scoping van `retries`, `providers` en de tracked client in task-bench is open | Geaccepteerd. Gecontroleerd: `task-bench.ts:259-262`, `:324-351`, `:465-467`. Fix: `let tracked` vóór de try, met `?? []`-fallbacks in het resultaat. |
| C-m3 | De kosten van een weggevallen antwoord in bench-result.json zijn niet getest in S1-6 | Geaccepteerd, samen met X-M1. Correctie op de voorgestelde test: een HTTP 503 heeft geen bedrag; alleen een record met kind `finish_other` heeft `costUsd` (`retry-client.ts:114-121`). De test is daarom `other` à 0.02 en daarna een geldig antwoord à 0.05, wat 0.07 geeft. `deps.sleep` gaat naar `createTrackedClient`. Dezelfde fout stond in de S1-2-test ("tijdelijke fout met costUsd"); die is ook gecorrigeerd. |
| C-m4 | AC7 zoekt alleen de hele key, en de Python-kant heeft geen echotest | Geaccepteerd. Gecontroleerd: `__tests__/helpers.ts:25-50`. Fix: S1-6 en S1-7 gebruiken `DUMMY_KEY`, `leakedFragments` en `bodyWithKeyAt(190)`. S2-2 krijgt `leaked_fragments` en een nep-LiteLLM die een 400 geeft met de key in de body. `reason` gaat door mask_secrets. |
| C-m5 | De externe bronnen en de docs zijn voor een worker zonder context niet bereikbaar | Geaccepteerd. S1-1 vertakt van `origin/claude/remote-models-review-9a05f5`, waar spec, plan en records staan. S1-3 en S1-4 noemen de Forgejo-repo's en lokale clones, met `git show <sha>:<pad>`. |
| C-m6 | De kostenvoorwaarde in de preflight herhaalt het probe-verdict | Geaccepteerd als herformulering (de reviewer eiste niets). Gecontroleerd: `probe-gate.ts:93-97`. Review Focus 4 en S2-2 zeggen nu dat de probe dit al eist en de preflight het herhaalt bij `max_tokens` 64000. De controle blijft. |
| C-m7 | De `read_file`-telling hangt af van de vorm van het pad | Geaccepteerd. Fix in S2-3: een absoluut pad met `/<runId>/root/` wordt het deel daarna, en dan `posixpath.normpath`. Een fixture met `./sources/doc` en een absoluut pad. |
| C-m8 | De generalisatie van `requiredValues` vraagt een typewijziging | Geaccepteerd, met een ander type. Gecontroleerd: `src/cli.ts:556`. Het voorstel `keyof Values & string` breekt, want `cliArgsConfig` heeft boolean-opties (`help`, `all`, `once`, `skip-probe`, `retry-transient`, `check-case`), en dan is de waarde geen string. Fix: de union van `TASK_BENCH_FLAGS` en `REVIEW_BENCH_FLAGS`. |

**Scope-delta r3→r4.**
- Erbij:
  - een optionele `guard` op de tracked client, met `CostStopError`;
  - `--preflight-file` in de driver;
  - de lijst-vorm van `skipped.json` met vijf redenen;
  - `score.py smoke`, en de extra invoer van `score.py report`;
  - een end-to-end-test.
- Eruit: de handmatige voorfiltering in P3, en `report --smoke`.
- Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.
- Om binnen de 64k te blijven: de MINOR-tabel van spec-ronde 2 is één alinea geworden, en Architecture, de PBI-tekst en enkele lijsten zijn ingekort.
- Plan: 56 756 → 62 945 tekens. De grootste `implementation_plan` is S2-2, met 6 337 tekens.

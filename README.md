# agent-harness

Standalone agent-harness v0: een CLI die een lokaal (OpenAI-compatibel) model zoals Ollama op max2 test op betrouwbare toolcalling en één run uit een manifest uitvoert. Profielen `answer` (zonder tools) en `tools` (read-only scrum4me-MCP via een allowlist), elk met een trace en `result.json`.

- Ontwerp: [docs/specs/2026-09-26-agent-harness-v0-design.md](docs/specs/2026-09-26-agent-harness-v0-design.md)
- Plan: [docs/plans/M1-agent-harness-v0.md](docs/plans/M1-agent-harness-v0.md)
- Recept en praktijkbewijs tegen max2: [docs/runbooks/probe-and-run-max2.md](docs/runbooks/probe-and-run-max2.md)

## Installeren

```bash
npm ci
npm run verify   # lint + typecheck + test, zonder netwerk
npm run build    # dist/cli.js; of gebruik npm run dev -- <args> zonder build
```

Ollama op max2 luistert alleen op localhost. Open eerst een tunnel: `ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2`.

## Capaciteitsprobe

```bash
harness probe --base-url http://127.0.0.1:11434/v1 --model qwen3-coder:30b --out runs
```

Draait vier vaste stappen met een dummy-tool `echo` en schrijft `runs/probe-<model>/probe.json` met `tool_calling: reliable | unreliable | none`. Exit 0 alleen bij `reliable`. Opties: `--api-key-env <VAR>` leest een API-key uit de omgeving, `--step-timeout <sec>` (standaard 120), `--extra-body-file <json>` leest een JSON-object met extra aanvraagvelden (dezelfde regels als `model.extraBody`, zie hieronder) en stuurt die met elke probe-aanvraag mee, zodat de probe bij dezelfde aanbieders uitkomt als de runs. Een bestand met een gereserveerde sleutel wordt geweigerd voordat er een aanvraag uitgaat. De optie geldt alleen voor `probe`: `harness run` en `harness worker` weigeren haar, omdat een stil genegeerd `provider`-blok de aanvragen zonder dat blok zou laten uitgaan; daar hoort `extraBody` in het `model`-blok.

### Probe per configuratie

```bash
harness probe --config /etc/agent-harness/harness.json (--configuration <naam> | --all) --out runs --api-key-env LITELLM_MASTER_KEY
```

Probeert een of alle configuraties van de worker-config via LiteLLM, elk onder zijn eigen naam en met zijn eigen `reasoningEffort` en `extraBody`, en schrijft per configuratie `<out>/probe-<naam>/probe.json`. Behalve de velden van de losse probe staan er `configuration`, `costMode`, `hash`, `accepted` (boolean) en `reasons` (lijst) in, en per stap `costsUsd`: het gemelde bedrag van elk antwoord (`null` als het antwoord er geen meldde; `c_two_tools` heeft twee antwoorden, de andere stappen één). De `hash` is de sha256 over de LiteLLM-config en -compose en over `name`, `costMode`, `reasoningEffort` en `extraBody` van de configuratie; `contextTokens` hoort er niet bij. De uitslag is `accepted` alleen als `tool_calling` `reliable` is, bij `hosted` elk antwoord van elke stap een bedrag heeft (0 is een bedrag) en bij `local` geen enkel antwoord een bedrag groter dan 0 meldt; `reasons` noemt wat ontbreekt. Exit 0 alleen als aanvaard; bij `--all` alleen als elke configuratie aanvaard is (de andere worden wel geprobeerd en geschreven). Deze vorm leest alleen `litellm` en `configurations` uit de config en de masterkey uit `--api-key-env`: hij expandeert geen omgeving en start nooit een MCP-kindproces, dus een probe-unit draait met alleen die sleutel. `--base-url`, `--model` en `--extra-body-file` horen bij de losse vorm en worden hier geweigerd.

## Een run uitvoeren

```bash
harness run examples/answer.json --out runs/
SCRUM4ME_TOKEN=… DATABASE_URL=… harness run examples/sprint-summary.json --out runs/
```

Elke run schrijft `runs/<id>/trace.jsonl`, `runs/<id>/tools/<callId>.txt` en `runs/<id>/result.json`. Een run-id is eenmalig; een bestaande run-dir wordt geweigerd. Exit 0 alleen bij `completed`; anders `failed`, `budget_exceeded` of `timed_out` met exit 1.

Het profiel `tools` weigert met `PROBE_REQUIRED` zolang er geen `probe.json` met `reliable` is voor hetzelfde `baseUrl` en model in de `--out`-map. `--skip-probe` omzeilt dat bewust en wordt in de trace vastgelegd.

Secrets horen in de omgeving, niet in het manifest: `tools.server.env` gebruikt `${VAR}`-verwijzingen die pas op weg naar het MCP-kindproces worden ingevuld. Het kindproces krijgt alleen `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` plus wat het manifest noemt. `model.apiKey` en de env-waarden komen nooit in trace of `result.json`.

`harness run <manifest> --out <dir> --api-key-env <VAR>` leest de API-key voor het model uit die omgevingsvariabele, zoals `probe` dat al deed. De flag wint van een `model.apiKey` in het manifest, die dan ongemoeid blijft; de sleutel gaat alleen naar de model-client en komt niet in het manifest, de trace of `result.json`. Een niet-gezette variabele is een fout die de naam noemt, nog voordat de run-map bestaat.

`model.extraBody` (optioneel object, ook per configuratie in de worker-config als `configurations.<naam>.extraBody`) wordt in elke chat-completions-aanvraag gemerged, voor velden als `temperature`, `seed`, een `provider`-blok of een `reasoning`-object (de geneste vorm van OpenRouter), bijvoorbeeld `"extraBody": { "temperature": 0.7, "seed": 1, "provider": { "data_collection": "deny", "require_parameters": true } }`. De sleutels `model`, `messages`, `tools`, `stream` en `max_tokens` zet de harness zelf; `max_completion_tokens` en `n` zijn ook gereserveerd, want ze botsen met `max_tokens` en met de ene `choices[0]` die de client leest. Al deze sleutels worden bij het laden geweigerd. `reasoning_effort` wordt alleen geweigerd als `reasoningEffort` ook gezet is: de waarde van de client wint dan stilzwijgend, dus het is onduidelijk welke geldt. Het `reasoning`-object is een ander veld en mag wel. De velden staan, net als de rest van het manifest, in de `run_start`-regel van de trace.

`history` (optioneel, op het hoogste niveau van het manifest naast `system` en `prompt`: een lijst van `{ "role": "user" | "assistant", "content": "…" }`) geeft eerdere berichten van een gesprek mee; de worker-config kent het niet. De harness zet ze tussen `system` en `prompt`: `[system?, ...history, user(prompt)]`. Een gevulde lijst begint met `user`, wisselt af en eindigt met `assistant`, want de prompt is de volgende gebruikersbeurt; een andere lijst wordt bij het laden geweigerd met het pad `history` in de melding.

Meldt een respons kosten, reasoning-tokens of de naam van de aanbieder die hem leverde (OpenRouter meldt alle drie; `provider` is dan bijvoorbeeld `AkashML`), dan staan die per respons in de trace (`model_response.usage.costUsd`, `.reasoningTokens`, `model_response.provider`) en opgeteld in `result.json` (`usage.costUsd`, `usage.reasoningTokens`). Reasoning-tokens zijn een deel van `outputTokens`, tel ze er dus niet bij op. Een veld dat geen enkele respons meldde, ontbreekt.

## Worker-modus (IDEA_CHAT via een lokaal model)

```bash
LITELLM_MASTER_KEY=… SCRUM4ME_TOKEN=… DATABASE_URL=… DIRECT_URL=… harness worker --config examples/worker.json --out runs --api-key-env LITELLM_MASTER_KEY [--once]
```

De worker-config (strikt: een onbekende sleutel is een fout, geen stille weglating) heeft een `litellm`-blok (`baseUrl` zonder gebruikersnaam of wachtwoord, plus de absolute paden `configPath` en `composePath`) en `configurations`: minstens één, met een naam die `^[a-z0-9][a-z0-9.-]{0,63}$` volgt. Een configuratie heeft `costMode` (`local` | `hosted`), `contextTokens` (het contextvenster van het model erachter, een geheel getal groter dan 0) en optioneel `reasoningEffort` en `extraBody`. Het oude `model`-blok wordt geweigerd, en `contextTokens` hoort niet meer in `limits` of `task.limits`.

`--api-key-env <VAR>` is verplicht voor `worker` (zonder is het een gebruiksfout, exit 78, voordat er iets start) en levert de masterkey van LiteLLM: de waarde van die omgevingsvariabele gaat als Bearer-header naar LiteLLM, voor de controle bij de start en voor elke model-aanvraag, en nergens anders heen (de config heeft er geen plek voor). Een niet-gezette of lege variabele is een fout die de naam noemt, nog voordat de worker start; ook een naam die de redactie niet als geheim herkent, of een waarde korter dan 8 tekens, wordt geweigerd. Bij de start vraagt de worker `GET <litellm.baseUrl>/models` en eist dat LiteLLM precies de configuraties van de config kent: is LiteLLM onbereikbaar of geeft het een netwerkfout, een 5xx of geen bruikbaar antwoord, dan is dat exit 1 (`LITELLM_UNREACHABLE`: een herstart kan het genezen); weigert LiteLLM de sleutel met HTTP 401 of 403, dan is dat exit 78 (`LITELLM_AUTH_FAILED`, zonder de sleutel in de logregel: een herstart herhaalt het); kent LiteLLM een configuratie niet, of heeft het een model zonder configuratie, dan is dat exit 78 (`LITELLM_MODELS_MISMATCH`, met beide lijsten in de logregel). Beide gebeuren vóór het MCP-kindproces bestaat. Een ongeldige of onleesbare worker-config, een ontbrekende `--api-key-env`-variabele of een andere gebruiksfout van `worker` is ook exit 78, vóór het kindproces. Per configuratie bouwt de worker één model-client (LiteLLM als `baseUrl`, de configuratienaam als modelnaam). Zie [docs/runbooks/idea-chat-worker.md](docs/runbooks/idea-chat-worker.md).

Per job komen de configuratie en het kostenplafond uit de payload: `config.model` is de configuratienaam en `config.max_cost_usd` het plafond als decimale tekenreeks (`^\d+(\.\d+)?$`, groter dan 0). Kent de worker de naam niet, dan faalt alleen die job met `UNKNOWN_CONFIGURATION: <naam>`; ontbreekt het plafond of is het ongeldig, dan faalt alleen die job met `COST_LIMIT_MISSING: <waarde>`. In beide gevallen staat de job nooit op `running`, raakt een taak de taak niet aan, meldt de statusupdate `cost: { reported_cost_usd: null, cost_source: 'none' }` en claimt de worker daarna de volgende job. De run gebruikt het contextvenster (`contextTokens`) van de configuratie van de job.

De worker start één scrum4me-MCP-kindproces met de vaste identiteit `SCRUM4ME_WORKER_RUNTIME=HARNESS` en een lege `SCRUM4ME_WORKER_CAPABILITIES`; de config kan die niet overschrijven. Daardoor claimt hij via `wait_for_job` uitsluitend jobs van runtime `HARNESS`. Vóór de eerste claim roept hij `health` aan en eist hij `HARNESS` in `runtimes`: een MCP zonder dat veld, zonder die waarde of zonder `health`-tool geeft de logregel `STARTCHECK_FAILED` en exit 78, zonder claim. Exit 78 betekent: niet herstarten (dezelfde start faalt op dezelfde manier); dat geldt ook voor een `RUNTIME_MISMATCH` van `wait_for_job`, voor een geclaimde payload waarvan `config.runtime` niet `HARNESS` is (de job blijft onaangeraakt) en voor een claimfilter-fout. Verliest de worker zijn MCP-kindproces, dan laat hij een lopende job los en stopt hij met exit 1: een herstart start een nieuw kind en doet de controle opnieuw. Exit 0 is een nette stop. Per job draait de v0-loop met alleen de vier doc-leestools (`allow` mag niets anders bevatten), en de harness sluit de job zelf af met `update_job_status`: `done` met het antwoord als chatbericht, `model_id` en tokens, of `failed` met een leesbare fout. Het model ziet `wait_for_job`, `job_heartbeat` en `update_job_status` nooit. Vraagt het model `get_product_doc` met een `max_chars` boven 12 000, dan geeft de worker 12 000 door. Zo blijft het antwoord binnen de tool-uitvoergrens van 16 KiB en zet de MCP zelf `truncated` en `next_offset`.

`reasoningEffort` (`none` | `low` | `medium` | `high`, optioneel, per configuratie; ook als `model.reasoningEffort` in een run-manifest) gaat mee als OpenAI-`reasoning_effort`; Ollama's `/v1` zet thinking daarmee uit (`none`). Standaard staat thinking aan: zonder thinking sloegen beide geteste Qwen-modellen de doc-tools over en verzonnen ze antwoorden (zie de runbook). Denktokens tellen mee in `maxOutputTokens`.

Elke claim krijgt een eigen run-dir `runs/job-<jobId>-<epoch-ms>/`. `--once` stopt na één claim of één lege wachtronde. Ctrl-C rondt een lopende job af als `failed` ("worker gestopt"); een tweede Ctrl-C breekt direct af. Per job geldt een probe-gate per configuratie: na de configuratie en het plafond en vóór `running` leest de worker `<out>/probe-<configuratie>/probe.json` en rekent de hash opnieuw uit (twee kleine bestanden). Alleen een probe die voor die configuratie is gemaakt, `accepted: true` heeft en dezelfde hash draagt laat de job door; anders faalt alleen die job met `CONFIGURATION_NOT_PROBED: <reden>` (geen bestand, onleesbaar bestand, niet aanvaard, of een hash die niet klopt omdat een LiteLLM-bestand of de configuratie veranderde) en gelden dezelfde regels als bij `UNKNOWN_CONFIGURATION`: nooit `running`, een taak blijft onaangeraakt, `cost: { reported_cost_usd: null, cost_source: 'none' }`, en de volgende job wordt gewoon geclaimd. De gate heeft geen omzeiling: `worker` kent geen `--skip-probe` (een gebruiksfout, exit 78), en `harness run` houdt zijn eigen gate en zijn `--skip-probe`.

Ontwerp en plan: [docs/specs/2026-09-26-idea-chat-local-llm-design.md](docs/specs/2026-09-26-idea-chat-local-llm-design.md), [docs/plans/M2-idea-chat-local-llm.md](docs/plans/M2-idea-chat-local-llm.md). Recept en praktijkbewijs: [docs/runbooks/idea-chat-worker.md](docs/runbooks/idea-chat-worker.md).

## Worker-modus (TASK_IMPLEMENTATION via een lokaal model)

Dezelfde worker claimt met een `task`-blok in de config ook `TASK_IMPLEMENTATION`-jobs met `required_capability: 'local_llm'` (`kind = 'TASK_IMPLEMENTATION' AND source = 'COPILOT' AND sprint_run_id IS NULL`). Per taak draait de harness `prepare`- en `verify`-commando's (uit een per-repo recept) in wegwerp-Dockercontainers, laat het model werken met zes worktools (`list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run_tests`) begrensd tot de worktree, en commit zelf — deterministisch, nooit het model — pas na een groene verify en een schone scan van de git-administratie. Push gebeurt door de scrum4me-MCP zelf, met een `GIT_ASKPASS`-script ([`deploy/max2/forgejo-askpass.sh`](deploy/max2/forgejo-askpass.sh)) dat het Forgejo-token alleen aan `git.jp-visser.nl` geeft.

Tot deze harness met een `task`-blok op max2 draait, wordt geen taak met `local_llm` gedispatcht (zie het runbook).

Ontwerp en plan: [docs/specs/2026-09-27-task-implementation-local-llm-design.md](docs/specs/2026-09-27-task-implementation-local-llm-design.md), [docs/plans/M3-task-implementation-local-llm.md](docs/plans/M3-task-implementation-local-llm.md). Recept, faalredenen en opruimen: [docs/runbooks/task-worker.md](docs/runbooks/task-worker.md).

## Run-logs in Worker Logs

Met een `workerLog`-blok in de worker-config (`{ "dir": …, "pool": …, "instance": … }`) schrijft de worker per geclaimde job ook een geredigeerd run-log in het Worker-Log-formaat van de Claude- en Codex-runners, naast de ongewijzigde `trace.jsonl`. Zonder dat blok verandert er niets.

```bash
harness check-run-logs --config <worker.json> --dir <run-logs-dir> [--api-key-env <VAR>]
```

Controleert of een geheim dat de redactie hoort te maskeren onveranderd in een run-log staat (met `--api-key-env` telt ook de masterkey van de worker mee), en drukt per geheim alleen de naam en het aantal treffers af, nooit een waarde. Exit 1 bij een treffer, of als er geen enkel geheim gecontroleerd is. Draai het met de omgeving van de service (zie het runbook).

Ontwerp en plan: [docs/specs/2026-09-28-harness-run-logging-design.md](docs/specs/2026-09-28-harness-run-logging-design.md), [docs/plans/M4-harness-run-logging.md](docs/plans/M4-harness-run-logging.md). Recept en praktijkbewijs: [docs/runbooks/idea-chat-worker.md](docs/runbooks/idea-chat-worker.md#run-logs-in-worker-logs-m4).

## Doc-server over een bevroren docset (M5)

```bash
harness doc-server --dir <docset-dir> --product-id <id>
```

Een stdio-MCP-server die de vier doc-tools van scrum4me-mcp (`search_product_docs`, `get_product_doc`, `list_product_docs`, `related_product_docs`) aanbiedt over een bevroren map met documenten. De modelvergelijking (M5) start hem als `tools.server` van een run met het profiel `tools`:

```json
"tools": {
  "server": { "command": "harness", "args": ["doc-server", "--dir", "docset", "--product-id", "bench-agent-harness"] },
  "allow": ["search_product_docs", "get_product_doc", "list_product_docs", "related_product_docs"]
}
```

Het model leest dezelfde toolnamen, beschrijvingen en invoerschema's als in Scrum4Me (scrum4me-mcp op `285c98ae`), de resultaten hebben dezelfde sleutels en de fouten dezelfde tekst. De beschrijvingen zijn letterlijk overgenomen, ook waar ze Postgres noemen. `__tests__/fixtures/scrum4me-doc-tools.schema.json` bevat de vastgelegde definities van het echte MCP; een test vergelijkt ze met wat de server aanbiedt.

De docset is `<dir>/docset.json` (`frozen_at` en `files: [{ folder, slug, … }]`; de andere sleutels worden niet gelezen) met de documenten op `<dir>/<folder>/<slug>.md`. `--product-id` is de id waarop de server antwoordt; een andere id geeft `Product '<id>' not found or not accessible`. Elk document is `active` in een ingeschakelde folder en heeft `frozen_at` als `updated_at`. De titel is de `title` uit de front matter, anders de eerste `# `-kop. De `slug` van een aanvraag wordt naar kleine letters gezet vóór het zoeken, zoals scrum4me-mcp doet; een slug met `.md` erachter is dus een onbekend document. `get_product_doc` pagineert in tekens (`byte_size` en `next_offset` tellen tekens), en `heading` is de koptekst zonder `#`, hoofdletterongevoelig, tot de volgende kop van gelijk of hoger niveau.

**Bewust anders dan productie:** geen authenticatie en geen Postgres-FTS. Zoeken is woordherkenning: de inhoud, titel en slug worden in kleine letters geknipt op alles wat geen letter of cijfer is, en een term telt bij een heel woord. Alle termen moeten erin staan; `OR` tussen twee termen maakt er "een van beide" van (`a b OR c` is: a, en b of c), terwijl productie (Postgres `websearch_to_tsquery`) dezelfde zoekopdracht leest als (a en b) of c, zodat een zoekopdracht met zowel gewone termen als `OR` hier minder documenten kan geven; `-term` sluit uit; een frase tussen aanhalingstekens vraagt de woorden direct achter elkaar, en een term met leestekens erin zoals `tool-calling` ook. De score is het aantal treffers, bij gelijke score beslist de slug. De snippet is de tien woorden rond de eerste treffer, met `<<` en `>>` om de treffer. `related_product_docs` leest `[tekst](pad.md)` en `[tekst](pad.md#anker)`, opgelost ten opzichte van de folder van het document of als `docs/<folder>/<bestand>.md` (die vorm lost hier op, maar de resolver van productie meldt hem onder `broken_links`); een link naar een `.md` die niet in de set zit staat onder `broken_links`. Een link naar het document zelf wordt overgeslagen in plaats van, zoals in het origineel, als gebroken gemeld. Een href naar een `.md` onder paden die het origineel negeert (zoals `/lib/` of `/app/`) telt hier wel mee en staat onder `broken_links` als het doel niet in de set zit. Het antwoord van `get_product_doc` blijft binnen de tool-uitvoergrens van de harness (`TOOL_OUTPUT_LIMIT`, 16 384 bytes, gemeten aan de geserialiseerde JSON): is het gevraagde stuk groter, dan levert de server het grootste stuk dat past en zet hij `truncated` en `next_offset` zoals het origineel bij `max_chars` doet, zodat paging met `offset` het hele bestand geeft (een sectie met `heading` wordt dan afgekapt zonder `next_offset`, net als bij `max_chars`).

Ontwerp en plan: [docs/specs/2026-09-30-model-comparison-refiner-design.md](docs/specs/2026-09-30-model-comparison-refiner-design.md), [docs/plans/M5-model-comparison-refiner.md](docs/plans/M5-model-comparison-refiner.md). Recept: [docs/runbooks/model-comparison.md](docs/runbooks/model-comparison.md).

## Local precision refiner (M6)

Volgt op M5. Test of qwen3.8-27b lokaal op hogere precisie (Q8, Q4) kan evenaaren wat gehost kan met docs, ter ondersteuning van een Mac-koopbesluit. Draait de docs-variant van de M5-bank op max2 tegen Ollama, vergelijkt de uitkomst met gsq (3-bit lokaal) en gehost (M5), en geeft het oordeel: door (kandidaat Q4 op Mac, of Q8 met 48 GB), gezakt (kies Q8 met ~48 GB), of onbeslist (extra seeds nodig of geen lokale route aangetoond).

Ontwerp en plan: [docs/specs/2026-10-01-local-precision-refiner-design.md](docs/specs/2026-10-01-local-precision-refiner-design.md), [docs/plans/M6-local-precision-refiner.md](docs/plans/M6-local-precision-refiner.md).

## Task-bench (M7)

Volgt op M5 en M6. Test of Qwen 3.8 (`qwen/qwen3.8-27b` op 16-bit via OpenRouter, naast `gsq-lokaal` op max2) echt werk aankan, ter ondersteuning van een aankoopbesluit voor een 96 GB-machine. Het subcommando `harness task-bench` voert 12 oude, afgeronde Scrum4Me-taken uit zoals de productieworker en toetst de uitkomst met de verborgen tests van de echte oplossing. Met `harness task-bench --check-case` bewijs je per case dat de verborgen toets op `base_commit` faalt en op `ref_commit` slaagt. Status: increment 1 (Taak 1–5, het subcommando en `--check-case`) is gebouwd en gemerged (PR #31); de build en de runs op max2 volgen apart.

Ontwerp en plan: [docs/specs/2026-10-02-task-bench-design.md](docs/specs/2026-10-02-task-bench-design.md), [docs/plans/M7-task-bench.md](docs/plans/M7-task-bench.md).

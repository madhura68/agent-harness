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

## Een run uitvoeren

```bash
harness run examples/answer.json --out runs/
SCRUM4ME_TOKEN=… DATABASE_URL=… harness run examples/sprint-summary.json --out runs/
```

Elke run schrijft `runs/<id>/trace.jsonl`, `runs/<id>/tools/<callId>.txt` en `runs/<id>/result.json`. Een run-id is eenmalig; een bestaande run-dir wordt geweigerd. Exit 0 alleen bij `completed`; anders `failed`, `budget_exceeded` of `timed_out` met exit 1.

Het profiel `tools` weigert met `PROBE_REQUIRED` zolang er geen `probe.json` met `reliable` is voor hetzelfde `baseUrl` en model in de `--out`-map. `--skip-probe` omzeilt dat bewust en wordt in de trace vastgelegd.

Secrets horen in de omgeving, niet in het manifest: `tools.server.env` gebruikt `${VAR}`-verwijzingen die pas op weg naar het MCP-kindproces worden ingevuld. Het kindproces krijgt alleen `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` plus wat het manifest noemt. `model.apiKey` en de env-waarden komen nooit in trace of `result.json`.

`harness run <manifest> --out <dir> --api-key-env <VAR>` leest de API-key voor het model uit die omgevingsvariabele, zoals `probe` dat al deed. De flag wint van een `model.apiKey` in het manifest, die dan ongemoeid blijft; de sleutel gaat alleen naar de model-client en komt niet in het manifest, de trace of `result.json`. Een niet-gezette variabele is een fout die de naam noemt, nog voordat de run-map bestaat.

`model.extraBody` (optioneel object, ook in het `model`-blok van de worker-config) wordt in elke chat-completions-aanvraag gemerged, voor velden als `temperature`, `seed`, een `provider`-blok of een `reasoning`-object (de geneste vorm van OpenRouter), bijvoorbeeld `"extraBody": { "temperature": 0.7, "seed": 1, "provider": { "data_collection": "deny", "require_parameters": true } }`. De sleutels `model`, `messages`, `tools`, `stream` en `max_tokens` zet de harness zelf; `max_completion_tokens` en `n` zijn ook gereserveerd, want ze botsen met `max_tokens` en met de ene `choices[0]` die de client leest. Al deze sleutels worden bij het laden geweigerd. `reasoning_effort` wordt alleen geweigerd als `reasoningEffort` ook gezet is: de waarde van de client wint dan stilzwijgend, dus het is onduidelijk welke geldt. Het `reasoning`-object is een ander veld en mag wel. De velden staan, net als de rest van het manifest, in de `run_start`-regel van de trace.

## Worker-modus (IDEA_CHAT via een lokaal model)

```bash
SCRUM4ME_TOKEN=… DATABASE_URL=… DIRECT_URL=… harness worker --config examples/worker.json --out runs [--once]
```

De worker start één scrum4me-MCP-kindproces met de vaste identiteit `SCRUM4ME_WORKER_CAPABILITIES=local_llm` en `SCRUM4ME_WORKER_RUNTIME=CLAUDE`; de config kan die niet overschrijven. Daardoor claimt hij via `wait_for_job` uitsluitend `IDEA_CHAT`-jobs met `required_capability = 'local_llm'`: de web-app zet die capability voor producten in `IDEA_CHAT_LOCAL_PRODUCT_IDS`. Per job draait de v0-loop met alleen de vier doc-leestools (`allow` mag niets anders bevatten), en de harness sluit de job zelf af met `update_job_status`: `done` met het antwoord als chatbericht, `model_id` en tokens, of `failed` met een leesbare fout. Het model ziet `wait_for_job`, `job_heartbeat` en `update_job_status` nooit.

`model.reasoningEffort` (`none` | `low` | `medium` | `high`, optioneel, ook in een run-manifest) gaat mee als OpenAI-`reasoning_effort`; Ollama's `/v1` zet thinking daarmee uit (`none`). Standaard staat thinking aan: zonder thinking sloegen beide geteste Qwen-modellen de doc-tools over en verzonnen ze antwoorden (zie de runbook). Denktokens tellen mee in `maxOutputTokens`.

Elke claim krijgt een eigen run-dir `runs/job-<jobId>-<epoch-ms>/`. `--once` stopt na één claim of één lege wachtronde. Ctrl-C rondt een lopende job af als `failed` ("worker gestopt"); een tweede Ctrl-C breekt direct af. Dezelfde probe-gate als `harness run` geldt.

Ontwerp en plan: [docs/specs/2026-09-26-idea-chat-local-llm-design.md](docs/specs/2026-09-26-idea-chat-local-llm-design.md), [docs/plans/M2-idea-chat-local-llm.md](docs/plans/M2-idea-chat-local-llm.md). Recept en praktijkbewijs: [docs/runbooks/idea-chat-worker.md](docs/runbooks/idea-chat-worker.md).

## Worker-modus (TASK_IMPLEMENTATION via een lokaal model)

Dezelfde worker claimt met een `task`-blok in de config ook `TASK_IMPLEMENTATION`-jobs met `required_capability: 'local_llm'` (`kind = 'TASK_IMPLEMENTATION' AND source = 'COPILOT' AND sprint_run_id IS NULL`). Per taak draait de harness `prepare`- en `verify`-commando's (uit een per-repo recept) in wegwerp-Dockercontainers, laat het model werken met zes worktools (`list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run_tests`) begrensd tot de worktree, en commit zelf — deterministisch, nooit het model — pas na een groene verify en een schone scan van de git-administratie. Push gebeurt door de scrum4me-MCP zelf, met een `GIT_ASKPASS`-script ([`deploy/max2/forgejo-askpass.sh`](deploy/max2/forgejo-askpass.sh)) dat het Forgejo-token alleen aan `git.jp-visser.nl` geeft.

Tot deze harness met een `task`-blok op max2 draait, wordt geen taak met `local_llm` gedispatcht (zie het runbook).

Ontwerp en plan: [docs/specs/2026-09-27-task-implementation-local-llm-design.md](docs/specs/2026-09-27-task-implementation-local-llm-design.md), [docs/plans/M3-task-implementation-local-llm.md](docs/plans/M3-task-implementation-local-llm.md). Recept, faalredenen en opruimen: [docs/runbooks/task-worker.md](docs/runbooks/task-worker.md).

## Run-logs in Worker Logs

Met een `workerLog`-blok in de worker-config (`{ "dir": …, "pool": …, "instance": … }`) schrijft de worker per geclaimde job ook een geredigeerd run-log in het Worker-Log-formaat van de Claude- en Codex-runners, naast de ongewijzigde `trace.jsonl`. Zonder dat blok verandert er niets.

```bash
harness check-run-logs --config <worker.json> --dir <run-logs-dir>
```

Controleert of een geheim dat de redactie hoort te maskeren onveranderd in een run-log staat, en drukt per geheim alleen de naam en het aantal treffers af, nooit een waarde. Exit 1 bij een treffer, of als er geen enkel geheim gecontroleerd is. Draai het met de omgeving van de service (zie het runbook).

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

**Bewust anders dan productie:** geen authenticatie en geen Postgres-FTS. Zoeken is woordherkenning: de inhoud, titel en slug worden in kleine letters geknipt op alles wat geen letter of cijfer is, en een term telt bij een heel woord. Alle termen moeten erin staan; `OR` tussen twee termen maakt er "een van beide" van (`a b OR c` is: a, en b of c); `-term` sluit uit; een frase tussen aanhalingstekens vraagt de woorden direct achter elkaar, en een term met leestekens erin zoals `tool-calling` ook. De score is het aantal treffers, bij gelijke score beslist de slug. De snippet is de tien woorden rond de eerste treffer, met `<<` en `>>` om de treffer. `related_product_docs` leest `[tekst](pad.md)` en `[tekst](pad.md#anker)`, opgelost ten opzichte van de folder van het document of als `docs/<folder>/<bestand>.md`; een link naar een `.md` die niet in de set zit staat onder `broken_links`. Een link naar het document zelf wordt overgeslagen in plaats van, zoals in het origineel, als gebroken gemeld. Een href naar een `.md` onder paden die het origineel negeert (zoals `/lib/` of `/app/`) telt hier wel mee en staat onder `broken_links` als het doel niet in de set zit. Het antwoord van `get_product_doc` blijft binnen de tool-uitvoergrens van de harness (`TOOL_OUTPUT_LIMIT`, 16 384 bytes, gemeten aan de geserialiseerde JSON): is het gevraagde stuk groter, dan levert de server het grootste stuk dat past en zet hij `truncated` en `next_offset` zoals het origineel bij `max_chars` doet, zodat paging met `offset` het hele bestand geeft (een sectie met `heading` wordt dan afgekapt zonder `next_offset`, net als bij `max_chars`).

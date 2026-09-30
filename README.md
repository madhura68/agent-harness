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

Draait vier vaste stappen met een dummy-tool `echo` en schrijft `runs/probe-<model>/probe.json` met `tool_calling: reliable | unreliable | none`. Exit 0 alleen bij `reliable`. Opties: `--api-key-env <VAR>` leest een API-key uit de omgeving, `--step-timeout <sec>` (standaard 120).

## Een run uitvoeren

```bash
harness run examples/answer.json --out runs/
SCRUM4ME_TOKEN=… DATABASE_URL=… harness run examples/sprint-summary.json --out runs/
```

Elke run schrijft `runs/<id>/trace.jsonl`, `runs/<id>/tools/<callId>.txt` en `runs/<id>/result.json`. Een run-id is eenmalig; een bestaande run-dir wordt geweigerd. Exit 0 alleen bij `completed`; anders `failed`, `budget_exceeded` of `timed_out` met exit 1.

Het profiel `tools` weigert met `PROBE_REQUIRED` zolang er geen `probe.json` met `reliable` is voor hetzelfde `baseUrl` en model in de `--out`-map. `--skip-probe` omzeilt dat bewust en wordt in de trace vastgelegd.

Secrets horen in de omgeving, niet in het manifest: `tools.server.env` gebruikt `${VAR}`-verwijzingen die pas op weg naar het MCP-kindproces worden ingevuld. Het kindproces krijgt alleen `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` plus wat het manifest noemt. `model.apiKey` en de env-waarden komen nooit in trace of `result.json`.

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

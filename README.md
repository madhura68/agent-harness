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

Elke claim krijgt een eigen run-dir `runs/job-<jobId>-<epoch-ms>/`. `--once` stopt na één claim of één lege wachtronde. Ctrl-C rondt een lopende job af als `failed` ("worker gestopt"); een tweede Ctrl-C breekt direct af. Dezelfde probe-gate als `harness run` geldt.

Ontwerp en plan: [docs/specs/2026-09-26-idea-chat-local-llm-design.md](docs/specs/2026-09-26-idea-chat-local-llm-design.md), [docs/plans/M2-idea-chat-local-llm.md](docs/plans/M2-idea-chat-local-llm.md). Recept en praktijkbewijs: [docs/runbooks/idea-chat-worker.md](docs/runbooks/idea-chat-worker.md).

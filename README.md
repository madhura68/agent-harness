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

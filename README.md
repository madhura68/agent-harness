# agent-harness

Standalone agent-harness v0: een CLI die een lokaal (OpenAI-compatibel) model zoals Ollama op max2 test op betrouwbare toolcalling en één run uit een manifest uitvoert. Profielen `answer` (zonder tools) en `tools` (read-only scrum4me-MCP via een allowlist), elk met een trace en `result.json`.

Ontwerp: [docs/specs/2026-09-26-agent-harness-v0-design.md](docs/specs/2026-09-26-agent-harness-v0-design.md).

```bash
harness probe --base-url http://<max2>:11434/v1 --model <naam> --out runs
harness run examples/sprint-summary.json --out runs/
```

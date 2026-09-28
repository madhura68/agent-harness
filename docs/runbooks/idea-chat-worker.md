---
title: "IDEA_CHAT-worker op Ollama (max2): recept en praktijkbewijs"
status: active
last_updated: 2026-09-27
---

# IDEA_CHAT-worker op Ollama (max2)

Recept voor `harness worker` en het live bewijs van M2 ([spec](../specs/2026-09-26-idea-chat-local-llm-design.md), [plan](../plans/M2-idea-chat-local-llm.md)).

Sinds M3 kan dezelfde worker ook `TASK_IMPLEMENTATION`-jobs met `required_capability: 'local_llm'` claimen (een `task`-blok in de config); zie [task-worker.md](task-worker.md) voor dat recept, de faalredenen en de volgorde-eis.

## Voorwaarden

1. **scrum4me-mcp met de `local_llm`-isolatie.** De worker draait zijn MCP-kindproces uit `~/Development/scrum4me-mcp-stable`. Die checkout moet de M2-MCP-wijziging bevatten (claimfilter + `chat.pending_user_message_ids`); zonder isolatie claimt een `['local_llm']`-worker via het generieke filter ook gewone jobs. Na de merge: `git -C ~/Development/scrum4me-mcp-stable pull --ff-only && npm --prefix ~/Development/scrum4me-mcp-stable ci`.
2. **Tunnel naar max2:** `ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2`. Controleer vóór een proef met `curl -s http://127.0.0.1:11434/api/tags` of het model nog op max2 staat (qwen3-coder:30b was op 2026-09-27 verwijderd) en met `api/ps` welk model geladen is (`OLLAMA_MAX_LOADED_MODELS=1`: een ander model betekent een swap en een trage eerste beurt).
3. **Probe:** `runs/probe-<model>/probe.json` met `tool_calling: reliable` voor het model uit de config (`harness probe --base-url http://127.0.0.1:11434/v1 --model qwen3.8-gsq-rco:27b-iq3_s-text --out runs`). Een ander model = eerst een nieuwe probe.
4. **Omgeving:** `SCRUM4ME_TOKEN`, `DATABASE_URL`, `DIRECT_URL` in de shell (dezelfde als de scrum4me-MCP van de Mac). Waarden nooit in config, trace of dit runbook.

## Productie: service op max2 (sinds 2026-09-27)

De worker draait als systemd-service op max2, naast Ollama: geen tunnel, altijd aan.

| Onderdeel | Waar |
|---|---|
| Unit | `/etc/systemd/system/agent-harness-worker.service` (`User=janpeter`, `Restart=always`, `RestartSec=30`, `KillSignal=SIGINT`, `KillMode=mixed` — stuurt SIGINT alleen naar het hoofdproces (niet naar de nog-lopende stdio-MCP-kind, die geen SIGINT-handler heeft) en pas ná diens exit stuurt systemd SIGKILL naar de rest van de control group, `TimeoutStopSec=180` — geeft het hoofdproces ruim baan om na SIGINT nog af te ronden (git/verify-stappen) vóórdat systemd alsnog SIGKILLt, na `ollama.service`) |
| Code | `~/Development/agent-harness` (gebouwd: `dist/cli.js`) en `~/Development/scrum4me-mcp-stable` (MCP-kindproces via `tsx`) |
| Config | `/etc/agent-harness/worker.json`: model `qwen3.8-gsq-rco:27b-iq3_s-text`, baseUrl `http://127.0.0.1:11434/v1`, thinking aan, `maxTurns 8`, `maxOutputTokens 4096`, `contextTokens 65536`, gelijk aan `OLLAMA_CONTEXT_LENGTH` in `/etc/systemd/system/ollama.service.d/override.conf` (zie [contextvenster](probe-and-run-max2.md#contextvenster-en-lange-beurten) en [meetproef](probe-and-run-max2.md#meetproef-contextvenster-2026-09-27)). Pas de twee altijd samen aan |
| Secrets | `/etc/agent-harness/worker.env` (root, 0600): `SCRUM4ME_TOKEN` = eigen token `agent-harness-local-llm-max2`; `DATABASE_URL`/`DIRECT_URL` = beperkte worker-rol uit `worker-idea.env` |
| Runs en probe | `/var/lib/agent-harness/runs/` (probe voor het model moet hier staan) |

Beheer:

```bash
sudo systemctl status agent-harness-worker
journalctl -u agent-harness-worker -f
sudo systemctl restart agent-harness-worker   # SIGINT: lopende job → failed "worker gestopt"
```

Bijwerken na een merge (op max2; `git` vraagt de Forgejo-PAT, er is geen credential helper):

```bash
cd ~/Development/agent-harness && git pull --ff-only && npm ci && npm run build
cd ~/Development/scrum4me-mcp-stable && git pull --ff-only && git submodule update --init && npm ci   # alleen bij MCP-wijzigingen
sudo systemctl restart agent-harness-worker
```

Ander model: eerst `node dist/cli.js probe --base-url http://127.0.0.1:11434/v1 --model <naam> --out /var/lib/agent-harness/runs`, dan `worker.json` aanpassen en herstarten. Zonder `reliable`-probe start de worker niet (`PROBE_REQUIRED`).

Bewijs: job `cmujtwnbj001qvz7rn2ytmgct` (IDEA-224, 2026-09-27 13:02) DONE in 12 s door de service (token `agent-harness-local-llm-max2`, `model_id qwen3.8-gsq-rco:27b-iq3_s-text`); beantwoordde beide openstaande berichten, ook dat van de eerder mislukte beurt.

Aandachtspunten: het token is (nog) niet op Agent-harness gescopet; de MCP logt `MaxListenersExceededWarning` door een listener-lek in `wait_for_job` (ISS-8 op scrum4me-mcp, onschadelijk).

## Lokaal draaien (Mac, ontwikkeling)

Vereist de tunnel en de omgeving uit de voorwaarden hierboven.

```bash
npm run dev -- worker --config examples/worker.json --out runs          # doorlopend
npm run dev -- worker --config examples/worker.json --out runs --once   # één claim of één lege wachtronde
```

Draai lokaal niet tegelijk met de service zonder reden: beide claimen dezelfde jobs.

Stoppen: Ctrl-C (lopende job → `failed` "worker gestopt"; een al voltooid antwoord wordt nog als `done` afgesloten). Een tweede Ctrl-C breekt direct af: een lopende job blijft dan op RUNNING tot de lease-reset (≤ 5 minuten) hem terugzet.

Vangnet: krijgt de worker toch een andere soort dan IDEA_CHAT, of een IDEA_CHAT-payload zonder `chat.pending_user_message_ids`, dan draait `scrum4me-mcp-stable` niet de M2-versie. De worker sluit die ene job af als `failed` en stopt met exit 1, zodat hij niet de hele queue leegtrekt. Werk dan eerst voorwaarde 1 bij.

## Uitzetten

1. Leeg `IDEA_CHAT_LOCAL_PRODUCT_IDS` in de env van de web-app en herstart die. Nieuwe chatbeurten gaan dan weer naar de gewone vloot.
2. Stop de service (`sudo systemctl disable --now agent-harness-worker`) pas nadat de `local_llm`-jobs op zijn. Jobs die al met `local_llm` op QUEUED/CLAIMED staan, worden niet omgerouteerd. Omdat een idee maar één actieve chatjob tegelijk heeft, blokkeert zo'n job verdere beurten in dat idee. Laat de worker draaien tot ze op zijn, of annuleer ze op het jobs-board.

## Bekende grens

De copilot-tool `send_idea_chat_message` (scrum4me-mcp) maakt IDEA_CHAT-jobs zonder `required_capability`. Een bericht via de copilot op een idee in een gerouteerd product gaat dus naar de gewone vloot, en een vervolgbeurt van zo'n job erft geen `local_llm`. Buiten M2; alleen berichten via de web-chat worden gerouteerd.

## Praktijkbewijs (2026-09-27)

Opstelling: scrum4me-mcp-stable op `16a527a` (bevat mcp#159), web op thuis.jp-visser.nl op `773381cb` (bevat Scrum4Me#263) met `IDEA_CHAT_LOCAL_PRODUCT_IDS=cmuhjw9e80003mt7rq4w3sauu`, harness op main `1b712e2`. Model: `qwen3.6:35b-a3b-coding` (qwen3-coder:30b stond niet meer op max2; JP koos dit model). Probe: 4/4 PASS, `tool_calling: reliable`, `usage_reported: true`. Testidee IDEA-224 in Agent-harness.

| Criterium | Proef | Uitkomst |
|---|---|---|
| 1 routering | Chat op IDEA-224 (Agent-harness) en op IDEA-213 (Scrum4Me) | IDEA-224 → jobs met `required_capability = local_llm`; IDEA-213 → job `cmujqitj6000qvz7r9mlimq9i` met `NULL` ✔ |
| 2 antwoord | Worker doorlopend, bericht "Welke product-docs zijn er voor dit product?" | Job `cmujq9cpv000dvz7roku6o622` DONE in 18 s, `model_id = qwen3.6:35b-a3b-coding`, tokens 3384/635 (provider_reported), 1 toolcall `list_product_docs` met de echte product-id; antwoord in het kanaal ✔ |
| 3 vervolgbeurt | Tweede bericht tijdens de eerste beurt | Vervolg-job `cmujq9r620002vz173lxqb9g8` (coalescing, erft `local_llm`), payload noemt alleen het tweede bericht onder "Te beantwoorden"; DONE in 17 s, tokens 1632/1259 ✔ |
| 4 isolatie | `--once`, `waitSeconds: 180`, terwijl gewone IDEA_CHAT-job `cmujqitj6…` (NULL-capability) op QUEUED stond | Exit 0, "0 job(s)": de lokale worker liet de gewone job liggen ✔ |
| 5 faalpad | Configkopie met `maxWallSeconds: 1`, `--once` | Job `cmujqfyml000mvz7r0scz1dli` FAILED met `timed_out: geen antwoord binnen maxWallSeconds=1`, niets op RUNNING, exit 1 ✔ |
| 6 secrets | Scan van `runs/` op het token en `postgres://` | 0 treffers ✔ |

Presence: tijdens de run staat er een `claude_workers`-rij met hostname van de Mac en capabilities `['local_llm']`, runtime CLAUDE.

Trace-fragment (job 1, ingekort):

```
run_start   job={jobId: cmujq9cpv000dvz7roku6o622, ideaId: cmujpsoo50003xj172ljoe1ts}
            prompt … "## Te beantwoorden\n[USER] Welke product-docs zijn er voor dit product?"
turn 1      usage 1338 in / 222 out → tool_call list_product_docs {"product_id":"cmuhjw9e80003mt7rq4w3sauu"}
turn 2      usage 2046 in / 413 out → eindantwoord
result.json status completed, reported qwen3.6:35b-a3b-coding, 18222 ms
```

Promptgrootte (spec §10): de grootste beurt was 2046 inputtokens, ruim binnen `OLLAMA_CONTEXT_LENGTH=32768`. Begrenzen van de geschiedenis is nog niet nodig.

Kwaliteit: het tweede antwoord stelt dat de docs "meestal onder `docs/`" in de repo staan zonder dat te controleren (geen toolcall). Zichtbaar zwakker dan Claude, zoals spec §10 verwacht.

Nevenbevinding: de CLAUDE-vloot op scrum4me-server en max2 draait een te oude Claude Code (2.1.197) voor het jobmodel; gewone jobs pendelen daardoor tussen CLAIMED en QUEUED (ISS-36). De web-uitrol liep daarom rechtstreeks via de ops-agent-flow `update_scrum4me_web` in plaats van via een DEPLOY-job. Raakt de lokale worker niet.

## Modelkeuze (2026-09-27, TEI uit)

Uitgangspunt: benchmark in `janpeter/max2` PR #13 (`llm-bench/results/`). Met TEI aan is `qwen3.6:35b-a3b-coding` (MoE) de enige snelle optie; met TEI uit past `qwen3.8-gsq-rco:27b-iq3_s-text` (dense, ~12 GB) volledig op de GPU. Beide halen de harness-probe (`reliable`, 4/4).

Vergelijking: de drie echte beurten van IDEA-224 opnieuw afgespeeld (zelfde prompt, zelfde doc-tools, alleen lezen), 2× per model per instelling. Bronnen: `runs/cmp-out/cmp-*` (thinking aan) en `runs/cmp-out/cmpn-*` (`reasoningEffort: none`), lokaal.

| | qwen3.6, thinking aan | GSQ-RCO, thinking aan | qwen3.6, thinking uit | GSQ-RCO, thinking uit |
|---|---|---|---|---|
| Voltooid | 4/6 (2× `budget_exceeded`: 2048 tokens verborgen thinking, lege content) | **6/6** | 6/6 | 6/6 |
| V1 "welke docs?" | juist (toolcall) | juist (toolcall) | **verzonnen**, geen toolcall | juist (toolcall) |
| V2 "staan ze in de repo?" | gok zonder toolcall | **2/2 juist**, 6–8 toolcalls, 33–39 s | **verzonnen** | 1/2 juist, 10–19 s |
| V3 "heb je de scrum4me-mcp?" | redelijk | precies (lezen ja, wijzigen nee) | kort, juist | juist |

Besluit: `examples/worker.json` gebruikt GSQ-RCO IQ3_S-text met thinking aan, `maxTurns: 8` (V2 gebruikte tot 5 beurten) en `maxOutputTokens: 4096` (thinking telt mee; V2 gebruikte tot 1693). `reasoningEffort: none` blijft beschikbaar, maar niet aanbevolen voor deze modellen. TEI blijft voorlopig uit; voor de embeddings wordt een andere oplossing gezocht. Gaat TEI toch weer aan op deze GPU, dan terug naar qwen3.6 (GSQ-RCO zakt naast TEI naar 13–22 tok/s) met thinking aan en ruimer uitvoerbudget, het contextvenster opnieuw meten (64k past dan waarschijnlijk niet meer), en vóór gebruik opnieuw proeven.

---
title: "IDEA_CHAT-worker op Ollama (max2): recept en praktijkbewijs"
status: active
last_updated: 2026-09-27
---

# IDEA_CHAT-worker op Ollama (max2)

Recept voor `harness worker` en het live bewijs van M2 ([spec](../specs/2026-09-26-idea-chat-local-llm-design.md), [plan](../plans/M2-idea-chat-local-llm.md)).

## Voorwaarden

1. **scrum4me-mcp met de `local_llm`-isolatie.** De worker draait zijn MCP-kindproces uit `~/Development/scrum4me-mcp-stable`. Die checkout moet de M2-MCP-wijziging bevatten (claimfilter + `chat.pending_user_message_ids`); zonder isolatie claimt een `['local_llm']`-worker via het generieke filter ook gewone jobs. Na de merge: `git -C ~/Development/scrum4me-mcp-stable pull --ff-only && npm --prefix ~/Development/scrum4me-mcp-stable ci`.
2. **Tunnel naar max2:** `ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2`. Controleer vóór een proef met `curl -s http://127.0.0.1:11434/api/tags` of het model nog op max2 staat (qwen3-coder:30b was op 2026-09-27 verwijderd) en met `api/ps` welk model geladen is (`OLLAMA_MAX_LOADED_MODELS=1`: een ander model betekent een swap en een trage eerste beurt).
3. **Probe:** `runs/probe-<model>/probe.json` met `tool_calling: reliable` voor het model uit de config (`harness probe --base-url http://127.0.0.1:11434/v1 --model qwen3.6:35b-a3b-coding --out runs`). Een ander model = eerst een nieuwe probe.
4. **Omgeving:** `SCRUM4ME_TOKEN`, `DATABASE_URL`, `DIRECT_URL` in de shell (dezelfde als de scrum4me-MCP van de Mac). Waarden nooit in config, trace of dit runbook.

## Starten

```bash
npm run dev -- worker --config examples/worker.json --out runs          # doorlopend
npm run dev -- worker --config examples/worker.json --out runs --once   # één claim of één lege wachtronde
```

Stoppen: Ctrl-C (lopende job → `failed` "worker gestopt"; een al voltooid antwoord wordt nog als `done` afgesloten). Een tweede Ctrl-C breekt direct af: een lopende job blijft dan op RUNNING tot de lease-reset (≤ 5 minuten) hem terugzet.

Vangnet: krijgt de worker toch een andere soort dan IDEA_CHAT, of een IDEA_CHAT-payload zonder `chat.pending_user_message_ids`, dan draait `scrum4me-mcp-stable` niet de M2-versie. De worker sluit die ene job af als `failed` en stopt met exit 1, zodat hij niet de hele queue leegtrekt. Werk dan eerst voorwaarde 1 bij.

## Uitzetten

1. Leeg `IDEA_CHAT_LOCAL_PRODUCT_IDS` in de env van de web-app en herstart die. Nieuwe chatbeurten gaan dan weer naar de gewone vloot.
2. Jobs die al met `local_llm` op QUEUED/CLAIMED staan, worden niet omgerouteerd. Omdat een idee maar één actieve chatjob tegelijk heeft, blokkeert zo'n job verdere beurten in dat idee. Laat de worker draaien tot ze op zijn, of annuleer ze op het jobs-board.

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

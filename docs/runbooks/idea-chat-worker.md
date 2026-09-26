---
title: "IDEA_CHAT-worker op Ollama (max2): recept en praktijkbewijs"
status: draft
last_updated: 2026-09-26
---

# IDEA_CHAT-worker op Ollama (max2)

Recept voor `harness worker` en het live bewijs van M2 ([spec](../specs/2026-09-26-idea-chat-local-llm-design.md), [plan](../plans/M2-idea-chat-local-llm.md)).

## Voorwaarden

1. **scrum4me-mcp met de `local_llm`-isolatie.** De worker draait zijn MCP-kindproces uit `~/Development/scrum4me-mcp-stable`. Die checkout moet de M2-MCP-wijziging bevatten (claimfilter + `chat.pending_user_message_ids`); zonder isolatie claimt een `['local_llm']`-worker via het generieke filter ook gewone jobs. Na de merge: `git -C ~/Development/scrum4me-mcp-stable pull --ff-only && npm --prefix ~/Development/scrum4me-mcp-stable ci`.
2. **Tunnel naar max2:** `ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2`. Controleer vóór een proef met `curl -s http://127.0.0.1:11434/api/ps` welk model geladen is (`OLLAMA_MAX_LOADED_MODELS=1`: een ander model betekent een swap en een trage eerste beurt).
3. **Probe:** `runs/probe-qwen3-coder-30b/probe.json` met `tool_calling: reliable` (`harness probe --base-url http://127.0.0.1:11434/v1 --model qwen3-coder:30b --out runs`).
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

## Isolatieproef (spec-criterium 4)

_Open: draait pas na de merge van de MCP-PR en de update van `scrum4me-mcp-stable`._

## Live E2E (spec-criteria 1–3 en 5)

_Open: na merge en uitrol van MCP, harness en web._

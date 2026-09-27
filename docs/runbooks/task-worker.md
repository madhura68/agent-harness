---
title: "TASK_IMPLEMENTATION-worker op een lokaal model (max2): recept"
status: active
last_updated: 2026-09-28
---

# TASK_IMPLEMENTATION-worker op een lokaal model (max2)

Recept voor `harness worker` met een `task`-blok ([spec](../specs/2026-09-27-task-implementation-local-llm-design.md), [plan](../plans/M3-task-implementation-local-llm.md)). Bouwt voort op [idea-chat-worker.md](idea-chat-worker.md): dezelfde worker, dezelfde `local_llm`-identiteit, nu ook voor `TASK_IMPLEMENTATION`-jobs.

## Voorwaarden

1. **Volgorde-eis (spec §7, bindend):** tot deze harness met een `task`-blok op max2 draait, dispatcht een sessie geen taak met `required_capability: 'local_llm'`. De huidige worker zou hem via het gedeelde `local_llm`-filter claimen, geen `task`-config vinden en de job als `failed` ("worker heeft geen task-config") afsluiten — zonder de idea-chat-jobs te raken, maar zonder de taak ooit uit te voeren.
2. **scrum4me-mcp met de M3-wijziging** (§5): het claimfilter kent `kind = 'TASK_IMPLEMENTATION' AND source = 'COPILOT' AND sprint_run_id IS NULL`, en de MCP doet geen statusdoorwerking (auto-PR, story/PBI/sprint, PBI-cascade) voor `local_llm`-jobs.
3. **Docker op max2**, `janpeter` in de docker-groep, het image (`node:24-bookworm`, volledige variant — de `slim`-variant heeft geen git) eenmalig gepulld.
4. **Forgejo-gebruiker `agent-harness`** met schrijfrecht op de recept-repo's; token als `FORGEJO_PUSH_TOKEN` in het worker-secretsbestand, nooit in de config of dit runbook.
5. **Probe** voor het model uit de config, zoals bij idea-chat.

## Dispatchen en uitlezen

Een sessie dispatcht zoals een gewone `TASK_IMPLEMENTATION`-job, met één toevoeging: `required_capability: 'local_llm'` (spec §5.1, alleen toegestaan bij die soort). Alleen taken op de default-branch komen in aanmerking — een taak die op ongemergd sprintwerk leunt hoort niet in de lokale wachtrij (spec §10). Status lezen gaat via de gewone taak-/jobtools; de taak zelf beheert de harness (`todo` → `in_progress` → `review`), niet de MCP.

## Wat de worker doet (spec §4.3)

1. Payload valideren, snapshot van de git-administratie in de worktree, recept kiezen op `task.repo_url ?? product.repo_url` (normalisatie: slash en `.git` weg, host lowercase). Geen recept → falen zonder dat er iets aan de taak wijzigt.
2. `update_job_status running`, `update_task_status in_progress`, `log_implementation` (start).
3. `prepare`-commando's in een wegwerpcontainer (netwerk aan, npm-cache gemount).
4. Modelloop met de verify-gate: elk eindantwoord van het model draait `recept.verify` in een netwerkloze container; groen → klaar, rood → een nieuwe poging tot `maxVerifyRepairs` keer.
5. Na een groene verify: de git-administratie opnieuw scannen en vergelijken met de snapshot uit stap 1 (ook `node_modules`); pas dan `git add -A` + `git commit --no-verify` met veilige host-git-vlaggen (auteur `agent-harness`).
6. `verify_task_against_plan`; `ALIGNED`/`PARTIAL` gaat door, `EMPTY`/`DIVERGENT` faalt.
7. `log_commit`, `log_test_result PASSED`, `update_job_status done` met de samenvatting en de verify-uitslag.
8. Alleen bij een bevestigde `done` mét `pushed_at`: `update_task_status review`. Wijst de MCP `done` af, of eindigt de job toch als `FAILED` (pushfout), dan stuurt de harness geen tweede terminale update; de taak blijft `in_progress`.

## Faalredenen (letterlijk uit `src/worker/task-impl.ts`)

| Reden | Wanneer |
|---|---|
| `achtergebleven harness-container niet aantoonbaar opgeruimd; geen taak uitgevoerd` | De opruimcontrole vóór de job kon niet bevestigen dat elke `harness-*`-container weg is (zie "Opruimen" hieronder). De taak blijft `todo`: er is niets aan gewijzigd. |
| `worker heeft geen task-config` | Een claim voor `TASK_IMPLEMENTATION` op een worker zonder `task`-blok (voorwaarde 1). |
| `geen recept voor <repo>` | Geen recept matcht `task.repo_url` (of `product.repo_url`) na normalisatie. |
| `prepare faalde (<reden>): <laatste 2000 tekens>` | Een `prepare`-commando faalde, timede uit, of de runner zelf kon niet starten. |
| `verify <n>× rood: <uitvoer>` (code `VERIFY_FAILED`) | Na `maxVerifyRepairs` rode gate-runs; de laatste 6000 tekens output gaan mee. |
| `git-administratie gewijzigd: <items>` | De scan na een groene verify vond een gewijzigd, nieuw of verdwenen `.git`-item (ook onder `node_modules`). Geen commit, geen verdere git-operatie. |
| `model produceerde geen wijzigingen` | `git commit` had niets gestaged. |
| `verify_task_against_plan: <empty\|divergent>` | De plan-check zag geen of tegenstrijdige voortgang. |
| `commit mislukt: <fout>` / `verify_task_against_plan mislukt: <fout>` / `done geweigerd: <fout>` | De bijbehorende MCP-aanroep zelf faalde. |
| `worker gestopt` | SIGINT (systemd-stop) terwijl een stap liep; zie hieronder. |
| `container <naam> niet aantoonbaar gestopt; worker gestopt, systemd herstart hem en de start ruimt achtergebleven containers op` | Zie "Opruimen". |

Elk faalpad na stap 2 killt eerst elke lopende container, scant de git-administratie nog één keer (bestandssysteem, geen git) en zet die uitkomst ("git-administratie gewijzigd" of "ongewijzigd") in de foutmelding. **Draai geen git in een mislukte worktree waarvan die scan "gewijzigd" meldde** — de administratie zelf is dan niet meer te vertrouwen (spec §4.3 stap 9). De worktree blijft staan voor onderzoek.

## Opruimen

`runWorker` ruimt bij het opstarten elke achtergebleven `harness-*`-container op (`docker rm -f`, dan een bevestigende `docker ps`) vóórdat de eerste job — idea-chat of taak — start. Idea-chat wacht hier nooit op; alleen een taakjob controleert opnieuw (zonder de taak aan te raken) en weigert met `achtergebleven harness-container niet aantoonbaar opgeruimd; geen taak uitgevoerd` zolang die controle onzeker blijft.

**Het onzekere pad van Taak 11:** kan een container tijdens een job zelf niet aantoonbaar gestopt worden (een mislukte `docker kill` of een `docker ps` die hem nog toont), dan sluit de harness de job af (of laat hem staan bij een verloren heartbeat) en **stopt de worker met exit 1**. systemd herstart hem (`Restart=always`); de opruimstap bij die herstart probeert de container alsnog weg te krijgen. Blijft dat onzeker, dan weigert elke volgende taakjob met de melding hierboven totdat een handmatige `docker rm -f` of een geslaagde herstart dat oplost.

**SIGINT tijdens een taak:** een stop die vóór de host-commit binnenkomt (stap 5) breekt de lopende stap af, killt een draaiende container en sluit de job af als `failed` ("worker gestopt"); geen git-operatie. Een stop die pas ná de commit binnenkomt laat het groene pad (`verify_task_against_plan`, `done`) nog afmaken — vanaf dat punt maakt de harness geen modelbeurt meer en is de rest kort.

**Open punt voor Taak 13 (setup):** dit gedrag ("stappen 5–8 afmaken na SIGINT") veronderstelt dat het proces zelf het stopsignaal krijgt en de kans krijgt om af te maken. De systemd-unit van de idea-chat-worker gebruikt de standaard `KillMode=control-group`: bij een `stop` krijgt niet alleen dit proces maar ook zijn stdio-MCP-kind het signaal. Of dat "afmaken" in de praktijk lukt (het MCP-kind kan zelf al wegvallen terwijl de harness nog `verify_task_against_plan` of de push-aanroep doet) hangt dus af van de exacte unit-instelling. Dit runbook wijzigt geen unit-bestand; Taak 13 moet dit expliciet meenemen bij het schrijven van de systemd-unit voor deze worker.

## Mergen van een scrum4me-mcp-branch uit een lokale taak

Een scrum4me-mcp-branch van een lokale taak wordt alleen gemerged via een PR met groene CI: het verify-recept sluit tests uit die de git-geschiedenis van de repo nodig hebben (`__tests__/ppe-bundle1-parity.test.ts`, zie Taak 13), en de CI draait alleen op PR's en main — niet op de losse commit die de worker op de host maakt.

## Config (`examples/worker.json`, `task`-blok)

```json
{
  "task": {
    "limits": { "maxTurns": 40, "maxOutputTokens": 80000, "maxWallSeconds": 2400, "maxToolErrors": 8, "contextTokens": 65536 },
    "image": "node:24-bookworm",
    "uid": 1000,
    "gid": 1000,
    "npmCacheDir": "/var/lib/agent-harness/npm-cache",
    "recipes": [
      { "repoUrl": "https://git.jp-visser.nl/janpeter/agent-harness.git", "prepare": ["npm ci"], "verify": "npm run verify" },
      { "repoUrl": "https://git.jp-visser.nl/janpeter/scrum4me-mcp.git", "prepare": ["npm ci", "npm run prisma:generate"], "verify": "npm run typecheck && npm run typecheck:tests && npx vitest run --exclude __tests__/ppe-bundle1-parity.test.ts" }
    ]
  }
}
```

`uid`/`gid` zijn hier `1000`; Taak 13 vervangt ze door de echte waarden van `janpeter` op max2 (eigenaar van de worktree). `mcp.env` krijgt daarnaast `GIT_ASKPASS` (naar [`deploy/max2/forgejo-askpass.sh`](../../deploy/max2/forgejo-askpass.sh)), `GIT_TERMINAL_PROMPT=0`, `FORGEJO_PUSH_TOKEN` (uit de omgeving, nooit een echte waarde in de config), `SCRUM4ME_AGENT_WORKTREE_DIR` en de `SCRUM4ME_REPO_ROOT_*`-variabelen voor de twee recepten (spec §6).

Het askpass-script geeft het token alleen als de prompt `https://git.jp-visser.nl` noemt (username) of `https://agent-harness@git.jp-visser.nl` (wachtwoord); elke andere prompt krijgt niets (exit 1, geen output) — zie [`__tests__/askpass.test.ts`](../../__tests__/askpass.test.ts).

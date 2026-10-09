---
title: "TASK_IMPLEMENTATION-worker op een lokaal model (max2): recept"
status: deprecated
last_updated: 2026-10-09
---

# TASK_IMPLEMENTATION-worker op een lokaal model (max2)

> **Historisch.** De oude dienst is in M45-3 (2026-10-09) van max2 verwijderd. Dit document blijft als recept en bewijs van M2–M4. De huidige dienst staat in [harness-service-max2.md](harness-service-max2.md); lokaal draaien staat in de [README](../../README.md).

Recept voor `harness worker` met een `task`-blok ([spec](../specs/2026-09-27-task-implementation-local-llm-design.md), [plan](../plans/M3-task-implementation-local-llm.md)). Bouwt voort op [idea-chat-worker.md](idea-chat-worker.md): dezelfde worker, dezelfde `local_llm`-identiteit, nu ook voor `TASK_IMPLEMENTATION`-jobs.

## Voorwaarden

1. **Volgorde-eis (spec §7, bindend):** tot deze harness met een `task`-blok op max2 draait, dispatcht een sessie geen taak met `required_capability: 'local_llm'`. De huidige worker zou hem via het gedeelde `local_llm`-filter claimen, geen `task`-config vinden en de job als `failed` ("worker heeft geen task-config") afsluiten — zonder de idea-chat-jobs te raken, maar zonder de taak ooit uit te voeren.
2. **scrum4me-mcp met de M3-wijziging** (§5): het claimfilter kent `kind = 'TASK_IMPLEMENTATION' AND source = 'COPILOT' AND sprint_run_id IS NULL`, en de MCP doet geen statusdoorwerking (auto-PR, story/PBI/sprint, PBI-cascade) voor `local_llm`-jobs.
3. **Docker op max2**, `janpeter` in de docker-groep, het image (`node:24-bookworm`, volledige variant — de `slim`-variant heeft geen git) eenmalig gepulld.
4. **Forgejo-gebruiker `agent-harness`** met schrijfrecht op de recept-repo's; token als `FORGEJO_PUSH_TOKEN` in het worker-secretsbestand, nooit in de config of dit runbook.
5. **Probe** van elke configuratie uit de config (`harness probe --config … --all`), zoals bij idea-chat: de gate per job eist een aanvaarde probe van de huidige hash.

## Dispatchen en uitlezen

Een sessie dispatchte (M3) zoals een gewone `TASK_IMPLEMENTATION`-job; sinds M45 kiest het product de runtime (een `HARNESS`-configuratie) en kent `dispatch_job` geen capability-sleutel meer. Alleen taken op de default-branch komen in aanmerking — een taak die op ongemergd sprintwerk leunt hoort niet in de lokale wachtrij (spec §10). Status lezen gaat via de gewone taak-/jobtools; de taak zelf beheert de harness (`todo` → `in_progress` → `review`), niet de MCP.

**Geen eigen `repo_url` als die gelijk is aan de product-repo.** Heeft de taak een `repo_url`, dan zoekt de MCP een repo-root onder `SCRUM4ME_REPO_ROOT_REPO_<repo-naam>`. Max2 heeft voor agent-harness alleen de product-sleutel `SCRUM4ME_REPO_ROOT_<product-id>`. Een taak met een expliciete agent-harness-`repo_url` faalt daardoor al bij de claim (`geen repo-root voor task.repo_url=… (local_llm vereist een expliciete SCRUM4ME_REPO_ROOT_*)`), zonder run-log. Zo ging het met T-44 op 2026-09-29. Laat `repo_url` leeg, dan gebruikt de MCP `product.repo_url`.

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

**Systemd-stopgedrag voor Taak 13 (setup):** het gedrag hierboven ("stappen 5–8 afmaken na SIGINT") veronderstelt dat het hoofdproces zelf het stopsignaal krijgt en de kans krijgt om af te maken — niet dat zijn stdio-MCP-kind halverwege wegvalt. Met de systemd-default `KillMode=control-group` krijgt bij een `stop` niet alleen dit proces maar tegelijk ook het MCP-kind SIGINT; dat kind heeft geen SIGINT-handler, dus dat kan het middenin `verify_task_against_plan` of de `done`-aanroep raken en breekt dan precies het pad dat dit runbook als "afmaken" beschrijft.

De unit voor deze worker (zie [idea-chat-worker.md](idea-chat-worker.md#productie-service-op-max2-sinds-2026-09-27)) zet daarom:

- **`KillMode=mixed`** — SIGINT gaat alleen naar het hoofdproces; pas ná diens exit stuurt systemd SIGKILL naar de rest van de control group (het MCP-kind). Het MCP-kind blijft dus in leven zolang de harness zelf nog loopt.
- **`TimeoutStopSec=180`** — geeft het hoofdproces ruim baan om na SIGINT de lopende stap af te maken vóórdat systemd alsnog SIGKILLt.

**De harness sluit het MCP-kind zelf ook af, ongeacht de unit.** `cmdWorker` (`src/cli.ts`) doet dit in zijn `finally`: `await conn?.close()` (via `connectStdioClient`, `src/tools/registry.ts`) sluit de MCP-`Client` en de stdio-transport netjes af zodra `runWorker` terugkeert — of dat nu is na een schone afronding of na een SIGINT-afbreekpad. `__tests__/cli-worker.test.ts` ("closes the MCP connection itself before returning") bevestigt dit met een spy op `close()` die los staat van de eigen test-cleanup. Met `KillMode=mixed` is dit een tweede, onafhankelijke garantie bovenop het systemd-gedrag; met de oude `control-group`-default was het de enige garantie, en races tegen systemd's eigen SIGINT naar het MCP-kind waren mogelijk.

**Live stoptest voor Taak 13:** met de echte unit op max2, twee scenario's, telkens met `kill -INT <hoofdproces-pid>` (zie hieronder — niet Ctrl-C in een terminal):
1. **Stop tijdens verify** (vóór stap 5, de host-commit): verwacht de job `failed` met "worker gestopt", de container aantoonbaar weg (`docker ps` leeg voor `harness-*`), en geen git-operatie op de worktree (geen nieuwe commit, geen gewijzigde `.git`-administratie).
2. **Stop ná de commit** (stap 5 al voltooid, tijdens stap 6–8): verwacht dat de job alsnog groen afrondt — `verify_task_against_plan`, `done` en (bij een bevestigde push) `update_task_status review` lopen nog af vóór de worker stopt.

**Ctrl-C in een terminal stuurt SIGINT naar de hele procesgroep** (voorgrondjob), niet alleen naar het hoofdproces — dat wijkt af van hoe systemd een enkel proces signaleert. Test dit stopgedrag daarom met `kill -INT <hoofdproces-pid>` (bijvoorbeeld `kill -INT $(systemctl show -p MainPID --value agent-harness-worker)` op max2), nooit met Ctrl-C in een interactieve shell.

## Inrichting max2 (Taak 13, 2026-09-28)

Stand na de inrichting; geheimen staan alleen in `/etc/agent-harness/worker.env` (root, 0600).

- **Paden:** clones in `/var/lib/agent-harness/repos/{agent-harness,scrum4me-mcp}`, gemaakt met een URL zonder userinfo (`https://git.jp-visser.nl/janpeter/<repo>.git`) en zonder `node_modules` in de clone-root. scrum4me-mcp is gemaakt met `--recurse-submodules`. Worktrees staan in `/var/lib/agent-harness/worktrees/` en de npm-cache in `/var/lib/agent-harness/npm-cache/`, allemaal van `janpeter`. De askpass-helper staat in `/usr/local/lib/agent-harness/forgejo-askpass.sh` (root, 0755). Image: `node:24-bookworm` (node v24.21.0, git 2.39.5).
- **Config:** de backup van de oude config staat in `/etc/agent-harness/worker.json.bak-pre-m3`.
- **Eigen git-config voor het MCP-kind:** `mcp.env` zet `GIT_CONFIG_GLOBAL=/dev/null` en `GIT_CONFIG_NOSYSTEM=1`. `~/.gitconfig` van `janpeter` op max2 heeft een `credential.helper store` met janpeters eigen Forgejo-token. Zonder deze isolatie zou de MCP bij `done` pushen als `janpeter`, niet als de beperkte gebruiker `agent-harness`. Met isolatie is `GIT_ASKPASS` de enige bron van credentials, ook voor de `fetch` bij de claim.
- **Forgejo-gebruiker `agent-harness`** (JP, 2026-09-28): schrijfrecht op agent-harness en scrum4me-mcp, leesrecht op scrum4me-shared; `FORGEJO_PUSH_TOKEN` in `worker.env` en `"FORGEJO_PUSH_TOKEN": "${FORGEJO_PUSH_TOKEN}"` in `mcp.env` (backup `worker.json.bak-pre-pushtoken`). Auth-proef met exact de env van het MCP-kind: `ls-remote` op alle drie de repo's en `push --dry-run` op de twee recept-repo's slagen; met een fout token faalt de push (negatieve controle). Let op: een `${VAR}` zonder waarde laat de worker niet starten (`expandEnv`) — het token moet in `worker.env` staan vóórdat de regel in `mcp.env` komt.
- **Worker-token:** `scoped_products` = `{cmuhjw9e80003mt7rq4w3sauu, cmohrysyj0000rd17clnjy4tc}` (Agent-harness + Scrum4Me), gezet in één transactie op de server-DB.
- **systemd:** drop-in `/etc/systemd/system/agent-harness-worker.service.d/m3.conf` met `KillMode=mixed` en `TimeoutStopSec=180` (`systemctl show`: `KillMode=mixed`, `TimeoutStopUSec=3min`, `KillSignal=2`). Een eerste herstart liet de stop schoon verlopen: `worker klaar — 0 job(s)`, `Deactivated successfully`. Bij een hangende `done`/`verify_task_against_plan` (grens 300 s) SIGKILLt systemd na 180 s. De job loopt dan via de lease-sweep opnieuw; dat is veilig, maar geen groene afronding.
- **scrum4me-mcp-stable bijwerken:** na `git pull --ff-only && npm ci` ook **`git submodule update --init` en daarna `npm run prisma:generate`**. `npm ci` draait de `postinstall` met de oude submodule, schrijft daarmee een verouderd `prisma/schema.prisma` en genereert de client daarop. Het MCP-kind start dan niet (`ERR_MODULE_NOT_FOUND @shared/…`), of de werkkopie blijft vuil. Na de regeneratie is `git status --porcelain` weer leeg. Dit geldt ook op de Mac.

- **Idea-chat-rooktest na de inrichting:** job `cmuklwg9d0009k47r72epkqby` (`IDEA_CHAT`, `local_llm`) geclaimd en `DONE` in ±1 minuut met `qwen3.8-gsq-rco:27b-iq3_s-text`.

### Recept-proef (zonder model)

Uitgevoerd met `runInContainer` uit `dist/` op een tijdelijke worktree op main. Na afloop zijn de worktrees verwijderd.

| Repo | prepare | verify | `git status --porcelain` na afloop | overig |
|---|---|---|---|---|
| agent-harness | groen (3 s, warme cache) | groen (12 s) | leeg | geen `node_modules`-symlink |
| scrum4me-mcp | groen (9–11 s) | groen (82 s) met de uitsluitingen hieronder | leeg | Prisma-client in `node_modules/.prisma/client`; geen `node_modules`-symlink |

`git --version` in een verify-container (`--network none`, worktree gemount): `git version 2.39.5`.

**Uitsluitingen in het scrum4me-mcp-recept.** Elk van deze bestanden faalt uitsluitend omdat de gitdir van de worktree buiten de containermount staat. Git leest de gitlink in de werkmap en stopt met `fatal: not a git repository: /var/lib/agent-harness/repos/scrum4me-mcp/.git/worktrees/<naam>`, ook bij commando's als `git ls-remote <pad>` die geen repo nodig hebben, omdat de tests geen eigen `cwd` meegeven. De gitdir mounten zou de containergrens verbreden en is geen optie. De volledige suite draait in de CI bij de PR.

| Bestand | Falende tests (eerste proef, zonder uitsluiting: 9 rood, 1907 groen) |
|---|---|
| `__tests__/ppe-bundle1-parity.test.ts` | (vooraf uitgesloten) git op de eigen repo-geschiedenis |
| `__tests__/branch-safety.test.ts` | 2× `git ls-remote <tmp>/origin.git` |
| `__tests__/default-branch.test.ts` | 1× `git ls-remote` |
| `__tests__/worktree-branch-safety.test.ts` | 2× `git ls-remote` |
| `__tests__/update-job-status-local-llm-chain.test.ts` | 2× `git config --file <tmp>/…/config` |
| `__tests__/update-job-status-local-llm-done-gitlink.test.ts` | 1× `git config --file …` |
| `__tests__/git/local-llm.test.ts` | 1× `git config --file …` |

Vervolgoptie, niet gedaan: geef in deze scrum4me-mcp-tests `cwd: <tmpdir>` mee aan de git-aanroepen. Dan kunnen de uitsluitingen weer weg.

### Naamfilter en opruimen, live

`runInContainer('verify', …)` met `verifyTimeoutSeconds: 5`, vier keer: één keer `sleep 300` en drie keer een container die eerst 300 MB en 3000 mappen in zijn writable layer schrijft en dan slaapt. Elke keer gaf `docker ps -aq --filter name=^<naam>$` vóór de kill een id en daarna niets, met als resultaat `timedOut: true`, `cleanup: 'stopped'`. Na de timeout duurde de afronding 2,4 s tot 3,7 s. Er bleven geen `harness-*`-containers achter.

## Live acceptatie (Taak 14, 2026-09-28)

Proeftaken onder ST-009 ("M3 live-acceptatie") in sprint S-2026-09-27-1, product Agent-harness. Dispatch met `dispatch_job` en `required_capability: 'local_llm'` via een vers gestart MCP-proces: een sessie waarvan de MCP van vóór de merge is, kent de parameter nog niet (zie Voorwaarden, en herstart de MCP van de dispatchende sessie).

| Criterium (spec §9) | Uitkomst | Bewijs |
|---|---|---|
| **1.** Kleine echte taak in agent-harness | **Gehaald.** T-30 (`normalizeRepoUrl`: host van scp-achtige remotes lowercase, plus 3 testgevallen) geeft job `DONE`. `model_id` is `qwen3.8-gsq-rco:27b-iq3_s-text` en de summary eindigt op de verify-uitslag. Branch `feat/story-253dbps0` @ `874337f`: author, committer en pusher zijn `agent-harness` (Forgejo-activiteit). Geen PR. T-30 staat op `review`; ST-009, PBI-3 en de sprint zijn ongewijzigd. Duur van start tot push: ±1,5 min. | job `cmukmueok00017x17apqdqj1f`; trace `/var/lib/agent-harness/runs/job-cmukmueok00017x17apqdqj1f-1790562774611`: 7 modelbeurten, 8 tool-calls, prepare 2,6 s, 3× verify groen (±12,5 s; 2× via `run_tests` van het model, 1× gate) |
| **2.** Verify kan niet groen worden | **Gehaald.** Recept tijdelijk op `verify: "echo verify-proef-rood; exit 1"` (backup `worker.json.bak-pre-crit2`, daarna teruggezet en herstart). T-31 geeft job `FAILED` met `VERIFY_FAILED verify 3× rood: exitcode 1 verify-proef-rood; git-administratie ongewijzigd`. T-31 blijft `in_progress`. Geen nieuwe commit: branch en worktree blijven op `874337f`. Geen push (`pushed_at` leeg), geen PR, geen doorwerking. Het was een tweede claim op dezelfde story-branch, en de commit van T-30 bleef staan. | job `cmukn0uwc0001bx177r3ojar4`; trace `/var/lib/agent-harness/runs/job-cmukn0uwc0001bx177r3ojar4-1790563075843`: 9 modelbeurten, 3 `after_answer`, `verify-proef-rood` 6× in de trace; geen `harness-*`-container achtergebleven |
| **3.** Isolatie (token, hooks, gitlink) | Open, door JP uit te voeren | — |
| **4.** Tweede claim: prepare-script, `.gitmodules`, host-poorten | Open, door JP uit te voeren | — |
| **5.** Eerste Notes-taak | Buiten dit plan (Notes-sprint) | — |
| **6.** Idea-chat blijft werken | **Gehaald.** Live bericht na de uitrol geeft een `IDEA_CHAT`-job met `local_llm` die `DONE` eindigt in ±1 min met het lokale model; de regressietests zijn groen. | job `cmuklwg9d0009k47r72epkqby` |

## Mergen van een scrum4me-mcp-branch uit een lokale taak

Een scrum4me-mcp-branch van een lokale taak wordt alleen gemerged via een PR met groene CI: het verify-recept sluit tests uit die een werkende gitdir in de worktree nodig hebben (zeven bestanden, zie "Inrichting max2" hieronder), en de CI draait alleen op PR's en main — niet op de losse commit die de worker op de host maakt.

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
      { "repoUrl": "https://git.jp-visser.nl/janpeter/scrum4me-mcp.git", "prepare": ["npm ci", "npm run prisma:generate"], "verify": "npm run typecheck && npm run typecheck:tests && npx vitest run --exclude __tests__/ppe-bundle1-parity.test.ts --exclude __tests__/branch-safety.test.ts --exclude __tests__/default-branch.test.ts --exclude __tests__/worktree-branch-safety.test.ts --exclude __tests__/update-job-status-local-llm-chain.test.ts --exclude __tests__/update-job-status-local-llm-done-gitlink.test.ts --exclude __tests__/git/local-llm.test.ts" }
    ]
  }
}
```

`uid`/`gid` zijn `1000`: dat zijn de echte waarden van `janpeter` op max2 (eigenaar van de worktree; gecontroleerd in Taak 13). `mcp.env` krijgt daarnaast `GIT_ASKPASS` (naar [`deploy/max2/forgejo-askpass.sh`](../../deploy/max2/forgejo-askpass.sh)), `GIT_TERMINAL_PROMPT=0`, `FORGEJO_PUSH_TOKEN` (uit de omgeving, nooit een echte waarde in de config), `SCRUM4ME_AGENT_WORKTREE_DIR`, de `SCRUM4ME_REPO_ROOT_*`-variabelen voor de twee recepten (spec §6), en `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` (zie "Inrichting max2").

Het askpass-script geeft het token alleen als de prompt `https://git.jp-visser.nl` noemt (username) of `https://agent-harness@git.jp-visser.nl` (wachtwoord); elke andere prompt krijgt niets (exit 1, geen output) — zie [`__tests__/askpass.test.ts`](../../__tests__/askpass.test.ts).

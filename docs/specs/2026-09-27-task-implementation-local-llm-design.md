---
title: "Agent-harness M3 — TASK_IMPLEMENTATION-jobs via het lokale model op max2"
status: reviewed
last_updated: 2026-09-27
revision: 5
---

# Agent-harness M3 — TASK_IMPLEMENTATION-jobs via het lokale model op max2

Vervolg op [M2](2026-09-26-idea-chat-local-llm-design.md). Brainstorm met JP op 2026-09-27; alle vier ontwerpsecties goedgekeurd. De werklast voor de eerste echte proef is IDEA-226 "Notes" (product Scrum4Me).

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** een Claude-sessie die een Scrum4Me-sprint uitvoert, kan losse taken uitbesteden aan het lokale model op max2 en krijgt ze terug als geverifieerde branch om te reviewen en in te mergen.

**Eerst bruikbare resultaat:** één echte Notes-taak in scrum4me-mcp (bijvoorbeeld de MCP-tool voor notes) loopt via een `TASK_IMPLEMENTATION`-job door `qwen3.8-gsq-rco:27b-iq3_s-text`, komt groen door de verify-gate, staat als branch op Forgejo, en de sessie merget hem na review in de sprint-branch.

**Welke taak komt in aanmerking.** Een verse story-branch begint op de default-branch van de repo (`wait-for-job.ts` geeft geen `baseRef` mee), niet op de sprint-branch van de sessie; een vervolgclaim op dezelfde story hergebruikt de bestaande story-branch. Een taak komt daarom alleen in aanmerking als hij bouwt en groen verifieert vanaf de default-branch: alles waarvan hij afhangt (voor de notes-tool: het Prisma-schema van Notes, gevendored in scrum4me-mcp) staat daar al. Dit is een planningsregel voor het Notes-plan.

**Niet-doelen:**
- sprint-runs of `SPRINT_BATCH` via het lokale model;
- het managed-dispatch-pad `dispatch_task` (IDEA-213);
- taken die het databaseschema migreren of dependencies toevoegen;
- taken in de Scrum4Me-webrepo (recept uitgesteld, zie §6);
- een sprint-branch als basis van de worktree;
- een UI-knop "lokaal uitvoeren";
- automatische terugval naar Claude als het lokale model faalt (de sessie beslist);
- de hele Notes-feature lokaal bouwen;
- voorrang voor idea-chat boven een lopende taak.

**Zichtbaar bewijs:** de job op het jobs-board (DONE, lokaal model als `model_id`, verify-samenvatting), de branch op Forgejo gepusht door de gebruiker `agent-harness`, de trace, en de merge door de sessie.

## 2. Besluiten

| # | Vraag | Besluit |
|---|---|---|
| 1 | Rol van IDEA-226 | Claude plant Notes via de gewone pipeline; per taak wordt gekozen wat lokaal draait (JP, optie B) |
| 2 | Toewijzing aan het lokale model | Bij het dispatchen: `dispatch_job` krijgt `required_capability: 'local_llm'` (JP, optie A). Reden: Scrum4Me staat op `pr_strategy = SPRINT_BATCH` (één job per sprint-run) en sinds juli draaien Claude-sessies de sprints, niet de vloot |
| 3 | Wanneer is een taak klaar | Harness-gate (verify groen, `verify_task_against_plan` levert `ALIGNED`/`PARTIAL`) plus review door de Claude-sessie vóór de merge (JP, optie A) |
| 4 | Waar draait code uit de repo | Nooit op de host. Verify én voorbereiding (`npm ci`, codegen) draaien in wegwerpcontainers zonder secrets; werktools in de harness op de host, begrensd tot de worktree; host-git zonder hooks (JP koos optie A; review ronde 1 breidde de containergrens uit van alleen verify naar ook voorbereiding) |
| 5 | Push-identiteit | Aparte Forgejo-gebruiker `agent-harness` met schrijfrecht op alleen de benodigde repo's (JP, optie A) |
| 6 | Aanpak | De bestaande worker uitbreiden; één service voor `IDEA_CHAT` en `TASK_IMPLEMENTATION` (JP, aanpak 1) |
| 7 | Status na afloop | De MCP laat bij `local_llm`-taakjobs de normale DONE/FAILED-doorwerking naar story, PBI en sprint en de PBI-fail-cascade achterwege; de harness zet de taak zelf op `review` (groen) of laat hem op `in_progress` (fout) |

## 3. Architectuur en stroom

```
Claude-sessie (Notes-sprint)
  └─ dispatch_job {kind: TASK_IMPLEMENTATION, task_id, required_capability: 'local_llm'}
       → ClaudeJob QUEUED, source COPILOT, required_capability 'local_llm'
agent-harness-worker (max2, systemd)
  ├─ control: wait_for_job → claim (MCP: worktree op feat/story-<id8>, zonder prepare:worktree-hook)
  ├─ heartbeat loopt vanaf de claim tot en met de afsluitende update
  ├─ prepare-container (netwerk, geen env): recept van de repo
  ├─ modelloop: werktools + doc-leestools, contextTokens 65536
  │    └─ run_tests / eindgate → verify-container (--network none, geen env)
  ├─ groen: host-git commit zonder hooks → verify_task_against_plan → update_job_status done
  │        (MCP pusht zonder hooks) → bevestigde DONE → update_task_status review
  └─ fout: update_job_status failed, zonder git in de worktree (geen backup-push); taak blijft in_progress
Claude-sessie
  └─ get_job_status → review diff tegen taak → merge story-branch in sprint-branch, of afwijzen
```

## 4. Harness

### 4.1 Claim, config en control-kanaal

- `src/worker/worker.ts`: de tweede grendel accepteert `IDEA_CHAT` en `TASK_IMPLEMENTATION`. Elke andere soort blijft `ClaimFilterError` (job sluiten, worker stopt met exit 1). Het echte filter zit in de MCP (§5.1).
- `src/worker/config.ts`: nieuw optioneel blok `task`:

```ts
task?: {
  limits: { maxTurns; maxOutputTokens; maxWallSeconds; maxToolErrors; contextTokens }  // voorbeeld 40 / 80000 / 2400 / 8 / 65536
  image: string                 // vast node-image, zelfde major als de host-node (v24)
  uid: number; gid: number      // container-gebruiker = eigenaar van de worktree
  npmCacheDir: string           // host-map, alleen in de prepare-container gemount
  prepareTimeoutSeconds: number // standaard 900
  verifyTimeoutSeconds: number  // standaard 600
  maxVerifyRepairs: number      // standaard 3
  recipes: Array<{
    repoUrl: string             // exacte match op task.repo_url ?? product.repo_url
    prepare: string[]           // in de prepare-container, in de worktree
    verify: string              // in de verify-container
  }>
}
```

  Beide soorten delen de capability `local_llm`, dus een worker zonder `task`-blok kan een taakjob toch claimen. Hij sluit die dan als `failed` ("worker heeft geen task-config"), zonder modelbeurten. Omdat de MCP bij `local_llm` geen statusdoorwerking doet (§5.2), raakt dat de taak niet.
- `src/worker/control.ts`: `CONTROL_TOOLS` en `ControlChannel` krijgen `update_task_status`, `verify_task_against_plan`, `log_implementation`, `log_commit` en `log_test_result`. `updateStatus` geeft de werkelijke uitkomst van `update_job_status` terug (status, branch, `pushed_at`, fout uit het JSON-antwoord), niet alleen "geen `isError`".
- Heartbeat: loopt vanaf de claim, door `prepare` en de modelloop heen, tot en met de afsluitende update.

### 4.2 Werktools (`src/worker/task-tools.ts`)

Een `ToolRegistry` in het harness-proces (geen MCP-kind), gecombineerd met de vier doc-leestools uit M2 tot één registry-view voor het model.

| Tool | Gedrag |
|---|---|
| `list_files {path?}` | recursief, zonder `node_modules` en `.git`, max 300 regels |
| `read_file {path, offset?, limit?}` | met regelnummers; zonder bereik max 20 000 tekens met melding "afgekapt, gebruik offset/limit" |
| `write_file {path, content}` | maakt mappen aan |
| `edit_file {path, old_string, new_string}` | `old_string` moet precies één keer voorkomen |
| `search {pattern, path?}` | regex, max 100 treffers `bestand:regel: tekst` |
| `run_tests {}` | het verify-commando in de verify-container (§4.4); antwoord `ok: true` met exitcode en de laatste 6 000 tekens, ook bij rode tests; `ok: false` alleen als de runner zelf faalt |

Elk pad wordt opgelost via `realpath` van de dichtstbijzijnde bestaande voorouder en moet binnen de worktree vallen. Paden met een segment `.git` zijn verboden. Geen git- of shell-tool voor het model.

### 4.3 Afhandeling per taakjob (`src/worker/task-impl.ts`)

Het model schrijft niets naar Scrum4Me; de harness doet dat deterministisch:

1. Payload valideren (Zod: `task`, `story`, `worktree_path`, `branch_name`, repo-URL). Een snapshot maken van alle git-administratie in de worktree: pad, type en inhoud van elk `.git`-item (het gitlink-bestand van de worktree en de gitlinks van submodules). Recept kiezen; geen recept → `failed` ("geen recept voor <repo>").
2. `update_job_status running`, `update_task_status in_progress`, `log_implementation` (start).
3. `prepare`-commando's in de prepare-container (§4.4). Faalt er een → `failed` met de laatste 2 000 tekens log.
4. Modelloop (§4.4) met de systeemprompt uit de spike plus taak, plan, story en acceptatiecriteria als data.
5. Na groene verify (er draait dan geen container meer): de git-administratie opnieuw scannen, ook in `node_modules`, en vergelijken met de snapshot; een gewijzigd, nieuw of verdwenen `.git`-item → `failed` ("git-administratie gewijzigd"), zonder verdere git-operatie. Dan met veilige host-git (§4.5) `git add -A` en `git commit --no-verify` met auteur `agent-harness` en de taaktitel als boodschap. Geen gestagede wijzigingen → `failed` ("model produceerde geen wijzigingen").
6. `verify_task_against_plan`. `ALIGNED`/`PARTIAL` → verder; `EMPTY` of `DIVERGENT` → `failed` met die reden.
7. `log_commit`, `log_test_result PASSED`, `update_job_status done` met summary = eindantwoord van het model (ingekort) plus de verify-uitslag.
8. Alleen als het antwoord een bevestigde DONE met `pushed_at` is: `update_task_status review`. Weigert de MCP `done` (verify-gate) of eindigt de job als FAILED (pushfout): de harness stuurt niet nogmaals een terminale update als de job al terminaal is; anders `update_job_status failed` met de weigeringstekst. De taak blijft `in_progress`.
9. Elk faalpad na stap 2 (prepare-fout, rode verify, budget, timeout, stop, gewijzigde git-administratie, geweigerde `done`): eerst elke lopende container killen; dan `log_test_result FAILED` waar van toepassing en `update_job_status failed` met leesbare reden. De harness doet op deze paden geen enkele git-operatie, en de MCP ook niet (§5.3). Na het killen van de containers draait de harness de scan nog één keer (alleen bestandssysteem, geen git) en zet de uitkomst in de foutmelding: "git-administratie ongewijzigd" of "gewijzigd". De worktree blijft staan voor onderzoek; draai geen git in een mislukte worktree waarvan de scan "gewijzigd" meldde (ook in de runbook). Een commit bestaat alleen na een groene verify en een geslaagde scan (stap 5); faalt daarna nog iets, dan staat die commit op de story-branch in de clone en neemt de volgende claim op die story hem mee. De taak blijft `in_progress`; wil de sessie opnieuw dispatchen, dan zet ze hem op `todo` (API-spelling).

**Stoppen:** verlies van eigenaarschap → zoals M2: niet afsluiten, de lease-sweep zet de job terug in de wachtrij. SIGINT (systemd-stop) tijdens een taak → de lopende stap afbreken, de verify-container killen, `update_job_status failed` ("worker gestopt"), taak `in_progress`. Idea-chat houdt het bestaande M2-gedrag.

### 4.4 Containers en de verify-lus

- **Prepare-container:** `docker run --rm --cpus 8 --memory 8g --user <uid>:<gid> -v <worktree>:<worktree> -v <npmCacheDir>:/npm-cache -e npm_config_cache=/npm-cache -w <worktree> <image> sh -c "<prepare-commando's>"`. Netwerk aan (npm-registry), verder geen env, geen andere mounts, harde timeout.
- **Verify-container:** hetzelfde zonder npm-cache-mount en met `--network none`, harde timeout (`verifyTimeoutSeconds`, daarna `docker kill`). Timeout telt als rood.
- Omdat verify geen netwerk heeft, faalt het als het model dependencies toevoegt; dat hoort bij de niet-doelen.
- `src/run.ts` krijgt een optionele haak `afterAnswer(answer): Promise<string | null>`. Geeft het model een eindantwoord, dan roept de loop de haak aan; een string wordt als user-bericht toegevoegd en de loop gaat door binnen dezelfde limieten; `null` sluit af als `completed`. Zonder haak verandert er niets (idea-chat).
- De taak-handler implementeert de haak: verify draaien; groen → `null`; rood → "Verify faalt (poging n van maxVerifyRepairs): <uitvoer>"; na `maxVerifyRepairs` keer rood → de run eindigt als `failed` met code `VERIFY_FAILED`.

### 4.5 Beveiligingsmodel

- **Code uit de repo draait alleen in containers.** Dat geldt voor alles wat het model kan beïnvloeden: `package.json`-scripts, lifecycle-hooks, codegen, tests. Ook bij een hergebruikte story-branch met eerdere, ongereviewde modelcommits.
- **Veilige host-git.** Elke git-aanroep op de host tegen een `local_llm`-worktree (harness én MCP, §5.3) gebruikt `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.ignoreSubmodules=all -c status.submoduleSummary=false -c submodule.recurse=false` en, waar van toepassing, `--no-verify`. De gitdir en config van de repo staan buiten de worktree; de containers kunnen wel gitlinks in de worktree wijzigen (ook van submodules) en daarmee git naar zelfgemaakte administratie met uitvoerbare config laten wijzen. Daarom geldt: **de scan is de controle, de vlaggen zijn een extra laag** (een omgebogen gitlink levert git een complete, door de container gemaakte config, en een vlaggenlijst kan niet alles uitschakelen, bijvoorbeeld `core.sshCommand`). Git draait met de worktree als werkmap alleen op het groene pad, nadat de harness alle `.git`-items tegen de snapshot van de claim heeft gescand (§4.3 stap 1 en 5): harness-commit, `verify_task_against_plan` en de push bij `done`. Op elk ander pad (failed, stop, requeue, opruimen) draait noch de harness noch de MCP git in die worktree (§4.3 stap 9, §5.3).
- **Secrets:** het Forgejo-token en de DB-credentials staan alleen in de env van de worker en het MCP-kind. Werktools, model en containers zien ze nooit; containers krijgen geen `-e` of `--env-file` behalve de npm-cache-variabele.
- **Restrisico:** de prepare-container heeft netwerk en draait mogelijk door het model gewijzigde scripts. Hij heeft geen secrets en alleen de worktree en de npm-cache gemount. Dat Ollama (alleen `127.0.0.1`) en de ops-agent (bearer-token) vanuit de container niet bruikbaar zijn, is een verwachting die acceptatie 4 live bewijst. De npm-cache kan door zo'n script vervuild raken; hij staat apart van de cache van de gebruiker.
- **Trace:** zoals v0/M2, plus events voor `prepare` en elke verify (bron `run_tests`/`gate`, exitcode, duur).

## 5. Wijzigingen in scrum4me-mcp

### 5.1 Dispatch en claim

- `dispatch_job`: optionele `required_capability`, enum `['local_llm']`, alleen toegestaan bij `kind: 'TASK_IMPLEMENTATION'` (anders validatiefout). `dispatchTaskImplementation` schrijft hem op de job (source blijft `COPILOT`).
- Claimfilter: de `local_llm`-tak in `src/dispatch/eligibility.ts` staat nu alleen `kind = 'IDEA_CHAT' AND source = 'SYSTEM'` toe. Hij wordt uitgebreid naar twee combinaties: de bestaande, en `kind = 'TASK_IMPLEMENTATION' AND source = 'COPILOT' AND sprint_run_id IS NULL`. Alle representaties van die tak gaan mee: de string-builder, `claimConditions.capability` (SQL-fragment), de predicate-evaluator en de higher-tier-peer-guard.
- Runtime: de worker registreert als `CLAUDE` en het filter matcht op `cj.runtime`. `dispatchTaskImplementation` schrijft geen runtime; de job krijgt `CLAUDE` via de database-default. De nieuwe lokale dispatch zet `runtime: 'CLAUDE'` expliciet, zodat die koppeling niet van een default afhangt.

### 5.2 Afsluiten zonder doorwerking

Voor `TASK_IMPLEMENTATION` met `required_capability = 'local_llm'` slaat `update_job_status`:
- `maybeCreateAutoPr` over;
- `propagateStatusUpwards` (DONE/FAILED naar taak, story, PBI, sprint en SprintRun) over;
- `cancelPbiOnFailure` over.

Push bij `done`, verify-gate, jobregistratie en tokenvelden blijven. De backup-push bij `failed` (M38) vervalt voor `local_llm` (§5.3). De taakstatus beheert de harness zelf (§4.3).

### 5.3 Worktree en push zonder repo-code

Voor jobs met `required_capability = 'local_llm'`:
- `createWorktreeForJob` roept de `prepare:worktree`-hook niet aan (die draait nu met `exec` in het MCP-proces, met diens env);
- `initSubmodules` (`git submodule update --init --recursive`, host, met de push-credentials) draait alleen als `.gitmodules` in de worktree gelijk is aan die op de default-branch; anders faalt de claim met een leesbare reden. Een door het model gewijzigde submodule-URL kan zo geen andere host laten benaderen;
- de git-aanroepen van de MCP op het groene pad (`getGitDiff` voor `verify_task_against_plan`, `pushBranchForJob` bij `done`, en de `rev-parse`- en `remote set-head`-aanroepen daarin) gebruiken de veilige vlaggen uit §4.5, de push ook `--no-verify`;
- geen git met de worktree als werkmap op de andere paden: `backupPushOnFailure` bij `failed` (`update-job-status.ts:184-199`), `maybeBackupPush` bij rollback en stale-reset/requeue (`wait-for-job.ts:276`, `:595`) worden overgeslagen;
- opruimen van een `local_llm`-worktree: map verwijderen via het bestandssysteem en daarna `git worktree prune` vanuit de clone-root (met de veilige vlaggen); nooit `git worktree remove` of een andere git-aanroep in de worktree zelf;
- de regel zit **in de helpers**, niet bij de aanroepers: `maybeBackupPush` en `removeWorktreeForJob` bepalen zelf aan de hand van de job (capability `local_llm`) of ze git in de worktree mogen draaien, net als de directe `git worktree remove`-aanroepen voor oude bezetters in `worktree.ts` (~218–220, ~271–277). Zo vallen alle aanroepers eronder: `update-job-status.ts` (~140, ~184–199), `wait-for-job.ts` (~276, ~312, ~595), `cancel/pbi-cascade.ts` (~231, ook bij een falende job van een andere soort onder dezelfde PBI) en `cleanup-my-worktrees.ts` (~88, ~101). Selecties die de job ophalen, nemen daarvoor `required_capability` mee.

### 5.4 Tests

Dispatch slaat de capability op en weigert hem bij een andere soort; de lokale worker (`['local_llm']`) claimt een `TASK_IMPLEMENTATION`/`COPILOT`/`local_llm`-job en een IDEA_CHAT-job, maar geen gewone taakjob; een gewone worker claimt de lokale taakjob niet; done en failed met `local_llm` roepen geen auto-PR, geen doorwerking en geen PBI-cascade aan (met een tweede actieve job onder dezelfde PBI die actief blijft); worktree-aanmaak met `local_llm` draait geen `prepare:worktree` en slaat `initSubmodules` over (met foutmelding) als `.gitmodules` afwijkt van de default-branch; diff en push bij `done` met `local_llm` bevatten de veilige vlaggen; `failed`, rollback, stale-reset, PBI-cascade en `cleanup_my_worktrees` met een `local_llm`-job voeren geen git-aanroep uit met de worktree als werkmap (getest via de helpers, zodat alle aanroepers gedekt zijn); de lokale dispatch zet `runtime` expliciet op `CLAUDE`.

## 6. Inrichting max2 (serveracties, op JP's go)

- Forgejo-gebruiker `agent-harness` met schrijfrecht op scrum4me-mcp en agent-harness, en leesrecht op scrum4me-shared (submodule van scrum4me-mcp); token in `/etc/agent-harness/worker.env` als `FORGEJO_PUSH_TOKEN`. De worker-config geeft het MCP-kind `GIT_ASKPASS=<script>` en het token; git-identiteit `agent-harness`. Het askpass-script geeft het token alleen als de prompt `https://git.jp-visser.nl` noemt, en anders niets.
- `scoped_products` van het worker-token wordt `{Agent-harness (cmuhjw9e80003mt7rq4w3sauu), Scrum4Me (cmohrysyj0000rd17clnjy4tc)}`: Agent-harness staat er al in (acceptatie 1), Scrum4Me komt erbij (Notes).
- Verse clones in `/var/lib/agent-harness/repos/`, zonder `node_modules` in de clone-root (de MCP symlinkt die anders in elke worktree, naar een pad dat de containers niet zien; de recept-proef controleert dit); worktrees in `/var/lib/agent-harness/worktrees/` via `SCRUM4ME_AGENT_WORKTREE_DIR`. Repo-roots via `SCRUM4ME_REPO_ROOT_<productId>` (product) en `SCRUM4ME_REPO_ROOT_REPO_<repoName>` (taak met `task.repo_url`, zoals scrum4me-mcp).
- Image eenmalig pullen; `uid`/`gid` van `janpeter` en een eigen npm-cachemap in de config.
- Recepten (exacte commando's in het plan, na een recept-proef op max2): agent-harness (`npm ci` / `npm run verify`) en scrum4me-mcp (`npm ci` met Prisma-generate / `npm run typecheck && npm test`). **Scrum4Me-web is uitgesteld**: husky, submodule, Prisma en `postinstall` maken dat recept het lastigst, en geen van de acceptatiecriteria heeft het nodig.

## 7. Uitrol en bouwvolgorde

1. MCP-PR (§5) en harness-PR (§4), beide door JP gemerged.
2. Inrichting max2 (§6) op JP's go. Alleen de MCP-checkouts die de nieuwe code nodig hebben gaan mee: `scrum4me-mcp-stable` op max2 (MCP-kind van de lokale worker: claim, afsluiten, push) en op de Mac (`dispatch_job` van de sessie). De vloot slaat `local_llm`-jobs al over en hoeft niet mee. Recept-proef per repo met een lege worktree op main (prepare + verify groen, geen `node_modules`-symlink).
   **Volgorde-eis:** tot de nieuwe harness op max2 draait, wordt geen taak met `local_llm` gedispatcht. De huidige M2-worker zou hem na de filterwijziging claimen, zijn tweede grendel slaan en met exit 1 stoppen, en dan ligt idea-chat stil.
3. Acceptatie 1–4 (§9). Pas daarna dispatcht een sessie echte taken met `local_llm`.
4. Notes (IDEA-226) via de gewone pipeline: spec, plan, ceremonie, met de planningsregel uit §1. De eerste lokale taak is acceptatie 5.

## 8. Tests (zonder netwerk)

- Werktools: padbegrenzing (`..`, absoluut pad, symlink naar buiten, `.git`-segment), `edit_file` uniek/niet-uniek, `read_file` met bereik en afkapmelding, `list_files` slaat `node_modules` over.
- `run.ts`: `afterAnswer` rood → verder → groen; 3× rood → `failed`/`VERIFY_FAILED`; zonder haak ongewijzigd gedrag; een rode `run_tests` telt niet als toolfout.
- Container-runner: gebouwde `docker`-argumenten voor prepare (netwerk, npm-cache, geen andere env) en verify (`--network none`, geen `-e`/`--env-file`); timeout → rood (injecteerbare process-runner).
- Host-git tegen een echte tijdelijke repo (niet alleen gebouwde argumenten): een gewijzigd bestaand bestand én een nieuw bestand komen in de commit; een gewijzigde gitlink van de worktree of van een submodule, een nieuw `.git`-item of een verdwenen submodule-gitlink geeft `failed` vóór enige git-aanroep; met een submodule-gitlink die naar administratie met `core.fsmonitor`-marker wijst, draait de marker niet (regressietest van het ronde-2-bewijs).
- Keten harness → echte MCP-handler `update_job_status failed` → backup/opruimen, met een omgebogen worktree-gitlink naar administratie met een `core.sshCommand`- en `core.fsmonitor`-marker: de marker ontstaat nooit.
- Taak-handler tegen nep-control en nep-model: volgorde van control-aanroepen op het groene pad; elk faalpad uit §4.3 met de juiste job- en taakstatus; `done` geweigerd; `done` die als FAILED terugkomt (pushfout) zet de taak niet op `review`; SIGINT tijdens de modelloop.
- Worker: claimfilter accepteert beide soorten; een taakjob zonder `task`-config → `failed`; idea-chat-regressie.

## 9. Acceptatiecriteria

1. Een kleine echte taak in agent-harness, gedispatcht met `local_llm`: job DONE met lokaal `model_id` en verify-samenvatting, branch gepusht door `agent-harness`, geen PR, taak op `review`, story/PBI/sprint ongewijzigd (live).
2. Een taak waarvan verify niet groen kan worden: job FAILED met de verify-uitvoer, taak `in_progress`, geen PR, geen doorwerking naar story/PBI/sprint (live).
3. Isolatie: een proef-verify met `env` en een netwerkaanroep toont geen token en een mislukte verbinding; een door de proeftaak gewijzigde `.husky/pre-commit` met een onschuldige marker draait niet bij de host-commit; een door de container omgebogen submodule- of worktree-gitlink laat de job falen zonder dat er daarna nog git in de worktree draait, ook niet via de MCP (live, met marker).
4. Tweede claim op dezelfde story-branch: de door de eerste job gecommitte wijziging aan een `prepare`-script draait alleen in de prepare-container, niet op de host; een door de eerste job gewijzigde `.gitmodules` laat de tweede claim falen zonder submodule-init; vanuit de prepare-container zijn de Ollama-poort en de ops-agent op de host-gateway niet bereikbaar (weigering vastgelegd) (live, met markers).
5. De eerste Notes-taak in scrum4me-mcp: de sessie reviewt de branch en merget hem in de Notes-sprint-branch (live).
6. Idea-chat blijft werken (regressietest en één live bericht).

## 10. Risico's en open punten

- **Modelkwaliteit:** de spike haalde 7/9 op kleine taken; echte Notes-taken zijn groter. Mitigatie: taken klein snijden, verify-gate, review door de sessie.
- **Basis op de default-branch:** taken die op ongemergd sprintwerk leunen komen niet in aanmerking (§1). Een sprint-branch als `baseRef` is een latere uitbreiding.
- **Doorlooptijd:** één job tegelijk; een taak (tot 40 minuten) houdt idea-chat op.
- **GPU-delen:** TEI blijft uit; een toekomstige embedding-job moet de GPU vrijmaken of elders draaien.
- **Docker-groep:** `janpeter` in de docker-groep is root-equivalent op max2; alleen de harness roept docker aan, nooit het model.
- **Scrum4Me-web:** uitgesteld tot een eigen recept-proef bewijst dat verify in een verse worktree groen is.

## Review record

### Ronde 1 — revisie 1 (`93433aa`), 2026-09-27

- **Reviewers:** `mac:claude` NO-GO (3 BLOCKER / 2 MAJOR / 4 MINOR), `mac:codex` NO-GO (4 BLOCKER / 2 MAJOR / 2 MINOR).
- **Convergent, geaccepteerd en bevestigd in de tree:**
  - claimfilter `local_llm` staat alleen `IDEA_CHAT`/`SYSTEM` toe (`eligibility.ts:83-96`, ook SQL-fragment, predicate en peer-guard) → §5.1 breidt uit, positieve claimtest;
  - `update_job_status` werkt voor COPILOT-taakjobs door naar story/PBI/sprint en draait bij FAILED de PBI-cascade (`update-job-status.ts:1304-1314`, `:1607`) → §5.2 slaat beide over, harness beheert de taakstatus;
  - host-commit en MCP-push draaien git-hooks (husky) → hooks uit voor host-git (§4.3 stap 5, §5.3), gitlink-controle, acceptatie 3;
  - voorbereiding kan ongereviewde branchcode op de host draaien, ook via `prepare:worktree` in het MCP-proces (`worktree.ts:34`) → prepare in een container (§4.4), MCP slaat de hook over (§5.3), acceptatie 4.
- **Enkelvoudig, geaccepteerd:** basis op de default-branch als planningsregel (claude, MAJOR → §1, §10); geweigerde of als FAILED teruggekomen `done` (claude MINOR + codex MAJOR → §4.1, §4.3 stap 8); control-kanaal en heartbeat (claude MINOR → §4.1); rode `run_tests` geen toolfout (claude MINOR → §4.2); runtime `CLAUDE` en env-namen (claude MINOR → §5.1, §6); stoppen versus eigenaarschap (codex MINOR → §4.3); startlog en API-spelling `todo` (codex MINOR → §4.3).
- **Afgewezen, ter beoordeling in ronde 2:** codex MAJOR "SKIPPED-pad ontbreekt". In deze route dispatcht alleen de sessie zelf, één taak tegelijk, en werkt ze niet parallel aan dezelfde taak; "al aanwezig op main" is geen realistisch pad. Met §5.2 heeft een FAILED zonder wijzigingen geen doorwerking meer: de taak blijft `in_progress` en de sessie kijkt. Een betrouwbaar "al aanwezig"-bewijs vergt meer dan een lege diff (codex zegt dat zelf) en voegt een pad toe zonder concreet faalgeval binnen dit doel.
- **Scope-delta:** Scrum4Me-webrecept uitgesteld (claude-suggestie; geen acceptatiecriterium heeft het nodig) → minder hostrisico; containergrens uitgebreid van alleen verify naar ook prepare (strengere bescherming, zelfde doel); MCP-wijzigingen gegroeid van twee naar vier punten (§5.1–5.3). Eerste bruikbare resultaat en eerste praktijkproef ongewijzigd.

### Ronde 2 — revisie 2 (`ebb1dcb`), 2026-09-27

- **Reviewers:** `mac:claude` NO-GO (0 BLOCKER / 1 MAJOR / 4 MINOR), `mac:codex` NO-GO (2 BLOCKER / 0 MAJOR / 2 MINOR). Ronde-1-reparaties 1, 2, 5, 6, 7 "held" bij beide; 3 en 4 deels.
- **Afgewezen SKIPPED-bevinding:** beide reviewers houden de afwijzing aan; codex trekt zijn MAJOR in voor dit increment.
- **Geaccepteerd en bevestigd in de tree:**
  - codex BLOCKER — code op de host via submodule-git-administratie: containers kunnen een submodule-gitlink (`vendor/scrum4me-shared/.git` in scrum4me-mcp) naar zelfgemaakte administratie met `core.fsmonitor` laten wijzen; `core.hooksPath` en `--no-verify` stoppen dat niet (codex reproduceerde het met synthetische repo's). → snapshot en rescan van alle `.git`-items vóór host-git (§4.3 stap 1 en 5), veilige git-vlaggen voor harness én MCP inclusief `getGitDiff` (§4.5, §5.3), regressietest (§8), live-proef (§9.3);
  - codex BLOCKER — `git add` verdwenen uit stap 5 (regressie in revisie 2) → hersteld, test tegen een echte repo met gewijzigd en nieuw bestand (§8);
  - claude MAJOR — `initSubmodules` draait op de host met push-credentials en een URL uit de branch (`worktree.ts:102-117`) → alleen bij `.gitmodules` gelijk aan de default-branch (§5.3), askpass alleen voor de Forgejo-host (§6), live-proef (§9.4).
- **MINORs geaccepteerd:** hergebruik van de story-branch in de basisregel (codex, §1); runtime via DB-default, lokale dispatch zet `CLAUDE` expliciet (codex, §5.1); clones zonder `node_modules` (claude, §6); netwerkclaim prepare-container live bewijzen (claude, §4.5, §9.4); geen `local_llm`-dispatch vóór de nieuwe harness draait (claude, §7); product-scope met beide producten (claude, §6).
- **Scope-delta:** kleiner in uitrol — alleen de MCP-checkouts op max2 en de Mac, niet de vloot (codex-suggestie, §7). Groter in bescherming: git-administratiescan en veilige git-vlaggen in harness en MCP. Eerste bruikbare resultaat en eerste praktijkproef ongewijzigd.

### Ronde 3 — revisie 3 (`6ff937b`), 2026-09-27

- **Reviewers:** `mac:claude` NO-GO (1 BLOCKER / 0 MAJOR / 1 MINOR), `mac:codex` NO-GO (1 BLOCKER / 0 MAJOR / 0 MINOR). Ronde-2-reparaties: `git add` en submodule-init "held" bij beide, git-administratie "partially held" bij beide.
- **Convergent BLOCKER, geaccepteerd en bevestigd in de tree:** op de faalpaden (failed, stop, requeue) draait de MCP nog git met de worktree als werkmap zonder scan: `backupPushOnFailure` (`update-job-status.ts:184-199`), `maybeBackupPush` bij rollback en stale-reset (`wait-for-job.ts:276`, `:595`), met `remote set-head` en `push`. Codex bewees met een marker dat een omgebogen gitlink naar administratie met `core.sshCommand` ondanks alle §4.5-vlaggen code start. → Voor `local_llm` geen git in de worktree buiten het gescande groene pad: backup-pushes vervallen, opruimen zonder git in de worktree (§4.3 stap 9, §4.5, §5.2, §5.3); de scan is de controle, de vlaggen een extra laag; keten-test met marker (§8) en live-proef (§9.3). Er gaat niets verloren: een commit ontstaat pas na groene verify en scan.
- **MINOR geaccepteerd:** een verdwenen `.git`-item telt ook als afwijking (claude, §4.3 stap 5, §8).
- **Scope-delta:** kleiner — de M38-backup-push en de git-gebaseerde opruiming vallen weg voor `local_llm`; geen nieuw subsysteem. Eerste bruikbare resultaat en eerste praktijkproef ongewijzigd.

### Ronde 4 — revisie 4 (`2cad72e`), 2026-09-27

- **Reviewers:** `mac:claude` **GO** (0 BLOCKER / 0 MAJOR / 2 MINOR), `mac:codex` **GO** (0 / 0 / 0). Ronde-3-reparaties "held" bij beide. Codex bevestigde met een synthetische proef dat bestand verwijderen plus `git worktree prune` vanuit de clone-root geen config uit een omgebogen worktree uitvoert (`marker_created: false`, branch behouden).
- **Na GO verwerkt (MINOR, door de reviewers zelf voorgestelde reparaties, geen nieuwe eisen):**
  - de git-regel zit in de helpers `maybeBackupPush` en `removeWorktreeForJob` en in de directe `worktree remove`-aanroepen, zodat alle aanroepers (ook `pbi-cascade` en `cleanup_my_worktrees`) eronder vallen; inventaris uit de codex-reply overgenomen (claude MINOR, §5.3, §5.4);
  - scan-uitkomst ook op faalpaden in de foutmelding, en een waarschuwing om geen git te draaien in een mislukte worktree met "gewijzigd" (claude MINOR, §4.3 stap 9).
- **Scope-delta:** geen. Eerste bruikbare resultaat en eerste praktijkproef ongewijzigd.
- **Status:** spec-fase afgerond met dubbel GO. Technisch GO autoriseert geen plan, implementatie, merge of uitrol.

---
title: "Agent-harness M3 — TASK_IMPLEMENTATION-jobs via het lokale model op max2"
status: draft
last_updated: 2026-09-27
---

# Agent-harness M3 — TASK_IMPLEMENTATION-jobs via het lokale model op max2

Vervolg op [M2](2026-09-26-idea-chat-local-llm-design.md). Brainstorm met JP op 2026-09-27; alle vier ontwerpsecties goedgekeurd. De werklast voor de eerste echte proef is IDEA-226 "Notes" (product Scrum4Me).

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** een Claude-sessie die een Scrum4Me-sprint uitvoert, kan losse taken uitbesteden aan het lokale model op max2 en krijgt ze terug als geverifieerde branch om te reviewen en in te mergen.

**Eerst bruikbare resultaat:** één echte Notes-taak (bijvoorbeeld de MCP-tool voor notes in scrum4me-mcp) loopt via een `TASK_IMPLEMENTATION`-job door `qwen3.8-gsq-rco:27b-iq3_s-text`, komt groen door de verify-gate, staat als branch op Forgejo, en de sessie merget hem na review in de sprint-branch.

**Niet-doelen:**
- sprint-runs of `SPRINT_BATCH` via het lokale model;
- het managed-dispatch-pad `dispatch_task` (IDEA-213);
- taken die het databaseschema migreren of dependencies toevoegen;
- een UI-knop "lokaal uitvoeren";
- automatische terugval naar Claude als het lokale model faalt (de sessie beslist);
- de hele Notes-feature lokaal bouwen;
- voorrang voor idea-chat boven een lopende taak.

**Zichtbaar bewijs:** de job op het jobs-board (DONE, lokaal model als `model_id`, verify-samenvatting), de branch op Forgejo gepusht door de gebruiker `agent-harness`, de trace, en de merge door de sessie.

## 2. Besluiten uit de brainstorm

| # | Vraag | Besluit |
|---|---|---|
| 1 | Rol van IDEA-226 | Claude plant Notes via de gewone pipeline; per taak wordt gekozen wat lokaal draait (optie B) |
| 2 | Toewijzing aan het lokale model | Bij het dispatchen: `dispatch_job` krijgt `required_capability: 'local_llm'` (optie A). Reden: Scrum4Me staat op `pr_strategy = SPRINT_BATCH` (één job per sprint-run, geen per-taak-jobs) en sinds juli draaien Claude-sessies de sprints, niet de vloot |
| 3 | Wanneer is een taak klaar | Harness-gate (verify groen, `verify_task_against_plan` ≠ EMPTY) plus review door de Claude-sessie vóór de merge (optie A) |
| 4 | Waar draait code van het model | Alleen verify in een wegwerpcontainer zonder netwerk en zonder secrets; werktools in de harness op de host, begrensd tot de worktree (optie A) |
| 5 | Push-identiteit | Aparte Forgejo-gebruiker `agent-harness` met schrijfrecht op alleen de benodigde repo's (optie A) |
| 6 | Aanpak | De bestaande worker uitbreiden; één service voor `IDEA_CHAT` en `TASK_IMPLEMENTATION` (aanpak 1) |

## 3. Architectuur en stroom

```
Claude-sessie (Notes-sprint)
  └─ dispatch_job {kind: TASK_IMPLEMENTATION, task_id, required_capability: 'local_llm'}
       → ClaudeJob QUEUED, required_capability = 'local_llm', geen auto-PR
agent-harness-worker (max2, systemd)
  ├─ control: wait_for_job → claim; MCP maakt worktree op feat/story-<id8>
  ├─ prepare (host, netwerk, onveranderde base-commit): recept van de repo
  ├─ modelloop: werktools + doc-leestools, contextTokens 65536
  │    └─ run_tests / eindgate → verify in container (--network none, geen env)
  ├─ groen: git commit → verify_task_against_plan → update_job_status done (MCP pusht)
  └─ rood/budget/fout: update_job_status failed (backup-push M38)
Claude-sessie
  └─ get_job_status → review diff tegen taak → merge story-branch in sprint-branch, of afwijzen
```

## 4. Harness

### 4.1 Claim en config

- `src/worker/worker.ts`: de tweede grendel accepteert `IDEA_CHAT` en `TASK_IMPLEMENTATION`. Elke andere soort blijft `ClaimFilterError` (job sluiten, worker stopt met exit 1).
- `src/worker/config.ts`: nieuw optioneel blok `task`:

```ts
task?: {
  limits: { maxTurns; maxOutputTokens; maxWallSeconds; maxToolErrors; contextTokens }  // voorbeeld 40 / 80000 / 2400 / 8 / 65536
  verifyImage: string                   // vast node-image, zelfde major als de host-node
  verifyTimeoutSeconds: number          // standaard 600
  maxVerifyRepairs: number              // standaard 3
  recipes: Array<{
    repoUrl: string                     // exacte match op task.repo_url ?? product.repo_url
    prepare: string[]                   // host, met netwerk, in de worktree, vóór het model
    verify: string                      // in de container
  }>
}
```

Beide soorten delen de capability `local_llm`, dus een worker zonder `task`-blok kan een taakjob toch claimen. Hij sluit die dan direct als `failed` met "worker heeft geen task-config", zonder modelbeurten en zonder de taak aan te raken. Een aparte capability per soort is niet nodig: alleen de lokale worker claimt `local_llm`.

### 4.2 Werktools (`src/worker/task-tools.ts`)

Een `ToolRegistry` in het harness-proces (geen MCP-kind), gecombineerd met de vier doc-leestools uit M2 tot één registry-view voor het model.

| Tool | Gedrag |
|---|---|
| `list_files {path?}` | recursief, zonder `node_modules` en `.git`, max 300 regels |
| `read_file {path, offset?, limit?}` | met regelnummers; zonder bereik max 20 000 tekens met melding "afgekapt, gebruik offset/limit" |
| `write_file {path, content}` | maakt mappen aan |
| `edit_file {path, old_string, new_string}` | `old_string` moet precies één keer voorkomen |
| `search {pattern, path?}` | regex, max 100 treffers `bestand:regel: tekst` |
| `run_tests {}` | het verify-commando van het recept in de container (§4.4); exitcode plus de laatste 6 000 tekens |

Elk pad wordt opgelost via `realpath` van de dichtstbijzijnde bestaande voorouder en moet binnen de worktree vallen; anders een toolfout. Geen git- of shell-tool voor het model.

### 4.3 Afhandeling per taakjob (`src/worker/task-impl.ts`)

Het model schrijft niets naar Scrum4Me; de harness doet dat deterministisch:

1. Payload valideren (Zod: `task`, `story`, `worktree_path`, `branch_name`, repo-URL). Recept kiezen; geen recept → `failed` ("geen recept voor <repo>"), taak ongemoeid.
2. `update_job_status running`, `update_task_status in_progress`.
3. `prepare`-commando's op de host in de worktree, met netwerk, op de onveranderde base-commit. Faalt er een → `failed` met de laatste 2 000 tekens log.
4. Modelloop (§4.4) met de systeemprompt uit de spike plus taak, plan, story en acceptatiecriteria als data.
5. Na groene verify: `git add -A && git commit` met auteur `agent-harness` en de taaktitel als boodschap; geen wijzigingen → `failed` ("model produceerde geen wijzigingen").
6. `verify_task_against_plan`. `ALIGNED`/`PARTIAL` → verder; `EMPTY` of `DIVERGENT` → `failed` met die reden (protocol `worker-idempotency`).
7. `log_commit`, `log_test_result PASSED`, `update_job_status done` met summary = eindantwoord van het model (ingekort) plus de verify-uitslag, en `update_task_status review`. De MCP pusht de branch.
8. Elk faalpad na stap 2: `log_test_result FAILED` waar van toepassing, `update_job_status failed` met leesbare reden, en de taak blijft `in_progress` (protocol: handmatig onderzoeken). De sessie zet hem op `to_do` als ze opnieuw wil dispatchen.

Stop of verlies van eigenaarschap: zoals M2 — niet afsluiten; de lease-sweep zet de job terug in de wachtrij.

### 4.4 Verify-lus en container

- `src/run.ts` krijgt een optionele haak `afterAnswer(answer): Promise<string | null>`. Geeft het model een eindantwoord, dan roept de loop de haak aan; een string wordt als user-bericht toegevoegd en de loop gaat door binnen dezelfde limieten; `null` sluit af als `completed`. Zonder haak verandert er niets (idea-chat).
- De taak-handler implementeert de haak: verify draaien; groen → `null`; rood → "Verify faalt (poging n van maxVerifyRepairs): <uitvoer>"; na `maxVerifyRepairs` keer rood → de run eindigt als `failed` met code `VERIFY_FAILED`.
- Container-runner (`src/worker/verify-container.ts`): `docker run --rm --network none --cpus 8 --memory 8g --user <uid>:<gid> -v <worktree>:<worktree> -w <worktree> <verifyImage> sh -c "<verify>"`, zonder `-e`/`--env-file`, met een harde timeout (`verifyTimeoutSeconds`, daarna `docker kill`). Timeout telt als rood.
- Omdat de container geen netwerk heeft, faalt verify als het model dependencies toevoegt; dat hoort bij de niet-doelen.

### 4.5 Trace en secrets

Trace zoals v0/M2, plus events voor `prepare` (commando, exitcode, duur) en elke verify (bron `run_tests`/`gate`, exitcode, duur). Het Forgejo-token staat alleen in de env van het MCP-kind (§5, §6); de werktools, het model en de verify-container zien het nooit. `prepare` erft de env van de worker niet: de runner geeft alleen `PATH`, `HOME` en npm-cache-variabelen door.

## 5. Wijzigingen in scrum4me-mcp

- `dispatch_job`: optionele `required_capability`, enum `['local_llm']`, alleen toegestaan bij `kind: 'TASK_IMPLEMENTATION'` (anders validatiefout). `dispatchTaskImplementation` schrijft hem op de job.
- `update_job_status`: geen auto-PR (`maybeCreateAutoPr`) als `required_capability = 'local_llm'`. De push en de backup-push bij `failed` blijven.
- Claim-isolatie bestaat al (`eligibility.ts`, lokale worker claimt alleen `local_llm`; vloot slaat `local_llm` over).
- Tests: dispatch slaat de capability op; een andere soort met capability wordt geweigerd; done met `local_llm` roept geen auto-PR aan; een worker zonder `local_llm` claimt de job niet.

## 6. Inrichting max2 (serveracties, op JP's go)

- Forgejo-gebruiker `agent-harness` met schrijfrecht op Scrum4Me, scrum4me-mcp en agent-harness; token in `/etc/agent-harness/worker.env` als `FORGEJO_PUSH_TOKEN`. De worker-config geeft het MCP-kind `GIT_ASKPASS=<script>` en het token; git-identiteit `agent-harness`.
- `scoped_products` van het worker-token uitbreiden met Scrum4Me (`cmohrysyj0000rd17clnjy4tc`).
- Verse clones in `/var/lib/agent-harness/repos/`; worktrees in `/var/lib/agent-harness/worktrees/` via `SCRUM4ME_REPO_ROOT_<product>` / `repoRoots` en `SCRUM4ME_AGENT_WORKTREE_DIR`. Een taak met `task.repo_url` (scrum4me-mcp) krijgt een clone via de bestaande override.
- Verify-image eenmalig pullen; `uid`/`gid` van `janpeter` in de config.
- Recepten (exacte commando's in het plan, na een losse proef op max2): agent-harness (`npm ci` / `npm run verify`), scrum4me-mcp (`npm ci` met Prisma-generate / `npm run typecheck && npm test`), Scrum4Me (submodule, `npm ci`, Prisma-generate / `npm run verify`).

## 7. Uitrol en bouwvolgorde

1. Harness-PR (§4) en MCP-PR (§5), beide door JP gemerged.
2. Inrichting max2 (§6) op JP's go; recept-proef per repo met een lege worktree (prepare + verify groen op main).
3. Acceptatie 1–3 (§9).
4. Notes (IDEA-226) via de gewone pipeline: spec, plan, ceremonie. De eerste lokale taak is acceptatie 4.

## 8. Tests (zonder netwerk)

- Werktools: padbegrenzing (`..`, absoluut pad, symlink naar buiten), `edit_file` uniek/niet-uniek, `read_file` met bereik en afkapmelding, `list_files` slaat `node_modules` over.
- `run.ts`: `afterAnswer` rood → verder → groen; 3× rood → `failed`/`VERIFY_FAILED`; zonder haak ongewijzigd gedrag.
- Container-runner: gebouwde `docker`-argumenten bevatten `--network none`, geen `-e`/`--env-file`, de juiste mount; timeout → rood (injecteerbare process-runner).
- Taak-handler tegen nep-control en nep-model: volgorde van control-aanroepen op het groene pad; elk faalpad uit §4.3 met de juiste job- en taakstatus; geen recept; geen wijzigingen; `DIVERGENT`.
- Worker: claimfilter accepteert beide soorten; een taakjob zonder `task`-config → `failed`; idea-chat-regressie.

## 9. Acceptatiecriteria

1. Een kleine echte taak in agent-harness, gedispatcht met `local_llm`: job DONE met lokaal `model_id` en verify-samenvatting, branch gepusht door `agent-harness`, geen PR, taak op `review` (live).
2. Een taak waarvan verify niet groen kan worden: job FAILED met de verify-uitvoer, taak `in_progress`, geen PR (live).
3. De verify-container heeft geen netwerk en geen secrets: een proef-verify met `env` en een netwerkaanroep toont geen token en een mislukte verbinding (live).
4. De eerste Notes-taak: de sessie reviewt de branch en merget hem in de Notes-sprint-branch (live).
5. Idea-chat blijft werken (regressietest en één live bericht).

## 10. Risico's en open punten

- **Modelkwaliteit:** de spike haalde 7/9 op kleine taken; echte Notes-taken zijn groter. Mitigatie: taken klein snijden in het Notes-plan, verify-gate, review door de sessie.
- **Scrum4Me-verify in een verse worktree** (geen `.env`, Prisma-client, submodule) was eerder lastig; eerst bewijzen in de recept-proef (§7 stap 2) vóór een Scrum4Me-taak.
- **Doorlooptijd:** één job tegelijk; een taak (tot 40 minuten) houdt idea-chat op.
- **GPU-delen:** TEI blijft uit; een toekomstige embedding-job moet de GPU vrijmaken of elders draaien.
- **Docker-groep:** `janpeter` in de docker-groep is root-equivalent op max2; alleen de harness roept docker aan, nooit het model.

## Review record

_(wordt per ronde bijgewerkt)_

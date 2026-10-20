# IDEA-269 — review record (spec- en plan-loop)

Formele review-loop op verzoek van JP (2026-10-20), vóór de ceremonie. Hij volgt de skill `review-loop`: twee onafhankelijke dispatch-reviewers (`runtime: CODEX` en `runtime: CLAUDE`), maximaal 10 rondes per fase. Eerst de spec, daarna het plan.

- **Idee:** IDEA-269 `cmvgkqqdd00x9zr7r11fglppi`, product Agent-harness `cmuhjw9e80003mt7rq4w3sauu`.
- **Spec:** `docs/specs/2026-10-20-idea-269-model-registry-origin-design.md`. Repo-kopie van ProductDoc `IDEA-269-spec`; wordt na de loop gesynchroniseerd.
- **Plan:** ProductDoc `IDEA-269-plan`, revisie 2. Komt voor de plan-fase als repobestand in `docs/plans/`.
- **Waarom repobestanden:** dispatch pint een ProductDoc op zijn content-hash. Een git-pin is reproduceerbaar te hashen.
- **`/work`-checkout:** Scrum4Me `178811a3925b4e92798193f1f2dc457f77ead503`, de repo met de meeste claims (migraties, chat, db-access).
- **Bronnen buiten `/work`**, als git-pins:
  - scrum4me-shared `8df7f2c07c3912c12ebbe294088d4d6684f2bc24`;
  - scrum4me-workers `198eb597e59ec3bae3a39552e2f785686cfec3b5`;
  - agent-harness (`deploy/max2/`, op de commit van de spec).

## Spec-fase

### Ronde 1 (spec revisie 2, commit `d978103`)

**Reviewers**

| | CODEX | CLAUDE |
|---|---|---|
| request | `e0f88012-88ed-436e-9364-4162f541d15a` | `4ee8e415-de0c-46e2-a545-16f829e9c97c` |
| root | `5b420b4b-45ec-4f98-8369-eb58b99d7899` | `b6daa631-5657-4160-a4df-558e3e32f047` |
| key | `c0093562-2e73-410b-9f38-59a0d279e6dc` | `9b18b568-dcfc-495b-af27-10c671fc7507` |
| idea_link | linked (SPEC) | linked (SPEC) |
| uitslag | 0 BLOCKER / 1 MAJOR / 1 MINOR, **NO-GO** | 1 BLOCKER / 0 MAJOR / 4 MINOR, **NO-GO** |

**Pins:**
- `spec`: sha256 `96fab4ed…`;
- `evidence`: sha256 `0159712c…`;
- `/work` = Scrum4Me `178811a3`.

De eerste poging om ook codebestanden te pinnen werd geweigerd met `DISPATCH_INVALID_INPUT`: git-pins moeten `.md` zijn, maximaal 8. Daarom kwam er een bewijsbijlage.

**Bepalende bevinding.** Beide reviewers vonden haar, de BLOCKER van Claude en de MAJOR van Codex. `agent_models` is een gesloten object van de IDEA-213-adoptie, en kolommen toevoegen geeft `SCHEMA_DRIFT` bij elke deploy.
- Door de orchestrator geverifieerd:
  - `idea-213.json:2447`;
  - `adoption-server.ts:101` (`schemaFingerprint` ≠ de verwachte waarde geeft `SCHEMA_DRIFT`);
  - `closed-schema-transitions.ts:195-198` (alleen triggers);
  - `contract-inventory.ts:21-31` (de fingerprint hasht de kolommen);
  - precedent `2026-10-10-agent-chat-design.md:622`, dat `cost_mode` om dezelfde reden schrapte.
- **Remedie:** JP-besluit 13. Een nieuwe 1:1-tabel `agent_model_facts` met een additief contract, volgens het precedent `0a56c53b` (`product_access_steps`). `agent_models` blijft byte-gelijk.
- **Geaccepteerd.** Spec revisie 3: §2 (besluit 13), §3, §4.1–4.5, §4.9 en §5.

**Overige bevindingen**

| Bevinding | Bron | Oordeel | Verwerking |
|---|---|---|---|
| Claims over code buiten `/work` zijn niet te verifiëren (MCP `agent-guide.ts`, shared- en workers-tests, consumenten) | Codex MINOR | terecht | Evidence uitgebreid met shared `harness-config.test.ts`, workers `model-registry.test.ts` en `usage-detail.tsx`. De MCP-claim is vervallen: er verandert geen bestaande tabel. De repo-brede grep blijft acceptatie (§5.3). |
| Criterium 3 raakt twee JSDoc-regels (`model-picker.tsx:26`, `chat-window.tsx:50`) | Claude MINOR | terecht | §3 en §4.4 noemen de regels; §5.3 vraagt "geen import, aanroep of commentaar", met de grep na stap 4 en buiten `vendor/` |
| De chat-omzetting is niet echt op de server getest | Claude MINOR | terecht | §4.4: test van `getAgentChatView` met een gemockte db (geen `active`-filter geasserteerd), en de layout-mapping als pure `toChatModelOptions` met tests |
| `yaml` v2 lost merge-keys niet standaard op | Claude MINOR | terecht (nu geen gevolg) | §3 en §4.6: de config heeft alleen anchors en aliassen; het script parset met `{ merge: true }`, en een fixture dekt een merge-key |
| De driftcheck heeft geen regel voor een ontbrekende LiteLLM-regel; de exitcode van de proef is onduidelijk | Claude MINOR | terecht | §4.6: een ontbrekende regel en een HARNESS-rij zonder facts vallen onder (c). §5.6: de proef wordt beoordeeld op (c)/(d), niet op de exitcode. |

**Scope-delta:** besluit 13 voegt één tabel en één additief contract toe. In ruil verdwijnen de kolomwijziging op een gesloten tabel en de DB-default (keuze 2 vervalt). Het eerste resultaat en de praktijkproef blijven gelijk. `observer` (`ops_readonly`) krijgt SELECT, zodat de driftcheck een toegestane read-only route heeft; daarmee is het open punt over productie-toegang opgelost. Geen werk uitgesteld.

### Ronde 2 (spec revisie 3, commit `70ded45`)

**Reviewers**

| | CODEX | CLAUDE |
|---|---|---|
| request | `17fad3b6-9f3c-4d4a-8eb8-50fdc714931f` | `51961752-6e4e-4f96-9fc4-02f34cc595f2` |
| root | `934cecaf-b896-4418-beec-edf0a6fd8834` | `9b7cfc1f-f00d-4917-8159-ce353f2e155a` |
| key | `b3873e4a-642e-47f2-b3f0-d7a193071dbb` | `7c46ae47-665a-4e46-8ded-c11ff393bb1f` |
| idea_link | linked (SPEC) | linked (SPEC) |
| uitslag | 0 / 0 / 2 MINOR, **GO** | 0 / 0 / 5 MINOR, **GO** |

**Pins:**
- `spec`: sha256 `116bc17e…`;
- `evidence`: sha256 `b96b7a71…`;
- `/work` = Scrum4Me `178811a3`.

**Fixes van ronde 1.** Beide reviewers: de fix voor de gesloten tabel houdt. Ze controleerden de fingerprint (FK-constraint op de nieuwe tabel, interne RI-triggers), alle voorwaarden van `splitAdditiveContracts` inclusief `observer` SELECT, de vorm van het precedent, de backfill-SQL en de driftafleiding voor alle configuraties. Claude: fix 4 houdt deels (zie MINOR 1–2 hieronder).

**MINORs van ronde 2.** Alle verwerkt in spec revisie 4, na GO. Ze worden in de plan-loop meegelezen, omdat het plan aan revisie 4 gebonden is.

| Bevinding | Bron | Oordeel | Verwerking (rev 4) |
|---|---|---|---|
| `git show 0a56c53b` faalt in de depth-1-checkout; de claim over de exacte diff is niet te controleren | Codex | terecht | §3 haalt het precedent aan via bestanden in de tree, plus `provision.ts:31` |
| Parameteraantallen als `Decimal(10,2)` botsen met de regel "gehele getallen" | Codex | terecht | §4.2 splitst de regel: tokenaantallen zijn gehele getallen, parameteraantallen decimalen (≤ 2 decimalen, < 10⁸), en actief ≤ totaal |
| De mocks in `agent-chat-view.test.ts` (`makeDb`, interleave) hebben geen `agentModel`; de leesvolgorde is niet vastgelegd | Claude | terecht (geverifieerd: `chats-server.ts:244-260`, de test r. 25-30 en 82-90) | §4.4: de opzoeking staat direct na de chat, vóór de jobs/berichten-reeks; beide mocks krijgen `agentModel.findFirst` |
| De inactieve case in de test van `toChatModelOptions` bewijst niets (de layout filtert op `active`) | Claude | terecht | §4.4: het inactieve geval wordt alleen bij `getAgentChatView` getest; §5.4 is herschreven |
| Een upsert van facts in `addModelAction` kan de herkomst van een bestaande rij omzetten | Claude | terecht | §4.5: in I1 alleen aanmaken; een afwijkende herkomst bij een bestaande naam wordt geweigerd, en de test is uitgebreid |
| Uitrolvolgorde in stap 2 (`applyContracts` vóór verkeer) en `data-model.md` | Claude | terecht (geverifieerd: `data-model.md` heeft een sectie voor het precedent) | §4.3: uitrolvolgorde vastgelegd en `data-model.md` toegevoegd |
| Een latere ALTER op `agent_model_facts` moet in `additiveFollowUpMigrationIds` | Claude | terecht | §3 en §4.7 |

**Scope-delta:** geen. Alleen verduidelijkingen en een smallere actie in I1 (alleen aanmaken). De spec-fase is afgerond met dubbel GO.

## Plan-fase

Het plan staat als repobestand `docs/plans/2026-10-20-idea-269-plan.md`, met de YAML-frontmatter die `update_idea_plan_md` valideert. Het is gebonden aan spec rev 4 en volgt besluit 13 (`agent_model_facts`). Ten opzichte van ProductDoc `IDEA-269-plan` rev 2 is het herschreven.

### Plan-ronde 1 (plan, commit `a2eb8c3`)

**Reviewers**

| | CODEX | CLAUDE |
|---|---|---|
| request | `f0964637-9f07-4794-8e72-cddb510d1dba` | `4105a64a-c9b1-4318-a4b6-5463ddc32f4e` |
| root | `81b96e5e-2700-4cb9-b69f-4cbb2d416d30` | `084c90cc-c357-4ae0-bc7a-d64b35da65ee` |
| key | `aa99dde2-0ad3-4f94-812b-97ccc1e7aaf6` | `675ab74c-9391-42c7-9ceb-d8ad63126b86` |
| idea_link | linked (PLAN) | linked (PLAN) |
| uitslag | 0 BLOCKER / 2 MAJOR / 1 MINOR, **NO-GO** | 0 BLOCKER / 1 MAJOR / 8 MINOR, **NO-GO** |

**Pins:**
- `plan`: sha256 `5abe44e3…`;
- `spec`: sha256 `820e2f41…`;
- `evidence`: sha256 `b96b7a71…`;
- `/work` = Scrum4Me `178811a3`.

**Bepalende bevindingen.** Alle drie de MAJORs zijn door de orchestrator in de tree geverifieerd.

| Bevinding | Bron | Oordeel | Verwerking |
|---|---|---|---|
| De code-taken van S2 en S3 laten een agent productie deployen. Daarvoor is een eigen operatorautorisatie nodig (`db-access-policy.md:449`). De eerste deploy stopt met exit 3 tot JP **Approve Policy Hash** draait (`:137-162`, `:346-349`), en de volgorde "workers na S2" is alleen proza. | Claude MAJOR | terecht | S2-T2 en S3-T3 stoppen na de merge, met een expliciet deployverbod. De uitrol staat als geordende JP-stappen in S4-T3: exit 3, Approve Policy Hash, deploy met migrate en apply/check, wrapper-precheck, SELECT-controles, en pas dan workers. S2- en S3-acceptatie, volgordetabel en risico's zijn bijgewerkt. |
| De praktijkproef gebruikt `status` (Prisma-migratiestatus) als policy-check. `status` stelt geen fingerprint-gelijkheid vast (`db-access-policy.md:40-46`, `:207`). | Codex MAJOR | terecht | S4-T3 stap 1 noemt de apply/check van de deploy als releasepoort; stap 2 is de read-only wrapper-`precheck` als observatiebewijs. `status` staat er expliciet bij als onvoldoende. Alleen geredigeerde fase-uitkomsten worden gelogd. |
| Geen taak doet `npm run build` voor workers (spec §5.1). Workers-CI draait alleen `verify`. | Codex MAJOR, Claude MINOR 6 | terecht | S3-T3-verificatie en S3-acceptatie: `npm run verify` en `npm run build`. |

**Overige bevindingen**

| Bevinding | Bron | Oordeel | Verwerking |
|---|---|---|---|
| Workers' `gen-schema.sh` schrijft naar stdout; S3-T1 gebruikte de Scrum4Me-aanroep. | Claude MINOR 1, Codex MINOR | terecht (geverifieerd: workers `scripts/gen-schema.sh`, `package.json:6-11`) | Commando met `> prisma/schema.prisma`. `postinstall` wordt bewust niet gebruikt, omdat `\|\| true` fouten verbergt. Controle met `grep`: het schema is gitignored. |
| "Gegroepeerd per onderliggend model" kan in I1 niet: REMOTE-rijen hebben geen upstream na de backfill. | Claude MINOR 2 | terecht | S4-T3 stap 5: "feitelijk op model_id gesorteerd; upstream volgt in I2" |
| S1-SHA, migratietimestamp en de submodule-pointer staan niet in de S2-T1-tekst. | Claude MINOR 3 | terecht | Commando om de S1-SHA te vinden, timestamp na de laatste map, pointer meecommitten, oude schema via `git show origin/main:prisma/schema.prisma` (Scrum4Me trackt het schema) |
| Testdetails: observer SELECT is niet gepind; de statementlijst mist INSERT; de Enums-tabel ontbreekt. | Claude MINOR 4 | terecht (geverifieerd: `access-checklist-contract.test.ts:33-52`, `access-checklist-migration.test.ts:64-112`, `data-model.md:966`) | S2-T1 stap 4: exacte `privileges` incl. observer, statementlijst met `INSERT INTO "agent_model_facts"`, `pinnedTables` bevat agent_models. Stap 5: rij in de Enums-tabel. Nagegaan: de `pinnedTableViolations`-scan raakt `INSERT … SELECT FROM "agent_models"` niet, en `migrateAdditive` draait als `scrum4me` (eigenaar). |
| Driftcheck: DB-pad, volledige YAML-paden, een merge-test die kan falen, exit-2-gevallen en foutteksten | Claude MINOR 5 | terecht | S3-T3: `lib/prisma.ts` (geen server-only, geen dotenv, dus DATABASE_URL verplicht, anders exit 2), precedent `scripts/check-review-source.ts`, volledig pad `litellm_params.extra_body.provider.quantizations`, een fixture die alleen via `<<` klopt plus een negatieve parse, exit-2-gevallen uitgeschreven. S3-T2: de fouttekst komt letterlijk uit de shared-module. |
| De grep in S4-T1 is niet uitvoerbaar en heeft geen stop. | Claude MINOR 7 | terecht | Clone-URL's en een stop-voorwaarde (treffer → niets verwijderen). De stand per repo op 2026-10-20 staat in de evidence. |
| Validators die pas in I2 nodig zijn; de DB-rolstap is afleidbaar | Claude MINOR 8 | deels | De validators blijven: spec §4.2 legt ze in I1 vast, en het is bewust gehouden. De DB-rolstap is een notitie geworden (alleen web en preparedWeb schrijven in agent_models, `scrum4me.json:2576-2591`). |
| Externe bestanden zijn niet te verifiëren uit de evidence. | Codex MINOR | terecht | Evidence aangevuld (achteraan; eerdere regelnummers ongewijzigd): workers `gen-schema.sh`, `prisma.config.ts`, `lib/prisma.ts`, `.gitignore`, `check-review-source.ts`, DataTable, `useLocalTableSort` en de opzet van beide tests; shared `package.json`, list-price-test en harness-schema-test; agent-harness `package.json` en de runbooksectie LiteLLM; consumenten-grep. |

**Eigen vondst bij de verificatie.** S4-T2 noemde "het recept voor het toevoegen of wijzigen van een configuratie" in `harness-service-max2.md`. Zo'n recept bestaat niet. De taak wijst nu de bullet "Upgrade (nieuw image, nieuwe modellen of config)" in `## LiteLLM` aan.

**Scope-delta:** geen werk toegevoegd aan de code-taken. De uitrol staat nu expliciet als JP-stappen in S4-T3; dat werk was er al impliciet. Workers krijgt één extra verificatiecommando (`build`). Eerste resultaat en praktijkproef blijven gelijk. De proef valt nu bewust na een gecontroleerde uitrol.

### Plan-ronde 2 (plan rev 2, commit `8aa748f`)

**Reviewers**

| | CODEX | CLAUDE |
|---|---|---|
| request | `e7cdf861-747d-4111-bce7-57a3c04235d9` | `24ae0af7-1779-4f71-a3e2-f66d02ab92c6` |
| root | `b50cf23c-d4aa-4b03-b4e9-cfceac970670` | `2db79bc5-08b6-46e4-a5a8-85a436292446` |
| key | `b9f876dc-09b2-4de7-954a-4161cbde89b9` | `fa865822-870b-417e-abc7-f343239df84e` |
| idea_link | linked (PLAN) | linked (PLAN) |
| uitslag | 0 / 0 / 2 MINOR, **GO** | 0 / 0 / 9 MINOR, **GO** |

**Pins:**
- `plan`: sha256 `1514d6d1…`;
- `plan_prev`: sha256 `5abe44e3…` (rev 1);
- `spec`: sha256 `820e2f41…`;
- `evidence`: sha256 `d0c16d94…`;
- `/work` = Scrum4Me `178811a3`.

**Fixes van ronde 1.**
- Codex: 11 van 12 hielden; #11 (externe bestanden) hield deels.
- Claude: 11 van 12 hielden; #6 hield deels (de SHA-opzoeking in een verse worktree).

**MINORs van ronde 2.** Alle geverifieerd. Na de GO verwerkt in plan rev 3.

| Bevinding | Bron | Verwerking (rev 3) |
|---|---|---|
| Geen test voor een inactieve LOCAL-rij in `getAgentChatView` (spec §4.4/§5.4) | Codex | S2-T2: case toegevoegd |
| Achtergrondbronnen en de workers-deploy zijn niet te verifiëren | Codex | S4-T3: Ops-flow `update_scrum4me_workers` genoemd (Ops-dashboard `deploy/ops-agent/baseline/flows/update_scrum4me_workers.yml`), en uitdrukkelijk niet `redeploy_all`. Het review-record en het grill-doc blijven verwijzingen. |
| F1: de list-price-pin bestaat al en kan niet rood zijn | Claude | S1-T2/S1: de bestaande tests dekken §5.7 (geverifieerd: `__tests__/list-price.test.ts` "covers exactly the priced runtimes" en `listPriceKey('HARNESS','gpt-5.5')`). Alleen een `qwen3.8-or`-case erbij; "eerst rood" geldt alleen voor de schema- en helpertests. S1-T1 noemt het precedent `access-checklist-schema.test.ts`; geen test pint de veldregels van AgentModel. |
| F2: de CI van S2-T1 heeft een PR nodig; dummy-env voor build | Claude | S2-T1 opent een draft-PR als test:dispatch lokaal niet kan; de stop-voorwaarde geldt voor die CI. Build-env uit `ci.yml` (Build-stap) overgenomen. |
| F3: de SHA-opzoeking faalt in een verse worktree | Claude | S2-T1 en S3-T1: eerst `git submodule update --init`; een lege uitkomst geeft een stop. S2-T1 stopt bij een onverwachte schema-diff. |
| F4: de backfill-CASE wordt alleen als string getest | Claude | Kleinste remedie: de PR vermeldt de handcontrole tegen §4.3, en S4-T3 stap 3 is de productiecontrole vóór de workers-uitrol. Geen nieuwe chain-test: de faalrichting is veilig ("gehost"). |
| F5: de rollback-test kan niet falen | Claude | S3-T2: de facts-rij wordt eerst gelezen en vóór elke schrijfactie geweigerd; de test asserteert dat upsert en create niet zijn aangeroepen. Het blok staat vóór `if (HARNESS) return` (r. ~135, geverifieerd); een lege upstream wordt null. |
| F6: bestaande editor-tests en fixtures | Claude | S3-T1: fixtures en `ids()` per sectie; een lege sectie heeft geen tabel; "herkomst niet vastgelegd" en de `actief`-toggle worden getest |
| F7: build-env voor workers | Claude | S3-T3: `lib/env.ts` slaat de validatie over bij NEXT_PHASE (geverifieerd); een dummy DATABASE_URL voor `prisma.config.ts`; wat te doen bij een env-fout |
| F8: een vergeten `facts`-select valt stil terug op "gehost" | Claude | S2-T2: `facts` is in het rijtype verplicht (`\| null`, niet optioneel), zodat tsc faalt |
| F9: exit 4, de herkomst-mismatch-fixture, het eerste echte INSERT | Claude | S4-T3: exit 4 geeft een rerun; S3-T3: een fixture met omgezette herkomst geeft exit 1 en (c); de eerste echte "Model toevoegen" bewijst het INSERT-recht later |

**Scope-delta:** geen. Alleen verduidelijkingen en testscherpte, plus één kleinere actie in S3-T2: weigeren vóór het schrijven in plaats van een rollback. Dat past binnen spec §4.5.

**Plan-fase afgerond met dubbel GO** (ronde 2, rev 2). Rev 3 bevat alleen de MINORs hierboven.

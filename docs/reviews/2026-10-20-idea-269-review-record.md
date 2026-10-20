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

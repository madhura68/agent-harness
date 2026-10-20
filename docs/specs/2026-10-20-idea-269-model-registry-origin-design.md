---
title: "IDEA-269 — Herkomst en modelfeiten in de model-registry"
status: draft
last_updated: 2026-10-20
revision: 3
---

# IDEA-269 — Herkomst en modelfeiten in de model-registry

Spec voor IDEA-269 "Toevoegen remote en lokale modellen". Ze bouwt op de grill van 2026-10-20 (grill-doc revisie 2; beslissingen staan als DECISION in de idee-tijdlijn). Waar deze spec een keuze maakt die de grill openliet, staat dat er expliciet bij. Deze repo-kopie is leidend tijdens de review-loop; de ProductDoc `IDEA-269-spec` (product Agent-harness) wordt na de loop gelijkgetrokken.

**Revisie 3** (na review-ronde 1; record: `docs/reviews/2026-10-20-idea-269-review-record.md`):
- **De nieuwe velden komen niet op `agent_models`, maar in een nieuwe 1:1-tabel `agent_model_facts`** (besluit 13, JP). `agent_models` is een gesloten object van de IDEA-213-adoptie; een kolomwijziging daarop geeft `SCHEMA_DRIFT` bij elke deploy.
- Het additieve db-access-contract, de backfill en de dispatch-CI staan nu in §4.3.
- De chat-omzetting wordt op de serverlaag getest (§4.4).
- De driftcheck heeft regels voor een ontbrekende LiteLLM-regel en voor YAML-merges, en de praktijkproef wordt beoordeeld op de secties (§4.6, §5).

Revisie 2:
- een inactieve LOCAL-rij is niet-gehost;
- de workers-uitrol wacht op de migratie;
- de verwachting voor de driftcheck is aangescherpt.

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "lokale modellen en openrouter modellen (…) in dezelfde fysieke tabel, maar ik wil ze visueel scheiden", met een veld voor abonnement/lokaal/remote, de context, de capabilities en de quantisatie. JP wil daarop modellen kunnen beoordelen naast de prijs.

**Eerste resultaat (I1):**
- JP opent workers `/settings/models` en ziet drie secties: Abonnement, Remote en Lokaal.
- In de chat-modelkiezer van Scrum4Me staat "gehost" alleen bij de niet-lokale configuraties. Die waarde komt uit de registry, niet meer uit een lijst in code.
- De driftcheck tegen de productie-DB en de repo-kopie van de harness-config meldt geen herkomstverschil.

**Niet-doelen:**
- Gemeten prestaties (probe, bench, snelheid) en beleid & fit (data-collectie, licentie, geheugen).
- Een lijst met beschikbare quants.
- Een DB die `harness.json` of LiteLLM aanstuurt of genereert.
- Groepering in de keuzelijsten.
- Nieuwe `AgentRuntime`-waarden.
- HARNESS in `LIST_PRICE_PROVIDERS`.
- Een cron- of CI-driftcheck.
- Elke schemawijziging aan `agent_models` of `model_prices`.

## 2. Besluiten

| # | Besluit |
|---|---|
| 1 | Alle modellen (Claude, Codex, lokaal, OpenRouter) blijven rijen in `agent_models`; één rij is een kiesbare configuratie. Er komt een optioneel veld voor het onderliggende model. *Aangevuld door 13: de nieuwe velden staan in een 1:1-tabel.* |
| 2 | `harness.json` en de LiteLLM-config blijven leidend. De DB-velden zijn beschrijvend; een read-only driftcheck vergelijkt ze. |
| 3 | Eén herkomstveld met drie waarden; het vervangt `HARNESS_LOCAL_CONFIGURATIONS`. |
| 4 | v1-velden zijn de kernfeiten en de gedeclareerde capabilities. |
| 5 | Quantisatie is één vrij tekstveld met de quant die draait. |
| 6 | REMOTE krijgt een lijstprijs, alleen voor weergave. HARNESS blijft buiten `LIST_PRICE_PROVIDERS`. |
| 7 | `/settings/models` krijgt drie secties met eigen kolommen. |
| 8 | De driftcheck is een npm-script in workers en leest de repo-kopie van de harness-config. |
| 9 | Increments: I1 schema, secties, chat-label, LOKAAL-regel en driftcheck; I2 velden bewerken; I3 REMOTE-prijs. |
| 10 | Sprint en PBI komen onder product scrum4me-workers. |
| 11 | LOKAAL alleen met bewijs, en de driftcheck al in I1. |
| 12 | De herkomst is een enum; capabilities zijn `String[]` gevalideerd in shared. Volgorde: shared → migratie → bump → UI. *Herzien door 13: de herkomst is NOT NULL op een facts-rij, en een ontbrekende facts-rij betekent "gehost".* |
| 13 | (JP, na review-ronde 1) Herkomst en feiten komen in een nieuwe tabel `agent_model_facts`, 1:1 met `agent_models` (FK met cascade), met een eigen migratie en een additief db-access-contract. `agent_models` blijft byte-gelijk. |

JP bevestigde ook vijf spec-keuzes (2026-10-20):
1. Engelse enumwaarden met Nederlandse labels.
2. *(vervallen door besluit 13: er is geen kolomdefault meer nodig)*
3. Een inactieve LOCAL-rij is niet-gehost.
4. In I3 één REMOTE-prijs per configuratie, met cacheprijzen op 0.
5. Geen DB-CHECK voor de LOKAAL-regel.

## 3. Uitgangssituatie

- **Schema.** `AgentModel` staat in scrum4me-shared `prisma/schema.prisma:855-868`.
  - Scrum4Me en workers vendoren shared als git-submodule (`vendor/scrum4me-shared`). Hun `prisma/schema.prisma` wordt gegenereerd (`scripts/gen-schema.sh`).
  - Scrum4Me is gepind op `8df7f2c` (shared main). Workers is gepind op `f1e78df`; daartussen zitten twee schema-commits (`c79f6e3` usage issue-scope, `cd01a69` ProductAccessStep), die al in de DB staan.
- **`agent_models` is gesloten.** Het staat in het IDEA-213-adoptiemanifest (Scrum4Me `scripts/db-access/adoptions/idea-213.json:2447`).
  - Bij elke policy-check en deploy vergelijkt `verifyAdoptionAfter` per manifestobject de schema-fingerprint (`lib/db-access/adoption-server.ts:101`). Die fingerprint hasht kolommen, constraints met `conrelid` = de tabel, indexen, niet-interne triggers en policies (`scripts/queue-dispatch/contract-inventory.ts:21-31`).
  - Op een gesloten tabel staat de closed-schema-keten alleen triggerwijzigingen toe (`lib/db-access/closed-schema-transitions.ts:195-198`).
  - Precedent: de agent-chat-spec (`docs/superpowers/specs/2026-10-10-agent-chat-design.md:622`) schrapte om die reden `agent_models.cost_mode` en voerde de harde lijst `HARNESS_LOCAL_CONFIGURATIONS` in.
  - Voor `model_prices` geldt hetzelfde. I3 voegt daar alleen rijen toe, geen kolommen.
- **Nieuwe tabellen na de adoptie** gaan alleen als *additief contract* (`docs/runbooks/db-access-policy.md`, "After the IDEA-213/227 adoption"):
  - een plain table-key;
  - `migrationId` gezet;
  - `privileges.dispatch` en `privileges.projector` leeg;
  - `publicPrivileges` leeg;
  - geen `columnGrants`.

  Precedent `0a56c53b` (`20261019120000_product_access_steps`) heeft precies de vorm die hier nodig is: een nieuwe enum, een nieuwe tabel, een FK met `ON DELETE CASCADE` naar een gesloten tabel (`products`), en een additief contract met CRUD voor `web`/`preparedWeb`. Het enumtype staat niet in de catalogus en krijgt geen contract. De commit raakte de submodule-pin, het gegenereerde schema, `migration.sql`, het profiel en twee tests (`__tests__/db/access-checklist-migration.test.ts`, `__tests__/lib/db-access/access-checklist-contract.test.ts`), maar niet `provision.ts` of `contract-inventory.ts`.
- **Een FK naar `agent_models` verandert de fingerprint van `agent_models` niet.** De FK-constraint heeft `conrelid` = de nieuwe tabel, en de triggers die hij op `agent_models` zet zijn interne triggers (`tgisinternal`), die de fingerprint uitsluit.
- **Rollen** (`profiles/scrum4me.json`, `roles`): `web` = `scrum4me_web_runtime`, `preparedWeb` = `scrum4me_app`, `observer` = `ops_readonly`, `dispatch`, `projector`, `queue`. Het contract van `agent_models` geeft `web`/`preparedWeb` CRUD en `observer`/`dispatch` SELECT.
- **Uitrol** gaat alleen via de operator-route in de gewone web-deploy, nooit met een kale `prisma migrate deploy`. De Scrum4Me-CI heeft naast `verify` de jobs `test:dispatch` en `test:dispatch:chain` (`.github/workflows/ci.yml:166,182`); die spelen migraties en contracten af tegen een test-DB.
- **Workers deployt niet automatisch:** CI (`.forgejo/workflows/ci.yml`) draait alleen verify.
- **Wie schrijft in `agent_models`:**
  - de Scrum4Me-seed (`prisma/seed-data/agent-models.ts`, alleen CLAUDE/CODEX);
  - `scripts/add-model.ts` (alleen CLAUDE/CODEX);
  - workers `addModelAction` (alle runtimes; HARNESS alleen hier).
- **Wie leest de herkomst nu:** `isHostedHarnessConfiguration` wordt in Scrum4Me aangeroepen in `app/(app)/chat/layout.tsx:57` en `app/(app)/chat/[id]/page.tsx:34`, en genoemd in JSDoc in `components/agent-chat/model-picker.tsx:26` en `components/agent-chat/chat-window.tsx:50`.
  - `[id]/page.tsx` leest `agentModel` nu niet; `getAgentChatView` levert alleen `configuration`.
  - Een inactieve configuratie wordt bij verzenden geweigerd met 409 (`lib/agent-chat/send-server.ts:40-44`).
  - De shared-test pint de oude lijst (`__tests__/harness-config.test.ts:223-232`).
- **Kosten:** alle kostenschermen koppelen `model_prices` via `listPriceJoinSqlText`/`listPriceKey`, met `LIST_PRICE_PROVIDERS` (alleen CLAUDE en CODEX) in shared `lib/list-price.ts`.
- **Harness-config (repo-kopie in agent-harness `deploy/max2/`):**
  - `harness.json` bevat per configuratie `costMode` (local/hosted) en `contextTokens`.
  - `litellm/config.yaml` bevat per `model_name` de `litellm_params.model`, `api_base` en `extra_body.provider.quantizations`, met YAML-anchors en -aliassen, maar zonder merge-keys (`<<`).
  - Het lokale model is `openai/qwen3.8-gsq-rco:27b-iq3_s-text`, met `api_base` naar de Ollama-bridge `172.30.82.1:11434`. De prefix zegt dus niet "lokaal".
- **Woordgebruik:** workers gebruikt "modelherkomst" al voor iets anders (`components/usage/usage-detail.tsx:249`).

## 4. Ontwerp

### 4.1 Schema (scrum4me-shared)

```prisma
/// IDEA-269: waar een registry-rij draait. Alleen LOCAL geldt als niet-gehost.
enum ModelOrigin {
  SUBSCRIPTION
  REMOTE
  LOCAL
}

/// IDEA-269: herkomst en beschrijvende feiten van één agent_models-rij (1:1).
/// Eigen tabel omdat agent_models gesloten is (IDEA-213-adoptie). Beschrijvend:
/// harness.json en LiteLLM blijven leidend. Geen rij = herkomst onbekend = gehost.
model AgentModelFacts {
  agent_model_id     String      @id
  agent_model        AgentModel  @relation(fields: [agent_model_id], references: [id], onDelete: Cascade, onUpdate: Cascade)
  origin             ModelOrigin
  upstream_model     String?
  context_tokens     Int?
  max_context_tokens Int?
  max_output_tokens  Int?
  quantization       String?
  params_total_b     Decimal?  @db.Decimal(10, 2)
  params_active_b    Decimal?  @db.Decimal(10, 2)
  capabilities       String[]  @default([])
  reasoning_efforts  String[]  @default([])
  created_at         DateTime  @default(now())
  updated_at         DateTime  @updatedAt

  @@map("agent_model_facts")
}

model AgentModel {
  // … bestaande velden ongewijzigd …
  facts AgentModelFacts?   // alleen een Prisma-back-relation; geen DB-kolom
}
```

- **De back-relation op `AgentModel`** bestaat alleen in Prisma en verandert de tabel niet. Precedent: de back-relation op `Product` in `0a56c53b`.
- **Engelse enumwaarden** volgen het patroon van `BillingMode` (keuze 1). De UI-labels zijn Abonnement, Remote en Lokaal. Het woord "herkomst" komt niet in de UI, vanwege "modelherkomst" in usage-detail.
- **`origin` is NOT NULL op een facts-rij.** Een facts-rij bestaat alleen als iemand de herkomst bewust heeft vastgelegd.
- **Betekenis van de velden:**
  - `upstream_model`: het onderliggende model, volgens de afspraak in §4.2;
  - `context_tokens`: de context die de configuratie gebruikt (= `contextTokens`); `max_context_tokens` is wat het model maximaal aankan;
  - `params_*_b`: het aantal parameters in miljarden (actief alleen bij MoE);
  - `capabilities` en `reasoning_efforts`: gedeclareerd, niet gemeten.

### 4.2 Gedeelde helpers (scrum4me-shared `lib/`)

**Nieuw: `lib/model-registry-fields.ts`.** Prisma-vrij, zoals `harness-config.ts`.
- `MODEL_ORIGINS = ['SUBSCRIPTION', 'REMOTE', 'LOCAL']` en `MODEL_ORIGIN_LABELS` (Abonnement, Remote, Lokaal).
- `MODEL_CAPABILITIES = ['tools', 'reasoning', 'vision', 'prompt_caching', 'structured_output']`.
- `REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']`.
- `isHostedOrigin(origin: string | null | undefined): boolean` geeft `origin !== 'LOCAL'`. Een ontbrekende facts-rij (`null`) geldt dus als gehost.
- `registrySection(runtime: string, origin: string | null | undefined)`:
  - CLAUDE/CODEX geven altijd `SUBSCRIPTION`;
  - HARNESS geeft `origin` als dat REMOTE of LOCAL is, en anders `REMOTE`. Een HARNESS-rij zonder (geldige) facts-rij komt dus fail-safe onder Remote.
- `allowedOrigins(runtime)`: CLAUDE en CODEX krijgen `['SUBSCRIPTION']`, HARNESS krijgt `['REMOTE', 'LOCAL']`.
- `validateModelFacts(runtime, facts)` geeft een lijst met leesbare fouten:
  - `origin` moet in `allowedOrigins` staan;
  - `LOCAL` vereist een `upstream_model` die met `ollama/` begint en daarna niet leeg is (de LOKAAL-regel, besluit 11);
  - de getallen zijn gehele getallen groter dan 0, en `context_tokens` is hoogstens `max_context_tokens` als beide gezet zijn;
  - `capabilities` en `reasoning_efforts` komen uit de const-lijsten, zonder dubbele waarden;
  - `reasoning_efforts` mag alleen gevuld zijn als `capabilities` `reasoning` bevat;
  - `quantization` en `upstream_model` worden getrimd en zijn hoogstens 100 tekens.

**Afspraak voor `upstream_model`:**
- REMOTE: de LiteLLM-modelstring, bijvoorbeeld `openrouter/qwen/qwen3.8-27b`.
- LOCAL: `ollama/` plus de Ollama-tag, bijvoorbeeld `ollama/qwen3.8-gsq-rco:27b-iq3_s-text`.
- SUBSCRIPTION: leeg.

**Eerlijk over de LOKAAL-regel:** de `ollama/`-voorwaarde is een naamafspraak, geen bewijs. Ze vangt een per ongeluk omgezette keuze (Lokaal kiezen bij `openrouter/…`), maar geen opzettelijk verkeerde invoer. De echte controle is de driftcheck (§4.6), die de herkomst afleidt uit `costMode` en `api_base`.

**`lib/harness-config.ts`:** `HARNESS_LOCAL_CONFIGURATIONS` en `isHostedHarnessConfiguration` vervallen, nadat Scrum4Me is omgezet (§4.4, §4.9 stap 4).

**Tests in shared:**
- Nieuw `__tests__/model-registry-fields.test.ts`:
  - `isHostedOrigin`: alleen LOCAL is niet-gehost; REMOTE, SUBSCRIPTION, `null`, `undefined` en een onbekende string zijn gehost;
  - `registrySection` voor elke runtime, met en zonder origin;
  - elke regel van `validateModelFacts`.
- `listPriceKey('HARNESS', 'qwen3.8-or')` blijft `null`, en `LIST_PRICE_PROVIDERS` heeft precies de sleutels CLAUDE en CODEX (besluit 6).
- De schematest pint de enum, het model `AgentModelFacts` (kolommen, FK met cascade, `@@map`) en dat `AgentModel` geen nieuwe scalaire velden krijgt.
- Bij het weghalen van de oude lijst vervallen `__tests__/harness-config.test.ts:223-232`.

### 4.3 Migratie, backfill en contract (Scrum4Me)

**Map:** `prisma/migrations/<ts>_agent_model_facts/migration.sql`. De vorm volgt `20261019120000_product_access_steps`:
- de header-comment noemt het additieve karakter, de spec en de `migrate diff`-bron;
- de SQL bevat geen GRANT en geen REVOKE.

```sql
-- CreateEnum
CREATE TYPE "ModelOrigin" AS ENUM ('SUBSCRIPTION', 'REMOTE', 'LOCAL');

-- CreateTable
CREATE TABLE "agent_model_facts" (
    "agent_model_id" TEXT NOT NULL,
    "origin" "ModelOrigin" NOT NULL,
    "upstream_model" TEXT,
    "context_tokens" INTEGER,
    "max_context_tokens" INTEGER,
    "max_output_tokens" INTEGER,
    "quantization" TEXT,
    "params_total_b" DECIMAL(10,2),
    "params_active_b" DECIMAL(10,2),
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasoning_efforts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_model_facts_pkey" PRIMARY KEY ("agent_model_id")
);

-- AddForeignKey
ALTER TABLE "agent_model_facts" ADD CONSTRAINT "agent_model_facts_agent_model_id_fkey"
  FOREIGN KEY ("agent_model_id") REFERENCES "agent_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (data): elke HARNESS-rij krijgt een facts-rij; gsq-lokaal is LOCAL.
INSERT INTO "agent_model_facts" ("agent_model_id", "origin", "upstream_model", "quantization", "context_tokens", "updated_at")
SELECT "id",
       CASE WHEN "model_id" = 'gsq-lokaal' THEN 'LOCAL'::"ModelOrigin" ELSE 'REMOTE'::"ModelOrigin" END,
       CASE WHEN "model_id" = 'gsq-lokaal' THEN 'ollama/qwen3.8-gsq-rco:27b-iq3_s-text' END,
       CASE WHEN "model_id" = 'gsq-lokaal' THEN 'iq3_s' END,
       CASE WHEN "model_id" = 'gsq-lokaal' THEN 65536 END,
       CURRENT_TIMESTAMP
FROM "agent_models" WHERE "runtime" = 'HARNESS';
```

De exacte DDL komt uit `prisma migrate diff` tegen het schema van `origin/main` (zoals het precedent); daarna komt de backfill er met de hand bij.

- **CLAUDE/CODEX krijgen geen facts-rij** in I1. Hun sectie volgt uit de runtime (`registrySection`), en ze zijn al gehost.
- **Een HARNESS-rij die later zonder facts-rij ontstaat** (een oude workers-client), komt onder Remote en geldt als gehost. De driftcheck meldt hem (§4.6).

**Contract** in `scripts/db-access/profiles/scrum4me.json` (achteraan `contracts`, zoals het precedent):

```json
{ "key": "public.table.agent_model_facts",
  "privileges": { "web": ["SELECT","INSERT","UPDATE","DELETE"], "preparedWeb": ["SELECT","INSERT","UPDATE","DELETE"],
                  "queue": [], "observer": ["SELECT"], "dispatch": [], "projector": [] },
  "publicPrivileges": [], "migrationId": "<ts>_agent_model_facts" }
```

- `web`/`preparedWeb` spiegelen `agent_models`.
- `observer` (`ops_readonly`) krijgt SELECT voor de read-only driftcheck (§4.6).
- `dispatch` en `projector` blijven leeg; zo eist het additieve contract het. Geen bestaande dispatch-lezer heeft de feiten nodig.
- Het enumtype krijgt geen contract (precedent).

**Tests**, naar het model van het precedent:
- `__tests__/db/agent-model-facts-migration.test.ts`: pint de enum, de tabel, de FK met cascade, het ontbreken van GRANT/REVOKE en de backfill, plus dat de migratie geen `ALTER TABLE "agent_models"` bevat.
- `__tests__/lib/db-access/agent-model-facts-contract.test.ts`: het contract voldoet aan de voorwaarden voor een additief contract (`splitAdditiveContracts` accepteert het), en de gesloten set hasht nog naar de pin.
- `npm run test:dispatch` en `test:dispatch:chain` zijn groen. Die spelen de additieve migratie na de adoptie af en controleren dat `agent_models` niet afwijkt.

**Uitrol** gaat in de gewone web-deploy, via de operator-route (migratie plus `applyContracts`).

### 4.4 Chat (Scrum4Me)

Eén pure functie zet de herkomst om naar `hosted`: `isHostedOrigin`.

- **`app/(app)/chat/layout.tsx`:** de bestaande `agentModel.findMany` krijgt `facts: { select: { origin: true } }` in de select. Het samenstellen van de opties verhuist naar een pure functie in `lib/agent-chat/` (bijv. `toChatModelOptions(rows)`), met `hosted: isHostedOrigin(row.facts?.origin)`.
- **`app/(app)/chat/[id]/page.tsx`:**
  - `getAgentChatView` (`lib/agent-chat/chats-server.ts`) zoekt de herkomst van `chat.configuration` op, met `agentModel.findFirst({ where: { runtime: 'HARNESS', model_id }, select: { facts: { select: { origin: true } } } })`. Er is bewust geen `active`-filter.
  - Hij levert `origin: ModelOrigin | null`, en de pagina zet `hosted: isHostedOrigin(view.origin)`.
- **Het label volgt de herkomst, niet `active`** (keuze 3). Een inactieve LOCAL-configuratie toont geen "gehost"; verzenden wordt bij een inactieve configuratie al geweigerd. Zonder registry-rij of facts-rij is de herkomst `null`, dus gehost.
- **Commentaar bijwerken:** de JSDoc in `components/agent-chat/model-picker.tsx:26` en `components/agent-chat/chat-window.tsx:50` noemt `isHostedHarnessConfiguration`. Die regels worden bijgewerkt naar `isHostedOrigin`.
- **Tests:**
  - `getAgentChatView` met een gemockte `db` (zoals `__tests__/lib/agent-chat-view.test.ts`). Hij levert LOCAL, REMOTE of `null`, en de query heeft geen `active`-filter; die wordt in de mock-aanroep geasserteerd.
  - `toChatModelOptions`: LOCAL geeft niet-gehost, ook bij een inactieve rij; REMOTE, SUBSCRIPTION en een ontbrekende facts-rij geven gehost.
  - De bestaande tests van `model-picker` en `chat-window` blijven ongewijzigd groen.
- **In dezelfde PR:** de submodule-bump naar de shared-commit uit §4.1–4.2, `gen-schema`, de migratie en het contract (§4.3).

### 4.5 `/settings/models` in drie secties (workers, I1)

**`lib/settings/model-registry.ts`:** `listModelsWithPrices` haalt `facts` mee (`include`/`select`). `ModelWithPrice` krijgt `origin` (`facts?.origin ?? null`), `section` (`registrySection(runtime, origin)`) en de beschrijvende velden. De `Decimal`-waarden gaan via `Number()`. De prijskoppeling via `listPriceKey` blijft, dus HARNESS heeft in I1 nog geen prijs.

**`components/settings/model-registry-editor.tsx`:**
- Drie secties op `section`, in de volgorde Abonnement, Remote, Lokaal. Elke sectie is een eigen `DataTable` met een eigen `useLocalTableSort` (storage key `scrum4me-workers:settings:models:<section>:sort:v1`). Een lege sectie toont "Geen modellen".
- Kolommen:

  | Sectie | Kolommen |
  |---|---|
  | Abonnement | runtime, model_id, weergavenaam, API-prijs in/out (+ cache), actief, acties (zoals nu) |
  | Remote | model_id, weergavenaam, onderliggend model, context (in gebruik / max), quant, capabilities, prijs in/out (I1: "—"), actief |
  | Lokaal | model_id, weergavenaam, onderliggend model, context, quant, capabilities, actief |

- Binnen Remote en Lokaal sorteert de tabel standaard op onderliggend model en daarna op `model_id`.
- Een leeg veld toont "—". Een HARNESS-rij zonder facts-rij krijgt in Remote de aanduiding "herkomst niet vastgelegd".

**Formulier "Model toevoegen":**
- Bij HARNESS komt er een verplichte keuze **Remote / Lokaal**, zonder voorkeuze, en een veld "onderliggend model": verplicht bij Lokaal (met de `ollama/`-hint), optioneel bij Remote.
- **`actions/model-registry.ts`:**
  - het strikte HARNESS-schema krijgt `origin` (`REMOTE` | `LOCAL`) en `upstream_model` erbij, en valideert met `validateModelFacts` vóór elke DB-aanroep;
  - in dezelfde transactie als de `agentModel.upsert` volgt een `agentModelFacts.upsert` op `agent_model_id` met `origin` en `upstream_model`;
  - CLAUDE/CODEX krijgen geen facts-rij.
- **Tests:**
  - de editor rendert drie secties, met elke rij in de juiste sectie, ook een HARNESS-rij zonder facts;
  - HARNESS zonder keuze wordt geweigerd zonder DB-aanroep;
  - Lokaal zonder of met een verkeerd `ollama/`-model wordt geweigerd, met de exacte fout;
  - de facts-upsert gebeurt in dezelfde transactie;
  - de HARNESS-payload heeft precies de nieuwe sleutels;
  - sorteren per sectie.

Herkomst en feiten van een **bestaande** rij bewerken komt in I2; de backfill dekt de huidige HARNESS-rijen.

**In dezelfde PR:** de submodule-bump van workers van `f1e78df` naar de nieuwe shared-commit. Die neemt `c79f6e3` en `cd01a69` mee, die al in de DB staan.

### 4.6 Driftcheck (workers, I1)

**Script:** `scripts/check-harness-registry.ts`, als `npm run db:check-harness-registry -- --harness-repo <pad>`. Read-only en zonder toegang tot max2. De vergelijkingslogica staat in een pure module (bijv. `lib/settings/harness-registry-drift.ts`).

**Invoer:**
- `<pad>/deploy/max2/harness.json` (`configurations`);
- `<pad>/deploy/max2/litellm/config.yaml` (`model_list`), geparset met `yaml` (al een dependency). Aliassen lost `parse` standaard op. Merge-keys (`<<`) vereisen in `yaml` v2 de optie `{ merge: true }`; het script zet die, zodat een latere merge in de config niet stil een verkeerd `extra_body` geeft;
- de DB via `DATABASE_URL`: alle HARNESS-rijen in `agent_models` met hun facts-rij. Alleen lezen; de rol `ops_readonly` volstaat (SELECT op beide tabellen).

**Verwacht per configuratie:**
- **origin:** uit `costMode` (`local` → LOCAL, `hosted` → REMOTE), want daarmee rekent de harness zelf.
  - Kruiscontrole met de LiteLLM-regel van dezelfde naam: `api_base` naar de Ollama-bridge (poort 11434) betekent lokaal, `openrouter/…` betekent remote.
  - Spreken ze elkaar tegen, of heeft een configuratie geen LiteLLM-regel (of andersom), dan is dat een (c)-bevinding.
- **upstream_model:**
  - REMOTE: `litellm_params.model`;
  - LOCAL: `ollama/` plus `litellm_params.model` zonder het voorvoegsel `openai/`.
- **context_tokens:** `contextTokens`.
- **quantization:**
  - REMOTE: `extra_body.provider.quantizations`, met komma's samengevoegd;
  - LOCAL: niet afgeleid. De DB-waarde moet hoofdletterongevoelig in de Ollama-tag voorkomen.

**Uitvoer:**

| Sectie | Betekenis | Telt als drift |
|---|---|---|
| (a) | configuratie zonder registry-rij | ja |
| (b) | actieve HARNESS-rij zonder configuratie | ja |
| (c) | **ernstig, raakt het label "gehost":** herkomst wijkt af, een HARNESS-rij heeft geen facts-rij, `harness.json` en LiteLLM spreken elkaar tegen, of een configuratie mist haar LiteLLM-regel | ja |
| (d) | waarde wijkt af (beide gezet, verschillend) | ja |
| (e) | DB-waarde ontbreekt (behalve origin) | nee, alleen info |

Een slotregel geeft per sectie het aantal.

**Exitcodes:**
- 0 zonder drift in (a)–(d);
- 1 bij drift in (a)–(d);
- 2 bij een gebruiks- of leesfout (ontbrekend pad, ongeldige JSON of YAML, geen DB).

Dit wijkt bewust af van `db:sync-model-prices` in Scrum4Me, dat ook bij drift 0 geeft. Een herkomstverschil moet kunnen falen.

**Tests:**
- fixtures met een kleine `harness.json` en een `config.yaml` met een anchor, een alias en een merge-key;
- elke sectie (a)–(e), waaronder een configuratie zonder LiteLLM-regel en een HARNESS-rij zonder facts;
- de afleiding van de lokale `upstream_model`;
- elke exitcode.

**Wanneer draaien:** agent-harness `docs/runbooks/harness-service-max2.md` krijgt bij het toevoegen of wijzigen van een configuratie één stap: "zet de rij in `/settings/models` met de juiste herkomst en draai de driftcheck tegen je checkout (DB-rol `ops_readonly`)". Dat is een doc-wijziging, zonder cron of CI.

### 4.7 Velden bewerken (workers, I2)

- **Bewerken** wordt beschikbaar voor elke rij. Het opent een detailpaneel met:
  - herkomst (alleen bij HARNESS: Remote/Lokaal);
  - onderliggend model, context in gebruik, maximale context, max output tokens, quantisatie, parameters totaal en actief;
  - capabilities als aankruisvakjes, en reasoning-efforts als aankruisvakjes die alleen actief zijn als `reasoning` aan staat.
- **Nieuwe actie:** `updateModelFactsAction(agentModelId, input)`, met een strikt zod-schema, `validateModelFacts` en `requireWorkersAdmin`. Hij doet een upsert van de facts-rij. Voor CLAUDE/CODEX wordt `origin` daarbij server-side `SUBSCRIPTION`.
- **Tests:**
  - elke validatieregel komt aan in de UI;
  - een mislukte opslag houdt het paneel open;
  - LOCAL omzetten naar REMOTE en weer terug;
  - een eerste bewerking van een CLAUDE-rij maakt een facts-rij met SUBSCRIPTION.

### 4.8 REMOTE-lijstprijs (workers, I3)

- `updateModelPricesAction` accepteert een HARNESS-rij waarvan de sectie Remote is. Een LOCAL-rij weigert hij met "Lokale configuraties hebben geen prijs.".
- **Het prijsrecord** is een `model_prices`-rij (alleen data) met runtime HARNESS, provider `openrouter`, API/USD/standard en `model_id` = de configuratienaam. `cache_read`/`cache_write` staan op 0 (keuze 4); de UI toont voor Remote alleen in en out.
- **Prijs per configuratie:** de vier `qwen3.8-or*` krijgen elk een eigen rij.
- **Opzoeken:** `listModelsWithPrices` zoekt de REMOTE-prijs op met een eigen sleutel in workers, `harnessListPriceKey(model_id)`, en **niet** via `LIST_PRICE_PROVIDERS`.
- **Tests:**
  - de test "HARNESS heeft nooit een prijs" (`__tests__/lib/model-registry.test.ts:116`) verandert bewust: REMOTE met een prijsrij geeft een prijs, LOCAL blijft null;
  - een HARNESS/openrouter-prijsrij verandert de uitkomst van `jobs-mapper` niet.

### 4.9 Volgorde en uitrol (I1)

1. **scrum4me-shared PR:** de enum, `AgentModelFacts`, de back-relation, `model-registry-fields.ts` en de tests. Merge naar main.
2. **Scrum4Me PR:** de bump, `gen-schema`, de migratie met backfill, het contract met tests, en de chat-omzetting met tests. CI groen, inclusief `test:dispatch` en `test:dispatch:chain`. Deploy via de gewone web-deploy; de migratie en het contract gaan via de operator-route.
3. **scrum4me-workers PR:** de bump, de drie secties, het formulier en de actie, de driftcheck met tests.
   - Schrijven en reviewen kan parallel met stap 2.
   - **De workers-deploy wacht tot de migratie van stap 2 live is in productie.** De nieuwe workers-client leest en schrijft `agent_model_facts`, en zonder migratie faalt `/settings/models` ("relation does not exist").
   - Workers deployt niet automatisch bij een merge; de poort zit dus op de deploy.
4. **scrum4me-shared PR:** de oude naamlijst weg, nadat stap 2 gemerged is.
5. **agent-harness PR (alleen docs):** de runbookstap uit §4.6.
6. **Praktijkproef met JP:**
   - de drie secties bekijken;
   - de chat-modelkiezer: alleen `gsq-lokaal` zonder "gehost";
   - de driftcheck tegen productie als `ops_readonly`: (c) en (d) zijn nul (zie §5.6).
7. **scrum4me-mcp:** geen wijziging. Er verandert geen bestaande tabel, dus een oudere client merkt niets. De volgende gewone bump neemt het schema mee, en dat mag pas na stap 2.

## 5. Acceptatiecriteria

**I1**
1. Groen:
   - shared, Scrum4Me en workers: `npm run verify`;
   - Scrum4Me en workers: `npm run build`;
   - Scrum4Me: `npm run test:dispatch` en `test:dispatch:chain`.

   Nieuwe tests zijn aantoonbaar rood zonder de wijziging.
2. **Na de deploy van stap 2:**
   - `agent_models` is byte-gelijk; de policy-check geeft geen `SCHEMA_DRIFT`;
   - elke HARNESS-rij heeft een facts-rij: `gsq-lokaal` LOCAL met `upstream_model = 'ollama/qwen3.8-gsq-rco:27b-iq3_s-text'`, de rest REMOTE;
   - CLAUDE/CODEX hebben geen facts-rij.
3. **Geen import of aanroep meer** van `HARNESS_LOCAL_CONFIGURATIONS` of `isHostedHarnessConfiguration`, ook niet in commentaar. Een grep op `origin/main` van shared, Scrum4Me, workers, scrum4me-mcp, scrum4me-copilot en Ops-dashboard, na stap 4, geeft nul treffers buiten docs en buiten de submodulemap `vendor/`.
4. De chat-modelkiezer en de chatpagina tonen "gehost" voor elke configuratie behalve `gsq-lokaal` (actief of niet). Een configuratie zonder registry- of facts-rij geldt als gehost.
5. `/settings/models` toont drie secties met de kolommen uit §4.5. Een HARNESS-rij toevoegen zonder keuze, of als Lokaal zonder `ollama/`-model, wordt geweigerd. Een geldige HARNESS-rij krijgt in dezelfde transactie haar facts-rij.
6. **Driftcheck tegen productie en agent-harness `main`:** nul bevindingen in (c) en (d).
   - De proef wordt beoordeeld op die twee secties, niet op de exitcode.
   - Bestaande (a)/(b)-meldingen uit de registry-data van vóór I1 (bijv. proefconfiguraties) gaan naar JP, die beslist over het opruimen. Ze tellen niet als gebrek van I1, maar geven wel exit 1.
   - Een bewust omgezette herkomst in een fixture geeft exit 1 met sectie (c).
7. `listPriceKey('HARNESS', …)` is `null`, gepind in een shared-test.

**I2**
8. Elk veld uit §4.1 is per rij te bewerken met de validatie uit §4.2. Na het invullen meldt de driftcheck voor de ingevulde rijen geen (e) meer.

**I3**
9. REMOTE-rijen tonen een bewerkbare lijstprijs. LOCAL toont "n.v.t." en weigert een prijs. De kostenschermen (jobs, usage, insights) geven voor HARNESS-jobs dezelfde uitkomst als vóór I3.

## 6. Risico's en open punten

- **Additief contract.** De voorwaarden en het precedent staan in §3. Het contract-testbestand (§4.3) en `test:dispatch` bewijzen ze vóór de merge. Faalt `splitAdditiveContracts` toch, dan stopt de taak en gaat de vraag naar JP; er komt geen ander db-access-pad.
- **De workers-DB-rol.** Het contract geeft `web` en `preparedWeb` dezelfde rechten als op `agent_models`. Welke van de twee workers gebruikt, controleert de workers-taak, zodat de facts-upsert niet op een ontbrekend recht stuit.
- **Workers-bump.** Die neemt `c79f6e3` en `cd01a69` mee, die al in de DB staan. De workers-taak moet ook met die wijzigingen groen zijn.
- **De LOKAAL-regel is een afspraak.** Zie §4.2. De driftcheck en de runbookstap zijn de borging. Er komt geen CHECK-constraint (keuze 5).
- **Quant-namen** zijn vrije tekst, dus de vergelijking in de driftcheck is voor LOCAL een substring-controle. Dat is bewust grof.
- **Ceremonie.** Sprint en PBI komen onder scrum4me-workers (besluit 10). Of `create_sprint`/`create_pbi` een `idea_id` van een ander product accepteert, blijkt pas bij de ceremonie. Lukt dat niet, dan beslist JP.
- **Raakvlak:** IDEA-270 (remote modellen voor reviews) en IDEA-229 (OpenRouter API) kunnen deze velden later gebruiken. Ze vallen buiten deze spec.

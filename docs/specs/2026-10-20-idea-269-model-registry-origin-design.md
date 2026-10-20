---
title: "IDEA-269 — Herkomst en modelfeiten in de model-registry"
status: draft
last_updated: 2026-10-20
revision: 2
---

# IDEA-269 — Herkomst en modelfeiten in de model-registry

Spec voor IDEA-269 "Toevoegen remote en lokale modellen". Ze bouwt op de grill van 2026-10-20 (grill-doc revisie 2; beslissingen 1–12 staan als DECISION in de idee-tijdlijn). Waar deze spec een keuze maakt die de grill openliet, staat dat er expliciet bij. Deze repo-kopie is gelijk aan de ProductDoc `IDEA-269-spec` (product Agent-harness).

Revisie 2 brengt drie wijzigingen:
- een inactieve LOCAL-rij geldt als niet-gehost (§4.4);
- de workers-uitrol wacht op de migratie (§4.9);
- de verwachting voor de driftcheck in de praktijkproef is aangescherpt (§5).

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP):** "lokale modellen en openrouter modellen (…) in dezelfde fysieke tabel, maar ik wil ze visueel scheiden", met een veld voor abonnement/lokaal/remote, de context, de capabilities en de quantisatie. JP wil daarop modellen kunnen beoordelen naast de prijs.

**Eerste resultaat (I1):**
- JP opent workers `/settings/models` en ziet drie secties: Abonnement, Remote en Lokaal.
- In de chat-modelkiezer van Scrum4Me staat "gehost" alleen bij de niet-lokale configuraties. Die waarde komt uit de registry, niet meer uit een lijst in code.
- De driftcheck tegen de productie-DB en de repo-kopie van de harness-config meldt geen herkomstverschil.

**Niet-doelen:**
- Gemeten prestaties (probe, bench, snelheid) en beleid & fit (data-collectie, licentie, geheugen).
- Een aparte modeltabel of een lijst met beschikbare quants.
- Een DB die `harness.json` of LiteLLM aanstuurt of genereert.
- Groepering in de keuzelijsten.
- Nieuwe `AgentRuntime`-waarden.
- HARNESS in `LIST_PRICE_PROVIDERS`.
- Een cron- of CI-driftcheck.

## 2. Besluiten (uit de grill)

| # | Besluit |
|---|---|
| 1 | Eén rij is een kiesbare configuratie, in `agent_models`. Er komt een optioneel veld voor het onderliggende model. |
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
| 12 | De herkomst is NOT NULL en een enum. Capabilities zijn `String[]` gevalideerd in shared. Volgorde: shared → migratie → bump → UI. |

JP bevestigde daarnaast vijf spec-keuzes op 2026-10-20:
- Engelse enumwaarden met Nederlandse labels;
- DB-default `SUBSCRIPTION`;
- een inactieve LOCAL-rij is niet-gehost;
- in I3 één REMOTE-prijs per configuratie, met cacheprijzen op 0;
- geen DB-CHECK voor de LOKAAL-regel.

## 3. Uitgangssituatie

Zie het grill-doc voor de volledige inventaris. De punten die het ontwerp sturen:

- **Schema:** `AgentModel` staat in scrum4me-shared `prisma/schema.prisma:855-868`. Scrum4Me en workers vendoren shared als git-submodule (`vendor/scrum4me-shared`). Hun `prisma/schema.prisma` wordt gegenereerd (`scripts/gen-schema.sh`).
  - Scrum4Me is gepind op `8df7f2c` (shared main).
  - Workers is gepind op `f1e78df`; daartussen zitten twee schema-commits (`c79f6e3` usage issue-scope, `cd01a69` ProductAccessStep), die al in de DB staan.
- **Migraties** staan alleen in Scrum4Me (`prisma/migrations/<YYYYMMDDHHMMSS>_<naam>`).
  - Precedent voor een kolom op een bestaande tabel: `753ca451` (`login_pairing_session_duration`) en `4baffa6a` (`usage_issue_scope`). Die raakten de submodule-pin, het schema, `migration.sql` en een test in `__tests__/db/*-migration.test.ts`, maar niet het db-access-profiel.
  - Uitrol gaat alleen via de operator-route in de gewone web-deploy, nooit met een kale `prisma migrate deploy`. Volgorde bij uitrol: eerst de Scrum4Me-migratie, dan pas workers en mcp met het nieuwe schema.
- **Workers deployt niet automatisch:** CI (`.forgejo/workflows/ci.yml`) draait alleen verify.
- **Wie schrijft in `agent_models`:**
  - de Scrum4Me-seed (`prisma/seed-data/agent-models.ts`, alleen CLAUDE/CODEX);
  - `scripts/add-model.ts` (alleen CLAUDE/CODEX);
  - workers `addModelAction` (alle runtimes; HARNESS alleen hier).
- **Wie leest de herkomst nu:** `isHostedHarnessConfiguration` wordt alleen in Scrum4Me gebruikt, in `app/(app)/chat/layout.tsx:57` en `app/(app)/chat/[id]/page.tsx:34`.
  - `[id]/page.tsx` leest `agentModel` nu niet; `getAgentChatView` levert alleen `configuration`.
  - Een inactieve configuratie wordt bij verzenden al geweigerd met 409 (`lib/agent-chat/send-server.ts:40-44`).
  - Er zijn geen servertests voor de omzetting naar `hosted`. `model-picker` en `chat-window` krijgen `hosted` als prop.
- **Kosten:** alle kostenschermen koppelen `model_prices` via `listPriceJoinSqlText`/`listPriceKey`, met `LIST_PRICE_PROVIDERS` (alleen CLAUDE en CODEX) in shared `lib/list-price.ts`.
- **Harness-config (repo-kopie in agent-harness `deploy/max2/`):**
  - `harness.json` bevat per configuratie `costMode` (local/hosted) en `contextTokens`.
  - `litellm/config.yaml` bevat per `model_name` de `litellm_params.model`, `api_base` en `extra_body.provider.quantizations`, met YAML-anchors en -aliassen.
  - Het lokale model is `openai/qwen3.8-gsq-rco:27b-iq3_s-text`, met `api_base` naar de Ollama-bridge `172.30.82.1:11434`. De prefix zegt dus niet "lokaal".
- **Woordgebruik:** workers gebruikt "modelherkomst" al voor iets anders (`components/usage/usage-detail.tsx:249`).

## 4. Ontwerp

### 4.1 Schema (scrum4me-shared)

```prisma
/// IDEA-269: waar een registry-rij draait. Stuurt de secties op /settings/models
/// en het label "gehost" in de chat. Alleen LOCAL geldt als niet-gehost.
enum ModelOrigin {
  SUBSCRIPTION
  REMOTE
  LOCAL
}

model AgentModel {
  // … bestaande velden ongewijzigd …
  origin             ModelOrigin @default(SUBSCRIPTION)
  upstream_model     String?
  context_tokens     Int?
  max_context_tokens Int?
  max_output_tokens  Int?
  quantization       String?
  params_total_b     Decimal?    @db.Decimal(10, 2)
  params_active_b    Decimal?    @db.Decimal(10, 2)
  capabilities       String[]    @default([])
  reasoning_efforts  String[]    @default([])
}
```

**Keuze: Engelse enumwaarden.** De grill sprak van ABONNEMENT/REMOTE/LOKAAL. Het schema volgt het patroon van `BillingMode` (`SUBSCRIPTION`, `API`), dus de enum is Engels. De UI-labels zijn Abonnement, Remote en Lokaal. Het woord "herkomst" komt niet in de UI, vanwege "modelherkomst" in usage-detail.

**Keuze: DB-default `SUBSCRIPTION`.** Zonder default breken de create-payloads van de seed en `add-model.ts`.
- Die schrijven alleen CLAUDE/CODEX, dus `SUBSCRIPTION` houdt elke bestaande schrijver correct zonder codewijziging.
- HARNESS-rijen komen alleen via de workers-actie binnen. Die eist voortaan een expliciete keuze tussen REMOTE en LOCAL (besluit 12).
- De default is dus alleen een vangnet voor een oudere client. Hij is privacy-veilig, want elke waarde behalve `LOCAL` geldt als gehost.
- Een HARNESS-rij die een oude workers-client zonder herkomst invoegt, komt onder Abonnement terecht; de driftcheck meldt dat (§4.6).

**Betekenis van de velden:**
- `upstream_model`: het onderliggende model, volgens de afspraak in §4.2.
- `context_tokens`: de context die de configuratie gebruikt (= `contextTokens`). `max_context_tokens` is wat het model maximaal aankan.
- `params_*_b`: het aantal parameters in miljarden (actief alleen bij MoE).
- `capabilities` en `reasoning_efforts`: gedeclareerde waarden uit de modelkaart of de aanbieder, niet gemeten.

### 4.2 Gedeelde helpers (scrum4me-shared `lib/`)

**Nieuw: `lib/model-registry-fields.ts`.** Prisma-vrij, zoals `harness-config.ts`.
- `MODEL_ORIGINS = ['SUBSCRIPTION', 'REMOTE', 'LOCAL']` en `MODEL_ORIGIN_LABELS` (Abonnement, Remote, Lokaal).
- `MODEL_CAPABILITIES = ['tools', 'reasoning', 'vision', 'prompt_caching', 'structured_output']`.
- `REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']`.
- `isHostedOrigin(origin: string | null | undefined): boolean` geeft `origin !== 'LOCAL'`. Een ontbrekende rij of waarde geldt dus als gehost.
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

**Eerlijk over de LOKAAL-regel:** de `ollama/`-voorwaarde is een naamafspraak, geen bewijs. Ze vangt een per ongeluk omgezette keuze (Lokaal kiezen bij een rij met `openrouter/…`), maar geen opzettelijk verkeerde invoer. De echte controle is de driftcheck (§4.6), die de herkomst afleidt uit `costMode` en `api_base`.

**`lib/harness-config.ts`:** `HARNESS_LOCAL_CONFIGURATIONS` en `isHostedHarnessConfiguration` vervallen, nadat Scrum4Me is omgezet (§4.4).

**Tests in shared:**
- Nieuw `__tests__/model-registry-fields.test.ts`:
  - `isHostedOrigin`: alleen LOCAL is niet-gehost; REMOTE, SUBSCRIPTION, `null`, `undefined` en een onbekende string zijn gehost;
  - elke regel van `validateModelFacts`.
- `listPriceKey('HARNESS', 'qwen3.8-or')` blijft `null`, en `LIST_PRICE_PROVIDERS` heeft precies de sleutels CLAUDE en CODEX (besluit 6).
- De schematest pint de nieuwe enum, de kolommen en de default.
- `__tests__/harness-config.test.ts:223-231` vervalt bij het weghalen van de oude lijst.

### 4.3 Migratie en backfill (Scrum4Me)

**Map:** `prisma/migrations/<ts>_agent_model_origin_and_facts/migration.sql`.

```sql
CREATE TYPE "ModelOrigin" AS ENUM ('SUBSCRIPTION', 'REMOTE', 'LOCAL');

ALTER TABLE "agent_models"
  ADD COLUMN "origin" "ModelOrigin" NOT NULL DEFAULT 'SUBSCRIPTION',
  ADD COLUMN "upstream_model" TEXT,
  ADD COLUMN "context_tokens" INTEGER,
  ADD COLUMN "max_context_tokens" INTEGER,
  ADD COLUMN "max_output_tokens" INTEGER,
  ADD COLUMN "quantization" TEXT,
  ADD COLUMN "params_total_b" DECIMAL(10,2),
  ADD COLUMN "params_active_b" DECIMAL(10,2),
  ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reasoning_efforts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "agent_models" SET "origin" = 'REMOTE' WHERE "runtime" = 'HARNESS';

UPDATE "agent_models"
SET "origin" = 'LOCAL',
    "upstream_model" = 'ollama/qwen3.8-gsq-rco:27b-iq3_s-text',
    "quantization" = 'iq3_s',
    "context_tokens" = 65536
WHERE "runtime" = 'HARNESS' AND "model_id" = 'gsq-lokaal';
```

- **Eén migratie is goed.** `CREATE TYPE` plus een kolom die het type gebruikt mag in één migratie. De Scrum4Me-regel "nieuwe enumwaarden in een eigen migratie" gaat over `ALTER TYPE … ADD VALUE`, en die komt hier niet voor.
- **Backfill:** de backfill van `gsq-lokaal` voldoet zelf aan de LOKAAL-regel. Andere HARNESS-rijen krijgen alleen `REMOTE`. Hun beschrijvende velden blijven leeg tot I2; de driftcheck noemt ze als "ontbreekt". Op een DB zonder HARNESS-rijen (dev) raken de UPDATEs niets.
- **Exacte vorm:** de SQL komt uit `prisma migrate diff` tegen het schema van `origin/main`, met de UPDATEs er met de hand bij, zoals het precedent `M45-2a` beschrijft.
- **Migratietest:** `__tests__/db/agent-model-origin-migration.test.ts`, naar het model van `usage-issue-scope-migration.test.ts`. Hij pint de enum, de kolommen, de defaults en de twee UPDATEs.
- **db-access:** de ADD COLUMN-precedenten raakten het profiel niet. Of een nieuw enumtype of een gewijzigd schema van `agent_models` een contract-, catalogus- of manifestregel vraagt, verifieert de plan-taak (zie §6).
- **Uitrol:** in de gewone web-deploy, via de operator-route.

### 4.4 Chat (Scrum4Me)

Eén plek zet de herkomst om naar `hosted`: `isHostedOrigin`. Die wordt getest waar hij gebruikt wordt.

- **`app/(app)/chat/layout.tsx`:** de bestaande `agentModel.findMany` selecteert ook `origin`, en `hosted` wordt `isHostedOrigin(m.origin)`.
- **`app/(app)/chat/[id]/page.tsx`:**
  - `getAgentChatView` (`lib/agent-chat/chats-server.ts`) zoekt voortaan de herkomst van `chat.configuration` op, met `agentModel.findFirst({ where: { runtime: 'HARNESS', model_id }, select: { origin: true } })`. Dat gebeurt zonder `active`-filter.
  - Hij levert `origin: ModelOrigin | null`, en de pagina zet `hosted: isHostedOrigin(view.origin)`.
- **Het label volgt de herkomst, niet `active`.** Een inactieve LOCAL-configuratie toont geen "gehost", want het verzenden wordt bij een inactieve configuratie al geweigerd (409 in `send-server.ts`). Zonder rij is de herkomst `null`, dus geldt de chat als gehost.
- **Tests:**
  - LOCAL geeft niet-gehost, ook bij een inactieve rij;
  - REMOTE, SUBSCRIPTION en een ontbrekende rij geven gehost;
  - de bestaande tests van `model-picker` en `chat-window` blijven ongewijzigd groen.
- **In dezelfde PR:** de submodule-bump van Scrum4Me naar de shared-commit uit §4.1–4.2, `gen-schema` en de migratie (§4.3).

### 4.5 `/settings/models` in drie secties (workers, I1)

**`lib/settings/model-registry.ts`:** `ModelWithPrice` krijgt `origin` en de beschrijvende velden. De `Decimal`-waarden gaan via `Number()`, zoals bij de prijzen. `listModelsWithPrices` blijft prijzen koppelen via `listPriceKey`, dus HARNESS heeft in I1 nog geen prijs.

**`components/settings/model-registry-editor.tsx`:**
- Drie secties in de volgorde Abonnement, Remote, Lokaal. Elke sectie is een eigen `DataTable` met een eigen sortering (`useLocalTableSort`, storage key `scrum4me-workers:settings:models:<origin>:sort:v1`). Een lege sectie toont "Geen modellen".
- Kolommen:

  | Sectie | Kolommen |
  |---|---|
  | Abonnement | runtime, model_id, weergavenaam, API-prijs in/out (+ cache), actief, acties (zoals nu) |
  | Remote | model_id, weergavenaam, onderliggend model, context (in gebruik / max), quant, capabilities, prijs in/out (I1: "—"), actief |
  | Lokaal | model_id, weergavenaam, onderliggend model, context, quant, capabilities, actief |

- Binnen Remote en Lokaal sorteert de tabel standaard op onderliggend model en daarna op `model_id`. Zo staan de configuraties van hetzelfde model bij elkaar (besluit 1).
- Een leeg veld toont "—".

**Formulier "Model toevoegen":**
- Bij HARNESS komt er een verplichte keuze **Remote / Lokaal**, zonder voorkeuze. Er komt ook een veld "onderliggend model": verplicht bij Lokaal (met de `ollama/`-hint), optioneel bij Remote.
- **`actions/model-registry.ts`:**
  - het strikte HARNESS-schema krijgt `origin` (`REMOTE` | `LOCAL`) en `upstream_model` erbij, en valideert met `validateModelFacts`;
  - de upsert schrijft beide;
  - CLAUDE en CODEX krijgen server-side `origin: 'SUBSCRIPTION'`.
- **Tests:**
  - de editor rendert drie secties, met de juiste rij in de juiste sectie;
  - HARNESS zonder keuze wordt geweigerd;
  - Lokaal zonder of met een verkeerd `ollama/`-model wordt geweigerd, met de exacte fout;
  - de HARNESS-payload krijgt precies de nieuwe sleutels;
  - de bestaande sorteertests per sectie.

In I1 kun je herkomst en velden van een **bestaande** rij nog niet bewerken: de backfill dekt de huidige rijen. Dat komt in I2.

**In dezelfde PR:** de submodule-bump van workers van `f1e78df` naar de nieuwe shared-commit. Die neemt `c79f6e3` en `cd01a69` mee; die staan al in de DB.

### 4.6 Driftcheck (workers, I1)

**Script:** `scripts/check-harness-registry.ts`, als `npm run db:check-harness-registry -- --harness-repo <pad>`. Read-only en zonder toegang tot max2.

**Invoer:**
- `<pad>/deploy/max2/harness.json` (`configurations`);
- `<pad>/deploy/max2/litellm/config.yaml` (`model_list`, geparset met `yaml`, dat al een dependency is; aliassen en merges worden opgelost);
- de DB via `DATABASE_URL`: alle HARNESS-rijen in `agent_models`.

**Verwacht per configuratie:**
- **origin:** uit `costMode` (`local` → LOCAL, `hosted` → REMOTE), want daarmee rekent de harness zelf. Kruiscontrole met LiteLLM: `api_base` naar de Ollama-bridge (poort 11434) betekent lokaal; `openrouter/…` betekent remote. Spreken `harness.json` en LiteLLM elkaar tegen, dan is dat een eigen bevinding.
- **upstream_model:**
  - REMOTE: `litellm_params.model`;
  - LOCAL: `ollama/` plus `litellm_params.model` zonder het voorvoegsel `openai/`.
- **context_tokens:** `contextTokens`.
- **quantization:**
  - REMOTE: `extra_body.provider.quantizations`, met komma's samengevoegd (bijv. `bf16` of `fp8`);
  - LOCAL: niet afgeleid. De DB-waarde moet hoofdletterongevoelig in de Ollama-tag voorkomen.

**Uitvoer:**

| Sectie | Betekenis | Telt als drift |
|---|---|---|
| (a) | configuratie zonder registry-rij | ja |
| (b) | actieve HARNESS-rij zonder configuratie | ja |
| (c) | herkomst wijkt af, of `harness.json` en LiteLLM spreken elkaar tegen (**ernstig**: raakt het label "gehost") | ja |
| (d) | waarde wijkt af (beide gezet, verschillend) | ja |
| (e) | DB-waarde ontbreekt | nee, alleen info |

Een slotregel geeft "geen drift" of "N drift-punt(en)".

**Exitcodes:**
- 0 zonder drift in (a)–(d);
- 1 bij drift in (a)–(d);
- 2 bij een gebruiks- of leesfout (ontbrekend pad, ongeldige JSON of YAML, geen DB).

Dit wijkt bewust af van `db:sync-model-prices` in Scrum4Me, dat ook bij drift 0 geeft: een herkomstverschil moet kunnen falen.

**Tests:** fixtures met een kleine `harness.json` en een `config.yaml` met anchors, plus een gemockte registry. Elke sectie (a)–(e), de afleiding van de lokale `upstream_model` en elke exitcode worden afgedekt.

**Wanneer draaien:** agent-harness `docs/runbooks/harness-service-max2.md` krijgt bij het toevoegen of wijzigen van een configuratie één stap: "zet de rij in `/settings/models` met de juiste herkomst en draai daarna de driftcheck tegen je checkout". Dat is een doc-wijziging, zonder cron of CI. De runbookstap noemt ook de toegestane read-only DB-route (§6).

### 4.7 Velden bewerken (workers, I2)

- **Bewerken** wordt beschikbaar voor elke rij. Het opent een detailpaneel met:
  - herkomst (alleen bij HARNESS: Remote/Lokaal);
  - onderliggend model, context in gebruik, maximale context, max output tokens, quantisatie, parameters totaal en actief;
  - capabilities als aankruisvakjes, en reasoning-efforts als aankruisvakjes die alleen actief zijn als `reasoning` aan staat.
- **Nieuwe actie:** `updateModelFactsAction(id, input)`, met een strikt zod-schema, `validateModelFacts` en `requireWorkersAdmin`. Hij schrijft alleen deze kolommen.
- Bij CLAUDE/CODEX blijft het prijspaneel zoals het is; de feiten komen in een tweede paneel of een tweede tab.
- **Tests:**
  - elke validatieregel komt aan in de UI;
  - een mislukte opslag houdt het paneel open;
  - LOCAL omzetten naar REMOTE en weer terug.

### 4.8 REMOTE-lijstprijs (workers, I3)

- `updateModelPricesAction` accepteert een HARNESS-rij met origin REMOTE. Een LOCAL-rij weigert hij met "Lokale configuraties hebben geen prijs.".
- **Het prijsrecord** is een `model_prices`-rij met runtime HARNESS, provider `openrouter`, API/USD/standard en `model_id` = de configuratienaam. `cache_read`/`cache_write` staan op 0, omdat de kolommen NOT NULL zijn; de UI toont voor Remote alleen in en out.
- **Keuze: prijs per configuratie.** De vier `qwen3.8-or*` krijgen elk een eigen rij, want de sleutel is `model_id`. Een prijs per onderliggend model is uitgesteld (YAGNI).
- **Opzoeken:** `listModelsWithPrices` zoekt de REMOTE-prijs op met een eigen sleutel in workers, `harnessListPriceKey(model_id)` = `priceRowKey({ runtime: 'HARNESS', provider: 'openrouter', … })`. Hij gaat **niet** via `LIST_PRICE_PROVIDERS`.
- **Tests:**
  - de test "HARNESS is altijd null" in `__tests__/lib/model-registry.test.ts` verandert bewust: REMOTE met een prijsrij geeft een prijs, LOCAL blijft null;
  - een HARNESS/openrouter-prijsrij verandert de uitkomst van `jobs-mapper` (`computeUsageEstimate`/`buildPriceMap`) niet.

### 4.9 Volgorde en uitrol (I1)

1. **scrum4me-shared PR:** de enum, de kolommen, `model-registry-fields.ts` en de tests. Merge naar main.
2. **Scrum4Me PR:** de bump, `gen-schema`, de migratie met test, de chat-omzetting met tests. Deploy via de gewone web-deploy; de migratie draait via de operator-route.
3. **scrum4me-workers PR:** de bump, de drie secties, het formulier en de actie, de driftcheck met tests.
   - De code kan parallel met stap 2 worden geschreven en gereviewd.
   - **De workers-deploy wacht tot de migratie van stap 2 live is in productie.** De nieuwe workers-client leest en schrijft de nieuwe kolommen (`agentModel.findMany` zonder `select`, de upsert in `addModelAction`). Tegen een DB zonder migratie faalt `/settings/models` dan met "column does not exist".
   - Workers deployt niet automatisch bij een merge; de poort zit dus op de deploy.
4. **scrum4me-shared PR:** de oude naamlijst weg, nadat stap 2 gemerged is.
5. **agent-harness PR (alleen docs):** de runbookstap uit §4.6.
6. **Praktijkproef met JP:**
   - de drie secties bekijken;
   - de chat-modelkiezer: alleen `gsq-lokaal` zonder "gehost";
   - de driftcheck tegen de productie-DB: (c) en (d) zijn nul.
7. **scrum4me-mcp:** geen bump nodig. Een oudere client negeert extra kolommen (`agent-guide.ts` leest alleen bestaande velden). De volgende gewone bump neemt het schema mee, en dat mag pas na stap 2.

## 5. Acceptatiecriteria

**I1**
1. `npm run verify` (shared, Scrum4Me, workers) en `npm run build` (Scrum4Me, workers) zijn groen. Nieuwe tests zijn aantoonbaar rood zonder de wijziging.
2. Na de migratie op productie:
   - elke CLAUDE/CODEX-rij heeft `SUBSCRIPTION`;
   - `gsq-lokaal` heeft `LOCAL` met `upstream_model = 'ollama/qwen3.8-gsq-rco:27b-iq3_s-text'`;
   - elke andere HARNESS-rij heeft `REMOTE`.
3. `HARNESS_LOCAL_CONFIGURATIONS` en `isHostedHarnessConfiguration` bestaan in geen enkele repo meer. Een grep over shared, Scrum4Me, workers, mcp, copilot en Ops-dashboard op `origin/main` geeft nul treffers buiten docs.
4. De chat-modelkiezer en de chatpagina tonen "gehost" voor elke configuratie behalve `gsq-lokaal` (actief of niet). Een configuratie zonder registry-rij geldt als gehost.
5. `/settings/models` toont drie secties met de kolommen uit §4.5. Een HARNESS-rij toevoegen zonder keuze, of als Lokaal zonder `ollama/`-model, wordt geweigerd.
6. `db:check-harness-registry` tegen de productie-DB en agent-harness `main` meldt nul bevindingen in (c) en (d). Bestaande (a)/(b)-meldingen komen uit de registry-data van vóór I1, bijvoorbeeld proefconfiguraties. Ze worden aan JP voorgelegd, die beslist over het opruimen; ze tellen niet als gebrek van I1. Een bewust omgezette herkomst in een fixture geeft exit 1 met sectie (c).
7. `listPriceKey('HARNESS', …)` is `null`, gepind in een shared-test.

**I2**
8. Elk veld uit §4.1 is per rij te bewerken met de validatie uit §4.2. Na het invullen meldt de driftcheck voor de ingevulde rijen geen (e) meer.

**I3**
9. REMOTE-rijen tonen een bewerkbare lijstprijs. LOCAL toont "n.v.t." en weigert een prijs. De kostenschermen (jobs, usage, insights) geven voor HARNESS-jobs dezelfde uitkomst als vóór I3.

## 6. Risico's en open punten

- **db-access en het nieuwe enumtype.** De ADD COLUMN-precedenten raakten `scripts/db-access/profiles/scrum4me.json` niet. Een nieuw type is wel een nieuw publiek object, en policy V2 legt ook schemadefinities en -hashes vast (`docs/runbooks/db-access-policy.md`). De plan-taak voor de migratie controleert `CLAUDE.md:94`, de catalogus (`lib/db-access/catalog-server.ts`, de legacy fingerprint van `agent_models`) en de manifestregels voordat de migratie wordt geschreven.
- **Read-only toegang tot productie** voor de driftcheck en de controle-SELECTs. Het db-access-beleid kent een rol `ops_readonly`. De praktijkproef en de runbookstap noemen de toegestane route. Is die er niet vanaf de Mac, dan voert JP de stap uit.
- **Workers-bump.** Die neemt `c79f6e3` en `cd01a69` mee. Beide staan al in de DB (Scrum4Me draait op `8df7f2c`). Het risico is klein, maar de workers-taak moet ook met die twee wijzigingen groen zijn.
- **De LOKAAL-regel is een afspraak.** Zie §4.2. De driftcheck en de runbookstap zijn de echte borging. Er komt bewust geen CHECK-constraint in de DB (geen concreet faalpad buiten handmatige SQL).
- **Quant-namen** zijn vrije tekst, dus de vergelijking in de driftcheck is voor LOCAL een substring-controle. Dat is bewust grof.
- **Ceremonie.** Sprint en PBI komen onder scrum4me-workers (besluit 10). Of `create_sprint`/`create_pbi` een `idea_id` van een ander product accepteert, blijkt pas bij de ceremonie. Lukt dat niet, dan vraagt dat een besluit van JP: het idee verhuizen, of de sprint toch onder Agent-harness zetten.
- **Raakvlak:** IDEA-270 (remote modellen voor reviews) en IDEA-229 (OpenRouter API) kunnen deze velden later gebruiken. Ze vallen buiten deze spec.

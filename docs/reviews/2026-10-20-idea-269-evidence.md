# IDEA-269 — bewijs bij de spec (fragmenten uit andere repo's)

Letterlijke fragmenten met regelnummers uit repo's buiten de `/work`-checkout (Scrum4Me), voor de review-loop van de IDEA-269-spec. Gegenereerd met `git show <sha>:<pad>`; elke regel begint met het regelnummer in dat bestand. Wat hier niet staat, staat in `/work` of is niet geverifieerd.

- scrum4me-shared `8df7f2c07c3912c12ebbe294088d4d6684f2bc24` (ook de submodule-pin van Scrum4Me)
- scrum4me-workers `198eb597e59ec3bae3a39552e2f785686cfec3b5` (shared-submodule gepind op `f1e78df001b66c7e12e7ab8505f666b99a769687`)
- agent-harness `8851723cca50e5ec9b82082da1d57a238db5569e`

## shared schema: enums — `prisma/schema.prisma` r. 25-60

`scrum4me-shared@8df7f2c:prisma/schema.prisma`

```prisma
   25    PLANNING
   26    WORKERS_UI
   27    COPILOT
   28  }
   29  
   30  enum AgentRuntime {
   31    CLAUDE
   32    CODEX
   33    HARNESS
   34  }
   35  
   36  enum WorkerCapability {
   37    HIGH_P
   38    MEDIUM_P
   39    LOW_P
   40  }
   41  
   42  enum JobSource {
   43    SYSTEM
   44    MANUAL
   45    ORCHESTRATOR
   46    COPILOT
   47  }
   48  
   49  enum BillingMode {
   50    SUBSCRIPTION
   51    API
   52  }
   53  
   54  enum BillingUnit {
   55    USD_PROXY
   56    USD
   57    CREDITS
   58  }
   59  
   60  enum ManualJobDraftStatus {
```

## shared schema: ModelPrice en AgentModel — `prisma/schema.prisma` r. 820-870

`scrum4me-shared@8df7f2c:prisma/schema.prisma`

```prisma
  820    @@index([task_id, created_at])
  821    @@index([sprint_task_execution_id, created_at])
  822    @@index([idea_id, created_at])
  823    @@map("review_logs")
  824  }
  825  
  826  model ModelPrice {
  827    id                       String       @id @default(cuid())
  828    model_id                 String
  829    runtime                  AgentRuntime @default(CLAUDE)
  830    provider                 String       @default("unknown")
  831    billing_mode             BillingMode  @default(SUBSCRIPTION)
  832    billing_unit             BillingUnit  @default(USD_PROXY)
  833    service_tier             String       @default("standard")
  834    input_price_per_1m       Decimal      @db.Decimal(12, 6)
  835    output_price_per_1m      Decimal      @db.Decimal(12, 6)
  836    cache_read_price_per_1m  Decimal      @db.Decimal(12, 6)
  837    cache_write_price_per_1m Decimal      @db.Decimal(12, 6)
  838    currency                 String?
  839    effective_from           DateTime?
  840    source_url               String?
  841    source_checked_at        DateTime?
  842    notes                    String?      @db.Text
  843    created_at               DateTime     @default(now())
  844    updated_at               DateTime     @updatedAt
  845  
  846    @@unique([runtime, provider, model_id, billing_mode, billing_unit, service_tier])
  847    @@index([runtime, billing_mode, billing_unit, service_tier])
  848    @@index([provider, model_id])
  849    @@map("model_prices")
  850  }
  851  
  852  /// M39: model-registry — bron voor keuzelijsten en validatie.
  853  /// Prijzen blijven in ModelPrice (join op model_id); dit tabel is
  854  /// beschikbaarheid/presentatie (actief, volgorde, weergavenaam).
  855  model AgentModel {
  856    id           String       @id @default(cuid())
  857    runtime      AgentRuntime @default(CLAUDE)
  858    model_id     String
  859    display_name String
  860    active       Boolean      @default(true)
  861    sort_order   Int          @default(0)
  862    notes        String?      @db.Text
  863    created_at   DateTime     @default(now())
  864    updated_at   DateTime     @updatedAt
  865  
  866    @@unique([runtime, model_id])
  867    @@map("agent_models")
  868  }
  869  
  870  model ClaudeWorker {
```

## shared harness-config — `lib/harness-config.ts` r. 1-60

`scrum4me-shared@8df7f2c:lib/harness-config.ts`

```ts
    1  // HARNESS-specifieke config-helpers (M45), los van het Claude-georiënteerde job-config.ts en
    2  // bedoeld voor de resolver daarin. Spec: docs/superpowers/specs/2026-10-05-harness-runtime-design.md
    3  // in Scrum4Me. Prisma-vrij: bedragen zijn decimale strings, nooit een number of een Decimal.
    4  
    5  /** Jobsoorten waarvoor runtime HARNESS bestaat (spec §5.1). */
    6  export const HARNESS_JOB_KINDS = ['IDEA_CHAT', 'TASK_IMPLEMENTATION'] as const
    7  export type HarnessJobKind = (typeof HARNESS_JOB_KINDS)[number]
    8  
    9  export function isHarnessJobKind(kind: string): kind is HarnessJobKind {
   10    return (HARNESS_JOB_KINDS as readonly string[]).includes(kind)
   11  }
   12  
   13  /** Standaardplafond per jobsoort in USD, als decimale string (spec §5.1). */
   14  export const DEFAULT_HARNESS_MAX_COST_USD: Readonly<Record<HarnessJobKind, string>> =
   15    Object.freeze({ IDEA_CHAT: '0.05', TASK_IMPLEMENTATION: '0.50' })
   16  
   17  /**
   18   * Plafond per AGENT_CHAT-job in USD (M50, chat-agent-spec §5.1). AGENT_CHAT staat bewust niet in
   19   * HARNESS_JOB_KINDS: die lijst stuurt de keuze per product, en een chat heeft geen productkeuze.
   20   */
   21  export const AGENT_CHAT_MAX_COST_USD = '0.05'
   22  
   23  /**
   24   * HARNESS-configuraties die lokaal draaien (chat-agent-spec §4.5). Alleen weergave: elke naam
   25   * buiten deze lijst geldt als gehost (fail-safe), de harness rekent zelf met zijn costMode.
   26   */
   27  export const HARNESS_LOCAL_CONFIGURATIONS = ['gsq-lokaal'] as const
   28  
   29  export function isHostedHarnessConfiguration(name: string): boolean {
   30    return !(HARNESS_LOCAL_CONFIGURATIONS as readonly string[]).includes(name)
   31  }
   32  
   33  /**
   34   * Ingebouwde CLAUDE.md van de chat-agent (chat-agent-spec §4.4 en §6.1): de eerste promptversie
   35   * van een gebruiker. Zonder product-id en toolnamen; de harness voegt de vaste productregel toe.
   36   */
   37  export const AGENT_CHAT_DEFAULT_PROMPT = `Je bent de chat-agent van Scrum4Me. Je beantwoordt vragen over het product waaraan deze chat gekoppeld is.
   38  
   39  - Antwoord in het Nederlands, kort en concreet.
   40  - Baseer je antwoord op de productdocumentatie: zoek en lees de docs met je tools voordat je antwoordt.
   41  - Lees grote documenten per sectie, met de parameter heading, in plaats van in hun geheel.
   42  - Verzin niets. Staat het antwoord niet in de docs, zeg dat dan en noem wat je wel vond.
   43  - Noem je bronnen: het document en de sectie waarop je antwoord steunt.`
   44  
   45  // Zelfde patroon als de CHECK op product_harness_choices.configuration (spec §4).
   46  // Bewust zonder g-vlag: .test() met g is stateful en geeft bij herhaalde aanroepen
   47  // wisselende antwoorden.
   48  export const HARNESS_CONFIGURATION_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/
   49  
   50  export function isHarnessConfigurationName(value: unknown): value is string {
   51    return typeof value === 'string' && HARNESS_CONFIGURATION_NAME.test(value)
   52  }
   53  
   54  // Decimal(10,4): hoogstens 6 cijfers vóór en 4 cijfers na de komma.
   55  const MAX_INTEGER_DIGITS = 6
   56  const MAX_FRACTION_DIGITS = 4
   57  
   58  // Alleen gewone decimale notatie; sluit exponent (1e-2), teken, spaties, '.5' en '5.' uit.
   59  const PLAIN_DECIMAL = /^\d+(\.\d+)?$/
   60  
```

## shared list-price — `lib/list-price.ts` r. 1-80

`scrum4me-shared@8df7f2c:lib/list-price.ts`

```ts
    1  // PBI-36 (JP, 2026-10-09): screens show every model at its API list price in USD, so models
    2  // of different providers can be compared and the figures match what an own API key would cost.
    3  // The list-price card of a model is the model_prices row with billing_mode API, billing_unit USD
    4  // and the standard tier, from the provider of its runtime. Subscription cards (USD_PROXY,
    5  // CREDITS) stay for internal accounting; this file never selects them.
    6  
    7  export type ListPriceRuntime = 'CLAUDE' | 'CODEX'
    8  
    9  export type ListPriceCard = {
   10    provider: string
   11    billing_mode: 'API'
   12    billing_unit: 'USD'
   13    service_tier: 'standard'
   14  }
   15  
   16  // Explicit per runtime: a new runtime gets its own provider here or has no list price.
   17  // HARNESS reports its own cost per job and has no card.
   18  export const LIST_PRICE_PROVIDERS = {
   19    CLAUDE: 'anthropic',
   20    CODEX: 'openai',
   21  } as const satisfies Record<ListPriceRuntime, string>
   22  
   23  export function listPriceCardForRuntime(runtime: string): ListPriceCard | null {
   24    if (!Object.hasOwn(LIST_PRICE_PROVIDERS, runtime)) return null
   25    return {
   26      provider: LIST_PRICE_PROVIDERS[runtime as ListPriceRuntime],
   27      billing_mode: 'API',
   28      billing_unit: 'USD',
   29      service_tier: 'standard',
   30    }
   31  }
   32  
   33  export type PriceRowKeyParts = {
   34    runtime: string
   35    provider: string
   36    model_id: string
   37    billing_mode: string
   38    billing_unit: string
   39    service_tier: string
   40  }
   41  
   42  // One key over the full composite unique of model_prices, so a map never mixes rows of
   43  // another runtime, provider or unit that share a model_id.
   44  export function priceRowKey(p: PriceRowKeyParts): string {
   45    return [p.runtime, p.provider, p.model_id, p.billing_mode, p.billing_unit, p.service_tier].join('|')
   46  }
   47  
   48  // The key of a model's list-price card, or null when the runtime has none or the model is empty.
   49  export function listPriceKey(runtime: string, modelId: string | null | undefined): string | null {
   50    const card = listPriceCardForRuntime(runtime)
   51    const model = modelId?.trim()
   52    if (!card || !model) return null
   53    return priceRowKey({ runtime, model_id: model, ...card })
   54  }
```

## shared usage-sql — `lib/usage-sql.ts` r. 1-40

`scrum4me-shared@8df7f2c:lib/usage-sql.ts`

```ts
    1  // IDEA-235 (spec §3.4, §5.3; plan Taak 7): one source for pricing usage lines and for which
    2  // tasks count as "measurable". SQL text, not Prisma.Sql: lib/ stays dependency-free and each
    3  // consumer wraps the text with Prisma.raw (the pattern of Scrum4Me lib/insights/rate-card-sql.ts).
    4  // Only tokens are stored; amounts in USD are computed at read time, at API list price (PBI-36).
    5  // The subscription cards (USD_PROXY, CREDITS) are no longer read here.
    6  
    7  import { LIST_PRICE_PROVIDERS } from './list-price.js'
    8  
    9  // PBI-36: the API list-price card (lib/list-price.ts) as a join, for screens that show USD for
   10  // every runtime. modelIdExpr and runtimeExpr are SQL expressions (for usage lines: 'ul.model_id'
   11  // and usageSegmentRuntimeSqlText('us'), for claude_jobs rows 'cj.model_id' and 'cj.runtime');
   12  // joins as `priceAlias` (default `mp`). No card keeps `<alias>.id IS NULL` and reads as
   13  // "no price", never 0.
   14  export function listPriceJoinSqlText(modelIdExpr: string, runtimeExpr: string, priceAlias = 'mp'): string {
   15    const providers = Object.entries(LIST_PRICE_PROVIDERS)
   16      .map(([runtime, provider]) => `(${runtimeExpr} = '${runtime}' AND ${priceAlias}.provider = '${provider}')`)
   17      .join('\n    OR ')
   18    return `
   19  LEFT JOIN model_prices ${priceAlias}
   20    ON ${priceAlias}.model_id = ${modelIdExpr}
   21    AND ${priceAlias}.runtime = ${runtimeExpr}
   22    AND ${priceAlias}.billing_mode = 'API'
   23    AND ${priceAlias}.billing_unit = 'USD'
   24    AND ${priceAlias}.service_tier = 'standard'
   25    AND (
   26      ${providers}
   27    )`
   28  }
   29  
   30  // USD at list price for one row of token counts (a usage line, or a claude_jobs row with
   31  // tokenAlias 'cj'). NULL without a card. Only use it on a listPriceJoinSqlText join.
   32  export function listPriceUsdSqlText(tokenAlias = 'ul', priceAlias = 'mp'): string {
   33    return usageLineAmountSqlText(tokenAlias, priceAlias)
   34  }
   35  
   36  // Interactive runtime is fixed by the stored mod_version; legacy versions are Claude.
   37  export function usageSegmentRuntimeSqlText(segmentAlias = 'us'): string {
   38    return `(CASE WHEN ${segmentAlias}.mod_version LIKE 'codex-usage-ledger/%'
   39    THEN 'CODEX' ELSE 'CLAUDE' END)::"AgentRuntime"`
   40  }
```

## shared test harness-config: imports — `__tests__/harness-config.test.ts` r. 1-20

`scrum4me-shared@8df7f2c:__tests__/harness-config.test.ts`

```ts
    1  import { describe, expect, it } from 'vitest'
    2  import { CLAUDE_JOB_KINDS, isClaudeJobKind } from '../lib/claude-job-kind'
    3  import {
    4    AGENT_CHAT_DEFAULT_PROMPT,
    5    AGENT_CHAT_MAX_COST_USD,
    6    DEFAULT_HARNESS_MAX_COST_USD,
    7    HARNESS_CONFIGURATION_NAME,
    8    HARNESS_COST_SOURCES,
    9    HARNESS_JOB_KINDS,
   10    HARNESS_LOCAL_CONFIGURATIONS,
   11    isHarnessConfigurationName,
   12    isHarnessJobKind,
   13    isHostedHarnessConfiguration,
   14    parseMaxCostUsd,
   15  } from '../lib/harness-config'
   16  
   17  describe('HARNESS-jobsoorten (spec §5.1)', () => {
   18    it('ondersteunt exact IDEA_CHAT en TASK_IMPLEMENTATION', () => {
   19      expect([...HARNESS_JOB_KINDS]).toEqual(['IDEA_CHAT', 'TASK_IMPLEMENTATION'])
   20    })
```

## shared test harness-config: pin op de lokale lijst — `__tests__/harness-config.test.ts` r. 215-235

`scrum4me-shared@8df7f2c:__tests__/harness-config.test.ts`

```ts
  215      expect(Object.keys(DEFAULT_HARNESS_MAX_COST_USD).sort()).toEqual(['IDEA_CHAT', 'TASK_IMPLEMENTATION'])
  216    })
  217  
  218    it('AGENT_CHAT_MAX_COST_USD is 0.05 en een geldig, genormaliseerd plafond', () => {
  219      expect(AGENT_CHAT_MAX_COST_USD).toBe('0.05')
  220      expect(parseMaxCostUsd(AGENT_CHAT_MAX_COST_USD)).toBe(AGENT_CHAT_MAX_COST_USD)
  221    })
  222  
  223    it('HARNESS_LOCAL_CONFIGURATIONS is exact gsq-lokaal, met geldige configuratienamen', () => {
  224      expect([...HARNESS_LOCAL_CONFIGURATIONS]).toEqual(['gsq-lokaal'])
  225      for (const name of HARNESS_LOCAL_CONFIGURATIONS) expect(isHarnessConfigurationName(name)).toBe(true)
  226    })
  227  
  228    it('isHostedHarnessConfiguration: alleen de lokale lijst is niet gehost (fail-safe voor nieuwe namen)', () => {
  229      expect(isHostedHarnessConfiguration('gsq-lokaal')).toBe(false)
  230      expect(isHostedHarnessConfiguration('qwen3.8-or')).toBe(true)
  231      expect(isHostedHarnessConfiguration('nieuw-lokaal')).toBe(true)
  232    })
  233  
  234    it('AGENT_CHAT_DEFAULT_PROMPT: kort, Nederlands, zonder product-id of toolnamen', () => {
  235      expect(AGENT_CHAT_DEFAULT_PROMPT.trim().length).toBeGreaterThan(0)
```

## workers actions/model-registry.ts (volledig) — `actions/model-registry.ts` r. 1-265

`scrum4me-workers@198eb59:actions/model-registry.ts`

```ts
    1  'use server'
    2  
    3  import { revalidatePath } from 'next/cache'
    4  import { AgentRuntime } from '@prisma/client'
    5  import { z } from 'zod'
    6  import { HARNESS_CONFIGURATION_NAME, isHarnessConfigurationName } from '@shared/harness-config'
    7  import { listPriceCardForRuntime } from '@shared/list-price'
    8  import { prisma } from '@/lib/prisma'
    9  import { requireWorkersAdmin } from '@/lib/auth'
   10  import { KIND_ORDER } from '@/lib/settings/job-kind-config'
   11  
   12  // Cache-tier multipliers t.o.v. input-prijs — alleen voor CLAUDE wanneer de cache-prijzen bij het
   13  // toevoegen ontbreken (1:1 met scripts/rate-card-data.ts in de Scrum4Me-web-repo). Nooit voor CODEX:
   14  // OpenAI heeft eigen cache-tarieven per model.
   15  const CACHE_READ_RATIO = 0.1
   16  const CACHE_WRITE_RATIO = 1.25
   17  const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000
   18  
   19  // PBI-36: de prijsrij is de API-lijstprijs in USD (billing_mode API, billing_unit USD, standard tier)
   20  // van de provider van de runtime. HARNESS heeft geen kaart (listPriceCardForRuntime → null).
   21  const PRICE_NOTE = 'Toegevoegd via /settings/models (API-lijstprijs).'
   22  const priceField = z.number().nonnegative().max(10_000)
   23  
   24  const pricedBase = {
   25    model_id: z.string().trim().min(1).max(100),
   26    display_name: z.string().trim().min(1).max(120),
   27    input_price_per_1m: priceField,
   28    output_price_per_1m: priceField,
   29    active: z.boolean().default(true),
   30    default_for_kinds: z.array(z.enum([...KIND_ORDER] as [string, ...string[]])).default([]),
   31  }
   32  
   33  // CLAUDE: cache-prijzen optioneel (afgeleid 0.1x / 1.25x input als ze ontbreken); kan kinds op het model zetten.
   34  const claudeModelSchema = z.object({
   35    ...pricedBase,
   36    runtime: z.literal(AgentRuntime.CLAUDE),
   37    cache_read_price_per_1m: priceField.optional(),
   38    cache_write_price_per_1m: priceField.optional(),
   39  })
   40  
   41  // CODEX: cached input verplicht, cache write optioneel (default 0; niet elk model rekent die).
   42  const codexModelSchema = z.object({
   43    ...pricedBase,
   44    runtime: z.literal(AgentRuntime.CODEX),
   45    cache_read_price_per_1m: priceField,
   46    cache_write_price_per_1m: priceField.default(0),
   47  })
   48  
   49  // HARNESS: een configuratienaam zonder prijs (het bedrag wordt per job gemeld). Strikt, zodat een
   50  // prijsveld of een niet-lege default_for_kinds de invoer weigert in plaats van stil wegvalt.
   51  // De naam zelf (trim, geen min/max) wordt in addModelAction aan één regel getoetst.
   52  const harnessModelSchema = z
   53    .object({
   54      runtime: z.literal(AgentRuntime.HARNESS),
   55      model_id: z.string().trim(),
   56      display_name: z.string().trim().min(1).max(120),
   57      active: z.boolean().default(true),
   58      default_for_kinds: z.array(z.never()).optional(),
   59    })
   60    .strict()
   61  
   62  const addModelSchema = z.discriminatedUnion('runtime', [claudeModelSchema, codexModelSchema, harnessModelSchema])
   63  
   64  // De invoer zoals de editor hem stuurt: active en default_for_kinds mogen ontbreken.
   65  export type AddModelInput = z.input<typeof addModelSchema>
   66  
   67  type ModelValidation = 'checked' | 'skipped-no-key' | 'not-found' | 'not-applicable'
   68  
   69  export type AddModelResult =
   70    | { ok: true; validated: ModelValidation }
   71    | { ok: false; error: string }
   72  
   73  /**
   74   * Voeg een model toe (of werk het bij) in de agent_models-registry én, voor CLAUDE en CODEX,
   75   * in model_prices (API-lijstprijs in USD, standard tier), plus optioneel als default voor gekozen kinds — alles in één
   76   * transactie. Een HARNESS-configuratie krijgt alleen een agent_models-rij: geen prijs en geen
   77   * /v1/models-controle. Optionele /v1/models-bestaanscheck (alleen CLAUDE) wanneer
   78   * ANTHROPIC_API_KEY op de host staat (nette degradatie als hij ontbreekt).
   79   */
   80  export async function addModelAction(input: AddModelInput): Promise<AddModelResult> {
   81    await requireWorkersAdmin()
   82  
   83    const parsed = addModelSchema.safeParse(input)
   84    if (!parsed.success) {
   85      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ongeldige invoer' }
   86    }
   87    const d = parsed.data
   88  
   89    // model_id-vorm per runtime (security-/typfout-grens), vóór elke fetch en DB-aanroep.
   90    if (d.runtime === AgentRuntime.CLAUDE && !/^claude-[a-z0-9.-]+$/.test(d.model_id)) {
   91      return { ok: false, error: `Ongeldig CLAUDE model_id: ${d.model_id} (verwacht ^claude-[a-z0-9.-]+$)` }
   92    }
   93    // Dezelfde regel als de CHECK op product_harness_choices.configuration; hoofdletters worden geweigerd.
   94    if (d.runtime === AgentRuntime.HARNESS && !isHarnessConfigurationName(d.model_id)) {
   95      return {
   96        ok: false,
   97        error: `Ongeldige HARNESS-configuratienaam: ${d.model_id} (verwacht ${HARNESS_CONFIGURATION_NAME.source})`,
   98      }
   99    }
  100  
  101    // Optionele bestaans-/spellingcheck tegen /v1/models — Anthropic heeft geen
  102    // prijs-API, dus prijs blijft handmatig; dit valideert alleen het id. HARNESS
  103    // heeft geen /v1/models: daar geen fetch en dus 'not-applicable'.
  104    let validated: ModelValidation = d.runtime === AgentRuntime.HARNESS ? 'not-applicable' : 'skipped-no-key'
  105    const key = process.env.ANTHROPIC_API_KEY?.trim()
  106    if (d.runtime === AgentRuntime.CLAUDE && key) {
  107      try {
  108        const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(d.model_id)}`, {
  109          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  110        })
  111        validated = res.ok ? 'checked' : 'not-found'
  112      } catch {
  113        validated = 'skipped-no-key'
  114      }
  115    }
  116  
  117    await prisma.$transaction(async (tx) => {
  118      const maxSort = await tx.agentModel.aggregate({
  119        where: { runtime: d.runtime },
  120        _max: { sort_order: true },
  121      })
  122      await tx.agentModel.upsert({
  123        where: { runtime_model_id: { runtime: d.runtime, model_id: d.model_id } },
  124        update: { display_name: d.display_name, active: d.active },
  125        create: {
  126          runtime: d.runtime,
  127          model_id: d.model_id,
  128          display_name: d.display_name,
  129          active: d.active,
  130          sort_order: (maxSort._max.sort_order ?? 0) + 10,
  131        },
  132      })
  133  
  134      // Een HARNESS-configuratie heeft geen prijs: geen prijsrij en geen kind-defaults.
  135      if (d.runtime === AgentRuntime.HARNESS) return
  136  
  137      const card = listPriceCardForRuntime(d.runtime)
  138      if (!card) return
  139  
  140      const cacheRead =
  141        d.runtime === AgentRuntime.CLAUDE
  142          ? (d.cache_read_price_per_1m ?? round6(d.input_price_per_1m * CACHE_READ_RATIO))
  143          : d.cache_read_price_per_1m
  144      const cacheWrite =
  145        d.runtime === AgentRuntime.CLAUDE
  146          ? (d.cache_write_price_per_1m ?? round6(d.input_price_per_1m * CACHE_WRITE_RATIO))
  147          : d.cache_write_price_per_1m
  148  
  149      const priceRow = {
  150        model_id: d.model_id,
  151        runtime: d.runtime,
  152        ...card,
  153        input_price_per_1m: d.input_price_per_1m,
  154        output_price_per_1m: d.output_price_per_1m,
  155        cache_read_price_per_1m: cacheRead,
  156        cache_write_price_per_1m: cacheWrite,
  157        currency: 'USD',
  158        notes: PRICE_NOTE,
  159      }
  160      await tx.modelPrice.upsert({
  161        where: {
  162          runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
  163            runtime: d.runtime,
  164            provider: card.provider,
  165            model_id: d.model_id,
  166            billing_mode: card.billing_mode,
  167            billing_unit: card.billing_unit,
  168            service_tier: card.service_tier,
  169          },
  170        },
  171        update: priceRow,
  172        create: priceRow,
  173      })
  174  
  175      if (d.runtime === AgentRuntime.CLAUDE && d.default_for_kinds.length > 0) {
  176        await tx.jobKindConfig.updateMany({
  177          where: { kind: { in: d.default_for_kinds as never[] } },
  178          data: { claude_model: d.model_id },
  179        })
  180      }
  181    })
  182  
  183    revalidatePath('/settings/models')
  184    revalidatePath('/settings/job-kinds')
  185    return { ok: true, validated }
  186  }
  187  
  188  export type ToggleModelResult = { ok: true } | { ok: false; error: string }
  189  
  190  /** Zet een registry-model actief/inactief. */
  191  export async function setModelActiveAction(id: string, active: boolean): Promise<ToggleModelResult> {
  192    await requireWorkersAdmin()
  193    try {
  194      await prisma.agentModel.update({ where: { id }, data: { active } })
  195    } catch {
  196      return { ok: false, error: 'Model niet gevonden.' }
  197    }
  198    revalidatePath('/settings/models')
  199    return { ok: true }
  200  }
  201  
  202  const updatePricesSchema = z.object({
  203    input_price_per_1m: priceField,
  204    output_price_per_1m: priceField,
  205    cache_read_price_per_1m: priceField,
  206    cache_write_price_per_1m: priceField,
  207  })
  208  
  209  export type UpdateModelPricesInput = z.input<typeof updatePricesSchema>
  210  export type UpdateModelPricesResult = { ok: true } | { ok: false; error: string }
  211  
  212  /**
  213   * Werk de API-lijstprijs (USD, standard tier) van een registry-model bij. Bij een bestaande rij
  214   * veranderen alleen de vier prijskolommen (bron, notities e.d. blijven); ontbreekt de rij dan wordt
  215   * de volledige kaart aangemaakt. HARNESS heeft geen prijs en wordt geweigerd.
  216   */
  217  export async function updateModelPricesAction(
  218    id: string,
  219    input: UpdateModelPricesInput,
  220  ): Promise<UpdateModelPricesResult> {
  221    await requireWorkersAdmin()
  222  
  223    const parsed = updatePricesSchema.safeParse(input)
  224    if (!parsed.success) {
  225      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ongeldige invoer' }
  226    }
  227    const prices = parsed.data
  228  
  229    const model = await prisma.agentModel.findUnique({
  230      where: { id },
  231      select: { runtime: true, model_id: true },
  232    })
  233    if (!model) return { ok: false, error: 'Model niet gevonden.' }
  234  
  235    const card = listPriceCardForRuntime(model.runtime)
  236    if (!card) return { ok: false, error: `${model.runtime}-configuraties hebben geen prijs.` }
  237  
  238    await prisma.$transaction(async (tx) => {
  239      await tx.modelPrice.upsert({
  240        where: {
  241          runtime_provider_model_id_billing_mode_billing_unit_service_tier: {
  242            runtime: model.runtime,
  243            provider: card.provider,
  244            model_id: model.model_id,
  245            billing_mode: card.billing_mode,
  246            billing_unit: card.billing_unit,
  247            service_tier: card.service_tier,
  248          },
  249        },
  250        update: { ...prices },
  251        create: {
  252          model_id: model.model_id,
  253          runtime: model.runtime,
  254          ...card,
  255          ...prices,
  256          currency: 'USD',
  257          notes: PRICE_NOTE,
  258        },
  259      })
  260    })
  261  
  262    revalidatePath('/settings/models')
  263    revalidatePath('/settings/job-kinds')
  264    return { ok: true }
  265  }
```

## workers lib/settings/model-registry.ts (volledig) — `lib/settings/model-registry.ts` r. 1-87

`scrum4me-workers@198eb59:lib/settings/model-registry.ts`

```ts
    1  import { AgentRuntime } from '@prisma/client'
    2  import { KNOWN_CLAUDE_MODEL_IDS } from '@shared/job-config'
    3  import { listPriceKey, priceRowKey } from '@shared/list-price'
    4  import { prisma } from '@/lib/prisma'
    5  
    6  // M39 Fase B: de agent_models-registry is de bron voor de model-keuzelijsten.
    7  // Het bestaande CLAUDE-vangnet gebruikt bekende ids bij een lege/onbereikbare
    8  // registry. CODEX geeft dan []: de editor behoudt de opgeslagen waarde en
    9  // blokkeert bewaren totdat een actief registrymodel beschikbaar is.
   10  const CLAUDE_FALLBACK_IDS: readonly string[] = KNOWN_CLAUDE_MODEL_IDS
   11  
   12  /**
   13   * Actieve model_id's voor een runtime, gesorteerd op sort_order. Bij een lege
   14   * (of onbereikbare) registry: fallback op KNOWN_CLAUDE_MODEL_IDS voor CLAUDE,
   15   * anders een lege lijst.
   16   */
   17  export async function getActiveModelIds(runtime: AgentRuntime): Promise<string[]> {
   18    try {
   19      const rows = await prisma.agentModel.findMany({
   20        where: { runtime, active: true },
   21        orderBy: [{ sort_order: 'asc' }, { model_id: 'asc' }],
   22        select: { model_id: true },
   23      })
   24      const ids = rows.map((r) => r.model_id)
   25      if (ids.length > 0) return ids
   26    } catch {
   27      // Behoud de runtime-specifieke foutsemantiek zonder DB-details te tonen.
   28    }
   29    return runtime === AgentRuntime.CLAUDE ? [...CLAUDE_FALLBACK_IDS] : []
   30  }
   31  
   32  export type ModelWithPrice = {
   33    id: string
   34    runtime: AgentRuntime
   35    model_id: string
   36    display_name: string
   37    active: boolean
   38    sort_order: number
   39    notes: string | null
   40    input_price_per_1m: number | null
   41    output_price_per_1m: number | null
   42    cache_read_price_per_1m: number | null
   43    cache_write_price_per_1m: number | null
   44  }
   45  
   46  /** Alle registry-modellen (optioneel per runtime) met hun API-lijstprijs in USD (standard tier;
   47   *  de model_prices-rij API/USD/standard van de provider van de runtime) voor de
   48   *  /settings/models-tabel. HARNESS heeft geen prijs: alle prijsvelden null. */
   49  export async function listModelsWithPrices(runtime?: AgentRuntime): Promise<ModelWithPrice[]> {
   50    const models = await prisma.agentModel.findMany({
   51      where: runtime ? { runtime } : undefined,
   52      orderBy: [{ runtime: 'asc' }, { sort_order: 'asc' }, { model_id: 'asc' }],
   53    })
   54    const prices = await prisma.modelPrice.findMany({
   55      where: { billing_mode: 'API', billing_unit: 'USD', service_tier: 'standard' },
   56      select: {
   57        runtime: true,
   58        provider: true,
   59        model_id: true,
   60        billing_mode: true,
   61        billing_unit: true,
   62        service_tier: true,
   63        input_price_per_1m: true,
   64        output_price_per_1m: true,
   65        cache_read_price_per_1m: true,
   66        cache_write_price_per_1m: true,
   67      },
   68    })
   69    const priceMap = new Map(prices.map((p) => [priceRowKey(p), p]))
   70    return models.map((m) => {
   71      const k = listPriceKey(m.runtime, m.model_id)
   72      const p = k ? priceMap.get(k) : undefined
   73      return {
   74        id: m.id,
   75        runtime: m.runtime,
   76        model_id: m.model_id,
   77        display_name: m.display_name,
   78        active: m.active,
   79        sort_order: m.sort_order,
   80        notes: m.notes,
   81        input_price_per_1m: p ? Number(p.input_price_per_1m) : null,
   82        output_price_per_1m: p ? Number(p.output_price_per_1m) : null,
   83        cache_read_price_per_1m: p ? Number(p.cache_read_price_per_1m) : null,
   84        cache_write_price_per_1m: p ? Number(p.cache_write_price_per_1m) : null,
   85      }
   86    })
   87  }
```

## workers model-registry-editor.tsx (volledig) — `components/settings/model-registry-editor.tsx` r. 1-411

`scrum4me-workers@198eb59:components/settings/model-registry-editor.tsx`

```tsx
    1  'use client'
    2  
    3  import { useState, useTransition } from 'react'
    4  import { AgentRuntime } from '@prisma/client'
    5  import { Button } from '@/components/ui/button'
    6  import {
    7    addModelAction,
    8    setModelActiveAction,
    9    updateModelPricesAction,
   10    type AddModelInput,
   11    type AddModelResult,
   12  } from '@/actions/model-registry'
   13  import type { ModelWithPrice } from '@/lib/settings/model-registry'
   14  import { DataTable, type DataTableColumn } from '@/components/shared/data-table'
   15  import { useLocalTableSort } from '@/hooks/use-local-table-sort'
   16  
   17  type Status = { kind: 'idle' | 'ok' | 'error'; message?: string }
   18  
   19  const fieldClass =
   20    'mt-1 block w-full rounded border border-control-border bg-background px-2 py-1 font-mono text-xs'
   21  const labelClass = 'block'
   22  const capClass = 'text-xs text-muted-foreground'
   23  
   24  function price(v: number | null): string {
   25    return v == null ? '—' : `$${v}`
   26  }
   27  
   28  const PRICE_FIELDS = [
   29    { key: 'input_price_per_1m', label: 'input $/1M' },
   30    { key: 'cache_read_price_per_1m', label: 'cached input $/1M' },
   31    { key: 'output_price_per_1m', label: 'output $/1M' },
   32    { key: 'cache_write_price_per_1m', label: 'cache write $/1M' },
   33  ] as const
   34  type PriceKey = typeof PRICE_FIELDS[number]['key']
   35  type PriceDraft = Record<PriceKey, string>
   36  
   37  function draftFor(m: ModelWithPrice): PriceDraft {
   38    const text = (v: number | null) => (v == null ? '' : String(v))
   39    return {
   40      input_price_per_1m: text(m.input_price_per_1m),
   41      cache_read_price_per_1m: text(m.cache_read_price_per_1m),
   42      output_price_per_1m: text(m.output_price_per_1m),
   43      cache_write_price_per_1m: text(m.cache_write_price_per_1m),
   44    }
   45  }
   46  
   47  function PriceEditPanel({
   48    model,
   49    pending,
   50    onSave,
   51    onCancel,
   52  }: {
   53    model: ModelWithPrice
   54    pending: boolean
   55    onSave: (draft: PriceDraft) => void
   56    onCancel: () => void
   57  }) {
   58    const [draft, setDraft] = useState<PriceDraft>(() => draftFor(model))
   59    return (
   60      <div className="space-y-2">
   61        <div className="grid gap-2 sm:grid-cols-4">
   62          {PRICE_FIELDS.map((f) => (
   63            <label key={f.key} className={labelClass}>
   64              <span className={capClass}>{f.label}</span>
   65              <input
   66                type="number"
   67                min={0}
   68                step="any"
   69                aria-label={`${model.model_id} ${f.key}`}
   70                className={fieldClass}
   71                value={draft[f.key]}
   72                onChange={(e) => setDraft((cur) => ({ ...cur, [f.key]: e.target.value }))}
   73              />
   74            </label>
   75          ))}
   76        </div>
   77        <div className="flex items-center gap-2">
   78          <Button size="sm" disabled={pending} onClick={() => onSave(draft)}>
   79            Opslaan
   80          </Button>
   81          <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>
   82            Annuleren
   83          </Button>
   84        </div>
   85      </div>
   86    )
   87  }
   88  
   89  // Per waarde een eigen tekst: een nieuwe validated-waarde zonder tekst faalt in de typecheck
   90  // in plaats van stilletjes de "geen API-key"-tekst te krijgen.
   91  const VALIDATED_NOTE: Record<Extract<AddModelResult, { ok: true }>['validated'], string> = {
   92    checked: ' (bevestigd via /v1/models)',
   93    'not-found': ' — LET OP: niet gevonden in /v1/models',
   94    'skipped-no-key': ' (niet gevalideerd — geen API-key op de host)',
   95    'not-applicable': ' (HARNESS-configuratie; geen /v1/models-controle)',
   96  }
   97  
   98  const MODEL_ID_PLACEHOLDER: Record<AgentRuntime, string> = {
   99    CLAUDE: 'claude-opus-6',
  100    CODEX: 'gpt-5.7',
  101    HARNESS: 'gsq-lokaal',
  102  }
  103  
  104  const SORT_COLUMNS = ['runtime', 'model_id', 'display_name', 'price', 'active'] as const
  105  type SortColumn = typeof SORT_COLUMNS[number]
  106  const SORT_KEY = 'scrum4me-workers:settings:models:sort:v1'
  107  
  108  function compareModels(a: ModelWithPrice, b: ModelWithPrice, column: SortColumn, direction: 'asc' | 'desc' = 'asc'): number {
  109    if (column === 'runtime') {
  110      return a.runtime.localeCompare(b.runtime) || a.sort_order - b.sort_order || a.model_id.localeCompare(b.model_id)
  111    }
  112    if (column === 'price') {
  113      const inputDifference = (a.input_price_per_1m ?? 0) - (b.input_price_per_1m ?? 0)
  114      if (inputDifference) return inputDifference
  115      if (a.output_price_per_1m == null && b.output_price_per_1m != null) return direction === 'desc' ? -1 : 1
  116      if (b.output_price_per_1m == null && a.output_price_per_1m != null) return direction === 'desc' ? 1 : -1
  117      return (a.output_price_per_1m ?? 0) - (b.output_price_per_1m ?? 0) || a.model_id.localeCompare(b.model_id)
  118    }
  119    if (column === 'active') return Number(a.active) - Number(b.active) || a.model_id.localeCompare(b.model_id)
  120    return a[column].localeCompare(b[column]) || a.model_id.localeCompare(b.model_id)
  121  }
  122  
  123  export default function ModelRegistryEditor({
  124    models,
  125    kindOptions,
  126  }: {
  127    models: ModelWithPrice[]
  128    kindOptions: string[]
  129  }) {
  130    const [runtime, setRuntime] = useState<AgentRuntime>(AgentRuntime.CLAUDE)
  131    const [modelId, setModelId] = useState('')
  132    const [displayName, setDisplayName] = useState('')
  133    const [inputPrice, setInputPrice] = useState('')
  134    const [outputPrice, setOutputPrice] = useState('')
  135    const [cacheReadPrice, setCacheReadPrice] = useState('')
  136    const [cacheWritePrice, setCacheWritePrice] = useState('')
  137    const [editingId, setEditingId] = useState<string | null>(null)
  138    const [defaultForKinds, setDefaultForKinds] = useState<string[]>([])
  139    const [status, setStatus] = useState<Status>({ kind: 'idle' })
  140    const [pending, startTransition] = useTransition()
  141    const { sort, sortBy } = useLocalTableSort({
  142      storageKey: SORT_KEY,
  143      columns: SORT_COLUMNS,
  144      defaultSort: { column: 'runtime', direction: 'asc' },
  145    })
  146  
  147    function toggleKind(kind: string) {
  148      setDefaultForKinds((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]))
  149    }
  150  
  151    function submit() {
  152      let input: AddModelInput
  153      if (runtime === AgentRuntime.HARNESS) {
  154        // Een HARNESS-configuratie heeft geen prijs: er wordt er niets van gecontroleerd of meegestuurd.
  155        if (!modelId.trim() || !displayName.trim()) {
  156          setStatus({ kind: 'error', message: 'Vul model_id en weergavenaam in.' })
  157          return
  158        }
  159        input = { runtime, model_id: modelId.trim(), display_name: displayName.trim(), active: true }
  160      } else {
  161        const inp = Number(inputPrice)
  162        const out = Number(outputPrice)
  163        if (!modelId.trim() || !displayName.trim() || Number.isNaN(inp) || Number.isNaN(out)) {
  164          setStatus({ kind: 'error', message: 'Vul model_id, weergavenaam en beide prijzen in.' })
  165          return
  166        }
  167        if (runtime === AgentRuntime.CODEX) {
  168          // OpenAI heeft eigen cache-tarieven: cached input is verplicht, cache write optioneel (leeg = 0).
  169          const cr = Number(cacheReadPrice)
  170          const cw = cacheWritePrice.trim() === '' ? 0 : Number(cacheWritePrice)
  171          if (cacheReadPrice.trim() === '' || Number.isNaN(cr) || Number.isNaN(cw)) {
  172            setStatus({ kind: 'error', message: 'Vul de cached input-prijs in (cache write is optioneel).' })
  173            return
  174          }
  175          input = {
  176            runtime,
  177            model_id: modelId.trim(),
  178            display_name: displayName.trim(),
  179            input_price_per_1m: inp,
  180            output_price_per_1m: out,
  181            cache_read_price_per_1m: cr,
  182            cache_write_price_per_1m: cw,
  183            active: true,
  184            default_for_kinds: [],
  185          }
  186        } else {
  187          input = {
  188            runtime,
  189            model_id: modelId.trim(),
  190            display_name: displayName.trim(),
  191            input_price_per_1m: inp,
  192            output_price_per_1m: out,
  193            active: true,
  194            default_for_kinds: defaultForKinds,
  195          }
  196        }
  197      }
  198      startTransition(async () => {
  199        const res = await addModelAction(input)
  200        if (res.ok) {
  201          setStatus({ kind: 'ok', message: `Model opgeslagen${VALIDATED_NOTE[res.validated]}.` })
  202          setModelId('')
  203          setDisplayName('')
  204          setInputPrice('')
  205          setOutputPrice('')
  206          setCacheReadPrice('')
  207          setCacheWritePrice('')
  208          setDefaultForKinds([])
  209        } else {
  210          setStatus({ kind: 'error', message: res.error })
  211        }
  212      })
  213    }
  214  
  215    function toggleActive(id: string, next: boolean) {
  216      startTransition(async () => {
  217        const res = await setModelActiveAction(id, next)
  218        if (!res.ok) setStatus({ kind: 'error', message: res.error })
  219      })
  220    }
  221  
  222    function savePrices(m: ModelWithPrice, draft: PriceDraft) {
  223      const parsed = {} as Record<PriceKey, number>
  224      for (const f of PRICE_FIELDS) {
  225        const raw = draft[f.key].trim()
  226        const n = Number(raw)
  227        if (raw === '' || Number.isNaN(n)) {
  228          setStatus({ kind: 'error', message: `Vul een geldige prijs in voor ${f.label}.` })
  229          return
  230        }
  231        parsed[f.key] = n
  232      }
  233      startTransition(async () => {
  234        const res = await updateModelPricesAction(m.id, parsed)
  235        if (res.ok) {
  236          setStatus({ kind: 'ok', message: `Prijzen van ${m.model_id} opgeslagen.` })
  237          setEditingId(null)
  238        } else {
  239          setStatus({ kind: 'error', message: res.error })
  240        }
  241      })
  242    }
  243  
  244    const columns: DataTableColumn<ModelWithPrice>[] = [
  245      { id: 'runtime', accessorFn: (m) => m.runtime, header: 'runtime', sortFn: (a, b) => compareModels(a.original, b.original, 'runtime'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.runtime}</span> },
  246      { id: 'model_id', accessorFn: (m) => m.model_id, header: 'model_id', sortFn: (a, b) => compareModels(a.original, b.original, 'model_id'), cell: ({ row }) => <span className="font-mono text-xs">{row.original.model_id}</span> },
  247      { id: 'display_name', accessorFn: (m) => m.display_name, header: 'weergavenaam', sortFn: (a, b) => compareModels(a.original, b.original, 'display_name') },
  248      { id: 'price', accessorFn: (m) => m.input_price_per_1m ?? undefined, header: 'API-prijs in/out ($/1M)', sortUndefined: 'last', sortFn: (a, b) => compareModels(a.original, b.original, 'price', sort.direction), cell: ({ row }) => {
  249        const m = row.original
  250        return <span
  251          className="font-mono text-xs text-muted-foreground"
  252          title={m.runtime === AgentRuntime.HARNESS ? undefined : `cached input ${price(m.cache_read_price_per_1m)} · cache write ${price(m.cache_write_price_per_1m)} ($/1M)`}
  253        >
  254          <span>{price(m.input_price_per_1m)} / {price(m.output_price_per_1m)}</span>
  255          {m.runtime !== AgentRuntime.HARNESS && <span className="block text-[10px]">cache {price(m.cache_read_price_per_1m)} / {price(m.cache_write_price_per_1m)}</span>}
  256        </span>
  257      } },
  258      { id: 'active', accessorFn: (m) => Number(m.active), header: 'actief', sortFn: (a, b) => compareModels(a.original, b.original, 'active'), cell: ({ row }) => {
  259        const m = row.original
  260        return <label className="inline-flex items-center gap-2">
  261          <input type="checkbox" aria-label={`${m.model_id} actief`} checked={m.active} disabled={pending} onChange={(e) => toggleActive(m.id, e.target.checked)} />
  262          <span className={capClass}>{m.active ? 'actief' : 'inactief'}</span>
  263        </label>
  264      } },
  265      { id: 'actions', header: 'acties', enableSorting: false, cell: ({ row }) => {
  266        const m = row.original
  267        if (m.runtime === AgentRuntime.HARNESS) return null
  268        return <Button size="sm" variant="outline" disabled={pending || (editingId !== null && editingId !== m.id)} onClick={() => { setEditingId(m.id); setStatus({ kind: 'idle' }) }}>
  269          Bewerken
  270        </Button>
  271      } },
  272    ]
  273  
  274    return (
  275      <div className="space-y-6">
  276        <section className="overflow-x-auto rounded-lg border border-border bg-card">
  277          <DataTable data={models} columns={columns} sort={sort} onSortColumn={(column) => sortBy(column as SortColumn)} getRowId={(m) => m.id}
  278            renderDetailRow={(m) => editingId === m.id ? <PriceEditPanel key={m.id} model={m} pending={pending} onSave={(draft) => savePrices(m, draft)} onCancel={() => setEditingId(null)} /> : null} />
  279          {models.length === 0 && <p className="px-3 py-4 text-center text-sm text-muted-foreground">Registry leeg — de editors vallen terug op de bekende ids tot je een model toevoegt.</p>}
  280        </section>
  281  
  282        <section className="space-y-4 rounded-lg border border-border bg-card p-4">
  283          <h2 className="text-sm font-semibold text-foreground">Model toevoegen</h2>
  284          <div className="grid gap-4 sm:grid-cols-2">
  285            <label className={labelClass}>
  286              <span className={capClass}>runtime</span>
  287              <select
  288                aria-label="runtime"
  289                className={fieldClass}
  290                value={runtime}
  291                onChange={(e) => setRuntime(e.target.value as AgentRuntime)}
  292              >
  293                <option value={AgentRuntime.CLAUDE}>CLAUDE</option>
  294                <option value={AgentRuntime.CODEX}>CODEX</option>
  295                <option value={AgentRuntime.HARNESS}>HARNESS</option>
  296              </select>
  297            </label>
  298            <label className={labelClass}>
  299              <span className={capClass}>model_id</span>
  300              <input
  301                aria-label="model_id"
  302                className={fieldClass}
  303                value={modelId}
  304                placeholder={MODEL_ID_PLACEHOLDER[runtime]}
  305                onChange={(e) => setModelId(e.target.value)}
  306              />
  307            </label>
  308            <label className={labelClass}>
  309              <span className={capClass}>weergavenaam</span>
  310              <input
  311                aria-label="display_name"
  312                className={fieldClass}
  313                value={displayName}
  314                placeholder="Claude Opus 6"
  315                onChange={(e) => setDisplayName(e.target.value)}
  316              />
  317            </label>
  318            {runtime !== AgentRuntime.HARNESS && (
  319              <div className="grid grid-cols-2 gap-2">
  320                <label className={labelClass}>
  321                  <span className={capClass}>input $/1M</span>
  322                  <input
  323                    aria-label="input_price_per_1m"
  324                    className={fieldClass}
  325                    inputMode="decimal"
  326                    value={inputPrice}
  327                    onChange={(e) => setInputPrice(e.target.value)}
  328                  />
  329                </label>
  330                <label className={labelClass}>
  331                  <span className={capClass}>output $/1M</span>
  332                  <input
  333                    aria-label="output_price_per_1m"
  334                    className={fieldClass}
  335                    inputMode="decimal"
  336                    value={outputPrice}
  337                    onChange={(e) => setOutputPrice(e.target.value)}
  338                  />
  339                </label>
  340              </div>
  341            )}
  342            {runtime === AgentRuntime.CODEX && (
  343              <div className="grid grid-cols-2 gap-2">
  344                <label className={labelClass}>
  345                  <span className={capClass}>cached input $/1M</span>
  346                  <input
  347                    aria-label="cache_read_price_per_1m"
  348                    className={fieldClass}
  349                    inputMode="decimal"
  350                    value={cacheReadPrice}
  351                    onChange={(e) => setCacheReadPrice(e.target.value)}
  352                  />
  353                </label>
  354                <label className={labelClass}>
  355                  <span className={capClass}>cache write $/1M (optioneel)</span>
  356                  <input
  357                    aria-label="cache_write_price_per_1m"
  358                    className={fieldClass}
  359                    inputMode="decimal"
  360                    placeholder="0"
  361                    value={cacheWritePrice}
  362                    onChange={(e) => setCacheWritePrice(e.target.value)}
  363                  />
  364                </label>
  365              </div>
  366            )}
  367          </div>
  368  
  369          {runtime === AgentRuntime.CLAUDE && (
  370            <div className="space-y-1">
  371              <span className={capClass}>zet als default voor kinds (optioneel)</span>
  372              <div className="flex flex-wrap gap-2">
  373                {kindOptions.map((kind) => (
  374                  <label key={kind} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
  375                    <input
  376                      type="checkbox"
  377                      aria-label={`default voor ${kind}`}
  378                      checked={defaultForKinds.includes(kind)}
  379                      onChange={() => toggleKind(kind)}
  380                    />
  381                    <span className="font-mono">{kind}</span>
  382                  </label>
  383                ))}
  384              </div>
  385            </div>
  386          )}
  387  
  388          <div className="flex items-center gap-3">
  389            <Button onClick={submit} disabled={pending}>
  390              {pending ? 'Bezig…' : 'Model toevoegen'}
  391            </Button>
  392            {status.kind === 'ok' && <span className="text-xs text-status-done">{status.message}</span>}
  393            {status.kind === 'error' && <span className="text-xs text-destructive">{status.message}</span>}
  394          </div>
  395          {runtime === AgentRuntime.CLAUDE && (
  396            <p className={capClass}>
  397              Prijzen zijn API-lijstprijzen in USD (standard tier). Cache-prijzen worden afgeleid (read 0.1×,
  398              write 1.25× input) en zijn daarna per model te bewerken. De prijs is handmatig; /v1/models valideert
  399              alleen het id (als er een API-key op de host staat).
  400            </p>
  401          )}
  402          {runtime === AgentRuntime.CODEX && (
  403            <p className={capClass}>
  404              Prijzen zijn API-lijstprijzen in USD (standard tier). Cached input is verplicht; cache write is
  405              optioneel (leeg = 0, niet elk OpenAI-model rekent die).
  406            </p>
  407          )}
  408        </section>
  409      </div>
  410    )
  411  }
```

## workers jobs-mapper: imports — `lib/jobs-mapper.ts` r. 1-30

`scrum4me-workers@198eb59:lib/jobs-mapper.ts`

```ts
    1  import type {
    2    AgentRuntime,
    3    ApiTokenKind,
    4    ClaudeJobKind,
    5    ClaudeJobStatus,
    6    JobSource as PrismaJobSource,
    7    ProductDocFolder,
    8    ReviewVerdict,
    9    VerifyResult,
   10  } from '@prisma/client'
   11  import {
   12    buildRuntimeMetadata,
   13    formatRuntimeLabel,
   14    jobAdapterFromDb,
   15    jobRuntimeFromDb,
   16    type JobAdapter,
   17    type JobRuntime,
   18    type JobSource as RuntimeJobSource,
   19    type WorkerCapability,
   20  } from '@/lib/job-runtime'
   21  import {
   22    buildWorkerAttributionMap,
   23    type WorkerAttribution,
   24  } from '@/lib/job-worker-attribution'
   25  import { listPriceKey, priceRowKey } from '@shared/list-price'
   26  import { buildJobDisplayReference, type JobDisplaySource } from '@/lib/job-display-reference'
   27  import {
   28    codeTitleReference,
   29    unavailableReference,
   30    type DisplayReference,
```

## workers jobs-mapper: prijskaart per runtime — `lib/jobs-mapper.ts` r. 160-200

`scrum4me-workers@198eb59:lib/jobs-mapper.ts`

```ts
  160    } as const
  161  }
  162  
  163  export const JOB_INCLUDE = {
  164    task: {
  165      select: {
  166        code: true,
  167        title: true,
  168        description: true,
  169        implementation_plan: true,
  170        story: { select: { code: true, title: true, pbi: { select: { code: true, title: true } } } },
  171      },
  172    },
  173    idea: { select: { code: true, title: true, description: true, grill_md: true, plan_md: true } },
  174    product: { select: { name: true, code: true } },
  175    sprint_run: {
  176      select: {
  177        status: true,
  178        created_at: true,
  179        sprint: { select: { sprint_goal: true, code: true } },
  180        failed_task: { select: { code: true, title: true } },
  181      },
  182    },
  183    user: { select: { username: true } },
  184    doc: { select: { id: true, folder: true, slug: true, title: true, status: true, current_revision_id: true } },
  185    doc_revision: {
  186      select: {
  187        id: true,
  188        revision: true,
  189        doc: { select: { folder: true, slug: true, title: true } },
  190      },
  191    },
  192    claimed_by_token: {
  193      select: { id: true, label: true, kind: true, user: { select: { username: true } } },
  194    },
  195    created_by_job: { select: compactJobDisplaySelect() },
  196    created_jobs: {
  197      take: 100,
  198      orderBy: { created_at: 'desc' },
  199      select: compactJobDisplaySelect(),
  200    },
```

## workers jobs-mapper: LIST_PRICE_ROW_WHERE, buildPriceMap, computeUsageEstimate — `lib/jobs-mapper.ts` r. 350-415

`scrum4me-workers@198eb59:lib/jobs-mapper.ts`

```ts
  350      } | null
  351    } | null
  352  }
  353  
  354  // PBI-36: alleen API/USD/standard-kaarten (de lijstprijs) worden geladen.
  355  export const LIST_PRICE_ROW_WHERE = {
  356    billing_mode: 'API',
  357    billing_unit: 'USD',
  358    service_tier: 'standard',
  359  } as const
  360  
  361  export type PriceRow = {
  362    model_id: string
  363    runtime: string
  364    provider: string
  365    billing_mode: string
  366    billing_unit: string
  367    service_tier: string
  368    input_price_per_1m: { toString: () => string }
  369    output_price_per_1m: { toString: () => string }
  370    cache_read_price_per_1m: { toString: () => string }
  371    cache_write_price_per_1m: { toString: () => string }
  372  }
  373  
  374  export function buildPriceMap(prices: PriceRow[]): Map<string, PriceRow> {
  375    return new Map(prices.map((p) => [priceRowKey(p), p]))
  376  }
  377  
  378  export function pickDescription(j: RawJob): string | null {
  379    switch (j.kind) {
  380      case 'TASK_IMPLEMENTATION':
  381      case 'TASK_REVIEW':
  382        return j.task?.implementation_plan ?? j.task?.description ?? null
  383      case 'IDEA_GRILL':
  384        return j.idea?.grill_md ?? j.idea?.description ?? null
  385      case 'IDEA_MAKE_PLAN':
  386      case 'IDEA_REVIEW_PLAN':
  387        return j.idea?.plan_md ?? j.idea?.description ?? null
  388      case 'PLAN_CHAT':
  389        return j.idea?.description ?? null
  390      case 'SPEC_REVIEW':
  391        return j.doc?.title ?? null
  392      case 'SPRINT_IMPLEMENTATION':
  393        return null
  394      default:
  395        return null
  396    }
  397  }
  398  
  399  export function computeCost(j: RawJob, priceMap: Map<string, PriceRow>): number | null {
  400    // PBI-36: bedrag = API-lijstprijs in USD van de kaart van de runtime (listPriceKey); pricing_model_id
  401    // wint van model_id. Een ontbrekende kaart geeft null, nooit 0. Bij een HARNESS-job is dat het model dat de aanbieder meldt,
  402    // en dat kan gelijk zijn aan een Claude- of Codex-prijsrij. Workers toont voor HARNESS geen bedrag.
  403    if (j.runtime === 'HARNESS') return null
  404    // Een job zonder runtime-waarde (smalle select/fixture) krijgt dezelfde claude-standaard als mapJob.
  405    const key = listPriceKey(j.runtime ?? 'CLAUDE', j.pricing_model_id ?? j.model_id)
  406    if (!key) return null
  407    const p = priceMap.get(key)
  408    if (!p || j.input_tokens == null) return null
  409    return (
  410      ((j.input_tokens ?? 0) * Number(p.input_price_per_1m.toString())) / 1_000_000 +
  411      ((j.output_tokens ?? 0) * Number(p.output_price_per_1m.toString())) / 1_000_000 +
  412      ((j.cache_read_tokens ?? 0) * Number(p.cache_read_price_per_1m.toString())) / 1_000_000 +
  413      ((j.cache_write_tokens ?? 0) * Number(p.cache_write_price_per_1m.toString())) / 1_000_000
  414    )
  415  }
```

## workers test model-registry: HARNESS zonder prijs — `__tests__/lib/model-registry.test.ts` r. 105-130

`scrum4me-workers@198eb59:__tests__/lib/model-registry.test.ts`

```ts
  105      mockAgentFindMany.mockResolvedValue([
  106        { id: 'b', runtime: 'CLAUDE', model_id: 'claude-opus-6', display_name: 'Claude Opus 6', active: true, sort_order: 5, notes: null },
  107      ])
  108      mockPriceFindMany.mockResolvedValue([])
  109      const rows = await listModelsWithPrices()
  110      expect(rows[0].input_price_per_1m).toBeNull()
  111      expect(rows[0].output_price_per_1m).toBeNull()
  112      expect(rows[0].cache_read_price_per_1m).toBeNull()
  113      expect(rows[0].cache_write_price_per_1m).toBeNull()
  114    })
  115  
  116    it('HARNESS heeft nooit een prijs', async () => {
  117      mockAgentFindMany.mockResolvedValue([
  118        { id: 'h', runtime: 'HARNESS', model_id: 'gsq-lokaal', display_name: 'GSQ', active: true, sort_order: 1, notes: null },
  119      ])
  120      mockPriceFindMany.mockResolvedValue([card('HARNESS', 'anthropic', 'gsq-lokaal')])
  121      const rows = await listModelsWithPrices()
  122      expect(rows[0].input_price_per_1m).toBeNull()
  123      expect(rows[0].cache_write_price_per_1m).toBeNull()
  124    })
  125  })
```

## workers usage-detail: bestaand woord modelherkomst — `components/usage/usage-detail.tsx` r. 240-252

`scrum4me-workers@198eb59:components/usage/usage-detail.tsx`

```tsx
  240          {row.endedAt
  241            ? ` · Einde: ${formatUsageDateTime(row.endedAt)}`
  242            : " · Nog open"}
  243        </p>
  244        {row.source === "jobs" && (
  245          <p className="text-sm">
  246            Jobstatus: {row.jobStatus} · {row.terminal ? "definitief" : "voorlopig"}
  247            {row.captureStatus ? ` · capture ${row.captureStatus}` : " · capture-status onbekend"}
  248            {row.model ? ` · ${row.model[0] ?? "runtime onbekend"}/${row.model[1] ?? "model onbekend"}` : ""}
  249            {row.pricingModelSource ? ` · modelherkomst ${pricingSourceLabel(row.pricingModelSource)}` : " · modelherkomst onbekend"}
  250          </p>
  251        )}
  252        {tokenQuality.status !== "known" && (
```

## workers package.json — `package.json` r. 1-65

`scrum4me-workers@198eb59:package.json`

```json
    1  {
    2    "name": "scrum4me-workers",
    3    "version": "1.2.0",
    4    "private": true,
    5    "scripts": {
    6      "predev": "bash scripts/gen-schema.sh > prisma/schema.prisma && prisma generate",
    7      "dev": "next dev -p 3010 --webpack",
    8      "prebuild": "bash scripts/gen-schema.sh > prisma/schema.prisma && prisma generate",
    9      "build": "next build --webpack",
   10      "start": "next start -p 3010",
   11      "postinstall": "bash scripts/gen-schema.sh > prisma/schema.prisma && prisma generate || true",
   12      "lint": "eslint .",
   13      "typecheck": "tsc --noEmit",
   14      "test": "vitest run",
   15      "test:watch": "vitest",
   16      "verify": "npm run lint && npm run typecheck && npm test"
   17    },
   18    "dependencies": {
   19      "@base-ui/react": "^1.5.0",
   20      "@modelcontextprotocol/sdk": "^1.29.0",
   21      "@prisma/adapter-pg": "^7.8.0",
   22      "@prisma/client": "^7.8.0",
   23      "@tanstack/react-table": "9.2.4",
   24      "bcryptjs": "^2.4.3",
   25      "class-variance-authority": "^0.7.1",
   26      "clsx": "^2.1.1",
   27      "immer": "^10.2.0",
   28      "iron-session": "^8.0.4",
   29      "next": "16.2.4",
   30      "pg": "^8.13.1",
   31      "qrcode.react": "^4.2.0",
   32      "react": "19.2.0",
   33      "react-dom": "19.2.0",
   34      "react-markdown": "^10.1.0",
   35      "recharts": "^3.10.1",
   36      "remark-gfm": "^4.0.1",
   37      "sonner": "^1.7.4",
   38      "tailwind-merge": "^3.6.0",
   39      "web-push": "^3.6.7",
   40      "yaml": "^2.9.0",
   41      "zod": "^3.25.76",
   42      "zustand": "^5.0.13"
   43    },
   44    "devDependencies": {
   45      "@tailwindcss/postcss": "^4",
   46      "@testing-library/jest-dom": "^6.9.1",
   47      "@testing-library/react": "^16.3.2",
   48      "@testing-library/user-event": "14.6.7",
   49      "@types/bcryptjs": "^2.4.6",
   50      "@types/node": "^24",
   51      "@types/pg": "^8.11.10",
   52      "@types/react": "19.2.2",
   53      "@types/react-dom": "19.2.1",
   54      "@types/web-push": "^3.6.4",
   55      "dotenv": "^16.4.5",
   56      "eslint": "^9",
   57      "eslint-config-next": "16.2.4",
   58      "jsdom": "^29.1.1",
   59      "prisma": "^7.8.0",
   60      "tailwindcss": "^4",
   61      "tsx": "^4.19.0",
   62      "typescript": "^5.6.0",
   63      "vitest": "^2.0.0"
   64    }
   65  }
```

## workers CI — `.forgejo/workflows/ci.yml` r. 1-34

`scrum4me-workers@198eb59:.forgejo/workflows/ci.yml`

```yaml
    1  name: CI
    2  
    3  on:
    4    pull_request:
    5      types: [opened, synchronize, reopened]
    6    push:
    7      branches:
    8        - main
    9    workflow_dispatch:
   10  
   11  jobs:
   12    verify:
   13      name: Verify
   14      runs-on: ubuntu-latest
   15      env:
   16        DATABASE_URL: postgresql://placeholder:placeholder@localhost:5432/placeholder
   17      steps:
   18        - name: Checkout
   19          uses: actions/checkout@v4
   20          with:
   21            submodules: recursive
   22  
   23        - name: Set up Node
   24          uses: actions/setup-node@v4
   25          with:
   26            node-version: 22
   27  
   28        - name: Install dependencies
   29          run: npm ci
   30  
   31        - name: Verify
   32          # Keep Vitest's UI tests responsive on the shared Forgejo runner.
   33          run: npm run verify -- -- --maxWorkers=2 --minWorkers=1
   34  
```

## workers .gitmodules — `.gitmodules` r. 1-3

`scrum4me-workers@198eb59:.gitmodules`

```ini
    1  [submodule "vendor/scrum4me-shared"]
    2  	path = vendor/scrum4me-shared
    3  	url = https://git.jp-visser.nl/janpeter/scrum4me-shared.git
```

## agent-harness harness.json (productie-repokopie) — `deploy/max2/harness.json` r. 1-136

`goofy-moser-804c51@8851723:deploy/max2/harness.json`

```json
    1  {
    2    "litellm": {
    3      "baseUrl": "http://127.0.0.1:4000/v1",
    4      "configPath": "/etc/agent-harness/litellm/config.yaml",
    5      "composePath": "/etc/agent-harness/litellm/compose.yml"
    6    },
    7    "configurations": {
    8      "gsq-lokaal": {
    9        "costMode": "local",
   10        "contextTokens": 65536
   11      },
   12      "qwen3.8-or": {
   13        "costMode": "hosted",
   14        "contextTokens": 65536,
   15        "reasoningEffort": "medium"
   16      },
   17      "qwen3.8-or-16k": {
   18        "costMode": "hosted",
   19        "contextTokens": 16384,
   20        "reasoningEffort": "medium"
   21      },
   22      "qwen3.8-or-32k": {
   23        "costMode": "hosted",
   24        "contextTokens": 32768,
   25        "reasoningEffort": "medium"
   26      },
   27      "qwen3.8-or-128k": {
   28        "costMode": "hosted",
   29        "contextTokens": 131072,
   30        "reasoningEffort": "medium"
   31      },
   32      "deepseek-v4-flash-or": {
   33        "costMode": "hosted",
   34        "contextTokens": 65536,
   35        "reasoningEffort": "high"
   36      },
   37      "deepseek-v4-pro-or": {
   38        "costMode": "hosted",
   39        "contextTokens": 65536,
   40        "reasoningEffort": "high"
   41      },
   42      "glm-5.3-or": {
   43        "costMode": "hosted",
   44        "contextTokens": 65536,
   45        "reasoningEffort": "high"
   46      },
   47      "minimax-m3-or": {
   48        "costMode": "hosted",
   49        "contextTokens": 65536
   50      }
   51    },
   52    "mcp": {
   53      "command": "/home/janpeter/Development/scrum4me-mcp-stable/node_modules/.bin/tsx",
   54      "args": [
   55        "--tsconfig",
   56        "/home/janpeter/Development/scrum4me-mcp-stable/tsconfig.json",
   57        "/home/janpeter/Development/scrum4me-mcp-stable/src/index.ts"
   58      ],
   59      "env": {
   60        "SCRUM4ME_TOKEN": "${SCRUM4ME_TOKEN}",
   61        "DATABASE_URL": "${DATABASE_URL}",
   62        "DIRECT_URL": "${DIRECT_URL}",
   63        "GIT_ASKPASS": "/usr/local/lib/agent-harness/forgejo-askpass.sh",
   64        "GIT_TERMINAL_PROMPT": "0",
   65        "GIT_CONFIG_GLOBAL": "/dev/null",
   66        "GIT_CONFIG_NOSYSTEM": "1",
   67        "SCRUM4ME_AGENT_WORKTREE_DIR": "/var/lib/agent-harness/worktrees",
   68        "SCRUM4ME_REPO_ROOT_cmuhjw9e80003mt7rq4w3sauu": "/var/lib/agent-harness/repos/agent-harness",
   69        "SCRUM4ME_REPO_ROOT_REPO_agent-harness": "/var/lib/agent-harness/repos/agent-harness",
   70        "SCRUM4ME_REPO_ROOT_REPO_scrum4me-mcp": "/var/lib/agent-harness/repos/scrum4me-mcp",
   71        "FORGEJO_PUSH_TOKEN": "${FORGEJO_PUSH_TOKEN}"
   72      }
   73    },
   74    "allow": {
   75      "IDEA_CHAT": [
   76        "search_product_docs",
   77        "get_product_doc",
   78        "list_product_docs",
   79        "related_product_docs"
   80      ],
   81      "AGENT_CHAT": [
   82        "search_product_docs",
   83        "get_product_doc",
   84        "list_product_docs",
   85        "related_product_docs",
   86        "list_issues",
   87        "get_issue",
   88        "create_issue",
   89        "search_notes",
   90        "get_note",
   91        "create_note",
   92        "list_note_keywords"
   93      ]
   94    },
   95    "limits": {
   96      "maxTurns": 8,
   97      "maxOutputTokens": 4096,
   98      "maxWallSeconds": 240,
   99      "maxToolErrors": 2
  100    },
  101    "waitSeconds": 300,
  102    "task": {
  103      "limits": {
  104        "maxTurns": 80,
  105        "maxOutputTokens": 80000,
  106        "maxWallSeconds": 2400,
  107        "maxToolErrors": 8
  108      },
  109      "image": "node:24-bookworm",
  110      "uid": 1000,
  111      "gid": 1000,
  112      "npmCacheDir": "/var/lib/agent-harness/npm-cache",
  113      "recipes": [
  114        {
  115          "repoUrl": "https://git.jp-visser.nl/janpeter/agent-harness.git",
  116          "prepare": [
  117            "npm ci"
  118          ],
  119          "verify": "npm run verify"
  120        },
  121        {
  122          "repoUrl": "https://git.jp-visser.nl/janpeter/scrum4me-mcp.git",
  123          "prepare": [
  124            "npm ci",
  125            "npm run prisma:generate"
  126          ],
  127          "verify": "npm run typecheck && npm run typecheck:tests && npx vitest run --exclude __tests__/ppe-bundle1-parity.test.ts --exclude __tests__/branch-safety.test.ts --exclude __tests__/default-branch.test.ts --exclude __tests__/worktree-branch-safety.test.ts --exclude __tests__/update-job-status-local-llm-chain.test.ts --exclude __tests__/update-job-status-local-llm-done-gitlink.test.ts --exclude __tests__/git/local-llm.test.ts"
  128        }
  129      ]
  130    },
  131    "workerLog": {
  132      "dir": "/srv/scrum4me/worker-logs",
  133      "pool": "harness",
  134      "instance": "max2"
  135    }
  136  }
```

## agent-harness LiteLLM-config (productie-repokopie) — `deploy/max2/litellm/config.yaml` r. 1-101

`goofy-moser-804c51@8851723:deploy/max2/litellm/config.yaml`

```yaml
    1  # LiteLLM config for the M45-2d harness worker on max2 (production). Keys only as os.environ/...: the values come from
    2  # the compose env file (/etc/agent-harness/litellm.env by default), never from this repo. No database, no callbacks.
    3  # The model_name values are exactly the configuration names in harness.json (a test pins that).
    4  model_list:
    5    # Local: max2's Ollama, reached through litellm-ollama-bridge.service on the litellm network's gateway.
    6    - model_name: gsq-lokaal
    7      litellm_params:
    8        model: openai/qwen3.8-gsq-rco:27b-iq3_s-text
    9        api_base: http://172.30.82.1:11434/v1
   10        api_key: "none"
   11        timeout: 600
   12    # Hosted: OpenRouter at BF16, no data collection, no silent fallback. extra_body is merged into every request
   13    # of this deployment. The trial of increment 1 measured that the provider block reaches OpenRouter (docs/runbooks/litellm-max2.md).
   14    - model_name: qwen3.8-or
   15      litellm_params: &qwen38or-params
   16        model: openrouter/qwen/qwen3.8-27b
   17        api_key: os.environ/OPENROUTER_API_KEY
   18        timeout: 600
   19        extra_body:
   20          provider:
   21            quantizations: ["bf16"]
   22            data_collection: "deny"
   23            require_parameters: true
   24            allow_fallbacks: false
   25      # ISS-5: LiteLLM 1.83.3 allows reasoning_effort for OpenRouter only when its model cost map marks the model as
   26      # reasoning-capable. That map is fetched live from GitHub at every container start, and on 2026-10-09 LiteLLM removed
   27      # every openrouter/* row from it (PRs #45665-#45669), so the harness's reasoningEffort got HTTP 400. This registers the
   28      # capability for this deployment itself (router registers model_info under openrouter/qwen/qwen3.8-27b), independent
   29      # of that map. The cost per answer still comes from OpenRouter's usage.cost in the body, not from the map.
   30      model_info: &qwen38or-info
   31        supports_reasoning: true
   32    # Context-window trial (2026-10-18): the same OpenRouter deployment under three more names, so harness.json can give each
   33    # its own contextTokens (the model itself takes 1M). The harness, not the provider, enforces the window: it stubs the
   34    # oldest tool results and stops with CONTEXT_EXHAUSTED when even that does not fit. Only the name differs per entry.
   35    - model_name: qwen3.8-or-16k
   36      litellm_params: *qwen38or-params
   37      model_info: *qwen38or-info
   38    - model_name: qwen3.8-or-32k
   39      litellm_params: *qwen38or-params
   40      model_info: *qwen38or-info
   41    - model_name: qwen3.8-or-128k
   42      litellm_params: *qwen38or-params
   43      model_info: *qwen38or-info
   44    # Model comparison (2026-10-18): four more OpenRouter models. None of them has a BF16 endpoint, so these pin FP8 (JP's
   45    # choice): near the original quality, unlike fp4/int4, and "unknown" is excluded so a measurement says what it ran on. Each
   46    # model has 8-16 FP8 endpoints with tools, so a fallback to the next endpoint is allowed here (the BF16 pin above has one
   47    # endpoint and no fallback). sort: price takes the cheapest endpoint that passes the filters; max_price (USD per million
   48    # tokens) keeps an expensive endpoint out. supports_reasoning: true for the same reason as ISS-5 above.
   49    # Reasoning effort differs per model, because OpenRouter's model metadata (reasoning.supported_efforts, 2026-10-18) does:
   50    # DeepSeek V4 takes xhigh/high/none and GLM-5.3 max/high/low (reasoning mandatory), so harness.json sets "high" for both,
   51    # the nearest to qwen3.8-or's "medium" that they accept; MiniMax-M3 offers no effort choice, so harness.json sets none.
   52    - model_name: deepseek-v4-flash-or
   53      litellm_params:
   54        model: openrouter/deepseek/deepseek-v4-flash
   55        api_key: os.environ/OPENROUTER_API_KEY
   56        timeout: 600
   57        extra_body: &or-fp8-extra
   58          provider:
   59            quantizations: ["fp8"]
   60            data_collection: "deny"
   61            require_parameters: true
   62            allow_fallbacks: true
   63            sort: "price"
   64            max_price:
   65              prompt: 2
   66              completion: 5
   67      model_info: &or-reasoning-info
   68        supports_reasoning: true
   69    - model_name: deepseek-v4-pro-or
   70      litellm_params:
   71        model: openrouter/deepseek/deepseek-v4-pro
   72        api_key: os.environ/OPENROUTER_API_KEY
   73        timeout: 600
   74        extra_body: *or-fp8-extra
   75      model_info: *or-reasoning-info
   76    - model_name: glm-5.3-or
   77      litellm_params:
   78        model: openrouter/z-ai/glm-5.3
   79        api_key: os.environ/OPENROUTER_API_KEY
   80        timeout: 600
   81        extra_body: *or-fp8-extra
   82      model_info: *or-reasoning-info
   83    - model_name: minimax-m3-or
   84      litellm_params:
   85        model: openrouter/minimax/minimax-m3
   86        api_key: os.environ/OPENROUTER_API_KEY
   87        timeout: 600
   88        extra_body: *or-fp8-extra
   89      model_info: *or-reasoning-info
   90  
   91  litellm_settings:
   92    turn_off_message_logging: true
   93  
   94  router_settings:
   95    # One deployment per model and no fallbacks, so a cooldown has nothing to route around: after an upstream error it would
   96    # only answer the next requests for 5 s with LiteLLM's own 429 ("No deployments available"). That hides real upstream
   97    # answers from the harness. Seen on 1.83.3.
   98    disable_cooldowns: true
   99  
  100  general_settings:
  101    master_key: os.environ/LITELLM_MASTER_KEY
```

# Aanvulling plan-ronde 1 (bestanden die het plan noemt)

Toegevoegd na plan-review ronde 1. De secties hierboven zijn ongewijzigd; regelnummers daarin blijven geldig. agent-harness-fragmenten hieronder komen van `a2eb8c316a4552a97d357f138e924498538110d3`.

## workers gen-schema.sh (schrijft naar stdout) — `scripts/gen-schema.sh` r. 1-28

`scrum4me-workers@198eb59:scripts/gen-schema.sh`

```bash
    1  #!/usr/bin/env bash
    2  # Generate prisma/schema.prisma from scrum4me-shared canonical.
    3  # Strips url= / directUrl= lines because Prisma 7 prisma.config.ts owns
    4  # connection URLs (would conflict with datasource block).
    5  
    6  set -euo pipefail
    7  
    8  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    9  SHARED="$ROOT/vendor/scrum4me-shared"
   10  
   11  # A fresh git worktree does not auto-check-out submodules, so vendor/scrum4me-shared/
   12  # starts empty and the @shared/* tsconfig alias breaks typecheck/build. Self-heal by
   13  # initializing the submodule when its lib/ (the @shared/* target) is missing. || true so
   14  # a network/auth failure doesn't abort install — the hard gate below reports it instead.
   15  if [ ! -d "$SHARED/lib" ]; then
   16    echo "scrum4me-shared submodule not checked out — running 'git submodule update --init'…" >&2
   17    git -C "$ROOT" submodule update --init --recursive vendor/scrum4me-shared >&2 || true
   18  fi
   19  
   20  if [ ! -f "$SHARED/scripts/gen-consumer-schema.sh" ]; then
   21    echo "error: shared submodule not initialized — run 'git submodule update --init vendor/scrum4me-shared'" >&2
   22    exit 1
   23  fi
   24  
   25  mkdir -p "$ROOT/prisma"
   26  PRISMA_CLIENT_OUTPUT="../node_modules/.prisma/client" \
   27    bash "$SHARED/scripts/gen-consumer-schema.sh" \
   28    | sed -E '/^[[:space:]]*(url|directUrl)[[:space:]]*=/d'
```

## workers prisma.config.ts — `prisma.config.ts` r. 1-13

`scrum4me-workers@198eb59:prisma.config.ts`

```ts
    1  import * as dotenv from 'dotenv'
    2  import { defineConfig } from 'prisma/config'
    3  
    4  // Load .env.local first (Next.js convention), then fall back to .env
    5  dotenv.config({ path: '.env.local' })
    6  dotenv.config()
    7  
    8  export default defineConfig({
    9    schema: 'prisma/schema.prisma',
   10    datasource: {
   11      url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
   12    },
   13  })
```

## workers lib/prisma.ts (geen server-only, geen dotenv) — `lib/prisma.ts` r. 1-30

`scrum4me-workers@198eb59:lib/prisma.ts`

```ts
    1  import { PrismaClient } from '@prisma/client'
    2  import { Pool } from 'pg'
    3  import { PrismaPg } from '@prisma/adapter-pg'
    4  
    5  // During `next build` page-data collection, route modules are evaluated to
    6  // inspect their exports — at that point DATABASE_URL is not yet available
    7  // (docker-compose env_file lands at runtime). We default to an empty
    8  // connection string so module-eval succeeds; Pool/PrismaPg/PrismaClient
    9  // initialize lazily without actually connecting. The first real query at
   10  // runtime will fail clearly if DATABASE_URL is still missing.
   11  // Mirrors the SKIP_ENV_VALIDATION escape hatch in `lib/env.ts`.
   12  function createPrismaClient() {
   13    const url = process.env.DATABASE_URL ?? ''
   14    const pool = new Pool({ connectionString: url })
   15    const adapter = new PrismaPg(pool)
   16    return new PrismaClient({
   17      adapter,
   18      log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
   19    })
   20  }
   21  
   22  declare global {
   23    var __prisma: PrismaClient | undefined
   24  }
   25  
   26  export const prisma = globalThis.__prisma ?? createPrismaClient()
   27  
   28  if (process.env.NODE_ENV !== 'production') {
   29    globalThis.__prisma = prisma
   30  }
```

## workers .gitignore (prisma/schema.prisma niet getrackt) — `.gitignore` r. 1-12

`scrum4me-workers@198eb59:.gitignore`

```text
    1  node_modules
    2  .next/
    3  out/
    4  dist/
    5  *.log
    6  .DS_Store
    7  .env*
    8  !.env.example
    9  prisma/schema.prisma
   10  prisma/migrations/
   11  .vercel
   12  .turbo
```

## workers tsx-scriptprecedent — `scripts/check-review-source.ts` r. 1-61

`scrum4me-workers@198eb59:scripts/check-review-source.ts`

```ts
    1  import { createHash } from 'node:crypto'
    2  import { readFile } from 'node:fs/promises'
    3  import { pathToFileURL } from 'node:url'
    4  import { parseArgs } from 'node:util'
    5  
    6  import { MARKDOWN_PREVIEW_MAX_BYTES } from '@shared/markdown-profile'
    7  import { readReviewDocuments } from '@shared/queue-review-documents'
    8  
    9  type CheckResult =
   10    | { ok: true; sha256: string }
   11    | { ok: false; reason: 'invalid-meta' | 'missing-key' | 'too-large' | 'hash-mismatch' }
   12  
   13  export function checkReviewSource(meta: unknown, key: string, bytes: Uint8Array): CheckResult {
   14    const state = readReviewDocuments(meta)
   15    if (state.status !== 'available') return { ok: false, reason: 'invalid-meta' }
   16  
   17    const reference = state.items.find(item => item.key === key)
   18    if (!reference) return { ok: false, reason: 'missing-key' }
   19    if (bytes.byteLength > MARKDOWN_PREVIEW_MAX_BYTES) return { ok: false, reason: 'too-large' }
   20  
   21    const sha256 = createHash('sha256').update(bytes).digest('hex')
   22    return sha256 === reference.sha256
   23      ? { ok: true, sha256 }
   24      : { ok: false, reason: 'hash-mismatch' }
   25  }
   26  
   27  async function main(): Promise<void> {
   28    const { values } = parseArgs({
   29      options: {
   30        meta: { type: 'string' },
   31        key: { type: 'string' },
   32        file: { type: 'string' },
   33      },
   34      strict: true,
   35    })
   36    if (!values.meta || !values.key || !values.file) {
   37      throw new Error('usage: --meta <json-file> --key <key> --file <markdown-file>')
   38    }
   39  
   40    const [metaBytes, sourceBytes] = await Promise.all([
   41      readFile(values.meta),
   42      readFile(values.file),
   43    ])
   44    const meta = JSON.parse(metaBytes.toString('utf8')) as unknown
   45    const result = checkReviewSource(meta, values.key, sourceBytes)
   46    const hash = result.ok ? result.sha256 : '-'
   47    console.log(`key=${values.key} sha256=${hash} outcome=${result.ok ? 'ok' : result.reason}`)
   48    if (!result.ok) process.exitCode = 1
   49  }
   50  
   51  const directEntry = process.argv[1]
   52    ? import.meta.url === pathToFileURL(process.argv[1]).href
   53    : false
   54  
   55  if (directEntry) {
   56    main().catch((error: unknown) => {
   57      const reason = error instanceof SyntaxError ? 'invalid-json' : 'input-error'
   58      console.error(`key=unknown sha256=- outcome=${reason}`)
   59      process.exitCode = 1
   60    })
   61  }
```

## workers DataTable — `components/shared/data-table.tsx` r. 1-45

`scrum4me-workers@198eb59:components/shared/data-table.tsx`

```tsx
    1  'use client'
    2  
    3  import { Fragment, type ReactNode } from 'react'
    4  import {
    5    createSortedRowModel,
    6    rowSortingFeature,
    7    tableFeatures,
    8    useTable,
    9    type ColumnDef,
   10    type RowData,
   11  } from '@tanstack/react-table'
   12  import {
   13    Table,
   14    TableBody,
   15    TableCell,
   16    TableHead,
   17    TableHeader,
   18    TableRow,
   19  } from '@/components/ui/table'
   20  
   21  const features = tableFeatures({
   22    rowSortingFeature,
   23    sortedRowModel: createSortedRowModel(),
   24  })
   25  
   26  export type DataTableColumn<TData extends RowData> = ColumnDef<typeof features, TData>
   27  export type SingleSort = { column: string; direction: 'asc' | 'desc' }
   28  
   29  export function DataTable<TData extends RowData>({
   30    data,
   31    columns,
   32    sort,
   33    onSortColumn,
   34    getRowId,
   35    getRowDomId,
   36    onRowActivate,
   37    renderDetailRow,
   38    getRowTitle,
   39    getRowClassName,
   40    getSortButtonLabel,
   41    caption,
   42    'data-debug-id': tableDebugId,
   43  }: {
   44    data: ReadonlyArray<TData>
   45    columns: DataTableColumn<TData>[]
```

## workers useLocalTableSort — `hooks/use-local-table-sort.ts` r. 1-57

`scrum4me-workers@198eb59:hooks/use-local-table-sort.ts`

```ts
    1  'use client'
    2  
    3  import { useCallback, useState, useSyncExternalStore } from 'react'
    4  
    5  export type LocalTableSort<TColumn extends string> = {
    6    column: TColumn
    7    direction: 'asc' | 'desc'
    8  }
    9  
   10  export function useLocalTableSort<TColumn extends string>({
   11    storageKey,
   12    columns,
   13    defaultSort,
   14  }: {
   15    storageKey: string
   16    columns: readonly TColumn[]
   17    defaultSort: LocalTableSort<TColumn>
   18  }) {
   19    const [chosenSort, setChosenSort] = useState<LocalTableSort<TColumn> | null>(null)
   20  
   21    const getSnapshot = useCallback(() => {
   22      try { return window.localStorage.getItem(storageKey) } catch { return null }
   23    }, [storageKey])
   24    const subscribe = useCallback((onStoreChange: () => void) => {
   25      const onStorage = (event: StorageEvent) => {
   26        if (event.key !== null && event.key !== storageKey) return
   27        setChosenSort(null)
   28        onStoreChange()
   29      }
   30      window.addEventListener('storage', onStorage)
   31      return () => window.removeEventListener('storage', onStorage)
   32    }, [storageKey])
   33    const saved = useSyncExternalStore(subscribe, getSnapshot, () => null)
   34  
   35    let storedSort: LocalTableSort<TColumn> | null = null
   36    try {
   37      const value: unknown = JSON.parse(saved ?? 'null')
   38      if (value && typeof value === 'object' && 'column' in value && 'direction' in value
   39        && typeof value.column === 'string' && columns.includes(value.column as TColumn)
   40        && (value.direction === 'asc' || value.direction === 'desc')) {
   41        storedSort = { column: value.column as TColumn, direction: value.direction }
   42      }
   43    } catch { /* Invalid saved values use the default. */ }
   44    const sort = chosenSort ?? storedSort ?? defaultSort
   45  
   46    function sortBy(column: TColumn) {
   47      if (!columns.includes(column)) return
   48      const next: LocalTableSort<TColumn> = {
   49        column,
   50        direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc',
   51      }
   52      setChosenSort(next)
   53      try { window.localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep the current mount usable. */ }
   54    }
   55  
   56    return { sort, sortBy }
   57  }
```

## workers test actions/model-registry: opzet — `__tests__/actions/model-registry.test.ts` r. 1-60

`scrum4me-workers@198eb59:__tests__/actions/model-registry.test.ts`

```ts
    1  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
    2  import type { AddModelInput } from '@/actions/model-registry'
    3  
    4  // tx is de transactiecontext die $transaction aan zijn callback geeft: zo zijn de aanroepen
    5  // per delegate te controleren. "Geen DB-aanroep" = geen $transaction en geen delegate-aanroep.
    6  const tx = {
    7    agentModel: { aggregate: vi.fn(), upsert: vi.fn() },
    8    modelPrice: { upsert: vi.fn() },
    9    jobKindConfig: { updateMany: vi.fn() },
   10  }
   11  const mockPrisma = { $transaction: vi.fn(), agentModel: { findUnique: vi.fn() } }
   12  const mockRequireAdmin = vi.fn()
   13  const mockRevalidate = vi.fn()
   14  const mockFetch = vi.fn()
   15  
   16  vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
   17  vi.mock('@/lib/auth', () => ({ requireWorkersAdmin: mockRequireAdmin }))
   18  vi.mock('next/cache', () => ({ revalidatePath: mockRevalidate }))
   19  
   20  beforeEach(() => {
   21    vi.resetAllMocks()
   22    mockRequireAdmin.mockResolvedValue({ userId: 'admin1', username: 'jp', isAdmin: true })
   23    mockPrisma.$transaction.mockImplementation(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx))
   24    tx.agentModel.aggregate.mockResolvedValue({ _max: { sort_order: 30 } })
   25    // Standaard geen sleutel op de host en een gestubde fetch: een onverwachte aanroep valt zo op.
   26    vi.stubEnv('ANTHROPIC_API_KEY', '')
   27    vi.stubGlobal('fetch', mockFetch)
   28  })
   29  
   30  afterEach(() => {
   31    vi.unstubAllEnvs()
   32    vi.unstubAllGlobals()
   33  })
   34  
   35  function expectNoDbCalls() {
   36    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
   37    expect(tx.agentModel.aggregate).not.toHaveBeenCalled()
   38    expect(tx.agentModel.upsert).not.toHaveBeenCalled()
   39    expect(tx.modelPrice.upsert).not.toHaveBeenCalled()
   40    expect(tx.jobKindConfig.updateMany).not.toHaveBeenCalled()
   41  }
   42  
   43  const harnessInput = {
   44    runtime: 'HARNESS' as const,
   45    model_id: 'gsq-lokaal',
   46    display_name: 'GSQ lokaal',
   47    active: true,
   48  }
   49  
   50  const claudeInput: AddModelInput = {
   51    runtime: 'CLAUDE',
   52    model_id: 'claude-opus-6',
   53    display_name: 'Claude Opus 6',
   54    input_price_per_1m: 10,
   55    output_price_per_1m: 50,
   56    active: true,
   57    default_for_kinds: ['IDEA_CHAT'],
   58  }
   59  
   60  async function load() {
```

## workers test model-registry-editor: opzet — `__tests__/components/settings/model-registry-editor.test.tsx` r. 1-40

`scrum4me-workers@198eb59:__tests__/components/settings/model-registry-editor.test.tsx`

```tsx
    1  // @vitest-environment jsdom
    2  import React from 'react'
    3  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
    4  import { fireEvent, render, screen, within } from '@testing-library/react'
    5  import '@testing-library/jest-dom/vitest'
    6  import { AgentRuntime } from '@prisma/client'
    7  import type { ModelWithPrice } from '@/lib/settings/model-registry'
    8  
    9  vi.mock('@/actions/model-registry', () => ({
   10    addModelAction: vi.fn(),
   11    setModelActiveAction: vi.fn().mockResolvedValue({ ok: true }),
   12    updateModelPricesAction: vi.fn().mockResolvedValue({ ok: true }),
   13  }))
   14  
   15  import ModelRegistryEditor from '@/components/settings/model-registry-editor'
   16  import { addModelAction, setModelActiveAction, updateModelPricesAction } from '@/actions/model-registry'
   17  
   18  const models: ModelWithPrice[] = [
   19    { id: 'c2', runtime: AgentRuntime.CODEX, model_id: 'gpt-z', display_name: 'Zulu', active: true, sort_order: 2, notes: null, input_price_per_1m: 0, output_price_per_1m: 3, cache_read_price_per_1m: 0.3, cache_write_price_per_1m: 0 },
   20    { id: 'c1', runtime: AgentRuntime.CODEX, model_id: 'gpt-a', display_name: 'Alpha', active: false, sort_order: 1, notes: null, input_price_per_1m: 1.5, output_price_per_1m: 4, cache_read_price_per_1m: 0.15, cache_write_price_per_1m: 1.9 },
   21    { id: 'h1', runtime: AgentRuntime.CLAUDE, model_id: 'claude-a', display_name: 'Bravo', active: true, sort_order: 1, notes: null, input_price_per_1m: null, output_price_per_1m: null, cache_read_price_per_1m: null, cache_write_price_per_1m: null },
   22  ]
   23  
   24  function ids() {
   25    return within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => row.getAttribute('data-row-id'))
   26  }
   27  
   28  beforeEach(() => {
   29    vi.stubGlobal('localStorage', window.sessionStorage)
   30    window.localStorage.clear()
   31    vi.clearAllMocks()
   32  })
   33  afterEach(() => vi.unstubAllGlobals())
   34  
   35  describe('ModelRegistryEditor', () => {
   36    it('keeps curated runtime/order/id default and sorts five headings in both directions with numeric prices', () => {
   37      render(<ModelRegistryEditor models={models} kindOptions={[]} />)
   38      expect(ids()).toEqual(['h1', 'c1', 'c2'])
   39      expect(screen.getByRole('columnheader', { name: 'runtime' })).toHaveAttribute('aria-sort', 'ascending')
   40      for (const heading of ['runtime', 'model_id', 'weergavenaam', 'API-prijs in/out ($/1M)', 'actief']) {
```

## shared package.json — `package.json` r. 1-26

`scrum4me-shared@8df7f2c:package.json`

```json
    1  {
    2    "name": "@scrum4me/shared",
    3    "version": "0.1.0",
    4    "private": true,
    5    "type": "module",
    6    "description": "Canonical schema + pure-TS lib for Scrum4Me, scrum4me-workers, scrum4me-mcp",
    7    "scripts": {
    8      "test": "vitest run",
    9      "test:watch": "vitest",
   10      "typecheck": "tsc --noEmit",
   11      "verify": "bash scripts/verify-no-deps.sh && bash __tests__/scripts/verify-no-deps.test.sh && npm run typecheck && npm test"
   12    },
   13    "dependencies": {
   14      "yaml": "^2.8.4"
   15    },
   16    "peerDependencies": {
   17      "zod": "^3.25.0 || ^4.0.0"
   18    },
   19    "devDependencies": {
   20      "@electric-sql/pglite": "^0.5.8",
   21      "@types/node": "^24",
   22      "typescript": "^5.6.0",
   23      "vitest": "^2.0.0",
   24      "zod": "^4.0.0"
   25    }
   26  }
```

## shared test list-price — `__tests__/list-price.test.ts` r. 1-44

`scrum4me-shared@8df7f2c:__tests__/list-price.test.ts`

```ts
    1  import { describe, expect, it } from 'vitest'
    2  
    3  import { LIST_PRICE_PROVIDERS, listPriceCardForRuntime, listPriceKey, priceRowKey } from '../lib/list-price'
    4  
    5  describe('listPriceCardForRuntime', () => {
    6    it('maps CLAUDE to anthropic and CODEX to openai at API/USD standard', () => {
    7      expect(listPriceCardForRuntime('CLAUDE')).toEqual({ provider: 'anthropic', billing_mode: 'API', billing_unit: 'USD', service_tier: 'standard' })
    8      expect(listPriceCardForRuntime('CODEX')).toEqual({ provider: 'openai', billing_mode: 'API', billing_unit: 'USD', service_tier: 'standard' })
    9    })
   10  
   11    it.each(['HARNESS', 'claude', '', 'toString', '__proto__'])('has no card for %j', runtime => {
   12      expect(listPriceCardForRuntime(runtime)).toBeNull()
   13    })
   14  
   15    it('covers exactly the priced runtimes', () => {
   16      expect(Object.keys(LIST_PRICE_PROVIDERS).sort()).toEqual(['CLAUDE', 'CODEX'])
   17    })
   18  })
   19  
   20  describe('priceRowKey and listPriceKey', () => {
   21    const row = { runtime: 'CODEX', provider: 'openai', model_id: 'gpt-5.5', billing_mode: 'API', billing_unit: 'USD', service_tier: 'standard' }
   22  
   23    it('keys a stored row the same way as the list-price lookup', () => {
   24      expect(listPriceKey('CODEX', 'gpt-5.5')).toBe(priceRowKey(row))
   25    })
   26  
   27    it('distinguishes rows that share a model_id', () => {
   28      const keys = new Set([
   29        priceRowKey(row),
   30        priceRowKey({ ...row, billing_mode: 'SUBSCRIPTION', billing_unit: 'CREDITS' }),
   31        priceRowKey({ ...row, billing_mode: 'SUBSCRIPTION', billing_unit: 'USD_PROXY' }),
   32        priceRowKey({ ...row, runtime: 'CLAUDE', provider: 'anthropic' }),
   33        priceRowKey({ ...row, service_tier: 'priority' }),
   34      ])
   35      expect(keys.size).toBe(5)
   36    })
   37  
   38    it('trims the model and returns null without a runtime card or a model', () => {
   39      expect(listPriceKey('CLAUDE', ' claude-opus-5-5 ')).toBe(listPriceKey('CLAUDE', 'claude-opus-5-5'))
   40      expect(listPriceKey('HARNESS', 'gpt-5.5')).toBeNull()
   41      expect(listPriceKey('CODEX', null)).toBeNull()
   42      expect(listPriceKey('CODEX', '  ')).toBeNull()
   43    })
   44  })
```

## shared test harness-schema: opzet — `__tests__/harness-schema.test.ts` r. 1-40

`scrum4me-shared@8df7f2c:__tests__/harness-schema.test.ts`

```ts
    1  import { readFileSync } from 'node:fs'
    2  import { describe, expect, it } from 'vitest'
    3  import { HARNESS_CONFIGURATION_NAME, HARNESS_COST_SOURCES, HARNESS_JOB_KINDS } from '../lib/harness-config'
    4  
    5  // M45-2a (spec docs/superpowers/specs/2026-10-05-harness-runtime-design.md §5.1 en §6.2 in
    6  // Scrum4Me): runtime HARNESS, de keuze per product en jobsoort, en het gemelde bedrag per job.
    7  // Alleen additief; de CHECKs staan als `// SQL:`-commentaar omdat Prisma ze niet kan uitdrukken
    8  // (de SQL zelf schrijft de migratie in Scrum4Me).
    9  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
   10  const schemaLines = schema.split('\n')
   11  
   12  const block = (kind: 'model' | 'enum', name: string) =>
   13    schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
   14  
   15  // De regels binnen de accolades, met witruimte samengevouwen: de test hangt zo niet af van de
   16  // kolomuitlijning in het schema.
   17  const bodyLines = (kind: 'model' | 'enum', name: string) =>
   18    block(kind, name)
   19      .split('\n')
   20      .slice(1, -1)
   21      .map((line) => line.trim().replace(/\s+/g, ' '))
   22      .filter(Boolean)
   23  const fieldLines = (name: string) =>
   24    bodyLines('model', name).filter((line) => !line.startsWith('//') && !line.startsWith('@@'))
   25  const attributeLines = (name: string) => bodyLines('model', name).filter((line) => line.startsWith('@@'))
   26  
   27  // De n-de regel direct boven `model <name> {`: 1 = `// SQL:`, 2 = `///`.
   28  const lineAboveModel = (name: string, n: number) => schemaLines[schemaLines.indexOf(`model ${name} {`) - n]
   29  const quotedList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',')
   30  
   31  describe('M45-2a: enum AgentRuntime', () => {
   32    it('bevat CLAUDE, CODEX en HARNESS, in die volgorde (HARNESS is achteraan toegevoegd)', () => {
   33      expect(bodyLines('enum', 'AgentRuntime')).toEqual(['CLAUDE', 'CODEX', 'HARNESS'])
   34    })
   35  })
   36  
   37  describe('M45-2a: ProductHarnessChoice', () => {
   38    it('heeft precies de velden uit het contract, geen extra', () => {
   39      expect(fieldLines('ProductHarnessChoice')).toEqual([
   40        'product Product @relation(fields: [product_id], references: [id], onDelete: Cascade)',
```

## agent-harness package.json — `package.json` r. 1-44

`goofy-moser-804c51@a2eb8c3:package.json`

```json
    1  {
    2    "name": "agent-harness",
    3    "version": "0.1.0",
    4    "description": "Standalone agent-harness CLI: capability probe and manifest runs against OpenAI-compatible local models",
    5    "directories": {
    6      "doc": "docs"
    7    },
    8    "scripts": {
    9      "build": "tsc",
   10      "typecheck": "tsc --noEmit",
   11      "lint": "eslint .",
   12      "test": "vitest run",
   13      "verify": "npm run lint && npm run typecheck && npm test",
   14      "dev": "tsx src/cli.ts"
   15    },
   16    "repository": {
   17      "type": "git",
   18      "url": "https://git.jp-visser.nl/janpeter/agent-harness"
   19    },
   20    "author": "",
   21    "license": "ISC",
   22    "type": "module",
   23    "dependencies": {
   24      "@modelcontextprotocol/sdk": "^1.30.1",
   25      "ajv": "^8.20.0",
   26      "undici": "^8.11.2",
   27      "zod": "^4.6.5"
   28    },
   29    "devDependencies": {
   30      "@types/node": "^26.6.3",
   31      "eslint": "^10.11.0",
   32      "tsx": "^4.23.15",
   33      "typescript": "^6.0.3",
   34      "typescript-eslint": "^8.70.1",
   35      "vitest": "^5.0.2"
   36    },
   37    "engines": {
   38      "node": ">=22"
   39    },
   40    "bin": {
   41      "harness": "dist/cli.js"
   42    },
   43    "private": true
   44  }
```

## agent-harness runbook: sectie LiteLLM — `docs/runbooks/harness-service-max2.md` r. 139-145

`goofy-moser-804c51@a2eb8c3:docs/runbooks/harness-service-max2.md`

```markdown
  139  ## LiteLLM
  140  
  141  - Eerste start: `litellm_up`. Daarna draait de container met `restart: unless-stopped`, ook na een herstart van max2.
  142  - Upgrade (nieuw image, nieuwe modellen of config): de nieuwe bestanden komen eerst in `current`, dus via een release van agent-harness. Volgorde, na `stop-check.sh`: het commando `harness_release_update` (de dienst blijft gestopt), dan (voor 2e, stap 8.5) het commando `litellm_upgrade` en daarna `harness_probe`; de flow `upgrade_litellm` eindigt met `harness_start` en is pas daarna bruikbaar. `litellm_upgrade` controleert alle bronnen in `current`, kopieert `harness.json`, `config.yaml`, `compose.yml` en de brug-unit naar `/etc` (de vorige als `<bestand>.bak-<tijdstip>`), herstart de brug, haalt het image op en maakt de container opnieuw. **Na een mislukte `litellm_upgrade`** (exit 74 in `pull` of `up`): draai `litellm_upgrade` opnieuw vóór elke probe; de oude container kan nog de oude config draaien terwijl de nieuwe bestanden al staan (en dus de nieuwe hash hebben). Alleen `install` (als het bestand ontbreekt) en `litellm_upgrade` installeren deze bestanden; `release-update` doet dat niet. `litellm_upgrade` neemt `harness.json` dus uit `current` over: controleer daarna `allow` (een eigen toollijst, zie "Toollijst aanpassen", staat dan in `harness.json.bak-<tijdstip>`). Draai `litellm_up` eerst op een host die LiteLLM nog nooit draaide: de herstart van de brug wacht op het netwerk `br-litellm`.
  143  - De image-digest in `compose.yml` is vastgepind (LiteLLM houdt de providersleutels); eigen code (harness, MCP) wordt niet vastgepind.
  144  - **Live kostenkaart (ISS-5).** LiteLLM haalt bij elke containerstart zijn model-kostenkaart van GitHub (`main`), ook met een vastgepind image; alleen `LITELLM_LOCAL_MODEL_COST_MAP=True` zet dat uit. Voor OpenRouter staat 1.83.3 `reasoning_effort` alleen toe als die kaart het model als `supports_reasoning` kent, en sinds 2026-10-09 bevat de kaart geen `openrouter/*`-rijen meer (LiteLLM-PR's #45665–#45669). Daarom draagt `qwen3.8-or` in `config.yaml` `model_info: { supports_reasoning: true }`: de router registreert dat onder `openrouter/qwen/qwen3.8-27b`, onafhankelijk van de kaart. Een nieuwe OpenRouter-configuratie met `reasoningEffort` heeft hetzelfde blok nodig. Een herstart van de container (reboot, `litellm_upgrade`) kan dus gedrag veranderen zonder dat de hash verandert; een probe die ineens faalt met `UnsupportedParamsError` wijst hierop. De kosten per antwoord komen uit OpenRouter's `usage.cost` en hangen niet van de kaart af.
  145  
```

## Consumenten van de oude naamlijst (S4-T1), origin/main op 2026-10-20

```text
-- Scrum4Me (https://git.jp-visser.nl/janpeter/Scrum4Me.git) @ 2bd0e46b
origin/main:app/(app)/chat/[id]/page.tsx:5:import { isHostedHarnessConfiguration } from '@shared/harness-config'
origin/main:app/(app)/chat/[id]/page.tsx:34:        hosted: isHostedHarnessConfiguration(view.chat.configuration),
origin/main:app/(app)/chat/layout.tsx:6:import { isHostedHarnessConfiguration } from '@shared/harness-config'
origin/main:app/(app)/chat/layout.tsx:57:              hosted: isHostedHarnessConfiguration(m.model_id),
origin/main:components/agent-chat/chat-window.tsx:50:    /** isHostedHarnessConfiguration(configuration), op de server bepaald. */
origin/main:components/agent-chat/model-picker.tsx:26:  /** Zie isHostedHarnessConfiguration: alles buiten de lokale lijst is gehost. */
-- scrum4me-workers (https://git.jp-visser.nl/janpeter/scrum4me-workers.git) @ 198eb59
   (geen treffers)
-- scrum4me-mcp-stable (https://git.jp-visser.nl/janpeter/scrum4me-mcp.git) @ 511912a
   (geen treffers)
-- scrum4me-copilot (https://git.jp-visser.nl/janpeter/scrum4me-copilot.git) @ 800df7a
   (geen treffers)
-- Ops-dashboard (https://git.jp-visser.nl/janpeter/Ops-dashboard.git) @ 70245304c
   (geen treffers)
```

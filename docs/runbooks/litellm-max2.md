---
title: "LiteLLM op max2 (M45): bestanden, venster en rooktest"
status: active
last_updated: 2026-10-05
---

# LiteLLM op max2 (M45)

LiteLLM zet de harness voor één aanroepvorm (`POST /v1/chat/completions`) voor een lokale en een gehoste configuratie. In M45 increment 1 was het een **praktijkproef**: LiteLLM draaide alleen tijdens een venster op max2, en Scrum4Me veranderde niet. Dit runbook beschrijft die proef en haar uitslagen. **Sinds 2d** staan de bestanden in `deploy/max2/litellm/` in productievorm (altijd aan, `restart: unless-stopped`, zonder `qwen3.8-or-neg`, de brug een ingeschakelde unit) en worden ze geïnstalleerd en beheerd door de ops-wrapper: zie [harness-service-max2.md](harness-service-max2.md). De tabellen hieronder beschrijven de bestanden zoals ze in de proef waren; waar de productie afwijkt, staat dat erbij. De spec en het plan staan in Scrum4Me:
- `docs/superpowers/specs/2026-10-05-harness-runtime-design.md` (de spec);
- `docs/plans/M45-harness-runtime-litellm.md` (het plan). De volledige vensterprocedure staat in Taak 3 van dat plan.

## Bestanden

| Bestand | Rol |
|---|---|
| `deploy/max2/litellm/compose.yml` | Project en container `litellm`, image vastgepind op digest (v1.83.3-stable, dezelfde als Scrum4Us), poort alleen `127.0.0.1:4000`, netwerk `litellm` (bridge `br-litellm`, `172.30.82.0/24`, gateway `172.30.82.1`, niet internal want OpenRouter vraagt egress), `restart: "no"` in de proef (productie: `unless-stopped`), `mem_limit 2g`, `pids_limit 512`, `no-new-privileges`, healthcheck op `/health/liveliness` |
| `deploy/max2/litellm/config.yaml` | De drie configuraties hieronder (productie: de eerste twee); `turn_off_message_logging: true`; `router_settings.disable_cooldowns: true` (zie de droge proef); master key uit de omgeving; geen database, geen callbacks |
| `deploy/max2/litellm/litellm-ollama-bridge.service` | socat op `172.30.82.1:11434` naar de Ollama van de host (`127.0.0.1:11434`), een kopie van `dsh-ollama-bridge.service`. In increment 1 alleen **gestart**, nooit `enable`d; sinds 2d een ingeschakelde unit die `litellm-up` start |
| `deploy/max2/litellm/meet.mjs` | Het meetscript van de proef (modi `meet`, `proxy`, `manifesten`, `opzoeken`) |

| Configuratie | Route | Bijzonderheden |
|---|---|---|
| `gsq-lokaal` | `openai/qwen3.8-gsq-rco:27b-iq3_s-text` via de brug | `api_key: "none"`, `timeout: 600` |
| `qwen3.8-or` | `openrouter/qwen/qwen3.8-27b` | `extra_body.provider`: `quantizations: ["bf16"]`, `data_collection: "deny"`, `require_parameters: true`, `allow_fallbacks: false` |
| `qwen3.8-or-neg` | als `qwen3.8-or` | alleen increment 1, niet in de productieconfig: `provider: {only: ["bestaat-niet"], allow_fallbacks: false}`. Komt het provider-blok aan, dan faalt elke aanvraag bij OpenRouter (de negatieve controle) |

De container heet `litellm` en nooit iets met het naamvoorvoegsel van de harness-containers: een worker met task-config ruimt zulke containers op bij zijn start.

## Geheimen

`OPENROUTER_API_KEY` en `LITELLM_MASTER_KEY` staan op max2 alleen in `/run/user/1000/m45.env` (tmpfs, modus 0600, via stdin geschreven; zie Taak 3 stap 3 van het plan). Ze komen nooit in argv, logs, traces, resultaten of deze repo. `config.yaml` verwijst er alleen naar met `os.environ/…`.

Elke compose-aanroep heeft `LITELLM_ENV_FILE` nodig, **ook `down`**: zonder variabele weigert compose (`required variable LITELLM_ENV_FILE is missing a value`). In het venster zet `$R/venster.sh` hem.

## Starten en stoppen (in het venster, met `venster.sh` geladen)

Starten:

```bash
docker compose -f $W/deploy/max2/litellm/compose.yml up -d     # maakt ook netwerk litellm
sudo -n cp $W/deploy/max2/litellm/litellm-ollama-bridge.service /etc/systemd/system/
sudo -n systemctl daemon-reload
sudo -n systemctl start litellm-ollama-bridge                  # start, geen enable
docker inspect litellm --format '{{.State.Health.Status}}'     # wacht op healthy
ss -ltnp '( sport = :4000 )'                                   # alleen 127.0.0.1:4000
```

Stoppen, in deze volgorde (de brug eerst, zodat socat niet blijft hangen):

```bash
sudo -n systemctl stop litellm-ollama-bridge
docker compose -f $W/deploy/max2/litellm/compose.yml down \
  || { docker rm -f litellm; docker network rm litellm; }
docker ps -aq --filter 'name=^litellm$'                         # leeg
docker network ls -q --filter 'name=^litellm$'                  # leeg
systemctl is-active litellm-ollama-bridge                       # exit 3, inactive
```

Na het venster blijven het image en het unitbestand staan (gestopt, niet geactiveerd). JP beslist daarover voor increment 2.

## Rooktest (lokaal, vóór het venster)

Op de Mac met Docker Desktop en een tijdelijk envbestand met nepsleutels:

1. `LITELLM_ENV_FILE=<tijdelijk> docker compose -f deploy/max2/litellm/compose.yml up -d`.
2. `curl -s http://127.0.0.1:4000/health/readiness` geeft `litellm_version` 1.83.3 en `db` "Not connected".
3. `/v1/models`, met de nep-master key via `curl --config`, toont de drie namen.
4. `LITELLM_ENV_FILE=<tijdelijk> docker compose -f deploy/max2/litellm/compose.yml down`, en ruim het tijdelijke bestand op.

Het image heeft één architectuur (linux/amd64). Op een arm64-Mac draait het geëmuleerd, met een platformwaarschuwing.

**Uitslag 2026-10-05 (Mac, Docker Desktop 29.8.2, arm64):** readiness na ongeveer 20 s HTTP 200 (`status` healthy, `db` "Not connected", `litellm_version` 1.83.3). `/v1/models` gaf `gsq-lokaal`, `qwen3.8-or` en `qwen3.8-or-neg`, en zonder sleutel 401. De poort stond alleen op `127.0.0.1:4000`, de container werd healthy, en het netwerk was `br-litellm` met `172.30.82.0/24`, gateway `.1`, niet internal. Compose weigerde `config` en `down` zonder `LITELLM_ENV_FILE`. De nepsleutels stonden niet in `docker logs` (grep exit 1). Na `down` waren er geen container en geen netwerk `litellm` meer.

## Droge proef van `meet.mjs` met nepsleutels (Mac, 2026-10-05)

`node deploy/max2/litellm/meet.mjs meet --base-url http://127.0.0.1:4000 --out <map>` tegen de lokale container, met nepsleutels. Ollama is op de Mac niet bereikbaar en OpenRouter weigert de nepsleutel, dus dit toetst alleen de foutpaden.

- **Cooldown van de router.** Zonder instelling gaf de eerste OpenRouter-fout (401) het model 5 s cooldown. De vier volgende denkvormen kregen een 429 van LiteLLM zelf: `RouterRateLimitError: No deployments available for selected model, Try again in 5 seconds`. In het venster zou de negatieve controle daardoor bij voorbaat "niet beslist" zijn: de tweede en derde variant falen dan bij LiteLLM in plaats van bij OpenRouter. Met één deployment per model en zonder fallbacks voegt cooldown niets toe, dus `config.yaml` zet `router_settings.disable_cooldowns: true` (LiteLLM-docs v1.83.3, `routing.md`; standaard `allowed_fails: 3`, `cooldown_time: 5s`). Daarna: denkvormen 401 401 401 401 401, `negative` kaal 401, canary 500/401/401, en geen 429 meer.
- **Herkenbare upstreamfout.** De excerpt van een OpenRouter-fout luidt `litellm.AuthenticationError: AuthenticationError: OpenrouterException - {…}. Received Model Group=…`. Een fout van OpenRouter is dus te onderscheiden van een fout van LiteLLM zelf, zoals de `RouterRateLimitError` hierboven. Dat is nodig voor de negatieve controle (plan §6 punt 2).
- **Kosten op een fout.** Bij een fout geeft LiteLLM `x-litellm-response-cost: 0`. `meet.mjs` maakt daar bron `none` van.
- **Logs.** De nepsleutels stonden niet in de uitvoer en niet in `docker logs` (grep exit 1). De drie kanaries stonden ook niet in de logs (exit 1, op het foutpad). `meting.json` bevatte geen velden `messages` of `content`.
- **Generale repetitie (zelfde avond).** `manifesten`, daarna `harness probe` en `harness run` (`run-qwen3.8-or.json`, `--api-key-env LITELLM_MASTER_KEY`) via de proxy op `127.0.0.1:4001` naar LiteLLM. De keten werkte tot OpenRouter (401 op de nepsleutel). De proxy logde vijf regels (vier van de probe, één van de run) met `bron: none`. De mappen heetten `runs/probe-qwen3.8-or` en `runs/m45-qwen3-8-or`. De nepsleutels stonden niet in de proefmap en niet in `docker logs` (grep exit 1), en de proxy stopte op SIGTERM met exit 0.

## Aanroepen van `meet.mjs` (proxy, manifesten, opzoeken)

`meet` staat hierboven. De drie andere modi gebruiken alleen Node-built-ins, lopen vanuit de clone en overschrijven of verwijderen nooit een bestand: bestaat een uitvoerbestand al, dan is dat exit 2 (kies een nieuwe naam). Exit 0: elke aanvraag kreeg een HTTP-antwoord (ook 4xx en 5xx); 1: een aanvraag kreeg geen antwoord; 2: een sleutel, optie of modus ontbreekt of deugt niet.

```bash
# opnameproxy tussen de harness (baseUrl http://127.0.0.1:4001/v1) en LiteLLM; draait tot SIGTERM of SIGINT
node meet.mjs proxy --listen 127.0.0.1:4001 --upstream http://127.0.0.1:4000 --log <map>/antwoorden.jsonl

# de runmanifesten van beide configuraties en de probe-velden van de lokale; <W> is de gebouwde checkout (dist/ bestaat)
node meet.mjs manifesten --uit <map> --repo <W>

# aanbieder en kosten van de hosted antwoorden bij OpenRouter (omgeving: OPENROUTER_API_KEY)
node meet.mjs opzoeken --in <map>/meting.json --in <map>/antwoorden.jsonl --out <map>/opzoeking.json
```

- **`proxy`** luistert alleen op `127.0.0.1`, stuurt elke aanvraag door en geeft het antwoord ongewijzigd terug; alleen `accept-encoding: identity` is anders. Start hem in de achtergrond (`setsid nohup node meet.mjs proxy … > proxy.out 2>&1 &`) en stop hem met `kill -TERM <pid>`; SIGHUP stopt hem niet, een request dat nog loopt krijgt 2 s. Per `POST …/chat/completions` komt één JSON-regel in het log, zonder aanvraagheaders en zonder inhoud: `tijd`, `model`, `http_status`, de twee kostenheaders, `body_usage_cost`, `provider`, `id`, `bedrag` en `bron` (`provider_reported`, `litellm_computed` of `none`), `finish_reason`, `reasoning_tokens` en `toolcalls`. Een gecomprimeerde body wordt niet gelezen: `bron: niet_leesbaar`, geen bedrag. Geeft LiteLLM geen antwoord, dan krijgt de client een 502 en komt er een regel met `http_status: null` en `fout` (een foutcode, `timeout`, of `client_verbroken` als de client wegging).
- **`manifesten`** leest `gsq-lokaal.json` en `run-extra-or.json` uit `<map>` en schrijft `run-gsq-lokaal.json`, `run-qwen3.8-or.json` en `probe-extra-gsq.json` ernaast. Beide manifesten zijn de docs-run van M5 (`model-comparison.md`, "Eerste run met docs") via de proxy, met id `m45-gsq-lokaal` en `m45-qwen3-8-or` (het schema staat geen punt toe), zonder `apiKey` (die komt via `--api-key-env`) en zonder `provider`-blok (dat zet LiteLLM). `probe-extra-gsq.json` is voor `harness probe --extra-body-file`: het `extraBody` van de lokale configuratie plus `reasoning_effort`.
- **`opzoeken`** zoekt elk `qwen3.8-or`-antwoord met een `gen-`-id op (minstens 10 s na het antwoord) en haalt één keer de endpointlijst van `qwen/qwen3.8-27b` op. Het oordeel per antwoord is een BF16-consistentiecontrole tegen die lijst, geen gemeten precisie per antwoord: `bf16 volgens endpointlijst`, `precisie niet eenduidig aangetoond`, `niet in BF16-lijst`, of `niet gemeten …` als een opzoeking of de lijst mislukte. Een antwoord zonder `gen-`-id krijgt `aanbieder niet gemeten via OpenRouter`.

`gsq-lokaal.json` zijn de modelinstellingen van de productieworker, geschreven in het venster. Alle drie de sleutels moeten er staan; `reasoningEffort` en `extraBody` zijn `null` als de worker ze niet heeft, en `extraBody` mag geen `provider` bevatten. `name` (de Ollama-modelnaam) wordt gelezen maar niet in een manifest gezet: daar staat de configuratienaam `gsq-lokaal`.

```json
{ "name": "qwen3.8-gsq-rco:27b-iq3_s-text", "reasoningEffort": "none", "extraBody": { "top_p": 0.95 } }
```

## Proef increment 1 (2026-10-06)

Venster op max2 op JP's go, 08:12–08:36 (CEST), op `C` = `37185fc` (de merge van PR #34). De werkmap op max2 is `~/m45-runs/proef-2026-10-06`, de kopie op de Mac `~/Development/m45-runs/proef-2026-10-06`. De ruwe bestanden staan alleen daar, niet in deze repo. `proef.log` eindigt op `exit=0`, dus dit is een geldige proefmap. LiteLLM gaf `litellm_version` 1.83.3 en `db` "Not connected".

### Uitslag per configuratie

| | `gsq-lokaal` (Ollama via de brug) | `qwen3.8-or` (OpenRouter, BF16) |
|---|---|---|
| Probe | `reliable`: 4/4 PASS (`a_plain`, `b_single_tool`, `c_two_tools`, `d_nonexistent_tool`) | `reliable`: `b`, `c` en `d` PASS. `a_plain` FAIL door de deadline van 120 s (de proxy logde `client_verbroken`), zie ontwerpinput 6. Met de uit-vorm (`reasoning_effort: "none"`) als `--extra-body-file` |
| Run (M5-docs-run) | `completed`: 3 beurten, 2 toolcalls, 0 toolfouten, 12,6 s, tokens 4122/405 | `completed`: 3 beurten, 2 toolcalls, 0 toolfouten, 54,2 s, tokens 4993/322, `costUsd` 0,0013527 |
| Antwoord | "5 stappen", met de laatste stap letterlijk (bron `specs/probe-design`) | idem |

### Kosten per gehost antwoord

Alle 13 HTTP-200-antwoorden van `qwen3.8-or` hebben een bedrag uit `provider_reported`: 6 in `meting.json` (vijf denkvormen en de kanarie) en 7 in `antwoorden.jsonl` (de probe en de run). Het bedrag stond telkens zowel in body-`usage.cost` als in beide kostenheaders, met dezelfde waarde.

`opzoeken` vond alle 13 bij OpenRouter terug: `total_cost` was gelijk aan het bedrag van LiteLLM, en `provider_name` was steeds DeepInfra. De endpointlijst van `qwen/qwen3.8-27b` (18 endpoints) noemt DeepInfra alleen met `bf16`, dus elk antwoord krijgt "bf16 volgens endpointlijst". Dat is een BF16-consistentiecontrole, geen gemeten precisie per antwoord. De andere 17 aanbieders staan erin met `fp8`, `fp4`, `fp16` of `unknown`.

De bedragen lagen tussen $0,0000065 (de uit-vorm) en $0,00065 (de laatste runbeurt). Samen was dat $0,0022 (meting $0,00035, probe en run $0,00183).

### Niet-200-antwoorden

- De negatieve controle (3×) en de kale kanarie op `qwen3.8-or-neg` gaven HTTP 404, zie hieronder.
- Eén proxyregel had `http_status: null` met `fout: client_verbroken`: dat was `a_plain` van de gehoste probe, afgebroken door de harness na 120 s. Dat is geen antwoord en valt buiten het kostencriterium.
- Er waren geen andere fouten, geen 429 en geen `niet_leesbaar`.

### Negatieve controle (providervoorkeuren)

Alle drie de varianten op `qwen3.8-or-neg` (kaal, met de uit-vorm en met de aan-vorm) gaven HTTP 404 met een fout van OpenRouter zelf: `litellm.NotFoundError: NotFoundError: OpenrouterException - {"error":{"message":"No allowed providers are available for the selected model. …`. `qwen3.8-or` gaf steeds 200. Het `provider`-blok uit `litellm_params.extra_body` komt dus bij OpenRouter aan, ook als de aanvraag eigen denkvelden meestuurt.

### Denkstand van `qwen3.8-or`

| Vorm | HTTP | `finish_reason` | `reasoning_tokens` | denktekst | stand |
|---|---|---|---|---|---|
| 1 geen veld | 200 | stop | 19 | `reasoning_content`, 72 tekens | aan |
| 2 `reasoning_effort: "none"` | 200 | stop | 0 | geen | **uit** (gekozen) |
| 3 `reasoning: {effort: "none"}` | 200 | stop | 0 | geen | uit |
| 4 `reasoning_effort: "medium"` | 200 | stop | 39 | `reasoning_content`, 151 tekens | **aan** (gekozen) |
| 5 `reasoning: {effort: "medium"}` | 200 | stop | 37 | `reasoning_content`, 144 tekens | aan |

Dit volgt de beslisregel uit het plan. Zonder veld denkt het model dus. De gehoste probe moet de uit-vorm meesturen, en dat deed hij.

### `gsq-lokaal`: kosten

Geen enkel antwoord van `gsq-lokaal` (de brugaanvraag en 8 proxyregels) had een kostenheader of body-`usage.cost`. LiteLLM berekent voor dit lokale model niets. `reasoning_tokens` ontbreekt. De productieworker heeft geen `reasoningEffort` en geen `extraBody` (`gsq-lokaal.json`), dus `probe-extra-gsq.json` is `{}`.

### Controles

| Controle | Uitkomst |
|---|---|
| Sleutelscan op de proefmap op max2 (`grep -rlF -f m45.pat`) | exit 1 (schoon) |
| `docker logs litellm` naar een bestand | exit 0 (567 regels) |
| Sleutelscan op die logs | exit 1 (schoon) |
| Kanariescan op die logs (3 kanaries, `turn_off_message_logging: true`) | exit 1 (inhoud blijft uit de logs) |
| Sleutelscan op de kopie op de Mac | exit 1 (schoon) |
| Poorten | 4000 alleen op `127.0.0.1`; de proxy alleen op `127.0.0.1:4001` |
| Na het venster | geen container en geen netwerk `litellm`; poort 4001 vrij; de brug `failed` (exit 3, dus gestopt); de geheime bestanden in `/run/user/1000` weg; de vasthouder dicht (`pgrep` exit 1, sessies terug van 4 naar 3) |

### Dienststand en keystand

- **M4-stop:** schoon (18 `local_llm`-rijen, geen claim, diff leeg).
- **Dienststand vooraf:** worker `active`, containers `dsh` en `open-webui` (geen `tei-gpu`), 270 MiB GPU-geheugen, geen model geladen.
- **Dienststand achteraf:** worker `active`, `dsh` en `open-webui`. De dienstregels zijn gelijk aan vooraf. Het model van de worker staat nog in het VRAM.
- **Keystand (bench-sleutel, limiet $20):** vooraf $2,098526 verbruikt, achteraf $2,100713, gemeten 5 min na de laatste aanvraag. Het verschil is $0,002187, ruim onder de verwachte $0,05. Geregistreerd was $0,002180; het restje van ongeveer $0,000007 past bij de afgebroken `a_plain`-aanvraag (zie ontwerpinput 6).

### Go/no-go (spec §7.1)

| Voorwaarde | Uitkomst |
|---|---|
| Beide probes `reliable` | ja |
| Beide runs `completed`, met ten minste één geslaagde toolcall | ja (2 en 2) |
| Elk 200-antwoord van `qwen3.8-or` heeft een bedrag uit `provider_reported` of `litellm_computed` | ja (13/13 `provider_reported`) |

**Technisch: GO.** Het besluit is aan JP.

### Wat de proef beslist voor increment 2 (plan §6)

1. **Kostenbron.** Body-`usage.cost` komt via LiteLLM door, met de waarde van OpenRouter (gelijk aan `total_cost`). De model-client blijft zoals hij is; een header lezen is niet nodig.
2. **Providervoorkeuren.** Ze gaan via `litellm_params.extra_body`: `qwen3.8-or` gaf 200, en elke variant op `qwen3.8-or-neg` gaf een upstreamfout van OpenRouter. De `extraBody` van de harness is daarvoor niet nodig.
3. **Denkstand.** Uit is `reasoning_effort: "none"`, aan is `reasoning_effort: "medium"`. Zonder veld denkt `qwen3.8-or`.
4. **De brug** werkte als gestarte unit, zonder enable. Increment 2 maakt hem blijvend, onder ops-agent.
5. **`qwen3.8-or-neg`** verdwijnt uit de config van increment 2.
6. **Ook ontwerpinput:**
   - **Cooldown.** `router_settings.disable_cooldowns: true` blijft nodig (zie "Droge proef").
   - **Lokale kosten.** `gsq-lokaal` levert geen kosten, dus `costMode` voor lokale configuraties kan niet op LiteLLM leunen (spec §4.2 en §6.1).
   - **Snelheid.** Gehoste aanvragen via de enige BF16-aanbieder (DeepInfra) duurden 14 tot ruim 110 s per stuk. `a_plain` haalde de standaarddeadline van 120 s van `harness probe` niet. Voor de gehoste probe in increment 2 is een ruimere `--step-timeout` het overwegen waard, of de bestaande herhaling. De gehoste run (54 s) was hier ruim vier keer zo traag als de lokale (12,6 s).
   - **Afbreken stopt de rekening niet.** De afgebroken `a_plain`-aanvraag werd bij OpenRouter wel uitgevoerd en geboekt (ongeveer $0,000007 extra op de keystand), maar staat in geen enkele kostenregel. Een kostenplafond dat alleen geregistreerde antwoorden optelt, mist zulke aanvragen.

---
title: "Agent-harness M6 — qwen3.8-27b lokaal op hogere precisie"
status: draft
last_updated: 2026-10-01
revision: 1
---

# Agent-harness M6 — qwen3.8-27b lokaal op hogere precisie

Vervolg op [M5](2026-09-30-model-comparison-refiner-design.md). Bron: IDEA-229, het M5-rapport (`llm-bench/results/refiner-vergelijking-2026-10-01.md` in max2) en het gesprek met JP op 2026-10-01. JP vroeg daarin om deze spec ("maak de spec voor M6").

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP, IDEA-229):** "voordat ik een Mac Mini of Mac studio koop wil ik kijken wat de modellen kunnen die daarop kunnen draaien. (…) maar alleen als er een echte meerwaarde is."

**Vraag van M6.** Uit M5 kwamen drie dingen:
- De klasse tot 35B kan de promptverfijner aan, en de ~120B-klasse voegde niets toe.
- Alleen `qwen/qwen3.8-27b` via OpenRouter kwam met en zonder docs door de zeef.
- Hetzelfde model lokaal op max2 (`qwen3.8-gsq-rco:27b-iq3_s-text`, 3-bit, 11 GB) komt zonder docs door, maar zakt met docs.

M6 meet of dat aan de precisie ligt. De vraag is: haalt qwen3.8-27b lokaal het niveau van gehost, op een precisie die op een Mac past?

**Eerst bruikbare resultaat:** de docs-variant (D01–D05 × seeds 1–3) voor `qwen3.8:27b-q8_0` op max2. De zeefuitkomst komt naast die van `gsq-lokaal` en `qwen3.8-openrouter` uit M5.

**Wat de uitkomst beslist:**

| Uitkomst | Betekenis voor de aankoop |
|---|---|
| Q8 zakt | De precisie verklaart het verschil niet. Er volgt geen Q4-run, en M6 eindigt met die uitkomst. |
| Q8 door, Q4 door | Q4_K_M (18 GB) is genoeg: een Mac met ongeveer 32 GB volstaat voor deze taak. |
| Q8 door, Q4 zakt | Q8_0 (30 GB) is nodig: een Mac met ongeveer 48 GB. |

Ligt een uitkomst binnen één gesprek van een zeefgrens, dan zegt het rapport dat. De conclusie is dan "geen verschil aantoonbaar" (§3).

**Niet-doelen:**
- **Snelheid of geheugen op een Mac.** De snelheid op max2, waar het model deels op de CPU draait, zegt niets over een Mac. Ze staat alleen ter informatie in het rapport.
- **Een ander model voor de productieworker.** Dat is een apart besluit na M6.
- **De variant zonder docs.** gsq haalt die al op 3-bit. Een run zonder docs kan later als vervolg.
- **Ander werk.** Andere modellen, nieuwe checks en codewijzigingen aan harness, `run.py` of `score.py` vallen erbuiten.
- **Uitgaven bij OpenRouter.** De referentie komt uit M5.
- **Q6_K of een kwantisatie buiten de officiële Ollama-tags** (§6).

**Zichtbaar bewijs:** `llm-bench/results/refiner-precisie-<datum>.md` in max2. Het bevat de tabellen, de run-mappen en de dienststand van max2 vooraf en achteraf.

## 2. Besluiten

| # | Vraag | Besluit |
|---|---|---|
| 1 | Volgende stap na M5 | De precisie van qwen3.8-27b lokaal meten (JP, 2026-10-01). |
| 2 | Welke precisies | De officiële Ollama-tags `qwen3.8:27b-q8_0` (30 GB) en `qwen3.8:27b-q4_K_M` (18 GB): de twee kandidaten voor een Mac-geheugenklasse. Eerst Q8; Q4 alleen als Q8 door de zeef komt. |
| 3 | Variant en omvang | Alleen met docs, waar gsq zakte: dezelfde 15 gesprekken als in M5, zodat de cijfers vergelijkbaar blijven. |
| 4 | Route, prompt en zeef | Ongewijzigd uit M5: `run.py --backend harness`, systeemprompt v3 met het docs-addendum, de bevroren docset, de cases, de checks en de zeef. |
| 5 | Vlaggen | JP beoordeelt nieuwe A5- en D5-vlaggen op een reviewpagina, zoals in M5. |

## 3. Uitgangssituatie

**M5, docs-variant (15 gesprekken per model):**

| Model | Afgerond | Eerste poging | D1 | D2 | D3 | D5 | Zeef |
|---|---|---|---|---|---|---|---|
| `gsq-lokaal` (IQ3_S, max2) | 13/15 | 13 | 15/15 | 9/12 | 15/15 | 3/3 | gezakt: afgerond, D2 |
| `qwen3.8-openrouter` (gehost) | 14/15 | 13 | 15/15 | 10/12 | 15/15 | 3/3 | door |

Het verschil is klein: één gesprek op afronding en één op D2. Bij gsq bleven twee gesprekken onaf. D01/3 eindigde op `maxTurns`: acht keer opnieuw zoeken in één beurt. D02/1 eindigde op `TOO_MANY_TOOL_ERRORS`: koppen opgevraagd zonder hun nummer. Dat is toolgedrag, en precies het soort gedrag dat een hogere precisie zou kunnen verbeteren.

**max2:**
- **Hardware:** RTX 5070 Ti met 16 GB, 30 GB RAM, 588 GB vrij op de schijf.
- **Ollama 0.34.4:** `OLLAMA_CONTEXT_LENGTH=65536`, `OLLAMA_KV_CACHE_TYPE=q8_0`, flash attention, en één model tegelijk.

**qwen3.8-27b:**
- **Architectuur (qwen35):** 64 lagen, waarvan 16 met volledige attention, met 4 KV-heads van 256. De KV-cache bij 65.536 tokens is daardoor ongeveer 1 GB in q8_0.
- **Q8_0 (30 GB):** inclusief een beeldprojector van ongeveer 0,9 GB, en met de cache erbij past het niet op de GPU. Ongeveer de helft draait op de CPU, en daarvoor is ongeveer 16 GB RAM nodig.
- **Q4_K_M (18 GB):** draait bijna helemaal op de GPU.

**Officiële tags (ollama.com, 2026-10-01):** q4_K_M (18 GB), q8_0 (30 GB) en bf16 (56 GB), plus mlx-varianten voor Apple. Er is geen Q6-tag.

## 4. Opzet

**Labels.** Twee nieuwe labels in `llm-bench/refiner/models.json`:
- `qwen3.8-q8-lokaal` voor `qwen3.8:27b-q8_0`;
- `qwen3.8-q4-lokaal` voor `qwen3.8:27b-q4_K_M`.

Beide krijgen dezelfde blokken als `gsq-lokaal`: zonder docs `reasoningEffort: none`, met docs geen instelling (thinking aan), en voor de probe `reasoning_effort: none`. Dit is configuratie plus één aangepaste test: `ModelsFileTest` in `test_refiner.py` pint nu precies de zeven labels van M5 en krijgt de twee nieuwe erbij. De officiële tags brengen hun eigen chat-template mee, dus de afgeleide Modelfile van gsq is niet nodig.

**Limieten.** Net als in M5: `maxOutputTokens` 16384, `maxTurns` 8, `maxToolErrors` 2 en `contextTokens` 65536. De uitzondering is `maxWallSeconds`. Q8 draait op max2 deels op de CPU, en een tijdsgrens van max2 mag de uitkomst niet bepalen. Daarom stelt de rooktest de grens vast:
- meet de snelheid in uitvoertokens per seconde, uit `result.json`;
- `maxWallSeconds` wordt ⌈16384 / snelheid × 1,5⌉, naar boven afgerond op een minuut;
- de tweede poging verdubbelt de grens, zoals in M5.

Een `timed_out` staat in het rapport apart, als grens van max2.

**Volgorde.** Serveracties en downloads gebeuren alleen op JP's go.
1. Download beide tags op max2: 30 GB en 18 GB.
2. Leg de dienststand vast en stop de diensten, zoals in M5 Taak 13:
   - de worker met de stopprocedure uit M4;
   - open-webui en dsh;
   - TEI blijft uit als hij uit stond.
3. Rooktest Q8:
   - de probe;
   - `ollama show --modelfile`, met dezelfde renderer en parser als gsq;
   - één docs-gesprek (D03, seed 1);
   - de verdeling over GPU en CPU (`ollama ps`) en het vrije RAM (`free`);
   - de snelheid, en daarmee `maxWallSeconds`.
4. Q8 met docs: D01–D05 × seeds 1–3, 15 gesprekken.
5. Herstel de stand precies, zoals in M5 criterium 9. JP beoordeelt de nieuwe vlaggen.
6. Komt Q8 door de zeef: dezelfde stappen 2–5 voor Q4, in een eigen venster.

**Duur (schatting).** In M5 duurde de docs-run van gsq, volledig op de GPU bij ongeveer 40 tokens per seconde, zo'n 25 minuten. Q8 draait op max2 naar schatting met 4–8 tokens per seconde, dus de run kost enkele uren. Q4 kost ongeveer een half uur tot een uur. De rooktest geeft de echte schatting vóór de lange run, zodat JP het venster kan kiezen.

**Rapport.** `llm-bench/results/refiner-precisie-<datum>.md` bevat:
- de docs-tabel van `score.py` voor Q8, en zo nodig Q4, naast de M5-rijen van gsq en gehost;
- de zeef met de besluiten over de vlaggen;
- per niet-afgerond gesprek de status;
- snelheid en verdeling op max2, ter informatie;
- de conclusie volgens §1;
- de dienststand vooraf en achteraf.

De run-mappen gaan mee zoals in M5: rijen, `summary.csv`, blind-key, transcripten en `probe.json`.

## 5. Acceptatiecriteria

1. `qwen3.8:27b-q8_0` heeft de docs-variant gedraaid: 15 gesprekken, met een probe-oordeel en een `summary.csv` met A- en D-checks. Dat gebeurde via dezelfde route en instellingen als M5, met de `maxWallSeconds` uit de rooktest.
2. Komt Q8 door de zeef, dan geldt criterium 1 ook voor `qwen3.8:27b-q4_K_M`. Zakt Q8, dan staat in het rapport dat de precisie het verschil niet verklaart, en is er geen Q4-run.
3. Het rapport zet de nieuwe rijen naast gsq en gehost uit M5, met de besluiten van JP over nieuwe vlaggen. Het geeft de conclusie volgens §1, en noemt het als een uitkomst binnen één gesprek van een grens ligt.
4. Geen `timed_out` bepaalt een uitkomst: de grens komt uit de rooktest, en elke `timed_out` staat apart in het rapport.
5. Na elke meting draaien op max2 precies de diensten van vooraf.
6. De unittests in max2 zijn groen, en `check_key.py` vindt nul treffers in de run-mappen. Hier komt geen sleutel aan te pas, maar de controle is goedkoop.

## 6. Risico's en open punten

- **Kleine aantallen.** Het verschil dat M6 wil verklaren, is in M5 één gesprek op twee regels. Een Q8-uitslag vlak bij de grens is een aanwijzing, geen bewijs.
  - **Open punt voor JP:** zes seeds in plaats van drie, dus 30 gesprekken, maakt het antwoord scherper maar verdubbelt de duur op max2. Mijn advies: drie, gelijk aan M5. Bij een uitslag binnen één gesprek van de grens volgen daarna extra seeds.
- **Duur en stilstand.** Tijdens de runs ligt de worker stil. Q8 en Q4 krijgen daarom elk een eigen venster. Tussen de vensters draait de worker gewoon.
- **Geheugen op max2.** Q8 en de cache nemen samen ongeveer 31 GB in: ongeveer 14,5 GB op de GPU en 16,5 GB in het RAM (30 GB totaal). Swapt max2, dan meet de run vooral de schijf. De rooktest controleert dat. Swapt hij toch, dan stopt de run en beslist JP, bijvoorbeeld over een kleinere context voor de meting. Dat raakt de Ollama-config.
- **Officiële tag tegenover gsq.**
  - De officiële tags laden een beeldprojector (ongeveer 0,9 GB) en gebruiken de template van Ollama. gsq liep op een afgeleide Modelfile zonder beeld, met dezelfde renderer en parser.
  - De rooktest controleert renderer en parser. Het verschil in geheugen beïnvloedt de snelheid, niet de kwaliteit.
- **Seeds.** Lokaal is een gesprek met dezelfde seed herhaalbaar: in M5 gaven herhalingen identieke tokens. Bij gehost is dat niet zo. Vergelijk daarom uitkomsten, niet transcripten.
- **Geen Q6.** Komt Q8 door en zakt Q4, dan ligt Q6_K ertussen (ongeveer 22 GB, een Mac van 36 GB). Ollama heeft geen officiële Q6-tag. Een Q6_K van Hugging Face, met een afgeleide Modelfile zoals bij gsq, kan een vervolg zijn, maar valt buiten deze spec.
- **Mac-geheugen is een schatting.**
  - macOS geeft de GPU standaard ongeveer twee derde tot drie kwart van het geheugen, en daarop zijn de klassen in §1 gebaseerd.
  - Op een Mac draait Ollama de mlx-varianten. Die zijn niet hetzelfde bestand als de GGUF die hier gemeten wordt.
  - Voor de aankoop blijft een meting op echte hardware nodig, ook voor de snelheid.
- **Productie.** Haalt Q4 het niveau, dan ligt de vraag voor de hand of de worker op max2 naar `qwen3.8:27b-q4_K_M` moet. Q4 past bijna helemaal op de GPU van 16 GB. Dat is een apart besluit.

## Review record

Nog niet gereviewd.

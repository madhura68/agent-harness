---
title: "Agent-harness M6 — qwen3.8-27b lokaal op hogere precisie"
status: draft
last_updated: 2026-10-01
revision: 2
---

# Agent-harness M6 — qwen3.8-27b lokaal op hogere precisie

Vervolg op [M5](2026-09-30-model-comparison-refiner-design.md). Bron: IDEA-229, het M5-rapport (`llm-bench/results/refiner-vergelijking-2026-10-01.md` in max2) en het gesprek met JP op 2026-10-01. JP vroeg daarin om deze spec ("maak de spec voor M6").

## 1. Doel, eerste resultaat, niet-doelen

**Doel (JP, IDEA-229):** "voordat ik een Mac Mini of Mac studio koop wil ik kijken wat de modellen kunnen die daarop kunnen draaien. (…) maar alleen als er een echte meerwaarde is."

**Vraag van M6.** Uit M5 kwamen drie dingen:
- De klasse tot 35B kan de promptverfijner aan, en de ~120B-klasse voegde niets toe.
- Alleen `qwen/qwen3.8-27b` via OpenRouter kwam met en zonder docs door de zeef.
- Hetzelfde model lokaal op max2 (`qwen3.8-gsq-rco:27b-iq3_s-text`, 3-bit, 11 GB) komt zonder docs door, maar zakt met docs.

M6 meet of hetzelfde model lokaal, op een hogere precisie, met docs wel door de zeef komt. De vraag is: haalt qwen3.8-27b lokaal het niveau van gehost, op een precisie die op een Mac past? Het niveau van gehost betekent hier: door de M5-zeef komen, zoals gehost in M5. Dit is geen zuivere proef op alleen de precisie. Q8 en Q4 draaien met de template van Ollama en een beeldprojector, gsq met een afgeleide Modelfile zonder beeld, en gehost bij een aanbieder (§6).

**Eerst bruikbare resultaat:** de docs-variant (D01–D05 × seeds 1–3) voor `qwen3.8:27b-q8_0` op max2, met het oordeel door, gezakt of onbeslist (hieronder). De zeefuitkomst komt naast die van `gsq-lokaal` en `qwen3.8-openrouter` uit M5.

**Wat de uitkomst beslist.** Het rapport geeft eerst de zeefuitkomst van `score.py`, ongewijzigd, met de besluiten van JP over de vlaggen. Daarna volgt het oordeel:
- **Grens.** Een regel met een percentage (afgerond, en elke check die meetelt) ligt op de grens als zijn telling de kleinste is die slaagt. Hij ligt één eronder als één gesprek meer hem zou laten slagen. Bij 15 gesprekken: afgerond 14 en 13; een check over 15 gesprekken 12 en 11; D2, over 12 gesprekken, 10 en 9.
- **Onbeslist.** Een model dat door is, is onbeslist als een regel precies op de grens ligt. Een model dat gezakt is, is onbeslist als het alleen zakt op regels die één eronder liggen, of als een `timed_out` de uitkomst bepaalt (§4). Voor vlaggen is er geen grens: JP beoordeelt ze zoals in M5, en een bevestigde vlag laat het model zakken.
- Gehost lag in M5 zelf op twee grenzen (afgerond 14/15, D2 10/12), en gsq lag op beide één eronder. Een Q8 die gehost of gsq evenaart, is dus onbeslist.

| Uitslag | Vervolg | Betekenis voor de aankoop |
|---|---|---|
| Q8 gezakt | Geen Q4; M6 eindigt. | Q8 voldoet in deze opzet niet: M6 toont geen lokale route met docs op het niveau van gehost. Of de precisie meespeelt, blijft open. |
| Q8 door | Q4 meten, in een eigen venster. | Volgt uit Q4. |
| Q4 door | M6 eindigt. | Kandidaat: Q4_K_M op een Mac van ongeveer 32–36 GB, bij 32 GB krap (§6). |
| Q4 gezakt | M6 eindigt. | Kandidaat: Q8_0 op een Mac van ongeveer 48 GB (§6). |
| Onbeslist | M6 stopt voor JP: seeds 4–6 voor dat model, via dezelfde route, of stoppen. Geen Q4 vóór die keuze. | Nog geen. Blijft het na seeds 4–6 onbeslist, dan is er geen meerwaarde aangetoond. |

Door en gezakt betekenen in de tabel: niet onbeslist. De kandidaten zijn schattingen voor een proef op echte Mac-hardware, geen koopadvies. Extra seeds gelden alleen het lokale model. De M5-rijen van gsq en gehost blijven op 15 gesprekken; dat kan, omdat de zeef een vaste drempel is en geen vergelijking met gehost.

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
| 2 | Welke precisies | De officiële Ollama-tags `qwen3.8:27b-q8_0` (30 GB) en `qwen3.8:27b-q4_K_M` (18 GB): de twee kandidaten voor een Mac-geheugenklasse. Eerst Q8; Q4 alleen als Q8 door is (§1). |
| 3 | Variant en omvang | Alleen met docs, waar gsq zakte: dezelfde 15 gesprekken als in M5, zodat de cijfers vergelijkbaar blijven. |
| 4 | Route, prompt en zeef | Ongewijzigd uit M5: `run.py --backend harness`, systeemprompt v3 met het docs-addendum, de bevroren docset, de cases, de checks en de zeef. |
| 5 | Vlaggen | JP beoordeelt nieuwe D5-vlaggen op een reviewpagina, zoals in M5. A5 geldt niet in de docs-variant. |

## 3. Uitgangssituatie

**M5, docs-variant (15 gesprekken per model):**

| Model | Afgerond | Eerste poging | D1 | D2 | D3 | D5 | Zeef |
|---|---|---|---|---|---|---|---|
| `gsq-lokaal` (IQ3_S, max2) | 13/15 | 13 | 15/15 | 9/12 | 15/15 | 3/3 | gezakt: afgerond, D2 |
| `qwen3.8-openrouter` (gehost) | 14/15 | 13 | 15/15 | 10/12 | 15/15 | 3/3 | door |

De A-checks tellen ook mee (A1–A4, A6 en A7; A5 en A8 gelden niet met docs). Beide modellen haalden ze; de laagste was A7 bij gsq, 13/15.

Het verschil is klein: één gesprek op afronding en één op D2. Bij gsq bleven twee gesprekken onaf. D01/3 eindigde op `maxTurns`: acht keer opnieuw zoeken in één beurt. D02/1 eindigde op `TOO_MANY_TOOL_ERRORS`: koppen opgevraagd zonder hun nummer. Dat is toolgedrag, en precies het soort gedrag dat een hogere precisie zou kunnen verbeteren.

**max2:**
- **Hardware:** RTX 5070 Ti met 16 GB, 30 GB RAM, 588 GB vrij op de schijf.
- **Ollama 0.34.4:** `OLLAMA_CONTEXT_LENGTH=65536`, `OLLAMA_KV_CACHE_TYPE=q8_0`, flash attention, en één model tegelijk.

**qwen3.8-27b:**
- **Architectuur (qwen35):** 64 lagen, waarvan 16 met volledige attention, met 4 KV-heads van 256 voor key en value. De KV-cache bij 65.536 tokens is daardoor ongeveer 2,3 GB in q8_0 (16 × 4 × 512 × 65.536 × 34/32 byte).
- **Q8_0 (30 GB):** inclusief een beeldprojector van ongeveer 0,9 GB. Met cache en buffers is dat ongeveer 33 GB: ongeveer 15 GB past op de GPU, ongeveer 18 GB draait op de CPU, uit het RAM.
- **Q4_K_M (18 GB):** met cache en buffers ongeveer 21 GB, dus ook deels op de CPU: ongeveer 5–6 GB.
- Dit zijn schattingen. De rooktest legt de gemeten grootte en verdeling vast (`ollama ps`).

**Officiële tags (ollama.com, 2026-10-01):** onder meer q4_K_M (18 GB), q8_0 (30 GB) en bf16 (56 GB), plus mlx-varianten voor Apple. Er is geen Q6-tag.

## 4. Opzet

**Labels.** Twee nieuwe labels in `llm-bench/refiner/models.json`:
- `qwen3.8-q8-lokaal` voor `qwen3.8:27b-q8_0`;
- `qwen3.8-q4-lokaal` voor `qwen3.8:27b-q4_K_M`.

Beide krijgen dezelfde blokken als `gsq-lokaal`: zonder docs `reasoningEffort: none`, met docs geen instelling (thinking aan), en voor de probe `reasoning_effort: none`. Dit is configuratie plus de aanpassing van `test_refiner.py` waar die de labels pint: de labellijst in `ModelsFileTest` en `LOCAL_MODELS`. De officiële tags brengen hun eigen chat-template mee, dus de afgeleide Modelfile van gsq is niet nodig.

**Limieten.** Net als in M5, per beurt: `maxOutputTokens` 16384, `maxTurns` 8, `maxToolErrors` 2 en `contextTokens` 65536. De uitzondering is `maxWallSeconds` (960 in M5). Q8 draait op max2 deels op de CPU, en een tijdsgrens van max2 mag de uitkomst niet bepalen. Daarom stelt de rooktest de grens vast:
- de snelheid is de som van `output_tokens` gedeeld door de som van `wall_s`, over de beurten van het rooktestgesprek (de rijen van `run.py`, uit `result.json`); is een van beide nul of leeg, dan stopt de rooktest;
- `maxWallSeconds` wordt ⌈16384 / snelheid × 1,5⌉, naar boven afgerond op een minuut;
- de tweede poging verdubbelt de grens en het tokenbudget, zoals in M5.

De snelheid telt de verwerking van de invoer mee en ligt dus onder de pure generatie; dat maakt de grens ruimer. Een zwaardere beurt kan de grens toch halen. Elk gesprek dat na beide pogingen op `timed_out` eindigt, staat daarom apart in het rapport. Slaat de zeef om wanneer zulke gesprekken als afgerond en op elke check geslaagd tellen, dan bepaalt de `timed_out` de uitkomst, en is de uitslag onbeslist (§1).

**Volgorde.** Serveracties en downloads gebeuren alleen op JP's go.
1. Download `qwen3.8:27b-q8_0` op max2 (30 GB).
2. Leg de dienststand vast en stop de diensten, zoals in M5 Taak 13:
   - de worker met de stopprocedure uit M4;
   - TEI als hij draait (`docker compose -f /srv/apps/tei/docker-compose.yml stop`);
   - open-webui en dsh.
3. Rooktest Q8:
   - de probe;
   - `ollama show --modelfile`, met dezelfde renderer en parser als gsq;
   - één docs-gesprek (D03, seed 1);
   - de grootte en de verdeling over GPU en CPU (`ollama ps`);
   - `MemAvailable` en de swaptellers `pswpin` en `pswpout` uit `/proc/vmstat`, vóór en na het gesprek, ter verklaring van de snelheid;
   - de snelheid, en daarmee `maxWallSeconds` en de geschatte duur.
4. Q8 met docs: D01–D05 × seeds 1–3, 15 gesprekken.
5. Herstel de stand precies, zoals in M5 criterium 9: alleen wat vooraf draaide, start weer. JP beoordeelt de nieuwe vlaggen.
6. Is Q8 door: download `qwen3.8:27b-q4_K_M` (18 GB) en doe de stappen 2–5 voor Q4, in een eigen venster.

Kiest JP bij een onbesliste uitslag voor seeds 4–6, dan gelden dezelfde stappen 2–5 met die seeds.

**Duur (schatting).** In M5 duurde de docs-run van gsq, volledig op de GPU bij ongeveer 40 tokens per seconde, zo'n 25 minuten. Q8 draait op max2 naar schatting met 4–8 tokens per seconde, dus de run kost enkele uren. Q4 draait ook deels op de CPU en kost naar schatting een à twee uur. De rooktest geeft de echte schatting vóór de lange run, zodat JP het venster kan kiezen.

**Rapport.** `llm-bench/results/refiner-precisie-<datum>.md` bevat:
- de docs-tabel van `score.py` voor Q8, en zo nodig Q4, naast de M5-rijen van gsq en gehost;
- de zeef met de besluiten over de vlaggen, de regels op of één onder de grens, en het oordeel door, gezakt of onbeslist;
- per niet-afgerond gesprek de status, met elke `timed_out` apart;
- snelheid, grootte, verdeling en swaptellers op max2, ter informatie;
- de conclusie volgens §1;
- de dienststand vooraf en achteraf.

De run-mappen gaan mee zoals in M5: rijen, `summary.csv`, blind-key, transcripten en `probe.json`.

## 5. Acceptatiecriteria

1. `qwen3.8:27b-q8_0` heeft de docs-variant gedraaid: 15 gesprekken, met een probe-oordeel en een `summary.csv` met A- en D-checks. Dat gebeurde via dezelfde route en instellingen als M5, met de `maxWallSeconds` uit de rooktest.
2. Is Q8 door, dan geldt criterium 1 ook voor `qwen3.8:27b-q4_K_M`. Is Q8 gezakt, dan staat in het rapport dat Q8 in deze opzet niet voldoet, en is er geen Q4-run. Is een uitslag onbeslist, dan stopt M6 voor de keuze van JP (§1).
3. Het rapport zet de nieuwe rijen naast gsq en gehost uit M5, met de besluiten van JP over nieuwe vlaggen. Het noemt de regels op of één onder de grens, en geeft het oordeel en de conclusie volgens §1.
4. Elke `timed_out` staat apart in het rapport. Bepaalt een `timed_out` de uitkomst, dan is de uitslag onbeslist.
5. Na elke meting draaien op max2 precies de diensten van vooraf.
6. De unittests in max2 zijn groen, en `check_key.py` vindt nul treffers in de run-mappen. Hier komt geen sleutel aan te pas, maar de controle is goedkoop.

## 6. Risico's en open punten

- **Kleine aantallen.** Het verschil tussen gsq en gehost is in M5 één gesprek op twee regels. Daarom de grens uit §1: een uitslag vlak bij de grens is onbeslist, geen bewijs.
  - **Open punt voor JP:** meteen zes seeds in plaats van drie, dus 30 gesprekken. Een uitslag gelijk aan gehost is onbeslist, en dat is een waarschijnlijke uitkomst. Zes seeds maken die kans kleiner, maar verdubbelen het Q8-venster. Mijn advies: drie, gelijk aan M5. De rooktest geeft dan eerst de echte duur, en seeds 4–6 volgen alleen bij een onbesliste uitslag, op jouw keuze.
- **Duur en stilstand.** Tijdens de runs ligt de worker stil. Q8 en Q4 krijgen daarom elk een eigen venster. Tussen de vensters draait de worker gewoon.
- **Geheugen op max2.** Q8 met cache en buffers is ongeveer 33 GB: ongeveer 15 GB op de GPU en 18 GB in het RAM. max2 heeft 30 GB RAM, waarvan ongeveer 25 GB beschikbaar. Dat past, met een kleine marge. Laadt Q8 niet, dan stopt de rooktest en beslist JP. Swappen verandert de antwoorden niet, alleen de snelheid. De grens en de duur volgen uit de gemeten snelheid (§4), en de swaptellers verklaren die.
- **Officiële tag tegenover gsq.**
  - De officiële tags laden een beeldprojector (ongeveer 0,9 GB) en gebruiken de template van Ollama. gsq liep op een afgeleide Modelfile zonder beeld, met dezelfde renderer en parser.
  - De rooktest controleert renderer en parser. Het verschil in geheugen beïnvloedt de snelheid, niet de kwaliteit.
- **Seeds.** Lokaal is een gesprek met dezelfde seed herhaalbaar: in M5 gaven herhalingen identieke tokens. Bij gehost is dat niet zo. Vergelijk daarom uitkomsten, niet transcripten.
- **Geen Q6.** Komt Q8 door en zakt Q4, dan ligt Q6_K ertussen (ongeveer 22 GB, een Mac van 36 GB). Ollama heeft geen officiële Q6-tag. Een Q6_K van Hugging Face, met een afgeleide Modelfile zoals bij gsq, kan een vervolg zijn, maar valt buiten deze spec.
- **Mac-geheugen is een schatting.**
  - macOS geeft de GPU standaard ongeveer twee derde tot drie kwart van het geheugen; dat is te verhogen met `iogpu.wired_limit_mb`. Q4 met cache en buffers (ongeveer 21 GB) zit op een Mac van 32 GB daardoor op de grens. Q8 (ongeveer 33 GB) past in 48 GB.
  - Op een Mac kan Ollama dezelfde GGUF-tag draaien. De mlx-tags zijn een alternatief met eigen kwantisatie en zijn niet gemeten.
  - De klassen in §1 zijn kandidaten voor een proef op echte hardware. Voor de aankoop blijft die proef nodig, ook voor de snelheid.
- **Productie.** Haalt Q4 het niveau, dan ligt de vraag voor de hand of de worker op max2 naar `qwen3.8:27b-q4_K_M` moet. Q4 draait daar voor een deel op de CPU. Dat is een apart besluit.

## Review record

### Ronde 1 (2026-10-01, rev 1 → rev 2)

- **Reviewers:** mac:claude (0 BLOCKER, 1 MAJOR, 4 MINOR; NO-GO) en mac:codex (0 BLOCKER, 3 MAJOR, 1 MINOR; NO-GO). De eerste codex-aanvraag faalde op het lezen van AGENTS.md en CLAUDE.md, die deze repo niet heeft; daarna opnieuw verstuurd.
- **Bepalend, beide MAJOR: de beslisregel botste rond de zeefgrens.** Gehost lag zelf op twee grenzen en gsq één eronder. Een Q8-uitslag viel dus vrijwel zeker "binnen één gesprek", en drie plekken gaven drie vervolgen. → Aanvaard. §1 definieert nu per regel de grens en het oordeel onbeslist, met één route: JP kiest seeds 4–6 of stoppen. Q8 gezakt heet "voldoet in deze opzet niet", en de Mac-klassen heten kandidaten voor een proef. §5 crit. 2–3 en §6 volgen.
- **`timed_out` zonder route** (codex MAJOR, claude MINOR). → Aanvaard. De snelheid is nu gedefinieerd (som `output_tokens` / som `wall_s`). Een `timed_out` die de zeef bepaalt, maakt de uitslag onbeslist (§4, crit. 4). Geen codewijziging.
- **Swapcontrole met `free` niet uitvoerbaar** (codex MAJOR). → Feit aanvaard; remedie SCHRAP in plaats van een betere stopregel. Swappen verandert de antwoorden niet, alleen de snelheid. De grens volgt uit de gemeten snelheid (paging maakt hem ruimer, niet krapper), de duur ook, en een `timed_out` die beslist, valt onder onbeslist. De tellers uit `/proc/vmstat` staan ter verklaring in het rapport.
- **KV-cache twee keer te laag** (claude MINOR). → Aanvaard: 2,3 GB; §3 en §6 herrekend. Q4 draait ook deels op de CPU, en 32 GB is krap.
- **mlx-zin onjuist** (claude MINOR). → Aanvaard, herschreven.
- **Q4-download te vroeg; TEI** (beide MINOR). → Aanvaard. De Q4-download staat nu in stap 6, en TEI stopt als hij draait, zoals in M5 Taak 13.
- **Observaties claude.** De testwijziging raakt `ModelsFileTest` en `LOCAL_MODELS` (§4 aangepast). A5 geldt niet met docs (§2 #5 aangepast).
- **Scope-delta:** niets toegevoegd aan de bouw. Eén uitslag erbij (onbeslist), die stopt voor JP. De swapstop is geschrapt en de Q4-download uitgesteld tot na Q8. Het eerste resultaat en de rooktest blijven gelijk.

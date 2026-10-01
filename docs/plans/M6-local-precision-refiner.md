# M6 — qwen3.8-27b lokaal op hogere precisie: implementatieplan

_Status: draft, revisie 1 (2026-10-01). Een technisch GO autoriseert geen ceremonie, download, serveractie, merge of uitvoering._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** een rapport `llm-bench/results/refiner-precisie-<datum>.md` (repo max2) met de docs-variant van de M5-bank voor `qwen3.8:27b-q8_0` op max2, en zo nodig voor `qwen3.8:27b-q4_K_M`. Het zet de uitslag naast gsq en gehost uit M5, geeft het oordeel door, gezakt of onbeslist, en wat dat betekent voor de aankoop.

**Architecture:** geen nieuwe code. Twee labels in `llm-bench/refiner/models.json` en de tests die de labels pinnen. Daarna draait `run.py --backend harness` op max2 zelf, in tmux, tegen Ollama op 127.0.0.1, met dezelfde prompt, docset, cases, checks en zeef als M5. `score.py` scoort. Het oordeel (grens, onbeslist, de timeout-tegenproef) reken je met de hand uit de score-uitvoer, zoals spec §1 en §4 voorschrijven.

**Tech Stack:** max2 `llm-bench` (Python 3, alleen de standaardbibliotheek, `unittest`); agent-harness `dist/cli.js` op max2 (Node 24); Ollama 0.34.4 op max2; tmux.

**Spec:** `docs/specs/2026-10-01-local-precision-refiner-design.md` (revisie 4: dubbel GO in ronde 3, daarna JP's besluit voor drie seeds). Voorganger: `docs/plans/M5-model-comparison-refiner.md`; Taak 13 daarvan is de procedure die dit plan volgt.

## Global Constraints

- **Route, ongewijzigd uit M5** (spec §2 #4): `run.py --backend harness`, variant `docs`, systeemprompt v3 (`llm-bench/prompts/promptverfijner-systeem.txt`) met `promptverfijner-docs-addendum.txt`, de bevroren docset `llm-bench/refiner/docset/`, de cases D01–D05 uit `cases.jsonl`, en de checks en de zeef van `score.py`. Geen wijziging aan `run.py`, `score.py`, `cases.jsonl`, de prompts, de docset of de harness.
- **Harness:** `node /home/janpeter/Development/agent-harness/dist/cli.js` op max2, op main `15c1e26`. `harness run`, `probe` en `doc-server` zijn daar gelijk aan de M5-build `aaae1a0`: sindsdien veranderde alleen het workerpad (`cmdWorker` in `src/cli.ts` en `src/worker/doc-tools.ts`, ISS-1). Staat de checkout op een andere commit of is hij niet schoon, dan eerst JP.
- **Waar het draait:** anders dan M5 Taak 13 (vanaf de Mac via een tunnel) draait `run.py` op max2 zelf, in tmux. Een run van uren mag niet afhangen van een laptop en een tunnel: een verbroken verbinding zou als niet-afgerond gesprek tellen. De route zelf is gelijk: `run.py` → `harness run` → Ollama `/v1` op `127.0.0.1:11434`. De code komt uit een worktree `~/Development/max2-m6` op max2, op de gepushte branch `feat/m6-precisie`. De uitvoer gaat naar `~/m6-runs/refiner-precisie-<datum>/` op max2, buiten elke repo, en daarna met `rsync` naar de Mac.
- **Modellen:** officiële Ollama-tags, geen hf.co-pull, geen afgeleide Modelfile, geen Q6 (spec §2 #2).

  | Model | `<label>` | `<tag>` | Grootte | `<kort>` |
  |---|---|---|---|---|
  | Q8 | `qwen3.8-q8-lokaal` | `qwen3.8:27b-q8_0` | 30 GB | `q8` |
  | Q4 | `qwen3.8-q4-lokaal` | `qwen3.8:27b-q4_K_M` | 18 GB | `q4` |

- **Omvang en instellingen:** D01–D05 × seeds 1, 2 en 3, dus 15 gesprekken per model (JP, 2026-10-01). Temperature 0,7 en seed gelijk aan de herhaling: de standaard van `run.py`. `--max-output-tokens 16384`. `maxTurns` 8, `maxToolErrors` 2 en `contextTokens` 65536 liggen vast in `run.py`. `--max-wall-seconds` komt uit de rooktest (Taak 2): ⌈16384 / snelheid × 1,5⌉, naar boven afgerond op een minuut. De tweede poging verdubbelt tokenbudget en grens (`run.py`, `conversation()`).
- **Snelheid** = de som van `output_tokens` gedeeld door de som van `wall_s`, over de beurtrijen (een getal in `turn`) van het rooktestgesprek in `raw.jsonl`. Is een van beide 0 of leeg, dan stopt de rooktest.
- **Oordeel** (spec §1):
  - Een regel met een percentage (afgerond, en elke check die meetelt: `SIEVE_CHECKS` met minstens vijf gesprekken) ligt _op de grens_ als zijn telling de kleinste is die slaagt (`meets()`: `n*100 >= totaal*procent`). Hij ligt _één eronder_ als één gesprek meer hem laat slagen.
  - Door, met een regel op de grens: onbeslist. Gezakt, alleen op regels één eronder: onbeslist. Gezakt, maar een `timed_out` bepaalt de uitkomst (tegenproef in Taak 4): onbeslist.
  - Een bevestigde vlag laat het model zakken; voor vlaggen is er geen grens.
- **Geen OpenRouter:** geen OpenRouter-label in een aanroep, geen uitgave. `check_key.py --env OPENROUTER_API_KEY` over de run-mappen geeft nul treffers.
- **max2:** downloads en serveracties alleen op JP's go, binnen het venster dat JP noemt. Elk venster loopt zo: dienststand vastleggen, worker stoppen met de M4-procedure, TEI, `open-webui` en `dsh` stoppen als ze draaien, meten, en precies herstellen, ook na een afbreking. Niet wijzigen: de Ollama-config, de productieconfig en het model van de worker.
- **`<datum>`** is de datum (UTC, JJJJ-MM-DD) van de Q8-rooktest. Alle bestanden van M6 gebruiken die ene datum.
- **Geheimen** nooit printen of loggen; een controle zet alleen namen en tellingen in de uitvoer. `FORGEJO_TOKEN` alleen via `GIT_ASKPASS` of `curl --config`.
- Forgejo is de forge; nooit `gh`. Geen merge zonder JP. Nooit `git branch -D`, nooit een kale `git stash`.
- **Gate vóór elke commit in max2:** `python3 -m unittest llm-bench/refiner/test_refiner.py` vanuit de repo-root, groen.

## Review Focus

1. **Een run die over JP's venster loopt.** Verwacht: afbreken, precies herstellen, en geen oordeel uit die map. Een gepland gesprek zonder rijen zou als niet afgerond tellen, en dan zou het venster de uitkomst bepalen. → Taak 3, stap "Venster".
2. **Een verbroken ssh-verbinding tijdens een run van uren.** Verwacht: de run loopt door, want hij draait in tmux op max2 zelf, zonder tunnel. → Taak 2 en 3: start in tmux, en na het opnieuw verbinden toont `tmux has-session` of de run leeft.
3. **Een officiële tag met een andere renderer of parser dan gsq, of een probe die niet `reliable` is.** Verwacht: stop vóór de lange run, en JP beslist. Met docs draait `run.py` een model alleen na `reliable`. → Taak 2.
4. **Handwerk in het oordeel.** Verwacht: elke telling komt uit de score-uitvoer, met teller en noemer in het rapport. Zo zijn de grens, de tegenproef en de optelling over seeds 1–6 na te rekenen. → Taak 4 en Taak 6.
5. **Een ander model dat Ollama laadt tijdens de meting.** Verwacht: geen, want worker, `open-webui` en `dsh` staan stil. `/api/ps` direct na een run toont alleen het gemeten model. → Taak 2 en 3.

## Bouwvolgorde

Spec §4. Spec en plan gaan vooraf als docs-PR (branch `docs/m6-local-precision-spec` in agent-harness); JP merget.

1. Taak 1: de labels, alleen in de repo.
2. Taak 2 (Q8): downloaden en de rooktest. Op JP's go, met een venster van ongeveer een uur.
3. Taak 3 (Q8): de run. Op JP's go, in een venster dat JP kiest op de duur uit Taak 2.
4. Taak 4 (Q8): het oordeel en het rapport. Dan één van drie:
   - Q8 door: Taak 5, dus Taak 2–4 voor Q4.
   - Onbeslist: JP kiest Taak 6 (seeds 4–6) of stoppen.
   - Gezakt, of JP stopt: Taak 7.
5. Taak 7: afronden en de PR in max2.

## Bestandsstructuur

| Repo | Bestand | Verantwoordelijkheid | Taak |
|---|---|---|---|
| max2 | `llm-bench/refiner/models.json` | twee labels | 1 |
| max2 | `llm-bench/refiner/test_refiner.py` | `LOCAL_MODELS` en `ModelsFileTest` | 1 |
| max2 | `llm-bench/README.md` | het aantal labels | 1 |
| max2 | `llm-bench/results/refiner-precisie-<datum>/` (nieuw) | run-mappen, logs, score-uitvoer, metingen, dienststand, `vlaggen-besluiten.json` | 2–6 |
| max2 | `llm-bench/results/refiner-precisie-<datum>.md` (nieuw) | het rapport | 4–7 |

## Increment 1 — de labels

### Taak 1: `qwen3.8-q8-lokaal` en `qwen3.8-q4-lokaal`

**Files:**
- Modify: `llm-bench/refiner/models.json`
- Modify: `llm-bench/refiner/test_refiner.py` (`LOCAL_MODELS` r. 2988; `ModelsFileTest` r. 3101-3118)
- Modify: `llm-bench/README.md` (r. 145-146)

**Interfaces:**
- Produces: de labels `qwen3.8-q8-lokaal` en `qwen3.8-q4-lokaal` voor `run.py --models`, en de branch `feat/m6-precisie` op Forgejo, die Taak 2 op max2 uitcheckt.

- [ ] Worktree op de Mac: `git -C ~/Development/max2 fetch origin && git -C ~/Development/max2 worktree add -b feat/m6-precisie ~/Development/max2-m6 origin/main`. De stappen hieronder draaien in `~/Development/max2-m6`.
- [ ] **Eerst de test.** In `llm-bench/refiner/test_refiner.py`:
  - `LOCAL_MODELS` (r. 2988) wordt:
    ```python
    LOCAL_MODELS = {"gsq-lokaal": "qwen3.8-gsq-rco:27b-iq3_s-text", "qwen3.6-lokaal": "qwen3.6:35b-a3b-coding",
                    "qwen3.8-q8-lokaal": "qwen3.8:27b-q8_0", "qwen3.8-q4-lokaal": "qwen3.8:27b-q4_K_M"}
    ```
  - `test_it_holds_the_seven_labels_in_the_order_of_the_plan` heet voortaan `test_it_holds_the_nine_labels_in_the_order_of_the_plans` en verwacht `["gsq-lokaal", "qwen3.6-lokaal", "qwen3.8-q8-lokaal", "qwen3.8-q4-lokaal", "qwen3.6-openrouter", "qwen3.8-openrouter", "gemma-openrouter", "qwen3.5-122b-openrouter", "nemotron-openrouter"]`.
  - De docstring van `ModelsFileTest` noemt de zeven labels van M5 en de twee van M6. `test_the_local_labels_are_the_two_installed_models_with_reasoning_off_without_docs_only` heet voortaan `test_the_local_labels_have_reasoning_off_without_docs_only`.
  - `python3 -m unittest llm-bench/refiner/test_refiner.py` is nu rood: de labellijst klopt niet en de nieuwe labels ontbreken in `models.json`.
- [ ] **`models.json`.** Voeg na `qwen3.6-lokaal` twee labels in, met precies de blokken van `gsq-lokaal`, in de opmaak van het bestand:
  ```json
  "qwen3.8-q8-lokaal": {
   "base_url": "http://127.0.0.1:11434/v1",
   "name": "qwen3.8:27b-q8_0",
   "nodocs": {"reasoningEffort": "none", "extraBody": {}},
   "docs": {"extraBody": {}},
   "probe": {"extraBody": {"reasoning_effort": "none"}}
  },
  ```
  `qwen3.8-q4-lokaal` is gelijk, met `"name": "qwen3.8:27b-q4_K_M"`.
- [ ] **README** r. 145-146: "kent zeven labels: `gsq-lokaal` en `qwen3.6-lokaal` (via Ollama's OpenAI-endpoint) en vijf via OpenRouter." wordt "kent negen labels: vier lokaal via Ollama's OpenAI-endpoint (`gsq-lokaal`, `qwen3.6-lokaal`, en voor M6 `qwen3.8-q8-lokaal` en `qwen3.8-q4-lokaal`, de officiële tags `qwen3.8:27b-q8_0` en `qwen3.8:27b-q4_K_M`) en vijf via OpenRouter." De rest van de alinea blijft.
- [ ] De unittest is groen. `test_every_label_of_models_json_runs_in_both_variants_and_its_manifest_is_accepted` draait de nieuwe labels nu ook door de nep-harness.
- [ ] Commit (`feat(refiner): labels voor qwen3.8 Q8 en Q4 (M6)`) en push `feat/m6-precisie` naar origin met `GIT_ASKPASS`. Nog geen PR: die volgt in Taak 7.

## Increment 2 — de metingen, per model

Taak 2, 3 en 4 gelden per model uit de tabel in Global Constraints, eerst voor Q8. Voor Q4 alleen via Taak 5. `<label>`, `<tag>` en `<kort>` komen uit die tabel. `<W>` komt uit de rooktest van hetzelfde model. Alle commando's met `~/m6-runs` of `~/Development/max2-m6` draaien op max2 (`ssh max2`), tenzij er "op de Mac" staat.

### Taak 2: downloaden en de rooktest (op JP's go; download en serveractie op max2)

Het eerste praktijkbewijs. De uitkomst is de snelheid, `<W>` en de geschatte duur van de lange run, zodat JP het venster van Taak 3 kan kiezen.

**Files:** op max2, in `~/m6-runs/refiner-precisie-<datum>/`:
- `rooktest-<kort>/` (de run-map) en `rooktest-<kort>.log`;
- `rooktest-<kort>-metingen.txt`;
- `dienststand-rooktest-<kort>-voor.txt` en `dienststand-rooktest-<kort>-na.txt`.

**Interfaces:**
- Consumes: branch `feat/m6-precisie` (Taak 1).
- Produces: `<W>` en de geschatte duur, in `rooktest-<kort>-metingen.txt`, voor Taak 3.

- [ ] **Worktree op max2**, alleen de eerste keer: `git -C ~/Development/max2 fetch origin feat/m6-precisie && git -C ~/Development/max2 worktree add --detach ~/Development/max2-m6 FETCH_HEAD`. Leg `git -C ~/Development/max2-m6 rev-parse HEAD` vast; die commit is gelijk aan die van Taak 1. Draai daar de unittest: groen. Dat bewijst ook Python op max2.
- [ ] **Harness:** `git -C ~/Development/agent-harness rev-parse --short HEAD` geeft `15c1e26` en `git -C ~/Development/agent-harness status --porcelain` is leeg. Anders stoppen en JP.
- [ ] **Download.** Die kan terwijl de worker draait: `ollama pull <tag>`. Daarna toont `ollama list` de tag.
- [ ] **Renderer en parser:** `ollama show --modelfile <tag> | grep -E '^(RENDERER|PARSER) '` geeft dezelfde twee regels als `ollama show --modelfile qwen3.8-gsq-rco:27b-iq3_s-text | grep -E '^(RENDERER|PARSER) '`. Anders stoppen en JP: dan is de route niet die van M5.
- [ ] **Dienststand vooraf**, naar `dienststand-rooktest-<kort>-voor.txt`:
  - `systemctl is-active agent-harness-worker`;
  - van `docker ps --format '{{.Names}}'` alleen `tei-gpu`, `open-webui` en `dsh`;
  - `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`;
  - `curl -s 127.0.0.1:11434/api/ps`.
- [ ] **Stoppen**, met de M4-procedure (`docs/plans/M4-harness-run-logging.md:30-33`, Global Constraints), op de Mac:
  ```bash
  d=$(mktemp -d)
  q="select id, kind, status, retry_count from claude_jobs where required_capability = 'local_llm' order by id"
  ssh scrum4me-srv "docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me -Atc \"$q\"" > "$d/voor.tmp" && mv "$d/voor.tmp" "$d/voor.txt"
  grep -cE '\|(CLAIMED|RUNNING)\|' "$d/voor.txt"      # 0; anders niet stoppen
  ssh max2 'sudo -n systemctl stop agent-harness-worker && systemctl is-active agent-harness-worker'   # inactive of failed
  ssh scrum4me-srv "docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me -Atc \"$q\"" > "$d/na.tmp" && mv "$d/na.tmp" "$d/na.txt"
  diff "$d/voor.txt" "$d/na.txt"                        # exit 0 = schoon
  ```
  Een opname telt alleen als `psql` met exitcode 0 eindigt; een mislukte opname is nooit schoon. Is de diff niet leeg, dan blijft de worker gestopt en volgt de rest van de M4-procedure (de ID's naar JP). Stop daarna wat draait: TEI met `docker compose -f /srv/apps/tei/docker-compose.yml stop`, `open-webui` en `dsh` met `docker stop`.
- [ ] **Geheugen vooraf**, naar `rooktest-<kort>-metingen.txt`: `grep -E '^(pswpin|pswpout) ' /proc/vmstat` en `grep MemAvailable /proc/meminfo`.
- [ ] **Het rooktestgesprek** (D03, seed 1), in tmux:
  ```bash
  mkdir -p ~/m6-runs/refiner-precisie-<datum>
  cd ~/Development/max2-m6/llm-bench
  tmux new-session -d -s m6-rooktest-<kort> "./refiner/run.py --backend harness \
    --harness 'node /home/janpeter/Development/agent-harness/dist/cli.js' --variant docs \
    --models <label> --cases D03 --seeds 1 --max-output-tokens 16384 --max-wall-seconds 3600 \
    --out /home/janpeter/m6-runs/refiner-precisie-<datum>/rooktest-<kort> \
    > /home/janpeter/m6-runs/refiner-precisie-<datum>/rooktest-<kort>.log 2>&1; \
    echo exit=\$? >> /home/janpeter/m6-runs/refiner-precisie-<datum>/rooktest-<kort>.log"
  ```
  `run.py` doet eerst de probe. Met docs draait het model alleen na `reliable`. De grens van 3600 s per beurt is ruim voor een eerste gesprek van onbekende snelheid.
- [ ] **Direct na afloop**, terwijl het model nog vijf minuten geladen is (standaard `keep_alive`), naar `rooktest-<kort>-metingen.txt`:
  - `ollama ps` en `curl -s 127.0.0.1:11434/api/ps`: grootte, `size_vram` en de verdeling over CPU en GPU. Alleen `<tag>` is geladen.
  - De swaptellers en `MemAvailable` opnieuw.
- [ ] **Controle:** de proberij in `raw.jsonl` heeft het oordeel `reliable`, en het log eindigt op `exit=0`. Het gesprek mag `final` of `error` zijn, want dit is een snelheidsmeting. Een `invocation_error` of een ontbrekende eindrij is een fout in de route: stoppen en JP.
- [ ] **Snelheid, grens en duur**, ook naar `rooktest-<kort>-metingen.txt`:
  ```bash
  python3 - ~/m6-runs/refiner-precisie-<datum>/rooktest-<kort>/raw.jsonl <<'EOF'
  import json, math, sys
  rows = [json.loads(line) for line in open(sys.argv[1])]
  turns = [r for r in rows if isinstance(r.get("turn"), int)]
  out = sum(r.get("output_tokens") or 0 for r in turns)
  wall = sum(r.get("wall_s") or 0 for r in turns)
  if out <= 0 or wall <= 0:
      sys.exit("snelheid niet te berekenen: de rooktest stopt")
  speed = out / wall
  conversation = sum(r.get("conversation_wall_s") or 0 for r in rows if r.get("turn") == "end")
  print(f"uitvoertokens={out} wall_s={wall:.1f} snelheid={speed:.2f} tok/s")
  print(f"W={math.ceil(16384 / speed * 1.5 / 60) * 60}")
  print(f"duur_s={max(54000 / speed, 15 * conversation):.0f}")
  EOF
  ```
  De geschatte duur is het grootste van twee getallen. Het eerste is 54.000 uitvoertokens (gsq in M5, alle pogingen) gedeeld door de snelheid. Het tweede is 15 keer de duur van het rooktestgesprek. Tweede pogingen komen daar nog bij.
- [ ] **Herstel**, ook na een afbreking, precies naar `dienststand-rooktest-<kort>-voor.txt`:
  - `docker start` voor de containers die draaiden;
  - `docker compose -f /srv/apps/tei/docker-compose.yml start`, alleen als TEI draaide;
  - `sudo -n systemctl start agent-harness-worker`, als de worker `active` was, en daarna de controle dat hij `active` is.

  Leg de dienststand daarna vast in `dienststand-rooktest-<kort>-na.txt`. De dienstregels zijn gelijk aan vooraf.
- [ ] **Melden aan JP:** renderer en parser, het probe-oordeel, de status van het gesprek, grootte en verdeling, `MemAvailable` en de swaptellers, de snelheid, `<W>` en de geschatte duur. JP kiest het venster voor Taak 3. Laadt het model niet, is de probe niet `reliable`, of is de snelheid niet te berekenen? Dan stoppen, herstellen, en JP beslist (spec §6).

### Taak 3: de run (op JP's go, in het venster dat JP koos)

**Files:**
- Op max2, in `~/m6-runs/refiner-precisie-<datum>/`: `<kort>-docs/`, `<kort>-docs.log`, `dienststand-<kort>-voor.txt` en `dienststand-<kort>-na.txt`.
- Op de Mac, de kopie in `llm-bench/results/refiner-precisie-<datum>/`, plus `<kort>-docs.score.txt`.

**Interfaces:**
- Consumes: `<W>` uit Taak 2; de worktree `~/Development/max2-m6` op max2.
- Produces: de run-map `<kort>-docs/` met `summary.csv`, en `<kort>-docs.score.txt`, voor Taak 4.

- [ ] Harness-controle zoals in Taak 2: `15c1e26`, schone status.
- [ ] Dienststand vooraf en stoppen, precies zoals in Taak 2: de M4-procedure, dan TEI, `open-webui` en `dsh`. De dienststand gaat naar `dienststand-<kort>-voor.txt`.
- [ ] **De run**, in tmux:
  ```bash
  cd ~/Development/max2-m6/llm-bench
  tmux new-session -d -s m6-<kort> "./refiner/run.py --backend harness \
    --harness 'node /home/janpeter/Development/agent-harness/dist/cli.js' --variant docs \
    --models <label> --seeds 1 2 3 --max-output-tokens 16384 --max-wall-seconds <W> \
    --out /home/janpeter/m6-runs/refiner-precisie-<datum>/<kort>-docs \
    > /home/janpeter/m6-runs/refiner-precisie-<datum>/<kort>-docs.log 2>&1; \
    echo exit=\$? >> /home/janpeter/m6-runs/refiner-precisie-<datum>/<kort>-docs.log"
  ```
  Volg de voortgang met `tail` op het log. Na het opnieuw verbinden toont `tmux has-session -t m6-<kort>` of de run nog loopt.
- [ ] **Venster.** Dreigt de run over het einde van het venster te lopen? Breek af met `tmux send-keys -t m6-<kort> C-c` en herstel. Een afgebroken map geeft geen oordeel. JP kiest een nieuw venster, en de run begint dan opnieuw in een nieuwe map (`<kort>-docs-2`).
- [ ] Direct na afloop toont `curl -s 127.0.0.1:11434/api/ps` alleen `<tag>`. Het log eindigt op `exit=0`.
- [ ] Herstel zoals in Taak 2. De dienststand na gaat naar `dienststand-<kort>-na.txt` en is gelijk aan vooraf.
- [ ] **Kopie naar de Mac:** `rsync -a max2:m6-runs/refiner-precisie-<datum>/ ~/Development/max2-m6/llm-bench/results/refiner-precisie-<datum>/`.
- [ ] **Op de Mac**, in `~/Development/max2-m6/llm-bench`:
  - `./refiner/score.py results/refiner-precisie-<datum>/<kort>-docs > results/refiner-precisie-<datum>/<kort>-docs.score.txt`;
  - `./refiner/check_key.py --env OPENROUTER_API_KEY results/refiner-precisie-<datum>` geeft `with_key=0`.

### Taak 4: het oordeel en het rapport

**Files:**
- Create of modify: `llm-bench/results/refiner-precisie-<datum>.md`
- Create of modify, alleen bij vlaggen: `llm-bench/results/refiner-precisie-<datum>/vlaggen-besluiten.json`

**Interfaces:**
- Consumes:
  - `<kort>-docs.score.txt`, `<kort>-docs/summary.csv` en `<kort>-docs/raw.jsonl` (Taak 3);
  - `rooktest-<kort>-metingen.txt` (Taak 2).
- Produces: het oordeel door, gezakt of onbeslist. Dat bepaalt de volgende taak.

- [ ] **Vlaggen.** D5 geldt alleen voor D02, dus er zijn per model hooguit drie nieuwe vlaggen. JP beoordeelt elke D5-vlag op een reviewpagina zoals in M5 (spec §2 #5). Dat is een privé artifact met de `db`-capability, dat alleen de eigenaar beschrijft. Per vlag staan er het transcript met de treffer gemarkeerd, het patroon, en knoppen voor bevestigen, verwerpen en twijfel. Lees de besluiten uit met `ArtifactData list`. Leg ze vast in `vlaggen-besluiten.json`, in de vorm van M5: `{"bron": …, "besluiten": [{"blind_id", "besluit", "check", "model", "variant", "case", "seed", "notitie", "bijgewerkt"}]}`. Zonder vlaggen is er geen pagina en geen bestand.
- [ ] **Zeef met de besluiten.** Neem de zeef van `score.py` en laat verworpen vlaggen weg. Een bevestigde vlag laat het model zakken.
- [ ] **Grens per regel.** Schrijf voor afgerond en voor elke check die meetelt de teller en de noemer op, met de kleinste telling die slaagt (afgerond 90%, checks 80%, `meets()`). Markeer _op de grens_ en _één eronder_. Bij 15 gesprekken:
  - afgerond: 14 en 13;
  - een check over 15 gesprekken: 12 en 11;
  - D2, over 12 gesprekken: 10 en 9.
- [ ] **Timeout-tegenproef.** Alleen nodig als een gesprek na beide pogingen eindigde met een beurtrij met harness-status `timed_out` in `raw.jsonl`. Tel zulke gesprekken als afgerond, en als geslaagd op elke check die voor hun case geldt (`n.v.t.` en een bevestigde vlag blijven zoals ze zijn). Slaat de zeef dan om, dan is het oordeel onbeslist.
- [ ] **Oordeel:** door, gezakt of onbeslist, volgens Global Constraints.
- [ ] **Rapport** `llm-bench/results/refiner-precisie-<datum>.md`. Voor Q4 komen de rij en het oordeel erbij. Het rapport bevat:
  - de docs-tabel van `score.py`, naast de M5-rijen van `gsq-lokaal` en `qwen3.8-openrouter` (uit `refiner-vergelijking-2026-10-01.md`, tabel "Met docs");
  - de zeef met de besluiten over de vlaggen, de regels op of één onder de grens met teller en noemer, en het oordeel;
  - per niet-afgerond gesprek de status, met elke `timed_out` apart, en zo nodig de tegenproef;
  - snelheid, grootte, verdeling en swaptellers uit de rooktest, ter informatie;
  - de conclusie volgens de tabel in spec §1, met de kandidaten als schatting voor een proef op een Mac;
  - per venster de dienststand vooraf en achteraf;
  - de commits: de max2-worktree (Taak 2) en de harness (`15c1e26`).
- [ ] Commit de run-mappen, metingen, dienststand, score-uitvoer en het rapport in `feat/m6-precisie`, met de unittest groen.
- [ ] **Volgende stap:**

  | Oordeel | Q8 | Q4 |
  |---|---|---|
  | Door | Taak 5 | Taak 7 |
  | Gezakt | Taak 7 | Taak 7 |
  | Onbeslist | JP kiest: Taak 6 of stoppen | JP kiest: Taak 6 of stoppen |

  Stoppen gaat verder als gezakt (spec §1).

### Taak 5: Q4 (alleen als Q8 door is; op JP's go, in eigen vensters)

- [ ] Taak 2, 3 en 4 met de Q4-rij uit de tabel in Global Constraints: label `qwen3.8-q4-lokaal`, tag `qwen3.8:27b-q4_K_M` (18 GB), kort `q4`. De download valt pas hier. Q4 krijgt een eigen rooktest en een eigen `<W>`.
- [ ] Het rapport krijgt de conclusie voor de aankoop, volgens spec §1:
  - Q4 door: kandidaat Q4_K_M, een Mac van ongeveer 32–36 GB, krap bij 32 GB;
  - Q4 gezakt, of onbeslist en daarna gestopt: kandidaat Q8_0, ongeveer 48 GB.

  Daarna Taak 7.

### Taak 6: seeds 4–6 (alleen bij een onbeslist oordeel en op JP's keuze)

- [ ] **Venster en run**, zoals Taak 3, met `--seeds 4 5 6`, de map `<kort>-docs-s456`, de tmux-sessie `m6-<kort>-s456` en dezelfde `<W>`. Spec §4 zegt "dezelfde stappen 2–5". Een nieuwe rooktest (stap 3) levert hier niets op: model, host en instellingen zijn gelijk, dus `<W>` en de verdeling zijn bekend, en de probe draait in `run.py` vanzelf mee.
- [ ] Score de nieuwe map apart, naar `<kort>-docs-s456.score.txt`. Nieuwe D5-vlaggen beoordeelt JP zoals in Taak 4.
- [ ] **Optellen** (spec §4). Tel per regel de tellers en noemers van beide score-uitvoeren op: afgerond over de 30 geplande gesprekken, en elke check over de gesprekken waarvoor hij geldt. Daarop gelden dezelfde drempels, de ondergrens van vijf gesprekken, en de grens. Bij 30 gesprekken:

  | Regel | Op de grens | Eén eronder |
  |---|---|---|
  | Afgerond (30) | 27 | 26 |
  | Een check over 30 gesprekken | 24 | 23 |
  | D2 (24 gesprekken) | 20 | 19 |
  | D4 (6 gesprekken) | 5 | 4 |

  D4 telt nu voor het eerst mee; in M5 telde D4 voor geen enkel model. Vlaggen tellen uit beide runs.
- [ ] **Oordeel over seeds 1–6:**
  - door: verder zoals bij door (Q8: Taak 5; Q4: kandidaat Q4_K_M);
  - gezakt, of nog onbeslist: verder als gezakt.
- [ ] Het rapport krijgt beide score-uitvoeren, de opgetelde tellingen en het oordeel. Commit.

### Taak 7: afronden en de PR

- [ ] Loop de zes acceptatiecriteria uit spec §5 na, en zet per criterium het bewijs in het rapport.
- [ ] De unittest is groen, en `./refiner/check_key.py --env OPENROUTER_API_KEY results/refiner-precisie-<datum>` geeft `with_key=0`.
- [ ] Push `feat/m6-precisie` en open de PR op Forgejo via de API: `curl --config` met de header uit `$FORGEJO_TOKEN`, dus de token niet in argv. JP merget.
- [ ] Op max2: `git -C ~/Development/max2 worktree remove ~/Development/max2-m6`. Dat kan zonder `--force`, want de uitvoer staat in `~/m6-runs`. `~/m6-runs` en de gedownloade modellen blijven staan; ze verwijderen is aan JP.

## Buiten dit plan

Snelheid of geheugen op een Mac, een ander model voor de productieworker, de variant zonder docs, Q6_K, andere modellen, nieuwe checks en uitgaven bij OpenRouter (spec §1). De ceremonie voor dit plan volgt pas na JP's akkoord.

## Review record

Nog niet gereviewd.

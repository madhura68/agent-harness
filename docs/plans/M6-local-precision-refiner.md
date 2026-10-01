# M6 — qwen3.8-27b lokaal op hogere precisie: implementatieplan

_Status: draft, revisie 3 (2026-10-01). Een technisch GO autoriseert geen ceremonie, download, serveractie, merge of uitvoering._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** een rapport `llm-bench/results/refiner-precisie-<datum>.md` (repo max2) met de docs-variant van de M5-bank voor `qwen3.8:27b-q8_0` op max2, en zo nodig voor `qwen3.8:27b-q4_K_M`. Het zet de uitslag naast gsq en gehost uit M5, geeft het oordeel door, gezakt of onbeslist, en wat dat betekent voor de aankoop.

**Architecture:** geen nieuwe code. Twee labels in `llm-bench/refiner/models.json` en de tests die de labels pinnen. Daarna draait `run.py --backend harness` op max2 zelf, in tmux, tegen Ollama op 127.0.0.1, met dezelfde prompt, docset, cases, checks en zeef als M5. `score.py` scoort. Het oordeel (grens, onbeslist, de timeout-tegenproef) reken je met de hand uit de score-uitvoer, zoals spec §1 en §4 voorschrijven.

**Tech Stack:** max2 `llm-bench` (Python 3, alleen de standaardbibliotheek, `unittest`); agent-harness `dist/cli.js` op max2 (Node 24); Ollama 0.34.4 op max2; tmux.

**Spec:** `docs/specs/2026-10-01-local-precision-refiner-design.md` (revisie 4: dubbel GO in ronde 3, daarna JP's besluit voor drie seeds). Voorganger: `docs/plans/M5-model-comparison-refiner.md`; Taak 13 daarvan is de procedure die dit plan volgt.

## Global Constraints

- **Route, ongewijzigd uit M5** (spec §2 #4): `run.py --backend harness`, variant `docs`, systeemprompt v3 (`llm-bench/prompts/promptverfijner-systeem.txt`) met `promptverfijner-docs-addendum.txt`, de bevroren docset `llm-bench/refiner/docset/`, de cases D01–D05 uit `cases.jsonl`, en de checks en de zeef van `score.py`. Geen wijziging aan `run.py`, `score.py`, `cases.jsonl`, de prompts, de docset of de harness.
- **Harness:** `node /home/janpeter/Development/agent-harness/dist/cli.js` op max2, op main `15c1e26`. `harness run`, `probe` en `doc-server` zijn daar gelijk aan de M5-build `aaae1a0`: sindsdien veranderde alleen het workerpad (`cmdWorker` in `src/cli.ts` en `src/worker/doc-tools.ts`, ISS-1). Staat de checkout op een andere commit of is hij niet schoon, dan eerst JP.
- **Waar het draait:** anders dan M5 Taak 13 (vanaf de Mac via een tunnel) draait `run.py` op max2 zelf, in tmux. Een run van uren mag niet afhangen van een laptop en een tunnel: een verbroken verbinding zou als niet-afgerond gesprek tellen. De route zelf is gelijk: `run.py` → `harness run` → Ollama `/v1` op `127.0.0.1:11434`.
  - **Code:** uit een worktree `~/Development/max2-m6` op max2, op de gepushte branch `feat/m6-precisie`.
  - **Uitvoer:** naar `~/m6-runs/refiner-precisie-<datum>/` op max2, buiten elke repo.
  - **Kopie:** met `rsync` naar `~/Development/m6-runs/refiner-precisie-<datum>/` op de Mac, ook buiten de repo. Alleen de bestanden die M5 ook bewaarde, gaan de repo in (Taak 4).
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
- **Alleen een geldige run-map telt** (Vensterprocedure, "Geldige run"). Uit een afgebroken of ongeldige map komt geen oordeel; hij gaat niet de repo in.
- **Geen OpenRouter:** geen OpenRouter-label in een aanroep, geen uitgave. `check_key.py --env OPENROUTER_API_KEY` draait op de Mac, waar die variabele in `~/.zshenv` staat, en geeft nul treffers (spec §5 criterium 6). Is de variabele daar leeg (exit 2), dan stoppen en JP; nooit een andere waarde invullen.
- **max2:** downloads en serveracties alleen op JP's go, binnen het venster dat JP noemt. Elk venster volgt de Vensterprocedure hieronder. Niet wijzigen: de Ollama-config, de productieconfig en het model van de worker.
- **`<datum>`** is de datum (UTC, JJJJ-MM-DD) van de Q8-rooktest. Alle bestanden van M6 gebruiken die ene datum.
- **Geheimen** nooit printen of loggen; een controle zet alleen namen en tellingen in de uitvoer. `FORGEJO_TOKEN` alleen via `GIT_ASKPASS` of `curl --config`.
- Forgejo is de forge; nooit `gh`. Geen merge zonder JP. Nooit `git branch -D`, nooit een kale `git stash`, geen `--force` bij `git worktree remove`.
- **Gate vóór elke commit in max2:** `python3 -m unittest llm-bench/refiner/test_refiner.py` vanuit de repo-root, op de Mac, groen.

## Vensterprocedure

Geldt voor elk venster op max2: Taak 2, 3, 5 en 6. Bij de ceremonie gaat dit blok mee in elke taak die het gebruikt. De paden staan in shellvariabelen; zet ze in elke shell eerst: op max2 `R=/home/janpeter/m6-runs/refiner-precisie-<datum>`, op de Mac `M=~/Development/m6-runs/refiner-precisie-<datum>` en `D=~/Development/max2-m6/llm-bench/results/refiner-precisie-<datum>`.

**Dienststand.** Op max2, naar `$R/dienststand-<venster>-voor.txt` en na het herstel naar `$R/dienststand-<venster>-na.txt`:
- `systemctl is-active agent-harness-worker`;
- van `docker ps --format '{{.Names}}'` alleen `tei-gpu`, `open-webui` en `dsh`;
- `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`;
- `curl -s 127.0.0.1:11434/api/ps`.

De dienstregels (de eerste twee) zijn na het herstel gelijk aan vooraf.

**Stoppen.** Op de Mac. Dit is de M4-procedure (`docs/plans/M4-harness-run-logging.md:30-33`) als script dat bij de eerste fout stopt:

```bash
#!/bin/bash
d=$(mktemp -d)
q="select id, kind, status, retry_count from claude_jobs where required_capability = 'local_llm' order by id"
opname() {   # $1 = voor | na; een opname telt alleen bij exitcode 0 van psql
  ssh scrum4me-srv "docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me -Atc \"$q\"" > "$d/$1.tmp" &&
    mv "$d/$1.tmp" "$d/$1.txt"
}
opname voor || { echo "opname voor mislukt: niet stoppen"; exit 1; }
grep -qE '\|(CLAIMED|RUNNING)\|' "$d/voor.txt"
case $? in
  0) echo "local_llm-job geclaimd of bezig: niet stoppen"; exit 1 ;;
  1) ;;
  *) echo "controle op claims mislukt: niet stoppen, JP"; exit 1 ;;
esac
ssh max2 'sudo -n systemctl stop agent-harness-worker' || { echo "stop mislukt: JP"; exit 1; }
toestand=$(ssh max2 'systemctl is-active agent-harness-worker')
case "$toestand" in inactive|failed) ;; *) echo "worker is $toestand na de stop: JP"; exit 1 ;; esac
opname na || { echo "opname na mislukt: worker blijft gestopt, JP"; exit 1; }
diff "$d/voor.txt" "$d/na.txt"
case $? in
  0) echo "schone stop" ;;
  1) echo "verschil: worker blijft gestopt, de ID's uit de diff naar JP (M4 stap 2)"; exit 1 ;;
  *) echo "diff mislukt: worker blijft gestopt, JP"; exit 1 ;;
esac
```

Na een schone stop stop je op max2 wat volgens de dienststand draait: TEI met `docker compose -f /srv/apps/tei/docker-compose.yml stop`, `open-webui` en `dsh` met `docker stop`. Bij elk ander einde van het script volgt de rest van de M4-procedure, en er wordt niet gemeten.

**Herstellen.** Ook na een afbreking. Op max2, precies naar de dienststand vooraf:
- `docker start` voor de containers die draaiden;
- `docker compose -f /srv/apps/tei/docker-compose.yml start`, alleen als `tei-gpu` draaide;
- `sudo -n systemctl start agent-harness-worker`, als de worker `active` was, en daarna `systemctl is-active agent-harness-worker` geeft `active`.

Leg daarna de dienststand na vast.

**Starten en wachten.** Op max2. Direct na `tmux new-session -d -s <sessie> …` legt `sid=$(tmux display -p -t <sessie> '#{pane_pid}') && echo "$sid" > "$R/<map>.sid"` het sessie-ID van de run vast. Het paneel is de leider van een eigen sessie, dus `run.py`, de harness en de doc-server delen dat ID; vreemde processen niet, ook niet een shell die op een woord als `refiner/run.py` zoekt. De run is afgelopen als `tmux has-session -t <sessie>` faalt én `pgrep -s "$sid"` niets vindt. Pas daarna volgen herstel en kopie. Het log eindigt dan op `exit=<code>`; of de map telt, beslist "Geldige run".

**Afbreken.** Dreigt een run over het einde van het venster te lopen?
1. `tmux send-keys -t <sessie> C-c`.
2. Wacht zoals hierboven, hooguit twee minuten.
3. Leeft er dan nog een proces in sessie `$sid`: `pkill -TERM -s "$sid"` en nog een minuut wachten. Leeft er daarna nog iets, dan JP; de worker blijft gestopt.
4. Herstel pas als niets in sessie `$sid` meer leeft.

De afgebroken map geeft geen oordeel. JP kiest een nieuw venster, en de run begint dan in een nieuwe map met het volgnummer erachter (`-2`, `-3`).

**Geldige run.** Een run-map is geldig als het log eindigt op `exit=0` en deze controle (op de Mac, na de kopie) `geldig` print. `<n>` is het aantal geplande gesprekken: 1 voor een rooktest, 15 voor een run.

```bash
python3 - <map>/raw.jsonl <n> <<'EOF'
import json, sys
path, n = sys.argv[1], int(sys.argv[2])
rows = [json.loads(line) for line in open(path, encoding="utf-8").read().split("\n") if line.strip()]
plans = [r for r in rows if r.get("turn") == "plan"]
planned = {tuple(p) for p in plans[-1]["conversations"]} if plans else set()
last_end = {}   # per gesprek de eindrij van de hoogste poging
for r in rows:
    if r.get("turn") == "end":
        key, poging = (r["case"], r["seed"]), r.get("poging", 1)
        if key not in last_end or poging >= last_end[key][0]:
            last_end[key] = (poging, r["status"])
problems = []
if len(plans) != 1 or len(planned) != n:
    problems.append(f"plan: {len(plans)} rij(en) met {len(planned)} gesprekken, verwacht 1 met {n}")
if any(r.get("turn") == "stop" for r in rows):
    problems.append("stop-rij")
for case, seed in sorted(planned):
    poging, status = last_end.get((case, seed), (None, None))
    if status in (None, "invocation_error"):
        problems.append(f"{case}/{seed}: {status or 'geen eindrij'}")
    elif status == "error" and poging == 1:   # na error volgt altijd een tweede poging (run.py, conversation())
        problems.append(f"{case}/{seed}: tweede poging ontbreekt")
print("geldig" if not problems else "ongeldig: " + "; ".join(problems))
sys.exit(1 if problems else 0)
EOF
```

Een ongeldige map geeft geen oordeel. Herstellen, aan JP melden, en opnieuw draaien in een nieuwe map, net als na een afbreking.

## Review Focus

1. **Een run die over JP's venster loopt, of een run die met `exit≠0`, een stop-rij of een `invocation_error` eindigt.** Verwacht: afbreken of stoppen, precies herstellen, en geen oordeel uit die map. Een gepland gesprek zonder rijen zou als niet afgerond tellen, en dan zou het venster of een crash de uitkomst bepalen. → Vensterprocedure, "Afbreken" en "Geldige run"; Taak 3.
2. **Een verbroken ssh-verbinding tijdens een run van uren.** Verwacht: de run loopt door, want hij draait in tmux op max2 zelf, zonder tunnel. De metingen na afloop lopen in hetzelfde script mee, zodat ze niet van een wakkere operator afhangen. → Taak 2 en 3.
3. **Een officiële tag met een andere renderer of parser dan gsq, of een probe die niet `reliable` is.** Verwacht: stop vóór de lange run, en JP beslist. Een ander `PARAMETER` gaat naar het rapport en naar JP, maar is geen stop. → Taak 2.
4. **Handwerk in het oordeel.** Verwacht: elke telling komt uit de score-uitvoer, met teller en noemer in het rapport. Zo zijn de grens, de tegenproef en de optelling over seeds 1–6 na te rekenen. → Taak 4 en Taak 6.
5. **Een ander model dat Ollama laadt tijdens de meting.** Verwacht: geen, want worker, `open-webui` en `dsh` staan stil. Het script legt `/api/ps` direct na de run vast. → Taak 2 en 3.

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

| Waar | Bestand | Verantwoordelijkheid | Taak |
|---|---|---|---|
| max2-repo | `llm-bench/refiner/models.json` | twee labels | 1 |
| max2-repo | `llm-bench/refiner/test_refiner.py` | `LOCAL_MODELS` en `ModelsFileTest` | 1 |
| max2-repo | `llm-bench/README.md` | het aantal labels | 1 |
| host max2, buiten de repo | `~/m6-runs/refiner-precisie-<datum>/` | volledige run-mappen, scripts, logs, metingen, dienststand | 2, 3, 5, 6 |
| Mac, buiten de repo | `~/Development/m6-runs/refiner-precisie-<datum>/` | de kopie daarvan, plus `summary.csv` en de score-uitvoer | 2–6 |
| max2-repo | `llm-bench/results/refiner-precisie-<datum>/` (nieuw) | per geldige run-map de bestanden die M5 bewaarde, met de logs, scripts, metingen, dienststand, score-uitvoer en `vlaggen-besluiten.json` | 4, 6 |
| max2-repo | `llm-bench/results/refiner-precisie-<datum>.md` (nieuw) | het rapport | 4–7 |

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

Taak 2, 3 en 4 gelden per model uit de tabel in Global Constraints, eerst voor Q8. Voor Q4 alleen via Taak 5. `<label>`, `<tag>` en `<kort>` komen uit die tabel. `<W>` komt uit de rooktest van hetzelfde model. `$R`, `$M` en `$D` zijn de paden uit de Vensterprocedure.

### Taak 2: downloaden en de rooktest (op JP's go; download en serveractie op max2)

Het eerste praktijkbewijs. De uitkomst is de snelheid, `<W>` en de geschatte duur van de lange run, zodat JP het venster van Taak 3 kan kiezen.

**Files:**
- Op max2, in `$R`: `rooktest-<kort>.sh`, de run-map `rooktest-<kort>/` met zijn log, `rooktest-<kort>-metingen.txt`, en `dienststand-rooktest-<kort>-voor.txt` en `-na.txt`.
- Op de Mac: de kopie in `$M`, plus `rooktest-<kort>/summary.csv` en `rooktest-<kort>.score.txt`.

**Interfaces:**
- Consumes: branch `feat/m6-precisie` (Taak 1); de Vensterprocedure.
- Produces: `<W>` en de geschatte duur, in `rooktest-<kort>-metingen.txt`, voor Taak 3.

- [ ] **Voorbereiden op max2:**
  - De eerste keer: `git -C ~/Development/max2 fetch origin feat/m6-precisie && git -C ~/Development/max2 worktree add --detach ~/Development/max2-m6 FETCH_HEAD`. `git -C ~/Development/max2-m6 rev-parse HEAD` is de commit van Taak 1; leg hem vast.
  - `mkdir -p "$R"`.
  - Harness: `git -C ~/Development/agent-harness rev-parse --short HEAD` geeft `15c1e26`, en `git -C ~/Development/agent-harness status --porcelain` is leeg. Anders stoppen en JP.
- [ ] **Download.** Die kan terwijl de worker draait: `ollama pull <tag>`. Leg `ollama --version` en de regel van `<tag>` uit `ollama list` (met de ID) vast in `$R/rooktest-<kort>-metingen.txt`.
- [ ] **Modelfile:**
  - `ollama show --modelfile <tag> | grep -E '^(RENDERER|PARSER|PARAMETER) '` en hetzelfde voor `qwen3.8-gsq-rco:27b-iq3_s-text`, beide naar de metingen.
  - Wijken `RENDERER` of `PARSER` af, dan stoppen en JP: dan is de route niet die van M5.
  - Een ander of ontbrekend `PARAMETER` (gsq zet onder meer `top_k`, `top_p`, `min_p` en `repeat_penalty`; `run.py` zet alleen `temperature` en `seed`) is geen stop. Het gaat wel naar JP en in het rapport, als deel van "geen zuivere proef" (spec §1).
- [ ] **Venster openen:** de dienststand vooraf (`rooktest-<kort>`), daarna Stoppen, volgens de Vensterprocedure.
- [ ] **Het rooktestgesprek** (D03, seed 1) in een script, zodat de metingen na afloop niet van een wakkere operator afhangen. Ollama houdt het model vijf minuten geladen, dus het script meet direct na het gesprek. Op max2:
  ```bash
  cat > "$R/rooktest-<kort>.sh" <<'EOF'
  #!/bin/sh
  r=/home/janpeter/m6-runs/refiner-precisie-<datum>; map=rooktest-<kort>; m=$r/rooktest-<kort>-metingen.txt
  cd /home/janpeter/Development/max2-m6/llm-bench || exit 1
  { echo "## voor het gesprek"; grep -E '^(pswpin|pswpout) ' /proc/vmstat; grep MemAvailable /proc/meminfo; } >> "$m"
  PYTHONDONTWRITEBYTECODE=1 ./refiner/run.py --backend harness \
    --harness "node /home/janpeter/Development/agent-harness/dist/cli.js" --variant docs \
    --models <label> --cases D03 --seeds 1 --max-output-tokens 16384 --max-wall-seconds 3600 \
    --out "$r/$map" > "$r/$map.log" 2>&1
  echo "exit=$?" >> "$r/$map.log"
  { echo "## na het gesprek"; ollama ps; curl -s 127.0.0.1:11434/api/ps; echo
    grep -E '^(pswpin|pswpout) ' /proc/vmstat; grep MemAvailable /proc/meminfo; } >> "$m"
  EOF
  tmux new-session -d -s m6-rooktest-<kort> "sh $R/rooktest-<kort>.sh"
  sid=$(tmux display -p -t m6-rooktest-<kort> '#{pane_pid}') && echo "$sid" > "$R/rooktest-<kort>.sid"
  ```
  - `run.py` doet eerst de probe. Met docs draait het model alleen na `reliable`.
  - De grens van 3600 s per beurt is ruim voor een eerste gesprek van onbekende snelheid.
  - Na een afbreking draait het script opnieuw met `map=rooktest-<kort>-2`.
- [ ] **Wachten** tot de run is afgelopen: "Starten en wachten" uit de Vensterprocedure.
- [ ] **Venster sluiten:** Herstellen en de dienststand na, volgens de Vensterprocedure.
- [ ] **Kopie en controle op de Mac:**
  - `rsync -a max2:m6-runs/refiner-precisie-<datum>/ "$M/"`.
  - "Geldige run" met `<n>` 1.
  - In `~/Development/max2-m6/llm-bench`: `./refiner/score.py "$M/rooktest-<kort>" > "$M/rooktest-<kort>.score.txt"`, ter informatie.
  - De proberij heeft het oordeel `reliable`.
  - Het gesprek eindigt `final`, `no_final` of `error`; voor een snelheidsmeting zijn alle drie goed.
  - In de metingen staat na het gesprek alleen `<tag>` in `/api/ps`.
- [ ] **Snelheid, grens en duur**, naar `$M/rooktest-<kort>-snelheid.txt`. Dat bestand bestaat alleen op de Mac, dus een volgende `rsync` laat het staan:
  ```bash
  python3 - "$M/rooktest-<kort>/raw.jsonl" > "$M/rooktest-<kort>-snelheid.txt" <<'EOF'
  import json, math, sys
  rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8").read().split("\n") if line.strip()]
  turns = [r for r in rows if isinstance(r.get("turn"), int)]
  out = sum(r.get("output_tokens") or 0 for r in turns)
  wall = sum(r.get("wall_s") or 0 for r in turns)
  if out <= 0 or wall <= 0:
      sys.exit("snelheid niet te berekenen: de rooktest stopt")
  speed = out / wall
  conversation = sum(r.get("conversation_wall_s") or 0 for r in rows if r.get("turn") == "end")
  print(f"uitvoertokens={out} wall_s={wall:.1f} snelheid={speed:.2f} tok/s")
  print(f"W={math.ceil(16384 / speed * 1.5 / 60) * 60}")
  print(f"duur_s={max(60556 / speed, 15 * conversation):.0f}")
  EOF
  ```
  De geschatte duur is het grootste van twee getallen:
  - 60.556 uitvoertokens (gsq in M5, alle pogingen: 53.973 in de eerste en 6.583 in de tweede) gedeeld door de snelheid;
  - 15 keer de duur van het rooktestgesprek.
- [ ] **Melden aan JP:**
  - de Modelfile-vergelijking en het probe-oordeel;
  - de status van het gesprek;
  - grootte en verdeling uit `ollama ps`;
  - `MemAvailable` en de swaptellers;
  - de snelheid, `<W>` en de geschatte duur.

  JP kiest het venster voor Taak 3. Laadt het model niet, is de probe niet `reliable`, is de map ongeldig, of is de snelheid niet te berekenen? Dan beslist JP (spec §6).

### Taak 3: de run (op JP's go, in het venster dat JP koos)

**Files:**
- Op max2, in `$R`: `<run-map>.sh`, de run-map `<run-map>/` met zijn log en `<run-map>-api-ps-na.json`, en `dienststand-<run-map>-voor.txt` en `-na.txt`.
- Op de Mac, in `$M`: de kopie, plus `<run-map>/summary.csv` en `<run-map>.score.txt`.

`<run-map>` is `<kort>-docs`, of na een afbreking of een ongeldige run `<kort>-docs-2`, `-3`, enzovoort.

**Interfaces:**
- Consumes: `<W>` uit Taak 2; de worktree `~/Development/max2-m6` op max2; de Vensterprocedure.
- Produces: een geldige `<run-map>` met `summary.csv`, en `<run-map>.score.txt`, voor Taak 4.

- [ ] **Controle:**
  - De harness staat op `15c1e26` en is schoon.
  - `ollama --version` en de ID van `<tag>` in `ollama list` zijn gelijk aan de metingen van de rooktest.
  - Anders stoppen en JP.
- [ ] **Venster openen:** de dienststand vooraf, daarna Stoppen, volgens de Vensterprocedure.
- [ ] **De run**, in een script, op max2:
  ```bash
  cat > "$R/<run-map>.sh" <<'EOF'
  #!/bin/sh
  r=/home/janpeter/m6-runs/refiner-precisie-<datum>; map=<run-map>
  cd /home/janpeter/Development/max2-m6/llm-bench || exit 1
  PYTHONDONTWRITEBYTECODE=1 ./refiner/run.py --backend harness \
    --harness "node /home/janpeter/Development/agent-harness/dist/cli.js" --variant docs \
    --models <label> --seeds 1 2 3 --max-output-tokens 16384 --max-wall-seconds <W> \
    --out "$r/$map" > "$r/$map.log" 2>&1
  echo "exit=$?" >> "$r/$map.log"
  curl -s 127.0.0.1:11434/api/ps > "$r/$map-api-ps-na.json"
  EOF
  tmux new-session -d -s m6-<run-map> "sh $R/<run-map>.sh"
  sid=$(tmux display -p -t m6-<run-map> '#{pane_pid}') && echo "$sid" > "$R/<run-map>.sid"
  ```
  Volg de voortgang met `tail` op het log. Dreigt de run over het einde van het venster te lopen, volg dan "Afbreken" uit de Vensterprocedure.
- [ ] **Wachten** tot de run is afgelopen: "Starten en wachten" uit de Vensterprocedure.
- [ ] **Venster sluiten:** Herstellen en de dienststand na, volgens de Vensterprocedure.
- [ ] **Kopie en controle op de Mac:**
  - `rsync -a max2:m6-runs/refiner-precisie-<datum>/ "$M/"`.
  - "Geldige run" met `<n>` 15.
  - `$M/<run-map>-api-ps-na.json` toont alleen `<tag>`.
  - Is de map ongeldig, dan geen oordeel: melden aan JP en een nieuw venster voor `<kort>-docs-2`.
- [ ] **Scoren op de Mac:**
  - In `~/Development/max2-m6/llm-bench`: `./refiner/score.py "$M/<run-map>" > "$M/<run-map>.score.txt"`. Dat schrijft ook `$M/<run-map>/summary.csv`.
  - `./refiner/check_key.py --env OPENROUTER_API_KEY "$M"` geeft `with_key=0` en exit 0. Exit 2, of een lege variabele: stoppen en JP.

### Taak 4: het oordeel en het rapport

**Files:**
- Create of modify: `llm-bench/results/refiner-precisie-<datum>.md`
- Create of modify: `llm-bench/results/refiner-precisie-<datum>/`, de bestanden die M5 bewaarde
- Create of modify, alleen bij vlaggen: `llm-bench/results/refiner-precisie-<datum>/vlaggen-besluiten.json`

**Interfaces:**
- Consumes: `$M/<run-map>/` met `summary.csv` en `raw.jsonl`, `$M/<run-map>.score.txt` (Taak 3), en `$M/rooktest-<kort>-metingen.txt` (Taak 2).
- Produces: het oordeel door, gezakt of onbeslist. Dat bepaalt de volgende taak.

- [ ] **Vlaggen.** D5 geldt alleen voor D02, dus er zijn per model hooguit drie nieuwe vlaggen. JP beoordeelt elke D5-vlag op een reviewpagina, zoals in M5 (spec §2 #5):
  - Een privé artifact met de `db`-capability, dat alleen de eigenaar beschrijft.
  - Per vlag het transcript met de treffer gemarkeerd, het patroon, en knoppen voor bevestigen, verwerpen en twijfel.
  - Lees de besluiten uit met `ArtifactData list`, en leg ze vast in `vlaggen-besluiten.json` in de vorm van M5: `{"bron": …, "besluiten": [{"blind_id", "besluit", "check", "model", "variant", "case", "seed", "notitie", "bijgewerkt"}]}`.
  - Zonder vlaggen is er geen pagina en geen bestand.
- [ ] **Zeef met de besluiten.** Neem de zeef van `score.py` en laat verworpen vlaggen weg. Een bevestigde vlag laat het model zakken.
- [ ] **Grens per regel.** Schrijf voor afgerond en voor elke check die meetelt de teller en de noemer op, met de kleinste telling die slaagt (afgerond 90%, checks 80%, `meets()`). Markeer _op de grens_ en _één eronder_. Bij 15 gesprekken:
  - afgerond: 14 en 13;
  - een check over 15 gesprekken: 12 en 11;
  - D2, over 12 gesprekken: 10 en 9.
- [ ] **Timeout-tegenproef.** Alleen nodig als een gesprek na beide pogingen eindigde met een beurtrij met harness-status `timed_out` in `raw.jsonl`. Tel zulke gesprekken als afgerond, en als geslaagd op elke check die voor hun case geldt (`n.v.t.` en een bevestigde vlag blijven zoals ze zijn). Slaat de zeef dan om, dan is het oordeel onbeslist.
- [ ] **Oordeel:** door, gezakt of onbeslist, volgens Global Constraints.
- [ ] **De repo in.** Kopieer uit `$M` naar `$D` alleen wat M5 ook bewaarde.
  - Per geldige run-map en per rooktestmap:
    ```bash
    mkdir -p "$D/<map>" && cp "$M/<map>"/{raw.jsonl,summary.csv,blind-key.json} "$D/<map>/" && cp -R "$M/<map>/transcripts" "$D/<map>/"
    for p in "$M/<map>"/harness/probe-*; do mkdir -p "$D/<map>/harness/${p##*/}" && cp "$p/probe.json" "$D/<map>/harness/${p##*/}/"; done
    ```
  - Daarnaast de bestanden direct in `$M`: `*.sh`, `*.sid`, `*.log`, `*.txt` (metingen, snelheid, dienststand, score-uitvoer) en `*-api-ps-na.json`.
  - Afgebroken en ongeldige run-mappen gaan niet mee. Hun script, log en `.sid` staan wel direct in `$M` en gaan als bewijs mee; het rapport noemt die mappen met de reden.
- [ ] **Rapport** `llm-bench/results/refiner-precisie-<datum>.md`. Voor Q4 komen de rij en het oordeel erbij. Het rapport bevat:
  - de docs-tabel van `score.py`, naast de M5-rijen van `gsq-lokaal` en `qwen3.8-openrouter` (uit `refiner-vergelijking-2026-10-01.md`, tabel "Met docs");
  - de zeef met de besluiten over de vlaggen, de regels op of één onder de grens met teller en noemer, en het oordeel;
  - per niet-afgerond gesprek de status, met elke `timed_out` apart, en zo nodig de tegenproef;
  - snelheid, grootte, verdeling, swaptellers en de Modelfile-vergelijking (met elk afwijkend `PARAMETER`) uit de rooktest, ter informatie;
  - de conclusie volgens de tabel in spec §1, met de kandidaten als schatting voor een proef op een Mac;
  - per venster de dienststand vooraf en achteraf, en elke afgebroken of ongeldige map met de reden;
  - de commits: de max2-worktree (Taak 2) en de harness (`15c1e26`), plus `ollama --version`.
- [ ] Commit in `feat/m6-precisie`, met de unittest groen.
- [ ] **Volgende stap:**

  | Oordeel | Q8 | Q4 |
  |---|---|---|
  | Door | Taak 5 | Taak 7 |
  | Gezakt | Taak 7 | Taak 7 |
  | Onbeslist | JP kiest: Taak 6 of stoppen | JP kiest: Taak 6 of stoppen |

  Stoppen gaat verder als gezakt (spec §1).

### Taak 5: Q4 (alleen als Q8 door is; op JP's go, in eigen vensters)

- [ ] Taak 2, 3 en 4 met de Q4-rij uit de tabel in Global Constraints: label `qwen3.8-q4-lokaal`, tag `qwen3.8:27b-q4_K_M` (18 GB), kort `q4`. De download valt pas hier. Q4 krijgt een eigen rooktest, een eigen `<W>` en een eigen run-map `q4-docs`.
- [ ] Het rapport krijgt de conclusie voor de aankoop, volgens spec §1:
  - Q4 door: kandidaat Q4_K_M, een Mac van ongeveer 32–36 GB, krap bij 32 GB;
  - Q4 gezakt, of onbeslist en daarna gestopt: kandidaat Q8_0, ongeveer 48 GB.

  Daarna Taak 7.

### Taak 6: seeds 4–6 (alleen bij een onbeslist oordeel en op JP's keuze)

- [ ] **Venster en run**, zoals Taak 3, met `--seeds 4 5 6`, de run-map `<kort>-docs-s456` en dezelfde `<W>`.
  - Spec §4 zegt "dezelfde stappen 2–5". Een nieuwe rooktest (stap 3) levert hier niets op: model, host en instellingen zijn gelijk, dus `<W>` en de verdeling zijn bekend. De probe draait in `run.py` vanzelf mee.
  - De controle uit Taak 3 (harness, `ollama --version`, de ID van `<tag>`) laat zien dat de route gelijk bleef.
- [ ] Score de nieuwe map apart, naar `$M/<kort>-docs-s456.score.txt`. Nieuwe D5-vlaggen beoordeelt JP zoals in Taak 4.
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
- [ ] Het rapport krijgt beide score-uitvoeren, de opgetelde tellingen en het oordeel. De nieuwe map gaat de repo in zoals in Taak 4. Commit.

### Taak 7: afronden en de PR

- [ ] Loop de zes acceptatiecriteria uit spec §5 na, en zet per criterium het bewijs in het rapport.
- [ ] De unittest is groen, en in `~/Development/max2-m6/llm-bench` geeft `./refiner/check_key.py --env OPENROUTER_API_KEY "$M" "$D"` `with_key=0` en exit 0.
- [ ] Push `feat/m6-precisie` en open de PR op Forgejo via de API: `curl --config` met de header uit `$FORGEJO_TOKEN`, dus de token niet in argv. JP merget.
- [ ] Op max2: `git -C ~/Development/max2 worktree remove ~/Development/max2-m6`, zonder `--force`.
  - De worktree hoort schoon te zijn: de uitvoer staat in `~/m6-runs`, en `PYTHONDONTWRITEBYTECODE=1` voorkomt `__pycache__`.
  - Weigert git, dan JP.
- [ ] `~/m6-runs` op max2, `~/Development/m6-runs` op de Mac en de gedownloade modellen blijven staan. Ze verwijderen is aan JP.

## Buiten dit plan

Snelheid of geheugen op een Mac, een ander model voor de productieworker, de variant zonder docs, Q6_K, andere modellen, nieuwe checks en uitgaven bij OpenRouter (spec §1). De ceremonie voor dit plan volgt pas na JP's akkoord.

## Review record

### Ronde 1 (2026-10-01, rev 1 `5bb59c6` → rev 2)

- **Reviewers:** mac:codex (0 BLOCKER, 3 MAJOR, 0 MINOR; NO-GO) en mac:claude (0 BLOCKER, 0 MAJOR, 7 MINOR; GO). mac:claude las bij het versturen als "weg", maar claimde wel. Het deed één `git fetch -q origin` in agent-harness-m6; dat raakt alleen refs (`origin/main` bleef `15c1e26`).
- **Workerstop niet fail-closed** (codex MAJOR). `grep -c` was een uitvoerregel en geen voorwaarde, een mislukte eerste opname hield de stop niet tegen, en `systemctl is-active` eindigt niet met 0 bij `inactive`. → Aanvaard. De M4-procedure is nu een script in de Vensterprocedure dat bij de eerste fout stopt, met een aparte tak voor diffstatus 0, 1 en fout.
- **Afgebroken run kon toch gescoord worden** (codex MAJOR, claude MINOR 2). De stappen na een afbreking wezen nog naar `<kort>-docs`, en `exit≠0`, een stop-rij of een `invocation_error` had geen route. → Aanvaard. `<run-map>` met volgnummer, de controle "Geldige run" (één planrij, 15 paren met een eindrij, geen stop-rij, geen `invocation_error`), en "Afbreken": wachten tot de tmux-sessie en de benchprocessen weg zijn vóór het herstel. Ongeldige mappen gaan niet de repo in.
- **Sleutelcontrole zonder sleutel** (codex MAJOR). → Verworpen, met bewijs. De controle draait op de Mac, en daar staat `OPENROUTER_API_KEY` in `~/.zshenv` (nagegaan: gezet). `check_key.py` geeft alleen exit 2 als de variabele leeg is. Spec §5 criterium 6 vraagt de controle uitdrukkelijk ("de controle is goedkoop"). Wel toegevoegd: een lege variabele betekent stoppen en JP, nooit een andere waarde. Gaat met dit bewijs naar ronde 2.
- **Metingen na afloop vragen een venster van vijf minuten** (claude MINOR 1). → Aanvaard. Het script meet direct na het gesprek (`ollama ps`, `/api/ps`, swaptellers); de run legt `/api/ps` vast in `<run-map>-api-ps-na.json`.
- **Welke bestanden de repo in gaan** (claude MINOR 3). → Aanvaard. Volledige kopie buiten de repo (`M`); de repo krijgt per map alleen wat M5 bewaarde: `raw.jsonl`, `summary.csv`, `blind-key.json`, `transcripts/` en `harness/probe-*/probe.json`, plus logs, scripts, metingen en dienststand.
- **Unittest op max2 laat `__pycache__` achter** (claude MINOR 4). → Aanvaard: SCHRAP de unittest op max2. Het script zet `PYTHONDONTWRITEBYTECODE=1`, en `worktree remove` gaat zonder `--force`.
- **54.000 tokens waren alleen de eerste pogingen** (claude MINOR 5). → Aanvaard: 60.556 over alle pogingen (53.973 + 6.583, nagegaan in `baseline-docs/raw.jsonl`).
- **Modelfile-controle negeerde `PARAMETER`** (claude MINOR 6). → Aanvaard. `PARAMETER` gaat mee in de vergelijking en het rapport; alleen `RENDERER` en `PARSER` zijn een stop.
- **Kleinigheden** (claude MINOR 7). → (a) `mkdir` vooraan: aanvaard. (b) `no_final` is ook een goede rooktestuitkomst: aanvaard. (c) Een latere harness-commit toestaan: verworpen. De strenge pin blijft, want een valse stop kost één vraag aan JP. Daarnaast zijn `ollama --version` en de ID van de tag toegevoegd, als bewijs dat de route tussen vensters gelijk bleef (observatie claude).
- **Scope-delta:** geen bouw toegevoegd. De bestaande M4-procedure is uitvoerbaar gemaakt. De controle "Geldige run" en de scripts per venster komen erbij; de unittest op max2 is geschrapt. Het eerste resultaat en de rooktest blijven gelijk.

### Ronde 2 (2026-10-01, rev 2 `6a0fdac` → rev 3)

- **Reviewers:** mac:codex (0 BLOCKER, 2 MAJOR, 0 MINOR; NO-GO) en mac:claude (0 BLOCKER, 1 MAJOR, 2 MINOR; NO-GO). Beide bevestigden de fixes van ronde 1 en de twee verwerpingen: de sleutelcontrole (codex trekt zijn MAJOR in, want de variabele is op de Mac gezet) en de strenge harness-pin.
- **Bepalend, beide: de wachtstap in "Afbreken" matchte vreemde processen.** `pgrep -af 'refiner/run.py|…'` vond de zoekende shell zelf, en op max2 draait sinds 29 september een verweesde lus (`bash -c while pgrep -f refiner/run.py …`, pid 2608864, eigen sessie). De voorwaarde "niets gevonden" werd dus nooit waar, en het herstel bleef geblokkeerd. → Aanvaard. "Starten en wachten" legt direct na de start het sessie-ID van het tmux-paneel vast (`#{pane_pid}`, de sessieleider) en wacht op `pgrep -s "$sid"`. Dat raakt alleen de eigen processen. "Afbreken" is begrensd: twee minuten, dan `pkill -TERM -s`, en daarna JP. Nagegaan op max2: `pgrep -s` bestaat, en de verweesde lus heeft een eigen sessie. Die lus opruimen is aan JP.
- **Normaal einde zonder wachtstap** (codex MAJOR, claude MINOR 1). Taak 2 ging na de tmux-start direct naar het herstel. → Aanvaard. Taak 2 en 3 hebben nu een stap "Wachten" vóór "Venster sluiten".
- **Leesfout in de claimcontrole liet de stop door** (codex MAJOR). `grep` exit 2 viel in de tak "geen claim". → Aanvaard. Een `case` op de exitstatus: 0 is niet stoppen, 1 is door, de rest is niet stoppen en JP. Getest met een ontbrekend, een vrij en een geclaimd bestand.
- **Snelheidsregels op de Mac werden door de volgende `rsync` overschreven** (claude MINOR 2). → Aanvaard. Ze gaan naar `$M/rooktest-<kort>-snelheid.txt`, dat alleen op de Mac bestaat.
- **Observaties claude:**
  - "Geldige run" neemt nu de eindrij van de hoogste poging, en meldt een `error` in poging 1 zonder poging 2. Getest op de gsq-rijen van `baseline-docs`: heel is `geldig`; zonder de eindrij van poging 2 van D02/1 is het `ongeldig: D02/1: tweede poging ontbreekt`; met een stop-rij is het `ongeldig`.
  - Script, log en `.sid` van een afgebroken map gaan als bewijs mee.
- **Scope-delta:** niets nieuws. Bestaande stappen zijn gerepareerd (wachten, afbreken, de claimgate). Het eerste resultaat en de rooktest blijven gelijk. De trend: ronde 1 had 3 MAJOR en 7 MINOR, ronde 2 had 3 MAJOR (2 verschillend) en 2 MINOR, allemaal in de vensterprocedure die ronde 1 toevoegde.

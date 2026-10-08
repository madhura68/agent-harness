---
title: "IDEA_CHAT-worker op Ollama (max2): recept en praktijkbewijs"
status: active
last_updated: 2026-10-08
---

# IDEA_CHAT-worker op Ollama (max2)

Recept voor `harness worker` en het live bewijs van M2 ([spec](../specs/2026-09-26-idea-chat-local-llm-design.md), [plan](../plans/M2-idea-chat-local-llm.md)).

> **Sinds de cutover van M45-2e (2026-10-08) is deze dienst uitgeschakeld.** `agent-harness-worker.service` (identiteit `local_llm`, direct tegen Ollama) is `inactive` en `disabled`. Idee-chat en taken van Agent-harness lopen nu via `agent-harness.service`, runtime `HARNESS`, via LiteLLM, met een productkeuze in workers `/context` (idee-chat `gsq-lokaal`). De env-lijst `IDEA_CHAT_LOCAL_PRODUCT_IDS` is weg uit web, en `dispatch_job` weigert `required_capability`. Beheer van de nieuwe dienst: [harness-service-max2.md](harness-service-max2.md). Unit, `worker.json` en de `local_llm`-code verwijderen hoort bij increment 3. Dit document blijft als recept en bewijs van M2–M4.

Sinds M3 kan dezelfde worker ook `TASK_IMPLEMENTATION`-jobs met `required_capability: 'local_llm'` claimen (een `task`-blok in de config); zie [task-worker.md](task-worker.md) voor dat recept, de faalredenen en de volgorde-eis.

## Voorwaarden

1. **scrum4me-mcp met de `local_llm`-isolatie.** De worker draait zijn MCP-kindproces uit `~/Development/scrum4me-mcp-stable`. Die checkout moet de M2-MCP-wijziging bevatten (claimfilter + `chat.pending_user_message_ids`); zonder isolatie claimt een `['local_llm']`-worker via het generieke filter ook gewone jobs. Na de merge: `git -C ~/Development/scrum4me-mcp-stable pull --ff-only && npm --prefix ~/Development/scrum4me-mcp-stable ci`.
2. **Tunnel naar max2:** `ssh -N -L 127.0.0.1:11434:127.0.0.1:11434 max2`. Controleer vóór een proef met `curl -s http://127.0.0.1:11434/api/tags` of het model nog op max2 staat (qwen3-coder:30b was op 2026-09-27 verwijderd) en met `api/ps` welk model geladen is (`OLLAMA_MAX_LOADED_MODELS=1`: een ander model betekent een swap en een trage eerste beurt).
3. **Probe:** per configuratie van de worker-config een aanvaarde `runs/probe-<configuratie>/probe.json` (`harness probe --config <harness.json> --all --out runs --api-key-env <VAR>`). Een andere configuratie of een gewijzigd LiteLLM-bestand = eerst een nieuwe probe: de worker controleert de hash per job.
4. **Omgeving:** `SCRUM4ME_TOKEN`, `DATABASE_URL`, `DIRECT_URL` in de shell (dezelfde als de scrum4me-MCP van de Mac). Waarden nooit in config, trace of dit runbook.

## Productie: service op max2 (sinds 2026-09-27)

De worker draait als systemd-service op max2, naast Ollama: geen tunnel, altijd aan.

| Onderdeel | Waar |
|---|---|
| Unit | `/etc/systemd/system/agent-harness-worker.service` (`User=janpeter`, `Restart=always`, `RestartSec=30`, `KillSignal=SIGINT`, `KillMode=mixed` — stuurt SIGINT alleen naar het hoofdproces (niet naar de nog-lopende stdio-MCP-kind, die geen SIGINT-handler heeft) en pas ná diens exit stuurt systemd SIGKILL naar de rest van de control group, `TimeoutStopSec=180` — geeft het hoofdproces ruim baan om na SIGINT nog af te ronden (git/verify-stappen) vóórdat systemd alsnog SIGKILLt, na `ollama.service`) |
| Code | `~/Development/agent-harness` (gebouwd: `dist/cli.js`) en `~/Development/scrum4me-mcp-stable` (MCP-kindproces via `tsx`) |
| Config | `/etc/agent-harness/worker.json`: model `qwen3.8-gsq-rco:27b-iq3_s-text`, baseUrl `http://127.0.0.1:11434/v1`, thinking aan, `maxTurns 8`, `maxOutputTokens 4096`, `contextTokens 65536`, gelijk aan `OLLAMA_CONTEXT_LENGTH` in `/etc/systemd/system/ollama.service.d/override.conf` (zie [contextvenster](probe-and-run-max2.md#contextvenster-en-lange-beurten) en [meetproef](probe-and-run-max2.md#meetproef-contextvenster-2026-09-27)). Pas de twee altijd samen aan |
| Secrets | `/etc/agent-harness/worker.env` (root, 0600): `SCRUM4ME_TOKEN` = eigen token `agent-harness-local-llm-max2`; `DATABASE_URL`/`DIRECT_URL` = beperkte worker-rol uit `worker-idea.env` |
| Runs en probe | `/var/lib/agent-harness/runs/` (de aanvaarde probe van elke configuratie moet hier staan) |

Beheer:

```bash
sudo systemctl status agent-harness-worker
journalctl -u agent-harness-worker -f
sudo systemctl restart agent-harness-worker   # SIGINT: lopende job → failed "worker gestopt"
```

Bijwerken na een merge (op max2; `git` vraagt de Forgejo-PAT, er is geen credential helper):

```bash
cd ~/Development/agent-harness && git pull --ff-only && npm ci && npm run build
cd ~/Development/scrum4me-mcp-stable && git pull --ff-only && git submodule update --init && npm ci   # alleen bij MCP-wijzigingen
sudo systemctl restart agent-harness-worker
```

Ander model: een config in `/etc/agent-harness/worker.json` aanpassen en herstarten; de worker controleert per job de probe van die configuratie. Probe eerst met `node dist/cli.js probe --config <config.json> --configuration <naam> --out /var/lib/agent-harness/runs --api-key-env <VAR>` (niet met `--base-url`: dat schrijft een uitslag zonder hash, en de gate eist een aanvaarde `probe-<naam>/probe.json` van de huidige hash). Een job op een configuratie zonder aanvaarde probe van de huidige hash faalt met `CONFIGURATION_NOT_PROBED`; de worker zelf start wel. Voor de nieuwe dienst staat dit in [harness-service-max2.md](harness-service-max2.md).

Bewijs: job `cmujtwnbj001qvz7rn2ytmgct` (IDEA-224, 2026-09-27 13:02) DONE in 12 s door de service (token `agent-harness-local-llm-max2`, `model_id qwen3.8-gsq-rco:27b-iq3_s-text`); beantwoordde beide openstaande berichten, ook dat van de eerder mislukte beurt.

Aandachtspunten: het token is (nog) niet op Agent-harness gescopet; de MCP logt `MaxListenersExceededWarning` door een listener-lek in `wait_for_job` (ISS-8 op scrum4me-mcp, onschadelijk).

## Run-logs in Worker Logs (M4)

Sinds M4 ([spec](../specs/2026-09-28-harness-run-logging-design.md)) schrijft de worker per geclaimde job ook een run-log in het bestaande Worker-Log-formaat (hetzelfde formaat als de Claude- en Codex-runners), zodat harness-runs naast die runs in Worker Logs en Worker Insights verschijnen. Dit is een aparte, afgeleide en geredigeerde weergave; `trace.jsonl` in `/var/lib/agent-harness/runs/` blijft de volledige bron op max2 en verandert hierdoor niet.

**Config.** Optioneel blok in `/etc/agent-harness/worker.json`:

```json
"workerLog": { "dir": "/srv/scrum4me/worker-logs", "pool": "harness", "instance": "max2" }
```

Zonder dit blok werkt de worker precies zoals vóór M4: geen run-log, verder geen andere wijziging. `pool` en `instance` moeten voldoen aan `^[A-Za-z0-9._-]{1,64}$`; de config controleert dat bij het opstarten. `dir` moet schrijfbaar zijn voor de service-user (`janpeter` op max2); zonder schrijfrecht faalt `openRunLog` stil (spec §6.3) en logt de worker per job precies één regel `run-log uitgeschakeld voor job …`, zonder de jobuitkomst te raken.

**Waar de bestanden staan.** Eén bestand per geclaimde job: `<dir>/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log`, op max2 dus `/srv/scrum4me/worker-logs/harness/max2/runs/`. De bestandsnaam is het UTC-tijdstip direct ná de claim.

**Snel controleren.**
- Eerste twee regels (`head -2 <bestand>`): `claimed job_id=…` en `config job_id=… runtime=HARNESS kind=… model=… base_url=…`.
- Is een run klaar: `tail -4 <bestand>` toont het afsluitblok — een `harness.run_end`-JSON-regel, bij een fout een `ERROR <CODE>: <bericht>`-regel, `harness done job_id=… exit_code=… duration_ms=…`, en als laatste `exit code=<0|1>`. **Alleen die laatste regel telt als afgesloten**; een bestand zonder `exit code=` hoort bij een nog lopende job, bij een harde crash die geen afsluitblok meer kon schrijven, of bij een mislukte schrijfpoging van het afsluitblok zelf (bijvoorbeeld een volle schijf of een verwijderde map) — in geen van die gevallen verandert dat de jobuitkomst (spec §5.6).
- Alle jobstappen op een rij: `grep '\[harness\] step ' <bestand>`.

**Controle op geheimen (spec §10 criterium 4).** Geen enkele waarde die de redactie hoort te raken — elke omgevingsvariabele in `/etc/agent-harness/worker.env` waarvan de naam matcht op `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$|DSN|CREDENTIAL)/i`, en het wachtwoord uit elke URL-waarde (zoals in `DATABASE_URL` en `DIRECT_URL`) — hoort **onveranderd** in een run-log voor te komen; `***` op die plek wel.

`harness check-run-logs` doet deze controle geautomatiseerd, zonder ooit een waarde in argv, uitvoer of een log te zetten: hij leest de geheimen uit dezelfde vier bronnen als de redactie (`process.env`, de MCP-omgeving, `model.apiKey` en `model.baseUrl`), doorzoekt de run-logs recursief en drukt per geheim alleen de naam, het aantal treffers en of de waarde korter is dan 8 tekens af — nooit een waarde. Exitcode 1 bij minstens één treffer, en ook als er nul geheimen gecontroleerd zijn (dan draait hij waarschijnlijk zonder de service-omgeving). Draai het met de omgeving van de service, zodat er geen waarde in argv komt:

```bash
sudo systemd-run --wait --pipe --uid=janpeter -p EnvironmentFile=/etc/agent-harness/worker.env /usr/bin/node /home/janpeter/Development/agent-harness/dist/cli.js check-run-logs --config /etc/agent-harness/worker.json --dir /srv/scrum4me/worker-logs/harness
```

Een losse controle op alleen de namen (zonder een waarde te tonen): `sudo cut -s -d= -f1 /etc/agent-harness/worker.env` naast de lijst met redactiepatronen hierboven — elke naam die matcht hoort onder één van beide regels te vallen. De `-s` is verplicht: zonder die vlag drukt `cut -d= -f1` een regel zonder `=` in zijn geheel af, wat een waarde kan tonen; met `-s` wordt zo'n regel nooit afgedrukt. Deze controle zet nooit een waarde in argv, uitvoer of een log; alleen namen en tellingen.

**Terugdraaien.** Verwijder het `workerLog`-blok uit `/etc/agent-harness/worker.json` (of zet de backup terug) en herstart de service:

```bash
sudo systemctl restart agent-harness-worker
```

Bestaande run-logs blijven staan; er is geen opruimstap of bewaartermijn voor harness-run-logs (spec §11).

### Praktijkbewijs M4 (2026-09-29)

Opstelling:
- Harness op main `146e043` (#17), als `agent-harness-worker` op max2, met `workerLog` naar `/srv/scrum4me/worker-logs/harness/max2/runs/`.
- Ops-dashboard op max2 op `700c802` (Ops-dashboard#273), uitgerold via de ops-agent-flow `redeploy_ops_dashboard`.
- Model `qwen3.8-gsq-rco:27b-iq3_s-text`.

| Criterium | Proef | Uitkomst |
|---|---|---|
| 1 idee-chat in Worker Logs | Twee idee-chatjobs op IDEA-224 (Taak 8), daarna `redeploy_ops_dashboard` op max2. T0 is het `done`-event van die flow (exit 0): 17:35:08.743Z | De eerste ingest-tick na T0 liep van 17:40:04.4 tot 17:40:08.4Z, met `errors: []`. Er staan twee `WorkerRun`s: `harness/max2/20260929T152756Z` (job `cmumtyync0100um7rpui5i5cc`, 1 beurt, 34 943 ms) en `harness/max2/20260929T154253Z` (job `cmumui6z8010fum7r9u048fwq`, 5 beurten, 29 389 ms). Beide hebben pool `harness`, host `max2`, status success en een model. T1 − T0 is 296,2 s (rij in de DB) tot 299,7 s (einde van de ingest). JP bekeek workers.jp-visser.nl/worker-logs en ops2.jp-visser.nl/worker-logs en zag denk-tekst, antwoord, toolblokken en de meetregel per beurt ✔ |
| 2 taakjob | T-45 (ST-014) via `dispatch_job` met `required_capability: 'local_llm'`: job `cmun0mmuu000gue17ixshy7c4` | Run `harness/max2/20260929T183419Z`: 61 regels, 204 s, 12 beurten. Het run-log toont `worktree path=/var/lib/agent-harness/worktrees/cmun0mmuu000gue17ixshy7c4`. Prepare gaf exit 0. Gate 1 gaf exit 1 door de timing-flake in `__tests__/task-tools.test.ts:362`; gate 2 gaf exit 0. Er zijn drie `run_tests`-runs: rood (de nieuwe tests vóór de fix), groen, groen. De stappen zijn `commit sha=9cc0077…`, `plan_check aligned`, `job_status done pushed_at=ja` en `task_status review ok`. De run stond om 18:40:01Z in `WorkerRun`, met 82 events. Branch `feat/story-nh8zpbbz` → agent-harness#18. Tweede fixture: Ops-dashboard#275 ✔ |
| 3 triage | 2026-09-30. Chatbericht op IDEA-224 dat drie niet-bestaande kopjes van `plans/m4-harness-run-logging` opvraagt. Er is geen config gemanipuleerd: dit is de productieconfig. Daarna 1× `worker-insights-triage.service` met de hand gestart op scrum4me-srv | Job `cmunwn3e301tlum7rq6m0ed1x`, run `harness/max2/20260930T093027Z`, 26 s. Het model deed in één beurt 3× `get_product_doc`, en elke aanroep gaf `TOOL_ERROR`. Daarna volgde `ERROR TOO_MANY_TOOL_ERRORS: … 3 tool errors exceed maxToolErrors=2` en exit 1. De tick van 09:35:00Z nam de run op met status error en `error_summary` `TOO_MANY_TOOL_ERRORS: failed: TOO_MANY_TOOL_ERRORS 3 tool errors exceed maxToolErrors=2`. De triage-start (09:35:46–09:35:52Z) verwerkte 2 runs, 0 failed, voor $0,0073. Daarna had de run een `WorkerInsight`: source llm, `claude-haiku-4-5`, confidence 0,85. De root cause noemt de drie ontbrekende kopjes, de lever is `prompt_context`. De categorie `DEMO_FORBIDDEN` past niet; een eigen triage-indeling valt buiten M4 (plan: "Buiten dit plan"). T-44 telt niet mee: de MCP weigerde die job al bij de claim (zie de noot in [task-worker.md](task-worker.md)) en schreef geen run-log ✔ |
| 4 geheimen | `harness check-run-logs --dir /srv/scrum4me/worker-logs/harness` via `systemd-run` met `worker.env`, om 18:39Z, over 3 bestanden. Daarnaast de namencontrole `cut -s -d= -f1 worker.env` | 4 geheimen gecontroleerd: `SCRUM4ME_TOKEN`, het wachtwoord uit `DATABASE_URL`, het wachtwoord uit `DIRECT_URL` en `FORGEJO_PUSH_TOKEN`. Elk gaf 0 treffers; exit 0. De namencontrole gaf precies deze vier namen, en elke naam valt onder een redactieregel ✔ |
| 5 ingest vóór de parser-uitrol | Ingest-ticks tussen het eerste run-log (Taak 8) en de parser-uitrol | 15:30:06Z en 15:45:10Z gaven `errors: []`. De oude parser sloeg het harness-bestand over: zonder `[harness]`-match vond hij geen job-id ✔ |
| 6 Claude en Codex ongewijzigd | Parser-tests. Oude parser (`af63940`) tegen nieuwe (`700c802`) op alle echte run-logs op max2 sinds 2026-09-20. Nieuwe runs na T0 | De parser-tests zijn groen. Op 420 logs (227 codex, 193 idea) zijn samenvatting en events identiek. Codex-runs `20260929T173104Z`, `175911Z` en `180210Z` kwamen binnen met status success, job en model. Idea-run 2026-09-30: een chatbericht op IDEA-213 (Scrum4Me, niet gerouteerd) werd job `cmunwokc801toum7r6jmepv3h`, geclaimd door max2 `scrum4me-worker-idea-2`. Run `aadbb0778e8a/20260930T092807Z` kwam met de tick van 09:35:03Z binnen: success, job, model `claude-opus-5-5`, 59 events. `num_turns` is NULL, net als bij alle max2-idea-runs sinds 2026-09-27. Dat was al zo vóór de parserwijziging ✔ |

Opmerkingen bij de uitrol:
- **Marge criterium 1.** De grens van 300 s is gelijk aan de timerperiode, en T0 viel 8 s na de tick van 17:35. Dat is vrijwel het slechtste geval: de marge is dan alleen de ingestduur (±4 s).
- **Smoke-stap.** `smoke_ops_dashboard` gaf exit 56: curl kreeg 0,02 s na de recreate een connection reset, en `--retry-connrefused` herhaalt dat niet. De flow eindigt toch met exit 0, en de app draaide (root 307, database ready).
- **`/api/health` op max2.** Die geeft 503: de check eist ook een ops-agent op dezelfde commit en een mac-heartbeat, en deze flow werkt de ops-agent niet bij.

## Model-sleutel via `--api-key-env`

Staat het model achter een gateway die een sleutel vraagt (zoals LiteLLM met een master key), dan krijgt `harness worker` de **naam** van de omgevingsvariabele met die sleutel. De waarde komt nooit in argv of config:

```bash
# LITELLM_MASTER_KEY staat al in de omgeving van de shell, niet op deze regel
npm run dev -- worker --config <worker.json> --out runs --api-key-env LITELLM_MASTER_KEY
```

**Gedrag.** De waarde gaat mee als `Authorization: Bearer …`. Ze wint van een `model.apiKey` in de config, zoals bij `harness run`, en gaat alleen naar de model-client: de config die het run-log, het manifest en de trace zien, blijft zoals hij geladen is. Zonder de optie verandert er niets.

**Wat de worker weigert.** De optie wordt gelezen direct na het laden van de config, vóór het MCP-kindproces. Een gebruiksfout volgt (exit 78, voordat er iets start; de naam van de variabele in de melding, nooit de waarde) als:
- de variabele niet gezet of leeg is;
- de naam niet als geheim telt, bijvoorbeeld `LITELLM` (`LITELLM_MASTER_KEY` en `MODEL_API_KEY` wel): dezelfde namen als onder *Controle op geheimen* hierboven;
- de waarde korter is dan 8 tekens.

**Waarom die twee laatste regels.** De worker maskeert in een run-log de waarden die `process.env` onder een geheimachtige naam bevat, vanaf 8 tekens; `harness check-run-logs` kiest dezelfde geheimen. Staat de sleutel onder een andere naam, dan wordt hij niet gemaskeerd en ook niet gecontroleerd, dus een herhaling door het model of een tool komt ongemerkt in een run-log. Is hij korter, dan wordt hij niet gemaskeerd en geeft `check-run-logs` een treffer (`kort=true`). De controle roept daarom de functies van die redactie zelf aan en bewaart geen eigen patroon of minimumlengte.

**Stand.** Alleen met unittests gedekt (M45, increment 1); een live proef tegen LiteLLM ontbreekt nog.

## Lokaal draaien (Mac, ontwikkeling)

Vereist de tunnel en de omgeving uit de voorwaarden hierboven.

```bash
npm run dev -- worker --config examples/worker.json --out runs          # doorlopend
npm run dev -- worker --config examples/worker.json --out runs --once   # één claim of één lege wachtronde
```

`examples/worker.json` heeft sinds M4 een `workerLog`-blok dat naar `/srv/scrum4me/worker-logs` wijst (de padlocatie op max2). Die map bestaat lokaal op de Mac niet, dus print elke geclaimde job één regel `run-log uitgeschakeld voor job …` naar stderr; de job zelf loopt gewoon door (spec §6.3, geen andere wijziging). Verwijder het blok of wijs het naar een lokaal schrijfbare map om die regel te voorkomen.

Draai lokaal niet tegelijk met de service zonder reden: beide claimen dezelfde jobs.

Stoppen: Ctrl-C (lopende job → `failed` "worker gestopt"; een al voltooid antwoord wordt nog als `done` afgesloten). Een tweede Ctrl-C breekt direct af: een lopende job blijft dan op RUNNING tot de lease-reset (≤ 5 minuten) hem terugzet.

Vangnet: krijgt de worker toch een andere soort dan IDEA_CHAT, of een IDEA_CHAT-payload zonder `chat.pending_user_message_ids`, dan draait `scrum4me-mcp-stable` niet de M2-versie. De worker sluit die ene job af als `failed` en stopt met exit 1, zodat hij niet de hele queue leegtrekt. Werk dan eerst voorwaarde 1 bij.

## Uitzetten

1. Leeg `IDEA_CHAT_LOCAL_PRODUCT_IDS` in de env van de web-app en herstart die. Nieuwe chatbeurten gaan dan weer naar de gewone vloot.
2. Stop de service (`sudo systemctl disable --now agent-harness-worker`) pas nadat de `local_llm`-jobs op zijn. Jobs die al met `local_llm` op QUEUED/CLAIMED staan, worden niet omgerouteerd. Omdat een idee maar één actieve chatjob tegelijk heeft, blokkeert zo'n job verdere beurten in dat idee. Laat de worker draaien tot ze op zijn, of annuleer ze op het jobs-board.

## Bekende grens

De copilot-tool `send_idea_chat_message` (scrum4me-mcp) maakt IDEA_CHAT-jobs zonder `required_capability`. Een bericht via de copilot op een idee in een gerouteerd product gaat dus naar de gewone vloot, en een vervolgbeurt van zo'n job erft geen `local_llm`. Buiten M2; alleen berichten via de web-chat worden gerouteerd.

## Praktijkbewijs (2026-09-27)

Opstelling: scrum4me-mcp-stable op `16a527a` (bevat mcp#159), web op thuis.jp-visser.nl op `773381cb` (bevat Scrum4Me#263) met `IDEA_CHAT_LOCAL_PRODUCT_IDS=cmuhjw9e80003mt7rq4w3sauu`, harness op main `1b712e2`. Model: `qwen3.6:35b-a3b-coding` (qwen3-coder:30b stond niet meer op max2; JP koos dit model). Probe: 4/4 PASS, `tool_calling: reliable`, `usage_reported: true`. Testidee IDEA-224 in Agent-harness.

| Criterium | Proef | Uitkomst |
|---|---|---|
| 1 routering | Chat op IDEA-224 (Agent-harness) en op IDEA-213 (Scrum4Me) | IDEA-224 → jobs met `required_capability = local_llm`; IDEA-213 → job `cmujqitj6000qvz7r9mlimq9i` met `NULL` ✔ |
| 2 antwoord | Worker doorlopend, bericht "Welke product-docs zijn er voor dit product?" | Job `cmujq9cpv000dvz7roku6o622` DONE in 18 s, `model_id = qwen3.6:35b-a3b-coding`, tokens 3384/635 (provider_reported), 1 toolcall `list_product_docs` met de echte product-id; antwoord in het kanaal ✔ |
| 3 vervolgbeurt | Tweede bericht tijdens de eerste beurt | Vervolg-job `cmujq9r620002vz173lxqb9g8` (coalescing, erft `local_llm`), payload noemt alleen het tweede bericht onder "Te beantwoorden"; DONE in 17 s, tokens 1632/1259 ✔ |
| 4 isolatie | `--once`, `waitSeconds: 180`, terwijl gewone IDEA_CHAT-job `cmujqitj6…` (NULL-capability) op QUEUED stond | Exit 0, "0 job(s)": de lokale worker liet de gewone job liggen ✔ |
| 5 faalpad | Configkopie met `maxWallSeconds: 1`, `--once` | Job `cmujqfyml000mvz7r0scz1dli` FAILED met `timed_out: geen antwoord binnen maxWallSeconds=1`, niets op RUNNING, exit 1 ✔ |
| 6 secrets | Scan van `runs/` op het token en `postgres://` | 0 treffers ✔ |

Presence: tijdens de run staat er een `claude_workers`-rij met hostname van de Mac en capabilities `['local_llm']`, runtime CLAUDE.

Trace-fragment (job 1, ingekort):

```
run_start   job={jobId: cmujq9cpv000dvz7roku6o622, ideaId: cmujpsoo50003xj172ljoe1ts}
            prompt … "## Te beantwoorden\n[USER] Welke product-docs zijn er voor dit product?"
turn 1      usage 1338 in / 222 out → tool_call list_product_docs {"product_id":"cmuhjw9e80003mt7rq4w3sauu"}
turn 2      usage 2046 in / 413 out → eindantwoord
result.json status completed, reported qwen3.6:35b-a3b-coding, 18222 ms
```

Promptgrootte (spec §10): de grootste beurt was 2046 inputtokens, ruim binnen `OLLAMA_CONTEXT_LENGTH=32768`. Begrenzen van de geschiedenis is nog niet nodig.

Kwaliteit: het tweede antwoord stelt dat de docs "meestal onder `docs/`" in de repo staan zonder dat te controleren (geen toolcall). Zichtbaar zwakker dan Claude, zoals spec §10 verwacht.

Nevenbevinding: de CLAUDE-vloot op scrum4me-server en max2 draait een te oude Claude Code (2.1.197) voor het jobmodel; gewone jobs pendelen daardoor tussen CLAIMED en QUEUED (ISS-36). De web-uitrol liep daarom rechtstreeks via de ops-agent-flow `update_scrum4me_web` in plaats van via een DEPLOY-job. Raakt de lokale worker niet.

## Modelkeuze (2026-09-27, TEI uit)

Uitgangspunt: benchmark in `janpeter/max2` PR #13 (`llm-bench/results/`). Met TEI aan is `qwen3.6:35b-a3b-coding` (MoE) de enige snelle optie; met TEI uit past `qwen3.8-gsq-rco:27b-iq3_s-text` (dense, ~12 GB) volledig op de GPU. Beide halen de harness-probe (`reliable`, 4/4).

Vergelijking: de drie echte beurten van IDEA-224 opnieuw afgespeeld (zelfde prompt, zelfde doc-tools, alleen lezen), 2× per model per instelling. Bronnen: `runs/cmp-out/cmp-*` (thinking aan) en `runs/cmp-out/cmpn-*` (`reasoningEffort: none`), lokaal.

| | qwen3.6, thinking aan | GSQ-RCO, thinking aan | qwen3.6, thinking uit | GSQ-RCO, thinking uit |
|---|---|---|---|---|
| Voltooid | 4/6 (2× `budget_exceeded`: 2048 tokens verborgen thinking, lege content) | **6/6** | 6/6 | 6/6 |
| V1 "welke docs?" | juist (toolcall) | juist (toolcall) | **verzonnen**, geen toolcall | juist (toolcall) |
| V2 "staan ze in de repo?" | gok zonder toolcall | **2/2 juist**, 6–8 toolcalls, 33–39 s | **verzonnen** | 1/2 juist, 10–19 s |
| V3 "heb je de scrum4me-mcp?" | redelijk | precies (lezen ja, wijzigen nee) | kort, juist | juist |

Besluit: `examples/worker.json` gebruikt GSQ-RCO IQ3_S-text met thinking aan, `maxTurns: 8` (V2 gebruikte tot 5 beurten) en `maxOutputTokens: 4096` (thinking telt mee; V2 gebruikte tot 1693). `reasoningEffort: none` blijft beschikbaar, maar niet aanbevolen voor deze modellen. TEI blijft voorlopig uit; voor de embeddings wordt een andere oplossing gezocht. Gaat TEI toch weer aan op deze GPU, dan terug naar qwen3.6 (GSQ-RCO zakt naast TEI naar 13–22 tok/s) met thinking aan en ruimer uitvoerbudget, het contextvenster opnieuw meten (64k past dan waarschijnlijk niet meer), en vóór gebruik opnieuw proeven.

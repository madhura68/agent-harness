---
title: "agent-harness.service op max2 (HARNESS-runtime): indeling, installeren, bijwerken en terugzetten"
status: active
last_updated: 2026-10-08
---

# agent-harness.service op max2

Recept en beheer van de nieuwe harness-dienst (M45-2d): `agent-harness.service` naast LiteLLM, beheerd door één root-wrapper die ops-agent via `sudo -n` aanroept. Spec: `docs/superpowers/specs/2026-10-05-harness-runtime-design.md` in Scrum4Me (revisie 9); plan: `docs/plans/M45-2d-harness-docker-dienst.md` in Scrum4Me (dubbel GO in planronde 7).

**Stand na M45-3.** `agent-harness.service` is de enige harness-dienst op max2 (ingeschakeld in 2e, stap 8.5). De oude dienst, zijn unit, dev-checkout en worker-config zijn in M45-3 verwijderd; de historische recepten staan in [idea-chat-worker.md](idea-chat-worker.md) en [task-worker.md](task-worker.md). `~/Development/scrum4me-mcp-stable` is de MCP-checkout van deze dienst.

## Indeling

| Wat | Waar | Eigenaar en modus |
|---|---|---|
| Wrapper | `/usr/local/lib/agent-harness/ops/agent-harness-ops.sh` (uit `deploy/max2/ops/` in de repo) | `root:root 0755`, de map niet beschrijfbaar voor ops-agent of janpeter |
| Sudoers | `/etc/sudoers.d/agent-harness-ops` (uit `deploy/max2/ops/sudoers-agent-harness-ops`) | `root:root 0440`, alleen na `visudo -cf` |
| Releases | `/srv/agent-harness/releases/<commit>` met een marker `.built` na een volledige build | `janpeter` (de map `releases` ook), `0755` |
| `current` | `/srv/agent-harness/current`: symlink naar `releases/<commit>`, wijst altijd naar een gebouwde release | root; `/srv/agent-harness` is `root:root 0755` |
| `release.prev` | `/var/lib/agent-harness/release.prev`: de release waar `current` naar wees vóór de laatste `release-update` | één commit en een newline |
| `mcp.built` | `/var/lib/agent-harness/mcp.built`: de commit van de laatste geslaagde MCP-installatie in `~/Development/scrum4me-mcp-stable` (eerste gebruik: de `HEAD` waarop de dienst draait) | idem |
| `mcp.prev` | `/var/lib/agent-harness/mcp.prev`: de commit die `mcp.built` had vóór de laatste update naar een andere commit | idem |
| Units | `/etc/systemd/system/agent-harness.service`, `agent-harness-probe.service` (uit `current/deploy/max2/`), `litellm-ollama-bridge.service` (uit `current/deploy/max2/litellm/`) | `644` |
| Worker-config | `/etc/agent-harness/harness.json` | `root:root 0644` |
| LiteLLM-bestanden | `/etc/agent-harness/litellm/config.yaml` en `compose.yml` | `root:root 0644`, de map `0755` |
| Sleutels | `/etc/agent-harness/litellm.env` (LiteLLM: masterkey en providersleutels) en `harness-litellm.env` (de harness en de probe: alleen de masterkey) | `root:root 0600` |
| Runs en probe-uitslagen | `/var/lib/agent-harness/runs/` (`probe-<configuratie>/probe.json`) | `janpeter` |

De releasemappen vallen buiten `compose-collision-check`: die zoekt met `find /srv -maxdepth 6`, en de `compose.yml` in een release ligt op diepte 7 (`agent-harness`/`releases`/`<commit>`/`deploy`/`max2`/`litellm`/`compose.yml`). Een andere indeling moet dat opnieuw nagaan. Oude releases ruimt de beheerder met de hand op, naar de prullenbak; dat automatiseert 2d niet.

## De wrapper en zijn acties

`sudo -n /usr/local/lib/agent-harness/ops/agent-harness-ops.sh <actie>`; elke andere invoer, of een extra argument, geeft exit 64. ops-agent kent elke actie als een commando `harness_<actie>` of `litellm_<actie>` (commands.yml in scrum4me-docker: `harness_status`, `harness_install`, `harness_stop`, `harness_start`, `harness_probe`, `harness_release_update`, `harness_release_rollback`, `harness_mcp_update`, `harness_mcp_rollback`, `litellm_up`, `litellm_upgrade`). `provider-key <NAAM>` staat in geen sudoers-regel: alleen JP draait hem, aan een terminal.

| Actie | Doet | Vereist stilstand |
|---|---|---|
| `status` | alleen lezen, zonder lock: de commits van `current`, `release.prev`, mcp-stable (`HEAD`), `mcp.built`, `mcp.prev` en `origin/main` van scrum4me-mcp (`git ls-remote`, als `janpeter`), de stand van de units, de LiteLLM-container met zijn image-digest, de modelnamen en per configuratie de opgeslagen probe-uitslag (`accepted`, `hash`, tijd) uit `probe.json`. Geen hashberekening (die doet de gate per job) en geen geheimen. Exit altijd 0: een onderdeel dat niet te lezen is, staat als `(…)` in de uitvoer | nee |
| `install` | eerste inrichting, idempotent: mappen, de release van `origin/main` bouwen en `current` wisselen, units installeren, `harness.json`, `config.yaml` en `compose.yml` plaatsen (alleen als ze ontbreken), de brug-unit plaatsen, de masterkey maken | `agent-harness.service` |
| `stop` | `systemctl stop agent-harness.service`; zonder lock, zodat `stop-check.sh` altijd kan stoppen | nee |
| `start` | `systemctl start agent-harness.service`; weigert (66) zonder unit, `harness.json` of `current` | nee |
| `probe` | `systemctl start agent-harness-probe.service` (blokkeert); exit 0 alleen als de probe slaagt, anders de exitcode van `systemctl` | nee |
| `release-update` | de release van `origin/main` bouwen, `release.prev` schrijven, `current` wisselen, units installeren | `agent-harness.service` |
| `release-rollback` | `current` naar `release.prev`, zonder build; `release.prev` verandert niet | `agent-harness.service` |
| `mcp-update` | in mcp-stable: `git fetch`, `merge --ff-only` naar `origin/main`, submodule, `npm ci`, `npm run prisma:generate` en een schone `git status --porcelain`; drukt `oud → nieuw` af | beide diensten |
| `mcp-rollback` | `git reset --hard` naar `mcp.prev` en dezelfde installatie; nooit een `fetch`, `merge` of `pull` | beide diensten |
| `litellm-up` | `docker compose -p litellm -f /etc/agent-harness/litellm/compose.yml up -d`, dan `systemctl enable --now litellm-ollama-bridge.service` (de geïnstalleerde unit, geen kopie), wachten op `/health/liveliness`, de modelnamen afdrukken | nee |
| `litellm-upgrade` | uit `current`: `harness.json`, `config.yaml`, `compose.yml` en de brug-unit kopiëren (0644, de vorige als `<bestand>.bak-<tijdstip>`; eerst worden alle bronnen gecontroleerd), `daemon-reload`, de brug herstarten, `pull` en `up -d --force-recreate`, wachten op liveliness, de modelnamen afdrukken | `agent-harness.service` |

"Stilstand" betekent: `systemctl is-active <unit>` geeft `inactive` of `failed`. Elke andere uitkomst, ook `activating` in de herstartpauze na exit 1, telt als actief en geeft exit 75.

`harness.json` en `config.yaml` dragen dezelfde configuratienamen (spec §4.1), dus `litellm-upgrade` vervangt ze samen. `--force-recreate` is nodig omdat `config.yaml` alleen een bind-mount is: een gewone `up -d` laat bij een gewijzigde config de oude container met de oude config draaien, en de probe zou die onder de hash van het nieuwe bestand aanvaarden.

De modelnamen komen uit `/v1/models`. De wrapper leest de masterkey als root uit `harness-litellm.env` en geeft hem via `curl --config -` op stdin door: de sleutel staat in geen argv, wordt nergens afgedrukt, en alleen `.data[].id` (met een veilig patroon) verlaat het antwoord.

**Exitcodes.** 0 goed; 1 de mcp-stable-checkout is niet schoon na de MCP-installatie; 64 onbekende actie, extra argument of onbruikbare waarde; 66 een map of bronbestand ontbreekt, een bron is een symlink, ligt buiten de release of is geen gewoon bestand, een release is niet gebouwd, of de masterkey ontbreekt; 73 een bestand, de lock of een tijdelijk bestand kon niet worden gemaakt of geschreven; 74 een release kon niet worden gebouwd, gewisseld of opgezocht, een git- of npm-stap in mcp-stable faalde, of een docker-, systemctl- of curl-stap van de LiteLLM-acties faalde (LiteLLM niet gezond ook); 75 bezet (een andere actie houdt de lock), geen stilstand, of een voorwaarde klopt niet (geen `release.prev` of `mcp.prev`, een vuile mcp-stable-checkout voor een update, een statusbestand dat geen volledige commit is).

**Eén actie tegelijk.** Elke actie behalve `status` en `stop` neemt eerst een exclusieve `flock -n` op `/run/lock/agent-harness-ops.lock`; is die bezet, dan exit 75, ook voor `start` en `probe`. Een stop tijdens een vergrendelde actie raakt die actie niet: de acties die de release of de MCP wijzigen, eisen al stilstand.

## Lange acties losgekoppeld aanroepen

ops-agent kent geen tijdslimiet per commando, maar een los commando (`/agent/v1/exec`) stopt zodra de aanvraag sluit; een flow loopt door. `harness_install`, `harness_probe`, `harness_release_update`, `harness_mcp_update`, `litellm_upgrade` en de flows duren minuten (bouwen, `npm ci`, probestappen). Roep ze daarom losgekoppeld aan, zoals in 2a–2c: de aanvraag met `nohup` op de achtergrond, de Bearer uit `sudo -n cat /etc/ops-agent/secret` via `curl --config -` (nooit in argv of uitvoer), de uitvoer naar een logbestand en de exitcode van `curl` naar een rc-bestand (`echo $? > …`). Wacht op het rc-bestand en lees daarna het log. Start dezelfde actie niet opnieuw zolang de eerste nog loopt: de lock geeft dan 75, maar controleer eerst het rc-bestand.

De volgorde bij elke wijziging aan de dienst is: **eerst `stop-check.sh`, dan een flow of actie**.

## Eerst stoppen: `stop-check.sh`

`deploy/max2/ops/stop-check.sh` draait op de beheerdersmachine (de Mac, bash 3.2 of 5; ssh-aliassen `scrum4me-srv` en `max2`). Het is het M4-recept ([M4-plan](../plans/M4-harness-run-logging.md), stappen 1–2) als script dat bij de eerste fout stopt, met het predicaat `runtime = 'HARNESS'`:

1. Opname "voor" op srv, read-only (`BEGIN READ ONLY; SET LOCAL ROLE ops_readonly; …; ROLLBACK`) van `id, kind, status, retry_count`. Nooit de kolom `error`. Een opname telt alleen als `psql` met exit 0 eindigt: eerst een tussenbestand, daarna hernoemen.
2. Staat er een rij in `CLAIMED` of `RUNNING`, dan stopt het script met die rijen (exit 1) en is er niets gestopt.
3. `ssh max2 sudo -n …/agent-harness-ops.sh stop`, dan moet `systemctl is-active agent-harness.service` `inactive` of `failed` geven (`failed` telt als gestopt, `activating` niet).
4. Opname "na".
5. Geen verschil: exit 0, "veilig om bij te werken". Een verschil (een job die sinds "voor" is geclaimd, afgesloten, teruggezet of nieuw gedispatcht): exit 1, de dienst blijft gestopt en de ids gaan naar JP.

Een mislukt commando is nooit een schone uitkomst. Het script drukt geen database-URL of geheim af: alleen jobregels.

## Installeren (eenmalig, op JP's go)

Voorwaarden:

- **Janpeters git-referenties op max2 werken zonder prompt.** `install` en `release-update` clonen agent-harness als `janpeter` over https. De wrapper zet `GIT_TERMINAL_PROMPT=0`: ontbreekt de referentie (of vraagt git om een wachtwoord), dan faalt de actie meteen met exit 74 in plaats van te blijven hangen. Controleer dat vooraf als `janpeter`, met `git ls-remote https://git.jp-visser.nl/janpeter/agent-harness.git refs/heads/main`.
- **mcp-stable kent `HARNESS`.** Start de nieuwe dienst nooit tegen een MCP die `HARNESS` niet kent: het MCP-kindproces faalt dan bij zijn start (`UNKNOWN_AGENT_RUNTIME`), de harness stopt met exit 1 en systemd herstart hem elke 30 s. `~/Development/scrum4me-mcp-stable` op max2 wordt bijgewerkt in 2e, stap 8.1, vóór de start (zie hieronder).
- Plantaak 10 (de vaste workers) is af en er staan nul `HARNESS`-rijen.

Stappen (plantaak 11):

1. Als root op max2: de wrapper en het sudoers-bestand uit een checkout van de gemergde release installeren: `install -o root -g root -m 0755 deploy/max2/ops/agent-harness-ops.sh /usr/local/lib/agent-harness/ops/agent-harness-ops.sh`, en het sudoers-bestand als `/etc/sudoers.d/agent-harness-ops` met `0440`, alleen nadat `visudo -cf` het accepteert.
2. De live ops-agent-bewerking: precies de wijzigingen uit de baseline in scrum4me-docker toevoegen (nieuwe sleutels, flows en de drie unitnamen in de allowlists), dan `systemctl restart ops-agent`. De baseline blijft gelijk aan de live bestanden (de dubbele bewerking van `ops-agent-host-config-discipline.md`).
3. `harness_install`, losgekoppeld. `current` wijst daarna naar de gebouwde release, de units staan er maar zijn uitgeschakeld, en de bestanden en sleutels zijn aangemaakt met de modi uit de tabel hierboven. De masterkey ontstaat op max2 (`sk-` plus 48 hex-tekens) en komt identiek in beide env-bestanden; hij wordt nergens afgedrukt.
4. **JP:** `sudo /usr/local/lib/agent-harness/ops/agent-harness-ops.sh provider-key OPENROUTER_API_KEY` aan een terminal (de waarde komt van stdin, zonder echo). Alleen JP plaatst providersleutels. De wrapper weigert een waarde met een teken dat compose in een env-bestand anders leest.
5. `litellm_up`: de container wordt `healthy`, alleen op `127.0.0.1:4000`, de brug is actief en ingeschakeld, en de afgedrukte modelnamen zijn precies `gsq-lokaal` en `qwen3.8-or`.
6. `harness_probe`, losgekoppeld: beide configuraties aanvaard, elk met een hash. De gsq-probe deelt Ollama met de dienst: lees eerst read-only de query van `stop-check.sh` stap 1 (zonder iets te stoppen); staat er een `HARNESS`-job op `CLAIMED` of `RUNNING`, wacht dan.
7. `harness_status`.

Terugzetten van de installatie: `docker compose -p litellm -f /etc/agent-harness/litellm/compose.yml down`, `systemctl disable --now litellm-ollama-bridge`, het sudoers-bestand naar een back-upmap verplaatsen en de ops-agent-sleutels weghalen (live en baseline). De releases mogen blijven.

## Bijwerken en terugzetten

1. `stop-check.sh` (exit 0 is de voorwaarde).
2. Voor 2e, stap 8.5: alleen de losse commando's, losgekoppeld: `harness_release_update`, `harness_release_rollback`, `litellm_upgrade`, `harness_probe` en `harness_status`. Nooit `harness_start`: er is vóór 2e geen HARNESS-rij (Globale beperking 1), en tegen de huidige mcp-stable geeft een start een herstartlus met `UNKNOWN_AGENT_RUNTIME`. De flows `update_agent_harness` (`harness_release_update` → `harness_probe` → `harness_start`), `rollback_agent_harness` (`harness_release_rollback` → `harness_probe` → `harness_start`) en `upgrade_litellm` (`litellm_upgrade` → `harness_probe` → `harness_start`) eindigen alle drie met `harness_start` en zijn dus alleen voor ná 2e stap 8.5. Daarna: dezelfde flows, losgekoppeld; de eerste stap van elke flow weigert zelf zonder stilstand (exit 75).
3. `harness_status`: `current` is de verwachte commit, beide configuraties zijn `accepted=true` met een verse hash en de unit is `active`.

Een terugzetting wisselt `current` naar `release.prev` zonder build. Weer vooruit gaat met `release-update`. Een mislukte build raakt `current` en `release.prev` niet; een onvolledige `releases/<commit>` gaat vóór het bouwen weg.

**Na een onderbroken actie** (afgebroken aanvraag, herstart van max2): `harness_status`, dan dezelfde actie opnieuw. Elke release- en MCP-actie is zo geschreven dat een herhaling het werk afmaakt (een terugzetting kiest weer `release.prev`).

**Niet starten terwijl een probe loopt.** De probe draait losgekoppeld (een probe-unit loopt door ook als de aanvraag sluit). `release-update`, `release-rollback` en `litellm-upgrade` weigeren daarom ook (exit 75) zolang `agent-harness-probe.service` niet stilstaat; controleer met `harness_status` (de regel `unit agent-harness-probe.service`) en wacht tot de probe klaar is. Anders valideert de probe de oude bestanden of een half bijgewerkte release.

## De MCP bijwerken (2e, stap 8.1, en daarna)

Voor mcp-stable gaat het in deze volgorde, nadat `stop-check.sh` is geslaagd (`agent-harness.service` moet stilstaan):

1. De doelcommit lezen: `origin/main` van scrum4me-mcp (`harness_status`, de regel `mcp origin/main`, of `git ls-remote`).
2. Voorcontrole 2 van plantaak 10 voor die commit: elke migratie die hij verwacht staat als `finished` in `_prisma_migrations` (read-only). De wrapper kan de database niet lezen.
3. `harness_mcp_update`, losgekoppeld. `mcp-update` haalt `origin/main` van dát moment op.
4. `mcp.built` (uit `harness_status`, of de regel `oud → nieuw`) vergelijken met de gecontroleerde commit. Gelijk: door. Anders blijft de dienst gestopt en volgt voorcontrole 2 voor de werkelijke commit; faalt die, dan wachten tot de migratie is uitgerold, of `harness_mcp_rollback`.

**Herstel na een onderbroken `mcp-update`:**

- Valt de actie na de merge uit en doet het doel een submodule-bump, dan staat de checkout vuil (de submodule wijst een andere commit aan). Een herhaalde `harness_mcp_update` geeft dan 75. Gebruik eerst `harness_mcp_rollback` (de reset herstelt de checkout) en daarna opnieuw `harness_mcp_update`.
- Een beschadigd `mcp.built` zonder `mcp.prev` (een symlink, FIFO, te groot bestand of geen volledige commit) geeft 75. Controleer eerst de `HEAD` van de checkout (`harness_status`), verwijder het bestand dan met de hand (naar de prullenbak) en draai `harness_mcp_update` opnieuw: het eerste gebruik schrijft `mcp.built` weer vanuit `HEAD`.
- Een `mcp-rollback` zonder `mcp.prev` geeft 75: er is dan niets om naar terug te gaan.

## Probe

`harness_probe` start `agent-harness-probe.service` (`Type=oneshot`, `User=janpeter`, alleen `harness-litellm.env`): `harness probe --config /etc/agent-harness/harness.json --all --out /var/lib/agent-harness/runs --api-key-env LITELLM_MASTER_KEY --step-timeout 300`. Per configuratie komt er `runs/probe-<naam>/probe.json` met de hash, de uitslag (`accepted`) en de kosten per antwoord. `gsq-lokaal` meldt geen bedrag groter dan 0; bij `qwen3.8-or` heeft elk antwoord een bedrag. De worker rekent de hash per job opnieuw uit uit `harness.json`, `config.yaml` en `compose.yml`: een wijziging aan een van de drie vraagt dus eerst een nieuwe probe, anders faalt de job met `CONFIGURATION_NOT_PROBED` (de dienst zelf start wel). `harness_status` toont de opgeslagen uitslag zonder iets te berekenen. De probe is een lange actie: losgekoppeld aanroepen.

## LiteLLM

- Eerste start: `litellm_up`. Daarna draait de container met `restart: unless-stopped`, ook na een herstart van max2.
- Upgrade (nieuw image, nieuwe modellen of config): de nieuwe bestanden komen eerst in `current`, dus via een release van agent-harness. Volgorde, na `stop-check.sh`: het commando `harness_release_update` (de dienst blijft gestopt), dan (voor 2e, stap 8.5) het commando `litellm_upgrade` en daarna `harness_probe`; de flow `upgrade_litellm` eindigt met `harness_start` en is pas daarna bruikbaar. `litellm_upgrade` controleert alle bronnen in `current`, kopieert `harness.json`, `config.yaml`, `compose.yml` en de brug-unit naar `/etc` (de vorige als `<bestand>.bak-<tijdstip>`), herstart de brug, haalt het image op en maakt de container opnieuw. **Na een mislukte `litellm_upgrade`** (exit 74 in `pull` of `up`): draai `litellm_upgrade` opnieuw vóór elke probe; de oude container kan nog de oude config draaien terwijl de nieuwe bestanden al staan (en dus de nieuwe hash hebben). Alleen `install` en `litellm_upgrade` installeren deze bestanden; `release-update` doet dat niet. Draai `litellm_up` eerst op een host die LiteLLM nog nooit draaide: de herstart van de brug wacht op het netwerk `br-litellm`.
- De image-digest in `compose.yml` is vastgepind (LiteLLM houdt de providersleutels); eigen code (harness, MCP) wordt niet vastgepind.

## Sleutels

- De masterkey ontstaat bij `install` op max2 en staat in `litellm.env` en `harness-litellm.env` (0600). Hij staat in geen argv, log, uitvoer, PR of document.
- Providersleutels (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) plaatst alleen JP, met `provider-key <NAAM>` aan een terminal. Zet ze nooit via een flow of een argument.
- De sudoers-regels geven ops-agent precies de elf acties, elk met een vast argument en zonder jokerteken. Het bestand kent geen `SETENV` en geen `env_keep`, dus de overschrijfbare paden van de wrapper (`AH_*`, voor tests) blijven door sudo's omgevingsreset buiten bereik van een aanroeper.

## Stand na 2e

De cutover (Scrum4Me-plan `docs/plans/M45-2e-harness-cutover.md`, "Status 2e") is uitgevoerd op 2026-10-08, 22:27–22:53 CEST.

- **Diensten:**
  - `agent-harness.service` is `active` en `enabled`, op `current` = `b0152a4`.
  - De oude dienst was na 2e `inactive` en `disabled`; M45-3 heeft hem met zijn configuratie verwijderd (spec §7.3).
- **mcp-stable** staat op `eaac101` (`mcp.built`), met `mcp.prev` = `285c98a`.
  - Nooit `harness_mcp_rollback` naar `285c98a` of een andere commit zonder `HARNESS`: er bestaan nu `HARNESS`-rijen.
  - Terugzetten kan alleen naar een vastgelegde commit mét `HARNESS`.
- **Configuraties en keuzes:**
  - In de registry (workers `/settings/models`) staan `gsq-lokaal` en `qwen3.8-or` actief, gelijk aan `harness.json`.
  - Productkeuzes (workers `/context`) alleen op Agent-harness: idee-chat `gsq-lokaal` met plafond $0,05, taken `qwen3.8-or` met $0,50.
  - Een keuze op een ander product hoort pas bij een recept en een repo-root op max2.
- **Bewezen in de praktijk:**
  - De omgezette `local_llm`-job is door deze dienst beantwoord.
  - Een idee-chat via Ollama, en een taak via OpenRouter met push en groene verify.
  - Een plafond dat stopt (`COST_LIMIT_EXCEEDED`).
  - Een onbekende configuratie (`UNKNOWN_CONFIGURATION`).
  - `stop-check.sh` tijdens een lopende taak (exit 1), en daarna `stop-check.sh` (exit 0) plus de flow `update_agent_harness` (exit 0).
- **Bijwerken en terugzetten:** zoals hierboven, altijd eerst `stop-check.sh`.
- **Bekende punten:**

  | Issue | Onderwerp |
  |---|---|
  | Agent-harness ISS-2 | geen worktree-opruiming na een taak |
  | Agent-harness ISS-3 | `bench-workspace.test.ts` faalt in de verify-container |
  | Agent-harness ISS-4 | een mislukte taakjob laat de taak op IN_PROGRESS |
  | scrum4me-mcp ISS-13 | tokenscope niet afgedwongen bij de claim |
  | scrum4me-mcp ISS-14 | verify-gate ALIGNED bij een wijziging buiten het plan |

#!/bin/bash
# agent-harness-ops.sh: the root ops wrapper of the harness deployment on max2 (M45-2d).
#
# Installed as /usr/local/lib/agent-harness/ops/agent-harness-ops.sh (root:root 0755, not writable by ops-agent) and called as
#   sudo -n /usr/local/lib/agent-harness/ops/agent-harness-ops.sh <action>
# by ops-agent (sudoers: one line per action; only `provider-key` is interactive and is never called by ops-agent).
#
# Actions (exactly these; anything else, or an extra argument, is exit 64):
#   status | install | stop | start | probe | release-update | release-rollback | mcp-update | mcp-rollback
#   | litellm-up | litellm-upgrade | provider-key <NAME>
#
# Exit codes: 0 ok; 64 unknown action, extra argument, unknown NAME or unusable value; 66 a needed directory or source file is missing, a source file is a symlink, or a release is not built;
#   70 the action is not built yet; 73 a file could not be created; 74 a release could not be built, switched or looked up;
#   75 busy (another action holds the lock) or the worker
#   is not at a standstill.
#
# Rules this file keeps:
# - git and npm only through `runuser` as the checkout owner (owner_git, owner_npm); never git as root in a checkout. runuser
#   keeps root's environment, HOME=/root included, so every owner command runs through `env HOME=<owner's home>` (owner_run):
#   git and npm never read or write root's config or cache. owner_run also sets GIT_TERMINAL_PROMPT=0.
# - All paths are variables with fixed defaults (AH_ETC, AH_LITELLM_ENV, AH_LOCK, AH_OWNER, AH_OWNER_HOME, AH_SRV, AH_UNIT_DIR,
#   AH_REPO_URL, ...), and so is PATH: the script sets
#   a fixed PATH itself instead of relying on sudo's secure_path (AH_PATH replaces it). sudo's env_reset wipes the caller's
#   environment, so a caller cannot override any of these in production; the tests set them (and put stubs on AH_PATH).
# - Standstill (require_standstill) means `systemctl is-active <unit>` says `inactive` or `failed`. Every other answer
#   counts as running, `activating` (the restart pause after exit 1) included.
# - One action at a time: every action except `status` and `stop` first takes an exclusive `flock -n` on the lock file;
#   busy is exit 75. `stop` stays free because it changes no files and stop-check.sh must always be able to stop.
# - A secret never goes into argv, stdout, stderr or a log. `provider-key` reads it from stdin, and writes it with shell
#   builtins only.
#
# Releases (decision 15): every release is its own directory /srv/agent-harness/releases/<commit> (owner janpeter, marker file
# `.built` only after a complete build); /srv/agent-harness/current is a symlink (root) to the rolled-out release, so it always
# names a built release. build_release builds one as the owner, swap_current switches the link with node (rename(2) replaces the
# link without following it; `ln -s` and `mv` would follow an existing link to a directory, and `mv -T` is GNU only), and
# install_units installs both worker units from current (never enable or start). Part d (release-update, rollback) reuses them.
#
# Adding an action: write `action_<name with _>()` (it replaces the not_implemented line), use the helpers below
# (require_standstill, owner_git, owner_npm, make_temp_beside, publish_temp), and add its name to the case lists in `main` only if its
# arguments differ. Lock-free actions are the `status|stop` case in `main`; nothing else needs to change.

set -euo pipefail

PATH="${AH_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export PATH

AH_ETC="${AH_ETC:-/etc/agent-harness}"
AH_LITELLM_ENV="${AH_LITELLM_ENV:-$AH_ETC/litellm.env}"
AH_LOCK="${AH_LOCK:-/run/lock/agent-harness-ops.lock}"
AH_OWNER="${AH_OWNER:-janpeter}"
AH_OWNER_HOME="${AH_OWNER_HOME:-/home/janpeter}"
AH_SRV="${AH_SRV:-/srv/agent-harness}"
# `current` and `releases` stay directly under AH_SRV: swap_current works in AH_SRV with the relative link target releases/<commit>.
AH_RELEASES="$AH_SRV/releases"
AH_CURRENT="$AH_SRV/current"
AH_UNIT_DIR="${AH_UNIT_DIR:-/etc/systemd/system}"
AH_LITELLM_DIR="${AH_LITELLM_DIR:-$AH_ETC/litellm}"
AH_HARNESS_JSON="${AH_HARNESS_JSON:-$AH_ETC/harness.json}"
AH_HARNESS_ENV="${AH_HARNESS_ENV:-$AH_ETC/harness-litellm.env}"
AH_REPO_URL="${AH_REPO_URL:-https://git.jp-visser.nl/janpeter/agent-harness.git}"

UNIT_HARNESS="agent-harness.service"
UNIT_PROBE="agent-harness-probe.service"
UNIT_BRIDGE="litellm-ollama-bridge.service"
# Used by the release, mcp and litellm actions (parts d-e).
# shellcheck disable=SC2034
UNIT_WORKER="agent-harness-worker.service"

PROVIDER_KEY_NAMES="OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY"

# --- helpers --------------------------------------------------------------------------------------------------------

die() {
  local code=$1
  shift
  printf 'agent-harness-ops: %s\n' "$*" >&2
  exit "$code"
}

# Never echoes the input: an argument may be a secret someone pasted in the wrong place.
usage_fail() {
  die 64 "onbekende actie of ongeldige argumenten. Toegestaan: status install stop start probe release-update release-rollback mcp-update mcp-rollback litellm-up litellm-upgrade, en provider-key <${PROVIDER_KEY_NAMES// /|}>"
}

not_implemented() { # $1 = action, $2 = the plan part that builds it
  die 70 "$1: nog niet geïmplementeerd (deel $2)"
}

# A command as the checkout owner, never as root, with the owner's HOME (runuser keeps root's HOME=/root) and without a git
# prompt: a missing credential must fail (the caller exits 74), never wait for a terminal that is not there.
owner_run() { runuser -u "$AH_OWNER" -- env HOME="$AH_OWNER_HOME" GIT_TERMINAL_PROMPT=0 "$@"; }
owner_git() { owner_run git "$@"; }
owner_npm() { owner_run npm "$@"; }

# Exit 75 unless every given unit is `inactive` or `failed`.
require_standstill() {
  local unit state
  for unit in "$@"; do
    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    case "$state" in
      inactive | failed) ;;
      *) die 75 "$unit is niet gestopt (is-active: ${state:-leeg}); stop eerst de dienst" ;;
    esac
  done
}

# One action at a time: hold an exclusive lock on fd 9 until this process exits.
take_lock() {
  { exec 9>"$AH_LOCK"; } 2>/dev/null || die 73 "lockbestand $AH_LOCK is niet te openen"
  local rc=0
  flock -n 9 || rc=$?
  case $rc in
    0) ;;
    1) die 75 "een andere actie loopt al (lock $AH_LOCK)" ;;
    *) die 73 "lock kon niet worden genomen (rc=$rc)" ;;
  esac
}

# A file that a crash cannot leave half written: `make_temp_beside <target>` creates a temporary file in the target's own
# directory (mode 0600 under umask 077) and leaves its name in TEMP_FILE; the caller fills it and finishes with
# `publish_temp <target> <mode>` (chmod, then an atomic rename). The EXIT trap removes a temp file that was never published.
# Not called through $(...): the variables must survive in this shell.
TEMP_FILE=""
trap '[[ -z $TEMP_FILE ]] || rm -f -- "$TEMP_FILE"' EXIT

make_temp_beside() {
  TEMP_FILE=$(mktemp "$(dirname -- "$1")/.$(basename -- "$1").XXXXXX") || die 73 "tijdelijk bestand bij $1 aanmaken mislukt"
}

publish_temp() { # $1 = target, $2 = mode
  chmod "$2" "$TEMP_FILE"
  mv -f -- "$TEMP_FILE" "$1"
  TEMP_FILE=""
}

# --- releases and units (shared by install and, in part d, release-update and release-rollback) ---------------------------

# The only form a release name may take: a full commit id. It ends up in paths and in a node argument, so nothing else passes.
require_commit() { # $1 = commit
  [[ $1 =~ ^[0-9a-f]{40}$ ]] || die 64 "ongeldige commit: een release heet naar een volledige commit van 40 hexadecimale tekens"
}

# Build releases/<commit> as the owner. A release that has `.built` is left alone. Anything else at that path is an incomplete
# build of ours (for instance of an aborted request) and goes first. The marker comes only after clone, checkout, npm ci and
# npm run build all succeeded, so a failed or interrupted build never looks like a release and never touches `current`.
build_release() { # $1 = commit
  local commit=$1 release
  require_commit "$commit"
  release="$AH_RELEASES/$commit"
  if [[ -f $release/.built ]]; then
    printf 'release %s is al gebouwd\n' "$commit"
    return 0
  fi
  [[ -d $AH_RELEASES ]] || die 66 "map $AH_RELEASES ontbreekt (eerst install)"
  if [[ -e $release || -L $release ]]; then
    owner_run rm -rf -- "$release" || die 74 "onvolledige release $commit kon niet worden verwijderd"
  fi
  owner_git clone "$AH_REPO_URL" "$release" || die 74 "git clone voor release $commit mislukt"
  owner_git -C "$release" checkout --detach "$commit" || die 74 "git checkout van $commit mislukt"
  # npm has no -C: the subshell's cwd is the release, which the owner owns.
  (cd "$release" && owner_npm ci && owner_npm run build) || die 74 "npm ci of npm run build voor release $commit mislukt"
  owner_run touch "$release/.built" || die 74 "het bestand .built voor release $commit kon niet worden gemaakt"
  printf 'release %s gebouwd\n' "$commit"
}

# The node program of swap_current. Run in AH_SRV, so the relative link targets hold there. unlink removes a leftover
# current.new (of an interrupted switch) as the link itself; symlink + rename then replaces `current` atomically and
# without following it.
SWAP_JS='const fs = require("fs");
const commit = process.argv[1];
try { fs.unlinkSync("current.new"); } catch (e) { if (e.code !== "ENOENT") throw e; }
fs.symlinkSync("releases/" + commit, "current.new");
fs.renameSync("current.new", "current");'

# Point `current` at a built release. Not with `ln -s` and `mv`: with a leftover current.new, `ln -s releases/C current.new`
# makes a link inside releases/B and `mv` then rolls out B (measured).
swap_current() { # $1 = commit
  local commit=$1
  require_commit "$commit"
  [[ -f $AH_RELEASES/$commit/.built ]] || die 66 "release $commit is niet gebouwd; current blijft ongewijzigd"
  [[ ! -e $AH_CURRENT || -L $AH_CURRENT ]] || die 74 "$AH_CURRENT is geen symlink; current blijft ongewijzigd"
  (cd "$AH_SRV" && node -e "$SWAP_JS" "$commit") || die 74 "current wisselen naar release $commit mislukt"
  printf 'current wijst naar release %s\n' "$commit"
}

# A source that root copies out of a release the owner built must be a plain file: a symlink there could point at any file root
# can read (say litellm.env) and root would copy its content into a world-readable target.
require_plain_file() { # $1 = source
  [[ ! -L $1 ]] || die 66 "bronbestand $1 is een symlink; niet gekopieerd"
  [[ -f $1 ]] || die 66 "bronbestand $1 ontbreekt"
}

# Copy a file with a temp file beside the target and an atomic rename, so a crash leaves the old file or the new one.
install_file() { # $1 = source, $2 = target, $3 = mode
  require_plain_file "$1"
  make_temp_beside "$2"
  cat -- "$1" >"$TEMP_FILE"
  publish_temp "$2" "$3"
}

install_file_if_missing() { # $1 = source, $2 = target, $3 = mode
  if [[ -e $2 ]]; then
    printf '%s bestaat al; ongewijzigd\n' "$2"
  else
    install_file "$1" "$2" "$3"
    printf '%s geplaatst\n' "$2"
  fi
}

# The shared "units installeren" step: both worker units from current to the unit directory, then daemon-reload. Never enable,
# never start: starting is for 2e.
install_units() {
  local unit
  [[ -d $AH_CURRENT/deploy/max2 ]] || die 66 "$AH_CURRENT/deploy/max2 ontbreekt (eerst een release uitrollen)"
  for unit in "$UNIT_HARNESS" "$UNIT_PROBE"; do
    install_file "$AH_CURRENT/deploy/max2/$unit" "$AH_UNIT_DIR/$unit" 644
  done
  systemctl daemon-reload
  printf 'units %s en %s geïnstalleerd\n' "$UNIT_HARNESS" "$UNIT_PROBE"
}

# The bridge unit from current: placed when it is missing or differs (max2 still has the increment-1 unit, which says "never
# enabled"), with a back-up of the one it replaces. daemon-reload follows a replacement: systemd keeps the loaded increment-1
# definition (`failed`) until then, and `enable --now` in litellm-up would start that one.
install_bridge_unit() {
  local src="$AH_CURRENT/deploy/max2/litellm/$UNIT_BRIDGE" dst="$AH_UNIT_DIR/$UNIT_BRIDGE" backup
  require_plain_file "$src"
  if [[ -f $dst ]] && cmp -s -- "$src" "$dst"; then
    printf '%s is al actueel\n' "$dst"
    return 0
  fi
  if [[ -e $dst ]]; then
    backup="$dst.bak-$(date +%Y%m%d%H%M%S)"
    cp -p -- "$dst" "$backup" || die 73 "back-up van $dst maken mislukt"
    printf '%s bewaard als %s\n' "$dst" "$backup"
  fi
  install_file "$src" "$dst" 644
  systemctl daemon-reload
  printf '%s vervangen door die uit current\n' "$dst"
}

# --- the LiteLLM files and the master key -------------------------------------------------------------------------------

# Sets ENV_VALUE to the value of the first non-empty NAME=value line of an env file (empty when there is none). A secret never
# leaves a shell variable: not printed, not in argv.
ENV_VALUE=""
read_env_value() { # $1 = file, $2 = NAME
  local line
  ENV_VALUE=""
  [[ -f $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$2="?* ]]; then
      ENV_VALUE=${line#"$2="}
      return 0
    fi
  done <"$1"
}

# One source for the master key. litellm.env (read by LiteLLM) gets a new LITELLM_MASTER_KEY only when it has none: `sk-` plus
# `openssl rand -hex 24` (the shape of increment 1), through a temp file and rename, written with builtins. harness-litellm.env
# (read by the harness) gets the key from litellm.env when it is missing and never a new one, so both always hold the same key,
# also after an interrupted install. Both 0600 under umask 077, and existing ones are brought back to 0600.
ensure_master_key() {
  local key line old_umask
  old_umask=$(umask)
  umask 077
  read_env_value "$AH_LITELLM_ENV" LITELLM_MASTER_KEY
  if [[ -z $ENV_VALUE ]]; then
    key=$(openssl rand -hex 24) || die 73 "openssl rand mislukt; er is geen sleutel gemaakt"
    key="sk-$key"
    [[ $key =~ ^sk-[0-9a-f]{48}$ ]] || die 73 "openssl gaf geen geldige sleutel; er is niets geschreven"
    make_temp_beside "$AH_LITELLM_ENV"
    {
      if [[ -f $AH_LITELLM_ENV ]]; then
        while IFS= read -r line || [[ -n $line ]]; do
          [[ $line == "LITELLM_MASTER_KEY="* ]] || printf '%s\n' "$line"
        done <"$AH_LITELLM_ENV"
      fi
      printf 'LITELLM_MASTER_KEY=%s\n' "$key"
    } >"$TEMP_FILE"
    publish_temp "$AH_LITELLM_ENV" 600
    ENV_VALUE=$key
    key=""
    printf 'masterkey aangemaakt in %s\n' "$AH_LITELLM_ENV"
  else
    chmod 600 "$AH_LITELLM_ENV"
    printf 'masterkey bestaat al in %s; ongewijzigd\n' "$AH_LITELLM_ENV"
  fi
  if [[ -e $AH_HARNESS_ENV ]]; then
    chmod 600 "$AH_HARNESS_ENV"
    printf '%s bestaat al; ongewijzigd\n' "$AH_HARNESS_ENV"
  else
    make_temp_beside "$AH_HARNESS_ENV"
    printf 'LITELLM_MASTER_KEY=%s\n' "$ENV_VALUE" >"$TEMP_FILE"
    publish_temp "$AH_HARNESS_ENV" 600
    printf '%s aangemaakt met de sleutel uit %s\n' "$AH_HARNESS_ENV" "$AH_LITELLM_ENV"
  fi
  ENV_VALUE=""
  umask "$old_umask"
}

# --- actions --------------------------------------------------------------------------------------------------------

action_status() { not_implemented status e; }

# The first set-up, idempotent: directories, the first release from origin/main, the units, the LiteLLM files and the bridge
# unit, the master key. A second run changes nothing that exists: no git or npm call, and no file, key or release replaced
# (except a bridge unit that differs from the one in current).
action_install() {
  local out commit=""
  require_standstill "$UNIT_HARNESS"
  umask 022

  mkdir -p "$AH_SRV" "$AH_RELEASES" || die 73 "mappen onder $AH_SRV konden niet worden gemaakt"
  chmod 755 "$AH_SRV" "$AH_RELEASES"
  chown "$AH_OWNER" "$AH_RELEASES"
  if [[ -e $AH_CURRENT || -L $AH_CURRENT ]]; then
    printf 'release bestaat; bijwerken via release-update\n'
  else
    out=$(owner_git ls-remote "$AH_REPO_URL" refs/heads/main) || die 74 "git ls-remote van origin/main mislukt"
    read -r commit _ <<<"$out" || true
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || die 74 "git ls-remote gaf geen geldige commit voor origin/main"
    build_release "$commit"
    swap_current "$commit"
  fi
  install_units

  mkdir -p "$AH_ETC" "$AH_LITELLM_DIR" || die 73 "map $AH_LITELLM_DIR kon niet worden gemaakt"
  chmod 755 "$AH_LITELLM_DIR"
  install_file_if_missing "$AH_CURRENT/deploy/max2/harness.json" "$AH_HARNESS_JSON" 644
  install_file_if_missing "$AH_CURRENT/deploy/max2/litellm/config.yaml" "$AH_LITELLM_DIR/config.yaml" 644
  install_file_if_missing "$AH_CURRENT/deploy/max2/litellm/compose.yml" "$AH_LITELLM_DIR/compose.yml" 644
  install_bridge_unit

  ensure_master_key
}

action_stop() { not_implemented stop d; }
action_start() { not_implemented start d; }
action_probe() { not_implemented probe d; }
action_release_update() { not_implemented release-update d; }
action_release_rollback() { not_implemented release-rollback d; }
action_mcp_update() { not_implemented mcp-update d; }
action_mcp_rollback() { not_implemented mcp-rollback d; }
action_litellm_up() { not_implemented litellm-up e; }
action_litellm_upgrade() { not_implemented litellm-upgrade e; }

# provider-key <NAME>: the value comes from stdin without echo; the line NAME=value in litellm.env is replaced (the first
# one, later duplicates are dropped) or appended. Only shell builtins touch the value, so it is in no argv.
# Compose reads an env_file value with interpolation and quoting, so a value with $ ' " ` # a space, a tab or a backslash
# would silently reach LiteLLM as another key: such a value is refused (64), as is an empty one, a control character or more
# than one line. The message names the reason, never the value; nothing is written.
action_provider_key() {
  local name=$1 value="" extra="" line found=0 old_umask rc
  [[ -d $AH_ETC ]] || die 66 "map $AH_ETC ontbreekt (eerst install)"
  if [[ -e $AH_LITELLM_ENV && ! -r $AH_LITELLM_ENV ]]; then die 66 "$AH_LITELLM_ENV is niet leesbaar"; fi

  if [[ -t 0 ]]; then
    IFS= read -rsp "Waarde voor $name (blijft onzichtbaar): " value || true
    printf '\n' >&2
  else
    IFS= read -rs value || true
  fi
  [[ -n $value ]] || die 64 "geen waarde op stdin"
  # Data after the first line (a multi-line paste) is refused. -t keeps an interactive terminal from waiting; read returns 1 at
  # end of input and more than 128 on a timeout, so any other status is a failure of read itself and also refuses.
  rc=0
  IFS= read -rs -t 1 extra || rc=$?
  if ((rc == 0)) || [[ -n $extra ]] || ((rc != 1 && rc < 129)); then die 64 "meer dan één regel op stdin; er is niets geschreven"; fi
  [[ $value != *[[:cntrl:]]* ]] || die 64 "de waarde bevat een stuurteken; er is niets geschreven"
  case $value in
    *'$'* | *"'"* | *'"'* | *'`'* | *'#'* | *' '* | *\\*)
      die 64 "de waarde bevat een teken dat compose in een env_file anders leest (\$ ' \" \` # spatie of \\); er is niets geschreven"
      ;;
  esac

  old_umask=$(umask)
  umask 077
  make_temp_beside "$AH_LITELLM_ENV"
  {
    if [[ -f $AH_LITELLM_ENV ]]; then
      while IFS= read -r line || [[ -n $line ]]; do
        if [[ $line == "$name="* ]]; then
          if ((found == 0)); then
            printf '%s=%s\n' "$name" "$value"
            found=1
          fi
          continue
        fi
        printf '%s\n' "$line"
      done <"$AH_LITELLM_ENV"
    fi
    if ((found == 0)); then printf '%s=%s\n' "$name" "$value"; fi
  } >"$TEMP_FILE"
  publish_temp "$AH_LITELLM_ENV" 600
  umask "$old_umask"

  if ((found == 1)); then
    printf 'provider-key: %s vervangen in %s\n' "$name" "$AH_LITELLM_ENV"
  else
    printf 'provider-key: %s toegevoegd aan %s\n' "$name" "$AH_LITELLM_ENV"
  fi
}

# --- dispatcher -----------------------------------------------------------------------------------------------------

main() {
  local action=${1:-}
  case "$action" in
    status | install | stop | start | probe | release-update | release-rollback | mcp-update | mcp-rollback | litellm-up | litellm-upgrade)
      (($# == 1)) || usage_fail
      ;;
    provider-key)
      (($# == 2)) || usage_fail
      case "$2" in
        OPENROUTER_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY) ;;
        *) usage_fail ;;
      esac
      ;;
    *) usage_fail ;;
  esac

  case "$action" in
    status | stop) ;;
    *) take_lock ;;
  esac

  "action_${action//-/_}" "${@:2}"
}

# Run only when executed; sourcing (the tests) gets the helpers without the dispatcher.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

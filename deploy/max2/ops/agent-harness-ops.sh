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
# Exit codes: 0 ok; 64 unknown action, extra argument, unknown NAME or unusable value; 66 a needed directory is missing;
#   70 the action is not built yet; 73 a file could not be created; 75 busy (another action holds the lock) or the worker
#   is not at a standstill.
#
# Rules this file keeps:
# - git and npm only through `runuser` as the checkout owner (owner_git, owner_npm); never git as root in a checkout.
# - All paths are variables with fixed defaults (AH_ETC, AH_LITELLM_ENV, AH_LOCK, AH_OWNER), and so is PATH: the script sets
#   a fixed PATH itself instead of relying on sudo's secure_path (AH_PATH replaces it). sudo's env_reset wipes the caller's
#   environment, so a caller cannot override any of these in production; the tests set them (and put stubs on AH_PATH).
# - Standstill (require_standstill) means `systemctl is-active <unit>` says `inactive` or `failed`. Every other answer
#   counts as running, `activating` (the restart pause after exit 1) included.
# - One action at a time: every action except `status` and `stop` first takes an exclusive `flock -n` on the lock file;
#   busy is exit 75. `stop` stays free because it changes no files and stop-check.sh must always be able to stop.
# - A secret never goes into argv, stdout, stderr or a log. `provider-key` reads it from stdin, and writes it with shell
#   builtins only.
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

# Used by the install, release, mcp and litellm actions (parts c-e).
# shellcheck disable=SC2034
UNIT_HARNESS="agent-harness.service"
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

# git and npm as the checkout owner, never as root.
owner_git() { runuser -u "$AH_OWNER" -- git "$@"; }
owner_npm() { runuser -u "$AH_OWNER" -- npm "$@"; }

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

# --- actions --------------------------------------------------------------------------------------------------------

action_status() { not_implemented status e; }
action_install() { not_implemented install c; }
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

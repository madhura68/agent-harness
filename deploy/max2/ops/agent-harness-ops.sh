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
# Exit codes: 0 ok; 1 the mcp-stable checkout is not clean after the MCP install (git status --porcelain; no other failure ends in 1); 64 unknown action, extra argument,
#   unknown NAME or unusable value (a master key that curl --config could read as another option included); 66 a needed directory or source
#   file is missing, a source file is a symlink or lies outside the release or is no plain file of a sane size, a release is not built, or
#   the master key is missing; 73 the lock file, the lock or a file could not be created or written; 74 a release could not be built, switched
#   or looked up, a git/npm step of the MCP checkout failed, a docker/systemctl/curl step of the LiteLLM actions failed (LiteLLM not
#   healthy included), or a systemctl daemon-reload or a chmod/chown of install failed; 75 busy (another action holds the lock), the worker is not at a standstill (release-update, release-rollback and litellm-upgrade also need agent-harness-probe.service stopped), or a precondition of the action does not
#   hold (no release.prev or mcp.prev, a dirty mcp-stable checkout before an update, a state file that is not a full commit). `probe` returns
#   the exit code of `systemctl start agent-harness-probe.service`; `stop` that of `systemctl stop`; `status` always 0 (it only reports).
#
# Rules this file keeps:
# - git and npm only through `runuser` as the checkout owner (owner_git, owner_npm); never git as root in a checkout. runuser
#   keeps root's environment, HOME=/root included, so every owner command runs through `env HOME=<owner's home>` (owner_run):
#   git and npm never read or write root's config or cache. owner_run also sets GIT_TERMINAL_PROMPT=0.
# - All paths are variables with fixed defaults (AH_ETC, AH_LITELLM_ENV, AH_LOCK, AH_OWNER, AH_OWNER_HOME, AH_SRV, AH_STATE_DIR, AH_MCP_DIR,
#   AH_UNIT_DIR, AH_REPO_URL, ...), and so is PATH: the script sets
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
# install_units installs both worker units from current (never enable or start). release-update and release-rollback reuse them.
#
# State files in AH_STATE_DIR (/var/lib/agent-harness, writable by the owner), each one commit plus a newline. Root reads and writes them
# only through node on a file descriptor (O_NOFOLLOW/O_NONBLOCK read, O_EXCL temp file + rename write), never by a checked path:
#   release.prev  the release `current` pointed at before the last release-update (release-rollback never changes it)
#   mcp.built     the commit of the last successful MCP install in the mcp-stable checkout (first use: its HEAD)
#   mcp.prev      the commit mcp.built had before the last update to another commit (mcp-rollback never changes it)
# Every release/mcp action is written so that a repetition after success, and a rerun after an interruption between any two
# writes, ends in the outcome the plan states (see each action).
#
# Adding an action: write `action_<name with _>()`, use the helpers below (require_standstill, owner_git, owner_npm, make_temp_beside,
# publish_temp), and add its name to the case lists in `main`. Lock-free actions are the `status|stop` case in `main`.
#
# Release files (install, litellm-upgrade): root never reads a source by a checked path. The release is built by the owner, so any
# directory or file in it may be a symlink that a commit put there. release_read resolves the source in node and refuses unless the
# real path stays inside the real path of `current`, the last component is no symlink and the file is a plain file of at most 1 MiB,
# opened with O_NOFOLLOW|O_NONBLOCK and read from the descriptor.
#
# LiteLLM (litellm-up, litellm-upgrade, status): the master key is read as root from harness-litellm.env and reaches curl as a `header`
# line of a config on stdin (`curl --config -`), written by the printf builtin: never in an argv, never printed. Only the model names
# (`.data[].id`, held to a safe pattern) leave the response.

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
AH_STATE_DIR="${AH_STATE_DIR:-/var/lib/agent-harness}"
AH_RUNS_DIR="${AH_RUNS_DIR:-/var/lib/agent-harness/runs}"
AH_LITELLM_URL="${AH_LITELLM_URL:-http://127.0.0.1:4000}"
AH_HEALTH_TRIES="${AH_HEALTH_TRIES:-60}"
AH_HEALTH_SLEEP="${AH_HEALTH_SLEEP:-2}"
# `status` never hangs: every external call of it (git, docker, systemctl) gets this many seconds (see bounded).
AH_STATUS_TIMEOUT="${AH_STATUS_TIMEOUT:-20}"
AH_RELEASE_PREV="$AH_STATE_DIR/release.prev"
AH_MCP_BUILT="$AH_STATE_DIR/mcp.built"
AH_MCP_PREV="$AH_STATE_DIR/mcp.prev"
# The mcp-stable checkout of the old service (owner janpeter); only git fetch/merge/reset and the MCP install touch it (as the owner).
AH_MCP_DIR="${AH_MCP_DIR:-/home/janpeter/Development/scrum4me-mcp-stable}"

UNIT_HARNESS="agent-harness.service"
UNIT_PROBE="agent-harness-probe.service"
UNIT_BRIDGE="litellm-ollama-bridge.service"
# The old service: the mcp-* actions need it at a standstill too (its MCP checkout is the one they change).
UNIT_WORKER="agent-harness-worker.service"
LITELLM_PROJECT="litellm"
LITELLM_CONTAINER="litellm"

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

# A command as the checkout owner, never as root, with the owner's HOME (runuser keeps root's HOME=/root) and without a git
# prompt: a missing credential must fail (the caller exits 74), never wait for a terminal that is not there.
owner_run() { runuser -u "$AH_OWNER" -- env HOME="$AH_OWNER_HOME" GIT_TERMINAL_PROMPT=0 "$@"; }
owner_git() { owner_run git "$@"; }
owner_npm() { owner_run npm "$@"; }

# A command with a hard time limit, for `status` (which must never hang): the command runs in its own process group, and when
# AH_STATUS_TIMEOUT seconds pass the whole group is killed and the exit code is 124. Stdout is passed on; stdin and stderr are not
# (callers that want stderr redirect it themselves). Node is used because `timeout` is GNU only and is no part of macOS.
BOUNDED_JS='const { spawn } = require("child_process");
const secs = Number(process.argv[1]);
const c = spawn(process.argv[2], process.argv.slice(3), { detached: true, stdio: ["ignore", "pipe", "ignore"] });
const out = [];
c.stdout.on("data", (d) => out.push(d));
c.on("error", () => process.exit(127));
const t = setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch (e) {} process.exit(124); }, secs * 1000);
c.on("close", (code) => { clearTimeout(t); process.stdout.write(Buffer.concat(out)); process.exit(code === null ? 128 : code); });'
bounded() { node -e "$BOUNDED_JS" "$AH_STATUS_TIMEOUT" "$@"; }
owner_git_bounded() { bounded runuser -u "$AH_OWNER" -- env HOME="$AH_OWNER_HOME" GIT_TERMINAL_PROMPT=0 git "$@"; }

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
  # A failure here is 73 with a line, never a bare `set -e` exit 1 (1 means "checkout not clean"); the EXIT trap removes the temp file.
  chmod "$2" "$TEMP_FILE" || die 73 "rechten van het tijdelijke bestand voor $1 zetten mislukt"
  mv -f -- "$TEMP_FILE" "$1" || die 73 "tijdelijk bestand naar $1 verplaatsen mislukt"
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

# The node program of release_read: argv[1] is the release root (`current`), argv[2] the source. Exit codes: 2 missing, 3 the last
# component is a symlink, 4 the real path leaves the release (a directory on the way is a symlink), 5 no plain file of at most 1 MiB or
# not safely openable. The content goes to stdout in one write, after every check; the descriptor is compared with the path again after
# the open, which narrows a swap in between (the owner could still win a race on a path inside the release; that needs a swap on the
# very microsecond, and the owner is in group sudo on max2 anyway: this guards against what a commit can contain).
READ_RELEASE_JS='const fs = require("fs"), path = require("path");
const root = process.argv[1], file = process.argv[2];
let rootReal, dirReal, real;
try {
  rootReal = fs.realpathSync(root);
  dirReal = fs.realpathSync(path.dirname(file));
  real = fs.realpathSync(file);
} catch (e) { process.exit(e.code === "ENOENT" || e.code === "ENOTDIR" ? 2 : 5); }
if (real !== path.join(dirReal, path.basename(file))) process.exit(3);
if (real !== rootReal && !real.startsWith(rootReal + path.sep)) process.exit(4);
let fd;
try {
  fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
} catch (e) { process.exit(e.code === "ENOENT" ? 2 : 5); }
try {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.size > 1048576) process.exit(5);
  const again = fs.statSync(real);
  if (again.dev !== st.dev || again.ino !== st.ino) process.exit(5);
  const buf = Buffer.alloc(st.size);
  let off = 0;
  while (off < st.size) {
    const n = fs.readSync(fd, buf, off, st.size - off, off);
    if (n === 0) break;
    off += n;
  }
  fs.writeSync(1, buf, 0, off);
} catch (e) { process.exit(5); }'

# Writes the content of a source in the release (a path under $AH_CURRENT) to stdout; anything but a plain file inside the release is 66.
# Call it with the output redirected (`release_read src >file`) or to /dev/null as a check; die exits the whole script.
release_read() { # $1 = source
  local rc=0
  node -e "$READ_RELEASE_JS" "$AH_CURRENT" "$1" || rc=$?
  case $rc in
    0) ;;
    2) die 66 "bronbestand $1 ontbreekt" ;;
    3) die 66 "bronbestand $1 is een symlink; niet gekopieerd" ;;
    4) die 66 "bronbestand $1 ligt buiten de release (een map of bestand onderweg is een symlink); niet gekopieerd" ;;
    5) die 66 "bronbestand $1 is geen gewoon bestand van hooguit 1 MiB (of niet veilig te openen); niet gekopieerd" ;;
    *) die 74 "bronbestand $1 kon niet worden gelezen (node rc=$rc)" ;;
  esac
}

# Fill a temp file beside the target with a release file, atomically published (a crash leaves the old file or the new one).
install_file() { # $1 = source, $2 = target, $3 = mode
  make_temp_beside "$2"
  release_read "$1" >"$TEMP_FILE" || die 73 "schrijven naar het tijdelijke bestand voor $2 mislukt"
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

# Like install_file, but a target that differs is first copied to <target>.bak-<timestamp>, and one that is identical is left alone.
# Returns 0 when it placed or replaced the target and 1 when it was already identical, so call it as `if install_replacing ...` or
# `|| true` (set -e).
install_replacing() { # $1 = source, $2 = target, $3 = mode
  local dst=$2 backup
  make_temp_beside "$dst"
  release_read "$1" >"$TEMP_FILE" || die 73 "schrijven naar het tijdelijke bestand voor $dst mislukt"
  if [[ -f $dst ]] && cmp -s -- "$TEMP_FILE" "$dst"; then
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
    printf '%s is al actueel\n' "$dst"
    return 1
  fi
  if [[ -e $dst ]]; then
    backup="$dst.bak-$(date +%Y%m%d%H%M%S)"
    cp -p -- "$dst" "$backup" || die 73 "back-up van $dst maken mislukt"
    printf '%s bewaard als %s\n' "$dst" "$backup"
  fi
  publish_temp "$dst" "$3"
  printf '%s vervangen door die uit current\n' "$dst"
  return 0
}

# The shared "units installeren" step: both worker units from current to the unit directory, then daemon-reload. Never enable,
# never start: starting is for 2e.
install_units() {
  local unit
  [[ -d $AH_CURRENT/deploy/max2 ]] || die 66 "$AH_CURRENT/deploy/max2 ontbreekt (eerst een release uitrollen)"
  for unit in "$UNIT_HARNESS" "$UNIT_PROBE"; do
    install_file "$AH_CURRENT/deploy/max2/$unit" "$AH_UNIT_DIR/$unit" 644
  done
  systemctl daemon-reload || die 74 "systemctl daemon-reload mislukt (na het installeren van de units)"
  printf 'units %s en %s geïnstalleerd\n' "$UNIT_HARNESS" "$UNIT_PROBE"
}

# The bridge unit from current: placed when it is missing or differs (max2 still has the increment-1 unit, which says "never
# enabled"), with a back-up of the one it replaces. daemon-reload follows a replacement: systemd keeps the loaded increment-1
# definition (`failed`) until then, and `enable --now` in litellm-up would start that one.
install_bridge_unit() {
  if install_replacing "$AH_CURRENT/deploy/max2/litellm/$UNIT_BRIDGE" "$AH_UNIT_DIR/$UNIT_BRIDGE" 644; then
    systemctl daemon-reload || die 74 "systemctl daemon-reload mislukt (na de brug-unit)"
  fi
}

# --- origin/main, state files and the MCP checkout (release-* and mcp-*) ------------------------------------------------------

# Sets ORIGIN_COMMIT to the commit of origin/main, looked up as the owner. A failed lookup, or an answer that is no full commit, is 74.
ORIGIN_COMMIT=""
resolve_origin_main() {
  local out
  ORIGIN_COMMIT=""
  out=$(owner_git ls-remote "$AH_REPO_URL" refs/heads/main) || die 74 "git ls-remote van origin/main mislukt"
  read -r ORIGIN_COMMIT _ <<<"$out" || true
  [[ $ORIGIN_COMMIT =~ ^[0-9a-f]{40}$ ]] || die 74 "git ls-remote gaf geen geldige commit voor origin/main"
}

# Sets CURRENT_COMMIT to the release `current` points at ("" when there is no `current`). Anything but a link to releases/<commit> is 74.
CURRENT_COMMIT=""
read_current_release() {
  local target re='^releases/([0-9a-f]{40})$'
  CURRENT_COMMIT=""
  if [[ ! -e $AH_CURRENT && ! -L $AH_CURRENT ]]; then return 0; fi
  [[ -L $AH_CURRENT ]] || die 74 "$AH_CURRENT is geen symlink"
  target=$(readlink -- "$AH_CURRENT") || die 74 "$AH_CURRENT kon niet worden gelezen"
  [[ $target =~ $re ]] || die 74 "$AH_CURRENT wijst niet naar releases/<commit>"
  CURRENT_COMMIT=${BASH_REMATCH[1]}
}

require_state_dir() {
  [[ -d $AH_STATE_DIR ]] || die 66 "map $AH_STATE_DIR ontbreekt"
}

# The state files live in AH_STATE_DIR, which the owner (janpeter) can write while root reads and writes the files. A path that root
# checks and then opens (-L, then `read <file`; mktemp, then `> $temp`) can be swapped by the owner in between: root would follow a
# link, write or chmod any file, or hang on a FIFO while it holds the lock. So both directions run in node, on a file descriptor:
# - reading opens with O_NOFOLLOW|O_NONBLOCK and fstat must say regular file of at most 256 bytes (exit 2 = missing, 3 = corrupt);
# - writing creates a temp file beside the target with O_CREAT|O_EXCL (a name that exists, a link included, is an error, never
#   followed), sets the mode on the descriptor, writes, fsyncs, and renames it over the target (rename replaces a link entry, it
#   never follows it). The temp name is random; a failure removes a temp file of ours and exits 1.
STATE_READ_JS='const fs = require("fs");
let fd;
try {
  fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
} catch (e) { process.exit(e.code === "ENOENT" ? 2 : 3); }
try {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.size > 256) process.exit(3);
  const buf = Buffer.alloc(st.size);
  fs.readSync(fd, buf, 0, st.size, 0);
  process.stdout.write(buf.toString("utf8"));
} catch (e) { process.exit(3); }'

STATE_WRITE_JS='const fs = require("fs"), path = require("path"), crypto = require("crypto");
const target = process.argv[1], value = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(value)) { process.stderr.write("geen volledige commit\n"); process.exit(1); }
const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + crypto.randomBytes(8).toString("hex"));
let fd, created = false;
try {
  fd = fs.openSync(tmp, "wx", 0o644);
  created = true;
  fs.fchmodSync(fd, 0o644);
  fs.writeSync(fd, value + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(tmp, target);
} catch (e) {
  try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
  try { if (created) fs.unlinkSync(tmp); } catch (_) {}
  process.stderr.write((e && e.code ? e.code : "fout") + "\n");
  process.exit(1);
}'

# Sets STATE_COMMIT to the commit in a state file ("" when the file is missing). A symlink, FIFO or other non-regular file, a file over
# 256 bytes, or a first line that is no full commit is 75, except with a second argument (lenient: the caller overwrites the file
# anyway), which reads all of that as missing.
STATE_COMMIT=""
read_state_commit() { # $1 = file, $2 = "lenient" (optional)
  local out="" line rc=0
  STATE_COMMIT=""
  out=$(node -e "$STATE_READ_JS" "$1") || rc=$?
  case $rc in
    0) ;;
    2) return 0 ;;
    3)
      [[ ${2:-} == lenient ]] && return 0
      die 75 "$1 is geen gewoon bestand van een paar bytes (symlink, FIFO of te groot)"
      ;;
    *) die 74 "$1 kon niet worden gelezen (node rc=$rc)" ;;
  esac
  line=${out%%$'\n'*}
  if [[ ! $line =~ ^[0-9a-f]{40}$ ]]; then
    [[ ${2:-} == lenient ]] && return 0
    die 75 "$1 bevat geen volledige commit"
  fi
  STATE_COMMIT=$line
}

# A state file is written whole or not at all (see above); a failure is 73 with a line (exit 1 means "checkout not clean").
write_state_commit() { # $1 = file, $2 = commit
  local err rc=0
  require_commit "$2"
  err=$(node -e "$STATE_WRITE_JS" "$1" "$2" 2>&1) || rc=$?
  ((rc == 0)) || die 73 "$1 schrijven mislukt (${err:-rc=$rc})"
}

require_mcp_checkout() {
  [[ -d $AH_MCP_DIR ]] || die 66 "checkout $AH_MCP_DIR ontbreekt"
}

# Sets MCP_REV to the full commit `git rev-parse <rev>` gives in the MCP checkout (74 when git fails or answers anything else).
MCP_REV=""
mcp_rev_parse() { # $1 = rev
  MCP_REV=$(owner_git -C "$AH_MCP_DIR" rev-parse "$1") || die 74 "git rev-parse $1 in $AH_MCP_DIR mislukt"
  [[ $MCP_REV =~ ^[0-9a-f]{40}$ ]] || die 74 "git rev-parse $1 gaf geen volledige commit"
}

# The shared install step of mcp-update and mcp-rollback: submodule, npm ci, prisma:generate (it rewrites prisma/schema.prisma from the
# submodule and generates the client; postinstall does the same but swallows a failure), then the checkout must be clean: a stale
# schema (it is in git) shows up as a change. Everything as the owner, npm in the checkout.
mcp_install() {
  local out
  owner_git -C "$AH_MCP_DIR" submodule update --init || die 74 "git submodule update --init in $AH_MCP_DIR mislukt"
  (cd "$AH_MCP_DIR" && owner_npm ci && owner_npm run prisma:generate) || die 74 "npm ci of npm run prisma:generate in $AH_MCP_DIR mislukt"
  out=$(owner_git -C "$AH_MCP_DIR" status --porcelain) || die 74 "git status in $AH_MCP_DIR mislukt"
  if [[ -n $out ]]; then
    printf '%s\n' "$out" >&2
    die 1 "git status --porcelain is niet leeg na de MCP-installatie in $AH_MCP_DIR"
  fi
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
    chmod 600 "$AH_LITELLM_ENV" || die 74 "chmod 600 van $AH_LITELLM_ENV mislukt"
    printf 'masterkey bestaat al in %s; ongewijzigd\n' "$AH_LITELLM_ENV"
  fi
  if [[ -e $AH_HARNESS_ENV ]]; then
    chmod 600 "$AH_HARNESS_ENV" || die 74 "chmod 600 van $AH_HARNESS_ENV mislukt"
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

# --- LiteLLM: master key, health and model names (litellm-up, litellm-upgrade, status) -----------------------------------------

# A master key that curl --config can carry as one `header` value: LiteLLM's `sk-` plus hex, or anything of that character class.
# A quote, backslash, space or control character could end the value and start another curl option, so they are refused.
KEY_RE='^[A-Za-z0-9._~+/=:-]+$'

# 66 when harness-litellm.env has no LITELLM_MASTER_KEY, 64 when it holds one curl --config cannot carry safely. The value is
# dropped again at once; fetch_models reads it itself.
require_master_key() {
  read_env_value "$AH_HARNESS_ENV" LITELLM_MASTER_KEY
  if [[ -z $ENV_VALUE ]]; then
    die 66 "LITELLM_MASTER_KEY ontbreekt in $AH_HARNESS_ENV (eerst install)"
  fi
  if [[ ! $ENV_VALUE =~ $KEY_RE ]]; then
    ENV_VALUE=""
    die 64 "de masterkey in $AH_HARNESS_ENV bevat een teken dat curl --config anders leest; niet gebruikt"
  fi
  ENV_VALUE=""
}

# The node program that reads the /v1/models response on stdin and prints the model names (`.data[].id`), space separated, and
# nothing else: an id must match a safe pattern, so no control character or other field of the response leaves the wrapper.
MODELS_JS='let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { s += d; if (s.length > 1048576) process.exit(3); });
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) { process.exit(3); }
  if (!j || !Array.isArray(j.data)) process.exit(3);
  const ids = [];
  for (const m of j.data) {
    if (m && typeof m.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(m.id)) ids.push(m.id);
  }
  process.stdout.write(ids.join(" "));
});'

# Sets MODELS_LINE to the model names LiteLLM knows. Returns 2 when there is no usable master key, 3 when LiteLLM did not answer or
# the answer is no model list. The key stays in a shell variable and goes to curl through printf (a builtin) into `--config -`.
MODELS_LINE=""
fetch_models() {
  local key rc=0
  MODELS_LINE=""
  read_env_value "$AH_HARNESS_ENV" LITELLM_MASTER_KEY
  key=$ENV_VALUE
  ENV_VALUE=""
  if [[ -z $key || ! $key =~ $KEY_RE ]]; then
    key=""
    return 2
  fi
  MODELS_LINE=$(printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -fsS --max-time 10 --config - "$AH_LITELLM_URL/v1/models" | node -e "$MODELS_JS") || rc=$?
  key=""
  ((rc == 0)) || { MODELS_LINE=""; return 3; }
}

print_models() { # for litellm-up and litellm-upgrade: a failure is 74
  local rc=0
  fetch_models || rc=$?
  case $rc in
    0) printf 'litellm modellen: %s\n' "${MODELS_LINE:-(geen)}" ;;
    2) die 66 "de masterkey in $AH_HARNESS_ENV ontbreekt of is onbruikbaar" ;;
    *) die 74 "de modellen van LiteLLM ($AH_LITELLM_URL/v1/models) zijn niet op te vragen" ;;
  esac
}

# Waits for /health/liveliness (no key needed): AH_HEALTH_TRIES tries, AH_HEALTH_SLEEP seconds apart. Not healthy is 74.
wait_litellm_healthy() {
  local i
  for ((i = 1; i <= AH_HEALTH_TRIES; i++)); do
    if curl -fsS --max-time 5 -o /dev/null "$AH_LITELLM_URL/health/liveliness" 2>/dev/null; then
      printf 'LiteLLM is gezond (/health/liveliness)\n'
      return 0
    fi
    ((i == AH_HEALTH_TRIES)) || sleep "$AH_HEALTH_SLEEP"
  done
  die 74 "LiteLLM gaf geen 200 op $AH_LITELLM_URL/health/liveliness binnen $AH_HEALTH_TRIES pogingen"
}

litellm_compose() { # $@ = docker compose arguments after -p/-f
  docker compose -p "$LITELLM_PROJECT" -f "$AH_LITELLM_DIR/compose.yml" "$@"
}

# --- actions --------------------------------------------------------------------------------------------------------

# The node program of `status`: per configuration of harness.json the stored probe result, from <runs>/probe-<name>/probe.json (the
# directory name is made the way probeDir in the harness makes it). Both files live in directories of the owner, so nothing blocks and
# nothing is followed: harness.json and probe.json are opened with O_NOFOLLOW|O_NONBLOCK, fstat must say regular file of at most 1 MiB, and
# they are read from the descriptor (a FIFO, a huge file or a link is "onleesbaar", never a hang). The runs directory must be its own real
# path and probe-<name> must be a real directory directly in it (realpath equals the joined path): a link in the way is "onleesbaar". Only
# validated fields are printed: accepted must be a boolean, the hash 64 hexadecimal characters, the time an ISO timestamp (else the
# modification time of the file). Nothing is hashed here: the gate of the worker does that, per job.
STATUS_PROBES_JS='const fs = require("fs"), path = require("path");
const cfgPath = process.argv[1], runs = process.argv[2];
const MAX = 1048576;
function readSmall(file) { // { text, mtime }; throws when the file is no plain file of at most MAX bytes, a link or a FIFO included
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX) throw new Error("geen gewoon bestand");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    return { text: buf.toString("utf8", 0, off), mtime: st.mtime };
  } finally { try { fs.closeSync(fd); } catch (e) {} }
}
let names;
try {
  names = Object.keys(JSON.parse(readSmall(cfgPath).text).configurations || {});
} catch (e) {
  process.stdout.write("probe: (" + (e && e.code === "ENOENT" ? "harness.json ontbreekt" : "harness.json onleesbaar") + ")\n");
  process.exit(0);
}
let realRuns = null, runsMissing = false;
try { const r = fs.realpathSync(runs); if (r === path.resolve(runs)) realRuns = r; } catch (e) { runsMissing = e && e.code === "ENOENT"; }
for (const name of names) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) { process.stdout.write("probe: (een configuratienaam in harness.json is ongeldig)\n"); continue; }
  let line;
  try {
    if (runsMissing) throw Object.assign(new Error("runs ontbreekt"), { code: "ENOENT" });
    if (realRuns === null) throw Object.assign(new Error("runs is geen echte map"), { code: "ELINK" });
    const dirName = path.join(realRuns, "probe-" + name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-"));
    if (fs.realpathSync(dirName) !== dirName) throw Object.assign(new Error("probe-map is een link"), { code: "ELINK" });
    const f = readSmall(path.join(dirName, "probe.json"));
    const j = JSON.parse(f.text);
    if (!j || typeof j.accepted !== "boolean" || typeof j.hash !== "string" || !/^[0-9a-f]{64}$/.test(j.hash)) throw new Error("onvolledig");
    const time = typeof j.ranAt === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,16}Z$/.test(j.ranAt) ? j.ranAt : f.mtime.toISOString();
    line = "accepted=" + j.accepted + " hash=" + j.hash + " tijd=" + time;
  } catch (e) {
    line = e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? "(geen probe-uitslag)" : "(onleesbaar)";
  }
  process.stdout.write("probe " + name + ": " + line + "\n");
}'

# One state file for `status`: the commit, "(geen)" when the file is missing, "(onleesbaar ...)" for anything else. Never exits.
status_state() { # $1 = label, $2 = file
  local out="" line rc=0
  out=$(node -e "$STATE_READ_JS" "$2" 2>/dev/null) || rc=$?
  case $rc in
    0)
      line=${out%%$'\n'*}
      if [[ $line =~ ^[0-9a-f]{40}$ ]]; then
        printf '%s: %s\n' "$1" "$line"
      else
        printf '%s: (onleesbaar: geen volledige commit)\n' "$1"
      fi
      ;;
    2) printf '%s: (geen)\n' "$1" ;;
    *) printf '%s: (onleesbaar: geen gewoon bestand van een paar bytes)\n' "$1" ;;
  esac
}

# `status`: read-only and without the lock; every part reports its own failure and the exit code is 0. It prints the commits (current,
# release.prev, mcp-stable HEAD, mcp.built, mcp.prev, origin/main of scrum4me-mcp), the unit states, the LiteLLM container with its image
# digest, the model names, and per configuration the stored probe result. No secret: the master key only travels to curl.
action_status() {
  local target out unit info state cfg_image image_id digests head remote rc
  local re='^releases/([0-9a-f]{40})$' sha_re='^[0-9a-f]{40}$'

  if [[ ! -e $AH_CURRENT && ! -L $AH_CURRENT ]]; then
    printf 'current: (geen)\n'
  elif [[ -L $AH_CURRENT ]] && target=$(readlink -- "$AH_CURRENT") && [[ $target =~ $re ]]; then
    printf 'current: %s\n' "${BASH_REMATCH[1]}"
  else
    printf 'current: (onleesbaar: geen symlink naar releases/<commit>)\n'
  fi
  status_state release.prev "$AH_RELEASE_PREV"

  if [[ ! -d $AH_MCP_DIR ]]; then
    printf 'mcp-stable HEAD: (checkout ontbreekt: %s)\n' "$AH_MCP_DIR"
  elif head=$(owner_git_bounded -C "$AH_MCP_DIR" rev-parse HEAD 2>/dev/null) && [[ $head =~ $sha_re ]]; then
    printf 'mcp-stable HEAD: %s\n' "$head"
  else
    printf 'mcp-stable HEAD: (onleesbaar: git rev-parse mislukte)\n'
  fi
  status_state mcp.built "$AH_MCP_BUILT"
  status_state mcp.prev "$AH_MCP_PREV"
  if [[ ! -d $AH_MCP_DIR ]]; then
    printf 'mcp origin/main: (checkout ontbreekt: %s)\n' "$AH_MCP_DIR"
  else
    rc=0
    out=$(owner_git_bounded -C "$AH_MCP_DIR" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=10 ls-remote origin refs/heads/main 2>/dev/null) || rc=$?
    remote=""
    read -r remote _ <<<"$out" || true
    if ((rc == 0)) && [[ $remote =~ $sha_re ]]; then
      printf 'mcp origin/main: %s\n' "$remote"
    else
      printf 'mcp origin/main: (niet bereikbaar)\n'
    fi
  fi

  for unit in "$UNIT_HARNESS" "$UNIT_PROBE" "$UNIT_WORKER" "$UNIT_BRIDGE"; do
    state=$(bounded systemctl is-active "$unit" 2>/dev/null || true)
    printf 'unit %s: %s\n' "$unit" "${state:-onbekend}"
  done

  if info=$(bounded docker inspect --format '{{.State.Status}}|{{.Config.Image}}|{{.Image}}' "$LITELLM_CONTAINER" 2>/dev/null) && [[ -n $info ]]; then
    state=${info%%|*}
    cfg_image=${info#*|}
    image_id=${cfg_image#*|}
    cfg_image=${cfg_image%%|*}
    printf 'litellm container: %s, image %s\n' "$state" "$cfg_image"
    digests=$(bounded docker image inspect --format '{{join .RepoDigests " "}}' "$image_id" 2>/dev/null || true)
    printf 'litellm image-digest: %s\n' "${digests:-(onbekend)}"
  else
    printf 'litellm container: (niet gevonden of docker niet bereikbaar)\n'
  fi

  rc=0
  fetch_models || rc=$?
  case $rc in
    0) printf 'litellm modellen: %s\n' "${MODELS_LINE:-(geen)}" ;;
    2) printf 'litellm modellen: (masterkey ontbreekt of is onbruikbaar in %s)\n' "$AH_HARNESS_ENV" ;;
    *) printf 'litellm modellen: (niet op te vragen)\n' ;;
  esac

  node -e "$STATUS_PROBES_JS" "$AH_HARNESS_JSON" "$AH_RUNS_DIR" 2>/dev/null || printf 'probe: (onleesbaar: node faalde)\n'
  return 0
}

# The first set-up, idempotent: directories, the first release from origin/main, the units, the LiteLLM files and the bridge
# unit, the master key. A second run changes nothing that exists: no git or npm call, and no file, key or release replaced
# (except a bridge unit that differs from the one in current).
action_install() {
  require_standstill "$UNIT_HARNESS"
  umask 022

  mkdir -p "$AH_SRV" "$AH_RELEASES" || die 73 "mappen onder $AH_SRV konden niet worden gemaakt"
  chmod 755 "$AH_SRV" "$AH_RELEASES" || die 74 "chmod 755 van $AH_SRV en $AH_RELEASES mislukt"
  chown "$AH_OWNER" "$AH_RELEASES" || die 74 "chown $AH_OWNER van $AH_RELEASES mislukt"
  if [[ -e $AH_CURRENT || -L $AH_CURRENT ]]; then
    printf 'release bestaat; bijwerken via release-update\n'
  else
    resolve_origin_main
    build_release "$ORIGIN_COMMIT"
    swap_current "$ORIGIN_COMMIT"
  fi
  install_units

  mkdir -p "$AH_ETC" "$AH_LITELLM_DIR" || die 73 "map $AH_LITELLM_DIR kon niet worden gemaakt"
  chmod 755 "$AH_LITELLM_DIR" || die 74 "chmod 755 van $AH_LITELLM_DIR mislukt"
  install_file_if_missing "$AH_CURRENT/deploy/max2/harness.json" "$AH_HARNESS_JSON" 644
  install_file_if_missing "$AH_CURRENT/deploy/max2/litellm/config.yaml" "$AH_LITELLM_DIR/config.yaml" 644
  install_file_if_missing "$AH_CURRENT/deploy/max2/litellm/compose.yml" "$AH_LITELLM_DIR/compose.yml" 644
  install_bridge_unit

  ensure_master_key
}

# stop: free of the lock (see main); it changes no file.
action_stop() {
  systemctl stop "$UNIT_HARNESS"
}

# start: refuses (66) when the unit, harness.json or current is missing; otherwise systemctl start. In 2d nobody calls it.
action_start() {
  [[ -f $AH_UNIT_DIR/$UNIT_HARNESS ]] || die 66 "unit $AH_UNIT_DIR/$UNIT_HARNESS ontbreekt (eerst install)"
  [[ -f $AH_HARNESS_JSON ]] || die 66 "$AH_HARNESS_JSON ontbreekt (eerst install)"
  [[ -e $AH_CURRENT ]] || die 66 "$AH_CURRENT ontbreekt of wijst naar niets (eerst install)"
  systemctl start "$UNIT_HARNESS"
}

# probe: starts the probe unit and blocks until it ends; exit 0 only when it succeeded, otherwise systemctl's exit code. The result
# per configuration is in probe.json and in the journal.
action_probe() {
  local rc=0
  systemctl start "$UNIT_PROBE" || rc=$?
  ((rc == 0)) || die "$rc" "$UNIT_PROBE faalde (systemctl start gaf rc=$rc); zie probe.json en de journal"
  printf 'probe geslaagd\n'
}

# release-update: the commit of origin/main. When `current` already is that release, only the units are installed (the repair after
# an update interrupted before the units). Otherwise: build, write release.prev (the release `current` has now), switch, install
# the units. A failed build changes neither `current` nor release.prev. An interruption leaves `current` on the old release (and
# release.prev on it too) or on the new one; the same action then finishes the job: release.prev is written again with the same
# value, the switch is made, the units follow.
action_release_update() {
  local old new
  require_standstill "$UNIT_HARNESS" "$UNIT_PROBE"
  require_state_dir
  read_current_release
  old=$CURRENT_COMMIT
  [[ -n $old ]] || die 66 "geen release in $AH_CURRENT (eerst install)"
  resolve_origin_main
  new=$ORIGIN_COMMIT
  if [[ $new == "$old" ]]; then
    printf 'current is al release %s; alleen de units installeren\n' "$new"
    install_units
    return 0
  fi
  build_release "$new"
  write_state_commit "$AH_RELEASE_PREV" "$old"
  swap_current "$new"
  install_units
  printf '%s → %s\n' "$old" "$new"
}

# release-rollback: switch to the release in release.prev, without a build; release.prev does not change. A missing release.prev,
# release or .built is 75. When `current` already is that release (a second call, or a rerun after an interruption), only the
# units are installed. Going forward again is release-update.
action_release_rollback() {
  local old prev
  require_standstill "$UNIT_HARNESS" "$UNIT_PROBE"
  read_state_commit "$AH_RELEASE_PREV"
  prev=$STATE_COMMIT
  [[ -n $prev ]] || die 75 "release.prev ontbreekt (zoals na de eerste installatie); er is geen release om naar terug te gaan"
  [[ -f $AH_RELEASES/$prev/.built ]] || die 75 "release $prev (release.prev) ontbreekt of is niet gebouwd"
  read_current_release
  old=$CURRENT_COMMIT
  if [[ $old == "$prev" ]]; then
    printf 'current is al release %s; alleen de units installeren\n' "$prev"
    install_units
    return 0
  fi
  swap_current "$prev"
  install_units
  printf '%s → %s\n' "${old:-onbekend}" "$prev"
}

# mcp-update: mcp.built holds the commit of the last successful install (first use: HEAD, on which the old service runs; written
# before anything changes). A dirty checkout is 75. fetch, then the target is origin/main. Only when the target differs from
# mcp.built does mcp.built go to mcp.prev first, so a failed update (also a second attempt) leaves mcp.prev on the last good commit
# and a repetition of a successful one leaves it on the commit before. merge --ff-only, install; only on success mcp.built becomes the target.
action_mcp_update() {
  local dirty built target
  require_standstill "$UNIT_HARNESS" "$UNIT_WORKER"
  require_state_dir
  require_mcp_checkout
  dirty=$(owner_git -C "$AH_MCP_DIR" status --porcelain) || die 74 "git status in $AH_MCP_DIR mislukt"
  [[ -z $dirty ]] || die 75 "$AH_MCP_DIR heeft wijzigingen; herstel eerst met mcp-rollback of ruim ze op"
  read_state_commit "$AH_MCP_BUILT"
  built=$STATE_COMMIT
  if [[ -z $built ]]; then
    mcp_rev_parse HEAD
    built=$MCP_REV
    write_state_commit "$AH_MCP_BUILT" "$built"
  fi
  owner_git -C "$AH_MCP_DIR" fetch origin || die 74 "git fetch origin in $AH_MCP_DIR mislukt"
  mcp_rev_parse origin/main
  target=$MCP_REV
  if [[ $target != "$built" ]]; then
    write_state_commit "$AH_MCP_PREV" "$built"
  fi
  owner_git -C "$AH_MCP_DIR" merge --ff-only "$target" || die 74 "git merge --ff-only $target in $AH_MCP_DIR mislukt"
  mcp_install
  write_state_commit "$AH_MCP_BUILT" "$target"
  if [[ $target == "$built" ]]; then
    printf 'mcp-stable staat al op %s; opnieuw geïnstalleerd\n' "$target"
  else
    printf '%s → %s\n' "$built" "$target"
  fi
}

# mcp-rollback: without mcp.prev 75. Otherwise reset --hard to it and install; expressly no fetch, merge or pull (they would go back to
# origin/main). A dirty checkout is no reason to refuse: the reset repairs it. On success mcp.built is that commit; mcp.prev stays, so a
# repetition picks the same commit.
action_mcp_rollback() {
  local old prev
  require_standstill "$UNIT_HARNESS" "$UNIT_WORKER"
  require_state_dir
  require_mcp_checkout
  read_state_commit "$AH_MCP_PREV"
  prev=$STATE_COMMIT
  [[ -n $prev ]] || die 75 "mcp.prev ontbreekt; er is geen commit om naar terug te gaan"
  read_state_commit "$AH_MCP_BUILT" lenient
  old=$STATE_COMMIT
  owner_git -C "$AH_MCP_DIR" reset --hard "$prev" || die 74 "git reset --hard $prev in $AH_MCP_DIR mislukt"
  mcp_install
  write_state_commit "$AH_MCP_BUILT" "$prev"
  printf '%s → %s\n' "${old:-onbekend}" "$prev"
}

# litellm-up: compose up -d (it makes the network `litellm`), then the installed bridge unit enabled and started (no copy: install and
# litellm-upgrade place it), wait for /health/liveliness, print the model names. Every precondition is checked first, so a missing
# file or key leaves LiteLLM as it was. The worker need not be at a standstill: this does not replace any file.
action_litellm_up() {
  [[ -f $AH_LITELLM_DIR/compose.yml ]] || die 66 "$AH_LITELLM_DIR/compose.yml ontbreekt (eerst install)"
  [[ -f $AH_UNIT_DIR/$UNIT_BRIDGE ]] || die 66 "unit $AH_UNIT_DIR/$UNIT_BRIDGE ontbreekt (eerst install)"
  require_master_key
  litellm_compose up -d || die 74 "docker compose up -d mislukt"
  systemctl enable --now "$UNIT_BRIDGE" || die 74 "systemctl enable --now $UNIT_BRIDGE mislukt"
  wait_litellm_healthy
  print_models
}

# litellm-upgrade: needs the worker at a standstill and the lock. From `current` it replaces harness.json, config.yaml, compose.yml and the
# bridge unit (harness.json and config.yaml carry the same configuration names, so they go together; 0644, the previous one kept as
# <file>.bak-<timestamp>), after every source has been checked: a bad source leaves every target as it was. Then daemon-reload, restart
# of the bridge, pull and `up -d --force-recreate` (config.yaml is only a bind mount, so a plain `up -d` would leave the old container
# on the old config), wait for liveliness, print the model names. The flow upgrade_litellm runs the probes and starts the service after
# it. Run litellm-up first on a host that never ran LiteLLM: the bridge restart waits for the network br-litellm.
action_litellm_upgrade() {
  local max2="$AH_CURRENT/deploy/max2" f
  require_standstill "$UNIT_HARNESS" "$UNIT_PROBE"
  [[ -d $max2 ]] || die 66 "$max2 ontbreekt (eerst install of release-update)"
  for f in harness.json litellm/config.yaml litellm/compose.yml "litellm/$UNIT_BRIDGE"; do
    release_read "$max2/$f" >/dev/null
  done
  [[ -d $AH_ETC && -d $AH_LITELLM_DIR && -d $AH_UNIT_DIR ]] || die 66 "$AH_LITELLM_DIR of $AH_UNIT_DIR ontbreekt (eerst install)"
  require_master_key
  umask 022
  install_replacing "$max2/harness.json" "$AH_HARNESS_JSON" 644 || true
  install_replacing "$max2/litellm/config.yaml" "$AH_LITELLM_DIR/config.yaml" 644 || true
  install_replacing "$max2/litellm/compose.yml" "$AH_LITELLM_DIR/compose.yml" 644 || true
  install_replacing "$max2/litellm/$UNIT_BRIDGE" "$AH_UNIT_DIR/$UNIT_BRIDGE" 644 || true
  systemctl daemon-reload || die 74 "systemctl daemon-reload mislukt (na de nieuwe bestanden)"
  systemctl restart "$UNIT_BRIDGE" || die 74 "systemctl restart $UNIT_BRIDGE mislukt"
  litellm_compose pull || die 74 "docker compose pull mislukt"
  litellm_compose up -d --force-recreate || die 74 "docker compose up -d --force-recreate mislukt"
  wait_litellm_healthy
  print_models
}

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

#!/bin/bash
# stop-check.sh: stop the agent-harness service on max2 without losing a claimed job. Runs on the admin machine (portable bash: macOS
# 3.2 and bash 5, no GNU-only flags), with the ssh aliases `scrum4me-srv` and `max2`. It is the M4 stop procedure (docs/plans/
# M4-harness-run-logging.md, step 1-2) as a script that stops at the first error, with the predicate of spec section 3 point 2:
# the jobs of the harness are the rows with runtime HARNESS (the only route since M45-3).
#
#   1. snapshot "voor" on scrum4me-srv: one read-only transaction (BEGIN READ ONLY; SET LOCAL ROLE ops_readonly; ...; ROLLBACK) with
#      `select id, kind, status, retry_count from claude_jobs where runtime = 'HARNESS' order by id`.
#      Never the column `error`: it can hold unredacted model or tool text. A snapshot counts only when psql ends with exit 0: it is
#      written to a temporary file first and renamed after that, and every line must have the four fields.
#   2. a row in CLAIMED or RUNNING: stop here with the ids (exit 1), nothing is stopped.
#   3. `sudo -n .../agent-harness-ops.sh stop` on max2, then `systemctl is-active agent-harness.service` must say `inactive` or `failed`
#      (a failed unit is stopped too; `activating` is the restart pause and is not). Anything else: exit 1.
#   4. snapshot "na", the same way.
#   5. no difference: exit 0 ("veilig om bij te werken"). A difference (a job claimed, finished, reset or dispatched since "voor"):
#      exit 1; the service stays stopped and the ids go to JP.
#
# A failed command is never a clean outcome: before the stop nothing is stopped, after it the service stays stopped. Nothing here
# prints a database URL or a secret: the database is reached through `docker exec` on scrum4me-srv, and the output is job ids.
#
# Exit codes: 0 safe to update; 1 anything else (the message says what).

SRV_HOST=scrum4me-srv
MAX2_HOST=max2
WRAPPER=/usr/local/lib/agent-harness/ops/agent-harness-ops.sh
UNIT=agent-harness.service
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
PSQL='docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me -X -q -v ON_ERROR_STOP=1 -At'

SQL="BEGIN READ ONLY;
SET LOCAL ROLE ops_readonly;
select id, kind, status, retry_count from claude_jobs where runtime = 'HARNESS' order by id;
ROLLBACK;"

work=$(mktemp -d) || { echo "stop-check: geen tijdelijke map te maken: niet gestopt" >&2; exit 1; }
trap 'rm -rf -- "$work"' EXIT

# opname <voor|na>: a snapshot counts only when ssh/psql end with exit 0 and every line is id|kind|STATUS|number.
opname() {
  printf '%s\n' "$SQL" | "${SSH[@]}" "$SRV_HOST" "$PSQL" >"$work/$1.tmp" || return 1
  # grep -v prints the lines that do not fit: status 0 means at least one (invalid), 1 none (valid), anything else an error (invalid).
  grep -qvE '^[^|]+[|][^|]+[|][A-Z_]+[|][0-9]+$' "$work/$1.tmp"
  [ $? -eq 1 ] || return 1
  mv "$work/$1.tmp" "$work/$1.txt"
}

opname voor || { echo "stop-check: opname 'voor' mislukt (psql of ssh gaf geen exit 0, of onverwachte uitvoer): niet gestopt" >&2; exit 1; }

bezig=$(awk -F'|' '$3 == "CLAIMED" || $3 == "RUNNING" { print $0 }' "$work/voor.txt") ||
  { echo "stop-check: de controle op claims mislukte: niet gestopt" >&2; exit 1; }
if [ -n "$bezig" ]; then
  echo "stop-check: een job van de harness is geclaimd of bezig (id|kind|status|retry_count): niet gestopt" >&2
  printf '%s\n' "$bezig" >&2
  exit 1
fi

"${SSH[@]}" "$MAX2_HOST" "sudo -n $WRAPPER stop" </dev/null || { echo "stop-check: de stop op max2 mislukte: JP" >&2; exit 1; }
toestand=$("${SSH[@]}" "$MAX2_HOST" "systemctl is-active $UNIT" </dev/null 2>/dev/null)
case "$toestand" in
  inactive | failed) ;;
  *) echo "stop-check: $UNIT is '$toestand' na de stop: JP" >&2; exit 1 ;;
esac

opname na || { echo "stop-check: opname 'na' mislukt: de dienst blijft gestopt, JP" >&2; exit 1; }

diff "$work/voor.txt" "$work/na.txt"
case $? in
  0) echo "stop-check: schone stop, veilig om bij te werken" ;;
  1) echo "stop-check: verschil tussen de opnames: de dienst blijft gestopt, de ids uit het verschil naar JP (M4 stap 2)" >&2; exit 1 ;;
  *) echo "stop-check: diff mislukte: de dienst blijft gestopt, JP" >&2; exit 1 ;;
esac

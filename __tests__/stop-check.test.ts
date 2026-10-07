import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// stop-check.sh (deploy/max2/ops/stop-check.sh) runs on the admin machine and calls only `ssh`. Here `ssh` is a fake on PATH: it logs
// its host and remote command, hands out the prepared snapshots (the n-th call to scrum4me-srv gets snap<n> and exit code rc<n>), and
// answers the wrapper's `stop` and `systemctl is-active` from files. Set OPS_BASH to run the script under another bash.

const SCRIPT = fileURLToPath(new URL('../deploy/max2/ops/stop-check.sh', import.meta.url))
const WRAPPER = '/usr/local/lib/agent-harness/ops/agent-harness-ops.sh'

let dir: string
let fake: string
let tmp: string

const FAKE_SSH = `#!/bin/sh
F="$FAKE_DIR"
opts=""
while [ "$1" = "-o" ]; do opts="$opts $2"; shift 2; done
host="$1"; cmd="$2"
printf '%s|%s|%s\\n' "$host" "$cmd" "$opts" >> "$F/calls.log"
case "$host" in
  scrum4me-srv)
    n=$(cat "$F/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$F/n"
    cat > "$F/sql.$n"
    [ -f "$F/snap$n" ] && cat "$F/snap$n"
    [ -f "$F/rc$n" ] && exit "$(cat "$F/rc$n")"
    exit 0 ;;
  max2)
    case "$cmd" in
      *"agent-harness-ops.sh stop") [ -f "$F/stop-rc" ] && exit "$(cat "$F/stop-rc")"; exit 0 ;;
      "systemctl is-active agent-harness.service")
        s=inactive; [ -f "$F/active" ] && s=$(cat "$F/active")
        [ -n "$s" ] && echo "$s"
        [ "$s" = active ] && exit 0
        [ -f "$F/active-rc" ] && exit "$(cat "$F/active-rc")"
        exit 3 ;;
    esac ;;
esac
echo "onverwachte ssh-aanroep: $host $cmd" >&2
exit 99
`

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), 'stop-check-'))
  fake = join(dir, 'fake')
  tmp = join(dir, 'tmp')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(fake)
  mkdirSync(tmp)
  writeFileSync(join(dir, 'bin', 'ssh'), FAKE_SSH)
  chmodSync(join(dir, 'bin', 'ssh'), 0o755)
}

const put = (name: string, content: string): void => writeFileSync(join(fake, name), content)
const snaps = (voor: string, na: string): void => {
  put('snap1', voor)
  put('snap2', na)
}
const calls = (): string[] => (existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [])
const hostCmds = (): string[] => calls().map((c) => c.split('|').slice(0, 2).join('|'))
const stopCalls = (): string[] => calls().filter((c) => c.includes('agent-harness-ops.sh stop'))

function run(bash = process.env.OPS_BASH ?? 'bash') {
  const res = spawnSync(bash, [SCRIPT], {
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, FAKE_DIR: fake, TMPDIR: tmp, HOME: dir },
    encoding: 'utf8',
    timeout: 30000,
  })
  return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}\n${res.stderr}` }
}

beforeEach(setup)
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ROWS = 'job-a|IDEA_CHAT|DONE|0\njob-b|TASK_IMPLEMENTATION|QUEUED|1\n'

describe('stop-check.sh', () => {
  it('geeft exit 0 ("veilig om bij te werken") bij twee gelijke opnames zonder claim, en roept ssh in de vaste volgorde aan: opname, stop, is-active, opname', () => {
    snaps(ROWS, ROWS)
    const res = run()
    expect(res.code, res.all).toBe(0)
    expect(res.out).toContain('veilig om bij te werken')
    const hosts = hostCmds()
    expect(hosts).toHaveLength(4)
    expect(hosts[0]).toMatch(/^scrum4me-srv\|docker exec -i scrum4me-postgres psql -U scrum4me -d scrum4me /)
    expect(hosts[1]).toBe(`max2|sudo -n ${WRAPPER} stop`)
    expect(hosts[2]).toBe('max2|systemctl is-active agent-harness.service')
    expect(hosts[3]).toBe(hosts[0])
    for (const c of calls()) expect(c, c).toContain('BatchMode=yes')
  })

  it('leest read-only: één transactie met BEGIN READ ONLY, SET LOCAL ROLE ops_readonly en ROLLBACK, met het predicaat van de spec en zonder de kolom error', () => {
    snaps(ROWS, ROWS)
    run()
    for (const n of [1, 2]) {
      const sql = readFileSync(join(fake, `sql.${n}`), 'utf8')
      expect(sql).toMatch(/^BEGIN READ ONLY;\nSET LOCAL ROLE ops_readonly;\n/)
      expect(sql).toContain("select id, kind, status, retry_count from claude_jobs where runtime = 'HARNESS' or required_capability = 'local_llm' order by id;")
      expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true)
      expect(sql).not.toMatch(/\berror\b/i)
      expect(sql).not.toMatch(/insert|update|delete|drop|alter|create/i)
    }
    // psql stops at the first error and prints no command tags
    expect(hostCmds()[0]).toContain('-v ON_ERROR_STOP=1')
    expect(hostCmds()[0]).toContain(' -q ')
  })

  it.each(['RUNNING', 'CLAIMED'])('stopt niet bij een rij met status %s: exit 1, de id in de uitvoer, en geen enkele aanroep naar max2', (status) => {
    put('snap1', `${ROWS}job-c|TASK_IMPLEMENTATION|${status}|0\n`)
    const res = run()
    expect(res.code).toBe(1)
    expect(res.all).toContain('job-c')
    expect(res.out).not.toContain('veilig')
    expect(stopCalls()).toEqual([])
    expect(hostCmds()).toHaveLength(1)
  })

  it('geeft exit 1 en laat de dienst gestopt bij een verschil tussen de opnames, met het verschil in de uitvoer', () => {
    snaps(ROWS, `${ROWS}job-d|IDEA_CHAT|QUEUED|0\n`)
    const res = run()
    expect(res.code).toBe(1)
    expect(res.all).toContain('job-d')
    expect(res.out).not.toContain('veilig')
    expect(stopCalls()).toHaveLength(1)
    expect(hostCmds()).toHaveLength(4) // geen poging de dienst te starten
  })

  it('geeft exit 1 bij een verschil in alleen de status of retry_count van een rij', () => {
    snaps('job-a|IDEA_CHAT|QUEUED|0\n', 'job-a|IDEA_CHAT|QUEUED|1\n')
    expect(run().code).toBe(1)
  })

  it('telt een mislukte opname vóór de stop nooit als schoon: psql-exit ≠ 0 geeft exit 1 zonder stop, ook als de uitvoer er schoon uitziet', () => {
    put('snap1', ROWS)
    put('rc1', '3')
    const res = run()
    expect(res.code).toBe(1)
    expect(res.out).not.toContain('veilig')
    expect(stopCalls()).toEqual([])
  })

  it('telt een mislukte opname na de stop nooit als schoon: exit 1, de dienst blijft gestopt, geen tweede stop of start', () => {
    put('snap1', ROWS)
    put('snap2', ROWS)
    put('rc2', '1')
    const res = run()
    expect(res.code).toBe(1)
    expect(res.out).not.toContain('veilig')
    expect(stopCalls()).toHaveLength(1)
  })

  it.each([
    ['een commandotag', 'BEGIN\njob-a|IDEA_CHAT|DONE|0\n'],
    ['een regel met te weinig velden', 'job-a|IDEA_CHAT|DONE\n'],
    ['een foutmelding', 'ERROR: permission denied for table claude_jobs\n'],
    ['een status in kleine letters', 'job-a|IDEA_CHAT|done|0\n'],
  ])('weigert een opname met %s, ook bij exit 0', (_naam, uitvoer) => {
    put('snap1', uitvoer)
    const res = run()
    expect(res.code).toBe(1)
    expect(stopCalls()).toEqual([])
    put('snap1', ROWS)
    rmSync(join(fake, 'calls.log'))
    put('n', '0')
    put('snap2', uitvoer)
    const res2 = run()
    expect(res2.code).toBe(1)
    expect(res2.out).not.toContain('veilig')
  })

  it('telt een lege tabel (geen rijen) als geldige opname', () => {
    snaps('', '')
    const res = run()
    expect(res.code, res.all).toBe(0)
    expect(res.out).toContain('veilig')
  })

  it.each(['inactive', 'failed'])('telt %s na de stop als gestopt', (toestand) => {
    snaps(ROWS, ROWS)
    put('active', toestand)
    const res = run()
    expect(res.code, res.all).toBe(0)
    expect(hostCmds()).toHaveLength(4)
  })

  it.each([['activating'], ['active'], ['deactivating'], ['reloading'], ['']])('telt %j na de stop niet als gestopt: exit 1 zonder tweede opname', (toestand) => {
    snaps(ROWS, ROWS)
    put('active', toestand)
    put('active-rc', '255')
    const res = run()
    expect(res.code).toBe(1)
    expect(res.out).not.toContain('veilig')
    expect(hostCmds()).toHaveLength(3)
  })

  it('geeft exit 1 als de stop zelf mislukt, zonder is-active of tweede opname', () => {
    snaps(ROWS, ROWS)
    put('stop-rc', '1')
    const res = run()
    expect(res.code).toBe(1)
    expect(hostCmds()).toHaveLength(2)
  })

  it('drukt geen database-URL of geheim af en laat geen tijdelijke map achter', () => {
    snaps(ROWS, `${ROWS}job-d|IDEA_CHAT|QUEUED|0\n`)
    const res = run()
    expect(res.all).not.toMatch(/postgres(ql)?:\/\//i)
    expect(res.all).not.toMatch(/DATABASE_URL|PASSWORD|TOKEN|sk-/)
    expect(readdirSync(tmp)).toEqual([])
    snaps(ROWS, ROWS)
    run()
    expect(readdirSync(tmp)).toEqual([])
  })

  it('is draagbaar: geen GNU-only vlaggen en geen bash-4-constructies, en het draait onder bash 3.2 van macOS als die er is', () => {
    const bron = readFileSync(SCRIPT, 'utf8')
    expect(bron.split('\n')[0]).toBe('#!/bin/bash')
    for (const verboden of ['--reference', 'readlink -f', 'sed -i', 'date -d', 'mapfile', 'readarray', 'declare -A', '${!', ',,', '^^', 'grep -P', 'xargs -r', 'timeout ']) expect(bron, verboden).not.toContain(verboden)
    if (existsSync('/bin/bash')) {
      snaps(ROWS, ROWS)
      const res = run('/bin/bash')
      expect(res.code, res.all).toBe(0)
    }
  })
})

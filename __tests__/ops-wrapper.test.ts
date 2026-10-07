import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The root ops wrapper (deploy/max2/ops/agent-harness-ops.sh), driven as a black box with bash. Every command it may call
// (systemctl, runuser, git, npm, docker, curl, flock) is a stub on PATH that logs its argv; the file tools it uses (mktemp, mv,
// chmod, ...) are logging shims that exec the real binary, so a secret in an argv shows up in the log. Paths are the wrapper's
// path variables (and AH_PATH, the wrapper's fixed PATH), pointed at a temp dir (in production sudo's env_reset keeps a caller from
// doing that). `bash` is the one on the test PATH (macOS: 3.2); set OPS_BASH=/path/to/bash to run the same tests under another bash.

const SCRIPT = fileURLToPath(new URL('../deploy/max2/ops/agent-harness-ops.sh', import.meta.url))

const ACTIONS = [
  'status',
  'install',
  'stop',
  'start',
  'probe',
  'release-update',
  'release-rollback',
  'mcp-update',
  'mcp-rollback',
  'litellm-up',
  'litellm-upgrade',
] as const
const LOCK_FREE = ['status', 'stop']
const LOCKED = ACTIONS.filter((a) => !LOCK_FREE.includes(a))
/** Every invocation that takes the lock: the locked actions and provider-key with a valid name. */
const LOCKED_CASES: string[][] = [...LOCKED.map((a) => [a]), ['provider-key', 'OPENROUTER_API_KEY']]
const COMMAND_STUBS = ['systemctl', 'runuser', 'git', 'npm', 'docker', 'curl', 'flock']
const FILE_SHIMS = ['mktemp', 'mv', 'chmod', 'rm', 'cat', 'sed', 'awk', 'grep', 'tee', 'env', 'id', 'dirname', 'basename', 'cp', 'ln', 'mkdir', 'touch', 'printf']

const FAKE_KEY = 'sk-fake-not-a-real-key-0123456789'

const LOG_LINE = `printf '%s' "\${0##*/}" >> "$STUB_LOG"; for a in "$@"; do printf ' %s' "$a" >> "$STUB_LOG"; done; printf '\\n' >> "$STUB_LOG"`

let dir: string
let log: string

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), 'ops-wrapper-'))
  log = join(dir, 'calls.log')
  writeFileSync(log, '')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'etc'))
  mkdirSync(join(dir, 'state'))
  const logLine = LOG_LINE
  for (const naam of COMMAND_STUBS) {
    let body = logLine
    if (naam === 'flock') body += '\nif [ -n "$STUB_FLOCK_RC" ]; then exit "$STUB_FLOCK_RC"; fi\nif [ -n "$STUB_FLOCK_BUSY" ]; then exit 1; fi\nexit 0'
    if (naam === 'systemctl') {
      body += `\nif [ "$1" = is-active ]; then
  if [ -f "$STUB_STATE/$2" ]; then s=$(cat "$STUB_STATE/$2"); echo "$s"; [ "$s" = active ] && exit 0; exit 3; fi
  echo unknown; exit 4
fi
exit 0`
    }
    if (naam !== 'flock' && naam !== 'systemctl') body += '\nexit 0'
    writeStub(naam, body)
  }
  for (const naam of FILE_SHIMS) {
    const failHook = naam === 'mv' ? '\nif [ -n "$STUB_MV_FAIL" ]; then exit 1; fi' : ''
    writeStub(naam, `${logLine}${failHook}\nfor d in /usr/bin /bin; do [ -x "$d/\${0##*/}" ] && exec "$d/\${0##*/}" "$@"; done\nexit 127`)
  }
}

function writeStub(naam: string, body: string): void {
  const p = join(dir, 'bin', naam)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
    AH_PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
    HOME: dir,
    STUB_LOG: log,
    STUB_STATE: join(dir, 'state'),
    AH_LOCK: join(dir, 'ops.lock'),
    AH_ETC: join(dir, 'etc'),
    ...extra,
  }
}

function run(args: string[], opts: { input?: string; env?: Record<string, string>; timeout?: number } = {}): { code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
  const res = spawnSync(process.env.OPS_BASH ?? 'bash', [SCRIPT, ...args], { input: opts.input ?? '', env: env(opts.env), encoding: 'utf8', timeout: opts.timeout })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, signal: res.signal }
}

/** Source the wrapper and run a snippet with its helpers (the main dispatcher does not run when the file is sourced). */
function runHelper(snippet: string, extra: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.env.OPS_BASH ?? 'bash', ['-c', `source "${SCRIPT}"; ${snippet}`], { input: '', env: env(extra), encoding: 'utf8' })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean)
/** Calls of the stubs that stand for the outside world (the file shims are not counted). */
const stubCalls = (): string[] => calls().filter((c) => COMMAND_STUBS.includes(c.split(' ')[0]))
const litellmEnv = (): string => join(dir, 'etc', 'litellm.env')
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)

beforeEach(setup)
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ops wrapper: de actielijst', () => {
  it('geeft 64 voor een onbekende actie, geen actie of een lege actie, zonder één stub-aanroep en zonder de invoer te echoën', () => {
    for (const args of [['bestaat-niet'], [], [''], ['STATUS'], ['status;id'], [FAKE_KEY]]) {
      const res = run(args)
      expect(res.code, JSON.stringify(args)).toBe(64)
      expect(res.stdout + res.stderr).not.toContain(FAKE_KEY)
    }
    expect(calls()).toEqual([])
  })

  it('geeft 64 voor elke actie met een extra argument, zonder één stub-aanroep', () => {
    for (const actie of ACTIONS) expect(run([actie, 'extra']).code, actie).toBe(64)
    expect(run(['provider-key', 'OPENROUTER_API_KEY', 'extra']).code).toBe(64)
    expect(run(['provider-key', 'OPENROUTER_API_KEY', FAKE_KEY]).code).toBe(64)
    expect(calls()).toEqual([])
  })

  it('geeft 64 voor provider-key zonder naam of met een onbekende naam, en laat het bestand ongemoeid', () => {
    writeFileSync(litellmEnv(), 'LITELLM_MASTER_KEY=fake-master\n', { mode: 0o600 })
    for (const args of [['provider-key'], ['provider-key', 'LITELLM_MASTER_KEY'], ['provider-key', 'openrouter_api_key'], ['provider-key', 'PATH'], ['provider-key', '']]) {
      const res = run(args, { input: `${FAKE_KEY}\n` })
      expect(res.code, JSON.stringify(args)).toBe(64)
    }
    expect(readFileSync(litellmEnv(), 'utf8')).toBe('LITELLM_MASTER_KEY=fake-master\n')
    expect(calls()).toEqual([])
  })

  it('kent alle elf acties en geeft nergens meer 70: geen enkele actie is nog "niet geïmplementeerd"', () => {
    for (const actie of ACTIONS) {
      const res = run([actie])
      expect(res.code, actie).not.toBe(70)
      expect(res.stderr, actie).not.toContain('nog niet geïmplementeerd')
    }
    const bron = readFileSync(SCRIPT, 'utf8')
    expect(bron).not.toContain('not_implemented')
    expect(bron).not.toContain('nog niet geïmplementeerd')
  })

  it('neemt voor elke actie behalve status en stop eerst de exclusieve flock (flock -n 9) en maakt het lockbestand aan', () => {
    for (const args of LOCKED_CASES) {
      writeFileSync(log, '')
      rmSync(join(dir, 'ops.lock'), { force: true })
      run(args, { input: `${FAKE_KEY}\n` })
      expect(stubCalls()[0], args.join(' ')).toBe('flock -n 9')
      expect(existsSync(join(dir, 'ops.lock')), args.join(' ')).toBe(true)
    }
    for (const actie of LOCK_FREE) {
      writeFileSync(log, '')
      rmSync(join(dir, 'ops.lock'), { force: true })
      run([actie])
      expect(stubCalls().filter((c) => c.startsWith('flock')), actie).toEqual([])
      expect(existsSync(join(dir, 'ops.lock')), actie).toBe(false)
    }
  })

  it('begint met #!/bin/bash en zet een vaste standaard-PATH die alleen een eigen variabele (AH_PATH) kan vervangen', () => {
    expect(readFileSync(SCRIPT, 'utf8').split('\n')[0]).toBe('#!/bin/bash')
    const res = runHelper('printf %s "$PATH"', { AH_PATH: '' })
    expect(res.stdout).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    // the caller's PATH (with the stubs) is not used when AH_PATH is not set
    const res2 = spawnSync(process.env.OPS_BASH ?? 'bash', ['-c', `unset AH_PATH; source "${SCRIPT}"; printf %s "$PATH"`], { env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(res2.stdout).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    expect(runHelper('printf %s "$PATH"').stdout).toBe(`${join(dir, 'bin')}:/usr/bin:/bin`)
  })
})

describe('ops wrapper: één actie tegelijk', () => {
  it('geeft 75 voor elke actie behalve status en stop als de lock bezet is, zonder git-, npm-, docker-, systemctl- of runuser-aanroep', () => {
    for (const args of LOCKED_CASES) {
      writeFileSync(log, '')
      const res = run(args, { env: { STUB_FLOCK_BUSY: '1' }, input: `${FAKE_KEY}\n` })
      expect(res.code, args.join(' ')).toBe(75)
      expect(res.stderr, args.join(' ')).toContain('een andere actie loopt al')
      expect(stubCalls(), args.join(' ')).toEqual(['flock -n 9'])
    }
    expect(existsSync(litellmEnv())).toBe(false)
  })

  it('meldt een flock-fout die geen "bezet" is (rc 127, 2) apart met exit 73 en de rc, en niet als bezet', () => {
    for (const rc of ['127', '2']) {
      for (const args of LOCKED_CASES) {
        const res = run(args, { env: { STUB_FLOCK_RC: rc }, input: `${FAKE_KEY}\n` })
        expect(res.code, `${args.join(' ')} rc=${rc}`).toBe(73)
        expect(res.stderr).toContain(`lock kon niet worden genomen (rc=${rc})`)
        expect(res.stderr).not.toContain('een andere actie loopt al')
      }
    }
  })

  it('laat status en stop vrij: ze nemen de lock niet, en een bezette lock houdt ze niet tegen', () => {
    for (const actie of LOCK_FREE) {
      writeFileSync(log, '')
      const res = run([actie], { env: { STUB_FLOCK_BUSY: '1' } })
      expect(res.code, actie).not.toBe(75)
      expect(stubCalls().filter((c) => c.startsWith('flock')), actie).toEqual([])
      // stop only asks systemd to stop the service
      if (actie === 'stop') expect(stubCalls()).toEqual(['systemctl stop agent-harness.service'])
    }
  })
})

describe('ops wrapper: runuser en stilstand (helpers)', () => {
  it('draait git en npm als janpeter via runuser, nooit rechtstreeks', () => {
    const res = runHelper('owner_git -C /srv/x status; owner_npm ci')
    expect(res.code).toBe(0)
    expect(stubCalls()).toEqual(['runuser -u janpeter -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 git -C /srv/x status', 'runuser -u janpeter -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 npm ci'])
  })

  it('houdt de eigenaar en zijn home overschrijfbaar voor tests, met janpeter en /home/janpeter als vaste standaard, en zet HOME op die home (runuser behoudt HOME=/root) en GIT_TERMINAL_PROMPT=0 (nooit een prompt)', () => {
    runHelper('owner_git log; owner_npm ci', { AH_OWNER: 'tester', AH_OWNER_HOME: '/home/tester' })
    expect(stubCalls()).toEqual(['runuser -u tester -- env HOME=/home/tester GIT_TERMINAL_PROMPT=0 git log', 'runuser -u tester -- env HOME=/home/tester GIT_TERMINAL_PROMPT=0 npm ci'])
  })

  it('telt alleen inactive en failed als stilstand', () => {
    for (const toestand of ['inactive', 'failed']) {
      writeFileSync(join(dir, 'state', 'agent-harness.service'), toestand)
      expect(runHelper('require_standstill agent-harness.service').code, toestand).toBe(0)
    }
    expect(stubCalls()).toEqual(Array(2).fill('systemctl is-active agent-harness.service'))
  })

  it('weigert met 75 bij elke andere uitkomst, ook activating in de herstartpauze, een onbekende unit en een lege uitkomst', () => {
    for (const toestand of ['active', 'activating', 'deactivating', 'reloading', 'maintenance', '']) {
      writeFileSync(join(dir, 'state', 'agent-harness.service'), toestand)
      const res = runHelper('require_standstill agent-harness.service')
      expect(res.code, JSON.stringify(toestand)).toBe(75)
      expect(res.stderr).toContain('agent-harness.service')
    }
    expect(runHelper('require_standstill agent-harness.service').code).toBe(75) // geen toestandsbestand: de stub zegt unknown
  })

  it('eist stilstand van elke genoemde unit', () => {
    writeFileSync(join(dir, 'state', 'agent-harness.service'), 'inactive')
    writeFileSync(join(dir, 'state', 'agent-harness-worker.service'), 'activating')
    const res = runHelper('require_standstill agent-harness.service agent-harness-worker.service')
    expect(res.code).toBe(75)
    expect(res.stderr).toContain('agent-harness-worker.service')
    writeFileSync(join(dir, 'state', 'agent-harness-worker.service'), 'failed')
    expect(runHelper('require_standstill agent-harness.service agent-harness-worker.service').code).toBe(0)
  })
})

describe('ops wrapper: provider-key', () => {
  const MASTER = 'LITELLM_MASTER_KEY=fake-master-key-for-tests'

  const secretFree = (res: { stdout: string; stderr: string }): void => {
    expect(res.stdout).not.toContain(FAKE_KEY)
    expect(res.stderr).not.toContain(FAKE_KEY)
    expect(readFileSync(log, 'utf8')).not.toContain(FAKE_KEY)
  }

  it('voegt de regel toe als hij ontbreekt, laat de masterkey gelijk en houdt de modus 0600', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n` })
    expect(res.code, res.stderr).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\nOPENROUTER_API_KEY=${FAKE_KEY}\n`)
    expect(mode(litellmEnv())).toBe('600')
    secretFree(res)
  })

  it('vervangt de regel als hij er al is, op dezelfde plek, en laat de rest gelijk', () => {
    writeFileSync(litellmEnv(), `# eigen opmerking\n${MASTER}\nOPENROUTER_API_KEY=oude-waarde\nOPENAI_API_KEY=andere-fake-waarde\n`, { mode: 0o600 })
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n` })
    expect(res.code, res.stderr).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`# eigen opmerking\n${MASTER}\nOPENROUTER_API_KEY=${FAKE_KEY}\nOPENAI_API_KEY=andere-fake-waarde\n`)
    expect(mode(litellmEnv())).toBe('600')
    secretFree(res)
  })

  it('werkt voor alle drie de namen, en raakt een naam die een voorvoegsel is of in een opmerking staat niet aan', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n# OPENAI_API_KEY=in-een-opmerking\nOPENAI_API_KEY_EXTRA=blijft\n`, { mode: 0o600 })
    for (const naam of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(run(['provider-key', naam], { input: `${naam}-fake\n` }).code, naam).toBe(0)
    }
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(
      `${MASTER}\n# OPENAI_API_KEY=in-een-opmerking\nOPENAI_API_KEY_EXTRA=blijft\nOPENROUTER_API_KEY=OPENROUTER_API_KEY-fake\nOPENAI_API_KEY=OPENAI_API_KEY-fake\nANTHROPIC_API_KEY=ANTHROPIC_API_KEY-fake\n`,
    )
  })

  it('laat precies één regel per naam over als het bestand er twee had', () => {
    writeFileSync(litellmEnv(), `OPENROUTER_API_KEY=een\n${MASTER}\nOPENROUTER_API_KEY=twee\n`, { mode: 0o600 })
    expect(run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n` }).code).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`OPENROUTER_API_KEY=${FAKE_KEY}\n${MASTER}\n`)
  })

  it('verwerkt een bestand zonder slotnewline en een invoer zonder slotnewline', () => {
    writeFileSync(litellmEnv(), MASTER, { mode: 0o600 })
    expect(run(['provider-key', 'ANTHROPIC_API_KEY'], { input: FAKE_KEY }).code).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\nANTHROPIC_API_KEY=${FAKE_KEY}\n`)
  })

  it('maakt het bestand met modus 0600 als het ontbreekt', () => {
    const res = run(['provider-key', 'OPENAI_API_KEY'], { input: `${FAKE_KEY}\n` })
    expect(res.code, res.stderr).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`OPENAI_API_KEY=${FAKE_KEY}\n`)
    expect(mode(litellmEnv())).toBe('600')
  })

  it('zet een ruimere modus terug op 0600', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o644 })
    chmodSync(litellmEnv(), 0o644)
    expect(run(['provider-key', 'OPENAI_API_KEY'], { input: `${FAKE_KEY}\n` }).code).toBe(0)
    expect(mode(litellmEnv())).toBe('600')
  })

  it('laat geen tijdelijk bestand achter en gebruikt flock voor de lock', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    run(['provider-key', 'OPENAI_API_KEY'], { input: `${FAKE_KEY}\n` })
    expect(readdirSync(join(dir, 'etc'))).toEqual(['litellm.env'])
    expect(stubCalls()).toEqual(['flock -n 9'])
  })

  it('laat bij een mislukte vervanging het oude bestand intact en geen tijdelijk bestand achter', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n`, env: { STUB_MV_FAIL: '1' } })
    expect(res.code).toBe(73) // not a bare set -e exit 1
    expect(res.stderr).toContain('verplaatsen mislukt')
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\n`)
    expect(readdirSync(join(dir, 'etc'))).toEqual(['litellm.env'])
    secretFree(res)
  })

  it('zet de waarde in geen argv van een bestandscommando, ook niet bij een mislukte actie', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    secretFree(run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n` }))
    secretFree(run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n`, env: { STUB_FLOCK_BUSY: '1' } }))
    secretFree(run(['provider-key', 'OPENROUTER_API_KEY', FAKE_KEY], { input: `${FAKE_KEY}\n` }))
    expect(calls().length).toBeGreaterThan(0) // the shims did see the file commands
  })

  it('laat een toegestane waarde met / & + = - _ . : letterlijk landen, bij toevoegen en bij vervangen, en de rest gelijk', () => {
    const waarde = 'sk-or-v1/ab+c=d&e.f_g:h'
    writeFileSync(litellmEnv(), `${MASTER}\nOPENAI_API_KEY=blijft\n`, { mode: 0o600 })
    let res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${waarde}\n` })
    expect(res.code, res.stderr).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\nOPENAI_API_KEY=blijft\nOPENROUTER_API_KEY=${waarde}\n`)
    res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${waarde}\n` })
    expect(res.code, res.stderr).toBe(0)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\nOPENAI_API_KEY=blijft\nOPENROUTER_API_KEY=${waarde}\n`)
    expect(mode(litellmEnv())).toBe('600')
    expect(res.stdout + res.stderr).not.toContain(waarde)
    expect(readFileSync(log, 'utf8')).not.toContain(waarde)
  })

  // Compose reads an env_file value with interpolation and quoting, so these would silently become another key.
  const REFUSED: Array<[string, string]> = [
    ['dollar', 'QZXV$cd'],
    ['dollar met haakjes', 'QZXV$(id)cd'],
    ['dollar met accolades', 'QZXV${HOME}cd'],
    ['enkele quote', "QZXV'cd"],
    ['dubbele quote', 'QZXV"cd'],
    ['backtick', 'QZXV`cd'],
    ['hekje', 'QZXV#cd'],
    ['spatie', 'QZXV cd'],
    ['spatie vooraan', ' QZXVcd'],
    ['spatie achteraan', 'QZXVcd '],
    ['tab', 'QZXV\tcd'],
    ['backslash', 'QZXV\\cd'],
    ['stuurteken', 'QZXV\u0007cd'],
    ['carriage return', 'QZXV\rcd'],
    ['vijandige mix', 'QZXV/b&c\\1$HOME $(id)'],
  ]

  it.each(REFUSED)('weigert een waarde met %s (exit 64), noemt de reden maar nooit de waarde, en schrijft niets', (_klasse, waarde) => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${waarde}\n` })
    expect(res.code).toBe(64)
    expect(res.stderr).toMatch(/provider-key|waarde/)
    expect(res.stdout + res.stderr).not.toContain('QZXV')
    expect(res.stdout + res.stderr).not.toContain('HOME')
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\n`)
    expect(readdirSync(join(dir, 'etc'))).toEqual(['litellm.env'])
    expect(readFileSync(log, 'utf8')).not.toContain('QZXV')
  })

  it.each([
    ['een tweede regel', `${FAKE_KEY}\nanders-geheim\n`],
    ['een tweede lege regel', `${FAKE_KEY}\n\n`],
    ['een tweede regel zonder newline', `${FAKE_KEY}\nanders-geheim`],
    ['een eerste lege regel met data erna', `\n${FAKE_KEY}\n`],
  ])('weigert een invoer met %s (exit 64) en schrijft niets', (_klasse, input) => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input })
    expect(res.code).toBe(64)
    expect(res.stdout + res.stderr).not.toContain('anders-geheim')
    secretFree(res)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\n`)
    expect(readdirSync(join(dir, 'etc'))).toEqual(['litellm.env'])
  })

  it('weigert een lege waarde en een lege invoer (exit 64) en laat het bestand ongemoeid', () => {
    writeFileSync(litellmEnv(), `${MASTER}\n`, { mode: 0o600 })
    for (const input of ['', '\n']) expect(run(['provider-key', 'OPENROUTER_API_KEY'], { input }).code, JSON.stringify(input)).toBe(64)
    expect(readFileSync(litellmEnv(), 'utf8')).toBe(`${MASTER}\n`)
    expect(readdirSync(join(dir, 'etc'))).toEqual(['litellm.env'])
  })

  it('meldt dat de map ontbreekt in plaats van er een aan te maken', () => {
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n`, env: { AH_ETC: join(dir, 'bestaat-niet') } })
    expect(res.code).toBe(66)
    secretFree(res)
  })

  it('meldt alleen de naam en wat er gebeurde, nooit de waarde', () => {
    const res = run(['provider-key', 'OPENROUTER_API_KEY'], { input: `${FAKE_KEY}\n` })
    expect(res.stdout + res.stderr).toMatch(/OPENROUTER_API_KEY/)
    secretFree(res)
  })
})

// --- releases, units installeren en install (deel c) ------------------------------------------------------------------------

const SHA = '1234567890abcdef1234567890abcdef12345678'
const SHA2 = 'fedcba0987654321fedcba0987654321fedcba09'
const REPO_DEPLOY = fileURLToPath(new URL('../deploy', import.meta.url))
const REPO_MAX2 = join(REPO_DEPLOY, 'max2')
const MASTER_RE = /^sk-[0-9a-f]{48}$/

/** runuser runs the rest of its command line (after `-u <user> --`), so env/git/npm/touch behave as janpeter's would; clone copies the repo's own deploy/ dir. */
function installStubs(): void {
  // node is the real one: the swap must be tested on a real file system (rename(2) does not follow the link).
  symlinkSync(process.execPath, join(dir, 'bin', 'node'))
  writeStub('runuser', `${LOG_LINE}\nshift 3\nexec "$@"`)
  writeStub(
    'git',
    `${LOG_LINE}
# a repo that needs a credential: with prompts disabled git fails at once; without GIT_TERMINAL_PROMPT=0 it would sit on a prompt forever
if { [ "$1" = ls-remote ] || [ "$1" = clone ]; } && [ -n "$STUB_NEEDS_CREDENTIAL" ]; then
  if [ "$GIT_TERMINAL_PROMPT" = 0 ]; then echo 'fatal: could not read Username: terminal prompts disabled' >&2; exit 128; fi
  echo 'git would wait on a prompt' >&2; exit 99
fi
case "$1" in
  ls-remote)
    if [ -n "$STUB_LSREMOTE_OUT" ]; then printf '%s\\n' "$STUB_LSREMOTE_OUT"; else printf '%s\\trefs/heads/main\\n' "$STUB_HEAD"; fi
    exit "\${STUB_LSREMOTE_RC:-0}" ;;
  clone)
    if [ -n "$STUB_CLONE_RC" ]; then exit "$STUB_CLONE_RC"; fi
    mkdir -p "$3" && cp -R "$STUB_SRC_DEPLOY" "$3/deploy"; exit $? ;;
  -C)
    if [ "$3" = checkout ] && [ -n "$STUB_CHECKOUT_RC" ]; then exit "$STUB_CHECKOUT_RC"; fi ;;
esac
exit 0`,
  )
  writeStub('npm', `${LOG_LINE}\nprintf 'npmcwd %s\\n' "$(pwd)" >> "$STUB_LOG"\nif [ "$STUB_NPM_FAIL" = "$1" ]; then exit 1; fi\nexit 0`)
}

function installEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // chown lives in /usr/sbin on macOS; the stubs still come first
    AH_PATH: `${join(dir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AH_SRV: join(dir, 'srv'),
    AH_UNIT_DIR: join(dir, 'units'),
    AH_OWNER: userInfo().username,
    AH_OWNER_HOME: '/home/janpeter',
    AH_REPO_URL: 'https://git.example.invalid/janpeter/agent-harness.git',
    STUB_HEAD: SHA,
    STUB_SRC_DEPLOY: REPO_DEPLOY,
    ...extra,
  }
}

const srv = (...p: string[]): string => join(dir, 'srv', ...p)
const etc = (...p: string[]): string => join(dir, 'etc', ...p)
const units = (...p: string[]): string => join(dir, 'units', ...p)
const harnessEnv = (): string => etc('harness-litellm.env')
const install = (extra: Record<string, string> = {}) => run(['install'], { env: installEnv(extra) })
const systemctlCalls = (): string[] => stubCalls().filter((c) => c.startsWith('systemctl'))
const stateOf = (unit: string, state: string): void => writeFileSync(join(dir, 'state', unit), state)

/** A release dir as the build leaves it (the shape of the repo's deploy/), without calling the stubs. */
function fakeRelease(commit: string, built = true): void {
  mkdirSync(srv('releases', commit), { recursive: true })
  cpSync(REPO_DEPLOY, srv('releases', commit, 'deploy'), { recursive: true })
  if (built) writeFileSync(srv('releases', commit, '.built'), '')
}

describe('ops wrapper: install en releases (deel c)', () => {
  beforeEach(() => {
    installStubs()
    mkdirSync(units(), { recursive: true })
    stateOf('agent-harness.service', 'inactive')
  })

  describe('stilstand en lock', () => {
    it('weigert install met 75 bij active en activating, zonder git, npm, docker of daemon-reload, en maakt niets aan', () => {
      for (const toestand of ['active', 'activating', 'deactivating', '']) {
        writeFileSync(log, '')
        stateOf('agent-harness.service', toestand)
        const res = install()
        expect(res.code, JSON.stringify(toestand)).toBe(75)
        expect(res.stderr).toContain('agent-harness.service')
        expect(stubCalls(), toestand).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
      }
      expect(existsSync(srv())).toBe(false)
      expect(existsSync(etc('litellm'))).toBe(false)
      expect(existsSync(litellmEnv())).toBe(false)
    })

    it('gaat door bij inactive en failed', () => {
      for (const toestand of ['inactive', 'failed']) {
        stateOf('agent-harness.service', toestand)
        const res = install()
        expect(res.code, `${toestand}: ${res.stderr}`).toBe(0)
      }
    })

    it('geeft 75 bij een bezette lock, vóór elke andere aanroep', () => {
      const res = install({ STUB_FLOCK_BUSY: '1' })
      expect(res.code).toBe(75)
      expect(stubCalls()).toEqual(['flock -n 9'])
    })
  })

  describe('eerste install', () => {
    it('bouwt de release van origin/main als janpeter met HOME=janpeters home, wisselt current en noemt de aanroepen in de goede volgorde', () => {
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      const url = 'https://git.example.invalid/janpeter/agent-harness.git'
      const rel = srv('releases', SHA)
      const onlyOwner = stubCalls().filter((c) => c.startsWith('runuser') || c.startsWith('flock') || c.startsWith('systemctl'))
      const me = userInfo().username
      expect(onlyOwner).toEqual([
        'flock -n 9',
        'systemctl is-active agent-harness.service',
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 git ls-remote ${url} refs/heads/main`,
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 git clone ${url} ${rel}`,
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 git -C ${rel} checkout --detach ${SHA}`,
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 npm ci`,
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 npm run build`,
        `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 touch ${rel}/.built`,
        'systemctl daemon-reload', // units installeren
        'systemctl daemon-reload', // brug-unit ontbrak
      ])
      // npm draait in de releasemap, niet in de cwd van root
      const cwds = calls().filter((c) => c.startsWith('npmcwd '))
      expect(cwds).toHaveLength(2)
      for (const c of cwds) expect(c.endsWith(`/releases/${SHA}`), c).toBe(true)
      expect(existsSync(join(rel, '.built'))).toBe(true)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA}`)
      expect(existsSync(srv('current.new'))).toBe(false)
    })

    it('zet root-git nergens in: elke git- en npm-aanroep staat achter runuser', () => {
      install()
      const direct = stubCalls().filter((c) => c.split(' ')[0] === 'git' || c.split(' ')[0] === 'npm')
      // elke stub-aanroep komt via `runuser … env HOME=… git|npm` (de stubs zelf loggen daarna nog eens): tel ze tegen de runuser-regels
      const viaRunuser = stubCalls().filter((c) => c.startsWith('runuser') && / (git|npm) /.test(c))
      expect(direct.length).toBe(viaRunuser.length)
      expect(viaRunuser.length).toBeGreaterThan(0)
      for (const c of viaRunuser) expect(c).toContain('env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 ')
    })

    it('installeert beide units uit current, zonder enable of start, en laat de dienst ongestart', () => {
      install()
      for (const u of ['agent-harness.service', 'agent-harness-probe.service']) {
        expect(readFileSync(units(u), 'utf8'), u).toBe(readFileSync(join(REPO_MAX2, u), 'utf8'))
        expect(mode(units(u)), u).toBe('644')
      }
      const verbs = systemctlCalls().map((c) => c.split(' ')[1])
      expect(verbs.filter((v) => v !== 'is-active' && v !== 'daemon-reload')).toEqual([])
      expect(calls().some((c) => /^docker /.test(c))).toBe(false)
    })

    it('maakt de mappen en bestanden met de goede modi, en kopieert harness.json, config.yaml en compose.yml uit current', () => {
      install()
      expect(mode(srv())).toBe('755')
      expect(mode(srv('releases'))).toBe('755')
      expect(statSync(srv('releases')).uid).toBe(userInfo().uid)
      expect(mode(etc('litellm'))).toBe('755')
      expect(readFileSync(etc('harness.json'), 'utf8')).toBe(readFileSync(join(REPO_MAX2, 'harness.json'), 'utf8'))
      expect(readFileSync(etc('litellm', 'config.yaml'), 'utf8')).toBe(readFileSync(join(REPO_MAX2, 'litellm', 'config.yaml'), 'utf8'))
      expect(readFileSync(etc('litellm', 'compose.yml'), 'utf8')).toBe(readFileSync(join(REPO_MAX2, 'litellm', 'compose.yml'), 'utf8'))
      for (const p of [etc('harness.json'), etc('litellm', 'config.yaml'), etc('litellm', 'compose.yml')]) expect(mode(p), p).toBe('644')
      expect(readFileSync(units('litellm-ollama-bridge.service'), 'utf8')).toBe(readFileSync(join(REPO_MAX2, 'litellm', 'litellm-ollama-bridge.service'), 'utf8'))
      expect(mode(units('litellm-ollama-bridge.service'))).toBe('644')
    })

    it('maakt een masterkey van sk- plus 48 hex-tekens, schrijft die identiek naar beide env-bestanden (0600), en drukt hem nergens af', () => {
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      const m = /^LITELLM_MASTER_KEY=(.*)$/m.exec(readFileSync(litellmEnv(), 'utf8'))
      expect(m).not.toBeNull()
      const key = m![1]
      expect(key).toMatch(MASTER_RE)
      expect(readFileSync(litellmEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${key}\n`)
      expect(readFileSync(harnessEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${key}\n`)
      expect(mode(litellmEnv())).toBe('600')
      expect(mode(harnessEnv())).toBe('600')
      expect(res.stdout + res.stderr).not.toContain(key)
      expect(res.stdout + res.stderr).not.toContain('sk-')
      expect(readFileSync(log, 'utf8')).not.toContain(key)
      expect(readFileSync(log, 'utf8')).not.toContain('LITELLM_MASTER_KEY')
      // geen tijdelijk bestand achter
      expect(readdirSync(etc()).sort()).toEqual(['harness-litellm.env', 'harness.json', 'litellm', 'litellm.env'])
      expect(readdirSync(etc('litellm')).sort()).toEqual(['compose.yml', 'config.yaml'])
    })

    it('maakt twee verschillende installs onafhankelijk: een nieuwe omgeving krijgt een andere sleutel (echte willekeur)', () => {
      install()
      const eerste = readFileSync(litellmEnv(), 'utf8')
      rmSync(litellmEnv())
      rmSync(harnessEnv())
      install()
      expect(readFileSync(litellmEnv(), 'utf8')).not.toBe(eerste)
    })
  })

  describe('tweede install (idempotent)', () => {
    it('doet met een bestaande current geen git- of npm-aanroep en meldt dat de release bestaat', () => {
      expect(install().code).toBe(0)
      writeFileSync(log, '')
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain('release bestaat; bijwerken via release-update')
      const names = stubCalls().map((c) => c.split(' ')[0])
      expect(names).not.toContain('git')
      expect(names).not.toContain('npm')
      expect(names).not.toContain('docker')
      expect(stubCalls().filter((c) => c.startsWith('runuser'))).toEqual([])
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA}`)
    })

    it('laat een bestaande harness.json, bestaande LiteLLM-bestanden en beide sleutels ongemoeid', () => {
      install()
      const key = readFileSync(litellmEnv(), 'utf8')
      writeFileSync(etc('harness.json'), '{"eigen":"aanpassing"}\n')
      writeFileSync(etc('litellm', 'config.yaml'), '# eigen config\n')
      writeFileSync(etc('litellm', 'compose.yml'), '# eigen compose\n')
      chmodSync(etc('litellm', 'config.yaml'), 0o640)
      writeFileSync(harnessEnv(), 'LITELLM_MASTER_KEY=sk-eigen-andere-sleutel\n', { mode: 0o600 })
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      expect(readFileSync(etc('harness.json'), 'utf8')).toBe('{"eigen":"aanpassing"}\n')
      expect(readFileSync(etc('litellm', 'config.yaml'), 'utf8')).toBe('# eigen config\n')
      expect(readFileSync(etc('litellm', 'compose.yml'), 'utf8')).toBe('# eigen compose\n')
      expect(readFileSync(litellmEnv(), 'utf8')).toBe(key)
      expect(readFileSync(harnessEnv(), 'utf8')).toBe('LITELLM_MASTER_KEY=sk-eigen-andere-sleutel\n')
    })

    it('doet na een onveranderde brug-unit maar één daemon-reload (de units-stap)', () => {
      install()
      writeFileSync(log, '')
      install()
      expect(systemctlCalls().filter((c) => c === 'systemctl daemon-reload')).toHaveLength(1)
      expect(readdirSync(units()).filter((f) => f.includes('.bak-'))).toEqual([])
    })
  })

  describe('de sleutel uit één bron', () => {
    it('geeft harness-litellm.env dezelfde sleutel als een bestaande litellm.env, en maakt geen nieuwe', () => {
      mkdirSync(etc(), { recursive: true })
      const key = `sk-${'ab12'.repeat(12)}`
      writeFileSync(litellmEnv(), `OPENROUTER_API_KEY=fake-or\nLITELLM_MASTER_KEY=${key}\n`, { mode: 0o600 })
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      expect(readFileSync(litellmEnv(), 'utf8')).toBe(`OPENROUTER_API_KEY=fake-or\nLITELLM_MASTER_KEY=${key}\n`)
      expect(readFileSync(harnessEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${key}\n`)
      expect(mode(harnessEnv())).toBe('600')
      expect(readFileSync(log, 'utf8')).not.toContain(key)
      expect(res.stdout + res.stderr).not.toContain(key)
    })

    it('voegt de sleutel toe aan een litellm.env zonder (of met een lege) LITELLM_MASTER_KEY, met de rest ongewijzigd, en houdt modus 0600', () => {
      for (const voor of ['OPENROUTER_API_KEY=fake-or\n', 'OPENROUTER_API_KEY=fake-or\nLITELLM_MASTER_KEY=\n', 'OPENROUTER_API_KEY=fake-or']) {
        rmSync(etc(), { recursive: true, force: true })
        mkdirSync(etc(), { recursive: true })
        writeFileSync(litellmEnv(), voor, { mode: 0o644 })
        chmodSync(litellmEnv(), 0o644)
        const res = install()
        expect(res.code, res.stderr).toBe(0)
        const inhoud = readFileSync(litellmEnv(), 'utf8')
        const m = /^(OPENROUTER_API_KEY=fake-or\n)LITELLM_MASTER_KEY=(sk-[0-9a-f]{48})\n$/.exec(inhoud)
        expect(m, JSON.stringify(voor)).not.toBeNull()
        expect(mode(litellmEnv())).toBe('600')
        expect(readFileSync(harnessEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${m![2]}\n`)
      }
    })

    it('herstelt na een onderbroken install: litellm.env heeft de sleutel, harness-litellm.env ontbreekt', () => {
      install()
      const key = readFileSync(litellmEnv(), 'utf8')
      rmSync(harnessEnv())
      install()
      expect(readFileSync(litellmEnv(), 'utf8')).toBe(key)
      expect(readFileSync(harnessEnv(), 'utf8')).toBe(key)
    })
  })

  describe('de brug-unit', () => {
    it('vervangt een afwijkende brug-unit (increment 1) door die uit current, bewaart de vorige als back-up en doet daarna een daemon-reload', () => {
      const oud = '# increment 1: never enabled\n[Unit]\nDescription=oud\n'
      writeFileSync(units('litellm-ollama-bridge.service'), oud)
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      expect(readFileSync(units('litellm-ollama-bridge.service'), 'utf8')).toBe(readFileSync(join(REPO_MAX2, 'litellm', 'litellm-ollama-bridge.service'), 'utf8'))
      const back = readdirSync(units()).filter((f) => f.startsWith('litellm-ollama-bridge.service.bak-'))
      expect(back).toHaveLength(1)
      expect(readFileSync(units(back[0]), 'utf8')).toBe(oud)
      const sc = systemctlCalls()
      expect(sc.filter((c) => c === 'systemctl daemon-reload')).toHaveLength(2) // units-stap + na de vervanging
      expect(sc[sc.length - 1]).toBe('systemctl daemon-reload')
    })

    it('laat een brug-unit die gelijk is aan die uit current ongemoeid (geen back-up)', () => {
      const src = readFileSync(join(REPO_MAX2, 'litellm', 'litellm-ollama-bridge.service'), 'utf8')
      writeFileSync(units('litellm-ollama-bridge.service'), src)
      install()
      expect(readdirSync(units()).filter((f) => f.includes('.bak-'))).toEqual([])
      expect(systemctlCalls().filter((c) => c === 'systemctl daemon-reload')).toHaveLength(1)
    })
  })

  describe('de build', () => {
    it('slaat een release met .built over zonder git- of npm-aanroep', () => {
      mkdirSync(srv('releases'), { recursive: true })
      fakeRelease(SHA)
      const res = runHelper(`build_release ${SHA}`, installEnv())
      expect(res.code, res.stderr).toBe(0)
      expect(stubCalls()).toEqual([])
    })

    it('verwijdert een onvolledige releasemap eerst (een afgebroken aanvraag) en bouwt opnieuw, met .built pas aan het eind', () => {
      fakeRelease(SHA, false)
      writeFileSync(srv('releases', SHA, 'half-gebouwd'), 'x')
      const res = runHelper(`build_release ${SHA}`, installEnv())
      expect(res.code, res.stderr).toBe(0)
      expect(existsSync(srv('releases', SHA, 'half-gebouwd'))).toBe(false)
      expect(existsSync(srv('releases', SHA, '.built'))).toBe(true)
      const names = stubCalls().filter((c) => c.startsWith('runuser')).map((c) => c.replace(/^runuser -u \S+ -- env HOME=\S+ GIT_TERMINAL_PROMPT=0 /, ''))
      expect(names.map((n) => n.split(' ').slice(0, 2).join(' '))).toEqual(['rm -rf', 'git clone', 'git -C', 'npm ci', 'npm run', 'touch ' + srv('releases', SHA, '.built')].map((x) => x))
    })

    it.each([
      ['clone', { STUB_CLONE_RC: '128' }],
      ['checkout', { STUB_CHECKOUT_RC: '1' }],
      ['npm ci', { STUB_NPM_FAIL: 'ci' }],
      ['npm run build', { STUB_NPM_FAIL: 'run' }],
    ])('geeft 74 bij een mislukte %s, zonder .built en zonder current aan te raken', (_naam, extra) => {
      fakeRelease(SHA2)
      symlinkSync(`releases/${SHA2}`, srv('current'))
      const res = runHelper(`build_release ${SHA}`, installEnv(extra))
      expect(res.code).toBe(74)
      expect(existsSync(srv('releases', SHA, '.built'))).toBe(false)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA2}`)
      // een volgende poging begint schoon
      expect(runHelper(`build_release ${SHA}`, installEnv()).code).toBe(0)
      expect(existsSync(srv('releases', SHA, '.built'))).toBe(true)
    })

    it('laat install bij een mislukte build zonder current, zonder units en zonder sleutel achter', () => {
      const res = install({ STUB_NPM_FAIL: 'run' })
      expect(res.code).toBe(74)
      expect(existsSync(srv('current'))).toBe(false)
      expect(readdirSync(units())).toEqual([])
      expect(existsSync(litellmEnv())).toBe(false)
      expect(systemctlCalls().filter((c) => c === 'systemctl daemon-reload')).toEqual([])
    })

    it.each(['', 'main', '../x', 'ABCDEF', SHA.slice(1), `${SHA}0`, `${SHA};id`])('weigert de commit %j (64), zonder één aanroep', (commit) => {
      const res = runHelper(`build_release '${commit}'`, installEnv())
      expect(res.code).toBe(64)
      expect(stubCalls()).toEqual([])
    })

    it('geeft 74 als ls-remote geen geldige commit levert, zonder te clonen', () => {
      for (const extra of [{ STUB_LSREMOTE_OUT: 'geen-sha\trefs/heads/main' }, { STUB_LSREMOTE_OUT: '' }, { STUB_LSREMOTE_RC: '128' }]) {
        writeFileSync(log, '')
        const res = install({ ...extra, STUB_HEAD: '' })
        expect(res.code, JSON.stringify(extra)).toBe(74)
        expect(stubCalls().some((c) => / git clone /.test(c))).toBe(false)
        expect(existsSync(srv('current'))).toBe(false)
      }
    })
  })

  describe('current wisselen (echte node, echt bestandssysteem)', () => {
    const swap = (commit: string) => runHelper(`swap_current ${commit}`, installEnv())

    it('maakt current als hij nog niet bestaat, met een relatief linkdoel', () => {
      fakeRelease(SHA)
      const res = swap(SHA)
      expect(res.code, res.stderr).toBe(0)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA}`)
      expect(existsSync(srv('current', 'deploy', 'max2', 'agent-harness.service'))).toBe(true)
      expect(existsSync(srv('current.new'))).toBe(false)
    })

    it('vervangt een bestaande current atomair door de nieuwe release', () => {
      fakeRelease(SHA2)
      symlinkSync(`releases/${SHA2}`, srv('current'))
      fakeRelease(SHA)
      expect(swap(SHA).code).toBe(0)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA}`)
      expect(readdirSync(srv()).sort()).toEqual(['current', 'releases'])
    })

    it('laat een achtergebleven current.new (onderbroken wissel) de oude release niet vervuilen: geen link ín de oude release, current wijst naar de nieuwe', () => {
      fakeRelease(SHA2)
      symlinkSync(`releases/${SHA2}`, srv('current'))
      symlinkSync(`releases/${SHA2}`, srv('current.new')) // de gemeten val: `ln -s releases/C current.new` zou een link ín releases/B maken
      fakeRelease(SHA)
      const before = readdirSync(srv('releases', SHA2)).sort()
      const res = swap(SHA)
      expect(res.code, res.stderr).toBe(0)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA}`)
      expect(readdirSync(srv('releases', SHA2)).sort()).toEqual(before)
      expect(existsSync(srv('current.new'))).toBe(false)
    })

    it('wisselt met ln of mv nooit: die volgen een bestaande link naar een map', () => {
      fakeRelease(SHA)
      swap(SHA)
      // current.new als link naar een map: de wissel gebruikt alleen node
      expect(calls().filter((c) => /^(ln|mv) /.test(c))).toEqual([])
    })

    it('weigert een release zonder .built (current blijft zoals hij was) en een ongeldige commit', () => {
      fakeRelease(SHA2)
      symlinkSync(`releases/${SHA2}`, srv('current'))
      fakeRelease(SHA, false)
      expect(swap(SHA).code).toBe(66)
      expect(swap('../x').code).toBe(64)
      expect(readlinkSync(srv('current'))).toBe(`releases/${SHA2}`)
    })

    it('weigert (74) als current een gewone map is, en laat die ongemoeid', () => {
      fakeRelease(SHA)
      mkdirSync(srv('current'))
      writeFileSync(srv('current', 'x'), 'bewaar')
      expect(swap(SHA).code).toBe(74)
      expect(readFileSync(srv('current', 'x'), 'utf8')).toBe('bewaar')
    })
  })

  describe('hardening (fix ronde 1)', () => {
    it('draait git zonder prompt: een ontbrekende credential laat install met 74 falen in plaats van te blijven hangen', () => {
      const res = install({ STUB_NEEDS_CREDENTIAL: '1' })
      expect(res.code, res.stderr).toBe(74)
      expect(existsSync(srv('current'))).toBe(false)
      expect(res.stderr).toContain('terminal prompts disabled')
      expect(res.stderr).not.toContain('would wait on a prompt')
      // ook de clone zelf (ls-remote niet nodig): build_release faalt met 74
      const res2 = runHelper(`build_release ${SHA}`, installEnv({ STUB_NEEDS_CREDENTIAL: '1' }))
      expect(res2.code).toBe(74)
      expect(res2.stderr).toContain('terminal prompts disabled')
      expect(existsSync(srv('releases', SHA, '.built'))).toBe(false)
    })

    it.each(['max2/agent-harness.service', 'max2/agent-harness-probe.service', 'max2/harness.json', 'max2/litellm/config.yaml', 'max2/litellm/compose.yml', 'max2/litellm/litellm-ollama-bridge.service'])(
      'weigert (66) een bronbestand dat een symlink is (%s): root kopieert nooit de inhoud van een link, ook niet naar een 0644-doel',
      (rel) => {
        const geheim = join(dir, 'geheim.env')
        writeFileSync(geheim, 'LITELLM_MASTER_KEY=sk-niet-kopieren\n', { mode: 0o600 })
        const bron = join(dir, 'deploy-src')
        cpSync(REPO_DEPLOY, bron, { recursive: true })
        rmSync(join(bron, rel))
        symlinkSync(geheim, join(bron, rel))
        const res = install({ STUB_SRC_DEPLOY: bron })
        expect(res.code, res.stderr).toBe(66)
        expect(res.stderr).toContain('symlink')
        // nergens in de doelmappen staat de inhoud van de link
        for (const d of [units(), etc(), etc('litellm')]) {
          for (const f of existsSync(d) ? readdirSync(d) : []) {
            const pad = join(d, f)
            if (statSync(pad).isFile()) expect(readFileSync(pad, 'utf8'), pad).not.toContain('sk-niet-kopieren')
          }
        }
      },
    )

    it('zet de modus van bestaande sleutelbestanden terug op 0600 (litellm.env en harness-litellm.env) bij een tweede install', () => {
      const key = `sk-${'cd34'.repeat(12)}`
      mkdirSync(etc(), { recursive: true })
      writeFileSync(litellmEnv(), `LITELLM_MASTER_KEY=${key}\n`)
      writeFileSync(harnessEnv(), `LITELLM_MASTER_KEY=${key}\n`)
      chmodSync(litellmEnv(), 0o644)
      chmodSync(harnessEnv(), 0o664)
      const res = install()
      expect(res.code, res.stderr).toBe(0)
      expect(mode(litellmEnv())).toBe('600')
      expect(mode(harnessEnv())).toBe('600')
      expect(readFileSync(litellmEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${key}\n`)
      expect(readFileSync(harnessEnv(), 'utf8')).toBe(`LITELLM_MASTER_KEY=${key}\n`)
    })

    it('zet litellm.env op 0600 als alleen harness-litellm.env ontbreekt (bestaande sleutel, ruime modus)', () => {
      mkdirSync(etc(), { recursive: true })
      writeFileSync(litellmEnv(), `LITELLM_MASTER_KEY=sk-${'ef56'.repeat(12)}\n`)
      chmodSync(litellmEnv(), 0o644)
      expect(install().code).toBe(0)
      expect(mode(litellmEnv())).toBe('600')
      expect(mode(harnessEnv())).toBe('600')
    })

    it('verwijdert bij een onvolledige releasemap die een symlink naar een map is alleen de link, niet de map waar hij heen wijst', () => {
      const doel = join(dir, 'doelmap')
      mkdirSync(doel)
      writeFileSync(join(doel, 'sentinel'), 'blijft')
      mkdirSync(srv('releases'), { recursive: true })
      symlinkSync(doel, srv('releases', SHA))
      const res = runHelper(`build_release ${SHA}`, installEnv())
      expect(res.code, res.stderr).toBe(0)
      expect(readFileSync(join(doel, 'sentinel'), 'utf8')).toBe('blijft')
      expect(readdirSync(doel)).toEqual(['sentinel'])
      expect(lstatSync(srv('releases', SHA)).isSymbolicLink()).toBe(false)
      expect(existsSync(srv('releases', SHA, '.built'))).toBe(true)
    })
  })
})

// --- stop, start, probe, release-update/-rollback en mcp-update/-rollback (deel d) ---------------------------------------------

const RA = 'a1'.repeat(20)
const RB = 'b2'.repeat(20)
const RC = 'c3'.repeat(20)

describe('ops wrapper: stop, start, probe, release-* en mcp-* (deel d)', () => {
  const me = userInfo().username
  const OWNER = `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 `
  const VAR = (): string => join(dir, 'var')
  const MCP = (): string => join(dir, 'mcp')
  const MCPSTATE = (): string => join(dir, 'mcpstate')
  const prevFile = (): string => join(VAR(), 'release.prev')
  const builtFile = (): string => join(VAR(), 'mcp.built')
  const mcpPrevFile = (): string => join(VAR(), 'mcp.prev')
  const read = (p: string): string => readFileSync(p, 'utf8')
  /** The calls that matter for order: the owner commands (without the runuser prefix), flock and systemctl. */
  const view = (): string[] =>
    stubCalls()
      .filter((c) => c.startsWith('runuser') || c.startsWith('flock') || c.startsWith('systemctl'))
      .map((c) => c.replace(OWNER, ''))
  const dEnv = (extra: Record<string, string> = {}): Record<string, string> =>
    installEnv({ AH_STATE_DIR: VAR(), AH_MCP_DIR: MCP(), STUB_MCP: MCPSTATE(), STUB_REAL_NODE: process.execPath, ...extra })
  const act = (action: string, extra: Record<string, string> = {}) => run([action], { env: dEnv(extra) })
  const current = (): string => readlinkSync(srv('current'))
  const point = (commit: string): void => {
    rmSync(srv('current'), { force: true })
    symlinkSync(`releases/${commit}`, srv('current'))
  }
  /** `current` -> B and, optionally, release.prev -> A: the starting point of most release tests. */
  const releases = (cur: string, prev?: string): void => {
    mkdirSync(srv('releases'), { recursive: true })
    fakeRelease(cur)
    point(cur)
    if (prev) {
      fakeRelease(prev)
      writeFileSync(prevFile(), `${prev}\n`)
    }
  }
  const failNodeOnce = (): void => writeFileSync(join(dir, 'state', 'node-fail-once'), '')
  const failReloadOnce = (): void => writeFileSync(join(dir, 'state', 'fail-reload-once'), '')

  /** git, npm and the checkout as one fake mcp-stable: HEAD and origin/main are files; flags in STUB_MCP make steps fail. */
  function mcpSetup(): void {
    mkdirSync(MCP())
    mkdirSync(MCPSTATE())
    writeFileSync(join(MCPSTATE(), 'head'), `${RA}\n`)
    writeFileSync(join(MCPSTATE(), 'remote'), `${RB}\n`)
    writeStub(
      'git',
      `${LOG_LINE}
M="$STUB_MCP"
[ "$1" = -C ] && shift 2
case "$1" in
status) [ -f "$M/dirty" ] && echo ' M prisma/schema.prisma'; [ -f "$M/generated" ] && [ -f "$M/dirty-after-generate" ] && echo ' M prisma/schema.prisma'; exit 0 ;;
fetch) [ -f "$M/fail-fetch" ] && exit 1; exit 0 ;;
rev-parse) case "$2" in origin/main) cat "$M/remote" ;; HEAD) cat "$M/head" ;; *) exit 1 ;; esac; exit 0 ;;
merge) [ "$2" = --ff-only ] || exit 2; [ -f "$M/fail-merge" ] && exit 1; printf '%s\\n' "$3" > "$M/head"; exit 0 ;;
reset) [ "$2" = --hard ] || exit 2; [ -f "$M/fail-reset" ] && exit 1; printf '%s\\n' "$3" > "$M/head"; rm -f "$M/dirty" "$M/generated"; exit 0 ;;
submodule) [ -f "$M/fail-submodule" ] && exit 1; exit 0 ;;
esac
exit 0`,
    )
    writeStub(
      'npm',
      `${LOG_LINE}
printf 'npmcwd %s\\n' "$(pwd)" >> "$STUB_LOG"
if [ "$STUB_NPM_FAIL" = "$1" ] || [ "$STUB_NPM_FAIL" = "$1 $2" ]; then exit 1; fi
if [ "$1 $2" = "run prisma:generate" ]; then : > "$STUB_MCP/generated"; fi
exit 0`,
    )
  }
  const gitCallsAll = (): string[] => view().filter((c) => c.startsWith('git '))

  beforeEach(() => {
    installStubs()
    mkdirSync(units(), { recursive: true })
    mkdirSync(VAR())
    stateOf('agent-harness.service', 'inactive')
    stateOf('agent-harness-worker.service', 'inactive')
    // node: the real one, except that a flag file makes the next call fail once (an interruption inside the switch)
    rmSync(join(dir, 'bin', 'node'))
    // (the flag fails only the switch of \`current\`; STUB_STATE_WRITE_FAIL fails every state-file writer; STUB_NODE_PRELOAD preloads a module)
    writeStub(
      'node',
      `case "$*" in
  *current.new*) if [ -f "$STUB_STATE/node-fail-once" ]; then rm -f "$STUB_STATE/node-fail-once"; exit 1; fi ;;
  *'"wx"'*) if [ -n "$STUB_STATE_WRITE_FAIL" ]; then exit 1; fi ;;
esac
exec "$STUB_REAL_NODE" \${STUB_NODE_PRELOAD:+-r "$STUB_NODE_PRELOAD"} "$@"`,
    )
    // systemctl: is-active from the state files; daemon-reload fails once on a flag; start can be given an exit code
    writeStub(
      'systemctl',
      `${LOG_LINE}
if [ "$1" = is-active ]; then
  if [ -f "$STUB_STATE/$2" ]; then s=$(cat "$STUB_STATE/$2"); echo "$s"; [ "$s" = active ] && exit 0; exit 3; fi
  echo unknown; exit 4
fi
if [ "$1" = daemon-reload ] && [ -f "$STUB_STATE/fail-reload-once" ]; then rm -f "$STUB_STATE/fail-reload-once"; exit 1; fi
if [ "$1" = start ] && [ -n "$STUB_START_RC" ]; then exit "$STUB_START_RC"; fi
exit 0`,
    )
  })

  describe('stop, start en probe', () => {
    it('stop vraagt systemd de dienst te stoppen, zonder lock en zonder andere aanroep', () => {
      const res = act('stop', { STUB_FLOCK_BUSY: '1' })
      expect(res.code, res.stderr).toBe(0)
      expect(stubCalls()).toEqual(['systemctl stop agent-harness.service'])
    })

    it('stop geeft de fout van systemctl door', () => {
      writeStub('systemctl', `${LOG_LINE}\nexit 5`)
      expect(act('stop').code).toBe(5)
    })

    describe('start', () => {
      const ready = (): void => {
        writeFileSync(units('agent-harness.service'), '[Service]\n')
        writeFileSync(etc('harness.json'), '{}')
        releases(RB)
      }

      it('start de dienst als unit, harness.json en current er zijn, na de lock', () => {
        ready()
        const res = act('start')
        expect(res.code, res.stderr).toBe(0)
        expect(stubCalls()).toEqual(['flock -n 9', 'systemctl start agent-harness.service'])
      })

      it.each([
        ['de unit', () => rmSync(units('agent-harness.service'))],
        ['harness.json', () => rmSync(etc('harness.json'))],
        ['current', () => rmSync(srv('current'))],
        ['current als dode link', () => point(RC)],
      ])('weigert (66) als %s ontbreekt, zonder systemctl start', (_naam, breek) => {
        ready()
        breek()
        const res = act('start')
        expect(res.code, res.stderr).toBe(66)
        expect(stubCalls().filter((c) => c.startsWith('systemctl start'))).toEqual([])
      })

      it('geeft 75 bij een bezette lock, zonder systemctl-aanroep', () => {
        ready()
        const res = act('start', { STUB_FLOCK_BUSY: '1' })
        expect(res.code).toBe(75)
        expect(stubCalls()).toEqual(['flock -n 9'])
      })
    })

    describe('probe', () => {
      it('start de probe-unit (blokkerend) en slaagt alleen als systemctl slaagt', () => {
        const res = act('probe')
        expect(res.code, res.stderr).toBe(0)
        expect(stubCalls()).toEqual(['flock -n 9', 'systemctl start agent-harness-probe.service'])
      })

      it('geeft de exitcode van systemctl door als de probe-unit faalt', () => {
        const res = act('probe', { STUB_START_RC: '5' })
        expect(res.code).toBe(5)
        expect(stubCalls()).toEqual(['flock -n 9', 'systemctl start agent-harness-probe.service'])
      })

      it('geeft 75 bij een bezette lock, zonder systemctl-aanroep', () => {
        const res = act('probe', { STUB_FLOCK_BUSY: '1' })
        expect(res.code).toBe(75)
        expect(stubCalls()).toEqual(['flock -n 9'])
      })
    })
  })

  describe('stilstand en lock van release-* en mcp-*', () => {
    const ACTIES = ['release-update', 'release-rollback', 'mcp-update', 'mcp-rollback']

    it.each(ACTIES)('%s weigert (75) bij active, activating en een andere uitkomst dan inactive/failed, zonder git, npm, docker of daemon-reload', (actie) => {
      for (const toestand of ['active', 'activating', 'deactivating', '']) {
        writeFileSync(log, '')
        stateOf('agent-harness.service', toestand)
        const res = act(actie)
        expect(res.code, `${actie} ${JSON.stringify(toestand)}`).toBe(75)
        expect(stubCalls()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
      }
    })

    it.each(['mcp-update', 'mcp-rollback'])('%s weigert (75) ook bij een actieve of activerende oude dienst, zonder git of npm', (actie) => {
      for (const toestand of ['active', 'activating']) {
        writeFileSync(log, '')
        stateOf('agent-harness-worker.service', toestand)
        const res = act(actie)
        expect(res.code, `${actie} ${toestand}`).toBe(75)
        expect(res.stderr).toContain('agent-harness-worker.service')
        expect(stubCalls()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', 'systemctl is-active agent-harness-worker.service'])
      }
    })

    it.each(['release-update', 'release-rollback'])('%s eist niets van de oude dienst: die mag draaien', (actie) => {
      stateOf('agent-harness-worker.service', 'active')
      writeFileSync(log, '')
      act(actie)
      expect(stubCalls().filter((c) => c.includes('agent-harness-worker.service'))).toEqual([])
    })

    it.each(['failed', 'inactive'])('gaat bij %s door: geen weigering om de stilstand (een andere uitkomst kan er nog wel zijn)', (toestand) => {
      stateOf('agent-harness.service', toestand)
      stateOf('agent-harness-worker.service', toestand)
      for (const actie of ACTIES) {
        const res = act(actie)
        expect(res.stderr, actie).not.toContain('is niet gestopt')
        expect(stubCalls().filter((c) => c.startsWith('systemctl is-active')).length, actie).toBeGreaterThan(0)
      }
    })

    it.each(['start', 'probe', ...ACTIES])('%s geeft 75 bij een bezette lock en doet geen enkele andere aanroep', (actie) => {
      const res = act(actie, { STUB_FLOCK_BUSY: '1' })
      expect(res.code).toBe(75)
      expect(stubCalls()).toEqual(['flock -n 9'])
    })
  })

  describe('release-update', () => {
    it('bouwt in releases/<commit>, schrijft release.prev, wisselt current pas daarna, installeert de units en drukt oud → nieuw af', () => {
      releases(RB, RA)
      const res = act('release-update', { STUB_HEAD: RC })
      expect(res.code, res.stderr).toBe(0)
      const url = 'https://git.example.invalid/janpeter/agent-harness.git'
      const rel = srv('releases', RC)
      expect(view()).toEqual([
        'flock -n 9',
        'systemctl is-active agent-harness.service',
        `git ls-remote ${url} refs/heads/main`,
        `git clone ${url} ${rel}`,
        `git -C ${rel} checkout --detach ${RC}`,
        'npm ci',
        'npm run build',
        `touch ${rel}/.built`,
        'systemctl daemon-reload',
      ])
      expect(existsSync(join(rel, '.built'))).toBe(true)
      expect(current()).toBe(`releases/${RC}`)
      expect(read(prevFile())).toBe(`${RB}\n`)
      expect(res.stdout).toContain(`${RB} → ${RC}`)
      expect(readdirSync(VAR()).sort()).toEqual(['release.prev'])
      expect(existsSync(units('agent-harness.service'))).toBe(true)
      expect(existsSync(units('agent-harness-probe.service'))).toBe(true)
      expect(stubCalls().filter((c) => /^systemctl (enable|start)/.test(c))).toEqual([])
    })

    it('maakt release.prev als hij er nog niet is (de eerste update na install)', () => {
      releases(RB)
      expect(existsSync(prevFile())).toBe(false)
      expect(act('release-update', { STUB_HEAD: RC }).code).toBe(0)
      expect(read(prevFile())).toBe(`${RB}\n`)
    })

    it('laat bij een falende build, twee keer na elkaar, current en release.prev gelijk', () => {
      releases(RB, RA)
      for (const poging of [1, 2]) {
        const res = act('release-update', { STUB_HEAD: RC, STUB_NPM_FAIL: 'run' })
        expect(res.code, `poging ${poging}`).toBe(74)
        expect(current(), `poging ${poging}`).toBe(`releases/${RB}`)
        expect(read(prevFile()), `poging ${poging}`).toBe(`${RA}\n`)
        expect(existsSync(srv('releases', RC, '.built'))).toBe(false)
      }
      expect(readdirSync(VAR()).sort()).toEqual(['release.prev'])
      expect(stubCalls().filter((c) => c === 'systemctl daemon-reload')).toEqual([])
    })

    it('laat bij een falende build zonder release.prev er ook geen achter', () => {
      releases(RB)
      expect(act('release-update', { STUB_HEAD: RC, STUB_CLONE_RC: '128' }).code).toBe(74)
      expect(existsSync(prevFile())).toBe(false)
      expect(current()).toBe(`releases/${RB}`)
    })

    it('verwijdert een onvolledige releases/<commit> vóór het bouwen', () => {
      releases(RB, RA)
      fakeRelease(RC, false)
      writeFileSync(srv('releases', RC, 'half-gebouwd'), 'x')
      const res = act('release-update', { STUB_HEAD: RC })
      expect(res.code, res.stderr).toBe(0)
      expect(existsSync(srv('releases', RC, 'half-gebouwd'))).toBe(false)
      expect(existsSync(srv('releases', RC, '.built'))).toBe(true)
      const stappen = view().map((c) => c.split(' ').slice(0, 2).join(' '))
      expect(stappen.indexOf('rm -rf')).toBeLessThan(stappen.indexOf('git clone'))
    })

    it('maakt na een onderbreking tussen het schrijven van release.prev en de wissel dezelfde update af: current → C en release.prev → B', () => {
      releases(RB, RA)
      failNodeOnce()
      const res1 = act('release-update', { STUB_HEAD: RC })
      expect(res1.code).toBe(74)
      expect(current()).toBe(`releases/${RB}`)
      expect(read(prevFile())).toBe(`${RB}\n`) // al geschreven, de wissel nog niet
      writeFileSync(log, '')
      const res2 = act('release-update', { STUB_HEAD: RC })
      expect(res2.code, res2.stderr).toBe(0)
      expect(current()).toBe(`releases/${RC}`)
      expect(read(prevFile())).toBe(`${RB}\n`)
      expect(stubCalls().filter((c) => / (clone|npm) /.test(c) || / git clone /.test(c))).toEqual([]) // de release was al gebouwd
      expect(existsSync(units('agent-harness.service'))).toBe(true)
    })

    it('maakt na een onderbreking tussen de wissel en de units alleen de units af, en laat release.prev staan', () => {
      releases(RB, RA)
      failReloadOnce()
      expect(act('release-update', { STUB_HEAD: RC }).code).not.toBe(0)
      expect(current()).toBe(`releases/${RC}`)
      expect(read(prevFile())).toBe(`${RB}\n`)
      writeFileSync(log, '')
      const res = act('release-update', { STUB_HEAD: RC })
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', `git ls-remote https://git.example.invalid/janpeter/agent-harness.git refs/heads/main`, 'systemctl daemon-reload'])
      expect(current()).toBe(`releases/${RC}`)
      expect(read(prevFile())).toBe(`${RB}\n`)
    })

    it('doet bij een herhaling na succes alleen units installeren: geen build, geen wissel, release.prev blijft B', () => {
      releases(RB, RA)
      expect(act('release-update', { STUB_HEAD: RC }).code).toBe(0)
      writeFileSync(log, '')
      const res = act('release-update', { STUB_HEAD: RC })
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', `git ls-remote https://git.example.invalid/janpeter/agent-harness.git refs/heads/main`, 'systemctl daemon-reload'])
      expect(read(prevFile())).toBe(`${RB}\n`)
      expect(res.stdout).not.toContain('→')
    })

    it('laat een achtergebleven current.new → releases/B de oude release niet vervuilen: current → C en releases/B ongewijzigd', () => {
      releases(RB, RA)
      symlinkSync(`releases/${RB}`, srv('current.new'))
      const voor = readdirSync(srv('releases', RB)).sort()
      const res = act('release-update', { STUB_HEAD: RC })
      expect(res.code, res.stderr).toBe(0)
      expect(current()).toBe(`releases/${RC}`)
      expect(readdirSync(srv('releases', RB)).sort()).toEqual(voor)
      expect(existsSync(srv('current.new'))).toBe(false)
    })

    it('geeft 74 als ls-remote faalt of geen geldige commit levert, en verandert niets', () => {
      releases(RB, RA)
      for (const extra of [{ STUB_LSREMOTE_OUT: 'geen-sha\trefs/heads/main' }, { STUB_LSREMOTE_OUT: '' }, { STUB_LSREMOTE_RC: '128' }]) {
        const res = act('release-update', { ...extra, STUB_HEAD: '' })
        expect(res.code, JSON.stringify(extra)).toBe(74)
      }
      expect(current()).toBe(`releases/${RB}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
      expect(stubCalls().some((c) => / git clone /.test(c))).toBe(false)
    })

    it('geeft 66 zonder current (eerst install) en zonder de map voor de toestandsbestanden, vóór elke git-aanroep', () => {
      mkdirSync(srv('releases'), { recursive: true })
      expect(act('release-update', { STUB_HEAD: RC }).code).toBe(66)
      releases(RB)
      rmSync(VAR(), { recursive: true })
      expect(act('release-update', { STUB_HEAD: RC }).code).toBe(66)
      expect(stubCalls().some((c) => / git /.test(c))).toBe(false)
    })

    it('geeft 74 als current niet naar releases/<commit> wijst, en verandert niets', () => {
      mkdirSync(srv('releases'), { recursive: true })
      symlinkSync('/elders', srv('current'))
      expect(act('release-update', { STUB_HEAD: RC }).code).toBe(74)
      expect(readlinkSync(srv('current'))).toBe('/elders')
    })
  })

  describe('release-rollback', () => {
    it('wisselt current naar release.prev zonder build, laat release.prev staan, installeert de units en drukt oud → nieuw af', () => {
      releases(RB, RA)
      const res = act('release-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(current()).toBe(`releases/${RA}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', 'systemctl daemon-reload'])
      expect(stubCalls().filter((c) => /^(git|npm|docker|curl) /.test(c))).toEqual([])
      expect(res.stdout).toContain(`${RB} → ${RA}`)
      expect(readdirSync(VAR()).sort()).toEqual(['release.prev'])
    })

    it('doet bij een tweede aanroep alleen units installeren, en verandert release.prev niet', () => {
      releases(RB, RA)
      expect(act('release-rollback').code).toBe(0)
      writeFileSync(log, '')
      const res = act('release-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', 'systemctl daemon-reload'])
      expect(current()).toBe(`releases/${RA}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
    })

    it('maakt een terugzetting af die vóór de wissel is onderbroken (de node-stub faalt één keer): daarna current → A', () => {
      releases(RB, RA)
      failNodeOnce()
      expect(act('release-rollback').code).toBe(74)
      expect(current()).toBe(`releases/${RB}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
      const res = act('release-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(current()).toBe(`releases/${RA}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
    })

    it('maakt een terugzetting af die na de wissel is onderbroken (de systemctl-stub faalt één keer): daarna current → A en de units geïnstalleerd', () => {
      releases(RB, RA)
      failReloadOnce()
      expect(act('release-rollback').code).not.toBe(0)
      expect(current()).toBe(`releases/${RA}`)
      writeFileSync(log, '')
      const res = act('release-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service', 'systemctl daemon-reload'])
      expect(current()).toBe(`releases/${RA}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
    })

    it('laat een achtergebleven current.new → releases/B de release B niet vervuilen: current → A en releases/B ongewijzigd', () => {
      releases(RB, RA)
      symlinkSync(`releases/${RB}`, srv('current.new'))
      const voor = readdirSync(srv('releases', RB)).sort()
      const res = act('release-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(current()).toBe(`releases/${RA}`)
      expect(readdirSync(srv('releases', RB)).sort()).toEqual(voor)
      expect(existsSync(srv('current.new'))).toBe(false)
    })

    it('geeft 75 zonder release.prev (zoals na de eerste installatie), zonder die release, of zonder zijn .built, en laat current ongemoeid', () => {
      releases(RB)
      expect(act('release-rollback').code).toBe(75)
      writeFileSync(prevFile(), `${RA}\n`) // release A bestaat niet
      expect(act('release-rollback').code).toBe(75)
      fakeRelease(RA, false) // niet gebouwd
      expect(act('release-rollback').code).toBe(75)
      writeFileSync(prevFile(), 'geen-commit\n')
      expect(act('release-rollback').code).toBe(75)
      expect(current()).toBe(`releases/${RB}`)
      expect(stubCalls().filter((c) => c === 'systemctl daemon-reload')).toEqual([])
    })

    it('laat release-update daarna weer vooruit gaan, met de teruggezette release als release.prev', () => {
      releases(RB, RA)
      expect(act('release-rollback').code).toBe(0)
      const res = act('release-update', { STUB_HEAD: RB })
      expect(res.code, res.stderr).toBe(0)
      expect(current()).toBe(`releases/${RB}`)
      expect(read(prevFile())).toBe(`${RA}\n`)
    })
  })

  describe('mcp-update en mcp-rollback', () => {
    const flag = (name: string): void => writeFileSync(join(MCPSTATE(), name), '')
    const unflag = (name: string): void => rmSync(join(MCPSTATE(), name), { force: true })
    const head = (): string => read(join(MCPSTATE(), 'head')).trim()
    const gitCalls = (): string[] => view().filter((c) => c.startsWith('git '))
    const writes = (): string[] => gitCalls().filter((c) => / (fetch|merge|pull)( |$)/.test(c))
    const setBuilt = (c: string): void => writeFileSync(builtFile(), `${c}\n`)
    const setRemote = (c: string): void => writeFileSync(join(MCPSTATE(), 'remote'), `${c}\n`)

    beforeEach(() => {
      mcpSetup()
      setBuilt(RA)
    })

    it('mcp-update: git fetch, ff-only merge naar origin/main, submodule, npm ci, prisma:generate en een schone status, in die volgorde; daarna mcp.prev → A en mcp.built → B', () => {
      const res = act('mcp-update')
      expect(res.code, res.stderr).toBe(0)
      const d = MCP()
      expect(view()).toEqual([
        'flock -n 9',
        'systemctl is-active agent-harness.service',
        'systemctl is-active agent-harness-worker.service',
        `git -C ${d} status --porcelain`,
        `git -C ${d} fetch origin`,
        `git -C ${d} rev-parse origin/main`,
        `git -C ${d} merge --ff-only ${RB}`,
        `git -C ${d} submodule update --init`,
        'npm ci',
        'npm run prisma:generate',
        `git -C ${d} status --porcelain`,
      ])
      for (const c of calls().filter((x) => x.startsWith('npmcwd '))) expect(c).toBe(`npmcwd ${d}`)
      expect(read(builtFile())).toBe(`${RB}\n`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(res.stdout).toContain(`${RA} → ${RB}`)
      expect(readdirSync(VAR()).sort()).toEqual(['mcp.built', 'mcp.prev'])
      expect(head()).toBe(RB)
    })

    it('begint bij het eerste gebruik mcp.built bij de huidige HEAD (waarop de oude dienst draait), vóór de merge', () => {
      rmSync(builtFile())
      const res = act('mcp-update')
      expect(res.code, res.stderr).toBe(0)
      expect(gitCalls()).toContain(`git -C ${MCP()} rev-parse HEAD`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(read(builtFile())).toBe(`${RB}\n`)
    })

    it('laat bij het eerste gebruik en een mislukte update mcp.built op de HEAD van de oude dienst en mcp.prev daar ook', () => {
      rmSync(builtFile())
      expect(act('mcp-update', { STUB_NPM_FAIL: 'ci' }).code).toBe(74)
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
    })

    it('mcp-update naar B faalt, een tweede mcp-update faalt ook, en mcp-rollback kiest A zonder één git fetch, merge of pull', () => {
      for (const poging of [1, 2]) {
        const res = act('mcp-update', { STUB_NPM_FAIL: 'ci' })
        expect(res.code, `poging ${poging}`).toBe(74)
        expect(read(builtFile()), `poging ${poging}`).toBe(`${RA}\n`)
        expect(read(mcpPrevFile()), `poging ${poging}`).toBe(`${RA}\n`)
      }
      expect(head()).toBe(RB) // de merge is gedaan, de installatie niet
      writeFileSync(log, '')
      const res = act('mcp-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(writes()).toEqual([])
      expect(gitCalls()).toEqual([`git -C ${MCP()} reset --hard ${RA}`, `git -C ${MCP()} submodule update --init`, `git -C ${MCP()} status --porcelain`])
      expect(head()).toBe(RA)
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(stubCalls().filter((c) => /^(curl|docker) /.test(c))).toEqual([])
    })

    it.each([
      ['de submodule-stap', { STUB_NPM_FAIL: '' }, 'fail-submodule'],
      ['git merge', { STUB_NPM_FAIL: '' }, 'fail-merge'],
      ['git fetch', { STUB_NPM_FAIL: '' }, 'fail-fetch'],
    ])('mcp-update die faalt bij %s geeft 74 en laat mcp.built op A', (_naam, extra, vlag) => {
      flag(vlag)
      const res = act('mcp-update', extra)
      expect(res.code, res.stderr).toBe(74)
      expect(read(builtFile())).toBe(`${RA}\n`)
    })

    it.each(['ci', 'run prisma:generate'])('mcp-update met npm %s die faalt: 74 en mcp.built op A', (stap) => {
      expect(act('mcp-update', { STUB_NPM_FAIL: stap }).code).toBe(74)
      expect(read(builtFile())).toBe(`${RA}\n`)
    })

    it('een geslaagde update naar B, dan dezelfde update nog eens: mcp.prev blijft A, en mcp-rollback kiest A', () => {
      expect(act('mcp-update').code).toBe(0)
      writeFileSync(log, '')
      const res = act('mcp-update')
      expect(res.code, res.stderr).toBe(0)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(read(builtFile())).toBe(`${RB}\n`)
      expect(res.stdout).not.toContain(`${RA} → ${RB}`)
      writeFileSync(log, '')
      const terug = act('mcp-rollback')
      expect(terug.code, terug.stderr).toBe(0)
      expect(gitCalls()).toContain(`git -C ${MCP()} reset --hard ${RA}`)
      expect(head()).toBe(RA)
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
    })

    it('een herhaald mcp-rollback kiest dezelfde commit en houdt mcp.prev', () => {
      writeFileSync(mcpPrevFile(), `${RA}\n`)
      setBuilt(RB)
      for (const keer of [1, 2]) {
        expect(act('mcp-rollback').code, `keer ${keer}`).toBe(0)
        expect(head()).toBe(RA)
        expect(read(mcpPrevFile())).toBe(`${RA}\n`)
        expect(read(builtFile())).toBe(`${RA}\n`)
      }
    })

    it('een update waarvan het doel al mcp.built is, laat mcp.prev ongemoeid (ook als hij er niet is)', () => {
      setRemote(RA)
      const res = act('mcp-update')
      expect(res.code, res.stderr).toBe(0)
      expect(existsSync(mcpPrevFile())).toBe(false)
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(res.stdout).not.toContain('→')
    })

    it('een mcp-update maakt na een onderbreking tussen mcp.prev en de installatie dezelfde update af', () => {
      flag('fail-merge')
      expect(act('mcp-update').code).toBe(74)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(read(builtFile())).toBe(`${RA}\n`)
      unflag('fail-merge')
      expect(act('mcp-update').code).toBe(0)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      expect(read(builtFile())).toBe(`${RB}\n`)
    })

    it('geeft exit 1 als git status --porcelain na prisma:generate niet leeg is, en laat mcp.built ongewijzigd', () => {
      flag('dirty-after-generate')
      const res = act('mcp-update')
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('prisma/schema.prisma')
      expect(read(builtFile())).toBe(`${RA}\n`)
      writeFileSync(mcpPrevFile(), `${RA}\n`)
      writeFileSync(log, '')
      expect(act('mcp-rollback').code).toBe(1)
      expect(read(builtFile())).toBe(`${RA}\n`)
    })

    it('mcp-update weigert (75) een checkout met wijzigingen, vóór elke fetch, merge, npm of schrijfactie', () => {
      flag('dirty')
      const res = act('mcp-update')
      expect(res.code).toBe(75)
      expect(gitCalls()).toEqual([`git -C ${MCP()} status --porcelain`])
      expect(stubCalls().filter((c) => c.startsWith('npm '))).toEqual([])
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(existsSync(mcpPrevFile())).toBe(false)
    })

    it('mcp-rollback weigert (75) zonder mcp.prev, vóór elke git- of npm-aanroep', () => {
      const res = act('mcp-rollback')
      expect(res.code).toBe(75)
      expect(gitCalls()).toEqual([])
      expect(stubCalls().filter((c) => c.startsWith('npm '))).toEqual([])
      expect(read(builtFile())).toBe(`${RA}\n`)
    })

    it('mcp-rollback weigert een vuile checkout niet: de reset herstelt hem', () => {
      writeFileSync(mcpPrevFile(), `${RA}\n`)
      setBuilt(RB)
      flag('dirty')
      const res = act('mcp-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(existsSync(join(MCPSTATE(), 'dirty'))).toBe(false)
      expect(res.stdout).toContain(`${RB} → ${RA}`)
    })

    it('mcp-rollback laat een kapotte mcp.built de terugzetting niet blokkeren: hij wordt overschreven', () => {
      writeFileSync(mcpPrevFile(), `${RA}\n`)
      writeFileSync(builtFile(), 'kapot\n')
      const res = act('mcp-rollback')
      expect(res.code, res.stderr).toBe(0)
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(res.stdout).toContain(`onbekend → ${RA}`)
    })

    it('mcp-rollback geeft 74 als de reset faalt, en laat mcp.built en mcp.prev staan', () => {
      writeFileSync(mcpPrevFile(), `${RA}\n`)
      setBuilt(RB)
      flag('fail-reset')
      expect(act('mcp-rollback').code).toBe(74)
      expect(read(builtFile())).toBe(`${RB}\n`)
      expect(read(mcpPrevFile())).toBe(`${RA}\n`)
    })

    it('schrijft mcp.prev en mcp.built nooit half: een mislukte schrijfactie geeft 73, laat het oude bestand en geen tijdelijk bestand achter', () => {
      const res = act('mcp-update', { STUB_STATE_WRITE_FAIL: '1' })
      expect(res.code).toBe(73)
      expect(res.stderr).toContain('mcp.prev')
      expect(read(builtFile())).toBe(`${RA}\n`)
      expect(existsSync(mcpPrevFile())).toBe(false)
      expect(readdirSync(VAR())).toEqual(['mcp.built'])
      expect(head()).toBe(RA) // geen merge vóór mcp.prev
      expect(gitCalls().some((c) => / merge /.test(c))).toBe(false)
    })

    it('weigert (75) een mcp.built, mcp.prev of origin/main die geen volledige commit is, en (66) zonder checkout', () => {
      writeFileSync(builtFile(), 'abc\n')
      expect(act('mcp-update').code).toBe(75)
      setBuilt(RA)
      writeFileSync(mcpPrevFile(), 'abc\n')
      expect(act('mcp-rollback').code).toBe(75)
      writeFileSync(join(MCPSTATE(), 'remote'), 'abc\n')
      expect(act('mcp-update').code).toBe(74)
      rmSync(MCP(), { recursive: true })
      expect(act('mcp-update').code).toBe(66)
      expect(act('mcp-rollback').code).toBe(66)
    })

    it('zet root-git nergens in: elke git- en npm-aanroep staat achter runuser, als janpeter', () => {
      expect(act('mcp-update').code).toBe(0)
      const direct = stubCalls().filter((c) => /^(git|npm) /.test(c))
      const via = stubCalls().filter((c) => c.startsWith('runuser') && / (git|npm) /.test(c))
      expect(direct.length).toBe(via.length)
      for (const c of via) expect(c).toContain('env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 ')
    })
  })

  describe('statusbestanden in een map van janpeter (geen symlink-race, geen hang)', () => {
    const SENTINEL_BODY = 'doel-van-de-link: mag niet worden overschreven\n'
    const sentinel = (): string => join(dir, 'sentinel')
    const makeSentinel = (): void => {
      writeFileSync(sentinel(), SENTINEL_BODY, { mode: 0o600 })
      chmodSync(sentinel(), 0o600)
    }
    const sentinelIntact = (): void => {
      expect(readFileSync(sentinel(), 'utf8')).toBe(SENTINEL_BODY)
      expect(mode(sentinel())).toBe('600')
    }
    const mkfifo = (p: string): void => {
      expect(spawnSync('mkfifo', [p]).status).toBe(0)
    }
    const timed = (action: string, extra: Record<string, string> = {}) => {
      const res = run([action], { env: dEnv(extra), timeout: 20000 })
      expect(res.signal, `${action} bleef hangen`).toBeNull()
      return res
    }

    describe('schrijven', () => {
      it('release-update schrijft door een symlink op het definitieve pad niet heen: de link wordt vervangen, het doel blijft ongemoeid', () => {
        releases(RB, RA)
        makeSentinel()
        rmSync(prevFile())
        symlinkSync(sentinel(), prevFile())
        const res = act('release-update', { STUB_HEAD: RC })
        expect(res.code, res.stderr).toBe(0)
        sentinelIntact()
        expect(lstatSync(prevFile()).isSymbolicLink()).toBe(false)
        expect(read(prevFile())).toBe(`${RB}\n`)
        expect(mode(prevFile())).toBe('644')
      })

      it('mcp-update schrijft mcp.built en mcp.prev niet door symlinks heen (ook niet bij een dode link)', () => {
        mcpSetup()
        makeSentinel()
        rmSync(join(VAR(), 'mcp.built'), { force: true })
        symlinkSync(join(dir, 'bestaat-niet'), builtFile()) // mcp.built is een dode link: ontbrekend lezen mag niet volgen
        symlinkSync(sentinel(), mcpPrevFile())
        const res = act('mcp-update')
        // een link als mcp.built is corrupt (75): niets wordt geschreven, het doel blijft staan
        expect(res.code).toBe(75)
        sentinelIntact()
        expect(existsSync(join(dir, 'bestaat-niet'))).toBe(false)
        rmSync(builtFile())
        writeFileSync(builtFile(), `${RA}\n`)
        const res2 = act('mcp-update')
        expect(res2.code, res2.stderr).toBe(0)
        sentinelIntact()
        expect(lstatSync(mcpPrevFile()).isSymbolicLink()).toBe(false)
        expect(read(mcpPrevFile())).toBe(`${RA}\n`)
      })

      it('weigert (73) een tijdelijk pad dat al bestaat (een symlink op een geraden naam): O_EXCL volgt niets, het doel blijft ongemoeid en er blijft niets achter', () => {
        releases(RB, RA)
        makeSentinel()
        const preload = join(dir, 'preload.cjs')
        writeFileSync(preload, "require('crypto').randomBytes = () => Buffer.from('0102030405060708', 'hex')\n")
        const geraden = join(VAR(), '.release.prev.0102030405060708')
        symlinkSync(sentinel(), geraden)
        const res = act('release-update', { STUB_HEAD: RC, STUB_NODE_PRELOAD: preload })
        expect(res.code).toBe(73)
        sentinelIntact()
        expect(lstatSync(geraden).isSymbolicLink()).toBe(true) // niet van ons: niet weggehaald
        expect(read(prevFile())).toBe(`${RA}\n`)
        expect(current()).toBe(`releases/${RB}`)
      })

      it('geeft 73 met een duidelijke regel als het schrijven mislukt (echte fout: de map is niet beschrijfbaar), zonder tijdelijk bestand en met current ongewijzigd', () => {
        releases(RB, RA)
        chmodSync(VAR(), 0o500)
        try {
          const res = act('release-update', { STUB_HEAD: RC })
          expect(res.code, res.stderr).toBe(73)
          expect(res.stderr).toContain('release.prev')
        } finally {
          chmodSync(VAR(), 0o700)
        }
        expect(readdirSync(VAR())).toEqual(['release.prev'])
        expect(read(prevFile())).toBe(`${RA}\n`)
        expect(current()).toBe(`releases/${RB}`)
      })

      it('geeft 73 (niet 1) als de schrijver faalt, en laat release.prev en current ongemoeid', () => {
        releases(RB, RA)
        const res = act('release-update', { STUB_HEAD: RC, STUB_STATE_WRITE_FAIL: '1' })
        expect(res.code).toBe(73)
        expect(res.stderr).toContain('release.prev')
        expect(current()).toBe(`releases/${RB}`)
        expect(read(prevFile())).toBe(`${RA}\n`)
      })
    })

    describe('lezen', () => {
      it.each([
        ['release-rollback', 'release.prev'],
        ['mcp-rollback', 'mcp.prev'],
      ])('%s: een FIFO als %s is corrupt (75) en laat de actie niet hangen', (actie, naam) => {
        releases(RB, RA)
        mcpSetup()
        rmSync(join(VAR(), naam), { force: true })
        mkfifo(join(VAR(), naam))
        const res = timed(actie)
        expect(res.code, res.stderr).toBe(75)
        expect(current()).toBe(`releases/${RB}`)
      })

      it.each([
        ['release-rollback', 'release.prev'],
        ['mcp-rollback', 'mcp.prev'],
        ['mcp-update', 'mcp.built'],
      ])('%s: een symlink als %s, zelfs naar een geldige commit, is corrupt (75)', (actie, naam) => {
        releases(RB, RA)
        mcpSetup()
        const doel = join(dir, 'commit-elders')
        writeFileSync(doel, `${RA}\n`)
        rmSync(join(VAR(), naam), { force: true })
        symlinkSync(doel, join(VAR(), naam))
        const res = timed(actie)
        expect(res.code, res.stderr).toBe(75)
        expect(current()).toBe(`releases/${RB}`)
        expect(gitCallsAll().filter((c) => / (merge|reset) /.test(c))).toEqual([])
      })

      it('een te groot bestand is corrupt (75)', () => {
        releases(RB, RA)
        writeFileSync(prevFile(), `${RA}\n${'x'.repeat(10000)}`)
        expect(timed('release-rollback').code).toBe(75)
        expect(current()).toBe(`releases/${RB}`)
      })

      it('mcp-rollback leest een FIFO of symlink als mcp.built als ontbrekend (hij wordt overschreven) en hangt niet', () => {
        mcpSetup()
        writeFileSync(mcpPrevFile(), `${RA}\n`)
        rmSync(builtFile(), { force: true })
        mkfifo(builtFile())
        const res = timed('mcp-rollback')
        expect(res.code, res.stderr).toBe(0)
        expect(lstatSync(builtFile()).isFile()).toBe(true)
        expect(read(builtFile())).toBe(`${RA}\n`)
      })
    })
  })
})

// --- litellm-up, litellm-upgrade en status (deel e) ----------------------------------------------------------------------------

const MASTER = `sk-${'ab'.repeat(24)}` // an obviously fake master key of the real shape
const BRIDGE = 'litellm-ollama-bridge.service'
const HEALTH_CALL = 'curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:4000/health/liveliness'
const MODELS_CALL = 'curl -fsS --max-time 10 --config - http://127.0.0.1:4000/v1/models'
const SECRET_SENTINEL = 'sk-niet-kopieren-uit-een-symlink'
const HEX64 = 'ab12cd34'.repeat(8)

describe('ops wrapper: litellm-up, litellm-upgrade en status (deel e)', () => {
  const me = userInfo().username
  const OWNER = `runuser -u ${me} -- env HOME=/home/janpeter GIT_TERMINAL_PROMPT=0 `
  const COMPOSE = (): string => etc('litellm', 'compose.yml')
  const VAR = (): string => join(dir, 'var')
  const RUNS = (): string => join(VAR(), 'runs')
  const MCP = (): string => join(dir, 'mcp')
  const read = (p: string): string => readFileSync(p, 'utf8')
  const src = (...p: string[]): string => join(REPO_MAX2, ...p)
  const eEnv = (extra: Record<string, string> = {}): Record<string, string> =>
    installEnv({ AH_STATE_DIR: VAR(), AH_RUNS_DIR: RUNS(), AH_MCP_DIR: MCP(), AH_HEALTH_TRIES: '3', AH_HEALTH_SLEEP: '0', STUB_MCP_HEAD: SHA, STUB_MCP_REMOTE: SHA2, ...extra })
  const act = (action: string, extra: Record<string, string> = {}) => run([action], { env: eEnv(extra), timeout: 30000 })
  const everything = (res: { stdout: string; stderr: string }): string => `${res.stdout}\n${res.stderr}\n${readFileSync(log, 'utf8')}`
  const curlConfigs = (): string[] => readdirSync(join(dir, 'state')).filter((f) => f.startsWith('curl-config.')).map((f) => read(join(dir, 'state', f)))
  /** The calls that matter for order (the file shims are not counted). */
  const view = (): string[] => stubCalls().map((c) => c.replace(OWNER, 'OWNER '))

  /** current -> a built release with the repo's deploy files, and everything install leaves: etc files, key files, the bridge unit. */
  function ready(): void {
    mkdirSync(srv('releases'), { recursive: true })
    fakeRelease(SHA)
    symlinkSync(`releases/${SHA}`, srv('current'))
    mkdirSync(etc('litellm'), { recursive: true })
    writeFileSync(etc('harness.json'), read(src('harness.json')))
    writeFileSync(etc('litellm', 'config.yaml'), read(src('litellm', 'config.yaml')))
    writeFileSync(etc('litellm', 'compose.yml'), read(src('litellm', 'compose.yml')))
    writeFileSync(units(BRIDGE), read(src('litellm', BRIDGE)))
    writeFileSync(litellmEnv(), `LITELLM_MASTER_KEY=${MASTER}\n`, { mode: 0o600 })
    writeFileSync(harnessEnv(), `LITELLM_MASTER_KEY=${MASTER}\n`, { mode: 0o600 })
  }

  beforeEach(() => {
    installStubs()
    mkdirSync(units(), { recursive: true })
    mkdirSync(VAR())
    stateOf('agent-harness.service', 'inactive')
    stateOf('agent-harness-worker.service', 'inactive')
    writeStub(
      'systemctl',
      `${LOG_LINE}
if [ "$1" = is-active ]; then
  if [ -f "$STUB_STATE/$2" ]; then s=$(cat "$STUB_STATE/$2"); echo "$s"; [ "$s" = active ] && exit 0; exit 3; fi
  echo unknown; exit 4
fi
if [ "$1" = restart ] && [ -n "$STUB_RESTART_RC" ]; then exit "$STUB_RESTART_RC"; fi
if [ "$1" = enable ] && [ -n "$STUB_ENABLE_RC" ]; then exit "$STUB_ENABLE_RC"; fi
exit 0`,
    )
    writeStub(
      'docker',
      `${LOG_LINE}
case "$1" in
  compose)
    case " $* " in
      *' pull '*) exit "\${STUB_PULL_RC:-0}" ;;
      *' up '*) exit "\${STUB_UP_RC:-0}" ;;
    esac
    exit 0 ;;
  inspect) [ -n "$STUB_INSPECT_RC" ] && exit "$STUB_INSPECT_RC"; echo 'running|ghcr.io/berriai/litellm@sha256:c2b7aba0e3ebac7618ed23d12c5c65e05c533fb6843a0c694ff5c77c53de3ddf|sha256:0f1e2d3c'; exit 0 ;;
  image) echo 'ghcr.io/berriai/litellm@sha256:c2b7aba0e3ebac7618ed23d12c5c65e05c533fb6843a0c694ff5c77c53de3ddf'; exit 0 ;;
esac
exit 0`,
    )
    // curl: the config on stdin (--config -) is recorded in STUB_STATE; liveliness fails STUB_HEALTH_FAILS times first
    writeStub(
      'curl',
      `${LOG_LINE}
for a in "$@"; do if [ "$a" = - ]; then cat > "$STUB_STATE/curl-config.$$"; fi; done
case "$*" in
  *liveliness*)
    n=$(cat "$STUB_STATE/health-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_STATE/health-count"
    if [ "$n" -le "\${STUB_HEALTH_FAILS:-0}" ]; then exit 22; fi
    echo '"I am alive!"'; exit 0 ;;
  */v1/models*)
    if [ -n "$STUB_MODELS_RC" ]; then exit "$STUB_MODELS_RC"; fi
    if [ -f "$STUB_STATE/models.json" ]; then cat "$STUB_STATE/models.json"; else echo '{"object":"list","data":[{"id":"gsq-lokaal"},{"id":"qwen3.8-or"}]}'; fi
    exit 0 ;;
esac
exit 0`,
    )
    writeStub(
      'git',
      `${LOG_LINE}
mcp=; if [ "$1" = -C ]; then mcp=1; shift 2; fi
case "$1" in
  rev-parse) echo "$STUB_MCP_HEAD"; exit 0 ;;
  ls-remote)
    if [ -n "$STUB_LSREMOTE_RC" ]; then exit "$STUB_LSREMOTE_RC"; fi
    if [ -n "$mcp" ]; then printf '%s\\trefs/heads/main\\n' "$STUB_MCP_REMOTE"; else printf '%s\\trefs/heads/main\\n' "$STUB_HEAD"; fi
    exit 0 ;;
  clone) mkdir -p "$3" && cp -R "$STUB_SRC_DEPLOY" "$3/deploy"; exit $? ;;
esac
exit 0`,
    )
  })

  describe('litellm-up', () => {
    it('draait compose up -d, start de geïnstalleerde brug-unit (enable --now), wacht op liveliness en vraagt de modellen, in die volgorde', () => {
      ready()
      writeFileSync(units(BRIDGE), '# eigen brug-unit, niet uit current\n') // litellm-up kopieert geen unit: wat er staat blijft staan
      const unitsVoor = readdirSync(units()).sort()
      const res = act('litellm-up')
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual([
        'flock -n 9',
        `docker compose -p litellm -f ${COMPOSE()} up -d`,
        `systemctl enable --now ${BRIDGE}`,
        HEALTH_CALL,
        MODELS_CALL,
      ])
      // geen kopie van de unit, geen back-up en geen daemon-reload
      expect(readdirSync(units()).sort()).toEqual(unitsVoor)
      expect(read(units(BRIDGE))).toBe('# eigen brug-unit, niet uit current\n')
    })

    it('vraagt geen stilstand van de dienst: litellm-up werkt ook als agent-harness.service draait', () => {
      ready()
      stateOf('agent-harness.service', 'active')
      const res = act('litellm-up')
      expect(res.code, res.stderr).toBe(0)
      expect(stubCalls().filter((c) => c.startsWith('systemctl is-active'))).toEqual([])
    })

    it('drukt alleen de modelnamen af: geen ander veld, geen stuurtekens, geen id met een vreemd teken', () => {
      ready()
      writeFileSync(
        join(dir, 'state', 'models.json'),
        JSON.stringify({ object: 'list', data: [{ id: 'gsq-lokaal', owned_by: 'lekt-niet-uit' }, { id: 'raar\u001b[31mid' }, { id: 'qwen3.8-or', extra: 'lekt-ook-niet' }, { x: 1 }, { id: 42 }] }),
      )
      const res = act('litellm-up')
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain('gsq-lokaal')
      expect(res.stdout).toContain('qwen3.8-or')
      for (const verboden of ['lekt-niet-uit', 'lekt-ook-niet', 'raar', '\u001b', 'owned_by']) expect(res.stdout + res.stderr, verboden).not.toContain(verboden)
    })

    it('geeft de masterkey alleen via curl --config op stdin: hij staat in geen argv van een stub en niet in stdout of stderr', () => {
      ready()
      const res = act('litellm-up')
      expect(res.code, res.stderr).toBe(0)
      expect(everything(res)).not.toContain(MASTER)
      expect(everything(res)).not.toContain('sk-')
      const configs = curlConfigs()
      expect(configs).toHaveLength(1)
      expect(configs[0]).toContain(`Bearer ${MASTER}`)
      // de modellenaanroep draagt de sleutel niet; alleen de health-aanroep loopt zonder --config
      expect(calls().filter((c) => c.startsWith('curl')).filter((c) => c.includes('/health/liveliness'))).toEqual([HEALTH_CALL])
    })

    it('probeert liveliness opnieuw tot het slaagt, binnen het aantal pogingen', () => {
      ready()
      const res = act('litellm-up', { STUB_HEALTH_FAILS: '2' })
      expect(res.code, res.stderr).toBe(0)
      expect(calls().filter((c) => c === HEALTH_CALL)).toHaveLength(3)
    })

    it('geeft 74 als liveliness nooit slaagt, zonder de modellen op te vragen en zonder de sleutel te lekken', () => {
      ready()
      const res = act('litellm-up', { STUB_HEALTH_FAILS: '99' })
      expect(res.code).toBe(74)
      expect(res.stderr).toContain('liveliness')
      expect(calls().filter((c) => c === HEALTH_CALL)).toHaveLength(3)
      expect(calls().some((c) => c.includes('/v1/models'))).toBe(false)
      expect(everything(res)).not.toContain(MASTER)
    })

    it('geeft 74 als de modellen niet op te vragen zijn (bijvoorbeeld 401), en lekt de sleutel niet', () => {
      ready()
      const res = act('litellm-up', { STUB_MODELS_RC: '22' })
      expect(res.code).toBe(74)
      expect(everything(res)).not.toContain(MASTER)
    })

    it('geeft 74 als compose up faalt, zonder de brug te starten', () => {
      ready()
      const res = act('litellm-up', { STUB_UP_RC: '1' })
      expect(res.code).toBe(74)
      expect(stubCalls().some((c) => c.startsWith('systemctl enable'))).toBe(false)
    })

    it('geeft 74 als enable --now faalt', () => {
      ready()
      expect(act('litellm-up', { STUB_ENABLE_RC: '1' }).code).toBe(74)
    })

    it.each([
      ['compose.yml', () => rmSync(etc('litellm', 'compose.yml'))],
      ['de brug-unit', () => rmSync(units(BRIDGE))],
      ['harness-litellm.env', () => rmSync(harnessEnv())],
      ['de sleutel in harness-litellm.env', () => writeFileSync(harnessEnv(), 'ANDERS=1\n')],
      ['een niet-lege sleutel', () => writeFileSync(harnessEnv(), 'LITELLM_MASTER_KEY=\n')],
    ])('geeft 66 als %s ontbreekt, vóór elke docker-, systemctl- of curl-aanroep', (_naam, breek) => {
      ready()
      breek()
      const res = act('litellm-up')
      expect(res.code, res.stderr).toBe(66)
      expect(view()).toEqual(['flock -n 9'])
    })

    it.each([['aanhalingsteken', 'sk-ab"cd'], ['carriage return', 'sk-ab\r'], ['spatie', 'sk-ab cd'], ['backslash', 'sk-ab\\cd']])(
      'weigert (64) een masterkey met %s: curl --config zou er een andere optie van maken',
      (_naam, sleutel) => {
        ready()
        writeFileSync(harnessEnv(), `LITELLM_MASTER_KEY=${sleutel}\n`)
        const res = act('litellm-up')
        expect(res.code, res.stderr).toBe(64)
        expect(everything(res)).not.toContain('sk-ab')
        expect(view()).toEqual(['flock -n 9'])
      },
    )
  })

  describe('litellm-upgrade', () => {
    /** Old content in every target, so that an upgrade has something to back up. */
    function oldTargets(): void {
      writeFileSync(etc('harness.json'), '{"oud":"harness"}\n')
      writeFileSync(etc('litellm', 'config.yaml'), '# oude config\n')
      writeFileSync(etc('litellm', 'compose.yml'), '# oude compose\n')
      writeFileSync(units(BRIDGE), '# oude brug\n')
    }
    const backups = (d: string, prefix: string): string[] => readdirSync(d).filter((f) => f.startsWith(`${prefix}.bak-`))

    it.each(['active', 'activating', 'deactivating', ''])('weigert (75) bij toestand %j, zonder docker, daemon-reload of bestandswijziging', (toestand) => {
      ready()
      oldTargets()
      stateOf('agent-harness.service', toestand)
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(75)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
      expect(read(etc('harness.json'))).toBe('{"oud":"harness"}\n')
      expect(read(units(BRIDGE))).toBe('# oude brug\n')
    })

    it.each(['inactive', 'failed'])('gaat bij %s door', (toestand) => {
      ready()
      stateOf('agent-harness.service', toestand)
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(0)
    })

    it('geeft 75 bij een bezette lock, vóór elke andere aanroep', () => {
      ready()
      const res = act('litellm-upgrade', { STUB_FLOCK_BUSY: '1' })
      expect(res.code).toBe(75)
      expect(view()).toEqual(['flock -n 9'])
    })

    it('kopieert harness.json, config.yaml, compose.yml en de brug-unit uit current (0644) en bewaart de vorige als back-up', () => {
      ready()
      oldTargets()
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(0)
      const doelen: Array<[string, string, string]> = [
        [etc('harness.json'), src('harness.json'), '{"oud":"harness"}\n'],
        [etc('litellm', 'config.yaml'), src('litellm', 'config.yaml'), '# oude config\n'],
        [etc('litellm', 'compose.yml'), src('litellm', 'compose.yml'), '# oude compose\n'],
        [units(BRIDGE), src('litellm', BRIDGE), '# oude brug\n'],
      ]
      for (const [doel, bron, oud] of doelen) {
        expect(read(doel), doel).toBe(read(bron))
        expect(mode(doel), doel).toBe('644')
        const back = backups(join(doel, '..'), doel.split('/').pop()!)
        expect(back, doel).toHaveLength(1)
        expect(read(join(doel, '..', back[0])), doel).toBe(oud)
      }
      expect(readdirSync(etc()).filter((f) => f.includes('.tmp') || f.startsWith('.'))).toEqual([])
    })

    it('maakt geen back-up van een bestand dat al gelijk is of nog niet bestaat', () => {
      ready()
      rmSync(etc('litellm', 'compose.yml'))
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(0)
      expect(read(etc('litellm', 'compose.yml'))).toBe(read(src('litellm', 'compose.yml')))
      expect(readdirSync(etc()).filter((f) => f.includes('.bak-'))).toEqual([])
      expect(readdirSync(etc('litellm')).filter((f) => f.includes('.bak-'))).toEqual([])
      expect(readdirSync(units()).filter((f) => f.includes('.bak-'))).toEqual([])
    })

    it('doet daemon-reload, herstart de brug, pull en up -d --force-recreate (zelfde -p en -f als litellm-up), wacht op liveliness en vraagt de modellen, in die volgorde', () => {
      ready()
      oldTargets()
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(0)
      expect(view()).toEqual([
        'flock -n 9',
        'systemctl is-active agent-harness.service',
        'systemctl daemon-reload',
        `systemctl restart ${BRIDGE}`,
        `docker compose -p litellm -f ${COMPOSE()} pull`,
        `docker compose -p litellm -f ${COMPOSE()} up -d --force-recreate`,
        HEALTH_CALL,
        MODELS_CALL,
      ])
      // zelfde -p en -f als litellm-up
      writeFileSync(log, '')
      expect(act('litellm-up').code).toBe(0)
      expect(view()[1]).toBe(`docker compose -p litellm -f ${COMPOSE()} up -d`)
    })

    it('drukt alleen de modelnamen af en geeft de masterkey alleen via curl --config op stdin', () => {
      ready()
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain('gsq-lokaal')
      expect(everything(res)).not.toContain(MASTER)
      expect(curlConfigs()).toHaveLength(1)
      expect(curlConfigs()[0]).toContain(`Bearer ${MASTER}`)
    })

    it('raakt git, npm en runuser niet aan: alles komt uit current', () => {
      ready()
      act('litellm-upgrade')
      expect(stubCalls().filter((c) => /^(git|npm|runuser) /.test(c))).toEqual([])
    })

    it.each([
      ['de herstart van de brug', { STUB_RESTART_RC: '1' }, 'pull'],
      ['pull', { STUB_PULL_RC: '1' }, 'up'],
      ['up -d --force-recreate', { STUB_UP_RC: '1' }, 'liveliness'],
    ])('geeft 74 als %s faalt en gaat daarna niet verder', (_naam, extra, volgende) => {
      ready()
      const res = act('litellm-upgrade', extra)
      expect(res.code, res.stderr).toBe(74)
      expect(calls().some((c) => c.includes(volgende === 'liveliness' ? '/health/liveliness' : ` ${volgende}`))).toBe(false)
    })

    it('geeft 74 als LiteLLM na de herstart niet gezond wordt', () => {
      ready()
      const res = act('litellm-upgrade', { STUB_HEALTH_FAILS: '99' })
      expect(res.code).toBe(74)
      expect(calls().some((c) => c.includes('/v1/models'))).toBe(false)
    })

    it('geeft 66 zonder current, vóór elke wijziging', () => {
      ready()
      rmSync(srv('current'))
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(66)
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
    })

    it('controleert eerst álle bronnen: een ontbrekend bronbestand laat elk doel en elke unit onaangeroerd, zonder daemon-reload of docker', () => {
      ready()
      oldTargets()
      rmSync(srv('current', 'deploy', 'max2', 'litellm', 'compose.yml'))
      const res = act('litellm-upgrade')
      expect(res.code, res.stderr).toBe(66)
      expect(read(etc('harness.json'))).toBe('{"oud":"harness"}\n')
      expect(read(etc('litellm', 'config.yaml'))).toBe('# oude config\n')
      expect(read(units(BRIDGE))).toBe('# oude brug\n')
      expect(readdirSync(etc()).filter((f) => f.includes('.bak-'))).toEqual([])
      expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
    })

    describe('bronnen worden als root gelezen, binnen de release (geen symlink-uitweg)', () => {
      const geheimDir = (): string => {
        const geheim = join(dir, 'geheime-map')
        mkdirSync(geheim, { recursive: true })
        for (const f of ['config.yaml', 'compose.yml', BRIDGE]) writeFileSync(join(geheim, f), `${SECRET_SENTINEL}\n`, { mode: 0o600 })
        return geheim
      }
      const nergensGekopieerd = (): void => {
        for (const d of [units(), etc(), etc('litellm')]) {
          for (const f of existsSync(d) ? readdirSync(d) : []) {
            const pad = join(d, f)
            if (statSync(pad).isFile()) expect(read(pad), pad).not.toContain(SECRET_SENTINEL)
          }
        }
      }

      it('weigert (66) een release waarin deploy/max2/litellm een symlink is naar een map met een geheim bestand, en kopieert het geheim niet', () => {
        ready()
        oldTargets()
        const doel = srv('releases', SHA, 'deploy', 'max2', 'litellm')
        rmSync(doel, { recursive: true })
        symlinkSync(geheimDir(), doel)
        const res = act('litellm-upgrade')
        expect(res.code, res.stderr).toBe(66)
        nergensGekopieerd()
        expect(view()).toEqual(['flock -n 9', 'systemctl is-active agent-harness.service'])
      })

      it('weigert (66) een release waarin deploy/max2 een symlink naar een map buiten de release is', () => {
        ready()
        oldTargets()
        const doel = srv('releases', SHA, 'deploy', 'max2')
        const buiten = join(dir, 'buiten-max2')
        cpSync(doel, buiten, { recursive: true })
        writeFileSync(join(buiten, 'harness.json'), `${SECRET_SENTINEL}\n`)
        rmSync(doel, { recursive: true })
        symlinkSync(buiten, doel)
        const res = act('litellm-upgrade')
        expect(res.code, res.stderr).toBe(66)
        nergensGekopieerd()
      })

      it.each(['harness.json', 'litellm/config.yaml', 'litellm/compose.yml', `litellm/${BRIDGE}`])('weigert (66) een bronbestand dat een symlink is naar een geheim bestand buiten de release (%s)', (rel) => {
        ready()
        oldTargets()
        const geheim = join(dir, 'geheim.env')
        writeFileSync(geheim, `${SECRET_SENTINEL}\n`, { mode: 0o600 })
        const pad = srv('releases', SHA, 'deploy', 'max2', rel)
        rmSync(pad)
        symlinkSync(geheim, pad)
        const res = act('litellm-upgrade')
        expect(res.code, res.stderr).toBe(66)
        expect(res.stderr).toContain('symlink')
        nergensGekopieerd()
        expect(read(etc('harness.json'))).toBe('{"oud":"harness"}\n')
      })

      it('weigert (66) ook een symlink naar een bestand binnen de release: een bronbestand is een gewoon bestand', () => {
        ready()
        const pad = srv('releases', SHA, 'deploy', 'max2', 'litellm', 'config.yaml')
        const echt = srv('releases', SHA, 'deploy', 'max2', 'litellm', 'echt.yaml')
        writeFileSync(echt, 'model_list: []\n')
        rmSync(pad)
        symlinkSync('echt.yaml', pad)
        const res = act('litellm-upgrade')
        expect(res.code, res.stderr).toBe(66)
        expect(res.stderr).toContain('symlink')
      })

      it('weigert (66) een bronbestand dat geen gewoon bestand is (een map) en een te groot bestand, en geeft geen hang bij een FIFO', () => {
        ready()
        const pad = srv('releases', SHA, 'deploy', 'max2', 'litellm', 'compose.yml')
        rmSync(pad)
        mkdirSync(pad)
        expect(act('litellm-upgrade').code).toBe(66)
        rmSync(pad, { recursive: true })
        writeFileSync(pad, 'x'.repeat(2 * 1024 * 1024))
        expect(act('litellm-upgrade').code).toBe(66)
        rmSync(pad)
        expect(spawnSync('mkfifo', [pad]).status).toBe(0)
        const res = act('litellm-upgrade')
        expect(res.signal).toBeNull()
        expect(res.code).toBe(66)
      })

      it('install weigert (66) ook een symlinkte deploy/max2/litellm: het geheim komt in geen doelbestand, ook niet in een bestand dat install al had geplaatst', () => {
        const bron = join(dir, 'deploy-src')
        cpSync(REPO_DEPLOY, bron, { recursive: true })
        rmSync(join(bron, 'max2', 'litellm'), { recursive: true })
        symlinkSync(geheimDir(), join(bron, 'max2', 'litellm'))
        const res = install({ STUB_SRC_DEPLOY: bron })
        expect(res.code, res.stderr).toBe(66)
        nergensGekopieerd()
      })
    })
  })

  describe('status', () => {
    const writeProbe = (naam: string, inhoud: string): void => {
      mkdirSync(join(RUNS(), `probe-${naam}`), { recursive: true })
      writeFileSync(join(RUNS(), `probe-${naam}`, 'probe.json'), inhoud)
    }
    /** A full picture: two releases, mcp state, a probe result per configuration. */
    function full(): void {
      ready()
      fakeRelease(SHA2)
      writeFileSync(join(VAR(), 'release.prev'), `${SHA2}\n`)
      writeFileSync(join(VAR(), 'mcp.built'), `${RA}\n`)
      writeFileSync(join(VAR(), 'mcp.prev'), `${RB}\n`)
      mkdirSync(MCP())
      stateOf('agent-harness.service', 'active')
      stateOf('agent-harness-probe.service', 'inactive')
      stateOf('agent-harness-worker.service', 'active')
      stateOf(BRIDGE, 'active')
      writeProbe('gsq-lokaal', JSON.stringify({ accepted: true, hash: HEX64, ranAt: '2026-10-08T07:30:00.000Z', configuration: 'gsq-lokaal', reasons: [] }))
      writeProbe('qwen3.8-or', JSON.stringify({ accepted: false, hash: HEX64, ranAt: '2026-10-08T07:31:00.000Z', reasons: ['tool_calling is partial'] }))
    }

    it('werkt zonder lock (ook met een bezette lock) en terwijl de dienst draait, en neemt de flock niet', () => {
      full()
      const res = act('status', { STUB_FLOCK_BUSY: '1' })
      expect(res.code, res.stderr).toBe(0)
      expect(stubCalls().filter((c) => c.startsWith('flock'))).toEqual([])
    })

    it('toont de commits van current, release.prev, mcp-stable (HEAD), mcp.built, mcp.prev en origin/main van scrum4me-mcp', () => {
      full()
      const res = act('status')
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain(`current: ${SHA}`)
      expect(res.stdout).toContain(`release.prev: ${SHA2}`)
      expect(res.stdout).toContain(`mcp-stable HEAD: ${SHA}`)
      expect(res.stdout).toContain(`mcp.built: ${RA}`)
      expect(res.stdout).toContain(`mcp.prev: ${RB}`)
      expect(res.stdout).toContain(`mcp origin/main: ${SHA2}`)
      // git draait als de eigenaar van de checkout, nooit als root
      const gitCalls = view().filter((c) => c.includes(' git '))
      expect(gitCalls).toEqual([`OWNER git -C ${MCP()} rev-parse HEAD`, `OWNER git -C ${MCP()} ls-remote origin refs/heads/main`])
    })

    it('toont de stand van de units, de LiteLLM-container met image-digest en de modelnamen', () => {
      full()
      const res = act('status')
      expect(res.stdout).toContain('unit agent-harness.service: active')
      expect(res.stdout).toContain('unit agent-harness-probe.service: inactive')
      expect(res.stdout).toContain('unit agent-harness-worker.service: active')
      expect(res.stdout).toContain(`unit ${BRIDGE}: active`)
      expect(res.stdout).toMatch(/litellm container: running/)
      expect(res.stdout).toContain('sha256:c2b7aba0e3ebac7618ed23d12c5c65e05c533fb6843a0c694ff5c77c53de3ddf')
      expect(res.stdout).toMatch(/litellm modellen: gsq-lokaal qwen3\.8-or/)
    })

    it('toont per configuratie van harness.json de opgeslagen probe-uitslag (accepted, hash, tijd) uit probe.json, zonder een hash te berekenen', () => {
      full()
      const res = act('status')
      expect(res.stdout).toContain(`probe gsq-lokaal: accepted=true hash=${HEX64} tijd=2026-10-08T07:30:00.000Z`)
      expect(res.stdout).toContain(`probe qwen3.8-or: accepted=false hash=${HEX64} tijd=2026-10-08T07:31:00.000Z`)
      // er is niets gehashed: de LiteLLM-bestanden zelf worden niet gelezen
      expect(stubCalls().filter((c) => /sha256sum|shasum|openssl/.test(c))).toEqual([])
    })

    it('doet alleen leesaanroepen: systemctl is-active, docker inspect, git rev-parse en ls-remote, curl op /v1/models, en schrijft niets', () => {
      full()
      const voor = [readdirSync(etc()).sort(), readdirSync(VAR()).sort(), readdirSync(units()).sort(), readdirSync(srv()).sort()]
      const res = act('status')
      expect(res.code, res.stderr).toBe(0)
      expect([readdirSync(etc()).sort(), readdirSync(VAR()).sort(), readdirSync(units()).sort(), readdirSync(srv()).sort()]).toEqual(voor)
      for (const c of stubCalls()) {
        const norm = c.replace(OWNER, 'OWNER ')
        const [naam, ...rest] = norm.split(' ')
        if (naam === 'systemctl') expect(norm).toMatch(/^systemctl is-active /)
        else if (naam === 'docker') expect(rest[0] === 'inspect' || (rest[0] === 'image' && rest[1] === 'inspect'), norm).toBe(true)
        else if (naam === 'OWNER' || naam === 'git') expect(norm).toMatch(/^(OWNER )?git -C \S+ (rev-parse HEAD|ls-remote origin refs\/heads\/main)$/)
        else if (naam === 'curl') expect(norm).toBe(MODELS_CALL)
        else throw new Error(`onverwachte aanroep: ${norm}`)
      }
    })

    it('toont de masterkey nergens: niet in stdout, stderr of een argv, en ook geen geheim uit harness.json of de env-bestanden', () => {
      full()
      const res = act('status')
      expect(everything(res)).not.toContain(MASTER)
      expect(everything(res)).not.toContain('SCRUM4ME_TOKEN')
      expect(everything(res)).not.toContain('sk-')
      expect(curlConfigs()[0]).toContain(`Bearer ${MASTER}`)
    })

    it('geeft 0 en een duidelijke regel per ontbrekend onderdeel, zonder iets aan te maken', () => {
      // niets geïnstalleerd: geen current, geen toestandsbestanden, geen harness.json, geen sleutel, geen container, geen checkout
      rmSync(VAR(), { recursive: true })
      const res = act('status', { STUB_INSPECT_RC: '1', STUB_MODELS_RC: '7' })
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain('current: (geen)')
      expect(res.stdout).toContain('release.prev: (geen)')
      expect(res.stdout).toContain('mcp.built: (geen)')
      expect(res.stdout).toMatch(/mcp-stable HEAD: \(.*checkout ontbreekt/)
      expect(res.stdout).toMatch(/litellm container: \(.*\)/)
      expect(res.stdout).toMatch(/litellm modellen: \(.*\)/)
      expect(res.stdout).toMatch(/probe: \(.*harness\.json/)
      expect(existsSync(VAR())).toBe(false)
      expect(readdirSync(etc())).toEqual([])
    })

    it('meldt een kapotte toestandsfile of current-link als onleesbaar in plaats van te stoppen', () => {
      full()
      writeFileSync(join(VAR(), 'release.prev'), 'geen-commit\n')
      rmSync(join(VAR(), 'mcp.built'))
      symlinkSync('/etc/passwd', join(VAR(), 'mcp.built'))
      rmSync(srv('current'))
      symlinkSync('ergens/anders', srv('current'))
      const res = act('status')
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toMatch(/release\.prev: \(onleesbaar/)
      expect(res.stdout).toMatch(/mcp\.built: \(onleesbaar/)
      expect(res.stdout).toMatch(/current: \(onleesbaar/)
      expect(res.stdout).not.toContain('root:')
    })

    it('meldt een mislukte ls-remote als niet bereikbaar en toont de rest', () => {
      full()
      const res = act('status', { STUB_LSREMOTE_RC: '128' })
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toMatch(/mcp origin\/main: \(niet bereikbaar/)
      expect(res.stdout).toContain(`current: ${SHA}`)
    })

    describe('probe.json komt uit een map van janpeter: alleen gevalideerde velden, nooit een symlink of FIFO', () => {
      it('volgt geen symlink naar een geheim bestand en toont niets daaruit', () => {
        full()
        const geheim = join(dir, 'geheim.json')
        writeFileSync(geheim, JSON.stringify({ accepted: true, hash: HEX64, ranAt: SECRET_SENTINEL }))
        rmSync(join(RUNS(), 'probe-gsq-lokaal', 'probe.json'))
        symlinkSync(geheim, join(RUNS(), 'probe-gsq-lokaal', 'probe.json'))
        const res = act('status')
        expect(res.code, res.stderr).toBe(0)
        expect(res.stdout).toMatch(/probe gsq-lokaal: \(onleesbaar/)
        expect(res.stdout).not.toContain(SECRET_SENTINEL)
      })

      it('hangt niet op een FIFO', () => {
        full()
        const pad = join(RUNS(), 'probe-gsq-lokaal', 'probe.json')
        rmSync(pad)
        expect(spawnSync('mkfifo', [pad]).status).toBe(0)
        const res = act('status')
        expect(res.signal).toBeNull()
        expect(res.stdout).toMatch(/probe gsq-lokaal: \(onleesbaar/)
      })

      it.each([
        ['accepted is geen boolean', { accepted: 'ja', hash: HEX64, ranAt: '2026-10-08T07:30:00.000Z' }],
        ['hash is geen 64 hexadecimale tekens', { accepted: true, hash: '\u001b[31mrood', ranAt: '2026-10-08T07:30:00.000Z' }],
        ['hash ontbreekt', { accepted: true, ranAt: '2026-10-08T07:30:00.000Z' }],
      ])('toont niets van een probe.json waarvan %s', (_naam, inhoud) => {
        full()
        writeProbe('gsq-lokaal', JSON.stringify(inhoud))
        const res = act('status')
        expect(res.stdout).toMatch(/probe gsq-lokaal: \(onleesbaar/)
        expect(res.stdout).not.toContain('\u001b')
        expect(res.stdout).not.toContain('rood')
      })

      it('toont een tijd die geen tijdstempel is niet, maar valt terug op de wijzigingstijd van het bestand', () => {
        full()
        writeProbe('gsq-lokaal', JSON.stringify({ accepted: true, hash: HEX64, ranAt: `${SECRET_SENTINEL}\u001b[31m` }))
        const res = act('status')
        expect(res.stdout).toMatch(new RegExp(`probe gsq-lokaal: accepted=true hash=${HEX64} tijd=\\d{4}-\\d{2}-\\d{2}T`))
        expect(res.stdout).not.toContain(SECRET_SENTINEL)
        expect(res.stdout).not.toContain('\u001b')
      })

      it('meldt "geen probe-uitslag" voor een configuratie zonder probe.json, en weigert een te groot bestand', () => {
        full()
        rmSync(join(RUNS(), 'probe-qwen3.8-or'), { recursive: true })
        writeProbe('gsq-lokaal', JSON.stringify({ accepted: true, hash: HEX64, pad: 'x'.repeat(2000000) }))
        const res = act('status')
        expect(res.stdout).toMatch(/probe qwen3\.8-or: \(geen probe-uitslag/)
        expect(res.stdout).toMatch(/probe gsq-lokaal: \(onleesbaar/)
      })
    })
  })
})

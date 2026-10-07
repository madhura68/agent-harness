import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
/** Actions that are built in an earlier part (own describe blocks); the rest still answers 70. */
const BUILT = ['install']
const NOT_BUILT = ACTIONS.filter((a) => !BUILT.includes(a))
const NOT_BUILT_LOCKED_CASES = LOCKED_CASES.filter((c) => !BUILT.includes(c[0]))
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

function run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.env.OPS_BASH ?? 'bash', [SCRIPT, ...args], { input: opts.input ?? '', env: env(opts.env), encoding: 'utf8' })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
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

  it('kent alle elf acties: elke actie die nog niet is gebouwd geeft 70 met een duidelijke regel, de rest van de wrapper blijft ongemoeid', () => {
    for (const actie of NOT_BUILT) {
      const res = run([actie])
      expect(res.code, actie).toBe(70)
      expect(res.stderr, actie).toMatch(new RegExp(`${actie}: nog niet geïmplementeerd \\(deel [de]\\)`))
    }
    expect(run(['install']).stderr).not.toContain('nog niet geïmplementeerd')
  })

  it('neemt voor elke actie behalve status en stop eerst de exclusieve flock (flock -n 9) en roept verder geen stub aan', () => {
    for (const args of NOT_BUILT_LOCKED_CASES) {
      writeFileSync(log, '')
      rmSync(join(dir, 'ops.lock'), { force: true })
      run(args, { input: `${FAKE_KEY}\n` })
      expect(stubCalls(), args.join(' ')).toEqual(['flock -n 9'])
      expect(existsSync(join(dir, 'ops.lock')), args.join(' ')).toBe(true)
    }
    for (const actie of LOCK_FREE) {
      writeFileSync(log, '')
      run([actie])
      expect(stubCalls(), actie).toEqual([])
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
      expect(stubCalls(), actie).toEqual([])
    }
  })
})

describe('ops wrapper: runuser en stilstand (helpers)', () => {
  it('draait git en npm als janpeter via runuser, nooit rechtstreeks', () => {
    const res = runHelper('owner_git -C /srv/x status; owner_npm ci')
    expect(res.code).toBe(0)
    expect(stubCalls()).toEqual(['runuser -u janpeter -- env HOME=/home/janpeter git -C /srv/x status', 'runuser -u janpeter -- env HOME=/home/janpeter npm ci'])
  })

  it('houdt de eigenaar en zijn home overschrijfbaar voor tests, met janpeter en /home/janpeter als vaste standaard, en zet HOME op die home (runuser behoudt HOME=/root)', () => {
    runHelper('owner_git log; owner_npm ci', { AH_OWNER: 'tester', AH_OWNER_HOME: '/home/tester' })
    expect(stubCalls()).toEqual(['runuser -u tester -- env HOME=/home/tester git log', 'runuser -u tester -- env HOME=/home/tester npm ci'])
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
    expect(res.code).not.toBe(0)
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
        `runuser -u ${me} -- env HOME=/home/janpeter git ls-remote ${url} refs/heads/main`,
        `runuser -u ${me} -- env HOME=/home/janpeter git clone ${url} ${rel}`,
        `runuser -u ${me} -- env HOME=/home/janpeter git -C ${rel} checkout --detach ${SHA}`,
        `runuser -u ${me} -- env HOME=/home/janpeter npm ci`,
        `runuser -u ${me} -- env HOME=/home/janpeter npm run build`,
        `runuser -u ${me} -- env HOME=/home/janpeter touch ${rel}/.built`,
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
      for (const c of viaRunuser) expect(c).toContain('env HOME=/home/janpeter ')
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
      const names = stubCalls().filter((c) => c.startsWith('runuser')).map((c) => c.replace(/^runuser -u \S+ -- env HOME=\S+ /, ''))
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
})

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

let dir: string
let log: string

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), 'ops-wrapper-'))
  log = join(dir, 'calls.log')
  writeFileSync(log, '')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'etc'))
  mkdirSync(join(dir, 'state'))
  const logLine = `printf '%s' "\${0##*/}" >> "$STUB_LOG"; for a in "$@"; do printf ' %s' "$a" >> "$STUB_LOG"; done; printf '\\n' >> "$STUB_LOG"`
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
    for (const actie of ACTIONS) {
      const res = run([actie])
      expect(res.code, actie).toBe(70)
      expect(res.stderr, actie).toMatch(new RegExp(`${actie}: nog niet geïmplementeerd \\(deel [cde]\\)`))
    }
  })

  it('neemt voor elke actie behalve status en stop eerst de exclusieve flock (flock -n 9) en roept verder geen stub aan', () => {
    for (const args of LOCKED_CASES) {
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
    expect(stubCalls()).toEqual(['runuser -u janpeter -- git -C /srv/x status', 'runuser -u janpeter -- npm ci'])
  })

  it('houdt de eigenaar overschrijfbaar voor tests, met janpeter als vaste standaard', () => {
    runHelper('owner_git log', { AH_OWNER: 'tester' })
    expect(stubCalls()).toEqual(['runuser -u tester -- git log'])
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

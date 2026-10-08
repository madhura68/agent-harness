import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The sudoers file of the ops wrapper (deploy/max2/ops/sudoers-agent-harness-ops), parsed as text. What it must pin: exactly one
// ops-agent line per allowed action, one janpeter line for `stop` only, no wildcard, no key action, and nothing that lets a caller
// bring its own environment (the wrapper's AH_* overrides are meant for tests and must stay stripped by sudo's env_reset).

const FILE = fileURLToPath(new URL('../deploy/max2/ops/sudoers-agent-harness-ops', import.meta.url))
const WRAPPER = '/usr/local/lib/agent-harness/ops/agent-harness-ops.sh'
const ALLOWED = ['status', 'install', 'stop', 'start', 'probe', 'release-update', 'release-rollback', 'mcp-update', 'mcp-rollback', 'litellm-up', 'litellm-upgrade']

const text = readFileSync(FILE, 'utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))

describe('sudoers-agent-harness-ops', () => {
  it('heeft precies één ops-agent-regel per toegestane actie, in de vorm van de plantekst, en één janpeter-regel voor alleen stop: de regelverzameling is exact', () => {
    const verwacht = [...ALLOWED.map((a) => `ops-agent ALL=(root) NOPASSWD: ${WRAPPER} ${a}`), `janpeter ALL=(root) NOPASSWD: ${WRAPPER} stop`]
    expect([...lines].sort()).toEqual([...verwacht].sort())
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('heeft geen jokerteken: nergens een *, ook niet in commentaar, en geen ? of [ in een regel', () => {
    expect(text).not.toContain('*')
    for (const l of lines) expect(l, l).not.toMatch(/[?[\]]/)
  })

  it('noemt de sleutelactie nergens (provider-key blijft voor JP aan een terminal)', () => {
    expect(text).not.toContain('provider-key')
    expect(lines.some((l) => l.endsWith(' provider-key') || l.includes('provider-key'))).toBe(false)
  })

  it('geeft de aanroeper geen omgeving mee: geen SETENV, geen env_keep, geen env_check, geen Defaults, geen Cmnd_Alias en geen ALL als commando', () => {
    for (const verboden of ['SETENV', 'env_keep', 'env_check', 'env_delete', 'Defaults', 'Cmnd_Alias', 'EXEC', 'NOEXEC', 'ALL=(ALL']) expect(text, verboden).not.toContain(verboden)
    for (const l of lines) {
      expect(l, l).toMatch(/^(ops-agent|janpeter) ALL=\(root\) NOPASSWD: \/usr\/local\/lib\/agent-harness\/ops\/agent-harness-ops\.sh [a-z-]+$/)
    }
  })

  it('geeft elke regel de runas-gebruiker root, het volledige pad en één vast argument; geen regel zonder argument', () => {
    for (const l of lines) {
      const [, cmd] = l.split('NOPASSWD: ')
      const delen = cmd.split(' ')
      expect(delen[0]).toBe(WRAPPER)
      expect(delen).toHaveLength(2)
      expect([...ALLOWED]).toContain(delen[1])
    }
  })

  it('geeft janpeter alleen stop, en geeft ops-agent geen enkele andere gebruiker dan root als runas', () => {
    const janpeter = lines.filter((l) => l.startsWith('janpeter '))
    expect(janpeter).toEqual([`janpeter ALL=(root) NOPASSWD: ${WRAPPER} stop`])
    for (const l of lines.filter((l) => l.startsWith('ops-agent '))) expect(l).toContain('ALL=(root) NOPASSWD:')
  })
})

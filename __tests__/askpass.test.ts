import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'deploy/max2/forgejo-askpass.sh'

function run(prompt: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('sh', [SCRIPT, prompt], { env: { PATH: process.env.PATH ?? '', ...env } }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout, stderr })
    })
  })
}

describe('deploy/max2/forgejo-askpass.sh', () => {
  it('answers the Forgejo username prompt with agent-harness', async () => {
    const res = await run("Username for 'https://git.jp-visser.nl': ")
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('agent-harness\n')
  })

  it('answers the Forgejo password prompt with FORGEJO_PUSH_TOKEN', async () => {
    const res = await run("Password for 'https://agent-harness@git.jp-visser.nl': ", { FORGEJO_PUSH_TOKEN: 'tok' })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('tok\n')
  })

  it('refuses any other host with a non-zero exit and no output', async () => {
    const res = await run("Password for 'https://evil.example': ", { FORGEJO_PUSH_TOKEN: 'tok' })
    expect(res.code).not.toBe(0)
    expect(res.stdout).toBe('')
  })
})

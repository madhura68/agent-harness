import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from '../src/worker/config.js'

const deploy = (naam: string): string => fileURLToPath(new URL(`../deploy/max2/${naam}`, import.meta.url))

/** The `model_name` values of the LiteLLM config's model_list, in file order. Comment lines are skipped. */
function modelNames(yaml: string): string[] {
  return yaml
    .split('\n')
    .filter((regel) => !regel.trimStart().startsWith('#'))
    .flatMap((regel) => {
      const m = regel.match(/^\s*-\s+model_name:\s*(\S+)\s*$/)
      return m ? [m[1].replace(/^["']|["']$/g, '')] : []
    })
}

describe('deploy/max2/harness.json', () => {
  // loadWorkerConfig expands no env: it parses the file through WorkerConfigSchema (strict), so the ${VAR} references stay as they are.
  const cfg = loadWorkerConfig(deploy('harness.json'))
  const yaml = readFileSync(deploy('litellm/config.yaml'), 'utf8')

  it('voldoet aan het strikte workerschema en noemt precies de twee configuraties uit litellm/config.yaml', () => {
    expect(Object.keys(cfg.configurations).sort()).toEqual(['gsq-lokaal', 'qwen3.8-or'])
    expect(Object.keys(cfg.configurations).sort()).toEqual(modelNames(yaml).sort())
    expect(modelNames(yaml)).not.toContain('qwen3.8-or-neg')
  })

  it('zet de configuraties en het litellm-blok zoals de productie ze nodig heeft', () => {
    expect(cfg.litellm).toEqual({
      baseUrl: 'http://127.0.0.1:4000/v1',
      configPath: '/etc/agent-harness/litellm/config.yaml',
      composePath: '/etc/agent-harness/litellm/compose.yml',
    })
    expect(cfg.configurations['gsq-lokaal']).toEqual({ costMode: 'local', contextTokens: 65536 })
    expect(cfg.configurations['qwen3.8-or']).toEqual({ costMode: 'hosted', contextTokens: 65536, reasoningEffort: 'medium' })
  })

  it('geeft een taak met repo_url de repo-sleutel voor agent-harness en bevat geen geheime waarde', () => {
    expect(cfg.mcp.env?.['SCRUM4ME_REPO_ROOT_REPO_agent-harness']).toBe('/var/lib/agent-harness/repos/agent-harness')
    expect(cfg.mcp.env?.SCRUM4ME_TOKEN).toBe('${SCRUM4ME_TOKEN}')
    expect(cfg.mcp.env?.FORGEJO_PUSH_TOKEN).toBe('${FORGEJO_PUSH_TOKEN}')
    for (const naam of ['SCRUM4ME_TOKEN', 'DATABASE_URL', 'DIRECT_URL', 'FORGEJO_PUSH_TOKEN']) expect(cfg.mcp.env?.[naam]).toBe('${' + naam + '}')
    expect(cfg.task?.limits).toEqual({ maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8 })
    expect(cfg.limits).toEqual({ maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2 })
  })
})

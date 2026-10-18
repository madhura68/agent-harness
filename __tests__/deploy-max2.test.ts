import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOC_TOOLS, loadWorkerConfig } from '../src/worker/config.js'

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

  it('voldoet aan het strikte workerschema en noemt precies de configuraties uit litellm/config.yaml', () => {
    expect(Object.keys(cfg.configurations).sort()).toEqual([
      'deepseek-v4-flash-or',
      'deepseek-v4-pro-or',
      'glm-5.3-or',
      'gsq-lokaal',
      'minimax-m3-or',
      'qwen3.8-or',
      'qwen3.8-or-128k',
      'qwen3.8-or-16k',
      'qwen3.8-or-32k',
    ])
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
    // Context-window trial: the same model and settings, only the window differs.
    for (const [naam, venster] of [['qwen3.8-or-16k', 16384], ['qwen3.8-or-32k', 32768], ['qwen3.8-or-128k', 131072]] as const) {
      expect(cfg.configurations[naam]).toEqual({ costMode: 'hosted', contextTokens: venster, reasoningEffort: 'medium' })
    }
    // Model comparison: the same window as the qwen3.8-or baseline. The effort is one each model accepts according to
    // OpenRouter's reasoning.supported_efforts (DeepSeek V4: xhigh/high/none, GLM-5.3: max/high/low, MiniMax-M3: no choice).
    for (const naam of ['deepseek-v4-flash-or', 'deepseek-v4-pro-or', 'glm-5.3-or']) {
      expect(cfg.configurations[naam]).toEqual({ costMode: 'hosted', contextTokens: 65536, reasoningEffort: 'high' })
    }
    expect(cfg.configurations['minimax-m3-or']).toEqual({ costMode: 'hosted', contextTokens: 65536 })
  })

  it('pint de vergelijkingsmodellen op FP8 zonder dataverzameling, en houdt qwen3.8-or op BF16', () => {
    expect(yaml).toMatch(/extra_body: &or-fp8-extra\n\s+provider:\n\s+quantizations: \["fp8"\]\n\s+data_collection: "deny"/)
    expect(yaml.match(/extra_body: \*or-fp8-extra/g)).toHaveLength(3)
    expect(yaml).toMatch(/quantizations: \["bf16"\]/)
  })

  it('geeft een taak met repo_url de repo-sleutel voor agent-harness en bevat geen geheime waarde', () => {
    expect(cfg.mcp.env?.['SCRUM4ME_REPO_ROOT_REPO_agent-harness']).toBe('/var/lib/agent-harness/repos/agent-harness')
    expect(cfg.mcp.env?.SCRUM4ME_TOKEN).toBe('${SCRUM4ME_TOKEN}')
    expect(cfg.mcp.env?.FORGEJO_PUSH_TOKEN).toBe('${FORGEJO_PUSH_TOKEN}')
    for (const naam of ['SCRUM4ME_TOKEN', 'DATABASE_URL', 'DIRECT_URL', 'FORGEJO_PUSH_TOKEN']) expect(cfg.mcp.env?.[naam]).toBe('${' + naam + '}')
    // maxTurns 80 (2026-10-18): models that make about one tool call per turn need ~45-70 turns for a 9-file task.
    expect(cfg.task?.limits).toEqual({ maxTurns: 80, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8 })
    expect(cfg.limits).toEqual({ maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2 })
  })

  it('geeft de idee-chat de vier doc-tools en de chat-agent daarbij de issue- en notitietools, zonder update-tools (IDEA-262)', () => {
    expect(cfg.allow.IDEA_CHAT).toEqual([...DOC_TOOLS])
    expect(cfg.allow.AGENT_CHAT).toEqual(expect.arrayContaining([...DOC_TOOLS, 'create_issue', 'create_note']))
    expect(cfg.allow.AGENT_CHAT.filter((tool) => tool.startsWith('update_'))).toEqual([])
  })
})

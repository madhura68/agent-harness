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
      'claude-sonnet-5.5-or',
      'deepseek-v4-flash-or',
      'deepseek-v4-pro-or',
      'glm-5.3-or',
      'gpt-6-luna-or',
      'gpt-6.1-sol-or',
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
    // M8 review-bench: three proprietary models behind OpenRouter, all with the 131072 window the review case needs.
    expect(cfg.configurations['gpt-6-luna-or']).toEqual({ costMode: 'hosted', contextTokens: 131072, reasoningEffort: 'medium' })
    expect(cfg.configurations['claude-sonnet-5.5-or']).toEqual({ costMode: 'hosted', contextTokens: 131072, reasoningEffort: 'high' })
    expect(cfg.configurations['gpt-6.1-sol-or']).toEqual({ costMode: 'hosted', contextTokens: 131072, reasoningEffort: 'medium' })
    // The new configurations come last (review record round 2, C-m3), after the existing ones, in this order.
    expect(Object.keys(cfg.configurations).slice(-3)).toEqual(['gpt-6-luna-or', 'claude-sonnet-5.5-or', 'gpt-6.1-sol-or'])
  })

  it('pint de vergelijkingsmodellen op FP8 zonder dataverzameling, en houdt qwen3.8-or op BF16', () => {
    expect(yaml).toMatch(/extra_body: &or-fp8-extra\n\s+provider:\n\s+quantizations: \["fp8"\]\n\s+data_collection: "deny"/)
    expect(yaml.match(/extra_body: \*or-fp8-extra/g)).toHaveLength(3)
    expect(yaml).toMatch(/quantizations: \["bf16"\]/)
  })

  it('geeft de drie propriëtaire modellen één provider-blok zonder quantizations, met de OpenRouter-modelnamen en alleen een sleutelverwijzing', () => {
    // The anchor is defined once, on the first proprietary item, and carries no quantizations pin: proprietary endpoints do not publish one.
    expect(yaml.match(/&or-proprietary-extra/g)).toHaveLength(1)
    expect(yaml).toMatch(
      /extra_body: &or-proprietary-extra\n\s+provider:\n\s+data_collection: "deny"\n\s+require_parameters: true\n\s+allow_fallbacks: true\n\s+sort: "price"\n\s+max_price:\n\s+prompt: 3\n\s+completion: 12\n/,
    )
    expect(yaml.match(/extra_body: \*or-proprietary-extra/g)).toHaveLength(2)
    // Each of the three items: its model_name, the OpenRouter model, the key reference, the timeout and the reasoning model_info.
    for (const [naam, model] of [
      ['gpt-6-luna-or', 'openrouter/openai/gpt-6-luna'],
      ['claude-sonnet-5.5-or', 'openrouter/anthropic/claude-sonnet-5.5'],
      ['gpt-6.1-sol-or', 'openrouter/openai/gpt-6.1-sol'],
    ] as const) {
      const blok = yaml.match(new RegExp(`- model_name: ${naam.replace(/\./g, '\\.')}\\n((?:    .*\\n)+)`))
      expect(blok, naam).not.toBeNull()
      expect(blok![1]).toContain(`model: ${model}\n`)
      expect(blok![1]).not.toContain('quantizations')
      expect(blok![1]).toContain('api_key: os.environ/OPENROUTER_API_KEY\n')
      expect(blok![1]).toContain('timeout: 600\n')
      expect(blok![1]).toMatch(/model_info: \*or-reasoning-info\n$/)
    }
    // The FP8 anchor is untouched: still three users and no proprietary item points at it.
    expect(yaml.match(/extra_body: \*or-fp8-extra/g)).toHaveLength(3)
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

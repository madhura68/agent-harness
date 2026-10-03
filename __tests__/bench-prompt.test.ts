import { afterEach, describe, expect, it, vi } from 'vitest'
import { BenchCaseSchema, type BenchCase } from '../src/bench/case.js'
import { BENCH_SYSTEM_PROMPT, benchTaskPrompt } from '../src/bench/task-prompt.js'
import { DOC_TOOLS } from '../src/worker/config.js'
import { renderTaskPrompt, TASK_SYSTEM_PROMPT, TaskPayloadSchema } from '../src/worker/task-impl.js'
import { taskPayload } from './fakes/task-payload.js'

// The one clause that sets the bench system prompt apart from the worker's (spec §4.1).
const CLAUSE = ', en je kunt productdocumentatie lezen met de doc-tools'
// Everything that points a model at the doc tools: their names, the key phrase of the clause and the prompt block about them.
const DOC_TOOL_TRACES = [...DOC_TOOLS, 'doc-tools', '## Product']

const exampleCase = {
  id: 'AH-01',
  repo_url: 'https://git.jp-visser.nl/janpeter/agent-harness.git',
  base_commit: 'a1b2c3d4e5'.repeat(4),
  ref_commit: 'f6e5d4c3b2'.repeat(4),
  task: { code: 'T-42', title: 'feat: voeg greet() toe', description: 'Voeg een functie greet toe.', implementation_plan: 'Schrijf src/greet.ts en een test.' },
  story: { title: 'Begroeting', description: 'De app begroet de gebruiker.', acceptance_criteria: 'greet("x") geeft "hallo x".' },
  hidden_tests: ['__tests__/greet.test.ts'],
  lines: 42,
  kind: 'feat',
} satisfies BenchCase

/** The `## ` headings of a prompt, in order; `### ` sub-headings do not match. */
const headings = (text: string) => text.match(/^## .+$/gm)

describe('BenchCaseSchema', () => {
  /** The schema paths that `input` is rejected on, e.g. ['hidden_tests.0']; empty when it is accepted. */
  const rejectedPaths = (input: unknown) => {
    const result = BenchCaseSchema.safeParse(input)
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  }

  it('accepts an example case and keeps every field', () => {
    expect(BenchCaseSchema.parse(exampleCase)).toEqual(exampleCase)
  })

  it('accepts null for the optional texts', () => {
    const bare = {
      ...exampleCase,
      task: { ...exampleCase.task, description: null, implementation_plan: null },
      story: { ...exampleCase.story, description: null, acceptance_criteria: null },
    }
    expect(BenchCaseSchema.parse(bare)).toEqual(bare)
  })

  it.each([
    ['a base_commit of 7 characters', { base_commit: 'a1b2c3d' }, 'base_commit'],
    ['a ref_commit that is not lowercase hex', { ref_commit: 'F6E5D4C3B2'.repeat(4) }, 'ref_commit'],
    ['an empty hidden_tests', { hidden_tests: [] }, 'hidden_tests'],
    ['a hidden test outside __tests__/', { hidden_tests: ['src/greet.test.ts'] }, 'hidden_tests.0'],
    ['a hidden file that is not a .test.ts', { hidden_tests: ['__tests__/helpers.ts'] }, 'hidden_tests.0'],
    ['an id like ah-1', { id: 'ah-1' }, 'id'],
    ['a kind other than feat or fix', { kind: 'chore' }, 'kind'],
  ])('rejects %s', (_what, patch, path) => {
    expect(rejectedPaths({ ...exampleCase, ...patch })).toEqual([path])
  })
})

describe('BENCH_SYSTEM_PROMPT', () => {
  it('is the worker system prompt with exactly the doc-tools clause removed', () => {
    // The first assertion makes a later change of the worker prompt visible: the clause must still be there to remove.
    expect(TASK_SYSTEM_PROMPT.includes(CLAUSE)).toBe(true)
    expect(TASK_SYSTEM_PROMPT.replace(CLAUSE, '')).toBe(BENCH_SYSTEM_PROMPT)
  })

  it.each(DOC_TOOL_TRACES)('does not mention %s', (trace) => {
    expect(BENCH_SYSTEM_PROMPT).not.toContain(trace)
  })
})

describe('benchTaskPrompt', () => {
  const prompt = benchTaskPrompt(exampleCase)

  it.each(DOC_TOOL_TRACES)('does not mention %s', (trace) => {
    expect(prompt).not.toContain(trace)
  })

  it('renders the task, the plan, the story with its acceptance criteria and the repository', () => {
    const { id, task, story, repo_url } = exampleCase
    expect(prompt).toContain(`## Taak\n\n${task.title}\n\n${task.description}`)
    expect(prompt).toContain(`## Plan\n\n${task.implementation_plan}`)
    expect(prompt).toContain(`## Story\n\n${story.title}\n\n${story.description}`)
    expect(prompt).toContain(`### Acceptatiecriteria\n\n${story.acceptance_criteria}`)
    expect(prompt).toContain(`## Repository\n\nURL: ${repo_url}\n\nBranch: bench/${id}`)
  })

  it('has the worker sections in the worker order, minus ## Product', () => {
    expect(headings(prompt)).toEqual(['## Taak', '## Plan', '## Story', '## Repository'])
  })

  it('leaves out the empty parts when description, plan and acceptance criteria are null', () => {
    const bare = benchTaskPrompt({
      ...exampleCase,
      task: { ...exampleCase.task, description: null, implementation_plan: null },
      story: { ...exampleCase.story, description: null, acceptance_criteria: null },
    })
    expect(headings(bare)).toEqual(['## Taak', '## Story', '## Repository'])
    expect(bare).not.toContain('Acceptatiecriteria')
    expect(bare).not.toContain('null')
  })

  it('keeps the commits and the hidden tests out of the prompt', () => {
    for (const hidden of [exampleCase.base_commit, exampleCase.ref_commit, ...exampleCase.hidden_tests]) {
      expect(prompt).not.toContain(hidden)
    }
  })
})

describe('renderTaskPrompt — productBlock option', () => {
  const payload = TaskPayloadSchema.parse(taskPayload({ productId: 'prod-scrum4me' }))
  // The output of renderTaskPrompt for this payload as it was before the option existed.
  const taak = '## Taak\n\nfeat: voeg greet() toe\n\nVoeg een functie greet toe.'
  const plan = '## Plan\n\nSchrijf src/greet.ts en een test.'
  const story = '## Story\n\nBegroeting\n\nDe app begroet de gebruiker.\n\n### Acceptatiecriteria\n\ngreet("x") geeft "hallo x".'
  const product = '## Product\n\nproduct_id: `prod-scrum4me` — gebruik exact dit id voor search_product_docs en list_product_docs'
  const repository = '## Repository\n\nURL: https://git.example/repo.git\n\nBranch: feat/story-1'
  const withProduct = [taak, plan, story, product, repository].join('\n\n')

  it('renders the ## Product block by default, exactly as before', () => {
    expect(renderTaskPrompt(payload)).toBe(withProduct)
  })

  it('renders the block with empty options or productBlock: true', () => {
    expect(renderTaskPrompt(payload, {})).toBe(withProduct)
    expect(renderTaskPrompt(payload, { productBlock: true })).toBe(withProduct)
  })

  it('leaves out the ## Product block, and nothing else, with productBlock: false', () => {
    expect(renderTaskPrompt(payload, { productBlock: false })).toBe([taak, plan, story, repository].join('\n\n'))
  })
})

describe('BENCH_SYSTEM_PROMPT — load-time check', () => {
  afterEach(() => {
    vi.doUnmock('../src/worker/task-impl.js')
    vi.resetModules()
  })

  it('refuses to load when the worker system prompt no longer holds the clause', async () => {
    vi.resetModules()
    vi.doMock('../src/worker/task-impl.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/worker/task-impl.js')>()),
      TASK_SYSTEM_PROMPT: 'Een systeemprompt zonder die bijzin.',
    }))
    await expect(import('../src/bench/task-prompt.js')).rejects.toThrow(/doc-tools/)
  })
})

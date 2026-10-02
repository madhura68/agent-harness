import { renderTaskPrompt, TASK_SYSTEM_PROMPT, type TaskPayload } from '../worker/task-impl.js'
import type { BenchCase } from './case.js'

// The one clause of the worker's system prompt that points at the doc tools. The bench has none (spec §4.1): the docs store
// of today may already hold the solution of an old task.
const DOC_TOOLS_CLAUSE = ', en je kunt productdocumentatie lezen met de doc-tools'

// Without the clause there is nothing to remove, and a reworded prompt could still point at the doc tools: stop and look.
if (!TASK_SYSTEM_PROMPT.includes(DOC_TOOLS_CLAUSE)) {
  throw new Error('BENCH_SYSTEM_PROMPT: de bijzin over de doc-tools staat niet meer in TASK_SYSTEM_PROMPT; pas src/bench/task-prompt.ts aan')
}

/** The worker's system prompt for TASK_IMPLEMENTATION, without the doc-tools clause; nothing else differs. */
export const BENCH_SYSTEM_PROMPT = TASK_SYSTEM_PROMPT.replace(DOC_TOOLS_CLAUSE, '')

/** The user message of a bench run: the worker's own `renderTaskPrompt` for the case's task, without the `## Product` block. */
export function benchTaskPrompt(c: BenchCase): string {
  const payload: TaskPayload = {
    job_id: 'bench',
    kind: 'TASK_IMPLEMENTATION',
    task: { id: c.task.code, title: c.task.title, description: c.task.description, implementation_plan: c.task.implementation_plan, repo_url: c.repo_url },
    story: { id: 'bench', title: c.story.title, description: c.story.description, acceptance_criteria: c.story.acceptance_criteria },
    product: { id: 'bench', repo_url: c.repo_url },
    worktree_path: '.',
    branch_name: `bench/${c.id}`,
  }
  return renderTaskPrompt(payload, { productBlock: false })
}

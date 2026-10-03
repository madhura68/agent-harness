import { z } from 'zod'

const nullableText = z.string().nullable()

/**
 * One case of the task-bench (spec §4.2): a finished task as the worker would get it, the commit it started from, the commit
 * it landed in, and the hidden tests that judge a solution. The model sees the task text only, never the commits or the tests.
 */
export const BenchCaseSchema = z.object({
  id: z.string().regex(/^[A-Z]{2}-\d{2}$/),
  repo_url: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  ref_commit: z.string().regex(/^[0-9a-f]{40}$/),
  task: z.object({ code: z.string().min(1), title: z.string().min(1), description: nullableText, implementation_plan: nullableText }),
  story: z.object({ title: z.string().min(1), description: nullableText, acceptance_criteria: nullableText }),
  hidden_tests: z.array(z.string().regex(/^__tests__\/.+\.test\.ts$/)).min(1),
  lines: z.number(),
  kind: z.enum(['feat', 'fix']),
})

export type BenchCase = z.infer<typeof BenchCaseSchema>

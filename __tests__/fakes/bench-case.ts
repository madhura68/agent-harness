import { BenchCaseSchema, type BenchCase } from '../../src/bench/case.js'
import { TaskConfigSchema, type TaskConfig } from '../../src/worker/config.js'
import type { BenchRepo } from './bench-repo.js'

/**
 * A case on the fixture repo: the task is "add src/y.ts", `base_commit` is commit A, `ref_commit` is commit B, and the hidden test is
 * the `__tests__/b.test.ts` that only B has. `over` replaces whole top-level fields.
 */
export function benchCaseFor(repo: BenchRepo, over: Partial<BenchCase> = {}): BenchCase {
  return BenchCaseSchema.parse({
    id: 'AH-01',
    repo_url: repo.url,
    base_commit: repo.a,
    ref_commit: repo.b,
    task: { code: 'T-1', title: 'feat: voeg y toe', description: 'Maak src/y.ts met een export y.', implementation_plan: 'Schrijf src/y.ts.' },
    story: { title: 'De waarde y', description: 'De app heeft y nodig.', acceptance_criteria: 'y is 2.' },
    hidden_tests: ['__tests__/b.test.ts'],
    lines: 30,
    kind: 'feat',
    ...over,
  })
}

/**
 * The task block of a worker config for the fixture repo: prepare `npm ci`, verify `npm test`. `over` replaces whole top-level fields,
 * and the schema fills in the rest (3 verify repairs, the timeouts), as it does for a real config.
 */
export function benchTaskConfigFor(repo: BenchRepo, over: Record<string, unknown> = {}): TaskConfig {
  return TaskConfigSchema.parse({
    limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 60, maxToolErrors: 3 },
    image: 'node:24-bookworm',
    uid: 1000,
    gid: 1000,
    npmCacheDir: '/tmp/npm-cache',
    recipes: [{ repoUrl: repo.url, prepare: ['npm ci'], verify: 'npm test' }],
    ...over,
  })
}

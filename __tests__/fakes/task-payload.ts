/** A TASK_IMPLEMENTATION payload in the shape the scrum4me-mcp wait_for_job COPILOT branch returns. */
export function taskPayload(opts: {
  jobId?: string
  worktree?: string
  repoUrl?: string | null
  productRepoUrl?: string | null
  productId?: string
  title?: string
  description?: string | null
  plan?: string | null
  storyDescription?: string | null
  acceptance?: string | null
} = {}) {
  return {
    job_id: opts.jobId ?? 'job1',
    kind: 'TASK_IMPLEMENTATION',
    source: 'COPILOT',
    status: 'claimed',
    task: {
      id: 'task-1',
      code: 'T-1',
      title: opts.title ?? 'feat: voeg greet() toe',
      description: opts.description === undefined ? 'Voeg een functie greet toe.' : opts.description,
      implementation_plan: opts.plan === undefined ? 'Schrijf src/greet.ts en een test.' : opts.plan,
      repo_url: opts.repoUrl === undefined ? 'https://git.example/repo.git' : opts.repoUrl,
    },
    story: {
      id: 'story-1',
      title: 'Begroeting',
      description: opts.storyDescription === undefined ? 'De app begroet de gebruiker.' : opts.storyDescription,
      acceptance_criteria: opts.acceptance === undefined ? 'greet("x") geeft "hallo x".' : opts.acceptance,
    },
    product: { id: opts.productId ?? 'prod-harness', name: 'Agent-harness', repo_url: opts.productRepoUrl === undefined ? null : opts.productRepoUrl },
    worktree_path: opts.worktree ?? '/nonexistent/worktree',
    branch_name: 'feat/story-1',
    prompt_text: 'Claude-prompt die de harness negeert',
  }
}

/**
 * The review prompt for a tool-calling harness run (M8 spec §4.5). The production prompt `review.md` talks about a sealed container:
 * a payload file at `$PAYLOAD_PATH`, sources under `/sources`, a checkout under `/work` and a result file under `/output`. The bench has
 * `list_files`, `read_file` and `search` on one workspace and the model answers in its last message, so those sentences are replaced.
 *
 * The replacements are an exact, counted list: each `from` must occur exactly `count` times, or the function throws. A change in
 * production `review.md` therefore stops the bench instead of silently leaving a container path in the prompt.
 */

export interface ReviewPromptReplacement {
  id: string
  from: string
  to: string
  /** How often `from` occurs in the production prompt, measured on the fixture. */
  count: number
}

/** In the order they are applied. A2a runs before A2b, so the `/sources` of A2b is the one that is left after A2a. */
export const REVIEW_PROMPT_REPLACEMENTS: ReadonlyArray<ReviewPromptReplacement> = [
  { id: 'A1', from: '$PAYLOAD_PATH', to: 'payload.json', count: 2 },
  { id: 'A2a', from: '`/sources/<key>`', to: '`sources/<key>`', count: 1 },
  { id: 'A2b', from: 'from `/sources`', to: 'from `sources/`', count: 1 },
  { id: 'A3', from: '`/work`', to: '`work/`', count: 3 },
  {
    id: 'A4',
    from: 'Everything is read-only except `/output`.',
    to: 'Everything is read-only. Your tools are `list_files`, `read_file` and `search`; paths are relative to your workspace root (`payload.json`, `sources/<key>`).',
    count: 1,
  },
  {
    id: 'A5',
    from: 'Write exactly one file, `/output/result.json`, as a `DispatchResult`:',
    to: 'Give your final message as exactly one JSON object, a `DispatchResult`, and nothing else:',
    count: 1,
  },
  {
    id: 'A6',
    from: 'Write the manifest last, and write it even when you could not finish.',
    to: 'Give the manifest as your last message, and give it even when you could not finish.',
    count: 1,
  },
]

/** Applies A1–A6 to the production review prompt. Throws on the first replacement whose `from` does not occur exactly `count` times. */
export function adaptReviewPrompt(original: string): string {
  let text = original
  for (const { id, from, to, count } of REVIEW_PROMPT_REPLACEMENTS) {
    const found = text.split(from).length - 1
    if (found !== count) throw new Error(`review-prompt: ${id} verwacht ${count}× ${JSON.stringify(from)}, gevonden ${found}`)
    text = text.replaceAll(from, to)
  }
  return text
}

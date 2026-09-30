import { describe, expect, it } from 'vitest'
import type { ToolDef, ToolExecResult, ToolRegistry } from '../src/types.js'
import { capDocArgs } from '../src/worker/doc-tools.js'

const RESULT: ToolExecResult = { ok: true, content: '{"truncated":true,"next_offset":12000}', truncated: false }
const TOOLS: ToolDef[] = [{ type: 'function', function: { name: 'get_product_doc', parameters: { type: 'object' } } }]

/** A view that records what reaches it, in place of the MCP doc-tools view. */
function fakeView() {
  const calls: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal }> = []
  let closed = 0
  const view: ToolRegistry = {
    snapshot: Object.freeze({ entries: [], hash: 'h' }),
    toOpenAiTools: () => TOOLS,
    async execute(name, args, signal) {
      calls.push({ name, args, signal })
      return RESULT
    },
    async close() {
      closed++
    },
  }
  return { view, calls, closed: () => closed }
}

const sig = () => AbortSignal.timeout(1000)
const doc = { product_id: 'p', folder: 'plans', slug: 'm5-model-comparison-refiner' }

describe('capDocArgs', () => {
  it('lowers a max_chars above 12 000 for get_product_doc to 12 000 and keeps the other arguments', async () => {
    const { view, calls } = fakeView()
    const capped = capDocArgs(view)
    await capped.execute('get_product_doc', { ...doc, max_chars: 40_000, offset: 12_000 }, sig())
    await capped.execute('get_product_doc', { ...doc, max_chars: 12_001, heading: 'Doel' }, sig())
    expect(calls.map((c) => c.args)).toEqual([
      { ...doc, max_chars: 12_000, offset: 12_000 },
      { ...doc, max_chars: 12_000, heading: 'Doel' },
    ])
  })

  it.each([12_000, 8_000, undefined])('passes max_chars %s through unchanged', async (maxChars) => {
    const { view, calls } = fakeView()
    const args = maxChars === undefined ? { ...doc } : { ...doc, max_chars: maxChars }
    await capDocArgs(view).execute('get_product_doc', args, sig())
    expect(calls[0].args).toEqual(args)
  })

  it('leaves other tools alone, also with a max_chars argument', async () => {
    const { view, calls } = fakeView()
    await capDocArgs(view).execute('search_product_docs', { product_id: 'p', query: 'x', max_chars: 40_000 }, sig())
    expect(calls[0]).toMatchObject({ name: 'search_product_docs', args: { product_id: 'p', query: 'x', max_chars: 40_000 } })
  })

  it('passes the snapshot, tool list, signal, result and close of the view through', async () => {
    const { view, calls, closed } = fakeView()
    const capped = capDocArgs(view)
    expect(capped.snapshot).toBe(view.snapshot)
    expect(capped.toOpenAiTools()).toBe(TOOLS)
    const signal = sig()
    expect(await capped.execute('get_product_doc', { ...doc, max_chars: 40_000 }, signal)).toBe(RESULT)
    expect(calls[0].signal).toBe(signal)
    await capped.close()
    expect(closed()).toBe(1)
  })
})

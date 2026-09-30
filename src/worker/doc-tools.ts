import type { ToolRegistry } from '../types.js'

/**
 * The largest max_chars the worker passes to get_product_doc. scrum4me-mcp accepts up to 40 000, but past about 15 400
 * characters its JSON answer exceeds TOOL_OUTPUT_LIMIT, and the registry's byte cut then drops the keys at the end
 * (truncated, next_offset): the model can no longer page on. 12 000 is the MCP's own default; every doc of the product
 * then answers in at most 12.9 KB, and the MCP flags the shorter chunk itself with truncated and next_offset.
 */
export const DOC_MAX_CHARS = 12_000

/**
 * The worker's doc-tools view with get_product_doc's max_chars capped at DOC_MAX_CHARS. The schema the model sees stays as
 * the MCP offers it: a lower maximum there would make the policy refuse the call, which counts as a tool error.
 */
export function capDocArgs(view: ToolRegistry): ToolRegistry {
  return {
    snapshot: view.snapshot,
    toOpenAiTools: () => view.toOpenAiTools(),
    execute(name, args, signal) {
      const cap = name === 'get_product_doc' && typeof args.max_chars === 'number' && args.max_chars > DOC_MAX_CHARS
      return view.execute(name, cap ? { ...args, max_chars: DOC_MAX_CHARS } : args, signal)
    },
    close: () => view.close(),
  }
}

// Draft-07 Ajv on purpose: MCP SDK registerTool converts zod via toJsonSchemaCompat without a target, and
// mapMiniTarget falls back to 'draft-7' (sdk/dist/esm/server/zod-json-schema-compat.js:9-16). Every inputSchema
// carries `$schema: http://json-schema.org/draft-07/schema#`, which Ajv2020 rejects.
import { Ajv, type ValidateFunction } from 'ajv'
import type { ToolCall, ToolSnapshot } from '../types.js'

export type PolicyDecision =
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; errorCode: 'UNKNOWN_TOOL' | 'MALFORMED_ARGS' | 'SCHEMA_MISMATCH'; message: string }

export type Policy = { check(call: ToolCall): PolicyDecision }

export function createPolicy(snapshot: ToolSnapshot): Policy {
  // strict: false — MCP schemas sometimes carry keywords Ajv does not know.
  const ajv = new Ajv({ strict: false, allErrors: false })
  const tools = new Map<string, { validate: ValidateFunction; hasRequired: boolean }>()
  for (const entry of snapshot.entries) {
    // Drop $schema so a later SDK bump to another draft does not break compilation outright.
    const { $schema: _ignored, ...schema } = structuredClone(entry.inputSchema)
    const required = (schema as { required?: unknown }).required
    tools.set(entry.name, {
      validate: ajv.compile(schema),
      hasRequired: Array.isArray(required) && required.length > 0,
    })
  }

  return {
    check(call) {
      const tool = tools.get(call.name)
      if (!tool) return { ok: false, errorCode: 'UNKNOWN_TOOL', message: `tool ${call.name} is not allowed in this run` }

      let args: unknown
      if (call.arguments.trim() === '') {
        if (tool.hasRequired) return { ok: false, errorCode: 'MALFORMED_ARGS', message: 'arguments are empty but the tool has required properties' }
        args = {}
      } else {
        try {
          args = JSON.parse(call.arguments)
        } catch (err) {
          return { ok: false, errorCode: 'MALFORMED_ARGS', message: `arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
        }
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, errorCode: 'MALFORMED_ARGS', message: 'arguments must be a JSON object' }
      }
      if (!tool.validate(args)) {
        return { ok: false, errorCode: 'SCHEMA_MISMATCH', message: ajv.errorsText(tool.validate.errors) }
      }
      return { ok: true, name: call.name, args: args as Record<string, unknown> }
    },
  }
}

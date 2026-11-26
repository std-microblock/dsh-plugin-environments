// The tool definitions of this package are authored in DSH's tool-schema DSL, which the MCP
// server cannot import at runtime (it must run outside a DSH installation). This module turns
// that DSL — `parameters` plus `required: true` annotations — into the raw JSON Schema an MCP
// client expects, and validates calls against it before a tool body sees them.
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Raw JSON Schema node (the subset the tool specs use). */
export interface JsonSchemaNode {
  type?: string
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
  enum?: readonly unknown[]
  const?: unknown
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  oneOf?: JsonSchemaNode[]
}

/** Copy the author-facing annotations shared by every schema node. */
function annotations(spec: ValueSchemaSpec): JsonSchemaNode {
  const node: JsonSchemaNode = {}
  if (spec.description !== undefined) node.description = spec.description
  if (spec.title !== undefined) node.title = spec.title
  if (spec.default !== undefined) node.default = spec.default
  if (spec.examples !== undefined) node.examples = spec.examples
  return node
}

/** Convert one value schema to raw JSON Schema. */
export function valueToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  const node = annotations(spec)
  if ('oneOf' in spec) {
    node.oneOf = spec.oneOf.map(valueToJsonSchema)
    return node
  }
  switch (spec.type) {
    case 'json':
      // Author-only free-form node: an annotation-only schema accepts any JSON value.
      return node
    case 'object': {
      node.type = 'object'
      node.additionalProperties = spec.additionalProperties
      if (spec.properties) {
        const converted = parametersToJsonSchema(spec.properties)
        node.properties = converted.properties ?? {}
        if (converted.required?.length) node.required = converted.required
      }
      return node
    }
    case 'array':
      node.type = 'array'
      if (spec.items) node.items = valueToJsonSchema(spec.items)
      return node
    case 'null':
      node.type = 'null'
      return node
    default:
      node.type = spec.type
      if (spec.enum) node.enum = spec.enum
      if (spec.const !== undefined) node.const = spec.const
      return node
  }
}

/**
 * Convert a parameter map to an object-rooted JSON Schema. The map is DSH's implicit open
 * object root, so no `additionalProperties` override is emitted here.
 */
export function parametersToJsonSchema(parameters: ParameterSchemaSpec): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(parameters)) {
    const node = valueToJsonSchema(spec)
    if (spec.description !== undefined && node.description === undefined) node.description = spec.description
    properties[name] = node
    if (spec.required === true) required.push(name)
  }
  const schema: JsonSchemaNode = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/** Whether a value is a plain JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Validate one value against a schema node, collecting path-qualified violations. */
function checkValue(spec: ValueSchemaSpec, value: unknown, path: string, out: string[]): void {
  if (value === undefined) return
  if ('oneOf' in spec) {
    const branches = spec.oneOf.map(branch => {
      const errors: string[] = []
      checkValue(branch, value, path, errors)
      return errors.length
    })
    if (!branches.includes(0)) out.push(`${path}: does not match any allowed shape`)
    return
  }
  switch (spec.type) {
    case 'json':
      return
    case 'string':
      if (typeof value !== 'string') out.push(`${path}: expected a string, got ${typeName(value)}`)
      return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        out.push(`${path}: expected a number, got ${typeName(value)}`)
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        out.push(`${path}: expected an integer, got ${typeName(value)}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path}: expected a boolean, got ${typeName(value)}`)
      return
    case 'null':
      if (value !== null) out.push(`${path}: expected null, got ${typeName(value)}`)
      return
    case 'array': {
      if (!Array.isArray(value)) {
        out.push(`${path}: expected an array, got ${typeName(value)}`)
        return
      }
      const items = spec.items
      if (items) value.forEach((item, i) => checkValue(items, item, `${path}[${i}]`, out))
      return
    }
    case 'object': {
      if (!isPlainObject(value)) {
        out.push(`${path}: expected an object, got ${typeName(value)}`)
        return
      }
      if (spec.properties) checkProperties(spec.properties, value, path, out)
      return
    }
  }
}

function checkProperties(
  parameters: ParameterSchemaSpec,
  args: Record<string, unknown>,
  path: string,
  out: string[],
): void {
  for (const [name, spec] of Object.entries(parameters)) {
    const key = path ? `${path}.${name}` : name
    if (spec.required === true && args[name] === undefined) {
      out.push(`${key}: required`)
      continue
    }
    checkValue(spec, args[name], key, out)
  }
}

/**
 * Validate tool arguments against a parameter map. Returns path-qualified violations; an empty
 * array means the call is well-formed.
 */
export function validateArgs(parameters: ParameterSchemaSpec, args: unknown): string[] {
  if (args === undefined || args === null) args = {}
  if (!isPlainObject(args)) return [`arguments: expected an object, got ${typeName(args)}`]
  const out: string[] = []
  checkProperties(parameters, args, '', out)
  return out
}

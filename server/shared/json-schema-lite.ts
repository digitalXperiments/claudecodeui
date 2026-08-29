/**
 * Minimal JSON Schema validator for Agent Relay structured outputs.
 *
 * Relay leads declare an output schema per task and workers return JSON that
 * must match it. Full JSON Schema is far more than that contract needs, and
 * the server has no schema dependency, so this validates the practical subset:
 * type, properties/required/additionalProperties, items, enum/const, anyOf,
 * and the common string/number/array bounds. Unknown keywords are ignored,
 * matching JSON Schema's own permissive stance.
 */

export type JsonSchema = Record<string, unknown>;

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
};

function typeMatches(value: unknown, type: unknown): boolean {
  if (typeof type === 'string') return TYPE_CHECKS[type]?.(value) ?? true;
  if (Array.isArray(type)) return type.some((entry) => typeMatches(value, entry));
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateAt(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (errors.length >= 20) return;

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
    return;
  }

  const composites = [schema.anyOf, schema.oneOf].filter(Array.isArray) as JsonSchema[][];
  for (const options of composites) {
    const matched = options.some((option) => {
      const branchErrors: string[] = [];
      validateAt(value, option, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matched) errors.push(`${path}: matched none of the ${options.length} allowed variants`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const option of schema.allOf as JsonSchema[]) validateAt(value, option, path, errors);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((entry, index) => validateAt(entry, schema.items as JsonSchema, `${path}[${index}]`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, JsonSchema>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && record[key] === undefined) errors.push(`${path}: missing required property "${key}"`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (record[key] !== undefined && propertySchema && typeof propertySchema === 'object') {
        validateAt(record[key], propertySchema, `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  validateAt(value, schema, '$', errors);
  return { valid: errors.length === 0, errors: errors.slice(0, 20) };
}

/**
 * Guards a lead-supplied schema before it is persisted: it must be a plain
 * object and stay small enough to embed in a worker prompt.
 */
export function normalizeDeclaredSchema(value: unknown, maxChars = 8_000): JsonSchema | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  if (!serialized || serialized === '{}' || serialized.length > maxChars) return null;
  return JSON.parse(serialized) as JsonSchema;
}

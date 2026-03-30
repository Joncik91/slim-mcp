import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type CompressionLevel = 'none' | 'standard' | 'aggressive';

/**
 * Compress a list of tools according to the specified level.
 * 'none' returns tools unchanged.
 * 'standard' and 'aggressive' apply Stage 1 structural cleanup.
 */
export function compressTools(tools: Tool[], level: CompressionLevel): Tool[] {
  if (level === 'none') {
    return tools;
  }

  const compressed = tools.map((tool) => compressTool(tool, level));

  // Stage 3: parameter deduplication (aggressive only)
  if (level === 'aggressive') {
    deduplicateParams(compressed);
  }

  return compressed;
}

/**
 * Stage 3: For repeated property name + type combos across tools,
 * keep first occurrence's full definition and strip subsequent to { type } only.
 */
function deduplicateParams(tools: Tool[]): void {
  // Map of "propName:type" → true (already seen)
  const seen = new Map<string, boolean>();

  for (const tool of tools) {
    const props = (tool as any).inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) continue;

    for (const [propName, prop] of Object.entries(props)) {
      const propType = typeof prop['type'] === 'string' ? prop['type'] : 'unknown';
      const key = `${propName}:${propType}`;

      if (seen.has(key)) {
        // Strip to minimal — keep only type
        const type = prop['type'];
        for (const k of Object.keys(prop)) {
          if (k !== 'type') delete prop[k];
        }
        if (type !== undefined) prop['type'] = type;
      } else {
        seen.set(key, true);
      }
    }
  }
}

function compressTool(tool: Tool, level: CompressionLevel): Tool {
  // Deep clone to avoid mutating input
  const cloned = structuredClone(tool) as any;

  // Remove empty description at tool level
  if (typeof cloned.description === 'string' && cloned.description === '') {
    delete cloned.description;
  }

  // Guard: if no inputSchema, return as-is
  if (!cloned.inputSchema || typeof cloned.inputSchema !== 'object') {
    return cloned as Tool;
  }

  // Clean top-level schema (removes additionalProperties, $schema from the schema object)
  cleanSchema(cloned.inputSchema);

  // Recurse into properties
  if (cloned.inputSchema.properties && typeof cloned.inputSchema.properties === 'object') {
    for (const key of Object.keys(cloned.inputSchema.properties)) {
      cloned.inputSchema.properties[key] = cleanProperty(cloned.inputSchema.properties[key]);
    }
  }

  // Stage 2: description trimming
  const toolDescLimit = level === 'aggressive' ? 100 : 200;

  if (typeof cloned.description === 'string') {
    cloned.description = truncateDesc(cloned.description, toolDescLimit);
  }

  if (cloned.inputSchema.properties && typeof cloned.inputSchema.properties === 'object') {
    for (const key of Object.keys(cloned.inputSchema.properties)) {
      const prop = cloned.inputSchema.properties[key];
      if (!prop || typeof prop !== 'object') continue;
      if (typeof prop.description !== 'string') continue;

      if (level === 'aggressive' && shouldStripDescription(key, prop.description)) {
        delete prop.description;
      } else {
        prop.description = truncateDesc(prop.description, 100);
      }
    }
  }

  return cloned as Tool;
}

/**
 * Remove structural noise from a schema object (top-level only, not recursive into properties).
 */
function cleanSchema(schema: Record<string, unknown>): void {
  if (schema.additionalProperties === false) {
    delete schema.additionalProperties;
  }
  if ('$schema' in schema) {
    delete schema.$schema;
  }
}

/**
 * Clean a single property definition and recurse into nested structures.
 */
function cleanProperty(prop: unknown): unknown {
  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
    return prop;
  }

  const p = prop as Record<string, unknown>;

  // Remove additionalProperties: false
  if (p.additionalProperties === false) {
    delete p.additionalProperties;
  }

  // Remove $schema
  if ('$schema' in p) {
    delete p.$schema;
  }

  // Remove empty description
  if (typeof p.description === 'string' && p.description === '') {
    delete p.description;
  }

  // Remove title from property schemas
  if ('title' in p) {
    delete p.title;
  }

  // Remove default-restating description
  if ('default' in p && typeof p.description === 'string') {
    if (isDefaultRestatingDescription(p.description, p.default)) {
      delete p.description;
    }
  }

  // Flatten single-element anyOf/oneOf
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(p[keyword])) {
      const arr = p[keyword] as unknown[];
      if (arr.length === 1) {
        const inner = arr[0];
        delete p[keyword];
        Object.assign(p, inner);
        // Re-process after merge
        return cleanProperty(p);
      } else if (keyword === 'anyOf' && arr.length === 2) {
        // Nullable pattern: [{ type: "X" }, { type: "null" }] or reversed
        const nonNull = arr.filter((x) => (x as any)?.type !== 'null');
        const hasNull = arr.some((x) => (x as any)?.type === 'null');
        if (hasNull && nonNull.length === 1) {
          delete p[keyword];
          Object.assign(p, nonNull[0]);
          p.nullable = true;
          return cleanProperty(p);
        }
      }
    }
  }

  // Recurse into nested properties
  if (p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties)) {
    const nested = p.properties as Record<string, unknown>;
    for (const key of Object.keys(nested)) {
      nested[key] = cleanProperty(nested[key]);
    }
  }

  // Recurse into items (array schemas)
  if (p.items && typeof p.items === 'object') {
    p.items = cleanProperty(p.items);
  }

  return p;
}

/**
 * Check if a description merely restates the default value.
 * Patterns: "Default: X" or "Defaults to X"
 */
function isDefaultRestatingDescription(description: string, defaultValue: unknown): boolean {
  const trimmed = description.trim();

  // "Default: X" pattern
  const defaultColonMatch = /^Default:\s*(.+)$/i.exec(trimmed);
  if (defaultColonMatch) {
    const stated = defaultColonMatch[1].trim();
    return statedValueMatchesDefault(stated, defaultValue);
  }

  // "Defaults to X" pattern
  const defaultsToMatch = /^Defaults to\s+(.+)$/i.exec(trimmed);
  if (defaultsToMatch) {
    const stated = defaultsToMatch[1].trim();
    return statedValueMatchesDefault(stated, defaultValue);
  }

  return false;
}

function statedValueMatchesDefault(stated: string, defaultValue: unknown): boolean {
  // Compare string representation
  if (String(defaultValue) === stated) {
    return true;
  }
  // Try numeric comparison
  const num = Number(stated);
  if (!isNaN(num) && num === defaultValue) {
    return true;
  }
  return false;
}

/**
 * Truncate a description to maxLen characters, preserving the first sentence if possible.
 * Splits on ". " (period followed by space). Hard-truncates at maxLen if no boundary found.
 */
function truncateDesc(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) {
    return desc;
  }
  // Try to find a sentence boundary before maxLen
  const candidate = desc.slice(0, maxLen + 1); // +1 to catch ". " at boundary
  const sentenceEnd = candidate.lastIndexOf('. ');
  if (sentenceEnd > 0) {
    return desc.slice(0, sentenceEnd + 1); // include the period
  }
  // Also check if the description ends with a period within the limit
  const periodAtEnd = desc.slice(0, maxLen).lastIndexOf('.');
  if (periodAtEnd > 0 && periodAtEnd === desc.length - 1) {
    return desc.slice(0, maxLen);
  }
  // Hard truncate
  return desc.slice(0, maxLen);
}

/**
 * Obvious parameter names whose descriptions can be stripped in aggressive mode.
 */
const OBVIOUS_PARAM_NAMES = new Set<string>([
  'path', 'query', 'url', 'name', 'id', 'content', 'message', 'owner', 'repo',
  'file', 'directory', 'pattern', 'limit', 'offset', 'cursor', 'format', 'title',
  'description', 'body', 'text', 'value', 'key', 'type', 'label', 'tag', 'ref',
]);

/**
 * Patterns that indicate the description has non-obvious constraints worth keeping.
 */
const NON_OBVIOUS_PATTERN = /:\s*\w.*,|must|between|one of|format|enum/i;

/**
 * In aggressive mode, decide whether to fully strip a property description.
 * Returns true (strip) when:
 * - The property name is in OBVIOUS_PARAM_NAMES, OR
 * - The description merely restates the property name (fuzzy match)
 * Returns false (keep) when the description contains enum values, specific formats,
 * or non-obvious constraints.
 */
function shouldStripDescription(propName: string, description: string): boolean {
  // Keep if it has non-obvious constraints
  if (NON_OBVIOUS_PATTERN.test(description)) {
    return false;
  }

  // Strip if it's an obvious param name
  if (OBVIOUS_PARAM_NAMES.has(propName)) {
    return true;
  }

  // Strip if description merely restates the property name
  // Fuzzy: lowercase description, strip articles, check if it contains the prop name
  const normalized = description.toLowerCase().replace(/\b(a|an|the|of|for|to|in)\b/g, '').replace(/\s+/g, ' ').trim();
  if (normalized.includes(propName.toLowerCase())) {
    return true;
  }

  return false;
}

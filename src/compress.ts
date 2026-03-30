import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type CompressionLevel = 'none' | 'standard' | 'aggressive' | 'extreme' | 'maximum';

/**
 * Compress a list of tools according to the specified level.
 * 'none' returns tools unchanged.
 * 'standard' and 'aggressive' apply Stage 1-3 structural cleanup.
 * 'extreme' embeds TS-style signatures in descriptions, strips inputSchema.
 * 'maximum' uses ultra-short types (s/n/b), ! for required, shared param extraction.
 */
export function compressTools(tools: Tool[], level: CompressionLevel): Tool[] {
  if (level === 'none') {
    return tools;
  }

  // extreme/maximum: signature embedding pipeline
  if (level === 'extreme' || level === 'maximum') {
    let result = tools.map((tool) => embedSignature(tool, level));
    // Stage 5: shared param extraction for multi-tool sets
    if (result.length >= 3) {
      result = extractSharedParams(result, level);
    }
    return result;
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

// ---------------------------------------------------------------------------
// Stage 4: Signature embedding (extreme + maximum)
// ---------------------------------------------------------------------------

const SHORT_TYPES: Record<string, string> = {
  string: 's', number: 'n', integer: 'n', boolean: 'b', object: 'obj', array: 'arr', null: 'null',
};

export function formatType(schema: Record<string, unknown>, short: boolean): string {
  const type = schema.type as string | undefined;

  // Enum
  if (Array.isArray(schema.enum)) {
    const vals = (schema.enum as unknown[]).map(v => JSON.stringify(v)).join('|');
    return vals;
  }

  // Array with items
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      const inner = formatType(items, short);
      return `${inner}[]`;
    }
    return short ? 'arr' : 'array';
  }

  // Nested object with properties
  if (type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const innerReq = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    const parts = Object.entries(props).map(([name, prop]) => {
      const t = formatType(prop, short);
      const req = innerReq.has(name) ? (short ? '!' : '') : '?';
      return short ? `${name}:${t}${req}` : `${name}: ${t}${req}`;
    });
    return `{${parts.join(short ? ' ' : ', ')}}`;
  }

  // Simple type
  if (type) {
    if (schema.nullable === true) {
      const base = short ? (SHORT_TYPES[type] || type) : type;
      return `${base}|null`;
    }
    return short ? (SHORT_TYPES[type] || type) : type;
  }

  // anyOf/oneOf
  for (const kw of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[kw])) {
      const variants = (schema[kw] as Record<string, unknown>[])
        .map(v => formatType(v, short))
        .filter(Boolean);
      return variants.join('|');
    }
  }

  return short ? 's' : 'string';
}

export function embedSignature(tool: Tool, level: 'extreme' | 'maximum'): Tool {
  const short = level === 'maximum';
  const schema = (tool as any).inputSchema;
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;

  if (!props || Object.keys(props).length === 0) {
    const desc = tool.description || tool.name;
    return {
      name: tool.name,
      description: short ? truncateDesc(desc, 80) : truncateDesc(desc, 150),
      inputSchema: { type: 'object' as const },
    };
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);

  const params = Object.entries(props).map(([name, prop]) => {
    const type = formatType(prop, short);
    if (short) {
      const req = required.has(name) ? '!' : '';
      return `${name}:${type}${req}`;
    } else {
      const req = required.has(name) ? ' (required)' : '';
      return `${name}: ${type}${req}`;
    }
  });

  const prefix = short ? 'P:' : 'Params:';
  const sep = short ? ' ' : ', ';
  const paramStr = `${prefix} ${params.join(sep)}`;

  const baseDesc = tool.description || tool.name;
  const trimmedDesc = short ? truncateDesc(baseDesc, 60) : truncateDesc(baseDesc, 120);
  const description = `${trimmedDesc}. ${paramStr}`;

  return {
    name: tool.name,
    description,
    inputSchema: { type: 'object' as const },
  };
}

// ---------------------------------------------------------------------------
// Stage 5: Shared parameter extraction (extreme + maximum, 3+ tools)
// ---------------------------------------------------------------------------

export function extractSharedParams(tools: Tool[], level: 'extreme' | 'maximum'): Tool[] {
  const short = level === 'maximum';
  const prefix = short ? 'P:' : 'Params:';

  // Group tools by server namespace
  const groups = new Map<string, { indices: number[]; paramCounts: Map<string, number> }>();

  for (let i = 0; i < tools.length; i++) {
    const name = tools[i].name;
    const sep = name.indexOf('__');
    const server = sep > 0 ? name.slice(0, sep) : '_default';

    if (!groups.has(server)) {
      groups.set(server, { indices: [], paramCounts: new Map() });
    }
    const group = groups.get(server)!;
    group.indices.push(i);

    // Extract params from the signature in the description
    const desc = tools[i].description || '';
    const prefixEscaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paramMatch = desc.match(new RegExp(`${prefixEscaped}\\s*(.+)$`));
    if (paramMatch) {
      const paramSection = paramMatch[1];
      const paramList = short
        ? paramSection.split(/\s+/).filter(Boolean)
        : paramSection.split(/,\s*/).filter(Boolean);
      for (const p of paramList) {
        group.paramCounts.set(p, (group.paramCounts.get(p) || 0) + 1);
      }
    }
  }

  const result = [...tools];
  for (const [server, group] of groups) {
    if (group.indices.length < 3) continue;

    const threshold = Math.min(3, Math.ceil(group.indices.length * 0.6));
    const sharedParams: string[] = [];
    for (const [param, count] of group.paramCounts) {
      if (count >= threshold) {
        sharedParams.push(param);
      }
    }
    if (sharedParams.length === 0) continue;

    // Prepend shared note to first tool in group
    const sharedNote = short
      ? `[${server} shared: ${sharedParams.join(' ')}]`
      : `[${server} shared params: ${sharedParams.join(', ')}]`;

    const firstIdx = group.indices[0];
    result[firstIdx] = {
      ...result[firstIdx],
      description: `${sharedNote} ${result[firstIdx].description || ''}`,
    };

    // Remove shared params from each tool's signature
    for (const idx of group.indices) {
      let desc = result[idx].description || '';
      for (const sp of sharedParams) {
        const escaped = sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Remove with surrounding separators
        desc = desc.replace(new RegExp(`,?\\s*${escaped}`), '');
        desc = desc.replace(new RegExp(`${escaped},?\\s*`), '');
      }
      // Clean up empty param sections
      desc = desc.replace(/Params:\s*$/g, '').replace(/P:\s*$/g, '');
      desc = desc.replace(/\.\s*$/g, '.').trim();
      result[idx] = { ...result[idx], description: desc };
    }
  }

  return result;
}

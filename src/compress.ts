import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CompressionLevel } from './config.js';
import { stableStringify } from './cache.js';

export type { CompressionLevel } from './config.js';

type Schema = Record<string, unknown>;

const NAMESPACE_SEP = '__';

/**
 * Compress a list of tools according to the specified level.
 * - 'none' returns tools unchanged.
 * - 'standard' / 'aggressive' apply structural cleanup + description trimming
 *   (aggressive also strips obvious descriptions and dedupes repeated params).
 * - 'extreme' embeds a TS-style signature in the description and strips inputSchema.
 * - 'maximum' uses ultra-short types (s/n/b), `!` for required, and hoists params
 *   shared by many tools of the same server into one note.
 *
 * Never mutates its input; tool names, annotations and _meta are always preserved.
 */
export function compressTools(tools: Tool[], level: CompressionLevel): Tool[] {
  if (level === 'none') {
    return tools;
  }

  if (level === 'extreme' || level === 'maximum') {
    return compressToSignatures(tools, level);
  }

  const compressed = tools.map((tool) => compressTool(tool, level));
  if (level === 'aggressive') {
    deduplicateParams(compressed);
  }
  return compressed;
}

function namespaceOf(toolName: string): string | undefined {
  const sep = toolName.indexOf(NAMESPACE_SEP);
  return sep > 0 ? toolName.slice(0, sep) : undefined;
}

function isSchema(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Tool-level fields signature embedding keeps: everything except the schemas it replaces
 * (title, annotations, execution, icons, _meta and any future spec fields survive).
 */
function preservedFields(tool: Tool): Partial<Tool> {
  const { name: _n, description: _d, inputSchema: _i, outputSchema: _o, ...rest } = tool;
  return rest;
}

// ---------------------------------------------------------------------------
// Stage 1–2: structural cleanup + description trimming (standard, aggressive)
// ---------------------------------------------------------------------------

/**
 * Stage 3 (aggressive): when the same parameter (same name, same structure) appears in
 * several tools of the same server, keep the description on the first one only.
 * Structural keywords (type, enum, items, properties, ...) are never removed.
 */
function deduplicateParams(tools: Tool[]): void {
  const seen = new Set<string>();

  for (const tool of tools) {
    const props = (tool.inputSchema as Schema | undefined)?.properties;
    if (!isSchema(props)) continue;
    const ns = namespaceOf(tool.name) ?? '';

    for (const [propName, prop] of Object.entries(props)) {
      if (!isSchema(prop)) continue;
      const { description: _d, examples: _e, ...structure } = prop;
      const key = `${ns}\u0000${propName}\u0000${stableStringify(structure)}`;
      if (seen.has(key)) {
        delete prop.description;
        delete prop.examples;
      } else {
        seen.add(key);
      }
    }
  }
}

function compressTool(tool: Tool, level: CompressionLevel): Tool {
  const cloned = structuredClone(tool) as Tool & { description?: string };

  if (cloned.description === '') {
    delete cloned.description;
  }

  const schema = cloned.inputSchema as Schema | undefined;
  if (!isSchema(schema)) {
    return cloned;
  }

  cleanSchema(schema);

  const props = isSchema(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined;
  if (props) {
    for (const key of Object.keys(props)) {
      props[key] = cleanProperty(props[key]);
    }
  }

  // Stage 2: description trimming
  const toolDescLimit = level === 'aggressive' ? 100 : 200;
  if (typeof cloned.description === 'string') {
    cloned.description = truncateDesc(cloned.description, toolDescLimit);
  }

  if (props) {
    for (const [key, prop] of Object.entries(props)) {
      if (!isSchema(prop) || typeof prop.description !== 'string') continue;
      if (level === 'aggressive' && shouldStripDescription(key, prop.description)) {
        delete prop.description;
      } else {
        prop.description = truncateDesc(prop.description, 100);
      }
    }
  }

  return cloned;
}

/** Remove structural noise from the top-level schema object. */
function cleanSchema(schema: Schema): void {
  if (schema.additionalProperties === false) {
    delete schema.additionalProperties;
  }
  delete schema.$schema;
}

/** Clean a single property definition and recurse into nested structures. */
function cleanProperty(prop: unknown): unknown {
  if (!isSchema(prop)) {
    return prop;
  }
  const p = prop;

  if (p.additionalProperties === false) delete p.additionalProperties;
  delete p.$schema;
  if (p.description === '') delete p.description;
  delete p.title;

  if ('default' in p && typeof p.description === 'string' && isDefaultRestatingDescription(p.description, p.default)) {
    delete p.description;
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = p[keyword];
    if (!Array.isArray(variants)) continue;

    if (variants.length === 1 && isSchema(variants[0])) {
      // Single variant: inline it. Outer keys (description, default) win over inner ones.
      const { [keyword]: _drop, ...outer } = p;
      return cleanProperty({ ...variants[0], ...outer });
    }

    if (keyword === 'anyOf' && variants.length === 2) {
      // Nullable pattern: [{ type: X, ... }, { type: "null" }] in either order
      const nullIdx = variants.findIndex((x) => isSchema(x) && x.type === 'null' && Object.keys(x).length === 1);
      const other = variants[1 - nullIdx];
      if (nullIdx !== -1 && isSchema(other) && typeof other.type === 'string' && other.type !== 'null') {
        const { anyOf: _drop, ...outer } = p;
        const merged: Schema = { ...other, ...outer, type: [other.type, 'null'] };
        if (Array.isArray(merged.enum) && !merged.enum.includes(null)) {
          merged.enum = [...merged.enum, null];
        }
        return cleanProperty(merged);
      }
    }
  }

  if (isSchema(p.properties)) {
    const nested = p.properties;
    for (const key of Object.keys(nested)) {
      nested[key] = cleanProperty(nested[key]);
    }
  }

  if (isSchema(p.items)) {
    p.items = cleanProperty(p.items);
  }

  return p;
}

/** Check if a description merely restates the default value ("Default: X" / "Defaults to X"). */
function isDefaultRestatingDescription(description: string, defaultValue: unknown): boolean {
  const match = /^(?:Default:|Defaults to)\s*(.+?)\.?$/i.exec(description.trim());
  if (!match) return false;
  const stated = match[1].trim().replace(/^["'`](.*)["'`]$/, '$1');
  if (String(defaultValue) === stated) return true;
  const num = Number(stated);
  return stated !== '' && !Number.isNaN(num) && num === defaultValue;
}

/**
 * Truncate a description to at most maxLen characters, preferring the last sentence
 * boundary, then the last word boundary, then a hard cut.
 */
export function truncateDesc(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) {
    return desc;
  }
  const candidate = desc.slice(0, maxLen + 1); // +1 to catch ". " at the boundary
  const sentenceEnd = candidate.lastIndexOf('. ');
  if (sentenceEnd > 0) {
    return desc.slice(0, sentenceEnd + 1);
  }
  const wordEnd = desc.slice(0, maxLen + 1).lastIndexOf(' ');
  if (wordEnd > maxLen / 2) {
    return desc.slice(0, wordEnd).trimEnd();
  }
  return desc.slice(0, maxLen);
}

/** Obvious parameter names whose descriptions can be stripped in aggressive mode. */
const OBVIOUS_PARAM_NAMES = new Set<string>([
  'path', 'query', 'url', 'name', 'id', 'content', 'message', 'owner', 'repo',
  'file', 'directory', 'pattern', 'limit', 'offset', 'cursor', 'format', 'title',
  'description', 'body', 'text', 'value', 'key', 'type', 'label', 'tag', 'ref',
]);

/** Patterns that indicate the description has non-obvious constraints worth keeping. */
const NON_OBVIOUS_PATTERN = /:\s*\w.*,|must|between|one of|format|enum/i;

function shouldStripDescription(propName: string, description: string): boolean {
  if (NON_OBVIOUS_PATTERN.test(description)) {
    return false;
  }
  if (OBVIOUS_PARAM_NAMES.has(propName)) {
    return true;
  }
  // Strip if the description merely restates the (non-trivial) property name
  if (propName.length < 3) return false;
  const normalized = description.toLowerCase().replace(/\b(a|an|the|of|for|to|in)\b/g, '').replace(/\s+/g, ' ').trim();
  return normalized.includes(propName.toLowerCase());
}

// ---------------------------------------------------------------------------
// Stage 4: Signature embedding (extreme + maximum)
// ---------------------------------------------------------------------------

const SHORT_TYPES: Record<string, string> = {
  string: 's', number: 'n', integer: 'n', boolean: 'b', object: 'obj', array: 'arr', null: 'null',
};

const MAX_TYPE_DEPTH = 6;

function resolveRef(ref: string, root: Schema | undefined): Schema | undefined {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m || !root) return undefined;
  const defs = root[m[1]];
  if (!isSchema(defs)) return undefined;
  const target = defs[m[2].replace(/~1/g, '/').replace(/~0/g, '~')];
  return isSchema(target) ? target : undefined;
}

function shortType(type: string, short: boolean): string {
  return short ? (SHORT_TYPES[type] ?? type) : type;
}

/** Render a JSON Schema fragment as a compact TS-like type string. */
export function formatType(schema: Schema, short: boolean, root?: Schema, depth = 0): string {
  const fallback = short ? 's' : 'string';
  if (depth > MAX_TYPE_DEPTH) return short ? 'obj' : 'object';

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    return target ? formatType(target, short, root, depth + 1) : short ? 'obj' : 'object';
  }

  if ('const' in schema) return JSON.stringify(schema.const);

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join('|');
  }

  const type = schema.type;

  if (Array.isArray(type)) {
    const parts = type
      .filter((t): t is string => typeof t === 'string')
      .map((t) => (t === 'null' ? 'null' : formatType({ ...schema, type: t }, short, root, depth + 1)));
    return [...new Set(parts)].join('|') || fallback;
  }

  if (type === 'array') {
    if (isSchema(schema.items)) {
      const inner = formatType(schema.items, short, root, depth + 1);
      return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
    }
    return short ? 'arr' : 'array';
  }

  if (type === 'object' && isSchema(schema.properties)) {
    const props = schema.properties;
    const innerReq = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const parts = Object.entries(props).map(([name, prop]) => {
      const t = isSchema(prop) ? formatType(prop, short, root, depth + 1) : fallback;
      const req = innerReq.has(name) ? (short ? '!' : '') : '?';
      return short ? `${name}:${t}${req}` : `${name}: ${t}${req}`;
    });
    return `{${parts.join(short ? ' ' : ', ')}}`;
  }

  if (typeof type === 'string') {
    const base = shortType(type, short);
    return schema.nullable === true ? `${base}|null` : base;
  }

  for (const kw of ['anyOf', 'oneOf'] as const) {
    const variants = schema[kw];
    if (Array.isArray(variants)) {
      const rendered = variants.filter(isSchema).map((v) => formatType(v, short, root, depth + 1));
      return [...new Set(rendered)].join('|') || fallback;
    }
  }

  if (Array.isArray(schema.allOf)) {
    const rendered = schema.allOf.filter(isSchema).map((v) => formatType(v, short, root, depth + 1));
    return rendered.join('&') || fallback;
  }

  return fallback;
}

interface Signature {
  tool: Tool;
  desc: string;
  /** Rendered parameter tokens, e.g. "path:s!" or "path: string (required)". */
  params: string[];
}

function buildSignature(tool: Tool, short: boolean): Signature {
  const schema = tool.inputSchema as Schema | undefined;
  const props = isSchema(schema?.properties) ? (schema!.properties as Record<string, unknown>) : {};
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);

  const params = Object.entries(props).map(([name, prop]) => {
    const type = isSchema(prop) ? formatType(prop, short, schema) : short ? 's' : 'string';
    if (short) return `${name}:${type}${required.has(name) ? '!' : ''}`;
    return `${name}: ${type}${required.has(name) ? ' (required)' : ''}`;
  });

  const baseDesc = (tool.description || tool.name).trim();
  const limit = params.length === 0 ? (short ? 80 : 150) : short ? 60 : 120;
  return { tool, desc: truncateDesc(baseDesc, limit), params };
}

function renderSignature(sig: Signature, short: boolean, prefixNote?: string): Tool {
  let description = sig.desc;
  if (sig.params.length > 0) {
    const sep = short ? ' ' : ', ';
    const body = `${short ? 'P:' : 'Params:'} ${sig.params.join(sep)}`;
    description = `${description.replace(/[.\s]+$/, '')}. ${body}`;
  }
  if (prefixNote) description = `${prefixNote} ${description}`;
  return {
    name: sig.tool.name,
    description,
    inputSchema: { type: 'object' as const },
    ...preservedFields(sig.tool),
  };
}

/** Embed a single tool's parameter signature in its description. */
export function embedSignature(tool: Tool, level: 'extreme' | 'maximum'): Tool {
  const short = level === 'maximum';
  return renderSignature(buildSignature(tool, short), short);
}

// ---------------------------------------------------------------------------
// Stage 5: Shared parameter extraction (extreme + maximum, 3+ tools per server)
// ---------------------------------------------------------------------------

function compressToSignatures(tools: Tool[], level: 'extreme' | 'maximum'): Tool[] {
  const short = level === 'maximum';
  const sigs = tools.map((t) => buildSignature(t, short));
  const notes = new Map<number, string>();

  // Group by server namespace; un-namespaced tools form one group.
  const groups = new Map<string, number[]>();
  sigs.forEach((sig, i) => {
    const ns = namespaceOf(sig.tool.name) ?? '';
    const g = groups.get(ns);
    if (g) g.push(i);
    else groups.set(ns, [i]);
  });

  for (const [ns, indices] of groups) {
    if (indices.length < 3) continue;

    const counts = new Map<string, number>();
    for (const i of indices) {
      for (const p of new Set(sigs[i].params)) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    // "Shared" means most of the server's tools take it (at least 3 and at least 60%).
    const threshold = Math.max(3, Math.ceil(indices.length * 0.6));
    const shared = [...counts].filter(([, c]) => c >= threshold).map(([p]) => p);
    if (shared.length === 0) continue;

    const sharedSet = new Set(shared);
    for (const i of indices) {
      sigs[i] = { ...sigs[i], params: sigs[i].params.filter((p) => !sharedSet.has(p)) };
    }
    const label = ns ? `${ns} shared` : 'shared';
    notes.set(
      indices[0],
      short ? `[${label}: ${shared.join(' ')}]` : `[${label} params: ${shared.join(', ')}]`,
    );
  }

  return sigs.map((sig, i) => renderSignature(sig, short, notes.get(i)));
}

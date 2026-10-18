// Response caching for MCP proxy

import { createHash } from 'node:crypto';
import type { CacheConfig } from './config.js';

export type { CacheConfig } from './config.js';

export interface CacheEntry {
  result: unknown;
  cachedAt: number;
  ttl: number;
  hits: number;
  responseSize: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  skips: number;
  evictions: number;
  estimatedTokensSaved: number;
}

/** Subset of MCP ToolAnnotations relevant to caching. */
export interface CacheHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Words that always signal a side effect, wherever they appear in the name. */
const STRONG_MUTATING = [
  'create', 'write', 'delete', 'remove', 'update', 'edit', 'modify', 'set', 'put', 'patch', 'push',
  'move', 'rename', 'copy', 'upload', 'insert', 'upsert', 'add', 'save', 'submit', 'replace', 'fill',
  'drop', 'truncate', 'reset', 'clear', 'purge', 'destroy', 'kill', 'restart', 'close', 'cancel',
  'send', 'notify', 'publish', 'emit', 'dispatch', 'broadcast', 'reply', 'invite', 'kick', 'ban',
  'merge', 'rebase', 'checkout', 'stash', 'revert', 'exec', 'execute', 'invoke', 'trigger', 'apply',
  'deploy', 'install', 'uninstall', 'click', 'navigate', 'setup', 'assign', 'unassign', 'approve',
  'reject', 'enable', 'disable', 'grant', 'revoke', 'transfer', 'rollback', 'migrate', 'unarchive',
  'mark', 'toggle', 'increment', 'decrement', 'dismiss', 'pay', 'refund', 'sign', 'book', 'order',
];

/** Conjunctions mark compound tools ("read_and_mark", "get_or_create"): never treated as reads. */
const CONJUNCTIONS = new Set(['and', 'or', 'then']);

/**
 * Words that signal a side effect but are also common nouns ("get_commit", "list_branch",
 * "get_run_status"). A leading read verb overrides them.
 */
const WEAK_MUTATING = [
  'post', 'email', 'message', 'comment', 'commit', 'branch', 'tag', 'cherry', 'pull', 'call', 'type',
  'run', 'start', 'stop', 'archive', 'schedule', 'import', 'lock', 'unlock', 'sync', 'pin', 'star',
];

/** Prefixes caught even in run-together lowercase names ("createissue", "executesql"). */
const MUTATING_PREFIXES = [
  'create', 'update', 'delete', 'remove', 'execute', 'insert', 'upsert', 'write', 'upload', 'rename',
  'submit', 'destroy', 'truncate', 'purge', 'deploy', 'install', 'publish', 'restart', 'start', 'stop',
];

/** Leading verbs that mark a read when no strong mutating word follows. */
const READ_VERBS = new Set([
  'get', 'list', 'read', 'search', 'find', 'describe', 'info', 'fetch', 'show', 'view', 'query',
  'count', 'lookup', 'stat', 'diff', 'inspect', 'browse',
]);

const STRONG_SET = new Set(STRONG_MUTATING);
const WEAK_SET = new Set(WEAK_MUTATING);

/** Kept for API compatibility: matches any mutating word at a token boundary. */
export const NEVER_CACHE_PATTERNS: RegExp[] = [
  new RegExp(`(^|[_\\-.])(${[...STRONG_SET, ...WEAK_SET].join('|')})([_\\-.]|$)`, 'i'),
];

/**
 * Is there positive evidence this tool is free of side effects? Unknown names count as
 * "no": a wrong "yes" silently swallows a side effect on a cache hit, a wrong "no" only
 * costs a cache miss.
 *
 * Evidence, in order: explicit MCP annotations; a well-known read tool; a read verb as the
 * first word (or second, after a prefix like "git_" / "slack_") with no strong mutating
 * word and no conjunction anywhere in the name.
 */
export function looksReadOnly(toolName: string, hints?: CacheHints): boolean {
  if (hints?.readOnlyHint === true) return true;
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return false;
  if (Object.hasOwn(ALWAYS_CACHE_DEFAULTS, toolName)) return true;

  const tokens = tokenizeToolName(toolName);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => STRONG_SET.has(t) || CONJUNCTIONS.has(t))) return false;
  if (MUTATING_PREFIXES.some((p) => tokens[0].startsWith(p))) return false;
  if (READ_VERBS.has(tokens[0])) return true;
  return tokens.length > 1 && READ_VERBS.has(tokens[1]) && !tokens.some((t) => WEAK_SET.has(t));
}

/** Built-in TTLs (seconds) for well-known tools. Overridden by tool_ttls and server_ttls. */
export const ALWAYS_CACHE_DEFAULTS: Record<string, number> = {
  'read_file': 30, 'list_directory': 30, 'get_file_info': 30, 'search_files': 30,
  'list_allowed_directories': 300,
  'git_status': 15, 'git_log': 30, 'git_diff': 15,
  'search': 60, 'list': 60, 'get': 60, 'find': 60, 'read': 30,
  'describe': 120, 'info': 120,
};

/** Split a tool name into lowercase word tokens: snake_case, kebab-case, dotted and camelCase. */
export function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Deterministic JSON: object keys sorted, undefined members dropped (matching JSON semantics). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Collision-resistant digest of a JSON value (SHA-256, base64url). */
export function stableHash(obj: unknown): string {
  return createHash('sha256').update(stableStringify(obj)).digest('base64url');
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private readonly config: CacheConfig;
  private readonly userNeverCache: RegExp[];
  /** Per-server write generation; bumped on every invalidation. */
  private readonly generations = new Map<string, number>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    skips: 0,
    evictions: 0,
    estimatedTokensSaved: 0,
  };

  constructor(config: CacheConfig) {
    this.config = config;
    this.userNeverCache = (config.never_cache ?? []).map((p) => new RegExp(p, 'i'));
  }

  get defaultTtl(): number {
    return this.config.default_ttl;
  }

  private makeKey(serverName: string, toolName: string, args: Record<string, unknown>): string {
    return `${JSON.stringify(serverName)}:${JSON.stringify(toolName)}:${stableHash(args)}`;
  }

  resolveTTL(serverName: string, toolName: string): number {
    const toolTtls = this.config.tool_ttls;
    if (toolTtls) {
      const namespaced = `${serverName}__${toolName}`;
      if (Object.hasOwn(toolTtls, namespaced)) return toolTtls[namespaced];
      if (Object.hasOwn(toolTtls, toolName)) return toolTtls[toolName];
    }
    const serverTtls = this.config.server_ttls;
    if (serverTtls && Object.hasOwn(serverTtls, serverName)) return serverTtls[serverName];
    if (Object.hasOwn(ALWAYS_CACHE_DEFAULTS, toolName)) return ALWAYS_CACHE_DEFAULTS[toolName];
    return this.config.default_ttl;
  }

  /**
   * Decide whether a tool's responses may be cached.
   * Order: user never_cache > annotations saying it has side effects > an explicit
   * tool_ttls entry (the user opted in) > read-only evidence (see looksReadOnly).
   */
  shouldCache(toolName: string, hints?: CacheHints, serverName?: string): boolean {
    for (const pattern of this.userNeverCache) {
      if (pattern.test(toolName)) return false;
    }
    if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return false;
    const ttls = this.config.tool_ttls;
    if (ttls && (Object.hasOwn(ttls, toolName) || (serverName !== undefined && Object.hasOwn(ttls, `${serverName}__${toolName}`)))) {
      return true;
    }
    return looksReadOnly(toolName, hints);
  }

  /** Current write generation for a server; pass it back to set() to drop results that raced a write. */
  generation(serverName: string): number {
    return this.generations.get(serverName) ?? 0;
  }

  get(serverName: string, toolName: string, args: Record<string, unknown>): CacheEntry | null {
    const key = this.makeKey(serverName, toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - entry.cachedAt >= entry.ttl * 1000) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    entry.hits++;
    this.stats.hits++;
    this.stats.estimatedTokensSaved += Math.ceil(entry.responseSize / 4);
    // Move to end for LRU freshness
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  /**
   * Store a result. Returns false when nothing was stored: TTL ≤ 0, cache size 0,
   * or the server was invalidated after `generation` was read (stale in-flight read).
   */
  set(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    generation?: number,
  ): boolean {
    if (generation !== undefined && generation !== this.generation(serverName)) return false;
    const ttl = this.resolveTTL(serverName, toolName);
    if (!(ttl > 0) || !(this.config.max_entries > 0)) return false;

    const key = this.makeKey(serverName, toolName, args);
    this.cache.delete(key);
    while (this.cache.size >= this.config.max_entries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.stats.evictions++;
    }
    this.cache.set(key, {
      result,
      cachedAt: Date.now(),
      ttl,
      hits: 0,
      responseSize: JSON.stringify(result)?.length ?? 0,
    });
    return true;
  }

  invalidateServer(serverName: string): void {
    this.generations.set(serverName, this.generation(serverName) + 1);
    const prefix = `${JSON.stringify(serverName)}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  recordSkip(): void {
    this.stats.skips++;
  }

  get size(): number {
    return this.cache.size;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  formatShutdownReport(): string {
    const total = this.stats.hits + this.stats.misses;
    const rate = total > 0 ? Math.round((this.stats.hits / total) * 100) : 0;
    const tokensSaved = this.stats.estimatedTokensSaved.toLocaleString('en-US');
    return (
      `Cache stats: ${this.stats.hits} hits / ${this.stats.misses} misses / ${this.stats.skips} skips (${rate}% hit rate)\n` +
      `Estimated tokens saved from cache: ~${tokensSaved}`
    );
  }
}

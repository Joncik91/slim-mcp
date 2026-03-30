// Response caching for MCP proxy

export interface CacheEntry {
  result: unknown;
  cachedAt: number;
  ttl: number;
  hits: number;
  responseSize: number;
}

export interface CacheConfig {
  enabled: boolean;
  default_ttl: number;
  max_entries: number;
  server_ttls?: Record<string, number>;
  tool_ttls?: Record<string, number>;
  never_cache?: string[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  skips: number;
  evictions: number;
  estimatedTokensSaved: number;
}

export const NEVER_CACHE_PATTERNS: RegExp[] = [
  /^(create|write|delete|remove|update|edit|modify|set|put|post|patch|push|move|rename|copy)/i,
  /^(drop|truncate|reset|clear|purge|destroy|kill|stop|start|restart)/i,
  /^(send|notify|publish|emit|dispatch|broadcast|email|message|slack)/i,
  /^(commit|merge|rebase|checkout|branch|tag|stash|cherry)/i,
  /^(run|exec|execute|invoke|call|trigger|apply|deploy)/i,
];

export const ALWAYS_CACHE_DEFAULTS: Record<string, number> = {
  'read_file': 30, 'list_directory': 30, 'get_file_info': 30, 'search_files': 30,
  'list_allowed_directories': 300,
  'git_status': 15, 'git_log': 30, 'git_diff': 15,
  'search': 60, 'list': 60, 'get': 60, 'find': 60, 'read': 30,
  'describe': 120, 'info': 120,
};

export function stableHash(obj: unknown): string {
  const str = stableStringify(obj);
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private config: CacheConfig;
  private userNeverCache: RegExp[];
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    skips: 0,
    evictions: 0,
    estimatedTokensSaved: 0,
  };

  constructor(config: CacheConfig) {
    this.config = config;
    this.userNeverCache = (config.never_cache ?? []).map(p => new RegExp(p, 'i'));
  }

  private makeKey(serverName: string, toolName: string, args: Record<string, unknown>): string {
    return `${serverName}:${toolName}:${stableHash(args)}`;
  }

  private resolveTTL(serverName: string, toolName: string): number {
    const toolTtls = this.config.tool_ttls;
    if (toolTtls) {
      const namespaced = `${serverName}__${toolName}`;
      if (namespaced in toolTtls) return toolTtls[namespaced];
      if (toolName in toolTtls) return toolTtls[toolName];
    }
    const serverTtls = this.config.server_ttls;
    if (serverTtls && serverName in serverTtls) return serverTtls[serverName];
    return this.config.default_ttl;
  }

  shouldCache(toolName: string): boolean {
    // Never-cache wins over everything
    for (const pattern of NEVER_CACHE_PATTERNS) {
      if (pattern.test(toolName)) return false;
    }
    for (const pattern of this.userNeverCache) {
      if (pattern.test(toolName)) return false;
    }
    return true;
  }

  get(serverName: string, toolName: string, args: Record<string, unknown>): CacheEntry | null {
    const key = this.makeKey(serverName, toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    const now = Date.now();
    if (now - entry.cachedAt > entry.ttl * 1000) {
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

  set(serverName: string, toolName: string, args: Record<string, unknown>, result: unknown): void {
    const key = this.makeKey(serverName, toolName, args);
    // Evict oldest if at capacity
    if (this.cache.size >= this.config.max_entries && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.stats.evictions++;
      }
    }
    const responseSize = JSON.stringify(result).length;
    const ttl = this.resolveTTL(serverName, toolName);
    this.cache.set(key, {
      result,
      cachedAt: Date.now(),
      ttl,
      hits: 0,
      responseSize,
    });
  }

  invalidateServer(serverName: string): void {
    const prefix = `${serverName}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  recordSkip(): void {
    this.stats.skips++;
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

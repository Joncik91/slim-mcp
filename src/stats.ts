// Centralized stats collector for slim-mcp dashboard

export interface ServerInfo {
  name: string;
  transport: string;
  tools: number;
  status: 'connected' | 'failed' | 'disconnected';
}

export interface CompressionStats {
  level: string;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  reductionPercent: number;
}

export interface LazyStats {
  enabled: boolean;
  fullTools: number;
  slimTools: number;
  totalTools: number;
  promotions: { tool: string; timestamp: string }[];
  savedTokens: number;
  reductionPercent: number;
}

export interface CacheDashStats {
  enabled: boolean;
  hits: number;
  misses: number;
  skips: number;
  evictions: number;
  hitRate: number;
  estimatedTokensSaved: number;
  entries: number;
  invalidations: number;
}

export interface ToolCallRecord {
  tool: string;
  server: string;
  cached: boolean;
  promoted: boolean;
  timestamp: string;
  durationMs: number;
}

export interface ToolCallStats {
  total: number;
  byTool: Record<string, number>;
  byServer: Record<string, number>;
  recent: ToolCallRecord[];
}

export interface SlimMcpStats {
  startedAt: string;
  uptime: number;
  servers: ServerInfo[];
  compression: CompressionStats;
  lazy: LazyStats;
  cache: CacheDashStats;
  toolCalls: ToolCallStats;
  totalSavedTokens: number;
}

export type StatsEvent =
  | { type: 'tool_call'; data: ToolCallRecord }
  | { type: 'promotion'; data: { tool: string; timestamp: string } }
  | { type: 'cache_invalidation'; data: { server: string; timestamp: string } }
  | { type: 'stats_update'; data: Partial<SlimMcpStats> };

type EventListener = (event: StatsEvent) => void;

const MAX_RECENT_CALLS = 50;

class StatsCollector {
  private startedAt = new Date();
  private servers: ServerInfo[] = [];
  private compression: CompressionStats = {
    level: 'standard', originalTokens: 0, compressedTokens: 0, savedTokens: 0, reductionPercent: 0,
  };
  private lazy: LazyStats = {
    enabled: false, fullTools: 0, slimTools: 0, totalTools: 0, promotions: [], savedTokens: 0, reductionPercent: 0,
  };
  private cacheStats: CacheDashStats = {
    enabled: false, hits: 0, misses: 0, skips: 0, evictions: 0, hitRate: 0, estimatedTokensSaved: 0, entries: 0, invalidations: 0,
  };
  private toolCalls: ToolCallStats = {
    total: 0, byTool: {}, byServer: {}, recent: [],
  };
  private listeners: EventListener[] = [];

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: StatsEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch {}
    }
  }

  // --- Server registration ---
  registerServer(info: ServerInfo): void {
    const existing = this.servers.findIndex(s => s.name === info.name);
    if (existing >= 0) this.servers[existing] = info;
    else this.servers.push(info);
  }

  // --- Compression ---
  recordCompression(level: string, originalTokens: number, compressedTokens: number): void {
    this.compression = {
      level,
      originalTokens,
      compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      reductionPercent: originalTokens > 0 ? Math.round((1 - compressedTokens / originalTokens) * 100) : 0,
    };
  }

  // --- Lazy loading ---
  recordLazy(enabled: boolean, fullTools: number, slimTools: number, savedTokens: number, withoutLazyTokens: number): void {
    this.lazy = {
      enabled,
      fullTools,
      slimTools,
      totalTools: fullTools + slimTools,
      promotions: this.lazy.promotions,
      savedTokens,
      reductionPercent: withoutLazyTokens > 0 ? Math.round((savedTokens / withoutLazyTokens) * 100) : 0,
    };
  }

  recordPromotion(tool: string): void {
    const ts = new Date().toISOString();
    this.lazy.promotions.push({ tool, timestamp: ts });
    if (this.lazy.promotions.length > MAX_RECENT_CALLS) {
      this.lazy.promotions = this.lazy.promotions.slice(-MAX_RECENT_CALLS);
    }
    this.emit({ type: 'promotion', data: { tool, timestamp: ts } });
  }

  // --- Cache ---
  recordCacheEnabled(enabled: boolean): void {
    this.cacheStats.enabled = enabled;
  }

  updateCacheStats(stats: { hits: number; misses: number; skips: number; evictions: number; estimatedTokensSaved: number }, entries: number): void {
    const total = stats.hits + stats.misses;
    this.cacheStats = {
      ...this.cacheStats,
      ...stats,
      hitRate: total > 0 ? Math.round((stats.hits / total) * 100) : 0,
      entries,
    };
  }

  recordCacheInvalidation(server: string): void {
    this.cacheStats.invalidations++;
    this.emit({ type: 'cache_invalidation', data: { server, timestamp: new Date().toISOString() } });
  }

  // --- Tool calls ---
  recordToolCall(record: ToolCallRecord): void {
    this.toolCalls.total++;
    this.toolCalls.byTool[record.tool] = (this.toolCalls.byTool[record.tool] || 0) + 1;
    this.toolCalls.byServer[record.server] = (this.toolCalls.byServer[record.server] || 0) + 1;
    this.toolCalls.recent.push(record);
    if (this.toolCalls.recent.length > MAX_RECENT_CALLS) {
      this.toolCalls.recent = this.toolCalls.recent.slice(-MAX_RECENT_CALLS);
    }
    this.emit({ type: 'tool_call', data: record });
  }

  // --- Snapshot ---
  getStats(): SlimMcpStats {
    const uptime = Math.round((Date.now() - this.startedAt.getTime()) / 1000);
    const totalSavedTokens = this.compression.savedTokens + this.lazy.savedTokens + this.cacheStats.estimatedTokensSaved;
    return {
      startedAt: this.startedAt.toISOString(),
      uptime,
      servers: [...this.servers],
      compression: { ...this.compression },
      lazy: { ...this.lazy, promotions: [...this.lazy.promotions] },
      cache: { ...this.cacheStats },
      toolCalls: {
        total: this.toolCalls.total,
        byTool: { ...this.toolCalls.byTool },
        byServer: { ...this.toolCalls.byServer },
        recent: [...this.toolCalls.recent],
      },
      totalSavedTokens,
    };
  }
}

// Singleton
export const stats = new StatsCollector();

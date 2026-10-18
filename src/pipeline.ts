// Shared tools/list transform and tools/call interception for both proxy modes.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { compressTools, type CompressionLevel } from './compress.js';
import { estimateTokens, formatCompressionReport } from './tokens.js';
import { formatLazyReport, type LazyToolManager } from './lazy.js';
import { looksReadOnly, type ResponseCache } from './cache.js';
import { info, debug } from './logger.js';
import { stats } from './stats.js';

export interface ResolvedTool {
  /** Cache/stats key for the server that owns the tool. */
  server: string;
  /** Tool name as the upstream server knows it. */
  tool: string;
}

export interface PipelineOptions {
  level: CompressionLevel;
  cache: ResponseCache | null;
  lazy: LazyToolManager | null;
  resolve: (toolName: string) => ResolvedTool;
}

/** What to do with an incoming tools/call. */
export type CallDecision =
  | { action: 'respond'; result: CallToolResult }
  | { action: 'forward'; ticket: CallTicket };

export interface CallTicket {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly resolved: ResolvedTool;
  readonly startedAt: number;
  /** Cache generation at request time; undefined when the result must not be cached. */
  readonly cacheGeneration: number | undefined;
  /** Side-effecting call: the server's cache is invalidated again when it finishes. */
  readonly invalidates: boolean;
  readonly promoted: boolean;
}

export interface ToolListOptions {
  /** This is a later page of a paginated tools/list: merge, don't replace. */
  append?: boolean;
  /** Part of a paginated listing: lazy loading is skipped (it needs the whole set). */
  paginated?: boolean;
}

/** Outcome of slim-tool interception. `listChanged` tells the caller to notify the client. */
interface PromotionOutcome {
  decision?: CallDecision;
  promoted: boolean;
}

export function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export class ToolPipeline {
  private readonly level: CompressionLevel;
  private readonly cache: ResponseCache | null;
  private lazy: LazyToolManager | null;
  private readonly resolve: (toolName: string) => ResolvedTool;
  /** Full (unmodified) tool definitions from the most recent tools/list, by exposed name. */
  private fullTools = new Map<string, Tool>();
  private validators = new Map<string, JsonSchemaValidator<unknown> | null>();
  private readonly ajv = new AjvJsonSchemaValidator();

  /** Called when the exposed tool list changed (e.g. after a promotion). */
  onToolListChanged: (() => void) | undefined;

  constructor(options: PipelineOptions) {
    this.level = options.level;
    this.cache = options.cache;
    this.lazy = options.lazy;
    this.resolve = options.resolve;
  }

  get lazyManager(): LazyToolManager | null {
    return this.lazy;
  }

  /** Lazy loading can be enabled late (single-server mode decides on the first tools/list). */
  setLazyManager(lazy: LazyToolManager | null): void {
    this.lazy = lazy;
  }

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  transformToolList(tools: Tool[], options: ToolListOptions = {}): Tool[] {
    if (!options.append) {
      this.fullTools = new Map();
      this.validators.clear();
    }
    for (const t of tools) {
      this.fullTools.set(t.name, t);
      this.validators.delete(t.name);
    }

    let listed = tools;
    const lazy = options.paginated ? null : this.lazy;
    if (lazy) {
      listed = lazy.getToolList(tools);
      const report = lazy.getReport();
      if (report) {
        info(formatLazyReport(report));
        stats.recordLazy(
          true,
          report.stats.loaded,
          report.stats.slim,
          report.withoutLazyTokens - report.slimTokens - report.fullTokens,
          report.withoutLazyTokens,
        );
      }
    }

    if (this.level === 'none') {
      return listed;
    }

    const before = estimateTokens(listed);
    let compressed: Tool[];
    if (lazy) {
      // Compress full tools as one batch (dedup and shared-param extraction need the
      // whole set); slim index entries pass through untouched, order preserved.
      const fullIdx: number[] = [];
      listed.forEach((t, i) => {
        if (!lazy.isSlim(t.name)) fullIdx.push(i);
      });
      const batch = compressTools(fullIdx.map((i) => listed[i]), this.level);
      compressed = [...listed];
      fullIdx.forEach((listIdx, b) => {
        compressed[listIdx] = batch[b];
      });
    } else {
      compressed = compressTools(listed, this.level);
    }
    const after = estimateTokens(compressed);

    info(formatCompressionReport({ toolCount: compressed.length, beforeTokens: before, afterTokens: after }));
    stats.recordCompression(this.level, before, after);
    debug(() =>
      compressed
        .map((t, i) => [t.name, estimateTokens(listed[i]), estimateTokens(t)] as const)
        .filter(([, a, b]) => a !== b)
        .map(([n, a, b]) => `  ${n}: ${a} → ${b} tokens`)
        .join('\n') || '  (no per-tool changes)',
    );

    return compressed;
  }

  // -------------------------------------------------------------------------
  // tools/call
  // -------------------------------------------------------------------------

  beginCall(toolName: string, args: Record<string, unknown>): CallDecision {
    const startedAt = Date.now();
    const resolved = this.resolve(toolName);

    const promotion = this.interceptSlimTool(toolName, args, resolved, startedAt);
    if (promotion.decision) return promotion.decision;

    let cacheGeneration: number | undefined;
    let invalidates = false;
    const cache = this.cache;
    if (cache) {
      const hints = this.fullTools.get(toolName)?.annotations;
      if (!cache.shouldCache(resolved.tool, hints, resolved.server)) {
        invalidates = true;
        cache.recordSkip();
        cache.invalidateServer(resolved.server);
        stats.recordCacheInvalidation(resolved.server);
        debug(`Cache skip: ${toolName} (side-effecting) — invalidated ${resolved.server}`);
      } else {
        const cached = cache.get(resolved.server, resolved.tool, args);
        if (cached) {
          const age = Math.round((Date.now() - cached.cachedAt) / 1000);
          info(`Cache hit: ${toolName} (cached ${age}s ago)`);
          this.record(toolName, resolved, startedAt, { cached: true, promoted: promotion.promoted, error: false });
          return { action: 'respond', result: cached.result as CallToolResult };
        }
        cacheGeneration = cache.generation(resolved.server);
      }
    }

    return {
      action: 'forward',
      ticket: { toolName, args, resolved, startedAt, cacheGeneration, invalidates, promoted: promotion.promoted },
    };
  }

  /** Record the upstream outcome of a forwarded call; caches successful cacheable results. */
  completeCall(ticket: CallTicket, outcome: { result: unknown } | { error: unknown }): void {
    this.settleWrite(ticket);
    const failed = 'error' in outcome || isErrorResult(outcome.result);
    if (!failed && this.cache && ticket.cacheGeneration !== undefined && 'result' in outcome) {
      const { server, tool } = ticket.resolved;
      if (this.cache.set(server, tool, ticket.args, outcome.result, ticket.cacheGeneration)) {
        debug(`Cache miss: ${ticket.toolName} → cached for ${this.cache.resolveTTL(server, tool)}s`);
      } else {
        debug(`Cache miss: ${ticket.toolName} → not cached (ttl 0 or invalidated in flight)`);
      }
    }
    this.record(ticket.toolName, ticket.resolved, ticket.startedAt, {
      cached: false,
      promoted: ticket.promoted,
      error: failed,
    });
  }

  /** Drop a forwarded call that will never complete (cancelled, transport closed). */
  abandonCall(ticket: CallTicket): void {
    this.settleWrite(ticket);
    this.record(ticket.toolName, ticket.resolved, ticket.startedAt, { cached: false, promoted: ticket.promoted, error: true });
  }

  /**
   * A write invalidates its server when it starts (so cached reads aren't served during it)
   * and again when it ends, so reads that overlapped it can't store pre-write data.
   */
  private settleWrite(ticket: CallTicket): void {
    if (ticket.invalidates && this.cache) this.cache.invalidateServer(ticket.resolved.server);
  }

  private record(
    toolName: string,
    resolved: ResolvedTool,
    startedAt: number,
    flags: { cached: boolean; promoted: boolean; error: boolean },
  ): void {
    stats.recordToolCall({
      tool: toolName,
      server: resolved.server,
      ...flags,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });
    if (this.cache) stats.updateCacheStats(this.cache.getStats(), this.cache.size);
  }

  /**
   * Slim (schema-less) tools are promoted on first use. The call proceeds in the same round
   * trip only when that is safe: the tool looks read-only, every argument name is declared
   * in the schema, and the arguments validate. Otherwise the agent gets the full schema back
   * and is asked to retry.
   */
  private interceptSlimTool(
    toolName: string,
    args: Record<string, unknown>,
    resolved: ResolvedTool,
    startedAt: number,
  ): PromotionOutcome {
    const lazy = this.lazy;
    if (!lazy || !lazy.isSlim(toolName)) return { promoted: false };

    lazy.promoteTools([toolName]);
    stats.recordPromotion(toolName);
    const s = lazy.getStats();
    info(`Promoted tool: ${toolName} (${s.loaded} full + ${s.slim} slim)`);
    this.onToolListChanged?.();

    const full = this.fullTools.get(toolName) ?? lazy.getFullTool(toolName);
    const check = full
      ? this.checkFirstCall(toolName, full, args, resolved)
      : { valid: false as const, message: 'schema unavailable' };
    if (check.valid) {
      debug(`Promoted ${toolName}: arguments match the full schema — forwarding`);
      return { promoted: true };
    }

    this.record(toolName, resolved, startedAt, { cached: false, promoted: true, error: false });
    return { promoted: true, decision: { action: 'respond', result: this.promotionResult(toolName, full, check.message) } };
  }

  private checkFirstCall(
    toolName: string,
    tool: Tool,
    args: Record<string, unknown>,
    resolved: ResolvedTool,
  ): { valid: true } | { valid: false; message: string } {
    // Never run a side-effecting tool whose schema the agent has not seen.
    if (!looksReadOnly(resolved.tool, tool.annotations)) {
      return { valid: false, message: 'tool may have side effects; confirm arguments against the schema' };
    }
    // Schemas usually allow extra keys, so a misnamed argument would validate and be ignored.
    const props = (tool.inputSchema as { properties?: unknown }).properties;
    const declared = props && typeof props === 'object' ? Object.keys(props) : [];
    const unknown = Object.keys(args).filter((k) => !declared.includes(k));
    if (unknown.length > 0) {
      return { valid: false, message: `unknown argument(s): ${unknown.join(', ')}` };
    }
    return this.validate(toolName, tool, args);
  }

  private validate(
    toolName: string,
    tool: Tool,
    args: Record<string, unknown>,
  ): { valid: true } | { valid: false; message: string } {
    let validator = this.validators.get(toolName);
    if (validator === undefined) {
      try {
        const { $schema: _ignored, ...schema } = tool.inputSchema as Record<string, unknown>;
        validator = this.ajv.getValidator(schema as JsonSchemaType);
      } catch (err) {
        debug(`Cannot compile schema for ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
        validator = null;
      }
      this.validators.set(toolName, validator);
    }
    if (!validator) return { valid: false, message: 'schema could not be compiled' };
    const res = validator(args);
    return res.valid ? { valid: true } : { valid: false, message: res.errorMessage };
  }

  private promotionResult(toolName: string, full: Tool | undefined, reason: string): CallToolResult {
    if (!full) {
      return errorResult(`Tool schema was not fully loaded. It has been loaded now. Please retry your call.`);
    }
    // Present the schema with structural cleanup only: extreme levels would strip it.
    const [shown] = compressTools([full], this.level === 'none' ? 'none' : 'standard');
    const definition = JSON.stringify({ name: toolName, description: shown.description, inputSchema: shown.inputSchema });
    return errorResult(
      `Tool schema was not fully loaded (arguments rejected: ${reason}). ` +
        `It has been loaded now. Please retry your call with arguments matching this definition:\n${definition}`,
    );
  }
}

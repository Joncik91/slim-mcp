import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { info, debug, error } from './logger.js';
import { compressTools, type CompressionLevel } from './compress.js';
import { estimateTokens, formatCompressionReport } from './tokens.js';
import { createServerManager, parseNamespacedToolName } from './server-manager.js';
import { ResponseCache, NEVER_CACHE_PATTERNS } from './cache.js';
import { createLazyToolManager, formatLazyReport } from './lazy.js';
import type { LazyToolManager } from './lazy.js';
import type { CacheConfig } from './config.js';
import type { McpSlimConfig } from './config.js';

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface SingleServerOptions {
  mode: 'single';
  command: string;
  args: string[];
  compression: CompressionLevel;
  noCache?: boolean;
  noLazy?: boolean;
  maxTools?: number;
}

export interface MultiServerOptions {
  mode: 'multi';
  config: McpSlimConfig;
  noCache?: boolean;
  noLazy?: boolean;
  maxTools?: number;
}

/**
 * Union type for proxy options.
 * When `mode` is absent (legacy callers), it is treated as 'single'.
 */
export type ProxyOptions =
  | SingleServerOptions
  | MultiServerOptions
  | { command: string; args: string[]; compression?: CompressionLevel };

// ---------------------------------------------------------------------------
// Request tracker (used by single-server mode, exported for tests)
// ---------------------------------------------------------------------------

export interface RequestTracker {
  trackRequest(msg: { id: string | number; method: string }): void;
  isToolsListResponse(id: string | number): boolean;
  consume(id: string | number): void;
}

export function createRequestTracker(): RequestTracker {
  const pending = new Set<string | number>();
  return {
    trackRequest(msg: { id: string | number; method: string }) {
      if (msg.method === 'tools/list') pending.add(msg.id);
    },
    isToolsListResponse(id: string | number): boolean {
      return pending.has(id);
    },
    consume(id: string | number) {
      pending.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Compression helper (exported for tests)
// ---------------------------------------------------------------------------

export function maybeCompressResponse(
  message: any,
  tracker: RequestTracker,
  level: CompressionLevel,
): any | null {
  if (!('result' in message) || !('id' in message)) return null;
  if (!tracker.isToolsListResponse(message.id)) return null;

  tracker.consume(message.id);

  const result = message.result;
  if (!result || !Array.isArray(result.tools)) return null;
  if (level === 'none') return null;

  const before = estimateTokens(result.tools);
  const compressed = compressTools(result.tools, level);
  const after = estimateTokens(compressed);

  info(formatCompressionReport({ toolCount: compressed.length, beforeTokens: before, afterTokens: after }));

  for (let i = 0; i < result.tools.length; i++) {
    const origTokens = estimateTokens(result.tools[i]);
    const compTokens = estimateTokens(compressed[i]);
    if (origTokens !== compTokens) {
      debug(`  ${compressed[i].name}: ${origTokens} → ${compTokens} tokens`);
    }
  }

  return { ...message, result: { ...result, tools: compressed } };
}

// ---------------------------------------------------------------------------
// Single-server proxy (M1/M2 transparent pass-through)
// ---------------------------------------------------------------------------

async function startSingleServerProxy(options: SingleServerOptions): Promise<void> {
  const level: CompressionLevel = options.compression ?? 'standard';
  const tracker = createRequestTracker();

  // Cache setup
  const cacheEnabled = !options.noCache;
  const cache = cacheEnabled
    ? new ResponseCache({ enabled: true, default_ttl: 60, max_entries: 1000 })
    : null;

  // Lazy loading setup (deferred until we know tool count)
  const lazyDisabled = options.noLazy === true;
  const maxTools = options.maxTools ?? 8;
  let lazyManager: LazyToolManager | null = null;

  // Track tools/call requests for cache: id → { toolName, args }
  const pendingToolCalls = new Map<string | number, { toolName: string; args: Record<string, unknown> }>();

  const upstreamTransport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    stderr: 'inherit',
  });

  const downstreamTransport = new StdioServerTransport();

  upstreamTransport.onmessage = (message: JSONRPCMessage) => {
    debug(`← upstream: ${JSON.stringify(message)}`);
    let outMessage: any = message;

    // Check if this is a tools/list response
    if ('result' in message && 'id' in message && tracker.isToolsListResponse((message as any).id)) {
      tracker.consume((message as any).id);
      const result = (message as any).result;
      if (result && Array.isArray(result.tools)) {
        let tools = result.tools;

        // Initialize lazy manager on first tools/list if not disabled
        if (!lazyDisabled && !lazyManager && tools.length > 15) {
          lazyManager = createLazyToolManager({ maxToolsLoaded: maxTools, alwaysLoad: new Set() });
        }

        // Apply lazy loading BEFORE compression
        if (lazyManager) {
          tools = lazyManager.getToolList(tools);
          const report = lazyManager.getReport();
          if (report) {
            info(formatLazyReport(report));
          }
        }

        // Apply compression only to full tools
        if (level !== 'none') {
          const before = estimateTokens(tools);
          if (lazyManager) {
            // Compress only full tools, pass slim tools through
            const compressed = tools.map((t: any) =>
              lazyManager!.isSlim(t.name) ? t : compressTools([t], level)[0]
            );
            tools = compressed;
          } else {
            tools = compressTools(tools, level);
          }
          const after = estimateTokens(tools);
          info(formatCompressionReport({ toolCount: tools.length, beforeTokens: before, afterTokens: after }));
        }

        outMessage = { ...message, result: { ...result, tools } };
      }
    } else {
      // Cache the response if it's a tools/call result
      if (cache && 'result' in outMessage && 'id' in outMessage) {
        const pending = pendingToolCalls.get(outMessage.id as string | number);
        if (pending) {
          pendingToolCalls.delete(outMessage.id as string | number);
          const result = (outMessage as any).result;
          // Only cache successful responses (no isError flag)
          if (result && !result.isError) {
            cache.set('_single', pending.toolName, pending.args, result);
            debug(`Cache miss: ${pending.toolName} → caching for ${cache['config'].default_ttl}s`);
          }
        }
      }
    }

    downstreamTransport.send(outMessage).catch((err) => {
      error(`Failed to send to agent: ${err}`);
    });
  };

  downstreamTransport.onmessage = (message: JSONRPCMessage) => {
    debug(`→ upstream: ${JSON.stringify(message)}`);
    if ('method' in message && 'id' in message) {
      tracker.trackRequest(message as { id: string | number; method: string });

      const msg = message as any;

      // Intercept tools/call for lazy loading — slim tools get error + promotion
      if (lazyManager && msg.method === 'tools/call' && msg.params) {
        const toolName = msg.params.name as string;
        if (lazyManager.isSlim(toolName)) {
          lazyManager.promoteTools([toolName]);
          const stats = lazyManager.getStats();
          info(`Promoted tool: ${toolName} (${stats.loaded + 1} full + ${stats.slim - 1} slim)`);
          const response = {
            jsonrpc: '2.0' as const,
            id: msg.id,
            result: {
              content: [{ type: 'text', text: 'Tool schema was not fully loaded. It has been loaded now. Please retry your call.' }],
              isError: true,
            },
          };
          downstreamTransport.send(response as JSONRPCMessage).catch((err) => {
            error(`Failed to send promotion response: ${err}`);
          });
          return; // Don't forward to upstream
        }
      }

      // Intercept tools/call for caching
      if (cache && msg.method === 'tools/call' && msg.params) {
        const toolName = msg.params.name as string;
        const args = (msg.params.arguments ?? {}) as Record<string, unknown>;

        if (!cache.shouldCache(toolName)) {
          cache.recordSkip();
          debug(`Cache skip: ${toolName} (matches never-cache pattern)`);
          // Invalidate all single-server cache entries on write
          cache.invalidateServer('_single');
        } else {
          const cached = cache.get('_single', toolName, args);
          if (cached) {
            const age = Math.round((Date.now() - cached.cachedAt) / 1000);
            info(`Cache hit: ${toolName} (cached ${age}s ago)`);
            // Send cached response directly, don't forward upstream
            const response = {
              jsonrpc: '2.0' as const,
              id: msg.id,
              result: cached.result,
            };
            downstreamTransport.send(response as JSONRPCMessage).catch((err) => {
              error(`Failed to send cached response: ${err}`);
            });
            return; // Don't forward to upstream
          }
          // Track for caching when response arrives
          pendingToolCalls.set(msg.id, { toolName, args });
        }
      }
    }
    upstreamTransport.send(message).catch((err) => {
      error(`Failed to send to upstream: ${err}`);
    });
  };

  upstreamTransport.onerror = (err: Error) => {
    error(`Upstream error: ${err.message}`);
  };

  downstreamTransport.onerror = (err: Error) => {
    error(`Downstream error: ${err.message}`);
  };

  const logShutdownAndExit = () => {
    if (cache) {
      const report = cache.formatShutdownReport();
      info(report);
    }
  };

  upstreamTransport.onclose = () => {
    debug('Upstream closed');
    logShutdownAndExit();
    downstreamTransport.close().catch(() => {});
    process.exit(0);
  };

  downstreamTransport.onclose = () => {
    debug('Downstream closed');
    logShutdownAndExit();
    upstreamTransport.close().catch(() => {});
    process.exit(0);
  };

  info(`Spawning upstream: ${options.command} ${options.args.join(' ')}`);
  info(`Compression: ${level}`);
  if (cache) info(`Cache: enabled (default TTL ${cache['config'].default_ttl}s)`);
  else info(`Cache: disabled`);
  info(`Lazy loading: ${lazyDisabled ? 'disabled' : 'auto (activates when >15 tools)'}`);
  await upstreamTransport.start();
  debug('Upstream transport started');

  await downstreamTransport.start();
  debug('Downstream transport started');

  info('Proxy ready — forwarding all messages');
}

// ---------------------------------------------------------------------------
// Multi-server proxy (M3: proper MCP Server with ServerManager)
// ---------------------------------------------------------------------------

async function startMultiServerProxy(options: MultiServerOptions): Promise<void> {
  const { config } = options;
  const level: CompressionLevel = config.compression ?? 'standard';

  // Cache setup
  const cacheDisabled = options.noCache || config.cache?.enabled === false;
  const cacheConfig = config.cache ?? { enabled: true, default_ttl: 60, max_entries: 1000 };
  const cache = !cacheDisabled ? new ResponseCache(cacheConfig) : null;

  const serverNames = Object.keys(config.servers);
  const serverLabels = serverNames.map(name => {
    const cfg = config.servers[name];
    const type = cfg.url ? (cfg.type ?? 'http') : 'stdio';
    return `${name} (${type})`;
  });
  info(`Starting with ${serverNames.length} servers: ${serverLabels.join(', ')}`);

  const serverManager = createServerManager(config.servers);
  await serverManager.connectAll();

  // Determine how many servers actually connected
  const connectedCount = [...serverManager.servers.values()].filter((s) => s.connected).length;
  const useNamespace = connectedCount >= 2;

  // Lazy loading setup
  const lazyDisabled = options.noLazy === true || config.lazy_loading === false;
  const maxTools = options.maxTools ?? config.max_tools_loaded ?? 8;
  const allAlwaysLoad = new Set<string>();
  for (const [srvName, srvCfg] of Object.entries(config.servers)) {
    if (srvCfg.always_load) {
      for (const toolName of srvCfg.always_load) {
        // Store both namespaced and bare names so matching works either way
        allAlwaysLoad.add(useNamespace ? `${srvName}__${toolName}` : toolName);
      }
    }
  }

  // Count total tools to decide auto-enable
  const totalTools = [...serverManager.servers.values()]
    .filter(s => s.connected)
    .reduce((sum, s) => sum + s.tools.length, 0);
  const lazyExplicit = config.lazy_loading !== undefined || options.noLazy === true;
  const lazyEnabled = !lazyDisabled && (lazyExplicit ? config.lazy_loading !== false : totalTools > 15);
  const lazyManager: LazyToolManager | null = lazyEnabled
    ? createLazyToolManager({ maxToolsLoaded: maxTools, alwaysLoad: allAlwaysLoad })
    : null;

  if (cache) info(`Cache: enabled (default TTL ${cacheConfig.default_ttl}s)`);
  else info(`Cache: disabled`);
  info(`Lazy loading: ${lazyManager ? `enabled (max ${maxTools} full)` : `disabled${totalTools <= 15 && !lazyExplicit ? ` (${totalTools} tools ≤ 15)` : ''}` }`);

  // Build the MCP server
  const server = new Server(
    { name: 'slim-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let tools = serverManager.getMergedTools(useNamespace);
    info(`Ready: ${tools.length} tools from ${connectedCount} servers`);

    // Apply lazy loading BEFORE compression
    if (lazyManager) {
      tools = lazyManager.getToolList(tools);
      const report = lazyManager.getReport();
      if (report) {
        info(formatLazyReport(report));
      }
    }

    if (level === 'none') {
      return { tools };
    }

    const before = estimateTokens(tools);
    // Compress only full tools when lazy loading is active
    let compressed: typeof tools;
    if (lazyManager) {
      compressed = tools.map((t) =>
        lazyManager!.isSlim(t.name) ? t : compressTools([t], level)[0]
      );
    } else {
      compressed = compressTools(tools, level);
    }
    const after = estimateTokens(compressed);

    info(formatCompressionReport({ toolCount: compressed.length, beforeTokens: before, afterTokens: after }));

    for (let i = 0; i < tools.length; i++) {
      const origTokens = estimateTokens(tools[i]);
      const compTokens = estimateTokens(compressed[i]);
      if (origTokens !== compTokens) {
        debug(`  ${compressed[i].name}: ${origTokens} → ${compTokens} tokens`);
      }
    }

    return { tools: compressed };
  });

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    debug(`tools/call: ${toolName}`);

    // Lazy loading: intercept slim tools BEFORE cache check
    if (lazyManager && lazyManager.isSlim(toolName)) {
      lazyManager.promoteTools([toolName]);
      const stats = lazyManager.getStats();
      info(`Promoted tool: ${toolName} (${stats.loaded + 1} full + ${stats.slim - 1} slim)`);
      return {
        content: [{ type: 'text', text: 'Tool schema was not fully loaded. It has been loaded now. Please retry your call.' }],
        isError: true,
      };
    }

    // Resolve server name and original tool name for cache keying
    let serverName: string;
    let originalToolName: string;
    if (useNamespace) {
      const parsed = parseNamespacedToolName(toolName);
      serverName = parsed.serverName || '_unknown';
      originalToolName = parsed.toolName;
    } else {
      serverName = '_single';
      originalToolName = toolName;
    }

    // Cache check
    if (cache) {
      if (!cache.shouldCache(originalToolName)) {
        cache.recordSkip();
        debug(`Cache skip: ${toolName} (matches never-cache pattern)`);
        cache.invalidateServer(serverName);
      } else {
        const cached = cache.get(serverName, originalToolName, args);
        if (cached) {
          const age = Math.round((Date.now() - cached.cachedAt) / 1000);
          info(`Cache hit: ${toolName} (cached ${age}s ago)`);
          return cached.result as { content: unknown[] };
        }
      }
    }

    try {
      const result = await serverManager.routeToolCall(toolName, args, useNamespace);
      // Cache successful results
      if (cache && cache.shouldCache(originalToolName)) {
        const r = result as any;
        if (!r?.isError) {
          cache.set(serverName, originalToolName, args, result);
          debug(`Cache miss: ${toolName} → caching`);
        }
      }
      return result as { content: unknown[] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: unknown[] = [];
    for (const srv of serverManager.servers.values()) {
      if (!srv.connected) continue;
      try {
        const result = await srv.client.listResources();
        resources.push(...(result.resources ?? []));
      } catch {
        // server may not support resources — skip
      }
    }
    return { resources };
  });

  // resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    debug(`resources/read: ${uri}`);
    try {
      const result = await serverManager.routeResourceRead(uri);
      return result as { contents: unknown[] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Resource not found: ${msg}`);
    }
  });

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts: unknown[] = [];
    for (const srv of serverManager.servers.values()) {
      if (!srv.connected) continue;
      try {
        const result = await srv.client.listPrompts();
        prompts.push(...(result.prompts ?? []));
      } catch {
        // server may not support prompts — skip
      }
    }
    return { prompts };
  });

  // prompts/get — route to first server that has the prompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const promptName = request.params.name;
    const promptArgs = request.params.arguments;
    debug(`prompts/get: ${promptName}`);

    for (const srv of serverManager.servers.values()) {
      if (!srv.connected) continue;
      try {
        const result = await srv.client.getPrompt({ name: promptName, arguments: promptArgs });
        return result;
      } catch {
        // try next server
      }
    }
    throw new Error(`Prompt "${promptName}" not found on any connected server`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    debug('Shutting down multi-server proxy');
    if (cache) {
      info(cache.formatShutdownReport());
    }
    await serverManager.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect agent-facing transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  info('Multi-server proxy ready');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function startProxy(options: ProxyOptions): Promise<void> {
  // Handle legacy callers that pass { command, args, compression } without mode
  if (!('mode' in options)) {
    return startSingleServerProxy({
      mode: 'single',
      command: (options as any).command,
      args: (options as any).args,
      compression: (options as any).compression ?? 'standard',
    });
  }

  if (options.mode === 'single') {
    return startSingleServerProxy(options);
  }

  return startMultiServerProxy(options);
}

import { basename } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type CallToolResult,
  type JSONRPCMessage,
  type Prompt,
  type RequestId,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { info, debug, error, warn } from './logger.js';
import type { CompressionLevel } from './compress.js';
import { createServerManager, parseNamespacedToolName, childEnv, type ServerManager } from './server-manager.js';
import { ResponseCache } from './cache.js';
import { createLazyToolManager, type LazyToolManager } from './lazy.js';
import { DEFAULT_CACHE, type McpSlimConfig } from './config.js';
import { ToolPipeline, type CallTicket, type ResolvedTool } from './pipeline.js';
import { startDashboard, type DashboardConfig, type DashboardHandle } from './dashboard.js';
import { stats } from './stats.js';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface CommonOptions {
  noCache?: boolean;
  noLazy?: boolean;
  maxTools?: number;
  /** Start the stats dashboard once upstream servers are up. */
  dashboard?: DashboardConfig;
}

export interface SingleServerOptions extends CommonOptions {
  mode: 'single';
  command: string;
  args: string[];
  compression: CompressionLevel;
}

export interface MultiServerOptions extends CommonOptions {
  mode: 'multi';
  config: McpSlimConfig;
}

export type ProxyOptions = SingleServerOptions | MultiServerOptions;

/** Lazy loading turns on automatically above this many tools. */
export const LAZY_AUTO_THRESHOLD = 15;
export const DEFAULT_MAX_TOOLS = 8;
const SINGLE_SERVER_KEY = '_single';

// ---------------------------------------------------------------------------
// Shutdown coordination
// ---------------------------------------------------------------------------

/**
 * Run `cleanup` once, on the first of: SIGINT, SIGTERM, SIGHUP, stdin EOF (the MCP stdio
 * shutdown signal), or an explicit trigger. Then exit with the given code.
 */
function installShutdown(cleanup: () => Promise<void>): (code?: number) => void {
  let started = false;
  const run = (code = 0) => {
    if (started) return;
    started = true;
    const hardExit = setTimeout(() => process.exit(code), 10_000);
    hardExit.unref();
    cleanup()
      .catch((err) => error(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => process.exit(code));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      debug(`Received ${sig}`);
      run(0);
    });
  }
  process.stdin.once('end', () => {
    debug('Agent closed stdin');
    run(0);
  });
  return run;
}

function makeLazy(enabled: boolean, maxTools: number, alwaysLoad: Set<string>): LazyToolManager | null {
  return enabled ? createLazyToolManager({ maxToolsLoaded: maxTools, alwaysLoad }) : null;
}

// ---------------------------------------------------------------------------
// Single-server proxy: transparent JSON-RPC pass-through with interception
// ---------------------------------------------------------------------------

interface PendingRequest {
  method: string;
  ticket?: CallTicket;
  /** tools/list request carried a cursor (a later page). */
  cursor?: boolean;
}

/** Tracks agent → upstream requests by id until the upstream answers. */
export class PendingRequests {
  private readonly map = new Map<RequestId, PendingRequest>();

  track(id: RequestId, entry: PendingRequest): void {
    this.map.set(id, entry);
  }

  /** Remove and return the entry for a response id. */
  take(id: RequestId): PendingRequest | undefined {
    const entry = this.map.get(id);
    this.map.delete(id);
    return entry;
  }

  get size(): number {
    return this.map.size;
  }

  drain(): PendingRequest[] {
    const all = [...this.map.values()];
    this.map.clear();
    return all;
  }
}

async function startSingleServerProxy(options: SingleServerOptions): Promise<void> {
  const level: CompressionLevel = options.compression ?? 'standard';
  const cache = options.noCache ? null : new ResponseCache({ ...DEFAULT_CACHE });
  const lazyDisabled = options.noLazy === true;
  const maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;
  const serverLabel = basename(options.args.find((a) => !a.startsWith('-')) ?? options.command);

  const resolve = (toolName: string): ResolvedTool => ({ server: SINGLE_SERVER_KEY, tool: toolName });
  const pipeline = new ToolPipeline({ level, cache, lazy: null, resolve });
  const pending = new PendingRequests();
  let sawPagination = false;
  let listedTools = 0;

  const upstream = new StdioClientTransport({
    command: options.command,
    args: options.args,
    env: childEnv(),
    stderr: 'inherit',
  });
  const downstream = new StdioServerTransport();

  const sendDown = (message: JSONRPCMessage, what: string) => {
    downstream.send(message).catch((err) => error(`Failed to send ${what} to agent: ${err}`));
  };

  pipeline.onToolListChanged = () => {
    sendDown({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, 'tools/list_changed');
  };

  upstream.onmessage = (message: JSONRPCMessage) => {
    debug(() => `← upstream: ${JSON.stringify(message)}`);
    let out: JSONRPCMessage = message;

    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const req = message.id !== undefined ? pending.take(message.id) : undefined;

      if (req && isJSONRPCResultResponse(message)) {
        const result = message.result as Record<string, unknown>;

        if (req.method === 'initialize' && !lazyDisabled) {
          // Advertise listChanged so the agent re-fetches tools after a lazy promotion.
          const caps = result.capabilities as ServerCapabilities | undefined;
          if (caps?.tools) {
            out = { ...message, result: { ...result, capabilities: { ...caps, tools: { ...caps.tools, listChanged: true } } } };
          }
        } else if (req.method === 'tools/list' && Array.isArray(result.tools)) {
          const tools = result.tools as Tool[];
          const paginated = req.cursor === true || typeof result.nextCursor === 'string';
          // Lazy loading needs the whole tool set; a paginated server never gets it.
          if (paginated) sawPagination = true;
          if (!lazyDisabled && !sawPagination && !pipeline.lazyManager && tools.length > LAZY_AUTO_THRESHOLD) {
            pipeline.setLazyManager(makeLazy(true, maxTools, new Set()));
          }
          if (sawPagination && pipeline.lazyManager) {
            debug('Paginated tools/list: lazy loading disabled');
            pipeline.setLazyManager(null);
          }
          const transformed = pipeline.transformToolList(tools, { append: req.cursor === true, paginated: sawPagination });
          listedTools = req.cursor === true ? listedTools + tools.length : tools.length;
          stats.registerServer({ name: serverLabel, transport: 'stdio', tools: listedTools, status: 'connected' });
          out = { ...message, result: { ...result, tools: transformed } };
        } else if (req.method === 'tools/call' && req.ticket) {
          pipeline.completeCall(req.ticket, { result });
        }
      } else if (req?.ticket) {
        pipeline.completeCall(req.ticket, { error: (message as { error?: unknown }).error });
      }
    }

    sendDown(out, 'upstream message');
  };

  downstream.onmessage = (message: JSONRPCMessage) => {
    debug(() => `→ upstream: ${JSON.stringify(message)}`);

    if (isJSONRPCRequest(message)) {
      if (message.method === 'tools/call' && message.params) {
        const params = message.params as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const decision = pipeline.beginCall(name, args);
        if (decision.action === 'respond') {
          sendDown({ jsonrpc: '2.0', id: message.id, result: decision.result }, 'local tools/call result');
          return; // answered locally, never reaches upstream
        }
        pending.track(message.id, { method: message.method, ticket: decision.ticket });
      } else {
        const cursor = message.method === 'tools/list' && typeof (message.params as { cursor?: unknown } | undefined)?.cursor === 'string';
        pending.track(message.id, cursor ? { method: message.method, cursor } : { method: message.method });
      }
    } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      const req = requestId !== undefined ? pending.take(requestId) : undefined;
      if (req?.ticket) pipeline.abandonCall(req.ticket);
    }

    upstream.send(message).catch((err) => error(`Failed to send to upstream: ${err}`));
  };

  upstream.onerror = (err: Error) => error(`Upstream error: ${err.message}`);
  downstream.onerror = (err: Error) => error(`Downstream error: ${err.message}`);

  let dashboard: DashboardHandle | null = null;
  let stopping = false;
  const shutdown = installShutdown(async () => {
    stopping = true;
    for (const req of pending.drain()) {
      if (req.ticket) pipeline.abandonCall(req.ticket);
    }
    if (cache) info(cache.formatShutdownReport());
    await upstream.close().catch(() => {});
    await dashboard?.close();
  });

  upstream.onclose = () => {
    if (stopping) return;
    warn('Upstream server exited unexpectedly');
    shutdown(1);
  };
  downstream.onclose = () => {
    debug('Downstream closed');
    shutdown(0);
  };

  info(`Spawning upstream: ${options.command} ${options.args.join(' ')}`);
  info(`Compression: ${level}`);
  info(cache ? `Cache: enabled (default TTL ${cache.defaultTtl}s)` : 'Cache: disabled');
  info(`Lazy loading: ${lazyDisabled ? 'disabled' : `auto (activates when >${LAZY_AUTO_THRESHOLD} tools)`}`);
  stats.recordCacheEnabled(!!cache);
  stats.registerServer({ name: serverLabel, transport: 'stdio', tools: 0, status: 'connected' });

  try {
    await upstream.start();
  } catch (err) {
    stats.registerServer({ name: serverLabel, transport: 'stdio', tools: 0, status: 'failed' });
    throw new Error(`Cannot spawn upstream "${options.command}": ${err instanceof Error ? err.message : String(err)}`);
  }
  debug('Upstream transport started');

  await downstream.start();
  debug('Downstream transport started');

  if (options.dashboard) dashboard = startDashboard(options.dashboard);
  info('Proxy ready — forwarding all messages');
}

// ---------------------------------------------------------------------------
// Multi-server proxy: an MCP Server aggregating several upstream clients
// ---------------------------------------------------------------------------

function connectedServers(manager: ServerManager) {
  return [...manager.servers.values()].filter((s) => s.connected);
}

async function startMultiServerProxy(options: MultiServerOptions): Promise<void> {
  const { config } = options;
  const level: CompressionLevel = config.compression ?? 'standard';

  const cacheDisabled = options.noCache || config.cache?.enabled === false;
  const cacheConfig = config.cache ?? { ...DEFAULT_CACHE };
  const cache = cacheDisabled ? null : new ResponseCache(cacheConfig);

  const serverNames = Object.keys(config.servers);
  const serverLabels = serverNames.map((name) => {
    const cfg = config.servers[name];
    return `${name} (${cfg.url ? (cfg.type ?? 'http') : 'stdio'})`;
  });
  info(`Starting with ${serverNames.length} servers: ${serverLabels.join(', ')}`);

  const manager = createServerManager(config.servers);
  await manager.connectAll();

  const connected = connectedServers(manager);
  // Namespacing is fixed at startup so tool names stay stable if a server drops later.
  const useNamespace = connected.length >= 2;

  for (const srv of manager.servers.values()) {
    stats.registerServer({
      name: srv.name,
      transport: srv.connected ? srv.transport : (config.servers[srv.name]?.url ? (config.servers[srv.name].type ?? 'http') : 'stdio'),
      tools: srv.tools.length,
      status: srv.connected ? 'connected' : 'failed',
    });
  }

  // Lazy loading
  const alwaysLoad = new Set<string>();
  for (const [srvName, srvCfg] of Object.entries(config.servers)) {
    for (const toolName of srvCfg.always_load ?? []) {
      alwaysLoad.add(useNamespace ? `${srvName}__${toolName}` : toolName);
    }
  }
  const maxTools = options.maxTools ?? config.max_tools_loaded ?? DEFAULT_MAX_TOOLS;
  const totalTools = connected.reduce((sum, s) => sum + s.tools.length, 0);
  const lazyEnabled =
    options.noLazy === true ? false : config.lazy_loading ?? totalTools > LAZY_AUTO_THRESHOLD;
  const lazy = makeLazy(lazyEnabled, maxTools, alwaysLoad);

  stats.recordCacheEnabled(!!cache);
  info(cache ? `Cache: enabled (default TTL ${cacheConfig.default_ttl}s)` : 'Cache: disabled');
  info(
    `Lazy loading: ${
      lazy
        ? `enabled (max ${maxTools} full)`
        : `disabled${config.lazy_loading === undefined && !options.noLazy ? ` (${totalTools} tools ≤ ${LAZY_AUTO_THRESHOLD})` : ''}`
    }`,
  );

  // With one connected server, cache keys use its real name so server_ttls/cache_ttl apply.
  const soleServer = useNamespace ? undefined : connected[0]?.name;
  const cacheServerKey = (name: string) => (useNamespace ? name : soleServer ?? SINGLE_SERVER_KEY);
  const resolve = (toolName: string): ResolvedTool => {
    if (!useNamespace) return { server: soleServer ?? SINGLE_SERVER_KEY, tool: toolName };
    const parsed = parseNamespacedToolName(toolName);
    return { server: parsed.serverName || '_unknown', tool: parsed.toolName };
  };
  const pipeline = new ToolPipeline({ level, cache, lazy, resolve });

  // Only advertise what at least one upstream supports.
  const anyCap = (cap: 'resources' | 'prompts') => connected.some((s) => !!s.client.getServerCapabilities()?.[cap]);
  const capabilities: ServerCapabilities = { tools: { listChanged: true } };
  if (anyCap('resources')) capabilities.resources = {};
  if (anyCap('prompts')) capabilities.prompts = {};

  const server = new Server({ name: 'slim-mcp', version: VERSION }, { capabilities });

  let initialized = false;
  server.oninitialized = () => {
    initialized = true;
  };
  const notifyToolsChanged = () => {
    if (!initialized) return;
    server.sendToolListChanged().catch((err) => debug(`tools/list_changed not delivered: ${err}`));
  };
  pipeline.onToolListChanged = notifyToolsChanged;

  manager.onEvent((event) => {
    const srv = manager.servers.get(event.server);
    if (!srv) return;
    cache?.invalidateServer(cacheServerKey(srv.name));
    stats.registerServer({
      name: srv.name,
      transport: srv.transport,
      tools: srv.tools.length,
      status: srv.connected ? 'connected' : 'disconnected',
    });
    notifyToolsChanged();
  });

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = manager.getMergedTools(useNamespace);
    debug(`tools/list: ${tools.length} tools from ${connectedServers(manager).length} servers`);
    return { tools: pipeline.transformToolList(tools) };
  });

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    debug(`tools/call: ${toolName}`);

    const decision = pipeline.beginCall(toolName, args);
    if (decision.action === 'respond') return decision.result;

    try {
      const result = await manager.routeToolCall(toolName, args, useNamespace, { signal: extra.signal });
      pipeline.completeCall(decision.ticket, { result });
      return result;
    } catch (err) {
      pipeline.completeCall(decision.ticket, { error: err });
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  // resources — list across servers in parallel, remember which server owns each URI
  const resourceOwner = new Map<string, string>();

  async function gather<T>(
    fetch: (srv: ReturnType<typeof connectedServers>[number]) => Promise<T[]>,
    cap: 'resources' | 'prompts',
    what: string,
  ): Promise<{ server: string; items: T[] }[]> {
    const targets = connectedServers(manager).filter((s) => !!s.client.getServerCapabilities()?.[cap]);
    const results = await Promise.allSettled(targets.map(async (s) => ({ server: s.name, items: await fetch(s) })));
    const ok: { server: string; items: T[] }[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value);
      else debug(`${what} failed on ${targets[i].name}: ${r.reason}`);
    });
    return ok;
  }

  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (_req, extra) => {
      const perServer = await gather<Resource>(
        async (s) => (await s.client.listResources(undefined, { signal: extra.signal })).resources ?? [],
        'resources',
        'resources/list',
      );
      const resources: Resource[] = [];
      for (const { server: owner, items } of perServer) {
        for (const r of items) {
          resourceOwner.set(r.uri, owner);
          resources.push(r);
        }
      }
      return { resources };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (_req, extra) => {
      const perServer = await gather<ResourceTemplate>(
        async (s) => (await s.client.listResourceTemplates(undefined, { signal: extra.signal })).resourceTemplates ?? [],
        'resources',
        'resources/templates/list',
      );
      return { resourceTemplates: perServer.flatMap((p) => p.items) };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const uri = request.params.uri;
      debug(`resources/read: ${uri}`);
      const owner = manager.servers.get(resourceOwner.get(uri) ?? '');
      if (owner?.connected) {
        try {
          return await owner.client.readResource({ uri }, { signal: extra.signal });
        } catch (err) {
          debug(`resources/read on owner ${owner.name} failed, trying others: ${err}`);
        }
      }
      return (await manager.routeResourceRead(uri, { signal: extra.signal })) as { contents: [] };
    });
  }

  // prompts — same ownership routing as resources
  const promptOwner = new Map<string, string>();

  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (_req, extra) => {
      const perServer = await gather<Prompt>(
        async (s) => (await s.client.listPrompts(undefined, { signal: extra.signal })).prompts ?? [],
        'prompts',
        'prompts/list',
      );
      const prompts: Prompt[] = [];
      for (const { server: owner, items } of perServer) {
        for (const p of items) {
          if (!promptOwner.has(p.name)) promptOwner.set(p.name, owner);
          prompts.push(p);
        }
      }
      return { prompts };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const { name, arguments: promptArgs } = request.params;
      debug(`prompts/get: ${name}`);
      const ownerName = promptOwner.get(name);
      const candidates = connectedServers(manager).filter((s) => !!s.client.getServerCapabilities()?.prompts);
      const ordered = ownerName
        ? [...candidates.filter((s) => s.name === ownerName), ...candidates.filter((s) => s.name !== ownerName)]
        : candidates;
      const errors: string[] = [];
      for (const srv of ordered) {
        try {
          return await srv.client.getPrompt({ name, arguments: promptArgs }, { signal: extra.signal });
        } catch (err) {
          errors.push(`${srv.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(`Prompt "${name}" not found on any connected server${errors.length ? ` (${errors.join('; ')})` : ''}`);
    });
  }

  let dashboard: DashboardHandle | null = null;
  const shutdown = installShutdown(async () => {
    debug('Shutting down multi-server proxy');
    if (cache) info(cache.formatShutdownReport());
    await manager.shutdown();
    await dashboard?.close();
  });

  server.onclose = () => shutdown(0);

  await server.connect(new StdioServerTransport());
  if (options.dashboard) dashboard = startDashboard(options.dashboard);

  info(`Ready: ${totalTools} tools from ${connected.length} servers`);
  info('Multi-server proxy ready');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function startProxy(options: ProxyOptions): Promise<void> {
  if (options.mode === 'single') {
    return startSingleServerProxy(options);
  }
  return startMultiServerProxy(options);
}

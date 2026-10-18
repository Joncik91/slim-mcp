import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { info, debug, error, warn } from './logger.js';
import type { ServerConfig } from './config.js';
import { createTypedTransport, connectWithAutoDetect } from './transport/http.js';
import { VERSION } from './version.js';

export const CONNECT_TIMEOUT_MS = 30_000;

export interface ManagedServer {
  name: string;
  client: Client;
  tools: Tool[];
  connected: boolean;
  /** Transport actually used: stdio, http (streamable) or sse. */
  transport: 'stdio' | 'http' | 'sse';
}

export type ServerEvent =
  | { type: 'tools_changed'; server: string }
  | { type: 'disconnected'; server: string };

export interface ServerManager {
  servers: Map<string, ManagedServer>;

  /** Initialize all servers in parallel, skip failures */
  connectAll(): Promise<void>;

  /** Get merged tool list with optional namespacing */
  getMergedTools(namespace: boolean): Tool[];

  /** Route a tool call to the correct server */
  routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    namespace: boolean,
    options?: RequestOptions,
  ): Promise<CallToolResult>;

  /** Route a resource read — tries each server, returns first success */
  routeResourceRead(uri: string, options?: RequestOptions): Promise<unknown>;

  /** Subscribe to upstream changes (tool list refreshes, disconnects). */
  onEvent(listener: (event: ServerEvent) => void): void;

  /** Shut down all servers */
  shutdown(): Promise<void>;
}

export const NAMESPACE_SEPARATOR = '__';

export function namespaceTool(serverName: string, tool: Tool): Tool {
  return { ...tool, name: `${serverName}${NAMESPACE_SEPARATOR}${tool.name}` };
}

export function parseNamespacedToolName(toolName: string): { serverName: string; toolName: string } {
  const sep = toolName.indexOf(NAMESPACE_SEPARATOR);
  if (sep === -1) {
    return { serverName: '', toolName };
  }
  return { serverName: toolName.slice(0, sep), toolName: toolName.slice(sep + NAMESPACE_SEPARATOR.length) };
}

/** Race a promise against a timer; the timer is always cleared so it never holds the event loop. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch every page of tools/list (servers may paginate via nextCursor). */
export async function listAllTools(client: Client, maxPages = 100): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...res.tools);
    if (!res.nextCursor || res.nextCursor === cursor) return tools;
    cursor = res.nextCursor;
  }
  warn(`tools/list pagination stopped after ${maxPages} pages`);
  return tools;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Environment for a stdio child: the full parent env (PATH, proxies, npm config) plus overrides. */
export function childEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...(overrides ?? {}) };
}

export function createServerManager(
  configs: Record<string, ServerConfig>
): ServerManager {
  const servers = new Map<string, ManagedServer>();
  const listeners: ((event: ServerEvent) => void)[] = [];
  let shuttingDown = false;

  if (Object.keys(configs).length === 0) {
    warn('no servers configured');
  }

  function emit(event: ServerEvent): void {
    for (const l of listeners) {
      try {
        l(event);
      } catch (err) {
        error(`server event listener failed: ${errMessage(err)}`);
      }
    }
  }

  async function refreshTools(server: ManagedServer): Promise<void> {
    try {
      const tools = await listAllTools(server.client);
      server.tools = tools;
      info(`${server.name}: tool list changed (${tools.length} tools)`);
      emit({ type: 'tools_changed', server: server.name });
    } catch (err) {
      warn(`${server.name}: failed to refresh tools after list_changed: ${errMessage(err)}`);
    }
  }

  async function connectOne(name: string, cfg: ServerConfig): Promise<void> {
    const stderrLines: string[] = [];
    let client = new Client({ name: 'slim-mcp', version: VERSION });
    let transport = 'stdio' as ManagedServer['transport'];
    let abandoned = false;

    const attempt = async (): Promise<Tool[]> => {
      if (cfg.url) {
        if (cfg.type) {
          await client.connect(createTypedTransport(cfg.url, cfg.type, cfg.headers));
          transport = cfg.type;
        } else {
          const detected = await connectWithAutoDetect(cfg.url, cfg.headers, () => {
            if (abandoned) throw new Error(`connect ${name} abandoned`);
            client = new Client({ name: 'slim-mcp', version: VERSION });
            return client;
          }, client);
          transport = detected;
        }
      } else {
        const stdio = new StdioClientTransport({
          command: cfg.command ?? '',
          args: cfg.args ?? [],
          env: childEnv(cfg.env),
          stderr: 'pipe',
        });
        // Keep the last stderr lines for richer error messages; log them in verbose mode.
        stdio.stderr?.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) debug(`${name} stderr: ${line}`);
          stderrLines.push(...lines);
          if (stderrLines.length > 20) stderrLines.splice(0, stderrLines.length - 20);
        });
        await client.connect(stdio);
        transport = 'stdio';
      }
      const caps = client.getServerCapabilities();
      if (!caps?.tools) return [];
      return listAllTools(client);
    };

    try {
      const tools = await withTimeout(attempt(), CONNECT_TIMEOUT_MS, `connect ${name}`);
      const managed: ManagedServer = { name, client, tools, connected: true, transport };
      servers.set(name, managed);

      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void refreshTools(managed);
      });
      client.onclose = () => {
        if (!managed.connected || shuttingDown) return;
        managed.connected = false;
        const tail = stderrLines.at(-1);
        warn(`${name} disconnected${tail ? ` — stderr: ${tail}` : ''}`);
        emit({ type: 'disconnected', server: name });
      };

      info(`✓ ${name} connected via ${transport === 'http' ? 'streamable-http' : transport} (${tools.length} tools)`);
      debug(() => `${name} tools: ${tools.map((t) => t.name).join(', ')}`);
    } catch (err) {
      abandoned = true;
      const lastStderr = stderrLines.at(-1);
      const msg = errMessage(err);
      error(`✗ ${name} failed: ${lastStderr ? `${msg} — stderr: ${lastStderr}` : msg}`);
      // Kill whatever the attempt started (child process, HTTP session) so it can't leak.
      await client.close().catch(() => {});
      servers.set(name, { name, client, tools: [], connected: false, transport });
      throw err;
    }
  }

  async function connectAll(): Promise<void> {
    const entries = Object.entries(configs);
    const results = await Promise.allSettled(entries.map(([name, cfg]) => connectOne(name, cfg)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      info(`${failed} of ${entries.length} server(s) failed to connect`);
    }
  }

  function getMergedTools(namespace: boolean): Tool[] {
    const merged: Tool[] = [];
    for (const server of servers.values()) {
      if (!server.connected) continue;
      for (const tool of server.tools) {
        merged.push(namespace ? namespaceTool(server.name, tool) : tool);
      }
    }
    return merged;
  }

  async function routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    namespace: boolean,
    options?: RequestOptions,
  ): Promise<CallToolResult> {
    let server: ManagedServer | undefined;
    let originalToolName = toolName;

    if (namespace) {
      const parsed = parseNamespacedToolName(toolName);
      if (!parsed.serverName) {
        throw new Error(`Namespaced tool name "${toolName}" is missing "${NAMESPACE_SEPARATOR}" separator`);
      }
      server = servers.get(parsed.serverName);
      originalToolName = parsed.toolName;
      if (!server || !server.connected) {
        throw new Error(`Server "${parsed.serverName}" not found or not connected (tool: "${toolName}")`);
      }
    } else {
      for (const candidate of servers.values()) {
        if (candidate.connected && candidate.tools.some((t) => t.name === toolName)) {
          server = candidate;
          break;
        }
      }
      if (!server) throw new Error(`Tool "${toolName}" not found on any connected server`);
    }

    debug(`Routing "${originalToolName}" → ${server.name}`);
    return (await server.client.callTool({ name: originalToolName, arguments: args }, undefined, options)) as CallToolResult;
  }

  async function routeResourceRead(uri: string, options?: RequestOptions): Promise<unknown> {
    const errors: string[] = [];
    for (const server of servers.values()) {
      if (!server.connected || !server.client.getServerCapabilities()?.resources) continue;
      try {
        const result = await server.client.readResource({ uri }, options);
        debug(`Resource "${uri}" served by ${server.name}`);
        return result;
      } catch (err) {
        errors.push(`${server.name}: ${errMessage(err)}`);
      }
    }
    throw new Error(`Resource "${uri}" not found on any connected server${errors.length ? ` (${errors.join('; ')})` : ''}`);
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    const entries = [...servers.values()];
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async (server) => {
        await withTimeout(server.client.close(), 5_000, `close ${server.name}`);
        server.connected = false;
        debug(`Closed ${server.name}`);
      })
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      error(`${failed.length} server(s) failed to close cleanly`);
    } else {
      info(`All servers shut down`);
    }
  }

  return {
    servers,
    connectAll,
    getMergedTools,
    routeToolCall,
    routeResourceRead,
    onEvent: (l) => listeners.push(l),
    shutdown,
  };
}

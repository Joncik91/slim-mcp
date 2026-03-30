import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { info, debug, error } from './logger.js';
import type { ServerConfig } from './config.js';
import { createTypedTransport, connectWithAutoDetect } from './transport/http.js';
import type { TransportType } from './transport/http.js';

export interface ManagedServer {
  name: string;
  client: Client;
  tools: Tool[];
  connected: boolean;
}

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
    namespace: boolean
  ): Promise<unknown>;

  /** Route a resource read — tries each server, returns first success */
  routeResourceRead(uri: string): Promise<unknown>;

  /** Shut down all servers */
  shutdown(): Promise<void>;
}

export function namespaceTool(serverName: string, tool: Tool): Tool {
  return { ...tool, name: `${serverName}__${tool.name}` };
}

export function parseNamespacedToolName(toolName: string): { serverName: string; toolName: string } {
  const sep = toolName.indexOf('__');
  if (sep === -1) {
    return { serverName: '', toolName };
  }
  return { serverName: toolName.slice(0, sep), toolName: toolName.slice(sep + 2) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export function createServerManager(
  configs: Record<string, ServerConfig>
): ServerManager {
  const servers = new Map<string, ManagedServer>();

  if (Object.keys(configs).length === 0) {
    info('Warning: no servers configured');
  }

  async function connectAll(): Promise<void> {
    const entries = Object.entries(configs);

    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        const stderrLines: string[] = [];
        const client = new Client({ name: 'slim-mcp', version: '0.1.0' });
        let transportLabel: string;

        try {
          await withTimeout(
            (async () => {
              if (cfg.url) {
                // HTTP/SSE transport
                if (cfg.type) {
                  // Explicit type
                  const transport = createTypedTransport(cfg.url, cfg.type, cfg.headers);
                  await client.connect(transport);
                  transportLabel = cfg.type === 'sse' ? 'sse' : 'streamable-http';
                } else {
                  // Auto-detect
                  const detected = await connectWithAutoDetect(client, cfg.url, cfg.headers);
                  transportLabel = detected === 'sse' ? 'sse' : 'streamable-http';
                }
              } else {
                // Stdio transport
                const transport = new StdioClientTransport({
                  command: cfg.command ?? '',
                  args: cfg.args ?? [],
                  env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
                  stderr: 'pipe',
                });

                // Collect stderr for richer error messages
                if (transport.stderr) {
                  transport.stderr.on('data', (chunk: Buffer) => {
                    const lines = chunk.toString().split('\n').filter(Boolean);
                    stderrLines.push(...lines);
                    if (stderrLines.length > 20) stderrLines.splice(0, stderrLines.length - 20);
                  });
                }

                await client.connect(transport);
                transportLabel = 'stdio';
              }

              const { tools } = await client.listTools();
              return tools;
            })(),
            30_000,
            `connect ${name}`
          ).then((tools) => {
            servers.set(name, { name, client, tools, connected: true });
            info(`✓ ${name} connected via ${transportLabel} (${tools.length} tools)`);
            debug(`${name} tools: ${tools.map((t) => t.name).join(', ')}`);
          });
        } catch (err) {
          const lastStderr = stderrLines.at(-1);
          const msg = err instanceof Error ? err.message : String(err);
          const detail = lastStderr ? `${msg} — stderr: ${lastStderr}` : msg;
          error(`✗ ${name} failed: ${detail}`);

          // Store a disconnected placeholder so callers can inspect the map
          servers.set(name, {
            name,
            client,
            tools: [],
            connected: false,
          });

          throw err; // allSettled captures this
        }
      })
    );

    // Log summary if some failed
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
    namespace: boolean
  ): Promise<unknown> {
    let serverName: string;
    let originalToolName: string;

    if (namespace) {
      const parsed = parseNamespacedToolName(toolName);
      if (!parsed.serverName) {
        throw new Error(`Namespaced tool name "${toolName}" is missing "__" separator`);
      }
      serverName = parsed.serverName;
      originalToolName = parsed.toolName;
    } else {
      // Single-server mode: try every connected server in insertion order
      for (const server of servers.values()) {
        if (!server.connected) continue;
        const hasTool = server.tools.some((t) => t.name === toolName);
        if (hasTool) {
          debug(`Routing "${toolName}" → ${server.name}`);
          return server.client.callTool({ name: toolName, arguments: args });
        }
      }
      throw new Error(`Tool "${toolName}" not found on any connected server`);
    }

    const server = servers.get(serverName);
    if (!server || !server.connected) {
      throw new Error(
        `Server "${serverName}" not found or not connected (tool: "${toolName}")`
      );
    }

    debug(`Routing "${originalToolName}" → ${serverName}`);
    return server.client.callTool({ name: originalToolName, arguments: args });
  }

  async function routeResourceRead(uri: string): Promise<unknown> {
    for (const server of servers.values()) {
      if (!server.connected) continue;
      try {
        const result = await server.client.readResource({ uri });
        debug(`Resource "${uri}" served by ${server.name}`);
        return result;
      } catch {
        // Try next server
      }
    }
    throw new Error(`Resource "${uri}" not found on any connected server`);
  }

  async function shutdown(): Promise<void> {
    const entries = [...servers.entries()].filter(([, s]) => s.connected);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async ([name, server]) => {
        await server.client.close();
        debug(`Closed ${name}`);
      })
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      error(`${failed.length} server(s) failed to close cleanly`);
    } else {
      info(`All servers shut down`);
    }
  }

  return { servers, connectAll, getMergedTools, routeToolCall, routeResourceRead, shutdown };
}

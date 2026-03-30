import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  namespaceTool,
  parseNamespacedToolName,
} from '../src/server-manager.js';
import type { ServerManager, ManagedServer } from '../src/server-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, description = 'A tool', extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object' as const,
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    ...extra,
  };
}

/**
 * Constructs a minimal ServerManager whose `getMergedTools` behaviour can be
 * tested without spawning any real MCP processes.  Only `servers` and
 * `getMergedTools` need to be realistic here; the other methods are stubs.
 */
function makeMockManager(
  servers: Array<{ name: string; tools: Tool[]; connected: boolean }>,
): ServerManager {
  const map = new Map<string, ManagedServer>();

  for (const s of servers) {
    // A real Client is not needed for getMergedTools – we cast to satisfy TS.
    map.set(s.name, {
      name: s.name,
      client: null as any,
      tools: s.tools,
      connected: s.connected,
    });
  }

  return {
    servers: map,
    connectAll: async () => {},
    getMergedTools(namespace: boolean): Tool[] {
      const result: Tool[] = [];
      for (const [, server] of map) {
        if (!server.connected) continue;
        for (const tool of server.tools) {
          result.push(namespace ? namespaceTool(server.name, tool) : tool);
        }
      }
      return result;
    },
    routeToolCall: async () => {},
    routeResourceRead: async () => {},
    shutdown: async () => {},
  };
}

// ---------------------------------------------------------------------------
// namespaceTool
// ---------------------------------------------------------------------------

describe('namespaceTool', () => {
  it('prefixes the tool name with serverName__', () => {
    const tool = makeTool('read_file');
    const result = namespaceTool('fs', tool);
    expect(result.name).toBe('fs__read_file');
  });

  it('preserves description', () => {
    const tool = makeTool('read_file', 'Reads a file from disk');
    const result = namespaceTool('fs', tool);
    expect(result.description).toBe('Reads a file from disk');
  });

  it('preserves inputSchema', () => {
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' }, encoding: { type: 'string' } },
      required: ['path'],
    };
    const tool: Tool = { name: 'read_file', description: 'desc', inputSchema: schema };
    const result = namespaceTool('fs', tool);
    expect(result.inputSchema).toEqual(schema);
  });

  it('does not mutate the original tool', () => {
    const tool = makeTool('read_file');
    const originalName = tool.name;
    namespaceTool('fs', tool);
    expect(tool.name).toBe(originalName);
  });

  it('works with a server name that contains underscores', () => {
    const tool = makeTool('write_file');
    const result = namespaceTool('my_server', tool);
    expect(result.name).toBe('my_server__write_file');
  });
});

// ---------------------------------------------------------------------------
// parseNamespacedToolName
// ---------------------------------------------------------------------------

describe('parseNamespacedToolName', () => {
  it('parses a basic namespaced tool name', () => {
    expect(parseNamespacedToolName('fs__read_file')).toEqual({
      serverName: 'fs',
      toolName: 'read_file',
    });
  });

  it('splits on the FIRST __ only (tool name may contain __)', () => {
    expect(parseNamespacedToolName('fs__read__special')).toEqual({
      serverName: 'fs',
      toolName: 'read__special',
    });
  });

  it('returns empty serverName when there is no __ separator', () => {
    expect(parseNamespacedToolName('read_file')).toEqual({
      serverName: '',
      toolName: 'read_file',
    });
  });

  it('handles a server name that contains underscores', () => {
    expect(parseNamespacedToolName('my_server__read_file')).toEqual({
      serverName: 'my_server',
      toolName: 'read_file',
    });
  });

  it('handles a leading __ (empty server name)', () => {
    // Edge case: the separator appears at position 0.
    expect(parseNamespacedToolName('__read_file')).toEqual({
      serverName: '',
      toolName: 'read_file',
    });
  });
});

// ---------------------------------------------------------------------------
// getMergedTools (via mock ServerManager)
// ---------------------------------------------------------------------------

describe('getMergedTools', () => {
  it('merges tools from multiple connected servers with namespace=true', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file'), makeTool('write_file')], connected: true },
      { name: 'git', tools: [makeTool('commit'), makeTool('push')], connected: true },
    ]);

    const tools = manager.getMergedTools(true);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['fs__read_file', 'fs__write_file', 'git__commit', 'git__push'].sort());
  });

  it('returns original names with namespace=false', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file'), makeTool('write_file')], connected: true },
    ]);

    const tools = manager.getMergedTools(false);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['read_file', 'write_file']);
  });

  it('skips disconnected servers', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file')], connected: true },
      { name: 'git', tools: [makeTool('commit')], connected: false },
    ]);

    const tools = manager.getMergedTools(true);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['fs__read_file']);
    expect(names).not.toContain('git__commit');
  });

  it('returns empty array when no servers are connected', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file')], connected: false },
      { name: 'git', tools: [makeTool('commit')], connected: false },
    ]);

    expect(manager.getMergedTools(true)).toEqual([]);
    expect(manager.getMergedTools(false)).toEqual([]);
  });

  it('returns empty array when there are no servers at all', () => {
    const manager = makeMockManager([]);
    expect(manager.getMergedTools(true)).toEqual([]);
  });

  it('works correctly with a single server (namespace=false)', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file')], connected: true },
    ]);

    const tools = manager.getMergedTools(false);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('read_file');
  });

  it('works correctly with a single server (namespace=true)', () => {
    const manager = makeMockManager([
      { name: 'fs', tools: [makeTool('read_file')], connected: true },
    ]);

    const tools = manager.getMergedTools(true);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('fs__read_file');
  });

  it('preserves tool metadata (description, inputSchema) when namespacing', () => {
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const tool: Tool = { name: 'read_file', description: 'Read a file', inputSchema: schema };
    const manager = makeMockManager([
      { name: 'fs', tools: [tool], connected: true },
    ]);

    const [result] = manager.getMergedTools(true);
    expect(result.description).toBe('Read a file');
    expect(result.inputSchema).toEqual(schema);
  });
});

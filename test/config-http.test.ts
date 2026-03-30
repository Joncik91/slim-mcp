import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';

// Collect temp files created during tests so we can clean them up
const tempFiles: string[] = [];

function writeTempConfig(name: string, content: unknown): string {
  const filePath = join(os.tmpdir(), name);
  writeFileSync(filePath, JSON.stringify(content), 'utf8');
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    if (existsSync(f)) unlinkSync(f);
  }
});

// ---------------------------------------------------------------------------
// URL-based server configs (HTTP/SSE)
// ---------------------------------------------------------------------------
describe('loadConfig — URL-based (HTTP/SSE) servers', () => {
  it('accepts a server with url only (no type)', () => {
    const filePath = writeTempConfig('slim-mcp-http-url-only.json', {
      servers: {
        remote: { url: 'http://localhost:8080/mcp' },
      },
    });
    const config = loadConfig(filePath);
    expect(config).not.toBeNull();
    expect(config!.servers.remote.url).toBe('http://localhost:8080/mcp');
    expect(config!.servers.remote.type).toBeUndefined();
    // Should not have stdio fields
    expect(config!.servers.remote.command).toBeUndefined();
    expect(config!.servers.remote.args).toBeUndefined();
  });

  it('accepts a server with url and type "http"', () => {
    const filePath = writeTempConfig('slim-mcp-http-typed.json', {
      servers: {
        api: { url: 'https://api.example.com/mcp', type: 'http' },
      },
    });
    const config = loadConfig(filePath);
    expect(config!.servers.api.url).toBe('https://api.example.com/mcp');
    expect(config!.servers.api.type).toBe('http');
  });

  it('accepts a server with url and type "sse"', () => {
    const filePath = writeTempConfig('slim-mcp-sse-typed.json', {
      servers: {
        stream: { url: 'http://localhost:9090/sse', type: 'sse' },
      },
    });
    const config = loadConfig(filePath);
    expect(config!.servers.stream.url).toBe('http://localhost:9090/sse');
    expect(config!.servers.stream.type).toBe('sse');
  });

  it('accepts a server with url and headers (with env expansion)', () => {
    const origKey = process.env.MCP_TEST_API_KEY;
    process.env.MCP_TEST_API_KEY = 'secret-key-123';

    try {
      const filePath = writeTempConfig('slim-mcp-http-headers.json', {
        servers: {
          authed: {
            url: 'https://api.example.com/mcp',
            type: 'http',
            headers: {
              Authorization: 'Bearer ${MCP_TEST_API_KEY}',
              'X-Static': 'plain-value',
            },
          },
        },
      });
      const config = loadConfig(filePath);
      expect(config!.servers.authed.headers).toBeDefined();
      expect(config!.servers.authed.headers!.Authorization).toBe('Bearer secret-key-123');
      expect(config!.servers.authed.headers!['X-Static']).toBe('plain-value');
    } finally {
      if (origKey === undefined) delete process.env.MCP_TEST_API_KEY;
      else process.env.MCP_TEST_API_KEY = origKey;
    }
  });

  it('throws when type is invalid (not "http" or "sse")', () => {
    const filePath = writeTempConfig('slim-mcp-http-bad-type.json', {
      servers: {
        bad: { url: 'http://localhost:8080', type: 'websocket' },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/type must be "http" or "sse"/);
  });
});

// ---------------------------------------------------------------------------
// Validation: command vs url constraints
// ---------------------------------------------------------------------------
describe('loadConfig — command/url validation', () => {
  it('throws when server has neither command nor url', () => {
    const filePath = writeTempConfig('slim-mcp-neither.json', {
      servers: {
        empty: { args: ['--foo'] },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/must have either/);
  });

  it('throws when server has both command and url', () => {
    const filePath = writeTempConfig('slim-mcp-both.json', {
      servers: {
        conflict: {
          command: 'node',
          url: 'http://localhost:8080',
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/cannot have both/);
  });

  it('throws when server has type but no url', () => {
    const filePath = writeTempConfig('slim-mcp-type-no-url.json', {
      servers: {
        broken: { command: 'node', type: 'http' },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/has "type" but no "url"/);
  });

  it('throws when server has headers but no url', () => {
    const filePath = writeTempConfig('slim-mcp-headers-no-url.json', {
      servers: {
        broken: { command: 'node', headers: { 'X-Key': 'val' } },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/has "headers" but no "url"/);
  });
});

// ---------------------------------------------------------------------------
// Mixed configs: stdio + HTTP in the same file
// ---------------------------------------------------------------------------
describe('loadConfig — mixed stdio and HTTP servers', () => {
  it('handles a mix of stdio and HTTP servers in the same config', () => {
    const filePath = writeTempConfig('slim-mcp-mixed.json', {
      servers: {
        local: { command: 'npx', args: ['some-mcp-server'] },
        remote: { url: 'https://api.example.com/mcp', type: 'http' },
        legacy: { url: 'http://old.example.com/sse', type: 'sse' },
      },
    });
    const config = loadConfig(filePath);
    expect(Object.keys(config!.servers)).toHaveLength(3);

    // Stdio server
    expect(config!.servers.local.command).toBe('npx');
    expect(config!.servers.local.args).toEqual(['some-mcp-server']);
    expect(config!.servers.local.url).toBeUndefined();

    // HTTP server
    expect(config!.servers.remote.url).toBe('https://api.example.com/mcp');
    expect(config!.servers.remote.type).toBe('http');
    expect(config!.servers.remote.command).toBeUndefined();

    // SSE server
    expect(config!.servers.legacy.url).toBe('http://old.example.com/sse');
    expect(config!.servers.legacy.type).toBe('sse');
  });

  it('command-based server still works unchanged (regression)', () => {
    const filePath = writeTempConfig('slim-mcp-regression.json', {
      servers: {
        fs: {
          command: 'node',
          args: ['./server.js', '--verbose'],
          env: { NODE_ENV: 'production' },
          cache_ttl: 300,
        },
      },
      compression: 'aggressive',
      max_tools_loaded: 15,
    });
    const config = loadConfig(filePath);
    expect(config!.servers.fs.command).toBe('node');
    expect(config!.servers.fs.args).toEqual(['./server.js', '--verbose']);
    expect(config!.servers.fs.env).toEqual({ NODE_ENV: 'production' });
    expect(config!.servers.fs.cache_ttl).toBe(300);
    expect(config!.compression).toBe('aggressive');
    expect(config!.max_tools_loaded).toBe(15);
  });
});

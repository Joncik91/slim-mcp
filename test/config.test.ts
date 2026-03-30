import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig, expandEnvVars } from '../src/config.js';

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
// Minimal valid config fixture
// ---------------------------------------------------------------------------
const minimalConfig = {
  servers: {
    myServer: { command: 'npx', args: ['some-mcp-server'] },
  },
};

// ---------------------------------------------------------------------------
// loadConfig — explicit path
// ---------------------------------------------------------------------------
describe('loadConfig with explicit path', () => {
  it('parses a valid config file correctly', () => {
    const filePath = writeTempConfig('slim-mcp-valid.json', {
      servers: {
        fs: { command: 'node', args: ['./server.js'], cache_ttl: 300 },
        git: { command: 'git-mcp', args: [] },
      },
      compression: 'aggressive',
      max_tools_loaded: 20,
    });

    const config = loadConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.compression).toBe('aggressive');
    expect(config!.max_tools_loaded).toBe(20);
    expect(Object.keys(config!.servers)).toHaveLength(2);
    expect(config!.servers.fs.command).toBe('node');
    expect(config!.servers.fs.args).toEqual(['./server.js']);
    expect(config!.servers.fs.cache_ttl).toBe(300);
    expect(config!.servers.git.command).toBe('git-mcp');
  });

  it('throws when the explicit path does not exist', () => {
    expect(() => loadConfig('/tmp/does-not-exist-slim-mcp.json')).toThrow(
      /Config file not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// loadConfig — auto-discovery
// ---------------------------------------------------------------------------
describe('loadConfig auto-discovery', () => {
  it('returns null when no config file is found', () => {
    // Neither cwd nor homedir has .slim-mcp.json during tests (we never create one)
    // We rely on the test environment not having the file; guard just in case.
    const cwdCandidate = join(process.cwd(), '.slim-mcp.json');
    const homeCandidate = join(os.homedir(), '.slim-mcp.json');
    if (existsSync(cwdCandidate) || existsSync(homeCandidate)) {
      // Cannot reliably test absence — skip
      return;
    }
    expect(loadConfig()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------
describe('loadConfig validation', () => {
  it('throws when "servers" field is missing', () => {
    const filePath = writeTempConfig('slim-mcp-no-servers.json', {
      compression: 'none',
    });
    expect(() => loadConfig(filePath)).toThrow(/missing required field "servers"/);
  });

  it('throws when "servers" is not an object', () => {
    const filePath = writeTempConfig('slim-mcp-servers-array.json', {
      servers: ['oops'],
    });
    expect(() => loadConfig(filePath)).toThrow(/"servers" must be an object/);
  });

  it('throws when "servers" object is empty', () => {
    const filePath = writeTempConfig('slim-mcp-empty-servers.json', {
      servers: {},
    });
    expect(() => loadConfig(filePath)).toThrow(/"servers" must have at least one entry/);
  });

  it('throws when a server is missing "command"', () => {
    const filePath = writeTempConfig('slim-mcp-no-command.json', {
      servers: {
        broken: { args: ['--foo'] },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/server "broken".*"command"/);
  });

  it('throws when "command" is not a string', () => {
    const filePath = writeTempConfig('slim-mcp-bad-command.json', {
      servers: {
        bad: { command: 42 },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/server "bad".*"command"/);
  });

  it('throws on invalid JSON', () => {
    const filePath = join(os.tmpdir(), 'slim-mcp-bad-json.json');
    writeFileSync(filePath, '{ not: valid json }', 'utf8');
    tempFiles.push(filePath);
    expect(() => loadConfig(filePath)).toThrow(/invalid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------
describe('loadConfig defaults', () => {
  it('sets compression to "standard" when not specified', () => {
    const filePath = writeTempConfig('slim-mcp-defaults.json', minimalConfig);
    const config = loadConfig(filePath);
    expect(config!.compression).toBe('standard');
  });

  it('sets args to [] when not specified on a server', () => {
    const filePath = writeTempConfig('slim-mcp-no-args.json', {
      servers: { s: { command: 'cmd' } },
    });
    const config = loadConfig(filePath);
    expect(config!.servers.s.args).toEqual([]);
  });

  it('does not set max_tools_loaded when absent', () => {
    const filePath = writeTempConfig('slim-mcp-no-max.json', minimalConfig);
    const config = loadConfig(filePath);
    expect(config!.max_tools_loaded).toBeUndefined();
  });

  it('preserves max_tools_loaded when specified', () => {
    const filePath = writeTempConfig('slim-mcp-with-max.json', {
      ...minimalConfig,
      max_tools_loaded: 10,
    });
    const config = loadConfig(filePath);
    expect(config!.max_tools_loaded).toBe(10);
  });

  it('preserves explicit args array from the file', () => {
    const filePath = writeTempConfig('slim-mcp-with-args.json', {
      servers: { s: { command: 'node', args: ['--foo', '--bar'] } },
    });
    const config = loadConfig(filePath);
    expect(config!.servers.s.args).toEqual(['--foo', '--bar']);
  });
});

// ---------------------------------------------------------------------------
// expandEnvVars
// ---------------------------------------------------------------------------
describe('expandEnvVars', () => {
  const ORIG = process.env.MCP_TEST_VAR;
  const ORIG2 = process.env.MCP_TEST_VAR2;

  beforeEach(() => {
    process.env.MCP_TEST_VAR = 'hello';
    process.env.MCP_TEST_VAR2 = 'world';
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.MCP_TEST_VAR;
    else process.env.MCP_TEST_VAR = ORIG;

    if (ORIG2 === undefined) delete process.env.MCP_TEST_VAR2;
    else process.env.MCP_TEST_VAR2 = ORIG2;
  });

  it('replaces a known env var placeholder', () => {
    const result = expandEnvVars({ KEY: '${MCP_TEST_VAR}' });
    expect(result.KEY).toBe('hello');
  });

  it('leaves unknown var placeholder as-is', () => {
    delete process.env.MCP_DEFINITELY_UNSET_VAR;
    const result = expandEnvVars({ KEY: '${MCP_DEFINITELY_UNSET_VAR}' });
    expect(result.KEY).toBe('${MCP_DEFINITELY_UNSET_VAR}');
  });

  it('replaces multiple placeholders in one value', () => {
    const result = expandEnvVars({ KEY: '${MCP_TEST_VAR} ${MCP_TEST_VAR2}' });
    expect(result.KEY).toBe('hello world');
  });

  it('handles a mix of known and unknown vars in one value', () => {
    delete process.env.MCP_DEFINITELY_UNSET_VAR;
    const result = expandEnvVars({ KEY: '${MCP_TEST_VAR}-${MCP_DEFINITELY_UNSET_VAR}' });
    expect(result.KEY).toBe('hello-${MCP_DEFINITELY_UNSET_VAR}');
  });

  it('does not modify values without placeholders', () => {
    const result = expandEnvVars({ KEY: 'plain-value' });
    expect(result.KEY).toBe('plain-value');
  });

  it('applies expansion during loadConfig for server env fields', () => {
    process.env.MCP_TEST_VAR = 'expanded';
    const filePath = writeTempConfig('slim-mcp-env-expand.json', {
      servers: {
        s: {
          command: 'cmd',
          env: { MY_VAR: '${MCP_TEST_VAR}' },
        },
      },
    });
    const config = loadConfig(filePath);
    expect(config!.servers.s.env!.MY_VAR).toBe('expanded');
  });
});

// ---------------------------------------------------------------------------
// loadConfig cache section
// ---------------------------------------------------------------------------
describe('loadConfig cache section', () => {
  it('parses cache section with all fields', () => {
    const filePath = writeTempConfig('slim-mcp-cache-all.json', {
      servers: { s: { command: 'cmd' } },
      cache: {
        enabled: true,
        default_ttl: 120,
        max_entries: 500,
        tool_ttls: { read_file: 30 },
        server_ttls: { fs: 60 },
        never_cache: ['my_tool'],
      },
    });
    const config = loadConfig(filePath);
    expect(config!.cache).toBeDefined();
    expect(config!.cache!.enabled).toBe(true);
    expect(config!.cache!.default_ttl).toBe(120);
    expect(config!.cache!.max_entries).toBe(500);
    expect(config!.cache!.tool_ttls).toEqual({ read_file: 30 });
    expect(config!.cache!.server_ttls).toEqual({ fs: 60 });
    expect(config!.cache!.never_cache).toEqual(['my_tool']);
  });

  it('defaults cache.enabled to true when not specified', () => {
    const filePath = writeTempConfig('slim-mcp-cache-empty.json', {
      servers: { s: { command: 'cmd' } },
      cache: {},
    });
    const config = loadConfig(filePath);
    expect(config!.cache!.enabled).toBe(true);
  });

  it('defaults cache.default_ttl to 60', () => {
    const filePath = writeTempConfig('slim-mcp-cache-ttl-default.json', {
      servers: { s: { command: 'cmd' } },
      cache: {},
    });
    const config = loadConfig(filePath);
    expect(config!.cache!.default_ttl).toBe(60);
  });

  it('defaults cache.max_entries to 1000', () => {
    const filePath = writeTempConfig('slim-mcp-cache-max-default.json', {
      servers: { s: { command: 'cmd' } },
      cache: {},
    });
    const config = loadConfig(filePath);
    expect(config!.cache!.max_entries).toBe(1000);
  });

  it('cache is undefined when not in config', () => {
    const filePath = writeTempConfig('slim-mcp-no-cache.json', {
      servers: { s: { command: 'cmd' } },
    });
    const config = loadConfig(filePath);
    expect(config!.cache).toBeUndefined();
  });

  it('extracts per-server cache_ttl into server_ttls', () => {
    const filePath = writeTempConfig('slim-mcp-server-ttl.json', {
      servers: {
        fs: { command: 'x', cache_ttl: 30 },
        git: { command: 'y', cache_ttl: 15 },
      },
    });
    const config = loadConfig(filePath);
    expect(config!.cache).toBeDefined();
    expect(config!.cache!.server_ttls).toEqual({ fs: 30, git: 15 });
  });

  it('merges per-server cache_ttl with explicit cache section', () => {
    const filePath = writeTempConfig('slim-mcp-cache-merge.json', {
      servers: {
        fs: { command: 'x', cache_ttl: 30 },
      },
      cache: {
        default_ttl: 90,
        server_ttls: { git: 15 },
      },
    });
    const config = loadConfig(filePath);
    expect(config!.cache!.default_ttl).toBe(90);
    expect(config!.cache!.server_ttls).toEqual({ git: 15, fs: 30 });
  });

  it('cache.enabled=false is preserved', () => {
    const filePath = writeTempConfig('slim-mcp-cache-disabled.json', {
      servers: { s: { command: 'cmd' } },
      cache: { enabled: false },
    });
    const config = loadConfig(filePath);
    expect(config!.cache!.enabled).toBe(false);
  });
});

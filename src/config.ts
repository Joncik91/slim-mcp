import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export interface ServerConfig {
  // Stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP/SSE transport
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // Common
  cache_ttl?: number;
  always_load?: string[];
}

export interface CacheConfig {
  enabled: boolean;
  default_ttl: number;
  max_entries: number;
  server_ttls?: Record<string, number>;
  tool_ttls?: Record<string, number>;
  never_cache?: string[];
}

export interface DashboardConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
}

export interface McpSlimConfig {
  servers: Record<string, ServerConfig>;
  compression: 'none' | 'standard' | 'aggressive' | 'extreme' | 'maximum';
  cache?: CacheConfig;
  max_tools_loaded?: number;
  lazy_loading?: boolean;
  dashboard?: DashboardConfig;
}

export function expandEnvVars(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    });
  }
  return result;
}

function parseConfig(raw: unknown, sourcePath: string): McpSlimConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Config at ${sourcePath}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  // Validate servers
  if (!('servers' in obj) || obj.servers === undefined) {
    throw new Error(`Config at ${sourcePath}: missing required field "servers"`);
  }
  if (typeof obj.servers !== 'object' || obj.servers === null || Array.isArray(obj.servers)) {
    throw new Error(`Config at ${sourcePath}: "servers" must be an object`);
  }
  const serversRaw = obj.servers as Record<string, unknown>;
  if (Object.keys(serversRaw).length === 0) {
    throw new Error(`Config at ${sourcePath}: "servers" must have at least one entry`);
  }

  // Validate and normalise each server
  const servers: Record<string, ServerConfig> = {};
  for (const [name, serverRaw] of Object.entries(serversRaw)) {
    if (typeof serverRaw !== 'object' || serverRaw === null || Array.isArray(serverRaw)) {
      throw new Error(`Config at ${sourcePath}: server "${name}" must be an object`);
    }
    const s = serverRaw as Record<string, unknown>;

    // Validate: must have command XOR url
    const hasCommand = typeof s.command === 'string' && s.command.length > 0;
    const hasUrl = typeof s.url === 'string' && s.url.length > 0;

    if (!hasCommand && !hasUrl) {
      throw new Error(
        `Config at ${sourcePath}: server "${name}" must have either "command" or "url"`,
      );
    }
    if (hasCommand && hasUrl) {
      throw new Error(
        `Config at ${sourcePath}: server "${name}" cannot have both "command" and "url"`,
      );
    }

    const server: ServerConfig = {};

    if (hasCommand) {
      server.command = s.command as string;
      server.args = Array.isArray(s.args) ? (s.args as string[]) : [];
      if (typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env)) {
        server.env = expandEnvVars(s.env as Record<string, string>);
      }
    }

    if (hasUrl) {
      server.url = s.url as string;
      // Validate type if present
      if (s.type !== undefined) {
        if (s.type !== 'http' && s.type !== 'sse') {
          throw new Error(
            `Config at ${sourcePath}: server "${name}" type must be "http" or "sse"`,
          );
        }
        server.type = s.type;
      }
      if (typeof s.headers === 'object' && s.headers !== null && !Array.isArray(s.headers)) {
        server.headers = expandEnvVars(s.headers as Record<string, string>);
      }
    }

    // Validate type only with url
    if (s.type !== undefined && !hasUrl) {
      throw new Error(
        `Config at ${sourcePath}: server "${name}" has "type" but no "url"`,
      );
    }

    // Validate headers only with url
    if (s.headers !== undefined && !hasUrl) {
      throw new Error(
        `Config at ${sourcePath}: server "${name}" has "headers" but no "url"`,
      );
    }

    if (typeof s.cache_ttl === 'number') {
      server.cache_ttl = s.cache_ttl;
    }
    if (Array.isArray(s.always_load)) {
      server.always_load = s.always_load as string[];
    }

    servers[name] = server;
  }

  // Validate compression
  const validCompressions = ['none', 'standard', 'aggressive', 'extreme', 'maximum'] as const;
  type Compression = (typeof validCompressions)[number];
  let compression: Compression = 'standard';
  if ('compression' in obj && obj.compression !== undefined) {
    if (!validCompressions.includes(obj.compression as Compression)) {
      throw new Error(
        `Config at ${sourcePath}: "compression" must be one of ${validCompressions.join(', ')}`,
      );
    }
    compression = obj.compression as Compression;
  }

  // Parse cache config
  let cache: CacheConfig | undefined;
  if ('cache' in obj && obj.cache !== undefined) {
    if (typeof obj.cache !== 'object' || obj.cache === null || Array.isArray(obj.cache)) {
      throw new Error(`Config at ${sourcePath}: "cache" must be an object`);
    }
    const c = obj.cache as Record<string, unknown>;
    cache = {
      enabled: c.enabled !== false, // default true
      default_ttl: typeof c.default_ttl === 'number' ? c.default_ttl : 60,
      max_entries: typeof c.max_entries === 'number' ? c.max_entries : 1000,
    };
    if (typeof c.server_ttls === 'object' && c.server_ttls !== null && !Array.isArray(c.server_ttls)) {
      cache.server_ttls = c.server_ttls as Record<string, number>;
    }
    if (typeof c.tool_ttls === 'object' && c.tool_ttls !== null && !Array.isArray(c.tool_ttls)) {
      cache.tool_ttls = c.tool_ttls as Record<string, number>;
    }
    if (Array.isArray(c.never_cache)) {
      cache.never_cache = c.never_cache as string[];
    }
  }

  // Extract per-server cache_ttl into server_ttls
  if (!cache) {
    // Check if any server has cache_ttl - if so, create a default cache config
    const hasServerTtl = Object.values(servers).some(s => s.cache_ttl !== undefined);
    if (hasServerTtl) {
      cache = { enabled: true, default_ttl: 60, max_entries: 1000 };
    }
  }
  if (cache) {
    for (const [name, srv] of Object.entries(servers)) {
      if (srv.cache_ttl !== undefined) {
        if (!cache.server_ttls) cache.server_ttls = {};
        cache.server_ttls[name] = srv.cache_ttl;
      }
    }
  }

  const config: McpSlimConfig = { servers, compression, cache };

  if (typeof obj.max_tools_loaded === 'number') {
    config.max_tools_loaded = obj.max_tools_loaded;
  }

  if (typeof obj.lazy_loading === 'boolean') {
    config.lazy_loading = obj.lazy_loading;
  }

  // Parse dashboard config
  if (typeof obj.dashboard === 'object' && obj.dashboard !== null && !Array.isArray(obj.dashboard)) {
    const d = obj.dashboard as Record<string, unknown>;
    config.dashboard = {
      enabled: d.enabled !== false,
      port: typeof d.port === 'number' ? d.port : 7333,
      host: typeof d.host === 'string' ? d.host : '0.0.0.0',
    };
  }

  return config;
}

function readAndParse(filePath: string): McpSlimConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read config file at ${filePath}: ${(err as NodeJS.ErrnoException).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config at ${filePath}: invalid JSON — ${(err as Error).message}`);
  }

  return parseConfig(raw, filePath);
}

export function loadConfig(explicitPath?: string): McpSlimConfig | null {
  if (explicitPath !== undefined) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Config file not found: ${explicitPath}`);
    }
    return readAndParse(explicitPath);
  }

  // Discovery: cwd first, then home dir
  const candidates = [
    join(process.cwd(), '.slim-mcp.json'),
    join(os.homedir(), '.slim-mcp.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readAndParse(candidate);
    }
  }

  return null;
}

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { warn } from './logger.js';

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

export const COMPRESSION_LEVELS = ['none', 'standard', 'aggressive', 'extreme', 'maximum'] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

export interface McpSlimConfig {
  servers: Record<string, ServerConfig>;
  compression: CompressionLevel;
  cache?: CacheConfig;
  max_tools_loaded?: number;
  lazy_loading?: boolean;
  dashboard?: DashboardConfig;
}

export const DEFAULT_DASHBOARD_PORT = 7333;
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_CACHE: Readonly<CacheConfig> = Object.freeze({
  enabled: true,
  default_ttl: 60,
  max_entries: 1000,
});

const TOP_LEVEL_KEYS = new Set(['servers', 'compression', 'cache', 'max_tools_loaded', 'lazy_loading', 'dashboard', '$schema']);
const SERVER_KEYS = new Set(['command', 'args', 'env', 'type', 'url', 'headers', 'cache_ttl', 'always_load']);
const CACHE_KEYS = new Set(['enabled', 'default_ttl', 'max_entries', 'server_ttls', 'tool_ttls', 'never_cache']);
const DASHBOARD_KEYS = new Set(['enabled', 'port', 'host']);

/**
 * Expand `${VAR}` and `${VAR:-default}` placeholders from process.env.
 * Unknown variables without a default are left verbatim and reported.
 */
export function expandString(value: string, onMissing?: (name: string) => void): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    if (v !== undefined) return v;
    onMissing?.(name);
    return match;
  });
}

export function expandEnvVars(env: Record<string, string>, onMissing?: (name: string) => void): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = expandString(value, onMissing);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Explicit `null` means "not set", as it did before validation was strict. */
function withoutNulls(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null));
}

class ConfigValidator {
  constructor(readonly source: string) {}

  fail(msg: string): never {
    throw new Error(`Config at ${this.source}: ${msg}`);
  }

  warnUnknown(obj: Obj, allowed: Set<string>, where: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) warn(`Config at ${this.source}: unknown key "${key}" in ${where} (ignored)`);
    }
  }

  stringArray(v: unknown, what: string): string[] {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) this.fail(`${what} must be an array of strings`);
    return v as string[];
  }

  stringRecord(v: unknown, what: string): Record<string, string> {
    if (!isPlainObject(v)) this.fail(`${what} must be an object`);
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string') this.fail(`${what}.${k} must be a string`);
    }
    return v as Record<string, string>;
  }

  nonNegInt(v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) this.fail(`${what} must be a non-negative integer`);
    return v;
  }

  nonNegNumber(v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) this.fail(`${what} must be a non-negative number`);
    return v;
  }

  numberRecord(v: unknown, what: string): Record<string, number> {
    if (!isPlainObject(v)) this.fail(`${what} must be an object`);
    for (const [k, val] of Object.entries(v)) this.nonNegNumber(val, `${what}.${k}`);
    return v as Record<string, number>;
  }

  boolean(v: unknown, what: string): boolean {
    if (typeof v !== 'boolean') this.fail(`${what} must be a boolean`);
    return v;
  }
}

function parseServer(name: string, input: unknown, v: ConfigValidator): ServerConfig {
  if (!isPlainObject(input)) v.fail(`server "${name}" must be an object`);
  const raw = withoutNulls(input);
  if (name.length === 0) v.fail('server names must be non-empty');
  if (name.includes('__')) v.fail(`server "${name}": name must not contain "__" (used as the namespace separator)`);
  v.warnUnknown(raw, SERVER_KEYS, `server "${name}"`);

  const s = raw;
  const onMissing = (envVar: string) =>
    warn(`Config at ${v.source}: server "${name}" references unset variable \${${envVar}}`);

  const hasCommand = typeof s.command === 'string' && s.command.length > 0;
  const hasUrl = typeof s.url === 'string' && s.url.length > 0;

  if (!hasCommand && !hasUrl) v.fail(`server "${name}" must have either "command" or "url"`);
  if (hasCommand && hasUrl) v.fail(`server "${name}" cannot have both "command" and "url"`);
  if (s.type !== undefined && !hasUrl) v.fail(`server "${name}" has "type" but no "url"`);
  if (s.headers !== undefined && !hasUrl) v.fail(`server "${name}" has "headers" but no "url"`);

  const server: ServerConfig = {};

  if (hasCommand) {
    server.command = expandString(s.command as string, onMissing);
    server.args = s.args === undefined ? [] : v.stringArray(s.args, `server "${name}" "args"`).map((a) => expandString(a, onMissing));
    if (s.env !== undefined) {
      server.env = expandEnvVars(v.stringRecord(s.env, `server "${name}" "env"`), onMissing);
    }
  } else {
    const url = expandString(s.url as string, onMissing);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      v.fail(`server "${name}" has invalid "url": ${url}`);
    }
    server.url = url;
    if (s.type !== undefined) {
      if (s.type !== 'http' && s.type !== 'sse') v.fail(`server "${name}" type must be "http" or "sse"`);
      server.type = s.type;
    }
    if (s.headers !== undefined) {
      server.headers = expandEnvVars(v.stringRecord(s.headers, `server "${name}" "headers"`), onMissing);
    }
  }

  if (s.cache_ttl !== undefined) server.cache_ttl = v.nonNegNumber(s.cache_ttl, `server "${name}" "cache_ttl"`);
  if (s.always_load !== undefined) server.always_load = v.stringArray(s.always_load, `server "${name}" "always_load"`);

  return server;
}

function parseCache(input: unknown, v: ConfigValidator): CacheConfig {
  if (!isPlainObject(input)) v.fail('"cache" must be an object');
  const raw = withoutNulls(input);
  v.warnUnknown(raw, CACHE_KEYS, '"cache"');
  const cache: CacheConfig = {
    enabled: raw.enabled === undefined ? true : v.boolean(raw.enabled, '"cache.enabled"'),
    default_ttl: raw.default_ttl === undefined ? DEFAULT_CACHE.default_ttl : v.nonNegNumber(raw.default_ttl, '"cache.default_ttl"'),
    max_entries: raw.max_entries === undefined ? DEFAULT_CACHE.max_entries : v.nonNegInt(raw.max_entries, '"cache.max_entries"'),
  };
  if (raw.server_ttls !== undefined) cache.server_ttls = { ...v.numberRecord(raw.server_ttls, '"cache.server_ttls"') };
  if (raw.tool_ttls !== undefined) cache.tool_ttls = { ...v.numberRecord(raw.tool_ttls, '"cache.tool_ttls"') };
  if (raw.never_cache !== undefined) {
    cache.never_cache = v.stringArray(raw.never_cache, '"cache.never_cache"');
    for (const p of cache.never_cache) {
      try {
        new RegExp(p, 'i');
      } catch {
        v.fail(`"cache.never_cache" contains an invalid regex: ${p}`);
      }
    }
  }
  return cache;
}

function parseDashboard(input: unknown, v: ConfigValidator): DashboardConfig {
  if (!isPlainObject(input)) v.fail('"dashboard" must be an object');
  const raw = withoutNulls(input);
  v.warnUnknown(raw, DASHBOARD_KEYS, '"dashboard"');
  const port = raw.port === undefined ? DEFAULT_DASHBOARD_PORT : v.nonNegInt(raw.port, '"dashboard.port"');
  if (port < 1 || port > 65535) v.fail('"dashboard.port" must be between 1 and 65535');
  if (raw.host !== undefined && (typeof raw.host !== 'string' || raw.host.length === 0)) {
    v.fail('"dashboard.host" must be a non-empty string');
  }
  return {
    enabled: raw.enabled === undefined ? true : v.boolean(raw.enabled, '"dashboard.enabled"'),
    port,
    host: (raw.host as string | undefined) ?? DEFAULT_DASHBOARD_HOST,
  };
}

export function parseConfig(input: unknown, sourcePath: string): McpSlimConfig {
  const v: ConfigValidator = new ConfigValidator(sourcePath);
  if (!isPlainObject(input)) v.fail('must be a JSON object');
  const raw = withoutNulls(input);
  v.warnUnknown(raw, TOP_LEVEL_KEYS, 'top level');

  if (raw.servers === undefined) v.fail('missing required field "servers"');
  if (!isPlainObject(raw.servers)) v.fail('"servers" must be an object');
  const serverEntries = Object.entries(raw.servers);
  if (serverEntries.length === 0) v.fail('"servers" must have at least one entry');

  const servers: Record<string, ServerConfig> = {};
  for (const [name, serverRaw] of serverEntries) {
    servers[name] = parseServer(name, serverRaw, v);
  }

  let compression: CompressionLevel = 'standard';
  if (raw.compression !== undefined) {
    if (!COMPRESSION_LEVELS.includes(raw.compression as CompressionLevel)) {
      v.fail(`"compression" must be one of ${COMPRESSION_LEVELS.join(', ')}`);
    }
    compression = raw.compression as CompressionLevel;
  }

  let cache = raw.cache === undefined ? undefined : parseCache(raw.cache, v);

  // Per-server cache_ttl folds into server_ttls (and implies a cache section)
  const serverTtls = Object.entries(servers).filter(([, s]) => s.cache_ttl !== undefined);
  if (serverTtls.length > 0) {
    cache ??= { ...DEFAULT_CACHE };
    cache.server_ttls ??= {};
    for (const [name, srv] of serverTtls) cache.server_ttls[name] = srv.cache_ttl!;
  }

  const config: McpSlimConfig = { servers, compression, cache };

  if (raw.max_tools_loaded !== undefined) {
    config.max_tools_loaded = v.nonNegInt(raw.max_tools_loaded, '"max_tools_loaded"');
  }
  if (raw.lazy_loading !== undefined) {
    config.lazy_loading = v.boolean(raw.lazy_loading, '"lazy_loading"');
  }
  if (raw.dashboard !== undefined) {
    config.dashboard = parseDashboard(raw.dashboard, v);
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
    raw = JSON.parse(text.replace(/^﻿/, ''));
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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseConfig, expandString } from '../src/config.js';

const SRC = 'test.json';

describe('config validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects server names containing the namespace separator', () => {
    expect(() => parseConfig({ servers: { 'a__b': { command: 'x' } } }, SRC)).toThrow(/must not contain "__"/);
  });

  it('rejects non-string args and env values with a clear message', () => {
    expect(() => parseConfig({ servers: { a: { command: 'x', args: ['ok', 3] } } }, SRC)).toThrow(/"args" must be an array of strings/);
    expect(() => parseConfig({ servers: { a: { command: 'x', env: { N: 1 } } } }, SRC)).toThrow(/"env"\.N must be a string/);
  });

  it('rejects negative or fractional numbers', () => {
    expect(() => parseConfig({ servers: { a: { command: 'x' } }, max_tools_loaded: -1 }, SRC)).toThrow(/max_tools_loaded/);
    expect(() => parseConfig({ servers: { a: { command: 'x' } }, cache: { max_entries: 1.5 } }, SRC)).toThrow(/max_entries/);
    expect(() => parseConfig({ servers: { a: { command: 'x', cache_ttl: -5 } } }, SRC)).toThrow(/cache_ttl/);
  });

  it('rejects invalid never_cache regexes at load time', () => {
    expect(() => parseConfig({ servers: { a: { command: 'x' } }, cache: { never_cache: ['('] } }, SRC)).toThrow(/invalid regex/);
  });

  it('rejects non-http URLs', () => {
    expect(() => parseConfig({ servers: { a: { url: 'ftp://x' } } }, SRC)).toThrow(/invalid "url"/);
  });

  it('rejects wrongly typed booleans instead of silently ignoring them', () => {
    expect(() => parseConfig({ servers: { a: { command: 'x' } }, lazy_loading: 'no' }, SRC)).toThrow(/lazy_loading/);
  });

  it('defaults the dashboard to loopback', () => {
    const cfg = parseConfig({ servers: { a: { command: 'x' } }, dashboard: {} }, SRC);
    expect(cfg.dashboard).toEqual({ enabled: true, port: 7333, host: '127.0.0.1' });
  });

  it('warns about unknown keys (typos) without failing', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    parseConfig({ servers: { a: { command: 'x', comand: 'y' } }, compresion: 'none' }, SRC);
    const out = spy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('unknown key "compresion"');
    expect(out).toContain('unknown key "comand"');
  });

  it('expands variables in command, args and url too', () => {
    process.env.SLIM_TEST_BIN = 'mybin';
    const cfg = parseConfig({ servers: { a: { command: '${SLIM_TEST_BIN}', args: ['--x=${SLIM_TEST_BIN}'] } } }, SRC);
    expect(cfg.servers.a.command).toBe('mybin');
    expect(cfg.servers.a.args).toEqual(['--x=mybin']);
    delete process.env.SLIM_TEST_BIN;
  });

  it('does not mutate shared defaults when folding per-server cache_ttl', () => {
    const a = parseConfig({ servers: { a: { command: 'x', cache_ttl: 5 } } }, SRC);
    const b = parseConfig({ servers: { b: { command: 'x' } }, cache: {} }, SRC);
    expect(a.cache!.server_ttls).toEqual({ a: 5 });
    expect(b.cache!.server_ttls).toBeUndefined();
  });
});

describe('expandString', () => {
  it('supports ${VAR:-default}', () => {
    delete process.env.SLIM_UNSET;
    expect(expandString('${SLIM_UNSET:-fallback}')).toBe('fallback');
    process.env.SLIM_SET = 'v';
    expect(expandString('${SLIM_SET:-fallback}')).toBe('v');
    process.env.SLIM_EMPTY = '';
    expect(expandString('${SLIM_EMPTY:-fallback}')).toBe('fallback');
    expect(expandString('${SLIM_EMPTY}')).toBe('');
  });

  it('reports missing variables', () => {
    const missing: string[] = [];
    expect(expandString('${SLIM_NOPE}', (n) => missing.push(n))).toBe('${SLIM_NOPE}');
    expect(missing).toEqual(['SLIM_NOPE']);
  });
});

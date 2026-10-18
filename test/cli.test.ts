import { describe, it, expect } from 'vitest';
import { parseArgs, resolveDashboard, UsageError } from '../src/cli.js';

const argv = (...a: string[]) => ['node', 'slim-mcp', ...a];

describe('parseArgs', () => {
  it('passes flags after -- through to the upstream untouched', () => {
    const p = parseArgs(argv('-v', '--', 'server', '--help', '--version', '-v'));
    expect(p.verbose).toBe(true);
    expect(p.help).toBe(false);
    expect(p.version).toBe(false);
    expect(p.command).toBe('server');
    expect(p.args).toEqual(['--help', '--version', '-v']);
  });

  it('legacy positional form: everything after the command belongs to it', () => {
    const p = parseArgs(argv('node', 'server.js', '--port', '3'));
    expect(p.command).toBe('node');
    expect(p.args).toEqual(['server.js', '--port', '3']);
  });

  it('rejects unknown options instead of treating them as a command', () => {
    expect(() => parseArgs(argv('--compresion', 'none'))).toThrow(UsageError);
  });

  it('rejects a missing flag value, including when the next token is --', () => {
    expect(() => parseArgs(argv('--max-tools'))).toThrow(/requires a value/);
    expect(() => parseArgs(argv('--config', '--', 'x'))).toThrow(/requires a value/);
  });

  it('validates numeric ranges', () => {
    expect(() => parseArgs(argv('--dashboard-port', '70000'))).toThrow(UsageError);
    expect(() => parseArgs(argv('--max-tools', '-1'))).toThrow(UsageError);
    expect(parseArgs(argv('--max-tools', '0')).maxTools).toBe(0);
  });

  it('keeps everything after the first colon in a header value', () => {
    expect(parseArgs(argv('--url', 'https://x', '--header', 'Authorization: Bearer a:b')).headers)
      .toEqual({ Authorization: 'Bearer a:b' });
  });

  it('rejects an empty -- and a bad URL', () => {
    expect(() => parseArgs(argv('--'))).toThrow(UsageError);
    expect(() => parseArgs(argv('--url', 'not a url'))).toThrow(UsageError);
  });
});

describe('resolveDashboard', () => {
  const none = { noDashboard: false, dashboardPort: undefined };

  it('is on by default in multi-server mode, on loopback', () => {
    expect(resolveDashboard(none, true)).toEqual({ enabled: true, port: 7333, host: '127.0.0.1' });
  });

  it('is off by default in single-server mode, on with --dashboard-port', () => {
    expect(resolveDashboard(none, false)).toBeUndefined();
    expect(resolveDashboard({ noDashboard: false, dashboardPort: 9000 }, false)?.port).toBe(9000);
  });

  it('respects config enabled:false and --no-dashboard', () => {
    expect(resolveDashboard(none, true, { enabled: false })).toBeUndefined();
    expect(resolveDashboard({ noDashboard: true, dashboardPort: 9000 }, true)).toBeUndefined();
  });
});

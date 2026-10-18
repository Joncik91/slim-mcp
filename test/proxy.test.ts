import { describe, it, expect } from 'vitest';
import { startProxy, PendingRequests } from '../src/proxy.js';
import type { SingleServerOptions, MultiServerOptions } from '../src/proxy.js';

describe('PendingRequests', () => {
  it('returns the tracked entry once, then forgets it', () => {
    const pending = new PendingRequests();
    pending.track(1, { method: 'tools/list' });
    expect(pending.take(1)).toEqual({ method: 'tools/list' });
    expect(pending.take(1)).toBeUndefined();
    expect(pending.size).toBe(0);
  });

  it('keeps numeric and string ids distinct', () => {
    const pending = new PendingRequests();
    pending.track(1, { method: 'a' });
    pending.track('1', { method: 'b' });
    expect(pending.take('1')?.method).toBe('b');
    expect(pending.take(1)?.method).toBe('a');
  });

  it('drain empties the map (no leak after shutdown)', () => {
    const pending = new PendingRequests();
    pending.track(1, { method: 'a' });
    pending.track(2, { method: 'b' });
    expect(pending.drain()).toHaveLength(2);
    expect(pending.size).toBe(0);
  });
});

describe('startProxy export', () => {
  it('startProxy is exported and is a function', () => {
    expect(typeof startProxy).toBe('function');
  });
});

describe('option types', () => {
  it('SingleServerOptions type is usable', () => {
    const opts: SingleServerOptions = {
      mode: 'single',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      compression: 'standard',
    };
    expect(opts.mode).toBe('single');
    expect(opts.compression).toBe('standard');
  });

  it('MultiServerOptions type is usable', () => {
    const opts: MultiServerOptions = {
      mode: 'multi',
      config: {
        servers: {
          fs1: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        },
        compression: 'standard',
      },
    };
    expect(opts.mode).toBe('multi');
    expect(Object.keys(opts.config.servers)).toContain('fs1');
  });
});

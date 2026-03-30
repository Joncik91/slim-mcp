import { describe, it, expect } from 'vitest';
import { startProxy, createRequestTracker, maybeCompressResponse } from '../src/proxy.js';
import type { SingleServerOptions, MultiServerOptions } from '../src/proxy.js';

describe('request tracker', () => {
  it('tracks tools/list request IDs', () => {
    const tracker = createRequestTracker();
    tracker.trackRequest({ id: 1, method: 'tools/list' });
    expect(tracker.isToolsListResponse(1)).toBe(true);
  });

  it('does not track non-tools/list requests', () => {
    const tracker = createRequestTracker();
    tracker.trackRequest({ id: 2, method: 'tools/call' });
    expect(tracker.isToolsListResponse(2)).toBe(false);
  });

  it('cleans up after consuming', () => {
    const tracker = createRequestTracker();
    tracker.trackRequest({ id: 1, method: 'tools/list' });
    tracker.consume(1);
    expect(tracker.isToolsListResponse(1)).toBe(false);
  });
});

describe('maybeCompressResponse', () => {
  it('compresses tools/list response', () => {
    const tracker = createRequestTracker();
    tracker.trackRequest({ id: 1, method: 'tools/list' });

    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{
          name: 'read_file',
          description: 'Read a file from the filesystem.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The path', additionalProperties: false },
            },
            required: ['path'],
            additionalProperties: false,
          },
        }],
      },
    };

    const result = maybeCompressResponse(response, tracker, 'standard');
    expect(result).not.toBeNull();
    expect(result.result.tools[0].inputSchema).not.toHaveProperty('additionalProperties');
  });

  it('returns null for non-tools/list responses', () => {
    const tracker = createRequestTracker();
    const response = { jsonrpc: '2.0', id: 99, result: { capabilities: {} } };
    const result = maybeCompressResponse(response, tracker, 'standard');
    expect(result).toBeNull();
  });

  it('returns null when compression is none', () => {
    const tracker = createRequestTracker();
    tracker.trackRequest({ id: 1, method: 'tools/list' });
    const response = {
      jsonrpc: '2.0', id: 1,
      result: { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
    };
    const result = maybeCompressResponse(response, tracker, 'none');
    expect(result).toBeNull();
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

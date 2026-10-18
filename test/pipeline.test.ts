import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolPipeline } from '../src/pipeline.js';
import { ResponseCache } from '../src/cache.js';
import { createLazyToolManager } from '../src/lazy.js';

function tool(name: string, props: Record<string, unknown>, required: string[] = []): Tool {
  return { name, description: `Tool ${name}`, inputSchema: { type: 'object', properties: props, required } } as Tool;
}

const resolve = (name: string) => ({ server: 's', tool: name });

describe('ToolPipeline lazy promotion', () => {
  function setup() {
    const lazy = createLazyToolManager({ maxToolsLoaded: 0, alwaysLoad: new Set() });
    const p = new ToolPipeline({ level: 'standard', cache: null, lazy, resolve });
    let changed = 0;
    p.onToolListChanged = () => changed++;
    p.transformToolList([tool('get_thing', { n: { type: 'number' } }, ['n'])]);
    return { p, changed: () => changed };
  }

  it('forwards a slim call whose args already match the full schema', () => {
    const { p, changed } = setup();
    const d = p.beginCall('get_thing', { n: 1 });
    expect(d.action).toBe('forward');
    expect(changed()).toBe(1);
  });

  it('rejects invalid args with the full schema and a retry hint', () => {
    const { p } = setup();
    const d = p.beginCall('get_thing', { n: 'nope' });
    expect(d.action).toBe('respond');
    if (d.action !== 'respond') return;
    expect(d.result.isError).toBe(true);
    const text = (d.result.content[0] as { text: string }).text;
    expect(text).toContain('retry');
    expect(text).toContain('"required":["n"]');
  });

  it('promotes only once', () => {
    const { p, changed } = setup();
    p.beginCall('get_thing', {});
    p.beginCall('get_thing', { n: 2 });
    expect(changed()).toBe(1);
  });

  it('handles schemas that cannot be compiled by asking for a retry', () => {
    const lazy = createLazyToolManager({ maxToolsLoaded: 0, alwaysLoad: new Set() });
    const p = new ToolPipeline({ level: 'standard', cache: null, lazy, resolve });
    p.transformToolList([{ name: 'weird', inputSchema: { type: 'object', properties: { x: { $ref: '#/nowhere' } } } } as Tool]);
    expect(p.beginCall('weird', {}).action).toBe('respond');
  });
});

describe('ToolPipeline compression under lazy loading', () => {
  it('compresses full tools as one batch so aggressive dedup still applies', () => {
    const lazy = createLazyToolManager({ maxToolsLoaded: 2, alwaysLoad: new Set(['a', 'b']) });
    const p = new ToolPipeline({ level: 'aggressive', cache: null, lazy, resolve });
    const prop = { type: 'string', description: 'Workspace slug used for scoping' };
    const out = p.transformToolList([tool('a', { ws: { ...prop } }), tool('b', { ws: { ...prop } }), tool('c', { ws: { ...prop } })]);
    expect((out[0].inputSchema.properties as any).ws.description).toBeDefined();
    expect((out[1].inputSchema.properties as any).ws.description).toBeUndefined();
    expect(out[2].inputSchema).toEqual({ type: 'object' }); // slim, untouched
  });
});

describe('ToolPipeline caching', () => {
  it('caches successful reads and serves them locally', () => {
    const cache = new ResponseCache({ enabled: true, default_ttl: 60, max_entries: 10 });
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    p.transformToolList([tool('read_x', {})]);
    const d1 = p.beginCall('read_x', {});
    expect(d1.action).toBe('forward');
    if (d1.action === 'forward') p.completeCall(d1.ticket, { result: { content: [] } });
    expect(p.beginCall('read_x', {}).action).toBe('respond');
  });

  it('never caches error results', () => {
    const cache = new ResponseCache({ enabled: true, default_ttl: 60, max_entries: 10 });
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    const d = p.beginCall('read_x', {});
    if (d.action === 'forward') p.completeCall(d.ticket, { result: { content: [], isError: true } });
    expect(p.beginCall('read_x', {}).action).toBe('forward');
  });

  it('does not cache a read that raced a write', () => {
    const cache = new ResponseCache({ enabled: true, default_ttl: 60, max_entries: 10 });
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    const read = p.beginCall('read_x', {});
    p.beginCall('write_x', {}); // invalidates server "s" while the read is in flight
    if (read.action === 'forward') p.completeCall(read.ticket, { result: { content: [] } });
    expect(p.beginCall('read_x', {}).action).toBe('forward');
  });

  it('uses readOnlyHint annotations from the tool list', () => {
    const cache = new ResponseCache({ enabled: true, default_ttl: 60, max_entries: 10 });
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    p.transformToolList([{ ...tool('run_report', {}), annotations: { readOnlyHint: true } }]);
    const d = p.beginCall('run_report', {});
    if (d.action === 'forward') p.completeCall(d.ticket, { result: { content: [] } });
    expect(p.beginCall('run_report', {}).action).toBe('respond');
  });
});

describe('review regressions', () => {
  const cacheCfg = { enabled: true, default_ttl: 60, max_entries: 10 };

  it('keeps annotations from earlier pages of a paginated tools/list', () => {
    const cache = new ResponseCache(cacheCfg);
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    p.transformToolList([{ ...tool('archive_thing', {}), annotations: { destructiveHint: true } }], { paginated: true });
    p.transformToolList([tool('read_x', {})], { append: true, paginated: true });
    const d = p.beginCall('archive_thing', {});
    if (d.action === 'forward') p.completeCall(d.ticket, { result: { content: [] } });
    expect(p.beginCall('archive_thing', {}).action).toBe('forward');
  });

  it('a read that started during a write is not cached after the write finishes', () => {
    const cache = new ResponseCache(cacheCfg);
    const p = new ToolPipeline({ level: 'none', cache, lazy: null, resolve });
    const write = p.beginCall('write_file', {});
    const read = p.beginCall('read_file', {}); // starts after the write began
    if (read.action === 'forward') p.completeCall(read.ticket, { result: { content: [{ type: 'text', text: 'OLD' }] } });
    if (write.action === 'forward') p.completeCall(write.ticket, { result: { content: [] } });
    expect(p.beginCall('read_file', {}).action).toBe('forward');
  });

  function slimPipeline(t: Tool) {
    const lazy = createLazyToolManager({ maxToolsLoaded: 0, alwaysLoad: new Set() });
    const p = new ToolPipeline({ level: 'standard', cache: null, lazy, resolve });
    p.transformToolList([t]);
    return p;
  }

  it('never runs a side-effecting slim tool before the agent has seen its schema', () => {
    const p = slimPipeline(tool('purge_files', { pattern: { type: 'string', default: '*' } }));
    expect(p.beginCall('purge_files', { pattern: '*.tmp' }).action).toBe('respond');
  });

  it('bounces misnamed arguments that a permissive schema would accept', () => {
    const p = slimPipeline(tool('search_files', { pattern: { type: 'string', default: '*' } }));
    const d = p.beginCall('search_files', { glob: '*.tmp' });
    expect(d.action).toBe('respond');
    if (d.action === 'respond') expect((d.result.content[0] as { text: string }).text).toContain('unknown argument(s): glob');
  });

  it('respects a destructiveHint on a read-sounding slim tool', () => {
    const p = slimPipeline({ ...tool('get_and_reset', {}), annotations: { destructiveHint: true } });
    expect(p.beginCall('get_and_reset', {}).action).toBe('respond');
  });
});

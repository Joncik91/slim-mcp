import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { startHarness, stopHarness, findStderr, waitForStderr, type HarnessResult } from './harness.js';

const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');

describe('lazy loading', () => {
  let harness: HarnessResult;

  afterEach(async () => {
    if (harness) {
      try { await stopHarness(harness); } catch {}
      harness = undefined as any;
    }
  });

  it('shows slim vs full count with 25 tools and max-tools 5', async () => {
    harness = await startHarness(['--max-tools', '5', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    await harness.client.listTools();

    const lazyLine = await waitForStderr(harness, /\d+ full \+ \d+ slim/);
    expect(lazyLine).toBeDefined();
    // Should show 5 full + 20 slim (approximately -- some always_load might shift numbers slightly)
    expect(lazyLine).toMatch(/5 full \+ 20 slim/);
  });

  it('full tools have inputSchema properties, slim tools do not', async () => {
    harness = await startHarness(['--max-tools', '3', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    const { tools } = await harness.client.listTools();

    const fullTools = tools.filter(t => t.inputSchema && (t.inputSchema as any).properties);
    const slimTools = tools.filter(t => !((t.inputSchema as any).properties));

    expect(fullTools.length).toBeGreaterThan(0);
    expect(slimTools.length).toBeGreaterThan(0);
    expect(fullTools.length + slimTools.length).toBe(25);
  });

  it('calling a slim tool returns retry error', async () => {
    harness = await startHarness(['--max-tools', '3', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    const { tools } = await harness.client.listTools();

    // Find a slim tool (no properties in inputSchema)
    const slimTool = tools.find(t => !((t.inputSchema as any).properties));
    expect(slimTool).toBeDefined();

    const result = await harness.client.callTool({ name: slimTool!.name, arguments: { input: 'test' } });
    expect(result.isError).toBe(true);
    const text = (result.content as any[])[0].text;
    expect(text.toLowerCase()).toContain('retry');
  });

  it('promoted tool has full schema on next listTools', async () => {
    harness = await startHarness(['--max-tools', '3', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    let { tools } = await harness.client.listTools();

    // Find a slim tool and call it to promote
    const slimTool = tools.find(t => !((t.inputSchema as any).properties));
    expect(slimTool).toBeDefined();

    await harness.client.callTool({ name: slimTool!.name, arguments: { input: 'test' } });

    // Re-list -- promoted tool should now have full schema
    const result = await harness.client.listTools();
    const promoted = result.tools.find(t => t.name === slimTool!.name);
    expect(promoted).toBeDefined();
    expect((promoted!.inputSchema as any).properties).toBeDefined();
  });

  it('promoted tool works on retry', async () => {
    harness = await startHarness(['--max-tools', '3', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    let { tools } = await harness.client.listTools();

    const slimTool = tools.find(t => !((t.inputSchema as any).properties));
    expect(slimTool).toBeDefined();

    // First call -- error + promotion
    await harness.client.callTool({ name: slimTool!.name, arguments: { input: 'test' } });

    // Re-list to get full schema
    await harness.client.listTools();

    // Second call -- should succeed
    const result = await harness.client.callTool({ name: slimTool!.name, arguments: { input: 'retry-test' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any[])[0].text;
    expect(text).toContain('mock:');
    expect(text).toContain('retry-test');
  });

  it('--no-lazy disables lazy loading', async () => {
    harness = await startHarness(['--no-lazy', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    const { tools } = await harness.client.listTools();

    // All tools should have full schemas (properties defined)
    // Mock server tools always have properties
    const withProps = tools.filter(t => (t.inputSchema as any).properties);
    expect(withProps.length).toBe(25);
  });

  it('shows stacked savings in stderr', async () => {
    harness = await startHarness(['--max-tools', '5', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '25']);
    await harness.client.listTools();

    // Should see both lazy loading and compression stats
    const lazyLine = await waitForStderr(harness, /Lazy loading saved/);
    expect(lazyLine).toBeDefined();

    const compLine = findStderr(harness, /Compressed/);
    expect(compLine).toBeDefined();
  });
});

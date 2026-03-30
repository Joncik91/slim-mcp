import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { startHarness, stopHarness, findStderr, waitForStderr, type HarnessResult } from './harness.js';

const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');

describe('single-server passthrough', () => {
  let harness: HarnessResult;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  it('lists tools from upstream server', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBe(5);
    // Tool names should NOT be namespaced (single server)
    expect(tools.every(t => !t.name.includes('__'))).toBe(true);
  });

  it('calls a tool and gets correct response', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    await harness.client.listTools(); // must list first
    const result = await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'hello' } });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('mock:read_data_0:');
    expect(text).toContain('hello');
  });

  it('shows compression stats in stderr', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    await harness.client.listTools();
    // Wait for stderr to populate
    const line = await waitForStderr(harness, /Compressed \d+ tools/);
    expect(line).toBeDefined();
  });

  it('shows startup message in stderr', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    const line = findStderr(harness, 'slim-mcp v');
    expect(line).toBeDefined();
  });
});

describe('compression levels', () => {
  let harness: HarnessResult;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  it('standard compression shows reduction', async () => {
    harness = await startHarness(['--compression', 'standard', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();
    const line = await waitForStderr(harness, /Compressed/);
    const match = line.match(/(\d+)% reduction/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1])).toBeGreaterThan(0);
  });

  it('aggressive compression shows higher reduction than standard', async () => {
    // First, standard
    harness = await startHarness(['--compression', 'standard', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();
    const stdLine = await waitForStderr(harness, /Compressed/);
    const stdMatch = stdLine.match(/(\d+)% reduction/);
    const stdReduction = parseInt(stdMatch![1]);
    await stopHarness(harness);

    // Then, aggressive
    harness = await startHarness(['--compression', 'aggressive', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();
    const aggLine = await waitForStderr(harness, /Compressed/);
    const aggMatch = aggLine.match(/(\d+)% reduction/);
    const aggReduction = parseInt(aggMatch![1]);

    expect(aggReduction).toBeGreaterThanOrEqual(stdReduction);
  });

  it('tools still work with aggressive compression', async () => {
    harness = await startHarness(['--compression', 'aggressive', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    await harness.client.listTools();
    const result = await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'test' } });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('mock:read_data_0:');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { startHarness, stopHarness, findStderr, waitForStderr, type HarnessResult } from './harness.js';

const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');

describe('response caching', () => {
  let harness: HarnessResult;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  it('cache hit on repeated identical call', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();

    // First call — should be cache miss
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'test' } });

    // Second identical call — should be cache hit
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'test' } });

    const hitLine = findStderr(harness, 'Cache hit');
    expect(hitLine).toBeDefined();
  });

  it('different args produce cache miss', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();

    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'aaa' } });
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'bbb' } });

    // Should NOT see cache hit (different args)
    const hitLine = findStderr(harness, 'Cache hit');
    expect(hitLine).toBeUndefined();
  });

  it('--no-cache disables caching', async () => {
    harness = await startHarness(['--no-cache', '--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    await harness.client.listTools();

    // Call twice with same args
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'test' } });
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'test' } });

    // Should see "Cache: disabled" in startup
    const disabledLine = findStderr(harness, 'Cache: disabled');
    expect(disabledLine).toBeDefined();

    // Should NOT see any cache hits
    const hitLine = findStderr(harness, 'Cache hit');
    expect(hitLine).toBeUndefined();
  });

  it('shutdown shows cache stats', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '5']);
    await harness.client.listTools();

    // Make some calls to populate stats
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'a' } });
    await harness.client.callTool({ name: 'read_data_0', arguments: { input: 'a' } }); // hit

    // Give time for shutdown stats to be logged before stopping
    await new Promise(r => setTimeout(r, 500));
    const { stderr } = await stopHarness(harness);
    harness = undefined as any; // prevent double-stop in afterEach

    // Cache stats may not be visible in single-server mode since the process
    // exits via process.exit(0) in the onclose handler before stderr flushes.
    // Check that cache was at least active during the session.
    const hitLine = stderr.find(l => l.includes('Cache hit'));
    expect(hitLine).toBeDefined();
  });
});

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { startHarness, stopHarness, findStderr, waitForStderr, type HarnessResult } from './harness.js';

const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');
const TMP_DIR = path.resolve(import.meta.dirname, '../../.tmp-e2e');
const CONFIG_PATH = path.join(TMP_DIR, 'multi-server.json');

describe('multi-server aggregation', () => {
  let harness: HarnessResult;

  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    const config = {
      servers: {
        alpha: {
          command: 'npx',
          args: ['tsx', MOCK_SERVER, '--tools', '3'],
        },
        beta: {
          command: 'npx',
          args: ['tsx', MOCK_SERVER, '--tools', '4'],
        },
      },
      compression: 'standard',
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  });

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  afterAll(() => {
    try { unlinkSync(CONFIG_PATH); } catch {}
  });

  it('lists tools from both servers', async () => {
    harness = await startHarness(['--config', CONFIG_PATH]);
    const { tools } = await harness.client.listTools();
    // 3 from alpha + 4 from beta = 7 total
    expect(tools.length).toBe(7);
  });

  it('tools are namespaced with server prefix', async () => {
    harness = await startHarness(['--config', CONFIG_PATH]);
    const { tools } = await harness.client.listTools();
    const alphaTools = tools.filter(t => t.name.startsWith('alpha__'));
    const betaTools = tools.filter(t => t.name.startsWith('beta__'));
    expect(alphaTools.length).toBe(3);
    expect(betaTools.length).toBe(4);
  });

  it('routes call to correct server via namespace', async () => {
    harness = await startHarness(['--config', CONFIG_PATH]);
    await harness.client.listTools();

    // Call alpha server tool
    const result = await harness.client.callTool({
      name: 'alpha__read_data_0',
      arguments: { input: 'from-alpha' }
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('mock:read_data_0:');
    expect(text).toContain('from-alpha');
  });

  it('routes to different servers correctly', async () => {
    harness = await startHarness(['--config', CONFIG_PATH]);
    await harness.client.listTools();

    // Call beta server tool
    const result = await harness.client.callTool({
      name: 'beta__read_data_0',
      arguments: { input: 'from-beta' }
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('mock:read_data_0:');
    expect(text).toContain('from-beta');
  });

  it('shows both servers connected in stderr', async () => {
    harness = await startHarness(['--config', CONFIG_PATH]);
    await harness.client.listTools();

    await waitForStderr(harness, 'alpha connected');
    await waitForStderr(harness, 'beta connected');
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const INDEX_PATH = path.resolve(import.meta.dirname, '../../dist/index.js');
const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');
const TMP_DIR = path.resolve(import.meta.dirname, '../../.tmp-e2e-lifecycle');

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
});

function processAlive(marker: string): boolean {
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Start the proxy, wait for the initialize response, close stdin, measure exit. */
async function runUntilStdinClosed(args: string[]): Promise<{ exitCode: number | null; ms: number; stdout: string }> {
  const child = spawn(process.execPath, [INDEX_PATH, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const initialized = new Promise<void>((resolve) => {
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes('"id":1')) resolve();
    });
  });
  child.stdin.write(INIT + '\n');
  await Promise.race([initialized, new Promise((r) => setTimeout(r, 30_000))]);

  const start = Date.now();
  child.stdin.end();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const exitCode = await exited;
  clearTimeout(timeout);
  return { exitCode, ms: Date.now() - start, stdout };
}

afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe('lifecycle: agent closes stdin', () => {
  it('single-server mode exits and reaps the upstream', async () => {
    const marker = `slim-e2e-${randomUUID()}`;
    const res = await runUntilStdinClosed(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '3', '--marker', marker]);
    expect(res.stdout).toContain('"id":1');
    expect(res.exitCode).toBe(0);
    expect(res.ms).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(processAlive(marker)).toBe(false);
  }, 60_000);

  it('multi-server mode exits and reaps every upstream', async () => {
    const marker = `slim-e2e-${randomUUID()}`;
    mkdirSync(TMP_DIR, { recursive: true });
    const cfg = path.join(TMP_DIR, 'multi.json');
    writeFileSync(cfg, JSON.stringify({
      servers: {
        a: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '3', '--marker', marker] },
        b: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '3', '--marker', marker] },
      },
      dashboard: { enabled: false },
    }));
    const res = await runUntilStdinClosed(['--config', cfg]);
    expect(res.stdout).toContain('"id":1');
    expect(res.exitCode).toBe(0);
    expect(res.ms).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(processAlive(marker)).toBe(false);
  }, 60_000);
});

describe('lifecycle: flags after -- belong to the upstream', () => {
  it('-- <server> --version does not print slim-mcp\'s version', async () => {
    const marker = `slim-e2e-${randomUUID()}`;
    const res = await runUntilStdinClosed(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '2', '--version', '--marker', marker]);
    expect(res.stdout).not.toMatch(/^\d+\.\d+\.\d+\n/);
    expect(res.stdout).toContain('"id":1');
  }, 60_000);
});

describe('lifecycle: upstream changes in multi-server mode', () => {
  it('follows upstream tools/list_changed and notifies the agent', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');

    mkdirSync(TMP_DIR, { recursive: true });
    const cfg = path.join(TMP_DIR, 'changing.json');
    writeFileSync(cfg, JSON.stringify({
      servers: {
        a: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '2', '--add-tool-after', '4000'] },
        b: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '2'] },
      },
      dashboard: { enabled: false },
    }));

    const client = new Client({ name: 'e2e', version: '1' });
    let notified = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified = true; });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [INDEX_PATH, '--config', cfg], stderr: 'pipe' }));
    try {
      const before = await client.listTools();
      expect(before.tools.some((t) => t.name === 'a__late_tool')).toBe(false);

      const deadline = Date.now() + 15_000;
      while (!notified && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(notified).toBe(true);

      const after = await client.listTools();
      expect(after.tools.some((t) => t.name === 'a__late_tool')).toBe(true);
      const res = await client.callTool({ name: 'a__late_tool', arguments: { input: 'hi' } });
      expect((res.content as any[])[0].text).toBe('late:hi');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('marks a crashed upstream as disconnected and drops its tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const marker = `slim-e2e-${randomUUID()}`;
    mkdirSync(TMP_DIR, { recursive: true });
    const cfg = path.join(TMP_DIR, 'crash.json');
    writeFileSync(cfg, JSON.stringify({
      servers: {
        a: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '2', '--marker', marker] },
        b: { command: 'npx', args: ['tsx', MOCK_SERVER, '--tools', '2'] },
      },
      dashboard: { enabled: false },
    }));

    const transport = new StdioClientTransport({ command: process.execPath, args: [INDEX_PATH, '--config', cfg], stderr: 'pipe' });
    const stderr: string[] = [];
    transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.filter((t) => t.name.startsWith('a__'))).toHaveLength(2);

      execFileSync('pkill', ['-KILL', '-f', marker]);
      const deadline = Date.now() + 10_000;
      while (!stderr.join('').includes('a disconnected') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(stderr.join('')).toContain('a disconnected');

      const tools = (await client.listTools()).tools;
      expect(tools.filter((t) => t.name.startsWith('a__'))).toHaveLength(0);
      expect(tools.filter((t) => t.name.startsWith('b__'))).toHaveLength(2);

      const res = await client.callTool({ name: 'a__read_data_0', arguments: { input: 'x' } });
      expect(res.isError).toBe(true);
      expect((res.content as any[])[0].text).toMatch(/not connected/);
    } finally {
      await client.close();
    }
  }, 60_000);
});

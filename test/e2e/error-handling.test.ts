import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const INDEX_PATH = path.resolve(import.meta.dirname, '../../dist/index.js');
const TMP_DIR = path.resolve(import.meta.dirname, '../../.tmp-e2e');

function runMcpSlim(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on('error', () => resolve({ exitCode: null, stdout, stderr }));

    // Close stdin so the process doesn't hang waiting for input
    child.stdin.end();
  });
}

describe('error handling', () => {
  it('--help exits 0 with usage text', async () => {
    const { exitCode, stderr } = await runMcpSlim(['--help']);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('slim-mcp');
    expect(stderr).toContain('Usage');
  });

  it('no args and no config exits with usage', async () => {
    // Run from a directory without .slim-mcp.json
    const { exitCode, stderr } = await runMcpSlim([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage');
  });

  it('invalid config file (malformed JSON) shows error', async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const badConfig = path.join(TMP_DIR, 'bad-config.json');
    writeFileSync(badConfig, 'not valid json {{{');

    const { exitCode, stderr } = await runMcpSlim(['--config', badConfig]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('invalid JSON');
  });

  it('non-existent config file shows error', async () => {
    const { exitCode, stderr } = await runMcpSlim(['--config', '/tmp/does-not-exist-slim-mcp.json']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('--url with -- command shows error', async () => {
    const { exitCode, stderr } = await runMcpSlim(['--url', 'http://localhost:9999', '--', 'echo', 'hello']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Cannot use --url with');
  });

  it('invalid compression level shows error', async () => {
    const { exitCode, stderr } = await runMcpSlim(['--compression', 'turbo']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid compression level');
  });

  it('invalid --max-tools value shows error', async () => {
    const { exitCode, stderr } = await runMcpSlim(['--max-tools', 'abc']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --max-tools');
  });
});

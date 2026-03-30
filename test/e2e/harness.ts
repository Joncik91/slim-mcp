import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const INDEX_PATH = path.resolve(import.meta.dirname, '../../dist/index.js');

export interface HarnessResult {
  client: Client;
  process: ChildProcess;
  stderr: string[];
}

/**
 * Start slim-mcp with given CLI args, connect an MCP client to it.
 * Returns the client, process handle, and live stderr array.
 */
export async function startHarness(args: string[], opts?: {
  env?: Record<string, string>;
  timeout?: number;
}): Promise<HarnessResult> {
  const timeout = opts?.timeout ?? 30_000;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_PATH, ...args],
    env: { ...process.env, ...opts?.env } as Record<string, string>,
    stderr: 'pipe',
  });

  const stderr: string[] = [];
  if (transport.stderr) {
    transport.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      stderr.push(...lines);
    });
  }

  const client = new Client({ name: 'e2e-test', version: '1.0.0' });

  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Harness connection timed out after ${timeout}ms`)), timeout),
  );
  await Promise.race([connectPromise, timeoutPromise]);

  // Extract the child process from the transport's private field
  const childProcess = (transport as unknown as { _process?: ChildProcess })._process;
  if (!childProcess) {
    throw new Error('Could not access child process from transport');
  }

  return { client, process: childProcess, stderr };
}

/**
 * Stop the harness: close client, kill process, wait for exit.
 * Returns the exit code and final stderr.
 */
export async function stopHarness(harness: HarnessResult): Promise<{
  exitCode: number | null;
  stderr: string[];
}> {
  const exitPromise = new Promise<number | null>((resolve) => {
    if (harness.process.exitCode !== null) {
      resolve(harness.process.exitCode);
      return;
    }
    harness.process.once('exit', (code) => resolve(code));
  });

  await harness.client.close();

  // Give stderr a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 100));

  // If the process didn't exit after client close, force kill
  const raceResult = await Promise.race([
    exitPromise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ]);

  if (raceResult === 'timeout') {
    harness.process.kill('SIGKILL');
    await exitPromise;
  }

  const exitCode = harness.process.exitCode;
  return { exitCode, stderr: harness.stderr };
}

/**
 * Helper: find a line in stderr matching a pattern.
 */
export function findStderr(harness: HarnessResult, pattern: string | RegExp): string | undefined {
  return harness.stderr.find((line) =>
    typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line),
  );
}

/**
 * Helper: wait for a stderr line matching a pattern.
 */
export async function waitForStderr(
  harness: HarnessResult,
  pattern: string | RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const match = findStderr(harness, pattern);
  if (match) return match;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const found = findStderr(harness, pattern);
    if (found) return found;
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for stderr matching ${pattern}. ` +
    `Collected ${harness.stderr.length} lines: ${harness.stderr.slice(-5).join(' | ')}`,
  );
}

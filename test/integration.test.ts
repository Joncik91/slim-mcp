import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function sendJsonRpc(proc: ReturnType<typeof spawn>, message: object): void {
  proc.stdin!.write(JSON.stringify(message) + '\n');
}

function parseJsonRpcMessages(raw: string): any[] {
  const messages: any[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try { messages.push(JSON.parse(line)); } catch {}
  }
  return messages;
}

describe('integration: proxy with filesystem server', () => {
  it('compresses tools/list response (standard)', async () => {
    const proxy = spawn('node', [
      'dist/index.js',
      '--compression', 'standard',
      '--',
      'npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT,
    });

    let stdout = '';
    proxy.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    // Initialize
    sendJsonRpc(proxy, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    await new Promise((r) => setTimeout(r, 5000));

    // Send initialized notification
    sendJsonRpc(proxy, { jsonrpc: '2.0', method: 'notifications/initialized' });

    await new Promise((r) => setTimeout(r, 1000));

    // Request tools/list
    sendJsonRpc(proxy, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    await new Promise((r) => setTimeout(r, 4000));

    proxy.kill();
    await new Promise((r) => setTimeout(r, 500));

    const messages = parseJsonRpcMessages(stdout);
    const toolsResponse = messages.find((m) => m.id === 2);

    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result.tools).toBeDefined();
    expect(toolsResponse.result.tools.length).toBeGreaterThan(0);

    // Verify structural cleanup was applied
    for (const tool of toolsResponse.result.tools) {
      expect(tool.name).toBeTruthy();
      if (tool.inputSchema) {
        expect(tool.inputSchema).not.toHaveProperty('additionalProperties');
      }
    }
  }, 20000);

  it('passes through unchanged with --compression none', async () => {
    const proxy = spawn('node', [
      'dist/index.js',
      '--compression', 'none',
      '--',
      'npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT,
    });

    let stdout = '';
    proxy.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    sendJsonRpc(proxy, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    await new Promise((r) => setTimeout(r, 5000));

    sendJsonRpc(proxy, { jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 1000));

    sendJsonRpc(proxy, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise((r) => setTimeout(r, 4000));

    proxy.kill();
    await new Promise((r) => setTimeout(r, 500));

    const messages = parseJsonRpcMessages(stdout);
    const toolsResponse = messages.find((m) => m.id === 2);

    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result.tools.length).toBeGreaterThan(0);
  }, 20000);
});

describe('integration: multi-server via config', () => {
  function makeTempConfig(): string {
    const config = {
      servers: {
        fs1: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
        fs2: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/root'],
        },
      },
      compression: 'standard',
    };
    const path = resolve(tmpdir(), `slim-mcp-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(config, null, 2));
    return path;
  }

  it('aggregates tools from two filesystem servers with namespacing', async () => {
    const configPath = makeTempConfig();
    const proxy = spawn('node', [
      'dist/index.js',
      '--config', configPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT,
    });

    let stdout = '';
    proxy.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    // Initialize
    sendJsonRpc(proxy, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    // Double init time for two servers to start
    await new Promise((r) => setTimeout(r, 10000));

    // Send initialized notification
    sendJsonRpc(proxy, { jsonrpc: '2.0', method: 'notifications/initialized' });

    await new Promise((r) => setTimeout(r, 1000));

    // Request tools/list
    sendJsonRpc(proxy, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    await new Promise((r) => setTimeout(r, 8000));

    proxy.kill();
    await new Promise((r) => setTimeout(r, 500));

    try { unlinkSync(configPath); } catch {}

    const messages = parseJsonRpcMessages(stdout);
    const toolsResponse = messages.find((m) => m.id === 2);

    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result.tools).toBeDefined();
    expect(toolsResponse.result.tools.length).toBeGreaterThan(0);

    const toolNames: string[] = toolsResponse.result.tools.map((t: any) => t.name);

    // Both namespaces should be present
    expect(toolNames.some((n) => n.startsWith('fs1__'))).toBe(true);
    expect(toolNames.some((n) => n.startsWith('fs2__'))).toBe(true);

    // Verify the same logical tool appears under both namespaces
    expect(toolNames.some((n) => n === 'fs1__list_directory')).toBe(true);
    expect(toolNames.some((n) => n === 'fs2__list_directory')).toBe(true);
  }, 40000);

  it('routes tools/call to correct server via namespace', async () => {
    const configPath = makeTempConfig();
    const proxy = spawn('node', [
      'dist/index.js',
      '--config', configPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT,
    });

    let stdout = '';
    proxy.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    // Initialize
    sendJsonRpc(proxy, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    await new Promise((r) => setTimeout(r, 10000));

    sendJsonRpc(proxy, { jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 1000));

    // List tools first to confirm they exist
    sendJsonRpc(proxy, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise((r) => setTimeout(r, 8000));

    // Call fs1__list_directory targeting /tmp
    sendJsonRpc(proxy, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'fs1__list_directory',
        arguments: { path: '/tmp' },
      },
    });

    await new Promise((r) => setTimeout(r, 5000));

    proxy.kill();
    await new Promise((r) => setTimeout(r, 500));

    try { unlinkSync(configPath); } catch {}

    const messages = parseJsonRpcMessages(stdout);
    const callResponse = messages.find((m) => m.id === 3);

    expect(callResponse).toBeDefined();
    expect(callResponse.result).toBeDefined();
    expect(callResponse.result.content).toBeDefined();
    expect(Array.isArray(callResponse.result.content)).toBe(true);
    expect(callResponse.result.content.length).toBeGreaterThan(0);
  }, 40000);
});

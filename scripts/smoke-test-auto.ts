#!/usr/bin/env npx tsx
/**
 * slim-mcp Real-World Smoke Test
 *
 * Discovers MCP servers from ~/.claude.json (and .mcp.json if present),
 * spawns slim-mcp as a proxy, connects as an MCP client, and verifies
 * that real tools are listed, callable, and compressed.
 *
 * This script is READ-ONLY — it never modifies ~/.claude.json.
 * It creates a temp config file which is cleaned up on exit.
 *
 * Usage:
 *   npx tsx scripts/smoke-test-auto.ts
 *   npx tsx scripts/smoke-test-auto.ts --verbose
 *   npx tsx scripts/smoke-test-auto.ts --config scripts/smoke-test-multi.json
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChildProcess } from 'node:child_process';

// ── Config ──────────────────────────────────────────────────────────────

const REPO_DIR = join(import.meta.dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dist/index.js');
const CLAUDE_CONFIG = join(homedir(), '.claude.json');
const TEMP_CONFIG = join(tmpdir(), `.slim-mcp-smoke-${Date.now()}.json`);

const SAFE_PREFIXES = ['list', 'get', 'read', 'search', 'describe', 'find', 'info', 'bridge_get', 'bridge_read', 'fs_list', 'fs_read', 'fs_info', 'fs_tree', 'fs_search'];
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

// Parse --config flag
function getConfigFlag(): string | undefined {
  const idx = process.argv.indexOf('--config');
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}
const customConfigPath = getConfigFlag();

// ── Types ───────────────────────────────────────────────────────────────

interface ClaudeServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface DiscoveredServer {
  name: string;
  transport: 'stdio' | 'http';
  config: ClaudeServer;
  source: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

function vlog(msg: string): void {
  if (verbose) process.stdout.write(`  [verbose] ${msg}\n`);
}

function isSafeTool(name: string): boolean {
  const baseName = name.includes('__') ? name.split('__').pop()! : name;
  return SAFE_PREFIXES.some(p => baseName.startsWith(p));
}

// ── Discovery ───────────────────────────────────────────────────────────

function discoverServers(): DiscoveredServer[] {
  const servers: DiscoveredServer[] = [];

  // 1. ~/.claude.json top-level mcpServers
  if (existsSync(CLAUDE_CONFIG)) {
    try {
      const config = JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8'));
      const mcpServers = config.mcpServers || {};
      for (const [name, srv] of Object.entries(mcpServers) as [string, ClaudeServer][]) {
        servers.push({
          name,
          transport: srv.url ? 'http' : 'stdio',
          config: srv,
          source: '~/.claude.json',
        });
      }
    } catch (err) {
      log(`Warning: Could not parse ${CLAUDE_CONFIG}: ${(err as Error).message}`);
    }
  }

  // 2. .mcp.json in cwd (Claude Code project-scoped servers)
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      const mcpServers = config.mcpServers || {};
      for (const [name, srv] of Object.entries(mcpServers) as [string, ClaudeServer][]) {
        if (!servers.some(s => s.name === name)) {
          servers.push({
            name,
            transport: srv.url ? 'http' : 'stdio',
            config: srv,
            source: '.mcp.json',
          });
        }
      }
    } catch (err) {
      log(`Warning: Could not parse ${mcpJsonPath}: ${(err as Error).message}`);
    }
  }

  return servers;
}

// ── Config Generation ───────────────────────────────────────────────────

function generateSlimConfig(servers: DiscoveredServer[]): Record<string, unknown> {
  const slimServers: Record<string, Record<string, unknown>> = {};

  for (const srv of servers) {
    const entry: Record<string, unknown> = {};
    if (srv.config.command) {
      entry.command = srv.config.command;
      if (srv.config.args?.length) entry.args = srv.config.args;
      if (srv.config.env && Object.keys(srv.config.env).length > 0) entry.env = srv.config.env;
    } else if (srv.config.url) {
      entry.url = srv.config.url;
      if (srv.config.type) entry.type = srv.config.type;
      if (srv.config.headers && Object.keys(srv.config.headers).length > 0) entry.headers = srv.config.headers;
    }
    slimServers[srv.name] = entry;
  }

  return {
    servers: slimServers,
    compression: 'standard',
  };
}

// ── MCP Client Connection ───────────────────────────────────────────────

async function connectToSlim(configPath: string): Promise<{
  client: Client;
  process: ChildProcess;
  stderr: string[];
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_PATH, '--config', configPath, '--verbose'],
    env: process.env as Record<string, string>,
    stderr: 'pipe',
  });

  const stderr: string[] = [];
  if (transport.stderr) {
    transport.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      stderr.push(...lines);
      if (verbose) lines.forEach(l => vlog(`stderr: ${l}`));
    });
  }

  const client = new Client({ name: 'smoke-test', version: '1.0.0' });

  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Connection timed out after 30s')), 30_000),
  );
  await Promise.race([connectPromise, timeoutPromise]);

  const childProcess = (transport as unknown as { _process?: ChildProcess })._process;
  if (!childProcess) throw new Error('Could not access child process');

  return { client, process: childProcess, stderr };
}

// ── Main Test ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== slim-mcp Real-World Smoke Test ===\n');

  // Step 1: Determine config — either custom or auto-discovered
  let configPath: string;
  let serverNames: string[];
  let needsCleanup = false;

  if (customConfigPath) {
    // --config flag: use the provided slim-mcp config directly
    if (!existsSync(customConfigPath)) {
      log(`FAIL: Config file not found: ${customConfigPath}`);
      process.exit(1);
    }
    configPath = customConfigPath;
    const config = JSON.parse(readFileSync(customConfigPath, 'utf8'));
    serverNames = Object.keys(config.servers || {});
    log(`Using custom config: ${customConfigPath}`);
    log(`Servers: ${serverNames.join(', ')}`);
  } else {
    // Auto-discover from Claude config
    const servers = discoverServers();
    if (servers.length === 0) {
      log('No MCP servers found in ~/.claude.json or .mcp.json');
      log('Nothing to test. Exiting.');
      process.exit(0);
    }

    log(`Discovered ${servers.length} server${servers.length > 1 ? 's' : ''}:`);
    for (const srv of servers) {
      log(`  ${srv.name} (${srv.transport}) — from ${srv.source}`);
    }

    const slimConfig = generateSlimConfig(servers);
    writeFileSync(TEMP_CONFIG, JSON.stringify(slimConfig, null, 2));
    vlog(`Temp config written to ${TEMP_CONFIG}`);
    configPath = TEMP_CONFIG;
    serverNames = servers.map(s => s.name);
    needsCleanup = true;
  }
  log('');

  // Cleanup on exit (only for auto-generated configs)
  const cleanup = () => {
    if (needsCleanup) {
      try { unlinkSync(TEMP_CONFIG); } catch {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });

  // Step 3: Connect to slim-mcp
  log('Starting slim-mcp with real servers...\n');
  let conn: Awaited<ReturnType<typeof connectToSlim>>;
  try {
    conn = await connectToSlim(configPath);
  } catch (err) {
    log(`FAIL: Could not connect to slim-mcp: ${(err as Error).message}`);
    cleanup();
    process.exit(1);
  }
  log('\u2713 Connected to slim-mcp proxy');

  // Step 4: List tools
  let tools: { name: string; description?: string }[];
  try {
    const result = await conn.client.listTools();
    tools = result.tools;
  } catch (err) {
    log(`FAIL: listTools failed: ${(err as Error).message}`);
    await conn.client.close();
    cleanup();
    process.exit(1);
  }
  log(`\u2713 Listed ${tools.length} tool${tools.length !== 1 ? 's' : ''} from ${serverNames.length} server${serverNames.length > 1 ? 's' : ''}`);
  log('');

  // Step 5: Per-server results
  const isMulti = serverNames.length > 1;
  const serverResults: { name: string; toolCount: number; callResult: string }[] = [];

  for (const srvName of serverNames) {
    const prefix = isMulti ? `${srvName}__` : '';
    const serverTools = tools.filter(t => isMulti ? t.name.startsWith(prefix) : true);
    const toolCount = isMulti ? serverTools.length : tools.length;

    // Find a safe read-only tool to call
    const safeTool = serverTools.find(t => isSafeTool(t.name));
    let callResult = 'no safe tool found';

    if (safeTool) {
      try {
        const result = await conn.client.callTool({ name: safeTool.name, arguments: {} });
        const hasContent = result.content && (result.content as unknown[]).length > 0;
        callResult = hasContent ? `called ${safeTool.name} \u2192 OK` : `called ${safeTool.name} \u2192 OK (empty)`;
      } catch (err) {
        callResult = `called ${safeTool.name} \u2192 FAIL: ${(err as Error).message}`;
      }
    }

    serverResults.push({ name: srvName, toolCount, callResult });
  }

  log('Per-server results:');
  for (const r of serverResults) {
    log(`  ${r.name}: ${r.toolCount} tools, ${r.callResult}`);
  }
  log('');

  // Step 6: Cache test — call the same safe tool twice
  // Prefer tools known to succeed with empty args (bridge_get_summary, read_data)
  const cachePreferred = ['bridge_get_summary', 'get_summary', 'read_data'];
  const anyTool = tools.find(t => cachePreferred.some(p => t.name.includes(p)))
    || tools.find(t => isSafeTool(t.name));
  let cacheTestResult = 'skipped (no safe tool)';
  if (anyTool) {
    try {
      await conn.client.callTool({ name: anyTool.name, arguments: {} });
      // Second call should be a cache hit
      await conn.client.callTool({ name: anyTool.name, arguments: {} });
      // Wait briefly for stderr to arrive
      await new Promise(r => setTimeout(r, 200));
      const hitLine = conn.stderr.find(l => l.includes('Cache hit'));
      cacheTestResult = hitLine ? `repeated call to ${anyTool.name}: cache hit \u2713` : `repeated call to ${anyTool.name}: no cache hit detected`;
    } catch (err) {
      cacheTestResult = `FAIL: ${(err as Error).message}`;
    }
  }

  log('Cache test:');
  log(`  ${cacheTestResult}`);
  log('');

  // Step 7: Parse stats from stderr
  const compressionLine = conn.stderr.find(l => l.includes('Compressed'));
  const lazyLine = conn.stderr.find(l => l.includes('Lazy loading'));
  const savedLine = conn.stderr.find(l => l.includes('Saved'));

  if (compressionLine || lazyLine || savedLine) {
    log('Stats from stderr:');
    if (compressionLine) log(`  ${compressionLine.trim()}`);
    if (lazyLine) log(`  ${lazyLine.trim()}`);
    if (savedLine) log(`  ${savedLine.trim()}`);
    log('');
  }

  // Step 8: Shutdown
  const exitPromise = new Promise<number | null>((resolve) => {
    if (conn.process.exitCode !== null) {
      resolve(conn.process.exitCode);
      return;
    }
    conn.process.once('exit', (code) => resolve(code));
  });

  await conn.client.close();
  await Promise.race([
    exitPromise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
  ]).then(result => {
    if (result === 'timeout') conn.process.kill('SIGKILL');
  });

  // Final stderr dump if verbose
  if (verbose) {
    log('Full stderr output:');
    conn.stderr.forEach(l => log(`  ${l}`));
    log('');
  }

  // Summary
  const failures = serverResults.filter(r => r.callResult.includes('FAIL'));
  if (failures.length > 0) {
    log(`=== ${failures.length} server${failures.length > 1 ? 's' : ''} had failures ===`);
    for (const f of failures) log(`  ${f.name}: ${f.callResult}`);
    process.exit(1);
  } else {
    log('=== All tests passed ===');
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  if (!customConfigPath) {
    try { unlinkSync(TEMP_CONFIG); } catch {}
  }
  process.exit(1);
});

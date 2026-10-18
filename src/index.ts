#!/usr/bin/env node

import { startProxy } from './proxy.js';
import { loadConfig, type McpSlimConfig, type ServerConfig } from './config.js';
import { setVerbose, info, error } from './logger.js';
import { parseArgs, printUsage, resolveDashboard, UsageError, type ParsedArgs } from './cli.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      printUsage();
      process.exit(1);
    }
    throw err;
  }

  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  setVerbose(parsed.verbose);
  info(`slim-mcp v${VERSION}`);

  const common = { noCache: parsed.noCache, noLazy: parsed.noLazy, maxTools: parsed.maxTools };

  // Mode 0: --url → single remote server through the multi-server engine
  if (parsed.url) {
    if (parsed.command !== undefined) {
      throw new UsageError('Cannot use --url with an upstream command (-- ...)');
    }
    const remote: ServerConfig = { url: parsed.url };
    if (parsed.transport) remote.type = parsed.transport;
    if (Object.keys(parsed.headers).length > 0) remote.headers = parsed.headers;
    const config: McpSlimConfig = { servers: { remote }, compression: parsed.compression };
    await startProxy({ mode: 'multi', config, ...common, dashboard: resolveDashboard(parsed, true) });
    return;
  }

  if (parsed.transport || Object.keys(parsed.headers).length > 0) {
    throw new UsageError('--transport and --header require --url');
  }

  // Mode 1: an upstream command (after --, or legacy positional form) → single-server pass-through
  if (parsed.command !== undefined && parsed.configPath === undefined) {
    await startProxy({
      mode: 'single',
      command: parsed.command,
      args: parsed.args,
      compression: parsed.compression,
      ...common,
      dashboard: resolveDashboard(parsed, false),
    });
    return;
  }

  if (parsed.command !== undefined) {
    throw new UsageError('Cannot combine --config with an upstream command');
  }

  // Mode 2: config file
  const config = loadConfig(parsed.configPath);
  if (config === null) {
    throw new UsageError('No upstream given and no .slim-mcp.json found');
  }
  if (parsed.compressionExplicit) {
    config.compression = parsed.compression;
  }
  await startProxy({ mode: 'multi', config, ...common, dashboard: resolveDashboard(parsed, true, config.dashboard) });
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

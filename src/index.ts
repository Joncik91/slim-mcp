#!/usr/bin/env node

import { startProxy } from './proxy.js';
import { loadConfig } from './config.js';
import { setVerbose, info, error } from './logger.js';
import type { CompressionLevel } from './compress.js';
import type { TransportType } from './transport/http.js';

const VALID_COMPRESSION_LEVELS: CompressionLevel[] = ['none', 'standard', 'aggressive'];
const VALID_TRANSPORT_TYPES: TransportType[] = ['http', 'sse'];

interface ParsedArgs {
  verbose: boolean;
  compression: CompressionLevel;
  compressionExplicit: boolean;
  noCache: boolean;
  noLazy: boolean;
  maxTools: number | undefined;
  configPath: string | undefined;
  url: string | undefined;
  headers: Record<string, string>;
  transport: TransportType | undefined;
  command: string | undefined;
  args: string[];
  doubleDash: boolean;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2); // skip node and script path
  let verbose = false;
  let compression: CompressionLevel = 'standard';
  let compressionExplicit = false;
  let noCache = false;
  let noLazy = false;
  let maxTools: number | undefined;
  let configPath: string | undefined;
  let url: string | undefined;
  let headers: Record<string, string> = {};
  let transport: TransportType | undefined;
  let doubleDash = false;

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--no-cache') {
      noCache = true;
    } else if (arg === '--no-lazy') {
      noLazy = true;
    } else if (arg === '--max-tools') {
      const val = args[++i];
      const num = Number(val);
      if (!val || !Number.isInteger(num) || num < 0) {
        process.stderr.write(`Invalid --max-tools value: ${val ?? '(missing)'}. Must be a non-negative integer.\n`);
        return null;
      }
      maxTools = num;
    } else if (arg === '--url') {
      const val = args[++i];
      if (!val) {
        process.stderr.write(`--url requires a URL argument\n`);
        return null;
      }
      url = val;
    } else if (arg === '--header') {
      const val = args[++i];
      if (!val || !val.includes(':')) {
        process.stderr.write(`--header requires a key:value argument\n`);
        return null;
      }
      const colonIdx = val.indexOf(':');
      headers[val.slice(0, colonIdx).trim()] = val.slice(colonIdx + 1).trim();
    } else if (arg === '--transport') {
      const val = args[++i];
      if (!val || !VALID_TRANSPORT_TYPES.includes(val as TransportType)) {
        process.stderr.write(`Invalid transport type: ${val ?? '(missing)'}. Valid: ${VALID_TRANSPORT_TYPES.join(', ')}\n`);
        return null;
      }
      transport = val as TransportType;
    } else if (arg === '--compression') {
      const val = args[++i];
      if (!val || !VALID_COMPRESSION_LEVELS.includes(val as CompressionLevel)) {
        process.stderr.write(`Invalid compression level: ${val ?? '(missing)'}. Valid: ${VALID_COMPRESSION_LEVELS.join(', ')}\n`);
        return null;
      }
      compression = val as CompressionLevel;
      compressionExplicit = true;
    } else if (arg === '--config') {
      const val = args[++i];
      if (!val) {
        process.stderr.write(`--config requires a path argument\n`);
        return null;
      }
      configPath = val;
    } else if (arg === '--') {
      // Everything after -- is the upstream command
      doubleDash = true;
      const rest = args.slice(i + 1);
      if (rest.length === 0) return null;
      return { command: rest[0], args: rest.slice(1), verbose, compression, compressionExplicit, noCache, noLazy, maxTools, configPath, url, headers, transport, doubleDash };
    } else {
      filtered.push(arg);
    }
  }

  const command = filtered.length > 0 ? filtered[0] : undefined;
  const commandArgs = filtered.slice(1);
  return { command, args: commandArgs, verbose, compression, compressionExplicit, noCache, noLazy, maxTools, configPath, url, headers, transport, doubleDash };
}

function printUsage(): void {
  process.stderr.write(`
slim-mcp v0.1.0 — MCP proxy that gives agents their context window back

Usage:
  npx slim-mcp [options] -- <command> [args...]    Proxy a single local server
  npx slim-mcp [options] --url <url>               Proxy a single remote server
  npx slim-mcp [options]                           Use .slim-mcp.json config

Options:
  --config <path>        Path to config file (default: auto-discover)
  --compression <level>  none | standard | aggressive (default: standard)
  --no-cache             Disable response caching
  --no-lazy              Disable lazy loading
  --max-tools <n>        Max tools with full schemas (default: 8)
  --url <url>            Connect to a remote MCP server
  --header <key:value>   Add HTTP header (repeatable)
  --transport <type>     http | sse (default: auto-detect)
  -v, --verbose          Show detailed logging
  --version              Show version
  --help                 Show this help

Examples:
  npx slim-mcp -- npx -y @modelcontextprotocol/server-filesystem /tmp
  npx slim-mcp --url https://mcp.example.com/mcp
  npx slim-mcp --compression aggressive --config ~/.slim-mcp.json

Documentation: https://github.com/Joncik91/mcp-slim
`);
}

async function main(): Promise<void> {
  const argv = process.argv;

  if (argv.includes('--version')) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const parsed = parseArgs(argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  setVerbose(parsed.verbose);
  info(`slim-mcp v0.1.0`);

  try {
    // Mode 0: --url → single remote server via multi-server config
    if (parsed.url) {
      if (parsed.doubleDash) {
        process.stderr.write(`Cannot use --url with -- command\n`);
        process.exit(1);
      }
      const serverConfig: Record<string, any> = {
        url: parsed.url,
      };
      if (parsed.transport) serverConfig.type = parsed.transport;
      if (Object.keys(parsed.headers).length > 0) serverConfig.headers = parsed.headers;
      const config = {
        servers: { remote: serverConfig },
        compression: parsed.compression,
      } as any;
      await startProxy({ mode: 'multi', config, noCache: parsed.noCache, noLazy: parsed.noLazy, maxTools: parsed.maxTools });
      return;
    }

    // Mode 1: explicit -- separator → single-server mode
    if (parsed.doubleDash) {
      await startProxy({
        mode: 'single',
        command: parsed.command!,
        args: parsed.args,
        compression: parsed.compression,
        noCache: parsed.noCache,
        noLazy: parsed.noLazy,
        maxTools: parsed.maxTools,
      });
      return;
    }

    // Mode 2: --config present or no command args → try config file mode
    if (parsed.configPath !== undefined || parsed.command === undefined) {
      const config = loadConfig(parsed.configPath);
      if (config !== null) {
        if (parsed.compressionExplicit) {
          config.compression = parsed.compression;
        }
        await startProxy({ mode: 'multi', config, noCache: parsed.noCache, noLazy: parsed.noLazy, maxTools: parsed.maxTools });
        return;
      }
      // No config found and no command → nothing to do
      printUsage();
      process.exit(1);
    }

    // Mode 3: remaining non-flag args → single-server mode (legacy)
    await startProxy({
      mode: 'single',
      command: parsed.command,
      args: parsed.args,
      compression: parsed.compression,
      noCache: parsed.noCache,
      noLazy: parsed.noLazy,
      maxTools: parsed.maxTools,
    });
  } catch (err) {
    error(`Failed to start proxy: ${err}`);
    process.exit(1);
  }
}

main();

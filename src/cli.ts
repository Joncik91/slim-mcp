import {
  COMPRESSION_LEVELS,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  type CompressionLevel,
  type DashboardConfig as FileDashboardConfig,
} from './config.js';
import type { DashboardConfig } from './dashboard.js';
import type { TransportType } from './transport/http.js';
import { VERSION } from './version.js';

const VALID_TRANSPORT_TYPES: readonly TransportType[] = ['http', 'sse'];

export interface ParsedArgs {
  help: boolean;
  version: boolean;
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
  dashboardPort: number | undefined;
  noDashboard: boolean;
}

export class UsageError extends Error {}

/**
 * Parse CLI arguments. Everything after `--` belongs to the upstream command and is
 * never interpreted (so `-- server --help` passes --help through).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    verbose: false,
    compression: 'standard',
    compressionExplicit: false,
    noCache: false,
    noLazy: false,
    maxTools: undefined,
    configPath: undefined,
    url: undefined,
    headers: {},
    transport: undefined,
    command: undefined,
    args: [],
    doubleDash: false,
    dashboardPort: undefined,
    noDashboard: false,
  };

  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined || v === '--') throw new UsageError(`${flag} requires a value`);
    return v;
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Legacy mode: once the upstream command starts, the rest is its argv.
    if (positional.length > 0) {
      positional.push(arg);
      continue;
    }

    switch (arg) {
      case '--':
        parsed.doubleDash = true;
        positional.push(...args.slice(i + 1));
        if (positional.length === 0) throw new UsageError('-- must be followed by a command');
        i = args.length;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--version':
        parsed.version = true;
        break;
      case '--verbose':
      case '-v':
        parsed.verbose = true;
        break;
      case '--no-cache':
        parsed.noCache = true;
        break;
      case '--no-lazy':
        parsed.noLazy = true;
        break;
      case '--no-dashboard':
        parsed.noDashboard = true;
        break;
      case '--dashboard-port': {
        const v = value(++i, arg);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new UsageError(`Invalid --dashboard-port value: ${v}. Must be an integer between 1 and 65535.`);
        }
        parsed.dashboardPort = n;
        break;
      }
      case '--max-tools': {
        const v = value(++i, arg);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(`Invalid --max-tools value: ${v}. Must be a non-negative integer.`);
        }
        parsed.maxTools = n;
        break;
      }
      case '--url': {
        const v = value(++i, arg);
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          throw new UsageError(`Invalid --url value: ${v}. Must be an http(s) URL.`);
        }
        parsed.url = v;
        break;
      }
      case '--header': {
        const v = value(++i, arg);
        const colon = v.indexOf(':');
        const key = colon > 0 ? v.slice(0, colon).trim() : '';
        if (!key) throw new UsageError('--header requires a key:value argument');
        parsed.headers[key] = v.slice(colon + 1).trim();
        break;
      }
      case '--transport': {
        const v = value(++i, arg);
        if (!VALID_TRANSPORT_TYPES.includes(v as TransportType)) {
          throw new UsageError(`Invalid transport type: ${v}. Valid: ${VALID_TRANSPORT_TYPES.join(', ')}`);
        }
        parsed.transport = v as TransportType;
        break;
      }
      case '--compression': {
        const v = value(++i, arg);
        if (!COMPRESSION_LEVELS.includes(v as CompressionLevel)) {
          throw new UsageError(`Invalid compression level: ${v}. Valid: ${COMPRESSION_LEVELS.join(', ')}`);
        }
        parsed.compression = v as CompressionLevel;
        parsed.compressionExplicit = true;
        break;
      }
      case '--config':
        parsed.configPath = value(++i, arg);
        break;
      default:
        if (arg.startsWith('-') && arg.length > 1) throw new UsageError(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  parsed.command = positional[0];
  parsed.args = positional.slice(1);
  return parsed;
}

export function printUsage(): void {
  process.stderr.write(`
slim-mcp v${VERSION} — MCP proxy that gives agents their context window back

Usage:
  npx slim-mcp [options] -- <command> [args...]    Proxy a single local server
  npx slim-mcp [options] --url <url>               Proxy a single remote server
  npx slim-mcp [options]                           Use .slim-mcp.json config

Options:
  --config <path>        Path to config file (default: ./.slim-mcp.json, then ~/.slim-mcp.json)
  --compression <level>  none | standard | aggressive | extreme | maximum (default: standard)
  --no-cache             Disable response caching
  --no-lazy              Disable lazy loading
  --max-tools <n>        Max tools with full schemas (default: 8)
  --url <url>            Connect to a remote MCP server
  --header <key:value>   Add HTTP header (repeatable)
  --transport <type>     http | sse (default: auto-detect)
  --dashboard-port <n>   Enable dashboard on port (default: ${DEFAULT_DASHBOARD_PORT})
  --no-dashboard         Disable dashboard
  -v, --verbose          Show detailed logging
  --version              Show version
  -h, --help             Show this help

Examples:
  npx slim-mcp -- npx -y @modelcontextprotocol/server-filesystem /tmp
  npx slim-mcp --url https://mcp.example.com/mcp
  npx slim-mcp --compression aggressive --config ~/.slim-mcp.json

Documentation: https://github.com/Joncik91/slim-mcp
`);
}

/**
 * Dashboard policy: on by default in multi-server mode (unless the config disables it),
 * off by default in single-server mode, forced on by --dashboard-port, off by --no-dashboard.
 */
export function resolveDashboard(
  parsed: Pick<ParsedArgs, 'noDashboard' | 'dashboardPort'>,
  multiServer: boolean,
  fromConfig?: FileDashboardConfig,
): DashboardConfig | undefined {
  if (parsed.noDashboard) return undefined;
  const enabled =
    parsed.dashboardPort !== undefined ||
    fromConfig?.enabled === true ||
    (multiServer && fromConfig?.enabled !== false);
  if (!enabled) return undefined;
  return {
    enabled: true,
    port: parsed.dashboardPort ?? fromConfig?.port ?? DEFAULT_DASHBOARD_PORT,
    host: fromConfig?.host ?? DEFAULT_DASHBOARD_HOST,
  };
}

<div align="center">

<img src="docs/logo.png" alt="slim-mcp" width="160" height="160">

# slim-mcp

[![npm](https://img.shields.io/npm/v/slim-mcp?color=E8954A&logo=npm)](https://www.npmjs.com/package/slim-mcp)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-E8954A.svg)](LICENSE)
[![tests: 220](https://img.shields.io/badge/tests-220%20%C2%B7%20190%20unit%20%2B%2030%20e2e-E8954A)]()
[![accuracy: 100%](https://img.shields.io/badge/accuracy-100%25%20%C2%B7%20120%20API%20calls-E8954A)]()
[![reduction: 77%](https://img.shields.io/badge/token%20reduction-up%20to%2077%25-E8954A)]()

***MCP proxy that gives agents their context window back.***

Compresses tool schemas (5 levels, up to 77% reduction), lazy-loads tool definitions, caches read-only responses, and aggregates multiple MCP servers behind one stdio interface. Validated against Claude Sonnet 4 across 120 API calls — 100% accuracy at every compression level.

</div>

## Table of Contents

- [Benchmarks](#benchmarks)
- [Install](#install)
- [Quick Start](#quick-start)
- [Agent Integration](#agent-integration)
- [Features](#features)
- [Configuration](#configuration)
- [CLI](#cli)
- [How It Works](#how-it-works)
- [Testing](#testing)
- [Security](#security)
- [Requirements](#requirements)
- [License](#license)

## Benchmarks

Tested on 57 tools across 4 real MCP servers. Accuracy validated with 120 API calls against Claude Sonnet 4.

| Level | Tokens | Reduction | Accuracy |
|-------|--------|-----------|----------|
| none | 7,528 | baseline | 100% |
| standard | 6,100 | 19% | 100% |
| aggressive | 4,930 | 35% | 100% |
| **extreme** | **2,133** | **72%** | **100%** |
| **maximum** | **1,750** | **77%** | **100%** |

With lazy loading (57 tools): 7,702 -> 2,722 tokens (65% reduction). Compression and lazy loading stack.

**How extreme/maximum work:** Instead of full JSON Schema, slim-mcp embeds TypeScript-style parameter signatures in the tool description and strips the inputSchema. The LLM reads the description to understand parameters -- which is what it does anyway.

## Install

```bash
npm install -g slim-mcp
```

## Quick Start

**Single server** -- wrap any MCP server:

```bash
slim-mcp -- npx -y @modelcontextprotocol/server-filesystem /tmp
```

**Multiple servers** -- create `.slim-mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  },
  "compression": "extreme"
}
```

```bash
slim-mcp
```

**Remote server:**

```bash
slim-mcp --url https://mcp.example.com/mcp --header "Authorization:Bearer $TOKEN"
```

## Agent Integration

### Claude Code

In `.mcp.json`:

```json
{
  "mcpServers": {
    "tools": {
      "command": "npx",
      "args": ["-y", "slim-mcp", "--config", "/path/to/.slim-mcp.json"]
    }
  }
}
```

Or wrap a single server:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "slim-mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### Any MCP Client

slim-mcp speaks standard MCP over stdio. Works with Cursor, Windsurf, or any client -- replace the server command with `slim-mcp` wrapping it.

## Features

| Feature | How it works | When it activates |
|---------|-------------|-------------------|
| **Compression** | 5 levels from structural cleanup to TS-signature embedding | Always (default: `standard`) |
| **Lazy loading** | Slim one-liner indexes for most tools, full schema on first call | Auto when >15 tools |
| **Caching** | TTL + LRU for read-only calls, invalidates on writes | Always (disable with `--no-cache`) |
| **Multi-server** | Aggregates servers behind one proxy, namespaces as `server__tool` | Config file with 2+ servers |
| **Remote transport** | HTTP/SSE alongside local stdio servers | `url` in config or `--url` flag |
| **Live dashboard** | Real-time stats: compression, cache hits, tool calls, server status | Multi-server mode (port 7333) |

### Compression Levels

| Level | What it does |
|-------|-------------|
| `none` | Passthrough |
| `standard` | Structural cleanup, description trimming |
| `aggressive` | + strips obvious descriptions, deduplicates params |
| `extreme` | Embeds TS-style signatures in descriptions, strips inputSchema (72% reduction) |
| `maximum` | Ultra-short types (`s`/`n`/`b`), `!` for required, shared param extraction (77% reduction) |

### Dashboard

When running in multi-server mode, slim-mcp serves a live web dashboard:

```
http://localhost:7333
```

Shows: token savings, cache hit rate, server status, recent tool calls with HIT/MISS/PROMOTED status and response times. Updates in real-time via SSE. Dark theme, zero dependencies.

Enable via config:
```json
{ "dashboard": { "enabled": true, "port": 7333 } }
```

Or CLI: `--dashboard-port 7333`. Disable: `--no-dashboard`.

## Configuration

slim-mcp looks for `.slim-mcp.json` in the working directory, then home directory. Use `--config <path>` to specify explicitly.

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "always_load": ["read_file", "list_directory"],
      "cache_ttl": 30
    },
    "remote-api": {
      "url": "https://mcp.example.com/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
  },
  "compression": "extreme",
  "max_tools_loaded": 10,
  "cache": {
    "default_ttl": 60,
    "max_entries": 1000,
    "never_cache": ["my_custom_write_tool"]
  },
  "dashboard": {
    "enabled": true,
    "port": 7333
  }
}
```

Each server needs `command` (stdio) or `url` (HTTP/SSE), not both. Environment variables expand with `${VAR}` syntax.

Full reference in [docs/configuration.md](docs/configuration.md).

## CLI

```
slim-mcp [options] -- <command> [args...]     Single server (stdio)
slim-mcp [options] --url <url>                Single server (HTTP/SSE)
slim-mcp [options] --config <path>            Multi-server (config file)
slim-mcp [options]                            Multi-server (auto-discover)
```

| Flag | Default | |
|------|---------|---|
| `-v, --verbose` | off | Show JSON-RPC messages on stderr |
| `--compression <level>` | `standard` | `none`, `standard`, `aggressive`, `extreme`, `maximum` |
| `--no-cache` | | Disable response caching |
| `--no-lazy` | | Disable lazy loading |
| `--max-tools <N>` | `8` | Max tools with full schemas |
| `--url <url>` | | Remote MCP server URL |
| `--header <key:value>` | | HTTP header (repeatable) |
| `--transport <type>` | auto | `http` or `sse` |
| `--dashboard-port <N>` | `7333` | Enable dashboard on port |
| `--no-dashboard` | | Disable dashboard |
| `--config <path>` | | Config file path |
| `--version` | | Show version |

## How It Works

```
                                ┌── Server A (stdio)
Agent <--stdio--> slim-mcp ----+-- Server B (stdio)
                                └── Server C (http)
```

On `tools/list`: collect from all servers -> lazy load (slim/full split) -> compress -> return.

On `tools/call`: check if slim (promote + retry) -> check cache (return if hit) -> route to server -> cache result.

All logging to stderr. Protocol channel stays clean.

Architecture deep dive in [docs/how-it-works.md](docs/how-it-works.md).

## Testing

220 tests: 190 unit + 30 e2e. Plus accuracy tests and smoke tests against real servers.

```bash
npm test              # Unit tests
npm run test:e2e      # E2E tests
npm run smoke-test    # Real servers from ~/.claude.json
```

### Accuracy Testing

Validates that compressed schemas produce correct tool calls via the Anthropic API.

```bash
ANTHROPIC_API_KEY=sk-... npx tsx scripts/accuracy-test.ts
```

- 8 test scenarios x 5 compression levels x 3 runs = 120 API calls
- Validates: tool selection, argument names, argument types
- Cost: ~$0.20 per run
- Result: **100% accuracy across all levels**

Details in [docs/testing.md](docs/testing.md).

## Security

slim-mcp is a **proxy in the middle of your agent and your MCP servers**.
That position has implications worth being explicit about.

- **Tokens flow through.** Configs accept `${VAR}` env-var expansion for
  headers (e.g. `"Authorization": "Bearer ${API_TOKEN}"`). The proxy
  forwards those headers verbatim to the wrapped server. Tokens are
  **not logged** (verbose mode prints JSON-RPC frames, not headers),
  but the same operational hygiene applies as to any reverse proxy:
  keep `.slim-mcp.json` out of git, use environment variables for
  secrets, and don't run the proxy on a host that holds tokens you
  wouldn't put on that host directly.
- **Tool calls are forwarded.** Compression rewrites the schema the
  agent sees; it does not rewrite the call the agent makes. Any
  destructive tool the wrapped server exposes is still destructive.
  Audit your wrapped servers as you would unwrapped.
- **Cache hits return prior responses.** Read-only calls are cached
  with a TTL + LRU. The cache invalidates on writes (`tools/call`
  for any non-read tool clears matching entries), but the threat
  model is single-tenant: don't expose one cache to multiple
  unrelated agents or trust-boundaries.
- **Dashboard is loopback by default.** When enabled, the dashboard
  binds `127.0.0.1:7333` and serves recent tool calls + stats. Don't
  change the bind address without a reverse proxy and auth in front
  — recent tool calls are sensitive.

For production-style use: lock the config file's permissions to your
user, run the proxy as the same user as the agent, and treat
`tools/list` and `tools/call` traffic as you would the underlying
servers' traffic.

## Requirements

- Node.js >= 18

## License

MIT — see [LICENSE](LICENSE).

# slim-mcp

MCP proxy that compresses tool schemas, lazy-loads definitions, caches responses, and aggregates multiple servers -- giving AI agents their context window back.

## Real-World Results

Tested against 3 real MCP servers (42 tools total) on a production Claude Code machine:

| Feature | What happened | Tokens |
|---------|--------------|--------|
| **Without slim-mcp** | 42 raw tool schemas | 5,812 |
| **Lazy loading** | 42 slim indexes | 2,191 (62% saved) |
| **Compression** | Trimmed descriptions, deduped params | Stacks on full schemas |
| **Caching** | 2nd identical call → instant | ~1,644 saved per repeated call |

Single server (8 tools): 715 → 611 tokens (15% compression). Multi-server (42 tools): lazy loading dominates at 62%. Both features stack -- a 50-tool setup with full schemas sees 80-95% combined reduction.

Every tool call routed correctly. Cache hit confirmed on repeated calls. All 203 tests pass.

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
  }
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
      "args": ["slim-mcp", "--config", "/path/to/.slim-mcp.json"]
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
      "args": ["slim-mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### Any MCP Client

slim-mcp speaks standard MCP over stdio. Works with Cursor, Windsurf, or any client -- replace the server command with `slim-mcp` wrapping it.

## Features

| Feature | How it works | When it activates |
|---------|-------------|-------------------|
| **Compression** | Strips verbose descriptions, redundant fields, deduplicates params | Always (3 levels: `none`, `standard`, `aggressive`) |
| **Lazy loading** | Slim one-liner indexes for most tools, full schema on first call | Auto when >15 tools |
| **Caching** | TTL + LRU for read-only calls, invalidates on writes | Always (disable with `--no-cache`) |
| **Multi-server** | Aggregates servers behind one proxy, namespaces as `server__tool` | Config file with 2+ servers |
| **Remote transport** | HTTP/SSE alongside local stdio servers | `url` in config or `--url` flag |

Details in [docs/how-it-works.md](docs/how-it-works.md).

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
  "compression": "standard",
  "max_tools_loaded": 10,
  "cache": {
    "default_ttl": 60,
    "max_entries": 1000,
    "never_cache": ["my_custom_write_tool"]
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
| `--compression <level>` | `standard` | `none`, `standard`, `aggressive` |
| `--no-cache` | | Disable response caching |
| `--no-lazy` | | Disable lazy loading |
| `--max-tools <N>` | `8` | Max tools with full schemas |
| `--url <url>` | | Remote MCP server URL |
| `--header <key:value>` | | HTTP header (repeatable) |
| `--transport <type>` | auto | `http` or `sse` |
| `--config <path>` | | Config file path |

## How It Works

```
                                ┌── Server A (stdio)
Agent ◄──stdio──► slim-mcp ────┼── Server B (stdio)
                                └── Server C (http)
```

On `tools/list`: collect from all servers → lazy load (slim/full split) → compress → return.

On `tools/call`: check if slim (promote + retry) → check cache (return if hit) → route to server → cache result.

All logging to stderr. Protocol channel stays clean.

Architecture deep dive in [docs/how-it-works.md](docs/how-it-works.md).

## Testing

203 tests: 173 unit + 30 e2e. Plus smoke tests against real servers.

```bash
npm test              # Unit tests
npm run test:e2e      # E2E tests
npm run smoke-test    # Real servers from ~/.claude.json
```

Details and real-world results in [docs/testing.md](docs/testing.md).

## Requirements

- Node.js >= 18

## License

MIT

# Configuration Reference

This document covers every configuration option, CLI flag, and validation rule in slim-mcp.

---

## Table of Contents

- [Config File Discovery](#config-file-discovery)
- [Config File Structure](#config-file-structure)
  - [Top-Level Fields](#top-level-fields)
  - [Server Configuration](#server-configuration)
  - [Cache Configuration](#cache-configuration)
- [Validation Rules](#validation-rules)
- [Environment Variable Expansion](#environment-variable-expansion)
- [TTL Resolution](#ttl-resolution)
- [Built-in Caching Behaviors](#built-in-caching-behaviors)
- [CLI Flags](#cli-flags)
- [Operating Modes](#operating-modes)
- [CLI Override Precedence](#cli-override-precedence)
- [Full Examples](#full-examples)

---

## Config File Discovery

slim-mcp looks for a `.slim-mcp.json` file in the following order:

1. **Explicit path** -- if `--config <path>` is passed, that file is used directly.
2. **Working directory** -- `.slim-mcp.json` in the current working directory.
3. **Home directory** -- `~/.slim-mcp.json` in the user's home directory.

The first file found wins. If no config file is found and no CLI arguments specify a server, slim-mcp exits with an error.

---

## Config File Structure

The config file is a JSON file with the following shape:

```json
{
  "servers": { ... },
  "compression": "standard",
  "lazy_loading": true,
  "max_tools_loaded": 8,
  "cache": { ... }
}
```

### Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `servers` | `Record<string, ServerConfig>` | Yes | -- | Map of server names to their configurations. Must contain at least one entry. |
| `compression` | `"none" \| "standard" \| "aggressive"` | No | `"standard"` | Controls how aggressively tool schemas are compressed before being sent to the LLM. |
| `lazy_loading` | `boolean` | No | Auto | Whether to use lazy loading for tool schemas. When omitted, defaults to `true` if the total number of tools across all servers exceeds 15, `false` otherwise. |
| `max_tools_loaded` | `number` | No | `8` | Maximum number of tools that receive full (uncompressed) schemas at any time. Only relevant when lazy loading is enabled. |
| `cache` | `CacheConfig` | No | See [Cache Configuration](#cache-configuration) | Response caching settings. A default config is auto-created if any server specifies `cache_ttl`. |

#### Compression levels

- **`none`** -- Tool schemas are passed through unmodified.
- **`standard`** -- Descriptions are shortened, optional fields with defaults are omitted, and parameter descriptions are trimmed. Good balance between token savings and clarity.
- **`aggressive`** -- On top of standard compression, examples are removed, enum descriptions are collapsed, and schemas are minimized to the bare structural minimum. Use when token budget is extremely tight.

#### Lazy loading behavior

When lazy loading is active, only `max_tools_loaded` tools receive their full schemas at a time. The remaining tools are presented as stubs (name + one-line description). When the LLM requests a lazily-loaded tool, its full schema is swapped in and the least-recently-used full schema is demoted back to a stub.

Tools listed in a server's `always_load` array are exempt from demotion and always retain their full schemas. These tools count toward the `max_tools_loaded` limit.

---

### Server Configuration

Each key in the `servers` object is the server's name (used in logs, cache keys, and namespaced tool names). The value is a `ServerConfig` object. There are two transport types: **stdio** and **HTTP/SSE**.

#### Stdio Transport

For local MCP servers that run as child processes:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | `string` | Yes | -- | Path to the executable. Must be a non-empty string. |
| `args` | `string[]` | No | `[]` | Arguments passed to the command. |
| `env` | `Record<string, string>` | No | `{}` | Environment variables set on the child process. Values support `${VAR}` expansion (see [Environment Variable Expansion](#environment-variable-expansion)). |
| `cache_ttl` | `number` | No | -- | Per-server cache TTL in seconds. Overrides the global `default_ttl` for all tools from this server. |
| `always_load` | `string[]` | No | `[]` | Tool names that always keep their full schemas loaded (bypass lazy loading demotion). |

**Example:**

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/project"],
      "env": {
        "NODE_ENV": "production"
      },
      "always_load": ["read_file", "write_file"]
    }
  }
}
```

#### HTTP/SSE Transport

For remote MCP servers accessed over HTTP:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` | Yes | -- | Server URL. Must be a non-empty string. |
| `type` | `"http" \| "sse"` | No | Auto-detect | Transport protocol. `"http"` uses Streamable HTTP, `"sse"` uses the legacy Server-Sent Events transport. When omitted, slim-mcp tries Streamable HTTP first and falls back to SSE if the server does not support it. |
| `headers` | `Record<string, string>` | No | `{}` | HTTP headers sent with every request. Values support `${VAR}` expansion (see [Environment Variable Expansion](#environment-variable-expansion)). |
| `cache_ttl` | `number` | No | -- | Per-server cache TTL in seconds. |
| `always_load` | `string[]` | No | `[]` | Tool names that always keep their full schemas loaded. |

**Example:**

```json
{
  "servers": {
    "remote-tools": {
      "url": "https://mcp.example.com/v1",
      "type": "http",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      },
      "cache_ttl": 120,
      "always_load": ["search"]
    }
  }
}
```

---

### Cache Configuration

The `cache` object controls response caching. When a tool call produces a cached response, slim-mcp returns the cached result without forwarding the request to the upstream server.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | `true` | Master switch for caching. Set to `false` to disable all caching. |
| `default_ttl` | `number` | No | `60` | Default time-to-live in seconds for cached responses. |
| `max_entries` | `number` | No | `1000` | Maximum number of entries in the cache. When exceeded, the least-recently-used entry is evicted. |
| `server_ttls` | `Record<string, number>` | No | `{}` | Per-server TTL overrides. Keys are server names (matching keys in `servers`). Values are TTL in seconds. |
| `tool_ttls` | `Record<string, number>` | No | `{}` | Per-tool TTL overrides. Keys can be bare tool names (`"read_file"`) or namespaced (`"filesystem__read_file"`). Values are TTL in seconds. |
| `never_cache` | `string[]` | No | `[]` | Additional tool name patterns (strings used as regex) that should never be cached. These are merged with the built-in never-cache patterns. |

**Example:**

```json
{
  "cache": {
    "enabled": true,
    "default_ttl": 90,
    "max_entries": 500,
    "server_ttls": {
      "filesystem": 30,
      "database": 10
    },
    "tool_ttls": {
      "search": 120,
      "filesystem__list_directory": 15
    },
    "never_cache": ["get_random", "fetch_live_"]
  }
}
```

#### Auto-created cache config

If any server has a `cache_ttl` field but there is no explicit `cache` section at the top level, slim-mcp automatically creates a default cache config:

```json
{
  "enabled": true,
  "default_ttl": 60,
  "max_entries": 1000,
  "server_ttls": {}
}
```

The per-server `cache_ttl` values are then injected into `server_ttls`. For example, if server `"myserver"` has `"cache_ttl": 30`, the resulting `server_ttls` will contain `{ "myserver": 30 }`.

---

## Validation Rules

slim-mcp validates the config file on startup. If any rule is violated, it exits with a descriptive error message.

| Rule | Error condition |
|------|----------------|
| `servers` is required | Missing or not an object |
| `servers` must be non-empty | Object with zero keys |
| Each server needs a transport | Server has neither `command` nor `url` |
| Transports are mutually exclusive | Server has both `command` and `url` |
| `command` must be non-empty | `command` is present but is an empty string |
| `url` must be non-empty | `url` is present but is an empty string |
| `type` requires `url` | `type` is set on a stdio server (one with `command`) |
| `headers` requires `url` | `headers` is set on a stdio server (one with `command`) |
| `compression` must be valid | Value is not one of `"none"`, `"standard"`, `"aggressive"` |
| `cache` must be an object | `cache` is present but is not an object |

---

## Environment Variable Expansion

String values in `env` (stdio servers) and `headers` (HTTP/SSE servers) support `${VAR_NAME}` placeholder syntax. At startup, each placeholder is replaced with the corresponding value from the process environment.

**Behavior:**

- `${VAR_NAME}` is replaced with the value of the environment variable `VAR_NAME`.
- If `VAR_NAME` is not set in the environment, the placeholder `${VAR_NAME}` is **left as-is** (no error, no empty string).
- Expansion happens once at config load time, not on each request.

**Example:**

```json
{
  "env": {
    "DATABASE_URL": "${DATABASE_URL}",
    "API_KEY": "${MY_SERVICE_KEY}"
  }
}
```

If `DATABASE_URL=postgres://localhost/mydb` is set but `MY_SERVICE_KEY` is not, the resolved values are:

- `DATABASE_URL` = `"postgres://localhost/mydb"`
- `API_KEY` = `"${MY_SERVICE_KEY}"` (unchanged)

---

## TTL Resolution

When determining the cache TTL for a specific tool call, slim-mcp checks the following sources in order. The **most specific match wins**:

| Priority | Source | Example key |
|----------|--------|-------------|
| 1 (highest) | `cache.tool_ttls` with namespaced name | `"filesystem__read_file"` |
| 2 | `cache.tool_ttls` with bare name | `"read_file"` |
| 3 | `cache.server_ttls` for the server, or the server's `cache_ttl` | `"filesystem"` |
| 4 (lowest) | `cache.default_ttl` | -- |

If no match is found at any level, the global `default_ttl` of **60 seconds** is used.

**Example:**

Given this config:

```json
{
  "servers": {
    "fs": {
      "command": "fs-server",
      "cache_ttl": 45
    }
  },
  "cache": {
    "default_ttl": 60,
    "server_ttls": {
      "fs": 45
    },
    "tool_ttls": {
      "read_file": 30,
      "fs__list_directory": 10
    }
  }
}
```

The resolved TTLs are:

| Tool | Resolved TTL | Reason |
|------|-------------|--------|
| `fs__list_directory` | 10s | Namespaced match in `tool_ttls` |
| `fs__read_file` | 30s | Bare name match in `tool_ttls` |
| `fs__write_file` | Never cached | Matches built-in never-cache pattern |
| `fs__get_info` | 45s | Server TTL for `"fs"` |

---

## Built-in Caching Behaviors

### Never-cache patterns

The following regex pattern is applied case-insensitively to every tool name. Any tool whose name matches is **never cached**, regardless of any TTL configuration:

```
^(create|write|update|delete|remove|set|put|post|patch|send|submit|commit|push|exec|run|invoke|apply|deploy)
```

This covers tools that perform mutations or side effects. The pattern matches the **start** of the tool name, so `write_file`, `delete_record`, `send_email`, `run_query`, etc. are all excluded from caching.

The `never_cache` array in `CacheConfig` lets you add additional patterns on top of these built-in ones.

### Always-cache defaults

The following tools have built-in default TTLs that apply even without explicit configuration:

| Tool name | Default TTL |
|-----------|-------------|
| `read_file` | 30s |
| `list_directory` | 30s |
| `git_status` | 15s |
| `git_log` | 30s |
| `search` | 60s |
| `git_diff` | 15s |

These defaults are overridden by any explicit `tool_ttls` or `server_ttls` entry. They serve as sensible starting points for common MCP tools.

---

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-v, --verbose` | boolean | `false` | Log all JSON-RPC messages to stderr. Useful for debugging transport and protocol issues. |
| `--compression <level>` | string | `"standard"` | Set the compression level. Must be `none`, `standard`, or `aggressive`. |
| `--no-cache` | boolean | `false` | Disable response caching entirely. Equivalent to setting `cache.enabled: false`. |
| `--no-lazy` | boolean | `false` | Disable lazy loading. All tools receive their full schemas upfront. |
| `--max-tools <N>` | integer | `8` | Maximum number of tools with full schemas when lazy loading is active. |
| `--url <url>` | string | -- | Connect to a single remote MCP server at the given URL. |
| `--header <key:value>` | string | -- | Set an HTTP header for the remote server. Can be repeated for multiple headers. Requires `--url`. |
| `--transport <type>` | string | auto | Force the transport type to `http` (Streamable HTTP) or `sse` (legacy SSE). Only applies to remote servers. When omitted, auto-detection is used. |
| `--config <path>` | string | -- | Path to a specific config file. Skips the normal discovery process. |
| `-h, --help` | -- | -- | Print usage information and exit. |

---

## Operating Modes

slim-mcp operates in one of four mutually exclusive modes, determined by the arguments provided:

### 1. Single stdio server

```bash
slim-mcp -- <command> [args...]
```

Launches `<command>` as a child process and connects via stdio. Everything after `--` is treated as the command and its arguments.

```bash
slim-mcp -- npx -y @modelcontextprotocol/server-filesystem /home/user
slim-mcp --compression aggressive -- python my_server.py --port 0
```

### 2. Single remote server

```bash
slim-mcp --url <url> [--header <key:value>]... [--transport <type>]
```

Connects to a single remote MCP server over HTTP. Cannot be combined with the `--` separator.

```bash
slim-mcp --url https://mcp.example.com/v1
slim-mcp --url https://mcp.example.com/v1 --header "Authorization:Bearer tok_abc" --transport sse
```

### 3. Explicit config file

```bash
slim-mcp --config <path>
```

Loads the specified config file. Supports multiple servers.

```bash
slim-mcp --config ./my-project/.slim-mcp.json
```

### 4. Auto-discovery

```bash
slim-mcp
```

With no positional arguments and no `--url`, slim-mcp searches for `.slim-mcp.json` in the working directory then the home directory.

---

## CLI Override Precedence

When both a config file and CLI flags are present, CLI flags take precedence:

| CLI Flag | Config field overridden |
|----------|----------------------|
| `--compression <level>` | `compression` |
| `--no-cache` | `cache.enabled` (set to `false`) |
| `--no-lazy` | `lazy_loading` (set to `false`) |
| `--max-tools <N>` | `max_tools_loaded` |

Flags not provided on the command line leave the config file values unchanged. If neither CLI nor config specifies a value, the documented default applies.

---

## Full Examples

### Minimal config -- single stdio server

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

### Multiple servers with mixed transports

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/project"],
      "always_load": ["read_file", "write_file", "list_directory"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "remote-search": {
      "url": "https://search.internal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCH_API_KEY}",
        "X-Team": "engineering"
      },
      "cache_ttl": 300
    }
  },
  "compression": "standard",
  "lazy_loading": true,
  "max_tools_loaded": 10
}
```

### Aggressive caching setup

```json
{
  "servers": {
    "database": {
      "command": "db-mcp-server",
      "args": ["--readonly"]
    },
    "docs": {
      "url": "https://docs-api.example.com/mcp",
      "type": "sse"
    }
  },
  "compression": "aggressive",
  "cache": {
    "enabled": true,
    "default_ttl": 120,
    "max_entries": 2000,
    "server_ttls": {
      "database": 30,
      "docs": 600
    },
    "tool_ttls": {
      "database__query": 15,
      "docs__search": 300
    },
    "never_cache": ["database__explain"]
  }
}
```

### CLI-only usage (no config file)

```bash
# Local server, verbose, no caching
slim-mcp --verbose --no-cache -- npx -y @modelcontextprotocol/server-filesystem .

# Remote server with auth header and forced SSE transport
slim-mcp --url https://mcp.example.com --header "Authorization:Bearer $TOKEN" --transport sse

# Local server with aggressive compression and limited tool loading
slim-mcp --compression aggressive --max-tools 4 -- python my_server.py
```

# How It Works

Deep dive into slim-mcp's architecture and internals for developers who want to understand the codebase, contribute, or debug issues.

## Module Overview

| Module | Purpose |
|--------|---------|
| `src/proxy.ts` | Both proxy modes -- single-server (JSON-RPC passthrough) and multi-server (MCP SDK server) -- plus shutdown coordination |
| `src/pipeline.ts` | Shared `tools/list` transform (lazy + batch compression + stats) and `tools/call` interception (promotion, cache) used by both modes |
| `src/compress.ts` | Schema compression engine -- structural cleanup, description trimming, param dedup, signature embedding |
| `src/config.ts` | Config file parsing, strict validation, env var expansion |
| `src/server-manager.ts` | Multi-server lifecycle -- connect, paginated tool listing, namespace, route calls, follow upstream changes, shutdown |
| `src/cli.ts` | CLI argument parsing and dashboard policy |
| `src/index.ts` | Entry point -- mode selection |
| `src/lazy.ts` | Lazy loading -- slim indexes, tool promotion, budget management |
| `src/cache.ts` | Response cache -- TTL, LRU eviction, write invalidation with in-flight race protection, stats |
| `src/stats.ts`, `src/dashboard.ts`, `src/dashboard-html.ts` | Stats collector and the live dashboard (HTTP + SSE) |
| `src/transport/http.ts` | HTTP/SSE transport factory -- typed creation and auto-detect |
| `src/tokens.ts` | Token estimation -- `JSON.stringify(tool).length / 4` heuristic |
| `src/logger.ts` | Stderr logging with `[slim-mcp]` prefix, verbose toggle |
| `src/version.ts` | Package version, read once from `package.json` |

---

## Two Proxy Modes

slim-mcp operates in one of two modes depending on how it is invoked. Both modes apply the same processing pipeline (compression, lazy loading, caching) but differ in how they handle MCP protocol messages.

### Single-Server Mode (JSON-RPC Passthrough)

Activated when running `slim-mcp -- command args...`. This mode sits between the agent and a single upstream MCP server as a transparent message-level proxy. No MCP protocol negotiation happens inside slim-mcp itself.

**Transport setup:**

- **Downstream**: `StdioServerTransport` -- reads JSON-RPC from the agent's stdin, writes to the agent's stdout.
- **Upstream**: `StdioClientTransport` -- spawns the MCP server as a child process, communicates via its stdin/stdout. stderr is inherited (passed through to the terminal).

The upstream child inherits the full parent environment (`PATH`, proxy settings, npm config), same as multi-server mode.

**Message flow -- agent to upstream (requests):**

1. Every request is recorded in `PendingRequests` (`id → { method, ticket? }`) until its response arrives.
2. `tools/call` goes through `ToolPipeline.beginCall()` (see [Call pipeline](#call-pipeline)). If the pipeline answers locally (cache hit, or a slim tool called with arguments that do not match its schema) the response is sent straight back and nothing is forwarded.
3. `notifications/cancelled` drops the pending entry for that request.
4. Everything else is forwarded unchanged.

**Message flow -- upstream to agent (responses):**

1. Responses (results *and* JSON-RPC errors) are matched to their pending entry by `id`; the entry is removed either way, so nothing leaks.
2. `initialize` result: `capabilities.tools.listChanged` is set to `true` (unless `--no-lazy`) so the agent re-fetches tools after a promotion.
3. `tools/list` result: on the first non-paginated response with >15 tools, lazy loading activates. The tool list is passed through `ToolPipeline.transformToolList()`. Paginated responses are compressed but not lazy-loaded.
4. `tools/call` result or error: `ToolPipeline.completeCall()` records stats and caches successful, cacheable results.
5. Everything else (notifications, server→client requests like `roots/list` or sampling) is forwarded unchanged.

**Shutdown:** the proxy exits on the first of: agent closes stdin (the MCP stdio shutdown signal), `SIGINT`/`SIGTERM`/`SIGHUP`, or the upstream exiting. The upstream gets stdin EOF, then `SIGTERM`, then `SIGKILL`.

### Multi-Server Mode (MCP SDK Server)

Activated when running with `--config`, `--url`, or when a `.slim-mcp.json` file is auto-discovered. This mode creates a proper MCP `Server` instance from the SDK that handles protocol negotiation (capabilities, initialize/initialized handshake) on the agent side. On the upstream side, it connects to one or more MCP servers via the `ServerManager`.

**MCP Server setup:**

The server always declares `tools: { listChanged: true }`. It declares `resources` and `prompts` only if at least one connected upstream does, and registers those handlers only then.

**`tools/list` handler:**

1. Call `serverManager.getMergedTools(useNamespace)` to collect tools from all connected servers. If 2+ servers are connected, tools are namespaced with `servername__` prefix.
2. If lazy loading is active, call `lazyManager.getToolList(tools)` to split into full and slim tools.
3. Compress full tools only (slim tools pass through). Skip compression entirely if level is `none`.
4. Return the tool list.

**`tools/call` handler:** `ToolPipeline.beginCall()` decides (see [Call pipeline](#call-pipeline)); forwarded calls are routed via `serverManager.routeToolCall()` with the agent's cancellation signal attached. Upstream errors become `{ isError: true }` results.

**`resources/list` / `resources/templates/list`:** Queried on all resource-capable servers in parallel; the proxy remembers which server listed each URI.

**`resources/read`:** Goes to the server that listed the URI; falls back to trying each resource-capable server.

**`prompts/list` / `prompts/get`:** Same ownership routing as resources. If no server has the prompt, the error lists each server's failure.

**Upstream changes:** When an upstream sends `notifications/tools/list_changed`, the proxy re-fetches that server's tools, invalidates its cache, and notifies the agent. When an upstream process dies, it is marked `disconnected` (visible in the dashboard), its tools disappear from `tools/list`, and the agent is notified.

**Shutdown:** same triggers as single-server mode; all upstream clients are closed (5s cap each).

### Call pipeline

`ToolPipeline.beginCall(name, args)` in `src/pipeline.ts`:

1. **Slim tool?** Promote it and notify the agent (`tools/list_changed`). If `args` validate against the tool's full `inputSchema` (Ajv, via the MCP SDK), continue -- the call goes through in one round trip. Otherwise answer with an error that contains the full schema and asks for a retry.
2. **Cacheable?** (`shouldCache`, see [Write Detection](#write-detection-and-invalidation)). If not: count a skip and invalidate that server's cache. If yes: return a cache hit locally, or remember the server's cache *generation* and forward.
3. `completeCall()` stores the result only if it succeeded and no write invalidated the server while the call was in flight.

---

## Server Manager

`createServerManager(configs)` in `src/server-manager.ts` returns a `ServerManager` that owns connections to all upstream servers.

### Connection (`connectAll`)

Connects to all configured servers in parallel via `Promise.allSettled`. Each connection attempt:

1. Creates an MCP `Client` instance.
2. Establishes the transport:
   - **Stdio**: `StdioClientTransport` with `command`, `args`, and merged `env` (process env + config env). stderr is piped, and the last 20 lines are retained for error diagnostics (and logged with `--verbose`).
   - **HTTP with explicit type**: Creates transport via `createTypedTransport()`.
   - **HTTP with auto-detect**: Calls `connectWithAutoDetect()` which tries Streamable HTTP first, then falls back to SSE on a fresh `Client`.
3. Fetches every page of `tools/list` (servers without the `tools` capability contribute none).
4. Stores the `ManagedServer` record: `{ name, client, tools, connected: true, transport }` and subscribes to `tools/list_changed` and to transport close.

Each connection has a **30-second timeout**. On failure or timeout the client is closed (killing any spawned child) and a disconnected placeholder is stored -- this is not fatal to the proxy.

### Tool Merging (`getMergedTools`)

Returns all tools from connected servers. When `namespace` is true (happens when 2+ servers are connected), each tool name is prefixed:

```
servername__toolname
```

The `__` double-underscore separator is used consistently. `parseNamespacedToolName()` splits on the first `__` to recover the server name and original tool name.

### Tool Call Routing (`routeToolCall`)

Two paths:

- **Namespaced**: Parse `servername__toolname`, look up the server in the map, call `client.callTool()` with the original (un-namespaced) tool name.
- **Non-namespaced** (single connected server): Iterate all connected servers, find the first one whose tool list contains the requested name, route to it.

### Resource Routing (`routeResourceRead`)

Tries each connected server in insertion order. Returns the first successful result. If no server can serve the URI, throws.

### Shutdown

Calls `client.close()` on all connected servers in parallel. For stdio servers this terminates the child process; for HTTP/SSE it closes the transport.

---

## Compression Pipeline

Defined in `src/compress.ts`. Three stages applied per-tool, with the third stage applied across all tools.

### Stage 1 -- Structural Cleanup (standard and aggressive)

Applied recursively to the tool's `inputSchema` and all nested properties:

- **Removes** `additionalProperties: false` (present in many auto-generated schemas, adds nothing for LLM usage).
- **Removes** `$schema` declarations.
- **Removes** empty `description` strings (`""`).
- **Removes** `title` fields from property schemas.
- **Removes** descriptions that merely restate a default value (patterns: "Default: X", "Defaults to X").
- **Flattens** single-element `anyOf`/`oneOf` wrappers. If an `anyOf` contains one item, the wrapper is removed and the inner schema is merged into the parent. Common in Pydantic/Zod-generated schemas.
- **Converts** nullable patterns: `anyOf: [{type: "X"}, {type: "null"}]` becomes `{type: ["X", "null"]}` (valid JSON Schema; `null` is added to any `enum`).

The `cleanProperty()` function recurses into nested `properties` objects and `items` (array schemas), so deeply nested schemas are cleaned too.

### Stage 2 -- Description Trimming (standard and aggressive)

**Standard mode:**
- Tool-level descriptions truncated to 200 characters.
- Property descriptions truncated to 100 characters.

**Aggressive mode:**
- Tool-level descriptions truncated to 100 characters.
- Property descriptions stripped entirely if the parameter name is self-evident.

Truncation is sentence-aware: `truncateDesc()` looks for the last sentence boundary (`. ` followed by more text) within the character limit. If found, it cuts at the period. Otherwise, it hard-truncates at the limit.

**Self-evident detection** (`shouldStripDescription`):

A set of 30 common parameter names is maintained in `OBVIOUS_PARAM_NAMES`:

```
path, query, url, name, id, content, message, owner, repo,
file, directory, pattern, limit, offset, cursor, format, title,
description, body, text, value, key, type, label, tag, ref
```

A description is stripped (in aggressive mode) when:
1. The property name is in `OBVIOUS_PARAM_NAMES`, OR
2. The description merely restates the property name (fuzzy: lowercase, strip articles, check if the prop name appears in the description).

A description is always kept when it contains non-obvious constraints, detected by the pattern `/:\s*\w.*,|must|between|one of|format|enum/i`. This preserves enum lists, format specifications, and range constraints.

### Stage 3 -- Parameter Deduplication (aggressive only)

Applied across all tools after per-tool compression:

1. Build a `Map<string, boolean>` keyed on `"propertyName:type"` (e.g., `"path:string"`, `"limit:number"`).
2. For each property in each tool's `inputSchema.properties`:
   - If this is the first occurrence of the key: record it, keep full definition.
   - If already seen: strip to `{ type }` only (delete all other keys like `description`, `enum`, `default`).

The assumption is that the LLM can infer repeated parameters from context once it has seen the first full definition.

---

## Lazy Loading

Defined in `src/lazy.ts`. The lazy loading system reduces context window usage by serving most tools as minimal "slim" stubs and only providing full schemas for a budgeted subset.

### Activation

- **Single-server mode**: Auto-activates on the first `tools/list` response if the server has >15 tools. Disabled with `--no-lazy`.
- **Multi-server mode**: Auto-activates if total tools across all servers >15, unless `lazy_loading: false` in config or `--no-lazy` on CLI. If `lazy_loading` is explicitly set in config (true or false), that takes precedence over auto-detection.

### State

`createLazyToolManager` returns a manager with internal state:

- **`toolStore: Map<string, Tool>`** -- Full definitions of ALL tools, always populated regardless of what the agent sees.
- **`promoted: Set<string>`** -- Tools promoted during this session. Persists across `getToolList()` calls.
- **`slimSet: Set<string>`** -- Tools currently served as slim. Rebuilt on every `getToolList()` call.

### The `getToolList` Algorithm

Called on every `tools/list` response. Receives the full tool array.

1. Store all tools in `toolStore`.
2. Build the "full" set (capped at `maxToolsLoaded`, default 8):
   - Add all `alwaysLoad` tools (from config `always_load` per server).
   - Add all previously `promoted` tools.
   - Fill remaining budget with tools matching `HIGH_PRIORITY_PATTERNS`: `/^(search|list|read|get|find|describe|info)/i`, tested against the bare name (after any `server__` prefix). These are common read operations that agents tend to call first.
3. Build the result list preserving original order:
   - Tools in the full set: returned as-is.
   - All others: converted to slim format.

### Slim Tool Format

```json
{
  "name": "original_tool_name",
  "description": "Original description preserved",
  "inputSchema": { "type": "object" }
}
```

`title`, `annotations` (e.g. `destructiveHint`) and other tool-level metadata are kept; only `inputSchema` and `outputSchema` are dropped. The agent knows the tool exists and what it does, but not the exact arguments.

### Promotion Flow

1. Agent calls a slim tool with arguments guessed from the description.
2. The proxy promotes the tool and sends `notifications/tools/list_changed`.
3. If the arguments validate against the full schema, the call is forwarded normally -- no extra round trip.
4. Otherwise the proxy returns an error that embeds the full definition:
   ```json
   {
     "content": [{ "type": "text", "text": "Tool schema was not fully loaded (arguments rejected: ...). It has been loaded now. Please retry your call with arguments matching this definition:\n{...}" }],
     "isError": true
   }
   ```
5. The agent retries with correct arguments. The next `tools/list` also shows the full schema.

### Budget Overflow

There is no hard cap preventing the full set from exceeding `maxToolsLoaded`. The `alwaysLoad` and `promoted` sets are always included, even if they alone exceed the budget. The budget only limits how many additional high-priority pattern matches are added. In practice, promotions accumulate over a session, so the full set grows as the agent discovers more tools.

---

## Cache Architecture

Defined in `src/cache.ts`. The `ResponseCache` class caches upstream `tools/call` responses to avoid redundant calls.

### Cache Key

```
serverName:toolName:stableHash(args)
```

**`stableHash(args)`**: SHA-256 (base64url) of a canonical JSON string with sorted keys and `undefined` members dropped, so `{a:1, b:2}` and `{b:2, a:1}` share a key. Server and tool names are JSON-quoted in the key so names containing `:` cannot collide.

### Read Path (`get`)

1. Look up the composite key in the `Map`.
2. If not found: increment `misses`, return null.
3. If found but expired (`Date.now() - cachedAt > ttl * 1000`): delete entry, increment `misses`, return null.
4. If found and valid: increment `hits`, estimate tokens saved (`responseSize / 4`), move entry to end of Map (LRU freshness), return entry.

The LRU move is implemented by deleting and re-inserting: JavaScript `Map` preserves insertion order, so the entry moves to the end.

### Write Path (`set`)

1. If the caller passed a cache generation and the server was invalidated since, store nothing (a write raced this read).
2. Resolve TTL (see below). TTL `0` or `max_entries: 0` means store nothing.
3. Evict the oldest entries while at capacity.
4. Store the entry with `cachedAt: Date.now()`, the resolved TTL, hit count 0, and `responseSize` (JSON string length of the result).

### TTL Resolution

The `resolveTTL(serverName, toolName)` method checks in order:

1. `tool_ttls[serverName__toolName]` -- namespaced tool-specific TTL.
2. `tool_ttls[toolName]` -- bare tool-specific TTL.
3. `server_ttls[serverName]` -- server-level TTL.
4. Built-in TTL for well-known tools (`ALWAYS_CACHE_DEFAULTS`, e.g. `git_status: 15`, `read_file: 30`).
5. `default_ttl` -- global default (60 seconds if not configured).

First match wins. This allows fine-grained control: you can set a 5-minute TTL for `describe` tools while keeping a 15-second TTL for `git_status`.

### Write Detection and Invalidation

`shouldCache(toolName, annotations?)` decides, first match wins:

1. **User `never_cache`** patterns (case-insensitive regexes) → never cached.
2. **MCP annotations** from the upstream tool definition: `readOnlyHint: true` → cacheable; `readOnlyHint: false` or `destructiveHint: true` → never cached.
3. **Name heuristic.** The name is split into word tokens (snake_case, kebab-case, dotted, camelCase). If the first token is a read verb (`get`, `list`, `read`, `search`, `find`, `describe`, `fetch`, `show`, `view`, `query`, ...) it is cacheable. Otherwise, any mutating-verb token (`create`, `write`, `delete`, `update`, `set`, `post`, `send`, `commit`, `run`, `exec`, `click`, ...) makes it never cached. Whole tokens are compared, so `calculate` is not `call` and `postgres_schema` is not `post`, while `issue_create` and `git_commit` are caught.

When a write operation is detected, `invalidateServer(serverName)` removes ALL cache entries whose key starts with `serverName:`. This is a conservative strategy: a write to one tool invalidates all cached reads from that server, since the write may have changed the data those reads would return.

### Built-in Cache Defaults

`ALWAYS_CACHE_DEFAULTS` gives TTLs for well-known tools (e.g., `read_file: 30`, `git_status: 15`, `describe: 120`). They apply when no `tool_ttls` or `server_ttls` entry matches, and take precedence over `default_ttl`.

### Shutdown Report

On process exit, the cache logs:

```
Cache stats: 12 hits / 8 misses / 3 skips (60% hit rate)
Estimated tokens saved from cache: ~4,500
```

Token savings are estimated as `responseSize / 4` per cache hit, accumulated across all hits during the session.

---

## Transport Layer

Defined in `src/transport/http.ts` plus MCP SDK transports.

### Stdio

`StdioClientTransport` from the MCP SDK. Spawns the upstream server as a child process. Communication happens via the child's stdin (requests) and stdout (responses) using newline-delimited JSON-RPC messages.

In single-server mode, stderr is inherited (passed through to the terminal). In multi-server mode, stderr is piped and the last 20 lines are retained in a buffer -- if the connection fails, these lines are included in the error message for diagnostics.

### Streamable HTTP

`StreamableHTTPClientTransport` from the MCP SDK. The modern HTTP transport for MCP. Uses a single endpoint: POST for sending requests, optional SSE (Server-Sent Events) for streaming responses.

### Legacy SSE

`SSEClientTransport` from the MCP SDK. The older transport. GET to `/sse` for the event stream, POST to `/messages` for requests. Still common in deployed MCP servers.

### Auto-Detect

`connectWithAutoDetect(client, url, headers)` tries Streamable HTTP first:

1. Create `StreamableHTTPClientTransport`, call `client.connect()`.
2. If it succeeds, return `'http'`.
3. If it throws, create `SSEClientTransport`, call `client.connect()`.
4. If it succeeds, return `'sse'`.
5. If both fail, the second error propagates.

The caller must NOT call `client.connect()` again after auto-detect -- the function connects the client as a side effect.

All HTTP transports accept `requestInit: { headers }` for authentication tokens or other custom headers.

---

## Processing Pipeline

### `tools/list` request

```
tools/list request from agent
         |
         v
Collect tools from all upstream servers
         |
         v
Namespace (add servername__ prefix if 2+ servers connected)
         |
         v
Lazy loading: split into full + slim sets
         |
         v
Compression: apply stages 1-3 to full tools only
         |
         v
Return tool list to agent
```

### `tools/call` request

```
tools/call request from agent
         |
         v
Is tool slim? --yes--> Promote + notify list_changed
         |                         |
         no            args match full schema? --no--> Return error with full schema ("retry")
         |                         |
         |<-----------------------yes
         |
         v
Should cache? --no (write op)--> Invalidate server cache
         |                                   |
        yes                                  |
         |                                   v
Cache hit? --yes--> Return cached result    Route to upstream
         |
         no
         |
         v
Route to upstream server
         |
         v
Cache successful response (unless a write invalidated the server meanwhile)
         |
         v
Return result to agent
```

---

## Config System

Defined in `src/config.ts`. Handles config file discovery, parsing, validation, and environment variable expansion.

### Config File Discovery

`loadConfig(explicitPath?)`:

1. If `explicitPath` is provided: load that file, throw if not found.
2. Otherwise, check two candidates in order:
   - `$CWD/.slim-mcp.json`
   - `$HOME/.slim-mcp.json`
3. Return the first one found, or `null` if neither exists.

### Config Shape

```typescript
interface McpSlimConfig {
  servers: Record<string, ServerConfig>;  // required, at least 1 entry
  compression: 'none' | 'standard' | 'aggressive' | 'extreme' | 'maximum';  // default: 'standard'
  cache?: CacheConfig;
  max_tools_loaded?: number;
  lazy_loading?: boolean;
  dashboard?: { enabled?: boolean; port?: number; host?: string };
}
```

Each server must have exactly one of `command` (stdio) or `url` (HTTP/SSE). Having both or neither is a validation error. Server names must not contain `__`. Every field is type-checked (wrong types, negative numbers, invalid regexes in `never_cache`, non-http URLs are errors). Unknown keys produce a warning, so typos are visible.

### Environment Variable Expansion

`${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url` and `headers`. An unset variable with no default is left verbatim and a warning names it.

### Server-Level Cache TTL

If a server config has `cache_ttl`, it is automatically promoted into `cache.server_ttls[serverName]`. If no explicit `cache` block exists in the config but any server has `cache_ttl`, a default cache config is created (`enabled: true, default_ttl: 60, max_entries: 1000`).

---

## CLI Entry Point

Defined in `src/cli.ts` (parsing) and `src/index.ts` (mode selection). Everything after `--` belongs to the upstream command and is never interpreted, so `slim-mcp -- server --help` passes `--help` to the server. In the legacy positional form, everything after the command belongs to it too. Unknown options are an error.

### Mode Selection Priority

1. **`--url` present**: Build a synthetic single-server config and start in multi-server mode. Cannot be combined with an upstream command.
2. **Upstream command present** (after `--`, or legacy positional): single-server mode. Cannot be combined with `--config`.
3. **Otherwise**: load the config file (explicit `--config` or auto-discovered) and start in multi-server mode. If none is found, print usage and exit 1.

The dashboard is on by default in multi-server mode, off in single-server mode, forced on by `--dashboard-port`, and off with `--no-dashboard`.

### Flag Handling

- `--compression` on CLI overrides config file compression level (via `compressionExplicit` flag).
- `--no-cache` and `--no-lazy` are passed through to the proxy options.
- `--max-tools` sets the lazy loading budget.
- `--header key:value` is repeatable -- all headers are collected into an object.
- `--verbose` / `-v` enables debug-level logging.

---

## Token Estimation

Defined in `src/tokens.ts`. A single function:

```typescript
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
```

This is a rough heuristic. JSON character count divided by 4 approximates token count for typical JSON schemas. It overestimates for whitespace-heavy content and underestimates for dense content, but is sufficient for comparison and reporting purposes.

The `formatCompressionReport()` function produces human-readable output:

```
Compressed 45 tools: 12500 -> 8200 tokens (34% reduction)
```

---

## Logging

Defined in `src/logger.ts`. All output goes to stderr (stdout is reserved for JSON-RPC protocol messages).

Four levels:

- **`info(msg)`**: Always logged. Prefix: `[slim-mcp]`.
- **`warn(msg)`**: Always logged. Prefix: `[slim-mcp] WARN:`.
- **`error(msg)`**: Always logged. Prefix: `[slim-mcp] ERROR:`.
- **`debug(msg)`**: Only logged when verbose mode is enabled via `setVerbose(true)`. Same prefix as info. Used for JSON-RPC message dumps and per-tool compression details.

---

## Testing

Unit tests (`npm test`) have no network dependencies except `integration.test.ts`, which spawns the real filesystem server via `npx`. End-to-end tests (`npm run test:e2e`) drive the built proxy as a child process against `test/e2e/mock-server.ts`.

| Test file | What it covers |
|-----------|---------------|
| `compress.test.ts` | All compression stages, signature embedding, shared-param hoisting, `formatType`, input immutability |
| `config.test.ts`, `config-http.test.ts`, `config-validation.test.ts` | Config parsing, strict validation, defaults, env var expansion |
| `cache.test.ts` | Get/set, TTL, LRU, built-in TTLs, token-based classification, annotations, write/read race |
| `lazy.test.ts` | Slim format, promotion, budget, namespaced priority patterns, stats |
| `pipeline.test.ts` | Promotion with schema validation, batch compression under lazy loading, cache integration |
| `cli.test.ts` | Argument parsing, `--` passthrough, dashboard policy |
| `proxy.test.ts` | Pending-request tracking, exports and option types |
| `server-manager.test.ts` | Server lifecycle, namespacing, tool merging |
| `tokens.test.ts`, `transport-http.test.ts` | Token estimation, transport factory |
| `integration.test.ts` | Real filesystem server: compression, multi-server aggregation and routing |
| `e2e/*.test.ts` | Single/multi-server, caching, lazy loading, error handling, lifecycle (stdin EOF exit, child reaping, upstream crash, upstream `list_changed`) |

Run tests:

```bash
npm test           # or: npx vitest run
npm run test:watch # or: npx vitest
```

---

## Development

```bash
# Build TypeScript to dist/
npm run build

# Watch mode (rebuild on change)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

The project uses TypeScript with ES modules (`"type": "module"` in package.json). Node.js >= 18 is required. Runtime dependencies are `@modelcontextprotocol/sdk` and `zod` (used by the SDK's schema validation). Dev dependencies are `typescript` and `vitest`.

# How It Works

Deep dive into slim-mcp's architecture and internals for developers who want to understand the codebase, contribute, or debug issues.

## Module Overview

slim-mcp has 10 source files totaling ~2,060 lines:

| Module | Lines | Purpose |
|--------|-------|---------|
| `src/proxy.ts` | 586 | Core proxy logic -- single-server (JSON-RPC passthrough) and multi-server (MCP SDK server) modes |
| `src/compress.ts` | 293 | Schema compression engine -- 3 stages (structural cleanup, description trimming, param dedup) |
| `src/config.ts` | 245 | Config file parsing, validation, env var expansion |
| `src/server-manager.ts` | 235 | Multi-server lifecycle -- connect, list tools, namespace, route calls, shutdown |
| `src/index.ts` | 226 | CLI entry point -- arg parsing, mode selection |
| `src/lazy.ts` | 186 | Lazy loading -- slim indexes, tool promotion, budget management |
| `src/cache.ts` | 177 | Response cache -- TTL, LRU eviction, write invalidation, stats |
| `src/transport/http.ts` | 72 | HTTP/SSE transport factory -- typed creation and auto-detect |
| `src/tokens.ts` | 24 | Token estimation -- `JSON.stringify(tool).length / 4` heuristic |
| `src/logger.ts` | 19 | Stderr logging with `[slim-mcp]` prefix, verbose toggle |

---

## Two Proxy Modes

slim-mcp operates in one of two modes depending on how it is invoked. Both modes apply the same processing pipeline (compression, lazy loading, caching) but differ in how they handle MCP protocol messages.

### Single-Server Mode (JSON-RPC Passthrough)

Activated when running `slim-mcp -- command args...`. This mode sits between the agent and a single upstream MCP server as a transparent message-level proxy. No MCP protocol negotiation happens inside slim-mcp itself.

**Transport setup:**

- **Downstream**: `StdioServerTransport` -- reads JSON-RPC from the agent's stdin, writes to the agent's stdout.
- **Upstream**: `StdioClientTransport` -- spawns the MCP server as a child process, communicates via its stdin/stdout. stderr is inherited (passed through to the terminal).

**Message flow -- upstream to agent (responses):**

1. Check if the response ID matches a tracked `tools/list` request (via `RequestTracker`).
2. If it is a `tools/list` response:
   - Initialize the lazy manager on the first response if not disabled and the server has >15 tools.
   - Apply lazy loading (split tools into full and slim).
   - Apply compression to full tools only (slim tools pass through unchanged).
   - Forward the modified response to the agent.
3. If it is a `tools/call` response and there is a pending cache entry for that request ID:
   - Cache the result (only if the result has no `isError` flag).
   - Delete the pending entry.
   - Forward the response unchanged.
4. All other messages: forward unchanged.

**Message flow -- agent to upstream (requests):**

1. Track all requests with an `id` and `method` field in the `RequestTracker`.
2. If `tools/call` and the tool is slim:
   - Do NOT forward to upstream.
   - Add the tool to the promoted set.
   - Return an error response directly: "Tool schema was not fully loaded. It has been loaded now. Please retry your call."
3. If `tools/call` and the tool matches a never-cache pattern:
   - Record a skip in cache stats.
   - Invalidate all cache entries for the `_single` server.
   - Forward to upstream.
4. If `tools/call` and there is a cache hit:
   - Do NOT forward to upstream.
   - Return the cached result directly to the agent.
5. If `tools/call` and cache miss:
   - Store a pending entry mapping the request ID to `{ toolName, args }`.
   - Forward to upstream.
6. All other messages: forward unchanged.

**The RequestTracker** exists because JSON-RPC responses contain only the request `id`, not the method name. The tracker maintains a `Set<string | number>` of request IDs corresponding to `tools/list` calls. When a response arrives, the tracker identifies whether it is a `tools/list` response. The ID is consumed (deleted) after use to prevent memory leaks.

### Multi-Server Mode (MCP SDK Server)

Activated when running with `--config`, `--url`, or when a `.slim-mcp.json` file is auto-discovered. This mode creates a proper MCP `Server` instance from the SDK that handles protocol negotiation (capabilities, initialize/initialized handshake) on the agent side. On the upstream side, it connects to one or more MCP servers via the `ServerManager`.

**MCP Server setup:**

```typescript
const server = new Server(
  { name: 'slim-mcp', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);
```

The server declares support for tools, resources, and prompts. It then registers handlers for each.

**`tools/list` handler:**

1. Call `serverManager.getMergedTools(useNamespace)` to collect tools from all connected servers. If 2+ servers are connected, tools are namespaced with `servername__` prefix.
2. If lazy loading is active, call `lazyManager.getToolList(tools)` to split into full and slim tools.
3. Compress full tools only (slim tools pass through). Skip compression entirely if level is `none`.
4. Return the tool list.

**`tools/call` handler:**

1. If tool is slim: promote it and return error asking the agent to retry.
2. Resolve server name and original tool name (parse namespace if in multi-server mode).
3. Check cache:
   - If tool matches never-cache patterns: record skip, invalidate that server's cache entries.
   - If cache hit: return cached result immediately.
4. Route call to the correct upstream server via `serverManager.routeToolCall()`.
5. Cache successful results (no `isError` flag).
6. Return the result. On error, return `{ isError: true }` with the error message.

**`resources/list` handler:** Iterates all connected servers, calls `listResources()` on each, aggregates results. Servers that do not support resources are silently skipped.

**`resources/read` handler:** Delegates to `serverManager.routeResourceRead(uri)`, which tries each connected server in order until one succeeds.

**`prompts/list` handler:** Same aggregation pattern as resources -- collects from all connected servers.

**`prompts/get` handler:** Tries each connected server in order until one returns the requested prompt.

---

## Server Manager

`createServerManager(configs)` in `src/server-manager.ts` returns a `ServerManager` that owns connections to all upstream servers.

### Connection (`connectAll`)

Connects to all configured servers in parallel via `Promise.allSettled`. Each connection attempt:

1. Creates an MCP `Client` instance.
2. Establishes the transport:
   - **Stdio**: `StdioClientTransport` with `command`, `args`, and merged `env` (process env + config env). stderr is piped, and the last 20 lines are retained for error diagnostics.
   - **HTTP with explicit type**: Creates transport via `createTypedTransport()`.
   - **HTTP with auto-detect**: Calls `connectWithAutoDetect()` which tries Streamable HTTP first, then falls back to SSE.
3. Calls `client.listTools()` to fetch the tool catalog.
4. Stores the `ManagedServer` record: `{ name, client, tools, connected: true }`.

Each connection has a **30-second timeout** (`withTimeout` wrapper using `Promise.race`). Failed connections are stored as disconnected placeholders (`connected: false`, empty tools array) -- this is not fatal to the proxy.

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
- **Converts** nullable patterns: `anyOf: [{type: "X"}, {type: "null"}]` becomes `{type: "X", nullable: true}`.

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
   - Fill remaining budget with tools matching `HIGH_PRIORITY_PATTERNS`: `/^(search|list|read|get|find|describe|info)/i`. These are common read operations that agents tend to call first.
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

This is a valid MCP tool definition. The agent knows the tool exists and what it does (from the description), but cannot construct correct arguments because the `inputSchema` has no `properties` or `required` fields.

### Promotion Flow

1. Agent attempts to call a slim tool with guessed arguments.
2. The proxy intercepts the call before it reaches the cache or upstream server.
3. `promoteTools([toolName])` adds the tool name to the `promoted` set.
4. The proxy returns an error response:
   ```json
   {
     "content": [{ "type": "text", "text": "Tool schema was not fully loaded. It has been loaded now. Please retry your call." }],
     "isError": true
   }
   ```
5. The agent, seeing the error, typically requests a fresh `tools/list`.
6. On the next `tools/list`, the promoted tool appears with its full schema (it is now in the `promoted` set).
7. The agent retries with correct arguments.

### Budget Overflow

There is no hard cap preventing the full set from exceeding `maxToolsLoaded`. The `alwaysLoad` and `promoted` sets are always included, even if they alone exceed the budget. The budget only limits how many additional high-priority pattern matches are added. In practice, promotions accumulate over a session, so the full set grows as the agent discovers more tools.

---

## Cache Architecture

Defined in `src/cache.ts`. The `ResponseCache` class caches upstream `tools/call` responses to avoid redundant calls.

### Cache Key

```
serverName:toolName:stableHash(args)
```

**`stableHash(args)`**: Produces a deterministic hash regardless of key order.

1. `stableStringify(obj)`: Recursively serializes the object with sorted keys. Arrays preserve order. Primitives use `JSON.stringify`. The result is a canonical JSON string where `{a:1, b:2}` and `{b:2, a:1}` produce the same output.
2. **djb2 hash**: The canonical string is hashed using the djb2 algorithm (seed 5381, shift-and-add), producing a 32-bit unsigned integer.
3. Convert to base-36 string for compact representation.

### Read Path (`get`)

1. Look up the composite key in the `Map`.
2. If not found: increment `misses`, return null.
3. If found but expired (`Date.now() - cachedAt > ttl * 1000`): delete entry, increment `misses`, return null.
4. If found and valid: increment `hits`, estimate tokens saved (`responseSize / 4`), move entry to end of Map (LRU freshness), return entry.

The LRU move is implemented by deleting and re-inserting: JavaScript `Map` preserves insertion order, so the entry moves to the end.

### Write Path (`set`)

1. If at `max_entries` capacity and the key is new: evict the oldest entry (first key in the Map via `keys().next().value`), increment `evictions`.
2. Resolve TTL for this server+tool combination (see TTL resolution below).
3. Store the entry with `cachedAt: Date.now()`, the resolved TTL, hit count 0, and `responseSize` (JSON string length of the result).

### TTL Resolution

The `resolveTTL(serverName, toolName)` method checks in order:

1. `tool_ttls[serverName__toolName]` -- namespaced tool-specific TTL.
2. `tool_ttls[toolName]` -- bare tool-specific TTL.
3. `server_ttls[serverName]` -- server-level TTL.
4. `default_ttl` -- global default (60 seconds if not configured).

First match wins. This allows fine-grained control: you can set a 5-minute TTL for `describe` tools while keeping a 15-second TTL for `git_status`.

### Write Detection and Invalidation

`shouldCache(toolName)` checks the tool name against two pattern lists:

**Built-in `NEVER_CACHE_PATTERNS`** (5 regex groups):
- Mutating: `create`, `write`, `delete`, `remove`, `update`, `edit`, `modify`, `set`, `put`, `post`, `patch`, `push`, `move`, `rename`, `copy`
- Destructive: `drop`, `truncate`, `reset`, `clear`, `purge`, `destroy`, `kill`, `stop`, `start`, `restart`
- Communication: `send`, `notify`, `publish`, `emit`, `dispatch`, `broadcast`, `email`, `message`, `slack`
- Version control: `commit`, `merge`, `rebase`, `checkout`, `branch`, `tag`, `stash`, `cherry`
- Execution: `run`, `exec`, `execute`, `invoke`, `call`, `trigger`, `apply`, `deploy`

**User `never_cache`** patterns from config, compiled to case-insensitive regexes.

When a write operation is detected, `invalidateServer(serverName)` removes ALL cache entries whose key starts with `serverName:`. This is a conservative strategy: a write to one tool invalidates all cached reads from that server, since the write may have changed the data those reads would return.

### Built-in Cache Defaults

The `ALWAYS_CACHE_DEFAULTS` object provides suggested TTLs for common tool patterns (e.g., `read_file: 30`, `git_status: 15`, `describe: 120`). These are reference values but do not affect runtime behavior -- actual TTLs come from the config's `tool_ttls`, `server_ttls`, or `default_ttl`.

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
Is tool slim? --yes--> Promote tool + return error ("retry")
         |
         no
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
Cache successful response
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
  compression: 'none' | 'standard' | 'aggressive';  // default: 'standard'
  cache?: CacheConfig;
  max_tools_loaded?: number;
  lazy_loading?: boolean;
}
```

Each server must have exactly one of `command` (stdio) or `url` (HTTP/SSE). Having both or neither is a validation error.

### Environment Variable Expansion

`expandEnvVars()` replaces `${VAR_NAME}` patterns in `env` and `headers` values with the corresponding `process.env` value. If the variable is not set, the original `${VAR_NAME}` string is preserved (not replaced with empty string).

### Server-Level Cache TTL

If a server config has `cache_ttl`, it is automatically promoted into `cache.server_ttls[serverName]`. If no explicit `cache` block exists in the config but any server has `cache_ttl`, a default cache config is created (`enabled: true, default_ttl: 60, max_entries: 1000`).

---

## CLI Entry Point

Defined in `src/index.ts`. Parses command-line arguments and selects the proxy mode.

### Mode Selection Priority

1. **`--url` present**: Build a synthetic single-server config and start in multi-server mode. Cannot be combined with `--`.
2. **`--` present**: Everything after `--` is the upstream command. Start in single-server mode.
3. **`--config` present OR no positional args**: Try to load a config file (explicit path or auto-discover). Start in multi-server mode. If no config is found and no command, print usage and exit.
4. **Positional args present**: Treat first arg as command, rest as args. Start in single-server mode (legacy mode).

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

Three levels:

- **`info(msg)`**: Always logged. Prefix: `[slim-mcp]`.
- **`error(msg)`**: Always logged. Prefix: `[slim-mcp] ERROR:`.
- **`debug(msg)`**: Only logged when verbose mode is enabled via `setVerbose(true)`. Same prefix as info. Used for JSON-RPC message dumps and per-tool compression details.

---

## Testing

173 tests across 10 test files. All unit tests with no network dependencies. Integration tests spawn real MCP servers (filesystem server) as child processes.

| Test file | What it covers |
|-----------|---------------|
| `compress.test.ts` | All 3 compression stages: structural cleanup, description trimming, param dedup |
| `config.test.ts` | Config parsing, validation, defaults, env var expansion |
| `config-http.test.ts` | HTTP/SSE server config validation (url, type, headers) |
| `cache.test.ts` | Cache get/set, TTL expiry, LRU eviction, write invalidation, stats, stable hashing |
| `lazy.test.ts` | Slim format, promotion, budget, high-priority patterns, stats reporting |
| `tokens.test.ts` | Token estimation, compression report formatting |
| `transport-http.test.ts` | Transport factory creation for http/sse types |
| `proxy.test.ts` | RequestTracker, maybeCompressResponse, proxy exports and option types |
| `server-manager.test.ts` | Server lifecycle, namespacing, tool merging |
| `integration.test.ts` | End-to-end: compression with real server, multi-server aggregation and routing |

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

# Testing

## Table of Contents

- [Real-World Results](#real-world-results)
  - [Single Server (1 server, 8 tools)](#single-server-1-server-8-tools)
  - [Multi-Server (3 servers, 42 tools)](#multi-server-3-servers-42-tools)
  - [What Each Feature Did](#what-each-feature-did)
  - [Running It Yourself](#running-it-yourself)
- [Developer Reference](#developer-reference)
  - [Test Suite Overview](#test-suite-overview)
  - [Unit Tests](#unit-tests)
  - [End-to-End Tests](#end-to-end-tests)
  - [Smoke Tests](#smoke-tests)
  - [Writing New Tests](#writing-new-tests)

---

## Real-World Results

We tested slim-mcp against real MCP servers on a production machine running Claude Code. Here's what happened.

### Single Server (1 server, 8 tools)

The simplest case: one MCP server with 8 tools, discovered automatically from `~/.claude.json`.

```
Discovered 1 server:
  my-server (stdio) — from ~/.claude.json

✓ Connected to slim-mcp proxy
✓ Listed 8 tools from 1 server

Per-server results:
  my-server: 8 tools, called get_summary → OK

Cache test:
  repeated call to bridge_get_summary: cache hit ✓

Stats:
  Compressed 8 tools: 715 → 611 tokens (15% reduction)
  Lazy loading: disabled (8 tools ≤ 15 threshold)
```

With only 8 tools, lazy loading stays off (the threshold is 15). Compression still shaves 15% off the schemas. Caching works -- the second identical call returns instantly from cache.

### Two Servers (2 servers, 13 tools)

Two real MCP servers proxied through slim-mcp.

| Server | Type | Tools | Example Call | Result |
|--------|------|-------|--------------|--------|
| server-a | stdio | 8 | `server-a__get_summary` | OK |
| server-b | stdio | 5 | `server-b__search` | OK |
| **Total** | | **13** | | |

```
✓ Connected to slim-mcp proxy
✓ Listed 13 tools from 2 servers

Compressed 13 tools: 1,543 → 1,374 tokens (11% reduction)
Lazy loading: disabled (13 tools ≤ 15 threshold)

Cache test:
  repeated call to server-a__get_summary: cache hit ✓
```

At 13 tools, lazy loading stays off (threshold is 15). Compression removes 11%. Both servers' tools route correctly through the proxy.

### Three Servers with Lazy Loading (3 servers, 33 tools)

Adding a mock server with 20 tools pushes the total past the lazy loading threshold.

| Server | Type | Tools | Example Call | Result |
|--------|------|-------|--------------|--------|
| server-a | stdio | 8 | `server-a__get_summary` | OK |
| server-b | stdio | 5 | `server-b__search` | OK |
| mock | stdio (test) | 20 | `mock__read_data_0` | OK |
| **Total** | | **33** | | |

```
✓ Connected to slim-mcp proxy
✓ Listed 33 tools from 3 servers

Lazy loading: enabled (max 8 full)

Cache test:
  repeated call to server-a__get_summary: cache hit ✓
```

At 33 tools, lazy loading kicks in. Every tool starts as a slim one-liner. When the agent calls a tool, it gets promoted to its full schema on the fly.

All tools are namespaced (`server-a__get_summary`, `server-b__search`, `mock__read_data_0`) and route to the correct server.

### What Each Feature Did

| Feature | 1 server (8 tools) | 2 servers (13 tools) | 3 servers (33 tools) |
|---------|-------------------|---------------------|---------------------|
| **Compression** | 715 → 611 (15%) | 1,543 → 1,374 (11%) | Minimal on slim schemas |
| **Lazy loading** | Disabled | Disabled | Enabled (max 8 full) |
| **Caching** | Hit on 2nd call | Hit on 2nd call | Hit on 2nd call |
| **Namespacing** | Not needed | `server__tool` | `server__tool` |
| **Routing** | Direct passthrough | Correct per tool | Correct per tool |

Compression and lazy loading are complementary. Compression works best on full schemas (trimming descriptions, deduplicating parameters). Lazy loading works best with many tools (serving slim placeholders until needed). Together they stack.

### Running It Yourself

**Quick check** -- discovers your servers from `~/.claude.json` automatically:

```bash
npm run smoke-test
```

**Multi-server** -- uses a pre-built config with handoff + filesystem + mock:

```bash
npx tsx scripts/smoke-test-auto.ts --config scripts/smoke-test-multi.json
```

**Verbose** -- shows every stderr line from slim-mcp (compression per tool, cache decisions, routing):

```bash
npx tsx scripts/smoke-test-auto.ts --verbose
npx tsx scripts/smoke-test-auto.ts --config scripts/smoke-test-multi.json --verbose
```

**Manual Claude Code integration** -- actually swaps Claude Code to use slim-mcp as its proxy:

```bash
npm run smoke-test:setup    # Backup config, swap to slim-mcp
# ... use Claude Code normally, all tools go through slim-mcp ...
npm run smoke-test:revert   # Restore original config, restart Claude Code
```

The smoke test never modifies `~/.claude.json` (the manual setup script does, but backs up first and reverts cleanly).

---

## Developer Reference

### Test Suite Overview

```
220+ tests total
├── 190 unit tests    (10 files, ~65s)
├──  30 e2e tests     (5 files, ~110s)
├──   2 smoke tests   (single-server + multi-server)
└── 120 accuracy tests (8 scenarios × 5 levels × 3 runs, via Anthropic API)
```

```bash
npm test              # Unit tests
npm run test:e2e      # E2E tests (sequential, spawns processes)
npm run smoke-test    # Smoke test with real servers
ANTHROPIC_API_KEY=... npx tsx scripts/accuracy-test.ts  # Accuracy test
```

### Unit Tests

Unit tests live in `test/` (top level, excluding `test/e2e/`). They import modules directly and test with mock data -- no child processes, no network.

```bash
npm test                              # All unit tests
npm run test:watch                    # Watch mode
npx vitest run test/compress.test.ts  # Single file
```

| File | Module | What it covers |
|------|--------|----------------|
| `compress.test.ts` | Schema compression | Structural cleanup, description trimming, parameter dedup, extreme/maximum signature embedding |
| `config.test.ts` | Config parsing | JSON parsing, server validation, env var expansion |
| `config-http.test.ts` | HTTP/SSE config | URL/command XOR, type/headers validation |
| `cache.test.ts` | Response caching | TTL, LRU eviction, write invalidation, stats |
| `lazy.test.ts` | Lazy loading | Slim schemas, promotion, budget allocation |
| `transport-http.test.ts` | HTTP transport | Transport type creation, auto-detect logic |

### End-to-End Tests

E2E tests spawn slim-mcp as a real child process, connect an MCP SDK client over stdio, and verify behavior through the protocol.

```bash
npm run test:e2e
npx vitest run test/e2e/caching.test.ts --testTimeout 60000  # Single suite
```

Tests run sequentially (`--fileParallelism=false`) because each spawns a child process.

**Architecture:**

```
Test (Vitest + MCP Client)
    │ stdio
    ▼
slim-mcp (node dist/index.js)
    │ stdio
    ▼
Mock Server (npx tsx mock-server.ts --tools N)
```

The test asserts on both MCP protocol responses and stderr log output.

**Test suites:**

| File | What it tests |
|------|---------------|
| `single-server.test.ts` | Single-server mode, tool listing, tool calls, compression, verbose mode, unknown tool errors, shutdown |
| `multi-server.test.ts` | Multi-server mode, namespacing (`server__tool`), cross-server routing, mixed configs |
| `caching.test.ts` | Cache hits on repeated calls, misses on different args, `--no-cache` flag, cache stats |
| `lazy-loading.test.ts` | Slim schemas above threshold, full schemas below, `--no-lazy`, `--max-tools`, promotion, `always_load`, stats |
| `error-handling.test.ts` | Missing command, invalid config, empty config, bad flags, nonexistent tools, startup failures, crash recovery |

**Mock server** (`test/e2e/mock-server.ts`):

- `--tools N` controls how many tools are registered
- Names cycle through read/write/neutral prefixes (`read_data_0`, `create_record_1`, `process_data_2`, ...)
- Three schema complexities: simple (1 param), medium (2 params), complex (3 params with defaults)
- Returns predictable `mock:TOOLNAME:ARGS_JSON` responses

**Test harness** (`test/e2e/harness.ts`):

- `startHarness(args, opts?)` -- spawns slim-mcp, connects MCP client, collects stderr
- `stopHarness(harness)` -- closes client, waits for exit (timeout + SIGKILL fallback)
- `findStderr(harness, pattern)` -- searches stderr for a string or regex
- `waitForStderr(harness, pattern, timeout?)` -- polls for a stderr match

### Accuracy Tests

Validates that compressed tool schemas produce correct tool calls via the Anthropic API. This is not a unit test -- it makes real API calls and costs ~$0.20 per run.

```bash
ANTHROPIC_API_KEY=sk-... npx tsx scripts/accuracy-test.ts
ANTHROPIC_API_KEY=sk-... npx tsx scripts/accuracy-test.ts --runs 1  # Quick single run
```

**Methodology:**
- Model: Claude Sonnet 4
- 8 test scenarios per compression level (bridge_get_summary, fs_read, fs_list, fs_search, fs_info, fs_tree, bridge_read_spec, bridge_read_decisions)
- 3 runs per scenario for reliability
- 5 compression levels: none, standard, aggressive, extreme, maximum
- Total: 120 API calls per full run

**What it validates:**
- Tool selection: did the LLM pick the correct tool name?
- Argument presence: are all required arguments included?
- Argument types: are strings sent as strings, numbers as numbers?

**Results (March 2026):**

| Level | Accuracy | Token Reduction |
|-------|----------|-----------------|
| none | 100% | baseline |
| standard | 100% | 19% |
| aggressive | 100% | 35% |
| extreme | 100% | 72% |
| maximum | 100% | 77% |

### Smoke Tests

Smoke tests verify slim-mcp against real MCP servers. Unlike e2e tests, they depend on the host machine's configuration and aren't repeatable in CI.

**`scripts/smoke-test-auto.ts`** -- the primary script:

1. Discovers servers from `~/.claude.json` and `.mcp.json` (or uses `--config`)
2. Generates a temp `.slim-mcp.json` config (skipped with `--config`)
3. Spawns slim-mcp, connects as MCP client
4. Lists tools, calls one safe read-only tool per server
5. Tests cache hit on repeated call
6. Reports stats, cleans up

Flags: `--verbose` / `-v` for full stderr, `--config <path>` for custom config.

**`scripts/smoke-test-multi.json`** -- pre-built 3-server config (handoff + filesystem + mock).

**`scripts/smoke-test.sh`** -- manual Claude Code integration:
- Setup: reads Claude config, generates proxy config, backs up, swaps
- Revert (`--revert`): restores from backup, cleans up

### Writing New Tests

**Unit tests:**
- Place in `test/`, name as `<module>.test.ts`
- Import the module directly, use mock data
- No child processes or network

**E2E tests:**
- Place in `test/e2e/`
- Use `startHarness()` / `stopHarness()` from `harness.ts`
- Use the mock server with `--tools N`
- Assert on both MCP responses and stderr
- Always clean up in `afterEach`

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { startHarness, stopHarness, findStderr, type HarnessResult } from './harness.js';

const MOCK_SERVER = path.resolve(import.meta.dirname, 'mock-server.ts');

describe('my feature', () => {
  let harness: HarnessResult;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  it('does the thing', async () => {
    harness = await startHarness(['--', 'npx', 'tsx', MOCK_SERVER, '--tools', '10']);
    await harness.client.listTools();

    const result = await harness.client.callTool({
      name: 'read_data_0',
      arguments: { input: 'test' },
    });

    expect(result.content).toBeDefined();
    const logLine = findStderr(harness, 'expected log pattern');
    expect(logLine).toBeDefined();
  });
});
```

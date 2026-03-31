#!/usr/bin/env npx tsx
/**
 * slim-mcp Accuracy Test
 *
 * Tests whether compressed tool schemas still produce correct tool calls.
 * Uses the Anthropic API to send prompts and verify tool_use responses.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/accuracy-test.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/accuracy-test.ts --runs 1
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { compressTools, type CompressionLevel } from '../src/compress.js';

// ── Config ──────────────────────────────────────────────────────────────

const RUNS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--runs') || '3', 10);
const MODEL = 'claude-sonnet-4-20250514';
const LEVELS: CompressionLevel[] = ['none', 'standard', 'aggressive', 'extreme', 'maximum'];

interface TestCase {
  prompt: string;
  expectedTool: string;
  expectedArgs: Record<string, string>; // arg name → expected type
  requiredArgs: string[];
}

const TEST_CASES: TestCase[] = [
  {
    prompt: 'Get the current bridge summary',
    expectedTool: 'bridge_get_summary',
    expectedArgs: {},
    requiredArgs: [],
  },
  {
    prompt: 'Read the file at /root/apps/mcp-slim/README.md',
    expectedTool: 'fs_read',
    expectedArgs: { path: 'string' },
    requiredArgs: ['path'],
  },
  {
    prompt: 'List the contents of /root/apps/mcp-slim/src directory',
    expectedTool: 'fs_list',
    expectedArgs: { path: 'string' },
    requiredArgs: ['path'],
  },
  {
    prompt: 'Search for files matching "dashboard" in /root/apps/mcp-slim',
    expectedTool: 'fs_search',
    expectedArgs: { path: 'string', query: 'string' },
    requiredArgs: ['path', 'query'],
  },
  {
    prompt: 'Get file info/metadata for /root/apps/mcp-slim/package.json',
    expectedTool: 'fs_info',
    expectedArgs: { path: 'string' },
    requiredArgs: ['path'],
  },
  {
    prompt: 'Show the directory tree of /root/apps/mcp-slim/src',
    expectedTool: 'fs_tree',
    expectedArgs: { path: 'string' },
    requiredArgs: ['path'],
  },
  {
    prompt: 'Read the spec of the current work unit from the bridge',
    expectedTool: 'bridge_read_spec',
    expectedArgs: {},
    requiredArgs: [],
  },
  {
    prompt: 'Read the recent decisions from the bridge',
    expectedTool: 'bridge_read_decisions',
    expectedArgs: {},
    requiredArgs: [],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

async function getToolsFromServer(command: string, args: string[]): Promise<Tool[]> {
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
  const client = new Client({ name: 'accuracy-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

function mcpToolToAnthropicTool(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description || '',
    input_schema: (tool.inputSchema || { type: 'object' }) as Anthropic.Tool.InputSchema,
  };
}

interface TestResult {
  passed: boolean;
  toolCorrect: boolean;
  argsCorrect: boolean;
  actualTool: string | null;
  actualArgs: Record<string, unknown> | null;
  error: string | null;
}

function matchesTool(actual: string, expected: string): boolean {
  // Match exact or with any namespace prefix (e.g. handoff-mcp__bridge_get_summary)
  return actual === expected || actual.endsWith('__' + expected);
}

async function runTestCase(
  client: Anthropic,
  tools: Anthropic.Tool[],
  testCase: TestCase,
): Promise<TestResult> {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools,
      messages: [{ role: 'user', content: testCase.prompt }],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ContentBlock & { type: 'tool_use' } => block.type === 'tool_use',
    );

    if (!toolUse) {
      return { passed: false, toolCorrect: false, argsCorrect: false, actualTool: null, actualArgs: null, error: 'No tool_use in response' };
    }

    const toolCorrect = matchesTool(toolUse.name, testCase.expectedTool);
    const actualArgs = toolUse.input as Record<string, unknown>;

    // Check required args present
    let argsCorrect = true;
    const argErrors: string[] = [];
    for (const req of testCase.requiredArgs) {
      if (!(req in actualArgs)) {
        argsCorrect = false;
        argErrors.push(`missing required arg: ${req}`);
      }
    }

    // Check arg types
    for (const [name, expectedType] of Object.entries(testCase.expectedArgs)) {
      if (name in actualArgs) {
        const actual = typeof actualArgs[name];
        if (actual !== expectedType) {
          argsCorrect = false;
          argErrors.push(`${name}: expected ${expectedType}, got ${actual}`);
        }
      }
    }

    const passed = toolCorrect && argsCorrect;
    return {
      passed,
      toolCorrect,
      argsCorrect,
      actualTool: toolUse.name,
      actualArgs: actualArgs,
      error: argErrors.length > 0 ? argErrors.join(', ') : null,
    };
  } catch (err) {
    return {
      passed: false,
      toolCorrect: false,
      argsCorrect: false,
      actualTool: null,
      actualArgs: null,
      error: (err as Error).message,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('ERROR: ANTHROPIC_API_KEY not set. Skipping accuracy test.');
    process.exit(0);
  }

  log(`=== slim-mcp Accuracy Test ===`);
  log(`Model: ${MODEL}`);
  log(`Runs per test: ${RUNS}`);
  log(`Test cases: ${TEST_CASES.length}`);
  log(`Levels: ${LEVELS.join(', ')}`);
  log('');

  // Get real tools
  log('Fetching real tool schemas...');
  const handoffTools = await getToolsFromServer('node', ['/root/apps/handoff-mcp/dist/index.js']);
  const fsTools = await getToolsFromServer('node', ['/root/apps/filesystem-mcp/dist/index.js']);
  const allTools = [...handoffTools, ...fsTools];
  log(`Got ${allTools.length} tools (${handoffTools.length} handoff + ${fsTools.length} filesystem)\n`);

  const anthropic = new Anthropic();
  const summary: { level: string; passed: number; total: number; pct: number; notes: string[] }[] = [];

  for (const level of LEVELS) {
    log(`--- Compression: ${level} ---`);
    const compressed = compressTools(allTools, level);
    const apiTools = compressed.map(mcpToolToAnthropicTool);

    let totalPassed = 0;
    let totalTests = 0;
    const notes: string[] = [];

    for (const tc of TEST_CASES) {
      let runPassed = 0;
      for (let run = 0; run < RUNS; run++) {
        const result = await runTestCase(anthropic, apiTools, tc);
        totalTests++;
        if (result.passed) {
          runPassed++;
          totalPassed++;
        } else if (run === 0) {
          // Log first failure per test case
          const toolStatus = result.toolCorrect ? 'correct tool' : `wrong tool (got ${result.actualTool})`;
          const argStatus = result.argsCorrect ? 'correct args' : `bad args: ${result.error}`;
          notes.push(`${tc.expectedTool}: ${toolStatus}, ${argStatus}`);
        }
      }
      const icon = runPassed === RUNS ? '\u2713' : runPassed > 0 ? '~' : '\u2717';
      log(`  ${icon} ${tc.expectedTool}: ${runPassed}/${RUNS} passed`);
    }

    const pct = Math.round((totalPassed / totalTests) * 100);
    log(`  Result: ${totalPassed}/${totalTests} (${pct}%)\n`);
    summary.push({ level, passed: totalPassed, total: totalTests, pct, notes });
  }

  // Summary table
  log('=== Summary ===');
  log('| Level      | Accuracy | Notes |');
  log('|------------|----------|-------|');
  for (const s of summary) {
    const noteStr = s.notes.length > 0 ? s.notes.join('; ') : '';
    log(`| ${s.level.padEnd(10)} | ${(s.pct + '%').padEnd(8)} | ${noteStr} |`);
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});

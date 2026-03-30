#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const args = process.argv.slice(2);
let toolCount = 25;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tools') toolCount = parseInt(args[++i], 10);
}

const READ_PREFIXES = ['read_data', 'get_info', 'list_items', 'search_records', 'find_match', 'describe_schema'];
const WRITE_PREFIXES = ['create_record', 'update_entry', 'delete_item', 'write_data', 'send_message'];
const NEUTRAL_PREFIXES = ['process_data', 'transform_input', 'validate_config', 'analyze_text', 'compute_hash', 'format_output'];
const ALL_PREFIXES = [...READ_PREFIXES, ...WRITE_PREFIXES, ...NEUTRAL_PREFIXES];

const server = new McpServer({ name: 'mock-tools', version: '1.0.0' });

for (let i = 0; i < toolCount; i++) {
  const prefix = ALL_PREFIXES[i % ALL_PREFIXES.length];
  const name = `${prefix}_${i}`;
  const desc = `Mock tool #${i}: ${prefix.replace('_', ' ')}`;

  // Register with varying schema complexity
  if (i % 3 === 0) {
    // Simple: one string param
    server.tool(name, desc, { input: z.string().describe('Input value') }, async ({ input }) => ({
      content: [{ type: 'text' as const, text: `mock:${name}:${JSON.stringify({ input })}` }],
    }));
  } else if (i % 3 === 1) {
    // Medium: two params
    server.tool(name, desc, { input: z.string().describe('Input value'), count: z.number().describe('Count').default(1) }, async (args) => ({
      content: [{ type: 'text' as const, text: `mock:${name}:${JSON.stringify(args)}` }],
    }));
  } else {
    // Complex: three params with optional
    server.tool(name, desc, {
      input: z.string().describe('Input value'),
      format: z.enum(['json', 'text', 'csv']).describe('Output format').default('text'),
      verbose: z.boolean().describe('Enable verbose output').default(false),
    }, async (args) => ({
      content: [{ type: 'text' as const, text: `mock:${name}:${JSON.stringify(args)}` }],
    }));
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mock-server ready with ${toolCount} tools\n`);

import { describe, it, expect } from 'vitest';
import { compressTools, formatType, embedSignature, extractSharedParams, type CompressionLevel } from '../src/compress.js';

// Helper to make a minimal valid Tool
function makeTool(name: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  return {
    name,
    description: extra.description ?? `Tool ${name}`,
    inputSchema: {
      type: 'object' as const,
      properties,
      ...(extra.schemaExtra as Record<string, unknown>) ?? {},
    },
    ...(extra.toolExtra as Record<string, unknown>) ?? {},
  };
}

describe('compressTools', () => {
  describe('level: none', () => {
    it('returns tools unchanged', () => {
      const tools = [makeTool('foo', { a: { type: 'string', description: 'bar' } })];
      const result = compressTools(tools, 'none');
      expect(result).toEqual(tools);
    });
  });

  describe('Stage 1: structural cleanup', () => {
    it('removes additionalProperties: false from schema and properties', () => {
      const tool = makeTool('t', {
        path: { type: 'string', additionalProperties: false },
      }, { schemaExtra: { additionalProperties: false } });

      const [result] = compressTools([tool], 'standard');
      expect(result.inputSchema).not.toHaveProperty('additionalProperties');
      expect((result.inputSchema.properties as any).path).not.toHaveProperty('additionalProperties');
    });

    it('removes $schema properties', () => {
      const tool = makeTool('t', {
        path: { type: 'string', $schema: 'http://json-schema.org/draft-07' },
      }, { schemaExtra: { $schema: 'http://json-schema.org/draft-07' } });

      const [result] = compressTools([tool], 'standard');
      expect(result.inputSchema).not.toHaveProperty('$schema');
      expect((result.inputSchema.properties as any).path).not.toHaveProperty('$schema');
    });

    it('removes empty description fields', () => {
      const tool = makeTool('t', {
        path: { type: 'string', description: '' },
      });
      tool.description = '';

      const [result] = compressTools([tool], 'standard');
      expect(result).not.toHaveProperty('description');
      expect((result.inputSchema.properties as any).path).not.toHaveProperty('description');
    });

    it('removes title from parameter schemas but keeps tool-level title', () => {
      const tool = makeTool('t', {
        path: { type: 'string', title: 'The Path' },
      }, { toolExtra: { title: 'My Tool' } });

      const [result] = compressTools([tool], 'standard');
      expect(result.title).toBe('My Tool');
      expect((result.inputSchema.properties as any).path).not.toHaveProperty('title');
    });

    it('removes description that just restates default value', () => {
      const tool = makeTool('t', {
        limit: { type: 'number', description: 'Default: 10', default: 10 },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).limit).not.toHaveProperty('description');
    });

    it('keeps description that adds info beyond default value', () => {
      const tool = makeTool('t', {
        limit: { type: 'number', description: 'Max results to return. Default: 10', default: 10 },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).limit.description).toBe('Max results to return. Default: 10');
    });

    it('flattens single-element anyOf', () => {
      const tool = makeTool('t', {
        path: { anyOf: [{ type: 'string' }] },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).path).toEqual({ type: 'string' });
    });

    it('flattens single-element oneOf', () => {
      const tool = makeTool('t', {
        path: { oneOf: [{ type: 'number' }] },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).path).toEqual({ type: 'number' });
    });

    it('flattens nullable anyOf pattern', () => {
      const tool = makeTool('t', {
        path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).path).toEqual({ type: 'string', nullable: true });
    });

    it('does not flatten anyOf with 3+ elements', () => {
      const tool = makeTool('t', {
        val: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).val).toHaveProperty('anyOf');
    });

    it('never modifies tool names', () => {
      const tool = makeTool('my_tool_name', { a: { type: 'string' } });
      const [result] = compressTools([tool], 'standard');
      expect(result.name).toBe('my_tool_name');
    });

    it('handles tool with no properties', () => {
      const tool = { name: 'empty', inputSchema: { type: 'object' as const } };
      const [result] = compressTools([tool], 'standard');
      expect(result.name).toBe('empty');
    });

    it('handles tool with missing inputSchema gracefully', () => {
      const tool = { name: 'broken' } as any;
      const [result] = compressTools([tool], 'standard');
      expect(result.name).toBe('broken');
    });
  });

  describe('Stage 2: description trimming — standard', () => {
    it('truncates tool description to 200 chars, preserving first sentence', () => {
      const longDesc = 'Search for files by name. ' + 'X'.repeat(200);
      const tool = makeTool('t', {}, { description: longDesc });

      const [result] = compressTools([tool], 'standard');
      expect(result.description).toBe('Search for files by name.');
    });

    it('hard-truncates tool description at 200 if no sentence boundary', () => {
      const longDesc = 'X'.repeat(300);
      const tool = makeTool('t', {}, { description: longDesc });

      const [result] = compressTools([tool], 'standard');
      expect(result.description!.length).toBeLessThanOrEqual(200);
    });

    it('truncates property description to 100 chars', () => {
      const longPropDesc = 'The path to the file. ' + 'Y'.repeat(100);
      const tool = makeTool('t', {
        path: { type: 'string', description: longPropDesc },
      });

      const [result] = compressTools([tool], 'standard');
      expect((result.inputSchema.properties as any).path.description).toBe('The path to the file.');
    });

    it('does not truncate short descriptions', () => {
      const tool = makeTool('t', {
        path: { type: 'string', description: 'File path' },
      });
      tool.description = 'Search files';

      const [result] = compressTools([tool], 'standard');
      expect(result.description).toBe('Search files');
      expect((result.inputSchema.properties as any).path.description).toBe('File path');
    });
  });

  describe('Stage 2: description trimming — aggressive', () => {
    it('truncates tool description to 100 chars', () => {
      const longDesc = 'Search for files by name. ' + 'X'.repeat(100);
      const tool = makeTool('t', {}, { description: longDesc });

      const [result] = compressTools([tool], 'aggressive');
      expect(result.description).toBe('Search for files by name.');
      expect(result.description!.length).toBeLessThanOrEqual(100);
    });

    it('strips descriptions from common/obvious parameter names', () => {
      const tool = makeTool('t', {
        path: { type: 'string', description: 'The file path to search' },
        query: { type: 'string', description: 'The search query' },
        name: { type: 'string', description: 'The name of the thing' },
        id: { type: 'string', description: 'The unique identifier' },
      });

      const [result] = compressTools([tool], 'aggressive');
      const props = result.inputSchema.properties as any;
      expect(props.path).not.toHaveProperty('description');
      expect(props.query).not.toHaveProperty('description');
      expect(props.name).not.toHaveProperty('description');
      expect(props.id).not.toHaveProperty('description');
    });

    it('strips descriptions that just restate the property name', () => {
      const tool = makeTool('t', {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The repository name' },
      });

      const [result] = compressTools([tool], 'aggressive');
      const props = result.inputSchema.properties as any;
      expect(props.owner).not.toHaveProperty('description');
      expect(props.repo).not.toHaveProperty('description');
    });

    it('keeps descriptions with enum values or non-obvious constraints', () => {
      const tool = makeTool('t', {
        format: { type: 'string', description: 'Output format: json, csv, or xml' },
        threshold: { type: 'number', description: 'Must be between 0.0 and 1.0' },
      });

      const [result] = compressTools([tool], 'aggressive');
      const props = result.inputSchema.properties as any;
      expect(props.format).toHaveProperty('description');
      expect(props.threshold).toHaveProperty('description');
    });
  });

  describe('Stage 3: parameter deduplication — aggressive', () => {
    it('keeps first occurrence of repeated property, strips subsequent', () => {
      const ownerProp = { type: 'string', description: 'Repository owner login' };
      const tool1 = makeTool('list_repos', { owner: { ...ownerProp } });
      const tool2 = makeTool('get_repo', { owner: { ...ownerProp } });
      const tool3 = makeTool('delete_repo', { owner: { ...ownerProp } });

      const results = compressTools([tool1, tool2, tool3], 'aggressive');
      // Subsequent tools: stripped to { type: "string" } only
      const p2 = (results[1].inputSchema.properties as any).owner;
      const p3 = (results[2].inputSchema.properties as any).owner;

      expect(p2).toEqual({ type: 'string' });
      expect(p3).toEqual({ type: 'string' });
    });

    it('does not dedup properties with different types', () => {
      const tool1 = makeTool('t1', { limit: { type: 'number', description: 'Max results' } });
      const tool2 = makeTool('t2', { limit: { type: 'string', description: 'Rate limit header' } });

      const results = compressTools([tool1, tool2], 'aggressive');
      const p2 = (results[1].inputSchema.properties as any).limit;
      // Different types, so not deduped
      expect(p2.type).toBe('string');
    });

    it('does not apply dedup in standard mode', () => {
      const ownerProp = { type: 'string', description: 'Repository owner login' };
      const tool1 = makeTool('t1', { owner: { ...ownerProp } });
      const tool2 = makeTool('t2', { owner: { ...ownerProp } });

      const results = compressTools([tool1, tool2], 'standard');
      // In standard, both keep their descriptions (truncated but not stripped)
      const p2 = (results[1].inputSchema.properties as any).owner;
      expect(p2.description).toBe('Repository owner login');
    });
  });

  describe('Stage 4: signature embedding — extreme', () => {
    it('embeds TS-style signature in description and strips inputSchema', () => {
      const tool = makeTool('create_issue', {
        title: { type: 'string' },
        body: { type: 'string' },
      }, { description: 'Create a new issue', schemaExtra: { required: ['title'] } });

      const [result] = compressTools([tool], 'extreme');
      expect(result.description).toContain('Params:');
      expect(result.description).toContain('title: string (required)');
      expect(result.description).toContain('body: string');
      expect(result.inputSchema).toEqual({ type: 'object' });
    });

    it('formats enum types correctly', () => {
      const tool = makeTool('set_status', {
        status: { type: 'string', enum: ['open', 'closed', 'pending'] },
      });

      const [result] = compressTools([tool], 'extreme');
      expect(result.description).toContain('"open"|"closed"|"pending"');
    });

    it('formats array types correctly', () => {
      const tool = makeTool('add_labels', {
        labels: { type: 'array', items: { type: 'string' } },
      });

      const [result] = compressTools([tool], 'extreme');
      expect(result.description).toContain('labels: string[]');
    });

    it('formats nested object types', () => {
      const tool = makeTool('configure', {
        options: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } },
      });

      const [result] = compressTools([tool], 'extreme');
      expect(result.description).toContain('{limit: number?, offset: number?}');
    });

    it('handles tool with no properties', () => {
      const tool = makeTool('ping', {}, { description: 'Health check' });

      const [result] = compressTools([tool], 'extreme');
      expect(result.description).toBe('Health check');
      expect(result.inputSchema).toEqual({ type: 'object' });
    });

    it('never modifies tool names', () => {
      const tool = makeTool('my_tool', { x: { type: 'string' } });
      const [result] = compressTools([tool], 'extreme');
      expect(result.name).toBe('my_tool');
    });
  });

  describe('Stage 4: signature embedding — maximum', () => {
    it('uses short type names and ! for required', () => {
      const tool = makeTool('create_issue', {
        title: { type: 'string' },
        count: { type: 'number' },
        draft: { type: 'boolean' },
      }, { description: 'Create issue', schemaExtra: { required: ['title', 'count'] } });

      const [result] = compressTools([tool], 'maximum');
      expect(result.description).toContain('P:');
      expect(result.description).toContain('title:s!');
      expect(result.description).toContain('count:n!');
      expect(result.description).toContain('draft:b');
      expect(result.description).not.toContain('draft:b!');
    });

    it('uses s[] for string arrays', () => {
      const tool = makeTool('tag', {
        labels: { type: 'array', items: { type: 'string' } },
      });

      const [result] = compressTools([tool], 'maximum');
      expect(result.description).toContain('labels:s[]');
    });

    it('strips inputSchema to { type: "object" }', () => {
      const tool = makeTool('t', { x: { type: 'string' } });
      const [result] = compressTools([tool], 'maximum');
      expect(result.inputSchema).toEqual({ type: 'object' });
    });
  });

  describe('formatType', () => {
    it('returns short type for string', () => {
      expect(formatType({ type: 'string' }, true)).toBe('s');
      expect(formatType({ type: 'string' }, false)).toBe('string');
    });

    it('handles nullable', () => {
      expect(formatType({ type: 'string', nullable: true }, true)).toBe('s|null');
      expect(formatType({ type: 'string', nullable: true }, false)).toBe('string|null');
    });

    it('handles enum', () => {
      expect(formatType({ enum: ['a', 'b'] }, true)).toBe('"a"|"b"');
    });

    it('handles anyOf', () => {
      expect(formatType({ anyOf: [{ type: 'string' }, { type: 'number' }] }, false)).toBe('string|number');
      expect(formatType({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true)).toBe('s|n');
    });

    it('handles array with items', () => {
      expect(formatType({ type: 'array', items: { type: 'number' } }, true)).toBe('n[]');
    });

    it('defaults to string for unknown', () => {
      expect(formatType({}, true)).toBe('s');
      expect(formatType({}, false)).toBe('string');
    });
  });

  describe('Stage 5: shared param extraction', () => {
    it('extracts shared params when 3+ tools share them', () => {
      const tools = [
        makeTool('srv__list', { owner: { type: 'string' }, repo: { type: 'string' }, page: { type: 'number' } }, { schemaExtra: { required: ['owner', 'repo'] } }),
        makeTool('srv__get', { owner: { type: 'string' }, repo: { type: 'string' }, id: { type: 'number' } }, { schemaExtra: { required: ['owner', 'repo', 'id'] } }),
        makeTool('srv__create', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } }, { schemaExtra: { required: ['owner', 'repo', 'title'] } }),
      ];

      const compressed = compressTools(tools, 'extreme');
      // First tool should have shared params note
      expect(compressed[0].description).toContain('[srv shared params:');
      // Individual tools should have shared params removed from their signatures
      expect(compressed[1].description).not.toContain('owner');
      expect(compressed[2].description).not.toContain('owner');
    });

    it('does not extract when fewer than 3 tools', () => {
      const tools = [
        makeTool('t1', { x: { type: 'string' } }),
        makeTool('t2', { x: { type: 'string' } }),
      ];

      const compressed = compressTools(tools, 'extreme');
      expect(compressed[0].description).not.toContain('shared');
    });
  });
});

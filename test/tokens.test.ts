import { describe, it, expect } from 'vitest';
import { estimateTokens, formatCompressionReport } from '../src/tokens.js';

describe('estimateTokens', () => {
  it('estimates tokens as JSON length / 4', () => {
    const obj = { name: 'test', description: 'a tool' };
    const json = JSON.stringify(obj);
    expect(estimateTokens(obj)).toBe(Math.ceil(json.length / 4));
  });

  it('returns 1 for empty object', () => {
    expect(estimateTokens({})).toBe(1); // "{}" is 2 chars → ceil(2/4) = 1
  });

  it('handles arrays', () => {
    const arr = [{ a: 1 }, { b: 2 }];
    const json = JSON.stringify(arr);
    expect(estimateTokens(arr)).toBe(Math.ceil(json.length / 4));
  });

  it('handles strings', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil('"hello world"'.length / 4));
  });
});

describe('formatCompressionReport', () => {
  it('formats summary line with tool count, tokens, and percentage', () => {
    const report = formatCompressionReport({
      toolCount: 5,
      beforeTokens: 1000,
      afterTokens: 600,
    });
    expect(report).toContain('5 tools');
    expect(report).toContain('1000');
    expect(report).toContain('600');
    expect(report).toContain('40%');
  });

  it('handles zero before tokens without division error', () => {
    const report = formatCompressionReport({
      toolCount: 0,
      beforeTokens: 0,
      afterTokens: 0,
    });
    expect(report).toContain('0 tools');
    expect(report).toContain('0%');
  });
});

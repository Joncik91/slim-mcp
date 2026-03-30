import { describe, it, expect } from 'vitest';
import { createTypedTransport } from '../src/transport/http.js';

// ---------------------------------------------------------------------------
// createTypedTransport — factory unit tests
// ---------------------------------------------------------------------------
// These tests verify the factory creates transport objects without errors.
// They do NOT connect to real servers — they only check construction.

describe('createTypedTransport', () => {
  it('returns a transport object for type "http"', () => {
    const transport = createTypedTransport('http://localhost:8080', 'http');
    expect(transport).toBeDefined();
    expect(transport).not.toBeNull();
  });

  it('returns a transport object for type "sse"', () => {
    const transport = createTypedTransport('http://localhost:8080', 'sse');
    expect(transport).toBeDefined();
    expect(transport).not.toBeNull();
  });

  it('accepts optional headers without throwing', () => {
    const transport = createTypedTransport(
      'http://localhost:8080/mcp',
      'http',
      { Authorization: 'Bearer test-token', 'X-Custom': 'value' },
    );
    expect(transport).toBeDefined();
    expect(transport).not.toBeNull();
  });

  it('accepts empty headers object without throwing', () => {
    const transport = createTypedTransport(
      'http://localhost:8080/mcp',
      'sse',
      {},
    );
    expect(transport).toBeDefined();
  });

  it('throws on an invalid URL', () => {
    expect(() => createTypedTransport('not-a-url', 'http')).toThrow();
  });

  it('throws on an empty URL string', () => {
    expect(() => createTypedTransport('', 'http')).toThrow();
  });
});

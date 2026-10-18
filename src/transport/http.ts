import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { debug } from '../logger.js';

export type TransportType = 'http' | 'sse';

function requestOptions(headers?: Record<string, string>): { requestInit: RequestInit } | undefined {
  return headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
}

/**
 * Create transport for an explicit type (no auto-detection).
 */
export function createTypedTransport(
  url: string,
  type: TransportType,
  headers?: Record<string, string>,
): Transport {
  const parsedUrl = new URL(url);
  const opts = requestOptions(headers);
  return type === 'sse'
    ? new SSEClientTransport(parsedUrl, opts)
    : new StreamableHTTPClientTransport(parsedUrl, opts);
}

/**
 * Auto-detect: try Streamable HTTP first, fall back to legacy SSE.
 *
 * A Client cannot be reused after a failed connect (its close() is asynchronous),
 * so the fallback runs on a fresh Client from `makeClient`. The connected client
 * is whichever `makeClient` returned last (or `first` if HTTP succeeded).
 */
export async function connectWithAutoDetect(
  url: string,
  headers: Record<string, string> | undefined,
  makeClient: () => Client,
  first: Client,
): Promise<TransportType> {
  try {
    debug(`Auto-detecting transport for ${url} — trying Streamable HTTP...`);
    await first.connect(createTypedTransport(url, 'http', headers));
    debug(`Connected to ${url} via Streamable HTTP`);
    return 'http';
  } catch (httpErr) {
    debug(`Streamable HTTP failed for ${url} (${httpErr instanceof Error ? httpErr.message : String(httpErr)}) — falling back to SSE`);
    await first.close().catch(() => {});
    const fallback = makeClient();
    try {
      await fallback.connect(createTypedTransport(url, 'sse', headers));
    } catch (sseErr) {
      const h = httpErr instanceof Error ? httpErr.message : String(httpErr);
      const s = sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(`Streamable HTTP failed (${h}); SSE fallback failed (${s})`);
    }
    debug(`Connected to ${url} via SSE`);
    return 'sse';
  }
}

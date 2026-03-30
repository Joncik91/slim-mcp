import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { debug } from '../logger.js';

export type TransportType = 'http' | 'sse';

export interface HttpTransportResult {
  transport: Transport;
  detectedType: TransportType;
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
  const requestInit: RequestInit | undefined =
    headers && Object.keys(headers).length > 0 ? { headers } : undefined;

  if (type === 'sse') {
    return new SSEClientTransport(
      parsedUrl,
      requestInit ? { requestInit } : undefined,
    );
  }
  return new StreamableHTTPClientTransport(
    parsedUrl,
    requestInit ? { requestInit } : undefined,
  );
}

/**
 * Auto-detect: try Streamable HTTP connection first, fall back to SSE.
 *
 * This actually connects the client — the caller should NOT call
 * `client.connect()` again after this returns.
 */
export async function connectWithAutoDetect(
  client: Client,
  url: string,
  headers?: Record<string, string>,
): Promise<TransportType> {
  const parsedUrl = new URL(url);
  const requestInit: RequestInit | undefined =
    headers && Object.keys(headers).length > 0 ? { headers } : undefined;

  try {
    debug(`Auto-detecting transport for ${url} — trying Streamable HTTP...`);
    const httpTransport = new StreamableHTTPClientTransport(
      parsedUrl,
      requestInit ? { requestInit } : undefined,
    );
    await client.connect(httpTransport);
    debug(`Connected to ${url} via Streamable HTTP`);
    return 'http';
  } catch {
    debug(`Streamable HTTP failed for ${url} — falling back to SSE`);
    const sseTransport = new SSEClientTransport(
      parsedUrl,
      requestInit ? { requestInit } : undefined,
    );
    await client.connect(sseTransport);
    debug(`Connected to ${url} via SSE`);
    return 'sse';
  }
}

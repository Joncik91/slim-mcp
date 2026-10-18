// HTTP dashboard server for slim-mcp
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { stats, type StatsEvent } from './stats.js';
import { info, warn } from './logger.js';
import { getDashboardHTML } from './dashboard-html.js';

export interface DashboardConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export interface DashboardHandle {
  close(): Promise<void>;
}

const HEARTBEAT_MS = 5_000;
const SNAPSHOT_THROTTLE_MS = 250;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** When bound to loopback, only accept loopback Host headers (blocks DNS-rebinding reads). */
function hostAllowed(req: IncomingMessage, bindHost: string): boolean {
  if (!LOOPBACK_HOSTS.has(bindHost)) return true;
  const header = req.headers.host;
  if (!header) return false;
  const name = header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.split(':')[0];
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

export function startDashboard(config: DashboardConfig): DashboardHandle | null {
  if (!config.enabled) return null;

  const sseClients = new Set<ServerResponse>();
  let pendingSnapshot: NodeJS.Timeout | undefined;

  const broadcast = (payload: string) => {
    for (const res of sseClients) {
      if (res.destroyed || res.writableEnded) {
        sseClients.delete(res);
        continue;
      }
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const snapshotPayload = () => `event: stats_update\ndata: ${JSON.stringify(stats.getStats())}\n\n`;

  // Event-driven snapshots, coalesced so a burst of tool calls yields one update.
  const scheduleSnapshot = () => {
    if (pendingSnapshot || sseClients.size === 0) return;
    pendingSnapshot = setTimeout(() => {
      pendingSnapshot = undefined;
      broadcast(snapshotPayload());
    }, SNAPSHOT_THROTTLE_MS);
    pendingSnapshot.unref();
  };

  const unsubscribe = stats.onEvent((event: StatsEvent) => {
    if (sseClients.size === 0) return;
    broadcast(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    scheduleSnapshot();
  });

  // Periodic snapshot keeps uptime fresh and the connection alive through proxies.
  const heartbeat = setInterval(() => {
    if (sseClients.size > 0) broadcast(snapshotPayload());
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req, config.host)) {
      res.writeHead(403, { ...BASE_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/api/stats') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats.getStats()));
      return;
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write(snapshotPayload());
      sseClients.add(res);
      const drop = () => sseClients.delete(res);
      req.on('close', drop);
      res.on('error', drop);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
      return;
    }

    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  // The dashboard must never keep the proxy alive on its own.
  server.unref();

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    info(`Dashboard: http://${shown.includes(':') ? `[${shown}]` : shown}:${config.port}`);
    if (!LOOPBACK_HOSTS.has(config.host)) {
      const host = hostname();
      if (host) info(`Dashboard: http://${host}:${config.port}`);
      warn('Dashboard is reachable from the network and has no authentication');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    const hint = err.code === 'EADDRINUSE' ? ' (another slim-mcp instance may own it; use --dashboard-port)' : '';
    warn(`Dashboard failed to start on ${config.host}:${config.port}: ${err.message}${hint}`);
    cleanup();
  });

  function cleanup(): void {
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(pendingSnapshot);
    for (const res of sseClients) res.end();
    sseClients.clear();
  }

  return {
    close: () =>
      new Promise<void>((resolve) => {
        cleanup();
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

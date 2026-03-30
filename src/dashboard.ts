// HTTP dashboard server for slim-mcp
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { stats, type StatsEvent } from './stats.js';
import { info } from './logger.js';
import { getDashboardHTML } from './dashboard-html.js';

export interface DashboardConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export function startDashboard(config: DashboardConfig): void {
  if (!config.enabled) return;

  const sseClients = new Set<ServerResponse>();

  // Push events to SSE clients
  stats.onEvent((event: StatsEvent) => {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(data); } catch { sseClients.delete(res); }
    }
    // Also push a periodic stats snapshot
    const snapshot = JSON.stringify(stats.getStats());
    const statsData = `event: stats_update\ndata: ${snapshot}\n\n`;
    for (const res of sseClients) {
      try { res.write(statsData); } catch { sseClients.delete(res); }
    }
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    if (url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats.getStats()));
      return;
    }

    if (url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`event: stats_update\ndata: ${JSON.stringify(stats.getStats())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Serve dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
  });

  server.listen(config.port, config.host, () => {
    info(`Dashboard: http://localhost:${config.port}`);
    const host = hostname();
    if (host && host !== 'localhost') {
      info(`Dashboard: http://${host}:${config.port}`);
    }
  });

  server.on('error', (err: Error) => {
    info(`Dashboard failed to start: ${err.message}`);
  });
}

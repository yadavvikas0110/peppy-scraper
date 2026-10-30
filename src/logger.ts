import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { isAuthorizedUpgrade } from './utils/api-key';

export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'success';
  source: string;
  message: string;
}

const MAX_BUFFER = 500;
const logBuffer: LogEntry[] = [];
const clients = new Set<WebSocket>();

function detectLevel(msg: string): LogEntry['level'] {
  const m = msg.toLowerCase();
  if (m.includes('✗') || m.includes(' error') || m.includes('failed') || m.includes('fatal') || m.includes('⛔')) return 'error';
  if (m.includes('warn') || m.includes('skipping') || m.includes('cooling') || m.includes('stale lock')) return 'warn';
  if (m.includes('✓') || m.includes('complete') || m.includes(' done') || m.includes('success') || m.includes('inserted') || m.includes('pushed') || m.includes('triggered')) return 'success';
  return 'info';
}

function detectSource(msg: string): string {
  const m = msg.match(/^\[([^\]]+)\]/);
  return m ? m[1] : 'system';
}

export function broadcast(level: LogEntry['level'], source: string, message: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, source, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  const payload = JSON.stringify(entry);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

export function getLogs(): LogEntry[] {
  return [...logBuffer];
}

export function attachLogServer(server: http.Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws/logs',
    verifyClient: ({ req }: { req: http.IncomingMessage }) => isAuthorizedUpgrade(req),
  });
  wss.on('connection', (ws: WebSocket) => {
    // Send buffered history to new client
    for (const entry of logBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(entry));
    }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

// Intercepts all process stdout/stderr so every console.log/error in every module gets broadcast.
export function interceptConsole(): void {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    const msg = String(chunk).replace(/\r?\n$/, '').trim();
    if (msg) broadcast(detectLevel(msg), detectSource(msg), msg);
    return origOut(chunk, ...args);
  };

  (process.stderr as any).write = (chunk: any, ...args: any[]) => {
    const msg = String(chunk).replace(/\r?\n$/, '').trim();
    if (msg) broadcast('error', detectSource(msg), msg);
    return origErr(chunk, ...args);
  };
}

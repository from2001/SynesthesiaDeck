import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema, NativeMessageSchema, VERSION, FRAME_HZ,
  type ClientInfo, type ServerMessage, type ShowEvent,
} from '../shared/protocol.js';
import { Authority } from './authority.js';
import { MidiMapper, type MidiProfile } from './midi.js';

export interface ServerOptions {
  host?: string; port?: number; nativePort?: number; controlToken: string; nativeToken: string;
  publicOrigin?: string; allowedOrigins?: string[]; trustedProxy?: boolean;
  tls?: { cert: string | Buffer; key: string | Buffer };
  production?: boolean; distDirectory?: string; vite?: boolean; synthetic?: boolean;
  midiProfile?: MidiProfile; heartbeatMs?: number; helloTimeoutMs?: number;
  maxClients?: number; maxBufferedBytes?: number; leadMs?: number;
}
interface Peer {
  ws: WebSocket; info: ClientInfo; hello: boolean; alive: boolean;
  connectedAt: number; budget: number; budgetAt: number; helloTimer: ReturnType<typeof setTimeout> | null;
}
interface Ack { eventId: string; effectiveAt: number; at: number; command: string }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_BODY = 8192;
function authorize(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function originValue(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('An allowed origin must be an http(s) origin without a path or credentials');
  }
  return url.origin;
}
async function body(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new Error('Request body exceeds 8192 bytes');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body exceeds 8192 bytes');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function listen(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener has no TCP address');
  return address.port;
}
function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolveClose => server.close(() => resolveClose()));
}

/** Starts independently closable HTTP(S), WS(S), and authenticated loopback listeners. */
export async function startServer(options: ServerOptions) {
  const host = options.host ?? '127.0.0.1';
  for (const token of [options.controlToken, options.nativeToken]) {
    if (typeof token !== 'string' || token.length < 24 || token.length > 256) throw new Error('CONTROL_TOKEN and NATIVE_TOKEN must each contain 24–256 characters');
  }
  if (options.controlToken === options.nativeToken) throw new Error('Use separate dashboard and native credentials');
  if (!LOOPBACK.has(host) && !options.tls && !options.trustedProxy) throw new Error('LAN binding requires TLS_CERT/TLS_KEY or an explicitly trusted HTTPS reverse proxy');
  if ((!LOOPBACK.has(host) || options.trustedProxy) && !options.publicOrigin) throw new Error('PUBLIC_ORIGIN is required for LAN or reverse-proxy delivery');
  if (options.publicOrigin && !LOOPBACK.has(new URL(options.publicOrigin).hostname) && !options.publicOrigin.startsWith('https://')) throw new Error('Remote PUBLIC_ORIGIN must use HTTPS');
  if (options.trustedProxy && !options.publicOrigin?.startsWith('https://')) throw new Error('Trusted proxy PUBLIC_ORIGIN must use HTTPS');
  const origins = new Set((options.allowedOrigins ?? []).map(originValue));
  if (options.publicOrigin) origins.add(originValue(options.publicOrigin));
  const hosts = new Set([...origins].map(value => new URL(value).host));
  const peers = new Map<WebSocket, Peer>();
  const acknowledgments = new Map<string, Ack>();
  const midi = new MidiMapper(options.midiProfile);
  const maxBuffered = options.maxBufferedBytes ?? 256 * 1024;
  const maxClients = Math.min(128, options.maxClients ?? 32);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });
  let closed = false;
  let currentNativeBudget = 1200;
  let nativeBudgetAt = performance.now();
  let vite: import('vite').ViteDevServer | undefined;
  let publishedClientsAt = 0;

  function send(peer: Peer, message: ServerMessage): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > maxBuffered) {
      peer.ws.terminate();
      return;
    }
    peer.ws.send(JSON.stringify(message), error => { if (error) peer.ws.terminate(); });
  }
  function broadcast(message: ServerMessage, dashboardsOnly = false): void {
    for (const peer of peers.values()) if (peer.hello && (!dashboardsOnly || peer.info.role === 'dashboard')) send(peer, message);
  }
  const authority = new Authority({ leadMs: options.leadMs, synthetic: options.synthetic,
    onEvent: event => broadcast({ version: VERSION, type: 'event', event }),
    onCancel: () => { for (const peer of peers.values()) if (peer.hello) snapshot(peer); },
  });
  function snapshot(peer: Peer): void {
    const now = authority.now();
    authority.advance(now);
    const audioFrame = authority.audioFrame(now);
    send(peer, { version: VERSION, type: 'snapshot', clientId: peer.info.id, serverTime: now,
      state: authority.state, pending: authority.pending, audioFrame, source: authority.source });
  }
  function error(peer: Peer, message: string, requestId?: string): void {
    send(peer, { version: VERSION, type: 'error', message, ...(requestId ? { requestId } : {}) });
  }
  function publishClients(): void {
    broadcast({ version: VERSION, type: 'clients', clients: [...peers.values()].filter(peer => peer.hello).map(peer => peer.info) }, true);
    publishedClientsAt = authority.now();
  }

  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  async function mainRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) { json(res, 421, { error: 'Unrecognized Host header; configure PUBLIC_ORIGIN' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }); return; }
    const url = new URL(req.url ?? '/', 'http://local.invalid');
    if (url.pathname === '/health') { json(res, 200, { version: VERSION, epoch: authority.epoch, serverTime: authority.now(), clients: peers.size,
      source: authority.source, transport: options.tls ? 'https' : options.trustedProxy ? 'trusted-https-proxy' : 'loopback-http' }); return; }
    if (url.pathname === '/clock' || url.pathname === '/ingest') { json(res, 404, { error: 'Native bridge is loopback-only on its separate port' }); return; }
    if (vite) { vite.middlewares(req, res); return; }
    if (!options.production) { json(res, 404, { error: 'UI middleware disabled; start with npm run dev or build for production' }); return; }
    const dist = resolve(options.distDirectory ?? 'dist');
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { json(res, 400, { error: 'Malformed path' }); return; }
    if (pathname.split('/').some(part => part.startsWith('.') && part.length > 0)) { json(res, 404, { error: 'Not found' }); return; }
    const mapped = pathname === '/' || pathname === '/dashboard' || pathname === '/hmd' || pathname === '/preview' ? 'index.html' : pathname.slice(1);
    const file = resolve(dist, mapped);
    if (!file.startsWith(`${dist}${sep}`)) { json(res, 403, { error: 'Forbidden path' }); return; }
    try {
      const info = await stat(file);
      if (!info.isFile()) { json(res, 404, { error: 'Not found' }); return; }
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { json(res, 404, { error: 'Not found; run npm run build before production start' }); }
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => { void mainRequest(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Request failed' }); else res.end(); }); };
  const main = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler);
  main.requestTimeout = 10000;
  main.headersTimeout = 10000;
  main.on('upgrade', (req, socket, head) => {
    const validOrigin = origins.has(req.headers.origin ?? '');
    if (req.url !== '/ws' || !hosts.has(req.headers.host ?? '') || !validOrigin || peers.size >= maxClients) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const now = authority.now();
    const peer: Peer = { ws, hello: false, alive: true, connectedAt: now, budget: 120, budgetAt: now,
      info: { id: randomUUID(), name: 'Unauthenticated', role: 'hmd', lastSeen: now, telemetry: null }, helloTimer: null };
    peer.helloTimer = setTimeout(() => { if (!peer.hello) ws.terminate(); }, options.helloTimeoutMs ?? 5000);
    peers.set(ws, peer);
    ws.on('error', () => ws.terminate());
    ws.on('close', () => { if (peer.helloTimer) clearTimeout(peer.helloTimer); peers.delete(ws); publishClients(); });
    ws.on('pong', () => { peer.alive = true; peer.info.lastSeen = authority.now(); });
    ws.on('message', (data, binary) => {
      const now = authority.now();
      peer.budget = Math.min(120, peer.budget + (now - peer.budgetAt) * .12);
      peer.budgetAt = now;
      if (--peer.budget < 0) { ws.close(1008, 'Message rate exceeded'); return; }
      if (binary) { ws.close(1003, 'JSON text messages only'); return; }
      let parsed;
      try { parsed = ClientMessageSchema.safeParse(JSON.parse(data.toString())); }
      catch { error(peer, 'Malformed JSON'); return; }
      if (!parsed.success) { error(peer, 'Message does not match protocol v1'); return; }
      const message = parsed.data;
      if (message.type === 'hello') {
        if (peer.helloTimer) { clearTimeout(peer.helloTimer); peer.helloTimer = null; }
        if (peer.hello) { error(peer, 'Connection is already initialized'); return; }
        if (message.role === 'dashboard' && !authorize(`Bearer ${message.token ?? ''}`, options.controlToken)) {
          error(peer, 'Dashboard token is invalid'); ws.close(1008, 'Unauthorized'); return;
        }
        peer.hello = true;
        peer.info.name = message.name;
        peer.info.role = message.role;
        peer.info.lastSeen = now;
        snapshot(peer);
        publishClients();
        return;
      }
      if (!peer.hello) { error(peer, 'Send hello first'); return; }
      peer.info.lastSeen = now;
      if (message.type === 'ping') {
        send(peer, { version: VERSION, type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: now, serverTime: authority.now(), epoch: authority.epoch });
      } else if (message.type === 'telemetry') peer.info.telemetry = message.telemetry;
      else {
        if (peer.info.role !== 'dashboard') { error(peer, 'HMD connections are read-only', message.requestId); return; }
        const existing = acknowledgments.get(message.requestId);
        if (existing) {
          if (existing.command !== JSON.stringify(message.command)) { error(peer, 'Request ID was already used for a different command', message.requestId); return; }
          send(peer, { version: VERSION, type: 'ack', requestId: message.requestId, eventId: existing.eventId, effectiveAt: existing.effectiveAt });
          return;
        }
        try {
          const event: ShowEvent = authority.schedule(message.command, now);
          acknowledgments.set(message.requestId, { eventId: event.id, effectiveAt: event.effectiveAt, at: now, command: JSON.stringify(message.command) });
          if (acknowledgments.size > 4096) acknowledgments.delete(acknowledgments.keys().next().value!);
          send(peer, { version: VERSION, type: 'ack', requestId: message.requestId, eventId: event.id, effectiveAt: event.effectiveAt });
        } catch (reason) { error(peer, reason instanceof Error ? reason.message : 'Command failed', message.requestId); }
      }
    });
  });

  const native = createHttpServer((req, res) => {
    void (async () => {
      if (!authorize(req.headers.authorization, options.nativeToken)) { json(res, 401, { error: 'Native bearer token required' }); return; }
      if (req.url === '/clock' && req.method === 'GET') { json(res, 200, { version: VERSION, epoch: authority.epoch, serverTime: authority.now() }); return; }
      if (req.url !== '/ingest' || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return; }
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { json(res, 415, { error: 'Content-Type must be application/json' }); return; }
      const now = authority.now();
      currentNativeBudget = Math.min(1200, currentNativeBudget + (now - nativeBudgetAt) * .6);
      nativeBudgetAt = now;
      if (--currentNativeBudget < 0) { json(res, 429, { error: 'Native ingest rate exceeded' }); return; }
      let parsed;
      try { parsed = NativeMessageSchema.safeParse(JSON.parse(await body(req))); }
      catch { json(res, 400, { error: 'Invalid JSON or oversized body' }); return; }
      if (!parsed.success) { json(res, 400, { error: 'Message does not match native protocol v1' }); return; }
      const message = parsed.data;
      const ingestedAt = authority.now();
      if ('timestamp' in message && (message.timestamp > ingestedAt + 2000 || message.timestamp < ingestedAt - 10000)) { json(res, 422, { error: 'Timestamp outside the allowed clock window; resynchronize with /clock' }); return; }
      authority.touchNative(ingestedAt);
      if (message.type === 'midi') {
        authority.source.midi = 'connected';
        const command = midi.consume(message, authority.projected(ingestedAt), ingestedAt);
        if (command) {
          try { authority.schedule(command, ingestedAt); }
          catch (reason) { json(res, 409, { error: reason instanceof Error ? reason.message : 'MIDI command rejected' }); return; }
        }
      } else {
        if (message.type === 'source' && message.midi === 'disconnected') midi.reset();
        authority.ingest(message, ingestedAt);
      }
      json(res, 200, { ok: true, serverTime: authority.now() });
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: 'Native request failed' }); else res.end(); });
  });
  native.requestTimeout = 5000;
  native.headersTimeout = 5000;
  let port = 0;
  let nativePort = 0;
  try {
    port = await listen(main, options.port ?? 8787, host);
    const protocol = options.tls ? 'https' : 'http';
    if (LOOPBACK.has(host)) {
      for (const name of ['127.0.0.1', 'localhost', '[::1]']) { origins.add(`${protocol}://${name}:${port}`); hosts.add(`${name}:${port}`); }
    }
    nativePort = await listen(native, options.nativePort ?? 8788, '127.0.0.1');
    if (options.vite && !options.production) {
      const { createServer } = await import('vite');
      vite = await createServer({ server: { middlewareMode: true, hmr: false, allowedHosts: [...hosts].map(host => host.split(':')[0]) }, appType: 'spa' });
    }
  } catch (reason) {
    await vite?.close();
    await Promise.all([shutdown(main), shutdown(native)]);
    wss.close();
    throw reason;
  }
  const frameTimer = setInterval(() => {
    const now = authority.now();
    authority.advance(now);
    const wasMidiConnected = authority.source.midi === 'connected';
    const audioFrame = authority.audioFrame(now);
    if (wasMidiConnected && authority.source.midi === 'disconnected') midi.reset();
    broadcast({ version: VERSION, type: 'frame', timestamp: now, state: authority.state, audioFrame, source: authority.source });
    if (now - publishedClientsAt > 1000) publishClients();
  }, 1000 / FRAME_HZ);
  const heartbeatTimer = setInterval(() => {
    const now = authority.now();
    for (const peer of peers.values()) {
      if (!peer.hello && now - peer.connectedAt > (options.helloTimeoutMs ?? 5000)) {
        peer.ws.terminate();
        continue;
      }
      if (!peer.alive) { peer.ws.terminate(); continue; }
      peer.alive = false;
      if (peer.ws.readyState === WebSocket.OPEN) peer.ws.ping();
    }
    for (const [key, value] of acknowledgments) if (now - value.at > 300000) acknowledgments.delete(key);
  }, options.heartbeatMs ?? 15000);
  return {
    authority, port, nativePort, main, native,
    url: options.publicOrigin ?? `${options.tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(frameTimer);
      clearInterval(heartbeatTimer);
      for (const peer of peers.values()) peer.ws.terminate();
      wss.close();
      await vite?.close();
      await Promise.all([shutdown(main), shutdown(native)]);
    },
  };
}

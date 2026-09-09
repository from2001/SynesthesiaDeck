import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { startServer, type ServerOptions } from '../server/app.js';
import { ServerMessageSchema, SILENCE, type ServerMessage } from '../shared/protocol.js';

const tokens = { controlToken: 'dashboard-test-credential-123456789', nativeToken: 'native-test-credential-987654321' };
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const sockets: WebSocket[] = [];
async function serve(extra: Partial<ServerOptions> = {}) {
  const server = await startServer({ ...tokens, port: 0, nativePort: 0, ...extra });
  servers.push(server);
  return server;
}
async function connect(server: Awaited<ReturnType<typeof startServer>>, role: 'dashboard' | 'hmd' = 'hmd', extra: { token?: string; name?: string; autoPong?: boolean; hello?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.url, autoPong: extra.autoPong ?? true });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.on('message', data => messages.push(ServerMessageSchema.parse(JSON.parse(data.toString()))));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = {
    ws, messages,
    send(value: unknown) { ws.send(JSON.stringify(value)); },
    async wait(type: ServerMessage['type'], predicate: (message: any) => boolean = () => true, after = 0): Promise<any> {
      return await new Promise((resolve, reject) => {
        const started = performance.now();
        const poll = setInterval(() => {
          const match = messages.slice(after).find(message => message.type === type && predicate(message));
          if (match) { clearInterval(poll); resolve(match); }
          else if (performance.now() - started > 3000) { clearInterval(poll); reject(new Error(`Timed out waiting for ${type}`)); }
        }, 5);
      });
    },
  };
  if (extra.hello !== false) client.send({ version: 1, type: 'hello', role, name: extra.name ?? role, ...(role === 'dashboard' ? { token: extra.token ?? tokens.controlToken } : {}) });
  return client;
}
async function native(server: Awaited<ReturnType<typeof startServer>>, message: unknown, token = tokens.nativeToken) {
  return fetch(`http://127.0.0.1:${server.nativePort}/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('real HTTP and WebSocket service', () => {
  it('authenticates native ingress, preserves capture time, rejects remote bridge paths and malformed frames', async () => {
    const server = await serve();
    const url = `http://127.0.0.1:${server.nativePort}`;
    expect((await fetch(`${url}/clock`)).status).toBe(401);
    const clock = await (await fetch(`${url}/clock`, { headers: { Authorization: `Bearer ${tokens.nativeToken}` } })).json();
    expect(clock.epoch).toBe(server.authority.epoch);
    expect(clock.serverTime).toBeGreaterThan(0);
    expect(server.native.address()).toMatchObject({ address: '127.0.0.1' });
    expect((await fetch(`${server.url}/ingest`)).status).toBe(404);
    const hmd = await connect(server);
    await hmd.wait('snapshot');
    const sample = { version: 1, type: 'audio', timestamp: clock.serverTime, source: 'system', audio: { ...SILENCE, level: .7 } };
    expect((await native(server, sample, tokens.controlToken)).status).toBe(401);
    expect((await native(server, { ...sample, audio: { ...sample.audio, rawPCM: [1, 2] } })).status).toBe(400);
    expect((await native(server, { ...sample, timestamp: server.authority.now() + 10000 })).status).toBe(422);
    expect((await native(server, sample)).status).toBe(200);
    const frame = await hmd.wait('frame', message => message.audioFrame.audio.level === .7);
    expect(frame.audioFrame.timestamp).toBe(clock.serverTime);
    expect(frame.audioFrame.source).toBe('system');
    expect(frame.source.capture).toBe('running');
    expect((await native(server, { ...sample, timestamp: clock.serverTime - 1, audio: { ...sample.audio, level: .1 } })).status).toBe(200);
    expect(server.authority.audioFrame().audio.level).toBe(.7);
  });
  it('keeps two HMDs coherent, rejects HMD authority, and deduplicates across reconnects', async () => {
    const server = await serve();
    const [one, two, dashboard] = await Promise.all([connect(server), connect(server), connect(server, 'dashboard')]);
    await Promise.all([one.wait('snapshot'), two.wait('snapshot'), dashboard.wait('snapshot')]);
    one.send({ version: 1, type: 'command', requestId: 'forbidden', command: { type: 'scene', scene: 4 } });
    expect((await one.wait('error')).message).toContain('read-only');
    dashboard.send({ version: 1, type: 'command', requestId: 'scene-request', command: { type: 'scene', scene: 2 } });
    const ack = await dashboard.wait('ack');
    const [a, b] = await Promise.all([one.wait('event'), two.wait('event')]);
    expect(a.event).toEqual(b.event);
    expect(a.event.id).toBe(ack.eventId);
    expect(server.authority.state.scene).toBe(0);
    const joining = await connect(server);
    const joined = await joining.wait('snapshot');
    expect(joined.state.scene).toBe(0);
    expect(joined.pending.map((event: any) => event.id)).toContain(ack.eventId);
    const states = await Promise.all([one.wait('frame', message => message.state.scene === 2), two.wait('frame', message => message.state.scene === 2)]);
    expect(states[0].state.seed).toBe(states[1].state.seed);
    expect(states[0].state.revision).toBe(states[1].state.revision);
    dashboard.ws.close();
    const replacement = await connect(server, 'dashboard');
    await replacement.wait('snapshot');
    replacement.send({ version: 1, type: 'command', requestId: 'scene-request', command: { type: 'scene', scene: 2 } });
    expect((await replacement.wait('ack')).eventId).toBe(ack.eventId);
    replacement.send({ version: 1, type: 'command', requestId: 'scene-request', command: { type: 'scene', scene: 3 } });
    expect((await replacement.wait('error')).message).toContain('different command');
    expect(server.authority.state.revision).toBe(a.event.sequence);
    const later = await connect(server);
    const latest = await later.wait('snapshot');
    expect(latest.pending).toHaveLength(0);
    expect(latest.state.scene).toBe(2);
  });
  it('requires a valid dashboard token, exact origin/path, safe Host and hello', async () => {
    const server = await serve();
    const bad = await connect(server, 'dashboard', { token: 'incorrect' });
    expect((await bad.wait('error')).message).toContain('invalid');
    const early = await connect(server, 'hmd', { hello: false });
    early.send({ version: 1, type: 'ping', id: 0, sentAt: 0 });
    expect((await early.wait('error')).message).toContain('hello');
    early.ws.send('{');
    expect((await early.wait('error', message => message.message.includes('JSON'))).message).toContain('JSON');
    for (const [path, origin] of [['/ws?token=secret', server.url], ['/ws', 'https://evil.example'], ['/ws', undefined]] as const) {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, origin ? { origin } : {});
        sockets.push(ws);
        ws.once('open', () => reject(new Error('Unexpected accepted connection')));
        ws.once('error', reason => { expect(reason.message).toContain('403'); resolve(); });
      });
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.once('error', reject); req.end();
    });
    expect(status).toBe(421);
    await expect(startServer({ ...tokens, host: '0.0.0.0', port: 0, nativePort: 0 })).rejects.toThrow('requires TLS');
    await expect(startServer({ ...tokens, host: '0.0.0.0', trustedProxy: true, publicOrigin: 'http://show.example', port: 0, nativePort: 0 })).rejects.toThrow('HTTPS');
  });
  it('publishes at approximately 30 Hz and removes silent peers without disturbing a healthy client', async () => {
    const server = await serve({ heartbeatMs: 50, helloTimeoutMs: 60 });
    const [healthy, silent, incomplete] = await Promise.all([connect(server), connect(server, 'hmd', { autoPong: false }), connect(server, 'hmd', { hello: false })]);
    await healthy.wait('snapshot');
    const initial = performance.now();
    await new Promise<void>(resolve => silent.ws.once('close', () => resolve()));
    expect(performance.now() - initial).toBeLessThan(400);
    expect(incomplete.ws.readyState).toBe(WebSocket.CLOSED);
    const first = await healthy.wait('frame');
    const later = await healthy.wait('frame', message => message.timestamp > first.timestamp + 170);
    const frames = healthy.messages.filter(message => message.type === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(later.timestamp - first.timestamp).toBeLessThan(300);
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    healthy.send({ version: 1, type: 'ping', id: 123, sentAt: 1 });
    expect((await healthy.wait('pong')).id).toBe(123);
  });
  it('routes native MIDI through scheduling, projected scene wrapping and toggle state', async () => {
    const server = await serve();
    const hmd = await connect(server);
    await hmd.wait('snapshot');
    const sendMidi = (data1: number, data2: number) => native(server, { version: 1, type: 'midi', timestamp: server.authority.now(), status: 0xb0, data1, data2 });
    await sendMidi(36, 127);
    await sendMidi(44, 127);
    const events = hmd.messages.filter(message => message.type === 'event');
    await hmd.wait('event', message => message.event.sequence === 2);
    expect(server.authority.projected().scene).toBe(0);
    await sendMidi(64, 127);
    await sendMidi(64, 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    await sendMidi(64, 127);
    expect(server.authority.projected().toggles[0]).toBe(false);
    expect(events.length).toBeGreaterThanOrEqual(1);
    await sendMidi(41, 127);
    await sendMidi(45, 127);
    await sendMidi(45, 127);
    expect(server.authority.pending.filter(event => event.command.type === 'drop')).toHaveLength(1);
    await sendMidi(42, 127);
    expect(server.authority.pending.filter(event => event.command.type === 'drop')).toHaveLength(0);
    const replacement = await hmd.wait('snapshot', message => message.pending.some((event: any) => event.command.type === 'clear'), 1);
    expect(replacement.pending.some((event: any) => event.command.type === 'drop')).toBe(false);
  });
  it('disconnects a simulated congested transport while another real WS keeps receiving frames', async () => {
    const server = await serve({ maxBufferedBytes: 1024 });
    const [slow, healthy] = await Promise.all([connect(server), connect(server)]);
    await Promise.all([slow.wait('snapshot'), healthy.wait('snapshot')]);
    const remotePort = Reflect.get(slow.ws, '_socket').localPort;
    const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
    // Reproduce a blocked writable transport deterministically without filling the
    // operating system's multi-megabyte send buffer or delaying the suite.
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
      const socket = Reflect.get(this, '_socket');
      return socket?.localPort === server.port && socket?.remotePort === remotePort ? 2048 : original.call(this);
    });
    await new Promise<void>(resolve => slow.ws.once('close', () => resolve()));
    const after = healthy.messages.length;
    await healthy.wait('frame', () => true, after);
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
  });
  it('bounds connection count and rejects oversized WS input', async () => {
    const server = await serve({ maxClients: 1 });
    const hmd = await connect(server);
    await hmd.wait('snapshot');
    await new Promise<void>(resolve => {
      const extra = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.url });
      sockets.push(extra);
      extra.once('error', reason => { expect(reason.message).toContain('403'); resolve(); });
    });
    const closed = new Promise<number>(resolve => hmd.ws.once('close', code => resolve(code)));
    hmd.ws.send('x'.repeat(10000));
    expect(await closed).toBe(1009);
  });
});

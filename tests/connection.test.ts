import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowConnection } from '../web/connection';
import { initialState, SILENCE } from '../shared/protocol';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  constructor(readonly url: string) { super(); FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(value: string) { this.sent.push(value); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
let connection: ShowConnection;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:8787', protocol: 'http:', host: '127.0.0.1:8787' });
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  connection = new ShowConnection('hmd');
});
afterEach(() => { connection.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('browser connection recovery', () => {
  it('defaults to same-origin /ws for local development and HTTPS hosting', () => {
    connection.connect();
    expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:8787/ws');
    connection.disconnect();
    vi.stubGlobal('location', { origin: 'https://desk.example', protocol: 'https:', host: 'desk.example' });
    connection = new ShowConnection('hmd');
    connection.connect();
    expect(FakeSocket.instances.at(-1)!.url).toBe('wss://desk.example/ws');
  });
  it('connects to an explicit cross-origin WSS authority and retains it on reconnect', () => {
    vi.stubGlobal('location', { origin: 'https://desk.example', protocol: 'https:', host: 'desk.example' });
    connection = new ShowConnection('dashboard', 'test-token', 'Remote VJ desk', 'wss://mac.example:8443/ws');
    connection.connect();
    const first = FakeSocket.instances[0];
    expect(first.url).toBe('wss://mac.example:8443/ws');
    expect(connection.serverUrl).toBe(first.url);
    first.open();
    expect(JSON.parse(first.sent[0])).toEqual({ version: 1, type: 'hello', role: 'dashboard', name: 'Remote VJ desk', token: 'test-token' });
    first.close();
    vi.stubGlobal('location', { origin: 'https://unrelated.example', protocol: 'https:', host: 'unrelated.example' });
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances[1].url).toBe('wss://mac.example:8443/ws');
  });
  it('normalizes an explicit HTTPS origin before opening the socket', () => {
    connection = new ShowConnection('hmd', '', 'Audience', 'https://mac.example/');
    connection.connect();
    expect(FakeSocket.instances[0].url).toBe('wss://mac.example/ws');
  });
  it('rejects mixed content and unsafe endpoints before any socket or credential message exists', () => {
    vi.stubGlobal('location', { origin: 'https://desk.example', protocol: 'https:', host: 'desk.example' });
    for (const endpoint of ['ws://mac.example/ws', 'ws://127.0.0.1:8787/ws', 'http://localhost:8787', 'wss://mac.example/ws?token=secret', 'https://name:password@mac.example']) {
      expect(() => new ShowConnection('dashboard', 'must-not-send', 'Desk', endpoint)).toThrow();
    }
    expect(FakeSocket.instances).toHaveLength(0);
  });
  it('times out an opened connection that never completes hello', () => {
    connection.connect(); const first = FakeSocket.instances[0]; first.open();
    vi.advanceTimersByTime(5000);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('does not accept incompatible messages as a successful handshake', () => {
    connection.connect(); const first = FakeSocket.instances[0]; first.open();
    first.receive({ version: 99, type: 'snapshot' });
    vi.advanceTimersByTime(5000);
    expect(first.closed).toBe(true);
    expect(connection.connected).toBe(false);
  });
  it('completes the handshake on a valid snapshot and resets the deadline on reconnect', () => {
    connection.connect(); const first = FakeSocket.instances[0]; first.open();
    first.receive({ version: 1, type: 'snapshot', clientId: 'a', serverTime: 100, state: initialState('show'), pending: [], audioFrame: { timestamp: 0, audio: SILENCE, source: 'silent' }, source: { capture: 'stopped', midi: 'disconnected', detail: '' } });
    vi.advanceTimersByTime(5000);
    expect(first.closed).toBe(false);
    expect(connection.connected).toBe(true);
    first.close(); vi.advanceTimersByTime(500);
    const second = FakeSocket.instances[1]; second.open();
    vi.advanceTimersByTime(5000);
    expect(second.closed).toBe(true);
  });
});

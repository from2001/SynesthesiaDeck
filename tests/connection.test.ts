import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowConnection } from '../web/connection';
import { initialState, SILENCE } from '../shared/protocol';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  constructor() { super(); FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(value: string) { this.sent.push(value); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
let connection: ShowConnection;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:8787' });
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  connection = new ShowConnection('hmd');
});
afterEach(() => { connection.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('browser connection recovery', () => {
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

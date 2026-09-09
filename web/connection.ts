import { ServerMessageSchema, VERSION, type ClientInfo, type Command, type ServerMessage, type SourceStatus, type Telemetry } from '../shared/protocol';
import { ShowClock, StateTimeline } from './sync';
import { resolveServerUrl } from './server-url';

export class ShowConnection extends EventTarget {
  readonly serverUrl: string;
  readonly clock = new ShowClock();
  readonly timeline = new StateTimeline();
  source: SourceStatus = { capture: 'stopped', midi: 'disconnected', detail: 'Waiting for the show server' };
  clients: ClientInfo[] = [];
  status = 'Offline';
  connected = false;
  clientId = '';
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer = 0;
  private pingTimer = 0;
  private handshakeTimer = 0;
  private pingId = 0;
  private pings = new Map<number, number>();
  private requests = new Map<string, { resolve: (eventId: string) => void; reject: (error: Error) => void; timeout: number }>();
  private lastReceive = 0;
  constructor(readonly role: 'hmd' | 'dashboard', readonly token = '', readonly name = role === 'hmd' ? 'Headset' : 'VJ desk', socketUrl?: string) {
    super();
    this.serverUrl = resolveServerUrl(socketUrl, location.origin);
  }
  private changed() { this.dispatchEvent(new Event('change')); }
  private message(text: string) { this.dispatchEvent(new CustomEvent('notice', { detail: text })); }
  connect() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.status = this.attempt ? 'Reconnecting' : 'Connecting'; this.changed();
    const socket = new WebSocket(this.serverUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.lastReceive = performance.now();
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = window.setTimeout(() => {
        if (!this.connected && this.socket === socket) socket.close();
      }, 5000);
      socket.send(JSON.stringify({ version: VERSION, type: 'hello', role: this.role, name: this.name, ...(this.role === 'dashboard' ? { token: this.token } : {}) }));
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (performance.now() - this.lastReceive > 10000) { socket.close(); return; }
        this.ping();
      }, 1000);
    });
    socket.addEventListener('message', event => {
      try {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) { this.message('The server protocol is incompatible. Update both server and client.'); return; }
        this.receive(parsed.data);
      } catch { this.message('Received an invalid server message.'); }
    });
    socket.addEventListener('error', () => { this.status = 'Connection error'; this.changed(); });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.connected = false; this.status = this.stopped ? 'Offline' : 'Reconnecting';
      clearInterval(this.pingTimer); clearTimeout(this.handshakeTimer); this.pings.clear();
      this.rejectRequests('Connection lost; the command may not have been applied. Check current state before retrying.');
      this.changed();
      if (!this.stopped) this.reconnectTimer = window.setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.attempt++));
    });
  }
  private receive(message: ServerMessage) {
    const localNow = performance.now(); this.lastReceive = localNow;
    if (message.type === 'snapshot') {
      clearTimeout(this.handshakeTimer);
      if (message.state.epoch !== this.clock.epoch) this.clock.reset(message.state.epoch, localNow, message.serverTime);
      this.timeline.snapshot(message.state, message.pending, message.audioFrame, message.serverTime);
      this.source = message.source; this.clientId = message.clientId;
      this.connected = true; this.attempt = 0; this.status = 'Live';
    } else if (message.type === 'frame') {
      if (message.state.epoch !== this.clock.epoch) { this.socket?.close(); return; }
      this.timeline.frame(message.state, message.audioFrame, message.timestamp); this.source = message.source;
    } else if (message.type === 'event') this.timeline.event(message.event);
    else if (message.type === 'pong') {
      const sentAt = this.pings.get(message.id);
      if (sentAt !== undefined && sentAt === message.sentAt) {
        this.clock.observe(sentAt, localNow, message.receivedAt, message.serverTime, message.epoch);
        this.pings.delete(message.id);
      }
    } else if (message.type === 'clients') this.clients = message.clients;
    else if (message.type === 'ack') {
      const request = this.requests.get(message.requestId);
      if (request) { clearTimeout(request.timeout); request.resolve(message.eventId); this.requests.delete(message.requestId); }
    } else if (message.type === 'error') {
      const request = message.requestId ? this.requests.get(message.requestId) : undefined;
      if (request) { clearTimeout(request.timeout); request.reject(new Error(message.message)); this.requests.delete(message.requestId!); }
      this.message(message.message);
      if (!this.connected) { this.status = 'Access denied'; this.disconnect(); }
    }
    this.changed();
  }
  private ping() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const id = this.pingId++, sentAt = performance.now();
    this.pings.set(id, sentAt);
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value!);
    this.socket.send(JSON.stringify({ version: VERSION, type: 'ping', id, sentAt }));
  }
  sample(localNow = performance.now()) {
    // Stop advancing an abandoned show after a short network outage.
    const boundedNow = this.lastReceive ? Math.min(localNow, this.lastReceive + 2000) : localNow;
    const now = this.clock.now(boundedNow);
    const sample = this.timeline.sample(now);
    return sample ? { ...sample, now } : null;
  }
  command(command: Command): Promise<string> {
    if (!this.connected || this.role !== 'dashboard' || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Connect the VJ desk before sending controls.'));
    if (this.requests.size >= 128) return Promise.reject(new Error('Too many pending controls; wait for the connection.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { this.requests.delete(requestId); reject(new Error('Command acknowledgement timed out. Check the live state before retrying.')); }, 5000);
      this.requests.set(requestId, { resolve, reject, timeout });
      this.socket!.send(JSON.stringify({ version: VERSION, type: 'command', requestId, command }));
    });
  }
  telemetry(telemetry: Telemetry) {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ version: VERSION, type: 'telemetry', telemetry }));
  }
  private rejectRequests(message: string) {
    for (const request of this.requests.values()) { clearTimeout(request.timeout); request.reject(new Error(message)); }
    this.requests.clear();
  }
  disconnect() {
    this.stopped = true; this.connected = false;
    clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer); clearTimeout(this.handshakeTimer);
    this.rejectRequests('Disconnected'); this.socket?.close();
  }
}

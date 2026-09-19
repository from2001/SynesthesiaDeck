import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';

// Observe real Quest browser targets forwarded with adb; never simulate a headset.
// Usage: node scripts/observe-hardware.mjs --seconds 600 --ports 9223,9224
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const seconds = Number(option('--seconds', '600'));
const ports = option('--ports', '9223,9224').split(',').map(Number);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7200 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('Invalid duration or CDP ports');
if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(option('--output', `artifacts/hardware-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(directory, { recursive: true });
const stream = createWriteStream(resolve(directory, 'observations.jsonl'), { flags: 'wx' });
const started = Date.now();
const summary = { startedAt: new Date(started).toISOString(), durationSeconds: seconds, kind: 'physical-browser-observation', devices: [], events: [], errors: [], authority: { frames: 0, bytes: 0, nonSilentFrames: 0, captureModes: [], maxLevel: 0 }, limitations: ['Renderer update times are CPU-side application observations, not photon or GPU measurements.', 'USB localhost is not evidence of trusted venue-LAN HTTPS/WSS.', 'XR session status does not establish both-eye image quality or physical alignment.', 'Physical MIDI operation requires a correlated operator action; server events alone do not prove input origin.'] };
function record(kind, data) { stream.write(`${JSON.stringify({ elapsedMs: Date.now() - started, kind, ...data })}\n`); }
function fail(scope, error) { const item = { scope, message: String(error) }; summary.errors.push(item); record('error', item); console.error(JSON.stringify(item)); }
const probes = [];
let control;
let closed = false;
let interval;
let deadline;

class CDP {
  pending = new Map();
  sequence = 0;
  constructor(socket, device) {
    this.socket = socket; this.device = device;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const request = this.pending.get(message.id);
        if (request) { clearTimeout(request.timer); this.pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
        return;
      }
      if (message.method === 'Runtime.bindingCalled' && message.params.name === '__nanokonHardwareRecord') {
        const data = JSON.parse(message.params.payload);
        record(data.kind, { port: device.port, ...data });
        if (data.kind === 'render-change') device.renderChanges.push(data);
        if (data.kind === 'render-sample') {
          device.samples++;
          if (data.stats.xr) device.xrSamples++;
          if (data.audio.level > 0.005) device.audioReactiveSamples++;
          if (data.stats.fps > 0) device.fps.push(data.stats.fps);
        }
      } else if (message.method === 'Runtime.exceptionThrown') fail(`browser:${device.port}`, message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description ?? ''));
      else if (message.method === 'Network.webSocketFrameReceived') {
        try {
          const payload = JSON.parse(message.params.response.payloadData);
          if (payload.type === 'event') record('hmd-event-received', { port: device.port, cdpTimestamp: message.params.timestamp, event: payload.event });
        } catch { /* Other browser sockets are outside the show protocol. */ }
      }
    });
    socket.on('error', error => fail(`cdp:${device.port}`, error));
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

const instrumentation = `(async () => {
  if (window.__nanokonHardwareRestore) return 'already observing';
  const { ShowRenderer } = await import('/visuals/renderer.ts');
  const original = ShowRenderer.prototype.update;
  let lastRevision = -1, lastEffects = '', lastSample = -Infinity;
  ShowRenderer.prototype.update = function(state, audio, now) {
    const result = original.call(this, state, audio, now);
    const localNow = performance.now();
    const effects = state.effects.map(effect => effect.id).join(',');
    if (state.revision !== lastRevision || effects !== lastEffects) {
      lastRevision = state.revision; lastEffects = effects;
      window.__nanokonHardwareRecord(JSON.stringify({kind:'render-change', localNow, masterNow:now, revision:state.revision, scene:state.scene, seed:state.seed, running:state.running, effects:state.effects, locked:window.__nanokon?.clockLocked, stats:this.stats}));
    }
    if (localNow - lastSample >= 1000) {
      lastSample = localNow;
      window.__nanokonHardwareRecord(JSON.stringify({kind:'render-sample', localNow, masterNow:now, scene:state.scene, seed:state.seed, revision:state.revision, running:state.running, audio, stats:this.stats, connected:window.__nanokon?.connected, locked:window.__nanokon?.clockLocked}));
    }
    return result;
  };
  window.__nanokonHardwareRestore = () => { ShowRenderer.prototype.update = original; delete window.__nanokonHardwareRestore; };
  return {url:location.href, secure:isSecureContext, userAgent:navigator.userAgent, diagnostics:window.__nanokon};
})()`;

async function finish(reason) {
  if (closed) return;
  closed = true; clearInterval(interval); clearTimeout(deadline);
  summary.finishedAt = new Date().toISOString(); summary.elapsedSeconds = (Date.now() - started) / 1000; summary.finishReason = reason;
  await Promise.allSettled(probes.map(async probe => {
    try { await probe.evaluate('window.__nanokonHardwareRestore?.()'); } catch (error) { fail(`restore:${probe.device.port}`, error); }
    probe.socket.close();
  }));
  control?.close();
  const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null; };
  for (const device of summary.devices) {
    device.fpsSummary = { samples: device.fps.length, p05: quantile(device.fps, .05), median: quantile(device.fps, .5) };
    delete device.fps;
  }
  const skew = [];
  summary.eventApplication = summary.events.map(event => {
    const applications = summary.devices.map(device => {
      const change = device.renderChanges.find(change => change.revision === event.sequence);
      return { port: device.port, masterNow: change?.masterNow ?? null, latenessMs: change ? change.masterNow - event.effectiveAt : null, locked: change?.locked ?? false, xr: change?.stats.xr ?? false };
    });
    const times = applications.map(app => app.masterNow).filter(time => time !== null);
    const skewMs = times.length === summary.devices.length && times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
    if (skewMs !== null) skew.push(skewMs);
    return { id: event.id, command: event.command, effectiveAt: event.effectiveAt, applications, skewMs };
  });
  summary.applicationSkewMs = { count: skew.length, p95: quantile(skew, .95), max: skew.length ? Math.max(...skew) : null };
  summary.authority.measuredFramesPerSecond = summary.authority.frames / summary.elapsedSeconds;
  summary.authority.measuredBytesPerSecond = summary.authority.bytes / summary.elapsedSeconds;
  for (const device of summary.devices) delete device.renderChanges;
  await new Promise(resolve => stream.end(resolve));
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ output: directory, elapsedSeconds: summary.elapsedSeconds, devices: summary.devices.map(device => ({ port: device.port, samples: device.samples, xrSamples: device.xrSamples, audioReactiveSamples: device.audioReactiveSamples, fps: device.fpsSummary })), applicationSkewMs: summary.applicationSkewMs, authority: summary.authority, errors: summary.errors.length }, null, 2));
}

try {
  for (const port of ports) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
    const target = targets.find(target => target.type === 'page' && /^http:\/\/localhost:8787\//.test(target.url) && (target.url.includes('view=hmd') || target.url.includes('/hmd')));
    if (!target) throw new Error(`No local HMD page on CDP port ${port}`);
    const device = { port, targetId: target.id, url: target.url, samples: 0, xrSamples: 0, audioReactiveSamples: 0, fps: [], renderChanges: [] };
    summary.devices.push(device);
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const probe = new CDP(socket, device); probes.push(probe);
    await probe.send('Runtime.enable'); await probe.send('Network.enable');
    await probe.send('Runtime.addBinding', { name: '__nanokonHardwareRecord' });
    device.initial = await probe.evaluate(instrumentation);
    record('device', { port, targetId: target.id, initial: device.initial });
  }
  const health = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  summary.health = health; record('health', { health });
  control = new WebSocket('ws://127.0.0.1:8787/ws', { origin: 'http://localhost:8787', handshakeTimeout: 5000 });
  control.on('open', () => control.send(JSON.stringify({ version: 1, type: 'hello', role: process.env.CONTROL_TOKEN ? 'dashboard' : 'hmd', name: 'Hardware evidence observer', ...(process.env.CONTROL_TOKEN ? { token: process.env.CONTROL_TOKEN } : {}) })));
  let lastFrame = 0;
  control.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'frame') {
      summary.authority.frames++; summary.authority.bytes += raw.length;
      summary.authority.maxLevel = Math.max(summary.authority.maxLevel, message.audioFrame.audio.level);
      if (message.audioFrame.audio.level > .005) summary.authority.nonSilentFrames++;
      if (!summary.authority.captureModes.includes(message.audioFrame.source)) summary.authority.captureModes.push(message.audioFrame.source);
      if (Date.now() - lastFrame >= 1000) { lastFrame = Date.now(); record('authority-frame', { message }); }
    } else if (message.type === 'event') { summary.events.push(message.event); record('authority-event', { event: message.event }); console.log(JSON.stringify({ event: message.event.command, id: message.event.id })); }
    else if (message.type === 'clients') record('clients', { clients: message.clients });
    else if (message.type === 'error') fail('authority', message.message);
  });
  control.on('error', error => fail('authority', error));
  control.on('close', () => { if (!closed) fail('authority', 'Observer connection closed'); });
  interval = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), frames: summary.authority.frames, nonSilent: summary.authority.nonSilentFrames, devices: summary.devices.map(d => ({ port: d.port, samples: d.samples, xrSamples: d.xrSamples, audioReactiveSamples: d.audioReactiveSamples })) })), 30000);
  deadline = setTimeout(() => void finish('duration'), seconds * 1000);
  process.once('SIGINT', () => void finish('SIGINT')); process.once('SIGTERM', () => void finish('SIGTERM'));
  console.log(JSON.stringify({ observing: directory, ports, seconds }));
} catch (error) { fail('startup', error); await finish('error'); process.exitCode = 1; }

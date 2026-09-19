import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

// Run against already-entered MR sessions. Never automate a permission prompt.
process.loadEnvFile('.env');
const durationMs = Number(process.env.SOAK_SECONDS ?? 1800) * 1000;
if (!Number.isFinite(durationMs) || durationMs < 180000) throw new Error('SOAK_SECONDS must be at least 180.');
const startedAt = new Date();
const output = path.resolve('artifacts', `hackathon-soak-${startedAt.toISOString().replaceAll(':', '-')}`);
fs.mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
const commands = [];
const exceptions = [];
const screenshots = [];
const frameStats = { count: 0, bytes: 0, nonSilent: 0, maxLevel: 0, firstFrameKeys: null };
const devices = [
  { name: 'A', serial: '340YC10G8B0LR0', url: 'ws://127.0.0.1:9223/devtools/page/11' },
  { name: 'B', serial: '340YC10GBB1CWQ', url: 'ws://127.0.0.1:9224/devtools/page/12' },
];
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null;
};
async function connect(url, options) {
  const socket = new WebSocket(url, { handshakeTimeout: 8000, ...options });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('error', error => exceptions.push({ source: url.startsWith('ws://127.0.0.1:8787') ? 'observer' : 'cdp', message: error.message }));
  return socket;
}
async function cdp(device) {
  const socket = await connect(device.url);
  let nextId = 1;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown' && message.params.timestamp >= startedAt.getTime()) {
      exceptions.push({ device: device.name, details: message.params.exceptionDetails });
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${device.name}: ${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (fn, ...args) => {
    const result = await call('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Runtime.enable');
  return { ...device, socket, call, evaluate };
}
function installFrameProbe() {
  if (!window.__nanokon?.stats.xr) throw new Error('The operator must enter MR before this test.');
  if (window.__hackathonFrameProbe) throw new Error('An existing frame probe must finish first.');
  const original = XRSession.prototype.requestAnimationFrame;
  const probe = { original, count: 0, cpu: [], gaps: [], last: null };
  probe.wrapper = function(callback) {
    return original.call(this, function(timestamp, frame) {
      const begin = performance.now();
      if (probe.last !== null) probe.gaps.push(timestamp - probe.last);
      probe.last = timestamp;
      try { return callback(timestamp, frame); }
      finally {
        probe.count += 1;
        if (probe.cpu.length < 4096) probe.cpu.push(performance.now() - begin);
        if (probe.gaps.length > 4096) probe.gaps.shift();
      }
    });
  };
  XRSession.prototype.requestAnimationFrame = probe.wrapper;
  window.__hackathonFrameProbe = probe;
  return { installed: true, stats: window.__nanokon.stats };
}
function sample() {
  const d = window.__nanokon;
  const probe = window.__hackathonFrameProbe;
  const result = {
    connected: d.connected, clockLocked: d.clockLocked, renderReady: d.renderReady,
    stats: d.stats, source: d.source, visibility: document.visibilityState,
    state: { epoch: d.state.epoch, revision: d.state.revision, scene: d.state.scene,
      seed: d.state.seed, running: d.state.running, effects: d.state.effects.map(e => e.id) },
    frames: probe.count, cpu: probe.cpu.splice(0), gaps: probe.gaps.splice(0),
  };
  probe.count = 0;
  return result;
}
function selectQuality(value) {
  const select = document.getElementById('quality');
  if (!select || ![...select.options].some(option => option.value === value)) throw new Error('Quality selector unavailable.');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return window.__nanokon.stats.quality;
}
function removeFrameProbe() {
  const probe = window.__hackathonFrameProbe;
  if (!probe) return;
  if (XRSession.prototype.requestAnimationFrame === probe.wrapper) XRSession.prototype.requestAnimationFrame = probe.original;
  delete window.__hackathonFrameProbe;
}
const initialHealth = await fetch('http://127.0.0.1:8787/health').then(response => response.json());
if (initialHealth.source.capture !== 'running') throw new Error(`Real system capture must be running: ${initialHealth.source.detail}`);
let clients = [];
let observer;
let player;
let stopping = false;
let begin;
let failure = null;
let initialSnapshot;
const audioRuns = [];
const pendingAcks = new Map();
process.on('SIGINT', () => { stopping = true; });
async function command(value) {
  const requestId = randomUUID();
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingAcks.delete(requestId); reject(new Error(`Command acknowledgement timeout: ${value.type}`)); }, 6000);
    pendingAcks.set(requestId, { resolve, reject, timer });
  });
  observer.send(JSON.stringify({ version: 1, type: 'command', requestId, command: value }));
  const ack = await response;
  commands.push({ at: new Date().toISOString(), command: value, ack });
  return ack;
}
function playFixture() {
  const audioPath = path.resolve('artifacts/hardware-2026-09-09-two-quest/system-audio-120bpm.wav');
  const run = { startedAt: new Date().toISOString(), input: audioPath, volume: 0.12 };
  audioRuns.push(run);
  const child = spawn('/usr/bin/afplay', ['-v', '0.12', audioPath], { stdio: 'ignore' });
  player = child;
  child.on('error', error => { run.error = error.message; stopping = true; });
  child.once('exit', (code, signal) => {
    run.endedAt = new Date().toISOString(); run.code = code; run.signal = signal;
    if (code !== 0 && !stopping) { run.error = 'Audio player exited unsuccessfully'; stopping = true; }
    if (!stopping) playFixture();
  });
}
try {
  for (const device of devices) {
    const client = await cdp(device); clients.push(client);
    await client.evaluate(installFrameProbe);
  }
  observer = await connect('ws://127.0.0.1:8787/ws', { origin: 'http://localhost:8787' });
  const snapshotReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Authenticated snapshot timeout')), 8000);
    observer.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'snapshot' && !initialSnapshot) { initialSnapshot = message; clearTimeout(timer); resolve(); }
      if (message.type === 'frame') {
        frameStats.count += 1; frameStats.bytes += raw.length;
        const frame = message.frame ?? message;
        frameStats.firstFrameKeys ??= Object.keys(frame);
        const audio = frame.audio ?? frame.features ?? frame;
        if (typeof audio.level === 'number') {
          frameStats.maxLevel = Math.max(frameStats.maxLevel, audio.level);
          if (audio.level > 0.001) frameStats.nonSilent += 1;
        }
      }
      if (message.requestId && pendingAcks.has(message.requestId)) {
        const { resolve: ok, reject: no, timer: ackTimer } = pendingAcks.get(message.requestId);
        pendingAcks.delete(message.requestId); clearTimeout(ackTimer);
        message.type === 'ack' ? ok(message) : no(new Error(JSON.stringify(message)));
      }
    });
  });
  observer.send(JSON.stringify({ version: 1, type: 'hello', role: 'dashboard', name: 'Authorized hackathon soak', token: process.env.CONTROL_TOKEN }));
  await snapshotReady;
  await command({ type: 'start' });
  begin = performance.now();
  playFixture();
  console.log(JSON.stringify({ state: 'running', output, seconds: durationMs / 1000 }));
  let previousPhase = '';
  let previousQuality = '';
  let lastEffectSlot = -1;
  let lastHeapSlot = -1;
  let lastProgressSlot = -1;
  const captured = new Set();
  while (!stopping && performance.now() - begin < durationMs) {
    const elapsed = performance.now() - begin;
    const initialSweep = elapsed < 180000;
    const quality = initialSweep ? ['low', 'medium', 'high'][Math.floor(elapsed / 60000)] : 'medium';
    const scene = initialSweep ? Math.floor(elapsed / 12000) % 5 : Math.floor((elapsed - 180000) / 45000) % 15;
    const phase = `${quality}-${scene}-${initialSweep ? 'sweep' : 'soak'}`;
    if (quality !== previousQuality) {
      for (const client of clients) await client.evaluate(selectQuality, quality);
      for (const key of ['density', 'intensity', 'glow', 'masterFX']) {
        await command({ type: 'control', key, value: quality === 'high' ? 1 : initialSnapshot.state.controls[key] });
      }
      previousQuality = quality;
    }
    if (phase !== previousPhase) { await command({ type: 'scene', scene }); previousPhase = phase; }
    const effectSlot = Math.floor(elapsed / 90000);
    if (elapsed % 90000 > 12000 && effectSlot !== lastEffectSlot) {
      await command({ type: 'drop', duration: 1800, strength: 0.4, targetScene: scene });
      lastEffectSlot = effectSlot;
    }
    const heapSlot = Math.floor(elapsed / 15000);
    for (const client of clients) {
      const state = await client.evaluate(sample);
      const row = {
        at: new Date().toISOString(), elapsedMs: performance.now() - begin, device: client.name,
        expected: { scene, quality }, ...state,
        cpu: { samples: state.cpu.length, p95Ms: percentile(state.cpu, 0.95), maxMs: state.cpu.length ? Math.max(...state.cpu) : null },
        gaps: { samples: state.gaps.length, p95Ms: percentile(state.gaps, 0.95), maxMs: state.gaps.length ? Math.max(...state.gaps) : null },
      };
      if (heapSlot !== lastHeapSlot) row.heap = await client.call('Runtime.getHeapUsage');
      rows.push(row);
      fs.appendFileSync(path.join(output, 'samples.jsonl'), `${JSON.stringify(row)}\n`);
      const captureKey = `${client.name}-${quality}-${scene}`;
      if (initialSweep && quality === 'medium' && elapsed % 12000 >= 7000 && !captured.has(captureKey)) {
        const filename = `${captureKey}.png`;
        try {
          fs.writeFileSync(path.join(output, filename), execFileSync('adb', ['-s', client.serial, 'exec-out', 'screencap', '-p'], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 }));
          screenshots.push({ filename, scene, quality, device: client.name, xr: state.stats.xr });
        } catch (error) { exceptions.push({ source: 'screenshot', device: client.name, message: error.message }); }
        captured.add(captureKey);
      }
    }
    lastHeapSlot = heapSlot;
    const progressSlot = Math.floor(elapsed / 60000);
    if (progressSlot !== lastProgressSlot) {
      const last = rows.slice(-2);
      console.log(JSON.stringify({ elapsedSeconds: Math.round(elapsed / 1000), states: last.map(r => ({ device: r.device, scene: r.state.scene, fps: r.stats.fps, xr: r.stats.xr, frames: r.frames, source: r.source.capture })) }));
      lastProgressSlot = progressSlot;
    }
    await sleep(2000);
  }
} catch (error) {
  failure = error.stack ?? String(error);
} finally {
  const elapsedMs = begin === undefined ? 0 : performance.now() - begin;
  stopping = true;
  if (player && player.exitCode === null) player.kill('SIGTERM');
  if (observer?.readyState === WebSocket.OPEN && initialSnapshot) {
    try {
      await command({ type: 'clear' });
      for (const [key, value] of Object.entries(initialSnapshot.state.controls)) await command({ type: 'control', key, value });
      await command({ type: 'scene', scene: initialSnapshot.state.scene });
      await command({ type: 'start' });
    } catch (error) { exceptions.push({ source: 'restore-show', message: error.message }); }
  }
  for (const client of clients) {
    try { await client.evaluate(selectQuality, 'medium'); await client.evaluate(removeFrameProbe); }
    catch (error) { exceptions.push({ source: 'restore-probe', device: client.name, message: error.message }); }
    client.socket.close();
  }
  observer?.close();
  const perDevice = devices.map(device => {
    const samples = rows.filter(row => row.device === device.name);
    const heaps = samples.filter(row => row.heap).map(row => row.heap.usedSize);
    return {
      device: device.name, samples: samples.length,
      xrSamples: samples.filter(row => row.stats.xr).length,
      connectedSamples: samples.filter(row => row.connected).length,
      captureRunningSamples: samples.filter(row => row.source.capture === 'running').length,
      freshXRFrames: samples.reduce((sum, row) => sum + row.frames, 0),
      medianFps: percentile(samples.map(row => row.stats.fps), 0.5),
      p05Fps: percentile(samples.map(row => row.stats.fps), 0.05),
      maxCallbackCpuMs: samples.length ? Math.max(...samples.map(row => row.cpu.maxMs ?? 0)) : null,
      heap: { samples: heaps.length, first: heaps[0], last: heaps.at(-1), min: heaps.length ? Math.min(...heaps) : null, max: heaps.length ? Math.max(...heaps) : null },
      scenes: [...new Set(samples.map(row => row.state.scene))].sort((a, b) => a - b),
      qualities: [...new Set(samples.map(row => row.stats.quality))],
    };
  });
  const report = {
    startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), requestedDurationMs: durationMs, elapsedMs,
    pass: !failure && elapsedMs >= durationMs && perDevice.every(d => d.samples > 0 && d.xrSamples === d.samples && d.connectedSamples === d.samples && d.captureRunningSamples === d.samples && d.freshXRFrames > 0) && !exceptions.length,
    failure, initialHealth, perDevice, frameStats: { ...frameStats, cadenceHz: frameStats.count / (elapsedMs / 1000) },
    exceptions, screenshots, commands, audioRuns,
    limitations: [
      'Real macOS playback of a generated 120 BPM fixture, including its intentional silent passages; not a continuous music-library rehearsal.',
      'Automated commands supplement earlier operator-confirmed physical MIDI tests; this is not a new manual rehearsal.',
      'JavaScript XR callbacks and application FPS are not GPU/compositor timing or photon measurements.',
      'Heap samples describe JavaScript allocation only; they do not prove absence of GPU resource leaks.',
      'Visual screenshots require separate inspection; the pass flag cannot establish stereo image quality or spatial accuracy.',
    ],
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

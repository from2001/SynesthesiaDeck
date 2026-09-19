import WebSocket from 'ws';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// Requires the two known Quest CDP sockets forwarded to localhost:9223/9224.
// This is a physical-browser check. No certificate bypasses or simulated HMDs are used.
const manifest = JSON.parse(await readFile('artifacts/https-preview.json', 'utf8'));
if (manifest.state !== 'ready' || Date.now() - Date.parse(manifest.updatedAt) > 20000) throw new Error('HTTPS preview is not freshly ready');
const origin = new URL(manifest.urls.publicAuthority).origin;
const url = `${origin}/?view=hmd&server=${encodeURIComponent(origin)}`;
const directory = `artifacts/quest-wss-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin, devices: [], errors: [], wifiReconnect: null };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probes = [];

async function attach(serial, port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const target = targets.find(target => target.type === 'page' && target.url.startsWith(origin) && target.url.includes('view=hmd'))
    ?? targets.find(target => target.type === 'page' && target.url.startsWith('http://localhost:8787/') && target.url.includes('view=hmd'));
  if (!target) throw new Error(`No show page on ${serial}`);
  const device = { serial, port, targetId: target.id, socketUrls: [], frames: 0, pongs: 0, telemetry: [], snapshots: [], tls: [], exceptions: [] };
  report.devices.push(device);
  const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map(); let sequence = 0;
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      return;
    }
    const params = message.params;
    if (message.method === 'Network.webSocketCreated') device.socketUrls.push(params.url);
    if (message.method === 'Network.responseReceived' && params.response.securityDetails) {
      const { protocol, issuer, subjectName, validFrom, validTo } = params.response.securityDetails;
      if (!device.tls.some(item => item.subjectName === subjectName)) device.tls.push({ protocol, issuer, subjectName, validFrom, validTo });
    }
    if (message.method === 'Runtime.exceptionThrown') device.exceptions.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (message.method === 'Network.webSocketFrameReceived' || message.method === 'Network.webSocketFrameSent') {
      try {
        const frame = JSON.parse((params.response ?? params.request).payloadData);
        if (frame.type === 'frame') device.frames++;
        if (frame.type === 'pong') device.pongs++;
        if (frame.type === 'telemetry') device.telemetry.push(frame.telemetry);
        if (frame.type === 'snapshot') device.snapshots.push({ clientId: frame.clientId, serverTime: frame.serverTime, state: frame.state });
      } catch { /* Only parse the show's text WebSocket protocol. */ }
    }
  });
  socket.on('error', error => report.errors.push(`${serial}: ${error.message}`));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out on ${serial}`)); }, 6000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, gesture = false) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: gesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const read = async () => JSON.parse(await evaluate('JSON.stringify({url:location.href,secure:isSecureContext,userAgent:navigator.userAgent,diagnostics:window.__nanokon??null,notice:document.querySelector("#notice")?.textContent})'));
  const until = async (predicate, timeout = 30000) => {
    const end = Date.now() + timeout;
    let state;
    do { state = await read(); if (predicate(state)) return state; await delay(300); } while (Date.now() < end);
    throw new Error(`Quest wait timed out: ${JSON.stringify(state)}`);
  };
  const probe = { device, socket, send, evaluate, read, until }; probes.push(probe);
  await send('Network.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  device.connected = await until(state => state.secure && state.diagnostics?.connected && state.diagnostics.clockLocked && state.diagnostics.renderReady);
  console.log(JSON.stringify({ serial, secure: true, connected: true, locked: true }));
  return probe;
}

try {
  const a = await attach('340YC10G8B0LR0', 9223);
  const b = await attach('340YC10GBB1CWQ', 9224);
  for (const probe of [a, b]) {
    await probe.evaluate('document.querySelector("#enter-mr").click()', true);
    try { probe.device.entered = await probe.until(state => state.diagnostics?.stats.xr, 20000); }
    catch (error) { probe.device.entryError = String(error); }
  }
  if (b.device.entered) {
    await b.evaluate('document.querySelector("#enter-mr").click()', true);
    try {
      b.device.exited = await b.until(state => state.diagnostics && !state.diagnostics.stats.xr, 8000);
      await b.evaluate('document.querySelector("#enter-mr").click()', true);
      b.device.reentered = await b.until(state => state.diagnostics?.stats.xr, 20000);
    } catch (error) { b.device.exitReentryError = String(error); }
  }
  if (process.argv.includes('--wifi-reconnect')) {
    const serial = b.device.serial;
    const wifiBefore = execFileSync('adb', ['-s', serial, 'shell', 'cmd', 'wifi', 'status'], { encoding: 'utf8', timeout: 5000 });
    if (!/Wifi is enabled/i.test(wifiBefore)) throw new Error('Wi-Fi is not confirmed enabled; leaving its configuration unchanged');
    const before = await b.read(), initialCount = b.device.snapshots.length;
    report.wifiReconnect = { kind: 'Actual Quest Wi-Fi disabled and re-enabled through adb; USB debugging remains connected', before, initialSnapshotCount: initialCount };
    try {
      execFileSync('adb', ['-s', serial, 'shell', 'svc', 'wifi', 'disable'], { timeout: 5000 });
      await delay(15000); report.wifiReconnect.offline = await b.read();
    } finally { execFileSync('adb', ['-s', serial, 'shell', 'svc', 'wifi', 'enable'], { timeout: 5000 }); }
    report.wifiReconnect.after = await b.until(state => state.diagnostics?.connected && state.diagnostics.clockLocked && b.device.snapshots.length > initialCount, 45000);
    report.wifiReconnect.reference = await a.read();
    const recovered = report.wifiReconnect.after.diagnostics.state, reference = report.wifiReconnect.reference.diagnostics.state;
    report.wifiReconnect.pass = recovered.epoch === reference.epoch && recovered.scene === reference.scene && recovered.seed === reference.seed && recovered.effects.length === 0;
  }
  await delay(3000);
  report.pass = report.devices.every(device => device.connected.secure && device.frames > 0 && device.pongs > 0 && device.socketUrls.includes(origin.replace('https:', 'wss:') + '/ws'));
} catch (error) { report.errors.push(String(error)); report.pass = false; }
finally {
  for (const probe of probes) probe.socket.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, pass: report.pass, wifiReconnect: report.wifiReconnect?.pass, devices: report.devices.map(device => ({ serial: device.serial, frames: device.frames, pongs: device.pongs, tls: device.tls, xr: Boolean(device.entered), exited: Boolean(device.exited), reentered: Boolean(device.reentered), entryError: device.entryError, exitReentryError: device.exitReentryError })), errors: report.errors }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

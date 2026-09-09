/**
 * Desktop-only system verification. Run after `npm run native:build`:
 *   npx tsx scripts/verify-system.ts
 * Override NATIVE_EXECUTABLE to use another already-built Swift executable.
 * OpenSSL is required. No capture, physical MIDI, HMD, or global CA trust is used.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { startServer } from '../server/app.js';
import { NativeMessageSchema, ServerMessageSchema, type NativeMessage, type ServerMessage, type ShowState } from '../shared/protocol.js';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const executable = resolve(process.env.NATIVE_EXECUTABLE ?? join(repository, 'native/.build/debug/nanokon-host'));
const fixturePath = join(repository, 'scripts/fixtures/verify-system-midi.json');
const credentials = {
  controlToken: 'loopback-verification-dashboard-token-only',
  nativeToken: 'loopback-verification-native-token-only',
};
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const rounded = (value: number) => Math.round(value * 1000) / 1000;
type RunningServer = Awaited<ReturnType<typeof startServer>>;
type Frame = Extract<ServerMessage, { type: 'frame' }>;
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
interface IngestRecord { message: NativeMessage; receivedAt: number; status: number }
interface SimulatedBrowser { ws: WebSocket; messages: ServerMessage[]; failures: string[] }

async function waitFor<T>(read: () => T | undefined, description: string, timeoutMs = 3000): Promise<T> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const result = read();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error(`Timed out: ${description}`);
}

async function certificate(directory: string) {
  const caKey = join(directory, 'ca-key.pem');
  const ca = join(directory, 'ca.pem');
  const key = join(directory, 'server-key.pem');
  const csr = join(directory, 'server.csr');
  const cert = join(directory, 'server.pem');
  const extensions = join(directory, 'server-ext.cnf');
  await writeFile(extensions, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=NanoKon desktop verification temporary CA', '-keyout', caKey, '-out', ca]);
  await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', key, '-out', csr]);
  await exec('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-extfile', extensions, '-out', cert]);
  return { ca: await readFile(ca), tls: { cert: await readFile(cert), key: await readFile(key) } };
}

async function httpsText(url: string, ca: Buffer): Promise<string> {
  return new Promise((resolveText, reject) => {
    const request = get(url, { ca, rejectUnauthorized: true, timeout: 3000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode === 200) resolveText(text);
        else reject(new Error(`HTTPS returned ${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS timed out')));
    request.on('error', reject);
  });
}

async function browser(server: RunningServer, ca: Buffer, name: string): Promise<SimulatedBrowser> {
  const ws = new WebSocket(server.url.replace('https:', 'wss:') + '/ws', { ca, rejectUnauthorized: true, origin: server.url });
  const client: SimulatedBrowser = { ws, messages: [], failures: [] };
  ws.on('message', data => {
    try { client.messages.push(ServerMessageSchema.parse(JSON.parse(data.toString()))); }
    catch (error) { client.failures.push(String(error)); }
  });
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject); });
  ws.on('error', error => client.failures.push(error.message));
  ws.send(JSON.stringify({ version: 1, type: 'hello', role: 'hmd', name }));
  await waitFor(() => client.messages.find(message => message.type === 'snapshot'), `${name} snapshot`);
  return client;
}

function observeNative(server: RunningServer): { records: IngestRecord[]; failures: string[] } {
  const records: IngestRecord[] = [];
  const failures: string[] = [];
  // This passive listener records the same request stream without consuming or
  // modifying the authority's parser, authentication, response, or timing.
  server.native.on('request', (request, response) => {
    if (request.url !== '/ingest') return;
    let text = '';
    let record: IngestRecord | undefined;
    request.on('data', chunk => { text += chunk.toString(); });
    request.on('end', () => {
      try {
        record = { message: NativeMessageSchema.parse(JSON.parse(text)), receivedAt: server.authority.now(), status: 0 };
        records.push(record);
      } catch (error) { failures.push(String(error)); }
    });
    response.on('finish', () => {
      if (record) record.status = response.statusCode;
      if (response.statusCode !== 200) failures.push(`Native ingest HTTP ${response.statusCode}`);
    });
  });
  return { records, failures };
}

async function runNative(server: RunningServer, args: string[], seconds: number): Promise<string> {
  const child = spawn(executable, [...args, '--midi-source', '__nanokon_desktop_verification_no_physical_input__', '--duration', String(seconds)], {
    cwd: repository,
    env: { ...process.env, SHOW_NATIVE_URL: `http://127.0.0.1:${server.nativePort}`, NATIVE_TOKEN: credentials.nativeToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-65536); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-65536); });
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const watchdog = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1500);
  }, (seconds + 10) * 1000);
  try {
    await new Promise<void>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0 && !timedOut) resolveExit();
        else reject(new Error(`Native host failed (code=${code}, signal=${signal}, timeout=${timedOut}):\n${output}`));
      });
    });
    assert(!output.includes('Native bridge unavailable'), `Native bridge reported a failure:\n${output}`);
    assert(!output.includes('CoreMIDI input connected'), 'A physical MIDI source was unexpectedly connected');
    return output;
  } finally {
    clearTimeout(watchdog);
    if (forceKill) clearTimeout(forceKill);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function lastState(client: SimulatedBrowser): ShowState {
  const message = [...client.messages].reverse().find((entry): entry is Frame | Snapshot => entry.type === 'frame' || entry.type === 'snapshot');
  assert(message, 'Client never received a state');
  return message.state;
}

async function main(): Promise<void> {
  assert(process.platform === 'darwin', 'The real native executable verification requires macOS');
  await access(executable, constants.X_OK).catch(() => { throw new Error(`Build the Swift host first (npm run native:build), or set NATIVE_EXECUTABLE. Missing: ${executable}`); });
  const directory = await mkdtemp(join(tmpdir(), 'nanokon-system-'));
  const clients: SimulatedBrowser[] = [];
  let server: RunningServer | undefined;
  try {
    const { ca, tls } = await certificate(directory);
    const distDirectory = join(directory, 'dist');
    await mkdir(distDirectory);
    await writeFile(join(distDirectory, 'index.html'), '<!doctype html><title>Desktop TLS verification</title>');
    server = await startServer({ ...credentials, host: '127.0.0.1', port: 0, nativePort: 0, tls, production: true, distDirectory, synthetic: false });
    const observed = observeNative(server);
    const health = JSON.parse(await httpsText(server.url + '/health', ca));
    assert.equal(health.transport, 'https');
    assert((await httpsText(server.url + '/', ca)).includes('Desktop TLS verification'));
    await assert.rejects(httpsText(server.url + '/health', Buffer.alloc(0)), /certificate|verify/i, 'Untrusted certificates must fail');
    clients.push(...await Promise.all([browser(server, ca, 'Simulated HMD A'), browser(server, ca, 'Simulated HMD B')]));
    assert.equal(lastState(clients[0]).running, false);
    assert.equal(server.authority.source.capture, 'stopped', 'Server-side synthetic audio must remain disabled');
    console.info('TLS certificate chain and hostname verified; two WSS clients connected. Starting real Swift analysis.');

    await runNative(server, ['--synthetic'], 8);
    const audioRecords = observed.records.filter((record): record is IngestRecord & { message: Extract<NativeMessage, { type: 'audio' }> } => record.message.type === 'audio');
    assert(audioRecords.length >= 200, `Too few real Swift audio frames: ${audioRecords.length}`);
    assert(audioRecords.every(record => record.status === 200 && record.message.source === 'synthetic'));
    const stamps = audioRecords.map(record => record.message.timestamp);
    const differences = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
    assert(differences.every(value => value > 0), 'Native capture timestamps must strictly increase');
    assert(Math.abs(percentile(differences, .5) - 1000 / 30) < .01, 'Analysis-window cadence must be 30 Hz');
    const deliveredHz = (audioRecords.length - 1) * 1000 / (stamps.at(-1)! - stamps[0]);
    assert(deliveredHz >= 27 && deliveredHz <= 31, `Unexpected native delivery cadence: ${deliveredHz}`);
    const ages = audioRecords.map(record => record.receivedAt - record.message.timestamp);
    assert(Math.min(...ages) > -25 && Math.max(...ages) < 300, 'Feature timestamps are not in the current master clock domain');
    const locked = audioRecords.filter(record => record.message.audio.bpmConfidence > .8 && Math.abs(record.message.audio.bpm - 120) < 1);
    assert(locked.length >= 80, 'The actual native analyzer did not lock to the 120 BPM fixture');
    assert(clients.every(client => client.messages.some(message => message.type === 'frame' && message.audioFrame.source === 'synthetic' && message.source.capture === 'synthetic')));
    assert(clients.every(client => client.messages.filter(message => message.type === 'frame' && message.audioFrame.source === 'synthetic').length >= 200));
    const syntheticSummary = { frames: audioRecords.length, deliveredHz: rounded(deliveredHz), timestampStepMs: rounded(percentile(differences, .5)), ageP95Ms: rounded(percentile(ages, .95)), acquiredBpm: rounded(locked.at(-1)!.message.audio.bpm) };
    console.info(`Swift features verified: ${JSON.stringify(syntheticSummary)}. Starting actual Swift MIDI replay.`);

    const eventStart = clients.map(client => client.messages.length);
    const ingressStart = observed.records.length;
    await runNative(server, ['--midi-replay', fixturePath], 3.5);
    await waitFor(() => clients.every(client => lastState(client).scene === 3 && lastState(client).running) ? true : undefined, 'MIDI final scene and transport');
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { at: number; status: number; data1: number; data2: number }[];
    const midiMessages = observed.records.slice(ingressStart).map(record => record.message).filter((message): message is Extract<NativeMessage, { type: 'midi' }> => message.type === 'midi');
    assert.deepEqual(midiMessages.map(({ status, data1, data2 }) => ({ status, data1, data2 })), fixture.map(({ status, data1, data2 }) => ({ status, data1, data2 })), 'Actual native canonical MIDI output differs from the replay');
    const events = clients.map((client, index) => client.messages.slice(eventStart[index]).filter((message): message is Extract<ServerMessage, { type: 'event' }> => message.type === 'event').map(message => message.event));
    assert.deepEqual(events[0], events[1], 'The two WSS clients received different scheduled MIDI events');
    assert.equal(events[0].filter(event => event.command.type === 'drop').length, 1, 'A held REC press retriggered DROP');
    assert.equal(events[0].filter(event => event.command.type === 'burst').length, 1);
    assert.deepEqual(events[0].filter(event => event.command.type === 'toggle').map(event => event.command), [{ type: 'toggle', slot: 0, value: true }, { type: 'toggle', slot: 0, value: false }]);
    assert.deepEqual(events[0].filter(event => event.command.type === 'scene').map(event => event.command), [{ type: 'scene', scene: 2 }, { type: 'scene', scene: 3 }]);
    for (const client of clients) {
      const state = lastState(client);
      assert.equal(state.effects.length, 0, 'STOP failed to clear DROP effects');
      assert.equal(state.controls.intensity, 110 / 127, 'Physical fader pickup was not applied');
      assert.equal(state.toggles[0], false);
      assert(client.messages.some(message => message.type === 'frame' && message.state.effects.some(effect => effect.kind === 'drop')), 'DROP was never active on the simulated client');
      assert(client.messages.some(message => message.type === 'frame' && !message.state.running && message.state.revision > 0), 'STOP was never observed');
      assert.equal(client.failures.length, 0, client.failures.join('\n'));
    }
    assert.deepEqual(lastState(clients[0]), lastState(clients[1]));
    assert.equal(observed.failures.length, 0, observed.failures.join('\n'));

    const originalEpoch = server.authority.epoch;
    for (const client of clients) client.ws.terminate();
    await server.close();
    server = await startServer({ ...credentials, host: '127.0.0.1', port: 0, nativePort: 0, tls, production: true, distDirectory, synthetic: false });
    const reconnected = await browser(server, ca, 'Simulated HMD after restart');
    clients.push(reconnected);
    const resetState = lastState(reconnected);
    assert.notEqual(resetState.epoch, originalEpoch);
    assert.equal(resetState.revision, 0);
    assert.equal(resetState.running, false);
    assert.equal(resetState.effects.length, 0);
    const report = { passed: true, scope: 'Desktop simulation only; no actual HMD, audio capture, or physical MIDI input', tls: 'Trusted temporary CA plus hostname verification; untrusted chain rejected', synthetic: syntheticSummary, midi: { inputMessages: midiMessages.length, scheduledEvents: events[0].length, dropEvents: 1, finalScene: 3, clientsAgreed: true }, restart: { newEpoch: true, stopped: true } };
    console.info(JSON.stringify(report, null, 2));
    if (process.env.VERIFY_OUTPUT) {
      const output = resolve(process.env.VERIFY_OUTPUT);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
  } finally {
    for (const client of clients) client.ws.terminate();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });

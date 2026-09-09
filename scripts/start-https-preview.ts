import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/app.js';
import { MidiProfileSchema, type MidiProfile } from '../server/midi.js';

export class PreviewError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'PreviewError'; }
}

export type TunnelProvider = 'cloudflare' | 'ngrok';
export interface PreviewConfiguration {
  repository: string; frontendOrigin: string; port: number; nativePort: number;
  allowedOrigins: string[]; synthetic: boolean; provider: TunnelProvider; cloudflaredBin?: string; ngrokBin?: string; ngrokConfig?: string;
}
export interface PreviewURLs { localDesk: string; fixedDesk: string; fixedAudience: string; publicAuthority: string; nativeBridge: string }
export interface PreviewStatus {
  version: 1; state: 'starting' | 'ready' | 'stopped' | 'failed'; updatedAt: string; pid: number;
  frontendOrigin?: string; provider?: TunnelProvider; urls?: PreviewURLs; message?: string;
}
export interface TunnelExit { code: number | null; signal: string | null }
export interface TunnelHandle { origin: Promise<string>; closed: Promise<TunnelExit>; stop(): Promise<void> }
export interface AuthorityHandle { epoch: string; close(): Promise<void> }
export interface PreviewServices {
  prepare(configuration: PreviewConfiguration): Promise<() => Promise<void>>;
  tunnel(configuration: PreviewConfiguration): TunnelHandle;
  authority(configuration: PreviewConfiguration, publicOrigin: string): Promise<AuthorityHandle>;
  ready(configuration: PreviewConfiguration, publicOrigin: string, authority: AuthorityHandle, signal: AbortSignal): Promise<void>;
  heartbeat(configuration: PreviewConfiguration, authority: AuthorityHandle, signal: AbortSignal): Promise<void>;
  status(status: PreviewStatus): Promise<void>;
  log(message: string): void;
}

interface PreviewLockOwner { version: 1; pid: number; owner: string }
type ProcessProbe = (pid: number) => boolean;
const repositoryBusy = () => new PreviewError('Another HTTPS preview owns this repository, or its ownership cannot be safely verified. The existing status was preserved; no process was stopped.');
const errorCode = (reason: unknown) => (reason as NodeJS.ErrnoException | undefined)?.code;

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (reason) { return errorCode(reason) !== 'ESRCH'; }
}

async function readLockOwner(path: string): Promise<PreviewLockOwner | undefined> {
  try {
    if ((await stat(path)).size > 1024) throw repositoryBusy();
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PreviewLockOwner>;
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid! < 1 || typeof value.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(value.owner)) throw repositoryBusy();
    return value as PreviewLockOwner;
  } catch (reason) {
    if (errorCode(reason) === 'ENOENT') return undefined;
    throw repositoryBusy();
  }
}

/** Publish a complete lock atomically. Dead-owner recovery is serialized before inspecting/removing a stale lock. */
export async function acquirePreviewLock(repository: string, alive: ProcessProbe = processIsAlive): Promise<() => Promise<void>> {
  const directory = join(repository, 'artifacts');
  const lockPath = join(directory, 'https-preview.lock'), recoveryPath = `${lockPath}.recovery`;
  const owner: PreviewLockOwner = { version: 1, pid: process.pid, owner: randomUUID() };
  const candidate = join(directory, `.https-preview-${owner.owner}.candidate`);
  let acquired = false;
  await mkdir(directory, { recursive: true });
  await writeFile(candidate, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  const claim = async () => {
    try { await link(candidate, lockPath); acquired = true; }
    catch (reason) { if (errorCode(reason) === 'EEXIST') throw repositoryBusy(); throw reason; }
  };
  const release = async () => {
    if (!acquired) return;
    const current = await readLockOwner(lockPath);
    if (current?.owner === owner.owner && current.pid === owner.pid) await unlink(lockPath);
    // Never remove a replacement owner, including if a manual operation replaced our record.
    acquired = false;
  };
  try {
    try { await claim(); }
    catch (reason) {
      if (!(reason instanceof PreviewError)) throw reason;
      const observed = await readLockOwner(lockPath);
      if (observed && alive(observed.pid)) throw repositoryBusy();
      // Other contenders refuse while this guard exists. A guard left by a crash is conservatively not reclaimed.
      try { await mkdir(recoveryPath); } catch { throw repositoryBusy(); }
      try {
        const current = await readLockOwner(lockPath);
        if (current && alive(current.pid)) throw repositoryBusy();
        if (current) await unlink(lockPath);
        await claim();
      } finally { await rmdir(recoveryPath); }
    }
    // Preserve a live status written by an older runner that predates repository locks.
    try {
      const previous = JSON.parse(await readFile(join(directory, 'https-preview.json'), 'utf8')) as Partial<PreviewStatus>;
      if (previous && (previous.state === 'ready' || previous.state === 'starting') && Number.isSafeInteger(previous.pid) && previous.pid! > 0 && alive(previous.pid!)) throw repositoryBusy();
    } catch (reason) { if (reason instanceof PreviewError) throw reason; }
    return release;
  } catch (reason) { await release(); throw reason; }
  finally { await rm(candidate, { force: true }); }
}

/** The callback is the only place allowed to publish status, including configuration failures. */
export async function withPreviewRepositoryLock<T>(repository: string, run: () => Promise<T>, alive: ProcessProbe = processIsAlive): Promise<T> {
  const release = await acquirePreviewLock(repository, alive);
  try { return await run(); } finally { await release(); }
}

/** Explicit origins are trust boundaries; paths, user information and wildcard hosts are never accepted. */
export function exactOrigin(value: string, httpsOnly = true): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PreviewError('FRONTEND_ORIGIN and allowed origins must be exact HTTP(S) origins.'); }
  if (!(httpsOnly ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) || !url.hostname ||
      url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      value.trim() !== value || /[?#@]/.test(value)) throw new PreviewError('Use an exact trusted HTTPS frontend origin, without a path, query, credentials or wildcard.');
  return url.origin;
}

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new PreviewError('PORT and NATIVE_PORT must be integers from 1 to 65535.');
  return parsed;
}

export function previewConfiguration(environment: NodeJS.ProcessEnv, argv: string[] = [], repository = process.cwd()): PreviewConfiguration {
  let frontend = environment.FRONTEND_ORIGIN;
  let synthetic = environment.SHOW_SYNTHETIC === '1';
  let provider = environment.TUNNEL_PROVIDER ?? 'cloudflare';
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--synthetic') synthetic = true;
    else if (argv[index] === '--frontend-origin') {
      frontend = argv[++index];
      if (!frontend) throw new PreviewError('--frontend-origin requires an exact HTTPS origin.');
    } else if (argv[index] === '--provider') {
      provider = argv[++index] ?? '';
    } else throw new PreviewError('Unknown preview option. Use --help for frontend, provider and synthetic options.');
  }
  if (provider !== 'cloudflare' && provider !== 'ngrok') throw new PreviewError('TUNNEL_PROVIDER / --provider must be cloudflare or ngrok.');
  if (!frontend) throw new PreviewError('Set FRONTEND_ORIGIN to the fixed trusted Vercel/custom-domain HTTPS origin, or pass --frontend-origin.');
  const frontendOrigin = exactOrigin(frontend);
  const mainPort = port(environment.PORT, 8787), nativePort = port(environment.NATIVE_PORT, 8788);
  if (mainPort === nativePort) throw new PreviewError('PORT and NATIVE_PORT must be different; native ingest is never tunneled.');
  const additional = (environment.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => exactOrigin(value, false));
  return { repository: resolve(repository), frontendOrigin, port: mainPort, nativePort,
    allowedOrigins: [...new Set([frontendOrigin, ...additional])], synthetic, provider,
    cloudflaredBin: environment.CLOUDFLARED_BIN, ngrokBin: environment.NGROK_BIN, ngrokConfig: environment.NGROK_CONFIG };
}

export const previewHelp = `Usage: npm run preview:https -- [--provider cloudflare|ngrok] [--frontend-origin HTTPS_ORIGIN] [--synthetic]
FRONTEND_ORIGIN is required unless --frontend-origin is supplied. TUNNEL_PROVIDER defaults to cloudflare.
ngrok uses its existing private authentication configuration; NGROK_CONFIG and NGROK_BIN may select trusted paths.
PORT defaults to 8787; NATIVE_PORT defaults to 8788 and is never tunneled. Build dist/ before starting.
Only one preview may own a repository, even when different ports are selected.
Ctrl+C closes only this runner's authority and tunnel. --help does not start any service.`;

export function previewURLs(configuration: PreviewConfiguration, tunnelOrigin: string): PreviewURLs {
  const publicAuthority = exactOrigin(tunnelOrigin);
  const desk = new URL(configuration.frontendOrigin), audience = new URL(configuration.frontendOrigin);
  desk.searchParams.set('server', publicAuthority);
  audience.searchParams.set('view', 'hmd'); audience.searchParams.set('server', publicAuthority);
  return { localDesk: `http://127.0.0.1:${configuration.port}/`, fixedDesk: desk.href, fixedAudience: audience.href,
    publicAuthority, nativeBridge: `http://127.0.0.1:${configuration.nativePort}` };
}

/** cloudflared writes the generated origin to stderr, sometimes across multiple chunks. */
export class QuickTunnelOriginParser {
  private tail = '';
  push(chunk: string): string | undefined {
    this.tail = (this.tail + chunk).replace(/\u001b\[[0-9;]*m/g, '').slice(-16384);
    const match = this.tail.match(/https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?=[\s"'|<>),\]])/i);
    return match ? exactOrigin(match[0]) : undefined;
  }
}

export function cloudflaredArguments(configuration: PreviewConfiguration, emptyConfigPath: string): string[] {
  return ['tunnel', '--config', emptyConfigPath, '--no-autoupdate', '--url', `http://127.0.0.1:${configuration.port}`,
    '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--grace-period', '3s'];
}

/** Only a structured announcement for our exact loopback target can select the public origin. */
export class NgrokOriginParser {
  private tail = '';
  constructor(private readonly target: string) {}
  push(chunk: string): string | undefined {
    const lines = (this.tail + chunk).split(/\r?\n/);
    this.tail = (lines.pop() ?? '').slice(-16384);
    for (const line of lines) {
      if (line.length > 16384) continue;
      try {
        const item = JSON.parse(line) as { msg?: unknown; url?: unknown; addr?: unknown };
        if (item.msg === 'started tunnel' && typeof item.url === 'string' && item.addr === this.target) return exactOrigin(item.url);
      } catch { /* Ignore unrelated, malformed or incomplete provider log messages. */ }
    }
    return undefined;
  }
}

export function ngrokArguments(configuration: PreviewConfiguration, baseConfig: string, overlayConfig: string): string[] {
  // ngrok accepts repeated config flags; later settings override the existing authentication file.
  return ['http', `http://127.0.0.1:${configuration.port}`, '--config', baseConfig, '--config', overlayConfig,
    '--log', 'stdout', '--log-format', 'json', '--log-level', 'info', '--inspect=false'];
}

export function ngrokOverlay(version: 2 | 3): string {
  const indent = version === 3 ? '  ' : '';
  return `version: "${version}"\n${version === 3 ? 'agent:\n' : ''}` +
    ['web_addr: false', 'inspect_db_size: -1', 'console_ui: false', 'update_check: false', 'remote_management: false'].map(line => `${indent}${line}\n`).join('');
}

/** Inspect only the top-level format version; credentials remain in ngrok's existing private file. */
async function ngrokConfigVersion(path: string): Promise<2 | 3> {
  const input = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let inspected = 0;
  try {
    for await (const line of lines) {
      inspected += line.length;
      const match = line.match(/^version:\s*["']?([23])["']?\s*(?:#.*)?$/);
      if (match) return Number(match[1]) as 2 | 3;
      if (inspected > 65536) break;
    }
  } catch { throw new PreviewError('The existing ngrok configuration is unreadable. Set NGROK_CONFIG to the trusted authenticated config path.'); }
  finally { lines.close(); input.destroy(); }
  throw new PreviewError('The existing ngrok configuration must declare format version 2 or 3. The runner does not rewrite or upgrade it.');
}

export function ngrokDiagnostic(line: string): string | undefined {
  let item: { msg?: unknown; lvl?: unknown; err?: unknown };
  try { item = JSON.parse(line) as typeof item; } catch { return undefined; }
  if (!item || typeof item !== 'object') return undefined;
  if (item.msg === 'client session established') return 'ngrok: edge session established.';
  if (item.msg === 'started tunnel') return 'ngrok: HTTPS endpoint announced.';
  const errorText = typeof item.err === 'string' ? item.err : '';
  const code = errorText.match(/\bERR_NGROK_\d{1,6}\b/)?.[0];
  if (code) return `ngrok: provider reported ${code}; raw details are suppressed.`;
  if (item.lvl === 'eror' || item.lvl === 'error' || item.lvl === 'crit') return 'ngrok: an error was reported; raw log fields are suppressed.';
  if (item.lvl === 'warn') return 'ngrok: a warning was reported; raw log fields are suppressed.';
  return undefined;
}

/** Tunnel subprocesses do not inherit show credentials or unrelated provider tokens. */
export function tunnelEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

/** Fixed diagnostic categories expose tunnel progress without echoing cloudflared's arbitrary log fields. */
export function cloudflaredDiagnostic(line: string): string | undefined {
  if (/registered tunnel connection/i.test(line)) {
    const protocol = line.match(/protocol[=":\s]+(quic|http2)\b/i)?.[1]?.toLowerCase();
    return `cloudflared: edge connection established${protocol ? ` using ${protocol}` : ''}.`;
  }
  if (/failed to dial.*quic|failed to serve.*quic|quic.*handshake.*timeout/i.test(line)) return 'cloudflared: QUIC edge connection failed; the network may be blocking UDP.';
  if (/unable to reach the origin|dial tcp.*connection refused/i.test(line)) return 'cloudflared: the loopback origin connection failed.';
  if (/failed to request.*quick.*tunnel|request.*quick.*tunnel.*failed/i.test(line)) return 'cloudflared: the Quick Tunnel allocation request failed.';
  if (/x509:|certificate.*(expired|unknown authority|invalid)/i.test(line)) return 'cloudflared: TLS certificate verification failed.';
  if (/context deadline exceeded|timeout: no recent network activity/i.test(line)) return 'cloudflared: a network or edge-connection request timed out.';
  if (/no such host|temporary failure in name resolution/i.test(line)) return 'cloudflared: DNS resolution failed.';
  if (/\bERR\b|"level"\s*:\s*"error"/i.test(line)) return 'cloudflared: an error was reported; raw log fields are suppressed.';
  return undefined;
}

function failure(reason: unknown): PreviewError {
  return reason instanceof PreviewError ? reason : new PreviewError('HTTPS preview failed. Check the build, configuration, tunnel installation and network connection.');
}

/** Owns only the resources returned by its services; no global PID or port-based termination is used. */
export async function supervisePreview(configuration: PreviewConfiguration, services: PreviewServices, signal: AbortSignal): Promise<number> {
  let cleanup: (() => Promise<void>) | undefined, tunnel: TunnelHandle | undefined, authority: AuthorityHandle | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let ending = false, checking = false;
  let result: { state: 'stopped' | 'failed'; message: string; code: number } | undefined;
  const work = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>(resolveFinish => { finish = resolveFinish; });
  const stop = (state: 'stopped' | 'failed', message: string, code: number) => {
    if (result) return;
    result = { state, message, code }; work.abort(); finish();
  };
  const onAbort = () => {
    const reason = signal.reason as { exitCode?: number } | undefined;
    stop('stopped', 'Preview stopped; its tunnel and authority are closed.', reason?.exitCode ?? 0);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const status = (state: PreviewStatus['state'], fields: Partial<PreviewStatus> = {}) => services.status({ version: 1, state,
    updatedAt: new Date().toISOString(), pid: process.pid, frontendOrigin: configuration.frontendOrigin, provider: configuration.provider, ...fields });
  try {
    await status('starting', { message: 'Checking configuration and waiting for a public HTTPS tunnel.' });
    if (signal.aborted) onAbort();
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    cleanup = await services.prepare(configuration);
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    services.log(`Starting ${configuration.provider === 'ngrok' ? 'ngrok' : 'an isolated Quick Tunnel'} for the loopback production authority…`);
    tunnel = services.tunnel(configuration);
    void tunnel.closed.then(exit => {
      if (!ending) stop('failed', `${configuration.provider === 'ngrok' ? 'ngrok' : 'cloudflared'} exited${exit.code === null ? '' : ` with code ${exit.code}`}${exit.signal ? ` (${exit.signal})` : ''}; restart the preview and use its reported tunnel URL.`, exit.code && exit.code > 0 ? exit.code : 1);
    });
    const publicOrigin = await Promise.race([tunnel.origin, finished.then(() => { throw new PreviewError('Tunnel startup ended before it became ready.'); })]);
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    services.log(`${configuration.provider === 'ngrok' ? 'ngrok' : 'Quick Tunnel'} origin allocated (public health not verified yet): ${publicOrigin}`);
    await status('starting', { message: `Tunnel origin ${publicOrigin} was allocated; local authority and public HTTPS readiness are being checked.` });
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    authority = await services.authority(configuration, publicOrigin);
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    await services.ready(configuration, publicOrigin, authority, work.signal);
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    const urls = previewURLs(configuration, publicOrigin);
    await status('ready', { urls, message: 'Public HTTPS health check matches the local authority epoch.' });
    if (result) throw new PreviewError('Preview startup canceled.', 0);
    services.log(`Local desk: ${urls.localDesk}`);
    services.log(`Fixed frontend desk: ${urls.fixedDesk}`);
    services.log(`Audience / HMD: ${urls.fixedAudience}`);
    services.log(`Native bridge: ${urls.nativeBridge} (authenticated and loopback-only)`);
    services.log(configuration.provider === 'cloudflare' ? 'The Quick Tunnel URL changes on every restart. Use the links printed by the current runner.' : 'Use the ngrok URL printed by this runner; availability and address reuse depend on the existing account.');
    services.log('Keep this Mac awake and online; browser access does not need a USB cable.');
    services.log('Current nonsecret URLs and heartbeat: artifacts/https-preview.json');
    heartbeatTimer = setInterval(() => {
      if (checking || ending || result) return;
      checking = true;
      void services.heartbeat(configuration, authority!, work.signal).then(async () => {
        if (!ending && !result) await status('ready', { urls, message: 'Authority heartbeat is healthy.' });
      }).catch(reason => {
        if (!ending && !result) stop('failed', failure(reason).message, failure(reason).exitCode);
      }).finally(() => { checking = false; });
    }, 5000);
    await finished;
  } catch (reason) {
    if (!result) { const error = failure(reason); stop('failed', error.message, error.exitCode); }
  } finally {
    ending = true; work.abort(); clearInterval(heartbeatTimer); signal.removeEventListener('abort', onAbort);
    const closed = await Promise.allSettled([authority?.close(), tunnel?.stop()]);
    if (closed.some(item => item.status === 'rejected')) result = { state: 'failed', message: 'A preview resource did not shut down cleanly.', code: 1 };
    try { await cleanup?.(); } catch { result = { state: 'failed', message: 'Preview stopped, but its temporary tunnel configuration could not be removed.', code: 1 }; }
    const final = result ?? { state: 'stopped' as const, message: 'Preview stopped.', code: 0 };
    await status(final.state, { message: final.message });
    services.log(final.message);
  }
  return result?.code ?? 0;
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new PreviewError(`Loopback port ${port} is occupied or unavailable. Stop the owning application yourself, or choose different PORT/NATIVE_PORT values. No process was terminated.`)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(error => error ? reject(new PreviewError(`Could not release the port ${port} availability probe.`)) : resolvePort()));
  });
}

async function locateTunnelExecutable(configuration: PreviewConfiguration, environment: NodeJS.ProcessEnv): Promise<string> {
  const provider = configuration.provider === 'ngrok' ? 'ngrok' : 'cloudflared';
  const requested = (configuration.provider === 'ngrok' ? configuration.ngrokBin : configuration.cloudflaredBin) ?? provider;
  const candidates = requested.includes('/') || isAbsolute(requested) ? [resolve(configuration.repository, requested)] :
    [...(environment.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, requested)), `/opt/homebrew/bin/${requested}`, `/usr/local/bin/${requested}`];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next explicit executable location. */ }
  }
  throw new PreviewError(`${provider} is not installed or executable. Install it or set ${configuration.provider === 'ngrok' ? 'NGROK_BIN' : 'CLOUDFLARED_BIN'} to a trusted executable path.`);
}

function launchTunnel(executable: string, configuration: PreviewConfiguration, configPath: string, environment: NodeJS.ProcessEnv, ngrokBaseConfig: string): TunnelHandle {
  let child: ChildProcess;
  const provider = configuration.provider === 'ngrok' ? 'ngrok' : 'cloudflared';
  let resolveOrigin!: (origin: string) => void, rejectOrigin!: (reason: Error) => void;
  const origin = new Promise<string>((resolveValue, reject) => { resolveOrigin = resolveValue; rejectOrigin = reject; });
  let resolveClosed!: (exit: TunnelExit) => void;
  const closed = new Promise<TunnelExit>(resolveExit => { resolveClosed = resolveExit; });
  const diagnostics = new Set<string>();
  let ended = false, discovered = false, stopPromise: Promise<void> | undefined;
  const timeout = setTimeout(() => rejectOrigin(new PreviewError(`${provider} did not announce an HTTPS tunnel URL within 60 seconds. Check Internet access and provider configuration.`)), 60000);
  const args = configuration.provider === 'ngrok' ? ngrokArguments(configuration, ngrokBaseConfig, configPath) : cloudflaredArguments(configuration, configPath);
  try { child = spawn(executable, args, { cwd: configuration.repository, env: tunnelEnvironment(environment), stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
  catch { clearTimeout(timeout); throw new PreviewError(`${provider} could not be launched. Check its configured executable and permissions.`); }
  const output = () => {
    // Keep stdout/stderr fragments separate so their asynchronously interleaved chunks cannot form a false record.
    const parser = configuration.provider === 'ngrok' ? new NgrokOriginParser(`http://127.0.0.1:${configuration.port}`) : new QuickTunnelOriginParser();
    let diagnosticTail = '';
    return (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!discovered) {
        const value = parser.push(text);
        if (value) { discovered = true; clearTimeout(timeout); resolveOrigin(value); }
      }
      const lines = (diagnosticTail + text).slice(-16384).split(/\r?\n/);
      diagnosticTail = lines.pop() ?? '';
      for (const line of lines) {
        const diagnostic = configuration.provider === 'ngrok' ? ngrokDiagnostic(line) : cloudflaredDiagnostic(line);
        if (diagnostic && !diagnostics.has(diagnostic)) { diagnostics.add(diagnostic); console.info(diagnostic); }
      }
    };
  };
  child.stdout?.on('data', output()); child.stderr?.on('data', output());
  child.once('error', () => {
    clearTimeout(timeout); ended = true;
    rejectOrigin(new PreviewError(`${provider} could not start. Check installation and executable permissions.`));
    resolveClosed({ code: 1, signal: null });
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout); ended = true; resolveClosed({ code, signal });
    if (!discovered) rejectOrigin(new PreviewError(`${provider} exited before announcing an HTTPS tunnel URL.`, code && code > 0 ? code : 1));
  });
  return { origin, closed, stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      clearTimeout(timeout);
      if (ended) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 4000);
      try { await closed; } finally { clearTimeout(force); }
    })();
    return stopPromise;
  } };
}

function statusWriter(repository: string): (status: PreviewStatus) => Promise<void> {
  const path = join(repository, 'artifacts/https-preview.json');
  let chain = Promise.resolve();
  return status => {
    chain = chain.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
      catch { await rm(temporary, { force: true }).catch(() => {}); await rm(path, { force: true }).catch(() => {}); throw new PreviewError('Could not update artifacts/https-preview.json; preview was stopped to avoid a stale ready status.'); }
    });
    return chain;
  };
}

/** Classify network failures without echoing arbitrary error messages, URLs, headers or credentials. */
export function healthNetworkFailure(reason: unknown): string {
  const error = reason as { name?: unknown; cause?: { code?: unknown } } | undefined;
  const code = error?.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Health DNS lookup failed (${code}).`;
  if (code === 'ECONNREFUSED') return 'Health connection was refused (ECONNREFUSED).';
  if (code === 'ECONNRESET') return 'Health connection was reset (ECONNRESET).';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Health request timed out or was canceled after three seconds.';
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'Health TLS certificate validation failed.';
  return 'Health network request failed before receiving an HTTP response.';
}

async function health(origin: string, epoch: string, signal: AbortSignal): Promise<void> {
  let response: Response;
  try { response = await fetch(new URL('/health', origin), { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error', cache: 'no-store' }); }
  catch (reason) { throw new PreviewError(healthNetworkFailure(reason)); }
  if (!response.ok) throw new PreviewError(`The authority health endpoint returned HTTP ${response.status}.`);
  let body: { version?: unknown; epoch?: unknown };
  try { body = await response.json(); }
  catch { throw new PreviewError('The health endpoint returned a non-JSON response.'); }
  if (body.version !== 1 || body.epoch !== epoch) throw new PreviewError('The health response does not match this runner’s authority.');
}

function productionServices(environment: NodeJS.ProcessEnv, writeStatus: PreviewServices['status']): PreviewServices {
  let executable = '', configPath = '', ngrokBaseConfig = '', midiProfile: MidiProfile | undefined;
  return {
    async prepare(configuration) {
      for (const key of ['CONTROL_TOKEN', 'NATIVE_TOKEN'] as const) {
        const length = environment[key]?.length ?? 0;
        if (length < 24 || length > 256) throw new PreviewError('Existing private CONTROL_TOKEN and NATIVE_TOKEN must each contain 24–256 characters. Run setup or correct the private .env; credentials are never printed.');
      }
      if (environment.CONTROL_TOKEN === environment.NATIVE_TOKEN) throw new PreviewError('Use separate private CONTROL_TOKEN and NATIVE_TOKEN credentials.');
      try { if (!(await stat(join(configuration.repository, 'dist/index.html'))).isFile()) throw new Error(); }
      catch { throw new PreviewError('Built dist/index.html is missing. Run npm run build before starting the HTTPS preview.'); }
      executable = await locateTunnelExecutable(configuration, environment);
      await assertPortAvailable(configuration.port); await assertPortAvailable(configuration.nativePort);
      if (environment.MIDI_PROFILE) {
        try { midiProfile = MidiProfileSchema.parse(JSON.parse(await readFile(resolve(configuration.repository, environment.MIDI_PROFILE), 'utf8'))); }
        catch { throw new PreviewError('MIDI_PROFILE must refer to a readable, valid server MIDI profile.'); }
      }
      let temporaryConfiguration = '{}\n';
      if (configuration.provider === 'ngrok') {
        ngrokBaseConfig = configuration.ngrokConfig ? resolve(configuration.repository, configuration.ngrokConfig) :
          join(homedir(), 'Library/Application Support/ngrok/ngrok.yml');
        // Repeated --config flags still parse comma-separated paths; refuse an ambiguous private config path.
        if (ngrokBaseConfig.includes(',')) throw new PreviewError('NGROK_CONFIG must be a single trusted configuration path without commas.');
        temporaryConfiguration = ngrokOverlay(await ngrokConfigVersion(ngrokBaseConfig));
      }
      const directory = await mkdtemp(join(tmpdir(), 'nanokon-https-tunnel-'));
      configPath = join(directory, 'config.yml');
      try { await writeFile(configPath, temporaryConfiguration, { mode: 0o600 }); }
      catch { await rm(directory, { recursive: true, force: true }); throw new PreviewError('Could not create the independent temporary tunnel configuration.'); }
      return () => rm(directory, { recursive: true, force: true });
    },
    tunnel: configuration => launchTunnel(executable, configuration, configPath, environment, ngrokBaseConfig),
    async authority(configuration, publicOrigin) {
      try {
        const server = await startServer({ host: '127.0.0.1', port: configuration.port, nativePort: configuration.nativePort,
          controlToken: environment.CONTROL_TOKEN!, nativeToken: environment.NATIVE_TOKEN!, publicOrigin, trustedProxy: true,
          allowedOrigins: configuration.allowedOrigins, production: true, distDirectory: join(configuration.repository, 'dist'),
          vite: false, synthetic: configuration.synthetic, midiProfile });
        return { epoch: server.authority.epoch, close: () => server.close() };
      } catch { throw new PreviewError('The local production authority could not bind its listeners. Check both configured ports and private credential/profile settings.'); }
    },
    async ready(configuration, publicOrigin, authority, signal) {
      await health(`http://127.0.0.1:${configuration.port}`, authority.epoch, signal);
      const deadline = Date.now() + 60000;
      let lastFailure = '';
      while (!signal.aborted) {
        try { await health(publicOrigin, authority.epoch, signal); return; }
        catch (reason) {
          const diagnostic = failure(reason).message;
          if (!signal.aborted && diagnostic !== lastFailure) console.info(`Waiting for public HTTPS readiness: ${diagnostic}`);
          lastFailure = diagnostic;
        }
        if (signal.aborted) break;
        if (Date.now() >= deadline) throw new PreviewError(`The public HTTPS tunnel did not reach this authority within 60 seconds. Last check: ${lastFailure} Check Internet/DNS access and retry.`);
        await new Promise<void>(resolveWait => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolveWait(); };
          const timer = setTimeout(done, 1000); signal.addEventListener('abort', done, { once: true });
        });
      }
      throw new PreviewError('Public HTTPS verification was canceled.');
    },
    async heartbeat(configuration, authority, signal) {
      try { await health(`http://127.0.0.1:${configuration.port}`, authority.epoch, signal); }
      catch { throw new PreviewError('Local authority heartbeat failed; the preview is no longer ready.'); }
    },
    status: writeStatus,
    log: message => console.info(message),
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(value => value === '--help' || value === '-h')) { console.info(previewHelp); return; }
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const writeStatus = statusWriter(repository);
  const abort = new AbortController();
  const interrupt = () => abort.abort({ exitCode: 130 });
  const terminate = () => abort.abort({ exitCode: 143 });
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    process.exitCode = await withPreviewRepositoryLock(repository, async () => {
      try {
        const envPath = join(repository, '.env');
        if (existsSync(envPath)) process.loadEnvFile(envPath);
        const configuration = previewConfiguration(process.env, process.argv.slice(2), repository);
        return await supervisePreview(configuration, productionServices(process.env, writeStatus), abort.signal);
      } catch (reason) {
        const error = failure(reason);
        await writeStatus({ version: 1, state: 'failed', updatedAt: new Date().toISOString(), pid: process.pid, message: error.message }).catch(() => {});
        console.error(error.message); return error.exitCode;
      }
    });
  } catch (reason) {
    const error = failure(reason);
    // Lock rejection must not overwrite the status belonging to another invocation.
    console.error(error.message); process.exitCode = error.exitCode;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

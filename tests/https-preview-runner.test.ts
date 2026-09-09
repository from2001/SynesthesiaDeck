import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquirePreviewLock, cloudflaredArguments, cloudflaredDiagnostic, exactOrigin, healthNetworkFailure, ngrokArguments, ngrokDiagnostic, ngrokOverlay, NgrokOriginParser, previewHelp, PreviewError, previewConfiguration, previewURLs, QuickTunnelOriginParser, withPreviewRepositoryLock,
  supervisePreview, tunnelEnvironment, type AuthorityHandle, type PreviewServices, type PreviewStatus, type TunnelExit } from '../scripts/start-https-preview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const environment = { FRONTEND_ORIGIN: 'https://fixed-show.vercel.app', PORT: '8787', NATIVE_PORT: '8788' };
const origin = 'https://quiet-paper-orbit.trycloudflare.com';
const configuration = () => previewConfiguration(environment, [], '/example/show');

function harness() {
  const abort = new AbortController(), announced = deferred<string>(), closed = deferred<TunnelExit>();
  const statuses: PreviewStatus[] = [];
  const cleanup = vi.fn(async () => {}), closeAuthority = vi.fn(async () => {}), stopTunnel = vi.fn(async () => {});
  const services: PreviewServices = {
    prepare: vi.fn(async () => cleanup),
    tunnel: vi.fn(() => ({ origin: announced.promise, closed: closed.promise, stop: stopTunnel })),
    authority: vi.fn(async () => ({ epoch: 'own-authority', close: closeAuthority })),
    ready: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}),
    status: vi.fn(async status => { statuses.push(structuredClone(status)); }),
    log: vi.fn(),
  };
  return { abort, announced, closed, statuses, cleanup, closeAuthority, stopTunnel, services };
}

async function drain() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
const temporaryRepositories: string[] = [];
async function lockFixture() {
  const repository = await mkdtemp(join(tmpdir(), 'nanokon-preview-lock-test-'));
  temporaryRepositories.push(repository);
  const artifacts = join(repository, 'artifacts'); await mkdir(artifacts);
  return { repository, artifacts, lock: join(artifacts, 'https-preview.lock'), status: join(artifacts, 'https-preview.json') };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(temporaryRepositories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('HTTPS preview repository ownership', () => {
  it.each([['8787', '8788'], ['9887', '9888']])('preserves a running ready record when another invocation selects ports %s / %s', async (PORT, NATIVE_PORT) => {
    const files = await lockFixture(), stop = deferred<void>(), published = deferred<void>();
    const ready = JSON.stringify({ version: 1, state: 'ready', pid: process.pid, urls: { fixedDesk: 'https://fixed-show.vercel.app/?server=https://own.ngrok-free.dev' } });
    const running = withPreviewRepositoryLock(files.repository, async () => {
      await writeFile(files.status, ready); published.resolve(); await stop.promise;
    });
    await published.promise;
    const config = previewConfiguration({ ...environment, PORT, NATIVE_PORT }, [], files.repository);
    const h = harness(), duplicate = vi.fn(() => supervisePreview(config, h.services, h.abort.signal));
    await expect(withPreviewRepositoryLock(files.repository, duplicate)).rejects.toThrow(/existing status was preserved/);
    expect(duplicate).not.toHaveBeenCalled(); expect(h.services.status).not.toHaveBeenCalled();
    expect(await readFile(files.status, 'utf8')).toBe(ready);
    stop.resolve(); await running;
    await expect(stat(files.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a confirmed dead owner and releases the replacement lock after callback failure', async () => {
    const files = await lockFixture();
    const stale = { version: 1, pid: 123456789, owner: randomUUID() };
    await writeFile(files.lock, JSON.stringify(stale));
    await writeFile(files.status, JSON.stringify({ version: 1, state: 'ready', pid: stale.pid }));
    const alive = (pid: number) => pid === process.pid;
    await expect(withPreviewRepositoryLock(files.repository, async () => {
      const current = JSON.parse(await readFile(files.lock, 'utf8'));
      expect(current.pid).toBe(process.pid); expect(current.owner).not.toBe(stale.owner);
      throw new PreviewError('Mock startup failure.');
    }, alive)).rejects.toThrow('Mock startup failure.');
    await expect(stat(files.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${files.lock}.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one concurrent contender to recover a stale lock', async () => {
    const files = await lockFixture();
    await writeFile(files.lock, JSON.stringify({ version: 1, pid: 123456789, owner: randomUUID() }));
    const contenders = await Promise.allSettled([acquirePreviewLock(files.repository, pid => pid === process.pid), acquirePreviewLock(files.repository, pid => pid === process.pid)]);
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1);
    for (const result of contenders) if (result.status === 'fulfilled') await result.value();
    await expect(stat(files.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a replacement owner when its original release callback runs', async () => {
    const files = await lockFixture(), release = await acquirePreviewLock(files.repository);
    const replacement = JSON.stringify({ version: 1, pid: process.pid, owner: randomUUID() });
    await writeFile(files.lock, replacement);
    await release(); await release();
    expect(await readFile(files.lock, 'utf8')).toBe(replacement);
  });

  it('preserves a live ready record from an older runner that did not create a lock', async () => {
    const files = await lockFixture();
    const ready = JSON.stringify({ version: 1, state: 'ready', pid: process.pid });
    await writeFile(files.status, ready);
    const started = vi.fn(async () => {});
    await expect(withPreviewRepositoryLock(files.repository, started)).rejects.toThrow(/owns this repository/);
    expect(started).not.toHaveBeenCalled(); expect(await readFile(files.status, 'utf8')).toBe(ready);
    await expect(stat(files.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses uncertain ownership and an interrupted recovery guard without deleting either', async () => {
    const files = await lockFixture();
    await writeFile(files.lock, 'incomplete-or-unknown-owner');
    await expect(acquirePreviewLock(files.repository, () => false)).rejects.toThrow(/safely verified/);
    expect(await readFile(files.lock, 'utf8')).toBe('incomplete-or-unknown-owner');
    await writeFile(files.lock, JSON.stringify({ version: 1, pid: 123456789, owner: randomUUID() }));
    await mkdir(`${files.lock}.recovery`);
    await expect(acquirePreviewLock(files.repository, () => false)).rejects.toThrow(/safely verified/);
    expect((await stat(`${files.lock}.recovery`)).isDirectory()).toBe(true);
  });
});

describe('HTTPS preview configuration', () => {
  it('accepts exact trusted deployment and custom-domain origins while rejecting URL-bearing credentials or paths', () => {
    for (const value of ['https://fixed-show.vercel.app', 'https://visuals.example.org/', 'https://visuals.example.org:9443']) expect(exactOrigin(value)).toMatch(/^https:\/\//);
    for (const value of ['', 'http://show.vercel.app', 'https://*.vercel.app', 'https://show.vercel.app/path', 'https://show.vercel.app?x=1',
      'https://show.vercel.app?', 'https://show.vercel.app/#', 'https://user:secret@show.vercel.app', 'https://@show.vercel.app', ' https://show.vercel.app']) expect(() => exactOrigin(value)).toThrow(PreviewError);
    const config = previewConfiguration({ ...environment, ALLOWED_ORIGINS: 'https://other.example.org,http://localhost:8787' }, ['--synthetic', '--frontend-origin', 'https://custom.example.org']);
    expect(config.synthetic).toBe(true); expect(config.frontendOrigin).toBe('https://custom.example.org');
    expect(config.allowedOrigins).toEqual(['https://custom.example.org', 'https://other.example.org', 'http://localhost:8787']);
  });

  it('rejects invalid/matching ports and exposes only the main loopback listener to cloudflared', () => {
    for (const PORT of ['0', '-1', '65536', '8787.5', 'abc']) expect(() => previewConfiguration({ ...environment, PORT })).toThrow(PreviewError);
    expect(() => previewConfiguration({ ...environment, NATIVE_PORT: '8787' })).toThrow(/different/);
    const config = previewConfiguration({ ...environment, PORT: '9870', NATIVE_PORT: '9871' });
    const args = cloudflaredArguments(config, '/temporary/isolated.yml');
    expect(args[args.indexOf('--url') + 1]).toBe('http://127.0.0.1:9870');
    expect(args.join(' ')).not.toContain('9871'); expect(args).toContain('/temporary/isolated.yml');
    expect(args).toContain('--no-autoupdate');
  });

  it('selects an explicit ngrok provider while keeping Cloudflare as the default', () => {
    expect(configuration().provider).toBe('cloudflare');
    expect(previewConfiguration({ ...environment, TUNNEL_PROVIDER: 'ngrok' }).provider).toBe('ngrok');
    const config = previewConfiguration({ ...environment, TUNNEL_PROVIDER: 'cloudflare', NGROK_BIN: '/trusted/ngrok', NGROK_CONFIG: '/private/ngrok.yml' }, ['--provider', 'ngrok', '--synthetic']);
    expect(config).toMatchObject({ provider: 'ngrok', synthetic: true, ngrokBin: '/trusted/ngrok', ngrokConfig: '/private/ngrok.yml' });
    for (const argv of [['--provider'], ['--provider', 'unsupported']]) expect(() => previewConfiguration(environment, argv)).toThrow(/cloudflare or ngrok/);
    expect(() => previewConfiguration({ ...environment, TUNNEL_PROVIDER: 'unsupported' })).toThrow(/cloudflare or ngrok/);
    expect(previewHelp).toContain('--provider cloudflare|ngrok');
  });

  it('uses existing ngrok authentication by path and overlays disabled inspection without forwarding native ingest', () => {
    const config = previewConfiguration({ ...environment, PORT: '9870', NATIVE_PORT: '9871', TUNNEL_PROVIDER: 'ngrok' });
    const args = ngrokArguments(config, '/private config/ngrok.yml', '/own temporary/overlay.yml');
    expect(args.slice(0, 2)).toEqual(['http', 'http://127.0.0.1:9870']);
    expect(args.slice(2, 6)).toEqual(['--config', '/private config/ngrok.yml', '--config', '/own temporary/overlay.yml']);
    expect(args).toContain('--inspect=false'); expect(args).not.toContain('--authtoken');
    expect(args).not.toContain('start'); expect(args.join(' ')).not.toContain('9871');
    expect(ngrokOverlay(3)).toContain('version: "3"\nagent:\n  web_addr: false\n');
    expect(ngrokOverlay(2)).toContain('version: "2"\nweb_addr: false\n');
    for (const version of [2, 3] as const) {
      const overlay = ngrokOverlay(version);
      expect(overlay).toContain('inspect_db_size: -1'); expect(overlay).toContain('remote_management: false');
      expect(overlay).not.toMatch(/authtoken|api_key|endpoints|tunnels/);
    }
    expect(tunnelEnvironment({ NGROK_AUTHTOKEN: 'private-test-value', NGROK_API_KEY: 'private-test-value', PATH: '/trusted/bin' })).toEqual({ PATH: '/trusted/bin' });
  });

  it('only accepts complete ngrok JSON announcements for the exact main loopback upstream', () => {
    const parser = new NgrokOriginParser('http://127.0.0.1:8787');
    const record = (url: string, addr = 'http://127.0.0.1:8787', msg = 'started tunnel') => JSON.stringify({ msg, addr, url });
    expect(parser.push('x'.repeat(100000) + '\n')).toBeUndefined();
    expect(parser.push('null\n')).toBeUndefined();
    expect(parser.push(record('https://some.ngrok-free.dev', 'http://127.0.0.1:8788') + '\n')).toBeUndefined();
    expect(parser.push(record('https://some.ngrok-free.dev', undefined, 'see dashboard') + '\n')).toBeUndefined();
    for (const url of ['http://some.ngrok-free.dev', 'https://user:secret@some.ngrok-free.dev', 'https://some.ngrok-free.dev/path', 'https://some.ngrok-free.dev?']) {
      expect(parser.push(record(url) + '\n')).toBeUndefined();
    }
    const valid = record('https://some.ngrok-free.dev');
    expect(parser.push(valid.slice(0, 40))).toBeUndefined();
    expect(parser.push(valid.slice(40))).toBeUndefined();
    expect(parser.push('\n')).toBe('https://some.ngrok-free.dev');
  });

  it('shows bounded ngrok progress and error codes without copying raw credential fields', () => {
    expect(ngrokDiagnostic(JSON.stringify({ msg: 'client session established', authtoken: 'private-test-value' }))).toBe('ngrok: edge session established.');
    expect(ngrokDiagnostic(JSON.stringify({ lvl: 'eror', err: 'private-test-value ERR_NGROK_108 account detail' }))).toBe('ngrok: provider reported ERR_NGROK_108; raw details are suppressed.');
    expect(ngrokDiagnostic(JSON.stringify({ lvl: 'error', err: 'private-test-value' }))).not.toContain('private-test-value');
    expect(ngrokDiagnostic(JSON.stringify({ lvl: 'info', msg: 'private-test-value' }))).toBeUndefined();
    expect(ngrokDiagnostic('null')).toBeUndefined();
  });

  it('never puts private credentials in configuration, URLs or cloudflared environment', () => {
    const privateEnv = { ...environment, CONTROL_TOKEN: 'private-control-test-value', NATIVE_TOKEN: 'private-native-test-value', VERCEL_TOKEN: 'private-provider-test-value',
      HOME: '/unchanged/home', PATH: '/trusted/bin', TUNNEL_TOKEN: 'unrelated-tunnel-value' };
    const config = previewConfiguration(privateEnv);
    const urls = previewURLs(config, origin);
    const child = tunnelEnvironment(privateEnv);
    expect(child).toEqual({ HOME: '/unchanged/home', PATH: '/trusted/bin' });
    const publicData = JSON.stringify({ config, urls, child });
    expect(publicData).not.toContain('private-'); expect(publicData).not.toContain('unrelated-tunnel');
    expect(new URL(urls.fixedDesk).searchParams.get('server')).toBe(origin);
    expect(new URL(urls.fixedAudience).searchParams.get('view')).toBe('hmd');
    expect(new URL(urls.fixedAudience).searchParams.get('server')).toBe(origin);
  });

  it('parses chunked Quick Tunnel output without accepting suffix domains or unbounded logs', () => {
    const parser = new QuickTunnelOriginParser();
    expect(parser.push('https://bad.trycloudflare.com.evil.test \n')).toBeUndefined();
    expect(parser.push('x'.repeat(100000))).toBeUndefined();
    expect(parser.push(' | https://quiet-paper-')).toBeUndefined();
    expect(parser.push('orbit.trycloudflare.com')).toBeUndefined();
    expect(parser.push(' |\n')).toBe(origin);
  });

  it('reports useful network categories without including secret-bearing exception details', () => {
    expect(healthNetworkFailure({ cause: { code: 'ENOTFOUND' }, message: 'private-value' })).toMatch(/DNS.*ENOTFOUND/);
    expect(healthNetworkFailure({ cause: { code: 'ECONNREFUSED' } })).toMatch(/refused/);
    expect(healthNetworkFailure({ name: 'TimeoutError' })).toMatch(/timed out/);
    expect(healthNetworkFailure({ cause: { code: 'CERT_HAS_EXPIRED' } })).toMatch(/TLS/);
    expect(healthNetworkFailure({ cause: { code: 'private-value' }, message: 'private-value' })).not.toContain('private-value');
  });

  it('classifies cloudflared progress and errors without repeating raw sensitive fields', () => {
    expect(cloudflaredDiagnostic('INF Registered tunnel connection connIndex=0 protocol=quic secret=private-value')).toBe('cloudflared: edge connection established using quic.');
    expect(cloudflaredDiagnostic('ERR failed to dial to edge with quic: private-value')).toMatch(/QUIC.*UDP/);
    expect(cloudflaredDiagnostic('ERR Unable to reach the origin service private-value')).toMatch(/loopback origin/);
    expect(cloudflaredDiagnostic('ERR unexpected failure token=private-value')).not.toContain('private-value');
    expect(cloudflaredDiagnostic('INF Settings token=private-value')).toBeUndefined();
  });
});

describe('HTTPS preview resource supervision', () => {
  it('uses the same epoch verification and owned-resource cleanup for ngrok with provider-specific status', async () => {
    const h = harness();
    const config = previewConfiguration(environment, ['--provider', 'ngrok']);
    const ngrokOrigin = 'https://some.ngrok-free.dev';
    const running = supervisePreview(config, h.services, h.abort.signal);
    h.announced.resolve(ngrokOrigin); await drain();
    expect(h.services.authority).toHaveBeenCalledWith(config, ngrokOrigin);
    expect(h.services.ready).toHaveBeenCalledWith(config, ngrokOrigin, expect.objectContaining({ epoch: 'own-authority' }), expect.any(AbortSignal));
    expect(h.statuses.at(-1)).toMatchObject({ state: 'ready', provider: 'ngrok' });
    expect(new URL(h.statuses.at(-1)!.urls!.fixedAudience).searchParams.get('server')).toBe(ngrokOrigin);
    h.closed.resolve({ code: 17, signal: null });
    expect(await running).toBe(17);
    expect(h.statuses.at(-1)?.message).toMatch(/^ngrok exited with code 17/);
    expect(h.statuses.at(-1)?.urls).toBeUndefined(); expect(h.closeAuthority).toHaveBeenCalledOnce();
    expect(h.stopTunnel).toHaveBeenCalledOnce(); expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('reports ready only after public verification and clears URLs when gracefully stopped', async () => {
    const h = harness();
    const verifying = deferred<void>(); h.services.ready = vi.fn(() => verifying.promise);
    const running = supervisePreview(configuration(), h.services, h.abort.signal);
    h.announced.resolve(origin); await drain();
    expect(h.statuses.some(status => status.state === 'ready')).toBe(false);
    expect(h.services.log).toHaveBeenCalledWith(expect.stringContaining(`not verified yet): ${origin}`));
    expect(h.statuses.at(-1)?.message).toContain(origin);
    verifying.resolve(); await drain();
    expect(h.statuses.at(-1)?.state).toBe('ready');
    expect(h.services.authority).toHaveBeenCalledWith(configuration(), origin);
    h.abort.abort(); expect(await running).toBe(0);
    expect(h.statuses.at(-1)?.state).toBe('stopped'); expect(h.statuses.at(-1)?.urls).toBeUndefined();
    expect(h.closeAuthority).toHaveBeenCalledOnce(); expect(h.stopTunnel).toHaveBeenCalledOnce(); expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it('refuses an occupied-port preparation failure before creating a tunnel or authority', async () => {
    const h = harness(); h.services.prepare = vi.fn(async () => { throw new PreviewError('Loopback port 8787 is occupied.'); });
    expect(await supervisePreview(configuration(), h.services, h.abort.signal)).toBe(1);
    expect(h.services.tunnel).not.toHaveBeenCalled(); expect(h.services.authority).not.toHaveBeenCalled();
    expect(h.statuses.at(-1)?.state).toBe('failed'); expect(h.statuses.at(-1)?.urls).toBeUndefined();
  });

  it('preserves a failed tunnel exit code and cleans resources before any URL is announced', async () => {
    const h = harness(); const running = supervisePreview(configuration(), h.services, h.abort.signal);
    await drain(); h.closed.resolve({ code: 23, signal: null });
    expect(await running).toBe(23);
    expect(h.services.authority).not.toHaveBeenCalled(); expect(h.stopTunnel).toHaveBeenCalledOnce(); expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.statuses.at(-1)?.state).toBe('failed');
  });

  it('clears a previously ready record when the tunnel exits unexpectedly', async () => {
    const h = harness(); const running = supervisePreview(configuration(), h.services, h.abort.signal);
    h.announced.resolve(origin); await drain(); expect(h.statuses.at(-1)?.state).toBe('ready');
    h.closed.resolve({ code: 0, signal: null });
    expect(await running).toBe(1);
    expect(h.closeAuthority).toHaveBeenCalledOnce(); expect(h.statuses.at(-1)?.state).toBe('failed'); expect(h.statuses.at(-1)?.urls).toBeUndefined();
  });

  it('closes an authority that finishes starting after SIGINT instead of publishing it as ready', async () => {
    const h = harness(), starting = deferred<AuthorityHandle>();
    h.services.authority = vi.fn(() => starting.promise);
    const running = supervisePreview(configuration(), h.services, h.abort.signal);
    h.announced.resolve(origin); await drain(); expect(h.services.authority).toHaveBeenCalledOnce();
    h.abort.abort({ exitCode: 130 }); starting.resolve({ epoch: 'late-authority', close: h.closeAuthority });
    expect(await running).toBe(130);
    expect(h.services.ready).not.toHaveBeenCalled(); expect(h.closeAuthority).toHaveBeenCalledOnce();
    expect(h.statuses.some(status => status.state === 'ready')).toBe(false);
  });

  it('cleans both owned resources if public HTTPS verification fails', async () => {
    const h = harness(); h.services.ready = vi.fn(async () => { throw new PreviewError('Public health verification timed out.'); });
    const running = supervisePreview(configuration(), h.services, h.abort.signal); h.announced.resolve(origin);
    expect(await running).toBe(1);
    expect(h.closeAuthority).toHaveBeenCalledOnce(); expect(h.stopTunnel).toHaveBeenCalledOnce();
    expect(h.statuses.at(-1)?.message).toMatch(/timed out/);
  });

  it('does not expose unclassified exception text in logs or the public status artifact', async () => {
    const h = harness();
    h.services.authority = vi.fn(async () => { throw new Error('private-control-value-from-an-unexpected-dependency'); });
    const running = supervisePreview(configuration(), h.services, h.abort.signal); h.announced.resolve(origin);
    expect(await running).toBe(1);
    expect(JSON.stringify(h.statuses)).not.toContain('private-control-value');
    expect(JSON.stringify(vi.mocked(h.services.log).mock.calls)).not.toContain('private-control-value');
    expect(h.stopTunnel).toHaveBeenCalledOnce(); expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it('withdraws readiness and closes resources if a running authority stops responding', async () => {
    vi.useFakeTimers();
    const h = harness(); h.services.heartbeat = vi.fn(async () => { throw new PreviewError('Authority heartbeat failed.'); });
    const running = supervisePreview(configuration(), h.services, h.abort.signal); h.announced.resolve(origin); await drain();
    expect(h.statuses.at(-1)?.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(5000); expect(await running).toBe(1);
    expect(h.statuses.at(-1)?.state).toBe('failed'); expect(h.statuses.at(-1)?.urls).toBeUndefined();
    expect(h.closeAuthority).toHaveBeenCalledOnce(); expect(h.stopTunnel).toHaveBeenCalledOnce();
  });
});

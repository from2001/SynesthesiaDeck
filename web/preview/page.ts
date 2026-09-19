import './preview.css';
import { SCENE_CATALOG, sceneNumber } from '../../shared/scenes';
import { ShowConnection } from '../connection';
import { initialShowSelection, prepareShowSelection, publicShowOrigin, type SettingsStore } from '../show-settings';
import { ShowRenderer } from '../visuals/renderer';
import { PreviewDirector, PreviewFrameWatch, SHOTS, type CameraFrame } from './camera';
import { previewPageLink } from './settings';

export function mountAudiencePreview(): void {
  document.body.classList.add('audience-preview');
  document.title = 'Synesthesia Deck | Audience preview';
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = `
    <main class="audience-screen" aria-label="Live audience preview">
      <div id="audience-stage" class="audience-stage"></div>
      <div class="audience-top"><span class="audience-brand">Synesthesia <em>Deck</em> <span>LIVE VISUALS</span></span><span id="audience-status" role="status" aria-live="polite">Waiting for show</span></div>
      <div class="audience-caption"><span id="audience-cue" class="audience-eyebrow">ONE ROOM / ONE SHOW</span><h1 id="audience-scene">A shared frequency.</h1><p id="audience-description">The live show will appear here.</p></div>
      <div class="audience-bottom"><span id="audience-progress-label">WAITING FOR SHOW</span><span id="audience-shot">WIDE</span><button id="audience-fullscreen" type="button">Fullscreen</button></div>
      <progress id="audience-progress" class="audience-progress" max="1" value="0" aria-label="Current camera section progress"></progress>
      <div id="audience-notice" class="audience-notice" role="status" aria-live="polite"></div>
      <details id="audience-settings" class="audience-settings"><summary>Show connection</summary><form id="audience-connect"><label for="audience-server">Mac show URL</label><div><input id="audience-server" type="url" autocomplete="off" spellcheck="false" placeholder="https://your-show-address" required><button type="submit">Connect</button></div><p>Use the show address from your Mac.</p></form></details>
    </main>`;
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const notice = (message: string) => { element('audience-notice').textContent = message; };
  const hosted = import.meta.env.VITE_SHOW_MODE === 'hosted';
  let store: SettingsStore | null = null;
  try { store = window.sessionStorage; } catch { /* Storage is optional on an external display. */ }
  let serverUrl = '';
  try {
    serverUrl = initialShowSelection({ pageOrigin: location.origin, hosted, audience: true, queryServer: new URLSearchParams(location.search).get('server'), configuredServer: import.meta.env.VITE_SHOW_SERVER_URL }, store).serverUrl;
  } catch (error) { notice(messageOf(error)); }
  let connection: ShowConnection;
  let director = new PreviewDirector(), watch = new PreviewFrameWatch();
  let renderer: ShowRenderer | null = null;
  let renderReady = false, disposed = false, renderingError = '';
  let current: ReturnType<ShowConnection['sample']> = null;
  let camera: CameraFrame | null = null;
  let lastUi = -Infinity, lastTelemetry = -Infinity, animation = 0;
  const name = `Preview ${crypto.randomUUID().slice(0, 4)}`;

  function connect(): void {
    connection?.disconnect();
    // The HMD role is enforced read-only by both ShowConnection and the show server.
    connection = new ShowConnection('hmd', '', name, serverUrl || undefined);
    director = new PreviewDirector(); watch = new PreviewFrameWatch(); current = null; camera = null;
    lastTelemetry = -Infinity;
    const selected = connection;
    selected.addEventListener('change', () => {
      if (selected === connection) watch.receive(selected.timeline.state, performance.now());
    });
    selected.addEventListener('notice', event => { if (selected === connection) notice((event as CustomEvent<string>).detail); });
    element<HTMLInputElement>('audience-server').value = serverUrl ? publicShowOrigin(serverUrl) : '';
    element<HTMLDetailsElement>('audience-settings').open = !serverUrl;
    if (serverUrl) selected.connect();
  }
  connect();
  element('audience-connect').addEventListener('submit', event => {
    event.preventDefault();
    try {
      serverUrl = prepareShowSelection(element<HTMLInputElement>('audience-server').value.trim(), location.origin, true, store).serverUrl;
      const link = previewPageLink(location.origin, serverUrl, hosted);
      try { history.replaceState(null, '', link); } catch { /* The active endpoint remains usable without history access. */ }
      notice(''); connect();
    } catch (error) { notice(messageOf(error)); }
  });
  element('audience-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { notice('Fullscreen is unavailable. Maximize this browser window for the audience display.'); }
  });
  const fullscreenChanged = () => { element('audience-fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; };
  document.addEventListener('fullscreenchange', fullscreenChanged);

  function sample(): ReturnType<ShowConnection['sample']> {
    const localNow = performance.now();
    current = connection.sample(localNow);
    watch.sampled(connection.timeline.state);
    camera = director.sample({ state: current?.state ?? null, now: current?.now ?? 0, localNow, connected: connection.connected, locked: connection.clock.locked, lastFrameAt: watch.lastFrameAt });
    return current;
  }
  function frame(): void {
    if (disposed) return;
    const localNow = performance.now();
    if (!renderReady || renderingError) sample();
    if (localNow - lastUi >= 100) {
      lastUi = localNow;
      const healthy = camera?.health === 'live';
      element('audience-status').textContent = renderingError ? 'Display unavailable' : !serverUrl ? 'Choose a show' : healthy ? current?.state.running ? 'Live' : 'Show paused' : camera?.health === 'acquiring' ? 'Synchronizing' : camera?.health === 'waiting' ? 'Waiting for show' : 'Reconnecting / wide view';
      element('audience-status').classList.toggle('is-live', healthy && Boolean(current?.state.running));
      const scene = current ? SCENE_CATALOG[current.state.scene] : null;
      element('audience-scene').textContent = scene?.name ?? 'A shared frequency.';
      element('audience-description').textContent = renderingError || (current && !current.state.running ? 'The show will resume here.' : scene?.synopsis ?? 'The live show will appear here.');
      element('audience-cue').textContent = current ? `SCENE ${sceneNumber(current.state.scene)} / ${camera?.reason === 'drop' ? 'DROP' : camera?.reason === 'burst' ? 'BURST' : 'LIVE VISUALS'}` : 'ONE ROOM / ONE SHOW';
      const seconds = current ? Math.floor(Math.max(0, current.now - current.state.sceneStartTime) / 1000) : 0;
      const elapsed = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
      element('audience-progress-label').textContent = current ? `${elapsed} / SECTION ${(camera?.section ?? 0) + 1}` : 'WAITING FOR SHOW';
      element('audience-shot').textContent = `${camera?.shot.toUpperCase() ?? 'WIDE'} / AUTO`;
      element<HTMLProgressElement>('audience-progress').value = camera?.sectionProgress ?? 0;
      if (current && localNow - lastTelemetry >= 1000) {
        lastTelemetry = localNow;
        const stats = renderer?.stats ?? { fps: 0, xr: false, calibrated: false, quality: 'medium' as const };
        connection.telemetry({ ...stats, scene: current.state.scene, offset: connection.clock.offset, rtt: connection.clock.rtt, locked: connection.clock.locked });
      }
    }
    animation = requestAnimationFrame(frame);
  }
  animation = requestAnimationFrame(frame);
  renderer = new ShowRenderer(element('audience-stage'));
  renderer.sampleProvider = sample;
  renderer.desktopCameraProvider = () => camera ?? SHOTS.wide;
  renderer.onStatus = message => {
    if (/^(Rendering stopped:|WebGL context lost)/.test(message)) { renderingError = message; notice(message); }
  };
  void renderer.initialize().then(() => {
    if (disposed) return;
    renderReady = true;
    element('audience-stage').querySelector('canvas')?.setAttribute('aria-label', 'Synchronized live visuals with an automatic camera.');
  }).catch(error => { renderingError = `Rendering unavailable: ${messageOf(error)}`; notice(renderingError); });

  const pagehide = () => {
    disposed = true; cancelAnimationFrame(animation); connection.disconnect(); renderer?.dispose();
    document.removeEventListener('fullscreenchange', fullscreenChanged);
  };
  window.addEventListener('pagehide', pagehide, { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  // Serializable, read-only diagnostics contain no endpoint credentials or command functions.
  Object.defineProperty(window, '__nanokon', { get: () => structuredClone({ mode: 'preview', connected: connection.connected, role: connection.role, name: connection.name, state: current?.state ?? null, clockLocked: connection.clock.locked, source: connection.source, renderReady, stats: renderer?.stats, renderingError, preview: camera }) });
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

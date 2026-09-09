import './style.css';
import { CONTROL_KEYS, EFFECT_NAMES, SCENES, SCENE_COUNT, initialState, SILENCE, type Command } from '../shared/protocol';
import { MIDI_SCENE_SHORTCUT_COUNT, SCENE_CATALOG, SCENE_GROUPS, sceneNumber } from '../shared/scenes';
import { ShowConnection } from './connection';
import { ShowRenderer } from './visuals/renderer';
import { PRESET_PARAMETERS } from './visuals/parameters';
import { initialShowSelection, persistControlToken, prepareShowSelection, publicShowOrigin, readSetting, showPageLink, type SettingsStore } from './show-settings';

const pageParameters = new URLSearchParams(location.search);
const hmdMode = pageParameters.get('view') === 'hmd' || (!pageParameters.has('view') && location.pathname === '/hmd');
const hosted = import.meta.env.VITE_SHOW_MODE === 'hosted';
if (hmdMode) document.body.classList.add('hmd-mode');
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header><a class="brand" href="/" aria-label="NanoKon VJ desk"><span class="brand-mark"></span>Nano<em>Kon</em></a><span class="tag">MR VJ INSTRUMENT / 01</span><div class="header-right"><span class="status" id="connection-status">Connecting</span><a href="?view=${hmdMode ? 'desk' : 'hmd'}" class="tag">${hmdMode ? 'VJ desk ↗' : 'Open audience view ↗'}</a></div></header>
  <main class="workspace">
    <div class="intro"><div><h1>Your room. A shared frequency.</h1><p>Shape the sound. Move the space.</p></div><div class="transport"><button class="play command" id="play">▶ Play</button><button class="command" id="stop">■ Clear</button><button class="command danger" id="reset">Reset</button></div></div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
    <details id="server-setup" class="server-setup"><summary>Show connection <span id="server-label">Choose your Mac</span></summary><form id="server-form"><label for="server-url">Mac show URL</label><div class="server-fields"><input id="server-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://your-show-address" aria-describedby="server-help"><button type="submit">Connect show</button></div><p id="server-help">Paste the HTTPS show address printed on your Mac. Keep the Mac and its tunnel running.</p></form></details>
    <div class="layout"><div class="main-column">
      <section class="panel">
        <form id="login" class="login"><input id="token" type="password" autocomplete="off" placeholder="Control token" aria-label="Control token"><button type="submit">Connect desk</button><p id="access-status">Audience preview · enter your control token to perform.</p></form>
        <div class="viewer" id="viewer"><div class="preview-top"><span>LIVE PREVIEW</span><span id="preview-clock">WAITING FOR SHOW</span></div><div class="preview-bottom"><div><div class="scene-caption" id="scene-caption">CODE CATHEDRAL</div><small id="scene-description">A quiet architecture of light and language.</small></div><small id="fps">— FPS</small></div></div>
        <div class="scene-preview-nav" aria-label="Preview scene navigation"><button class="command" id="scene-previous" aria-label="Previous scene">← Previous</button><select class="command" id="preview-scene" aria-label="Preview scene">${SCENE_GROUPS.map(group => `<optgroup label="${group.name}">${SCENE_CATALOG.map((scene, i) => ({ ...scene, i })).filter(scene => scene.group === group.id).map(scene => `<option value="${scene.i}">${sceneNumber(scene.i)} / ${scene.name}</option>`).join('')}</optgroup>`).join('')}</select><button class="command" id="scene-next" aria-label="Next scene">Next →</button></div>
        <div class="preview-actions"><button id="enter-mr">Enter MR ↗</button><button id="calibrate">Align room</button><button id="reset-calibration">Reset alignment</button><span class="quality"><label for="quality">Quality </label><select id="quality"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></span><span id="xr-status" class="tag">DESKTOP PREVIEW</span></div>
      </section>
      <section class="panel scenes"><div class="panel-head"><h2>Scene bank</h2><span class="tag" id="scene-status">${SCENE_COUNT} PRESETS</span></div><div class="scene-bank">${SCENE_GROUPS.map(group => `<section class="scene-group scene-group-${group.id}" aria-labelledby="group-${group.id}"><div class="scene-group-head"><h3 id="group-${group.id}">${group.name}</h3><span>${group.subtitle}</span></div><div class="scene-list">${SCENE_CATALOG.map((scene, i) => ({ ...scene, i })).filter(scene => scene.group === group.id).map(scene => `<button class="scene-button command" data-scene="${scene.i}" aria-pressed="false" title="${scene.synopsis}"><span class="scene-card-top"><span class="number">${sceneNumber(scene.i)}</span><span class="scene-shortcut">${scene.i < MIDI_SCENE_SHORTCUT_COUNT ? `S${scene.i + 1}` : 'REW / FF'}</span></span><strong>${scene.name}</strong><span class="scene-synopsis">${scene.synopsis}</span></button>`).join('')}</div></section>`).join('')}</div><p class="scene-midi-note">nanoKONTROL2 · S1–S8 select presets 01–08 · REW / FF browse all ${SCENE_COUNT}</p></section>
      <section class="panel controls"><div class="panel-head"><h2>Shape the space</h2><span class="tag">FADERS 01 — 08</span></div><div class="control-grid">${CONTROL_KEYS.map((key, i) => `<div class="fader"><label for="control-${key}">${key === 'masterFX' ? 'Master FX' : key[0].toUpperCase() + key.slice(1)}</label><input class="command" id="control-${key}" data-control="${key}" type="range" min="0" max="1" step="0.01" value="0.5" aria-label="${key}"><output id="value-${key}">50</output></div>`).join('')}</div></section>
      <section class="panel controls"><div class="panel-head"><h2>Scene expression</h2><span class="tag">KNOBS + EFFECTS</span></div><div class="knobs">${Array.from({ length: 8 }, (_, i) => `<div class="knob"><label for="knob-${i}"><span id="knob-name-${i}">Parameter ${i + 1}</span><output id="knob-value-${i}">50</output></label><input class="command" id="knob-${i}" data-knob="${i}" type="range" min="0" max="1" step="0.01" value="0.5"></div>`).join('')}</div><div class="effect-grid">${EFFECT_NAMES.map((name, i) => `<div class="effect-cell"><button class="command" data-burst="${i}" title="M${i + 1} one-shot">${name} ↗</button><button class="command" data-toggle="${i}" aria-pressed="false" title="R${i + 1} toggle">R${i + 1} · Off</button></div>`).join('')}</div></section>
    </div><aside class="sidebar">
      <section class="panel"><div class="panel-head"><h2>Audio input</h2><span class="tag" id="audio-mode">SILENT</span></div><div class="audio-body">${['level', 'bass', 'lowMid', 'mid', 'high'].map(key => `<div class="meter"><span>${key === 'lowMid' ? 'Low mid' : key[0].toUpperCase() + key.slice(1)}</span><div class="meter-track"><div class="meter-fill" id="meter-${key}"></div></div><output id="audio-${key}">0</output></div>`).join('')}<div class="tempo"><strong id="bpm">—</strong><span>BPM</span><div class="beat-lamp" id="beat-lamp"></div></div><div class="source-info" id="source-info">Waiting for system audio</div></div></section>
      <section class="panel"><div class="panel-head"><h2>Connected audience</h2><span class="tag" id="client-count">— ONLINE</span></div><div id="clients" class="clients"><div class="empty">Connect the desk to view all clients.</div></div></section>
      <section class="panel drop-panel"><button class="drop command" id="drop">↯ DROP</button><p>REC · contract / flash / explode</p><label class="source-info" for="drop-target">After the drop</label><select id="drop-target" aria-label="Scene after DROP" style="width:100%;padding:7px;margin-top:7px"><option value="next">Next scene</option><option value="stay">Stay in this scene</option>${SCENES.map((name, i) => `<option value="${i}">${name}</option>`).join('')}</select></section>
      <section class="panel join"><h2>Bring the room in</h2><p>Open this address on each headset.</p><input id="join-url" aria-label="Audience join URL" readonly><button id="copy-join">Copy audience link</button></section>
    </aside></div>
    <footer class="footer"><span>LOCAL RENDERING · SHARED TIME · ONE SHOW</span><span id="clock-info">CLOCK ACQUIRING</span></footer>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function notice(message: string) { $('notice').textContent = message; }
let connection: ShowConnection;
let renderer: ShowRenderer | null = null;
let renderReady = false;
let serverUrl = '';
let savedToken = '';
let lastUi = 0, lastTelemetry = 0, clientSignature = '';
const editedAt = new Map<string, number>();
const delayed = new Map<string, number>();
const knobLabels = PRESET_PARAMETERS;
let settingsStore: SettingsStore | null = null;
try { settingsStore = window.sessionStorage; } catch { /* Browser storage is optional for a live connection. */ }
const audienceName = readSetting(settingsStore, 'nanokon-name') ?? crypto.randomUUID().slice(0, 4);

function publicServerOrigin(): string { return publicShowOrigin(serverUrl); }
function pageLink(audience: boolean): URL { return showPageLink(location.origin, serverUrl, audience, hosted); }
function updateConnectionLinks() {
  $<HTMLInputElement>('join-url').value = serverUrl ? pageLink(true).href : '';
  $<HTMLButtonElement>('copy-join').disabled = !serverUrl;
  $('copy-join').textContent = 'Copy audience link';
  document.querySelector<HTMLAnchorElement>('.brand')!.href = pageLink(false).href;
  document.querySelector<HTMLAnchorElement>('.header-right a')!.href = pageLink(!hmdMode).href;
  $('server-label').textContent = serverUrl ? new URL(serverUrl).host : 'Choose your Mac';
  $<HTMLInputElement>('server-url').value = serverUrl ? publicServerOrigin() : '';
}
function startConnection(token: string) {
  const previous = connection;
  const selected = new ShowConnection(!hmdMode && token ? 'dashboard' : 'hmd', hmdMode ? '' : token, hmdMode ? `Audience ${audienceName}` : 'VJ desk', serverUrl || undefined);
  connection = selected;
  previous?.disconnect(); clientSignature = '';
  for (const timer of delayed.values()) clearTimeout(timer);
  delayed.clear(); editedAt.clear(); lastTelemetry = 0;
  renderer?.update(initialState('awaiting-show'), SILENCE, 0);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('.command').forEach(element => { element.disabled = true; });
  $('preview-clock').textContent = 'WAITING FOR SHOW'; $('clock-info').textContent = 'CLOCK ACQUIRING';
  $('scene-caption').textContent = 'WAITING FOR SHOW'; $('scene-description').textContent = 'The selected show will appear after connecting.';
  $('bpm').textContent = '—'; $('beat-lamp').style.opacity = '.1';
  for (const key of ['level', 'bass', 'lowMid', 'mid', 'high']) {
    $('meter-' + key).style.width = '0%'; $('audio-' + key).textContent = '0';
  }
  selected.addEventListener('notice', event => { if (connection === selected) notice((event as CustomEvent<string>).detail); });
  if (serverUrl) selected.connect();
  else selected.status = 'Choose a show server';
  $('access-status').textContent = token ? 'Authenticating the VJ desk…' : 'Audience preview · enter your control token to perform.';
}
try {
  const selected = initialShowSelection({ pageOrigin: location.origin, hosted, audience: hmdMode, queryServer: pageParameters.get('server'), configuredServer: import.meta.env.VITE_SHOW_SERVER_URL }, settingsStore);
  serverUrl = selected.serverUrl; savedToken = selected.token;
} catch (error) { notice(`Show address rejected: ${error instanceof Error ? error.message : String(error)}`); }
$<HTMLInputElement>('token').value = hmdMode ? '' : savedToken;
$<HTMLDetailsElement>('server-setup').open = !serverUrl;
startConnection(savedToken);
$('server-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const requested = $<HTMLInputElement>('server-url').value.trim();
    if (!requested && hosted) throw new Error('Enter the HTTPS show address printed on your Mac.');
    const selected = prepareShowSelection(requested, location.origin, hmdMode, settingsStore);
    const link = showPageLink(location.origin, selected.serverUrl, hmdMode, hosted);
    // Publish the complete endpoint/credential pair only after validation and storage handling finish.
    serverUrl = selected.serverUrl; savedToken = selected.token;
    $<HTMLInputElement>('token').value = hmdMode ? '' : savedToken;
    try { history.replaceState(null, '', link); } catch { /* Navigation links still carry the selected endpoint when history updates are restricted. */ }
    updateConnectionLinks(); startConnection(savedToken);
    $<HTMLDetailsElement>('server-setup').open = false;
    notice(selected.persisted ? 'Connecting to the selected show. Use Play on the authenticated desk to start the visuals.' : 'Connecting to the selected show without saved credentials. Enter its control token to use the desk.');
  } catch (error) { notice(error instanceof Error ? error.message : String(error)); }
});
$<HTMLFormElement>('login').addEventListener('submit', event => {
  event.preventDefault();
  if (!serverUrl) { $<HTMLDetailsElement>('server-setup').open = true; notice('Connect to your Mac show before entering a control token.'); return; }
  savedToken = $<HTMLInputElement>('token').value.trim();
  persistControlToken(serverUrl, savedToken, settingsStore); startConnection(savedToken);
});
async function send(command: Command) {
  const selected = connection;
  try { await selected.command(command); }
  catch (error) { if (connection === selected) notice(error instanceof Error ? error.message : String(error)); }
}
function schedule(key: string, command: Command) {
  editedAt.set(key, performance.now());
  clearTimeout(delayed.get(key));
  delayed.set(key, window.setTimeout(() => { delayed.delete(key); void send(command); }, 35));
}
$('play').addEventListener('click', () => void send({ type: 'start' }));
$('stop').addEventListener('click', () => void send({ type: 'clear' }));
$('reset').addEventListener('click', () => void send({ type: 'reset' }));
function projectedScene(): number {
  const queuedScene = connection.timeline.pendingEvents.filter(event => event.command.type === 'scene').at(-1)?.command;
  return queuedScene?.type === 'scene' ? queuedScene.scene : (connection.timeline.state?.scene ?? 0);
}
$('scene-previous').addEventListener('click', () => void send({ type: 'scene', scene: (projectedScene() + SCENE_COUNT - 1) % SCENE_COUNT }));
$('scene-next').addEventListener('click', () => void send({ type: 'scene', scene: (projectedScene() + 1) % SCENE_COUNT }));
$<HTMLSelectElement>('preview-scene').addEventListener('change', event => void send({ type: 'scene', scene: Number((event.currentTarget as HTMLSelectElement).value) }));
$('drop').addEventListener('click', () => {
  const selection = $<HTMLSelectElement>('drop-target').value;
  const scene = projectedScene();
  void send({ type: 'drop', duration: 1800, strength: .7, ...(selection === 'stay' ? {} : { targetScene: selection === 'next' ? (scene + 1) % SCENE_COUNT : Number(selection) }) });
});
document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach(button => button.addEventListener('click', () => void send({ type: 'scene', scene: Number(button.dataset.scene) })));
document.querySelectorAll<HTMLInputElement>('[data-control]').forEach(input => input.addEventListener('input', () => {
  const key = input.dataset.control as typeof CONTROL_KEYS[number];
  $('value-' + key).textContent = String(Math.round(Number(input.value) * 100));
  schedule(key, { type: 'control', key, value: Number(input.value) });
}));
document.querySelectorAll<HTMLInputElement>('[data-knob]').forEach(input => input.addEventListener('input', () => {
  const slot = Number(input.dataset.knob); $('knob-value-' + slot).textContent = String(Math.round(Number(input.value) * 100));
  schedule('knob' + slot, { type: 'knob', slot, value: Number(input.value) });
}));
document.querySelectorAll<HTMLButtonElement>('[data-burst]').forEach(button => button.addEventListener('click', () => void send({ type: 'burst', slot: Number(button.dataset.burst) })));
document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(button => button.addEventListener('click', () => {
  const slot = Number(button.dataset.toggle);
  const projected = connection.timeline.pendingEvents.filter(event => event.command.type === 'toggle' && event.command.slot === slot).at(-1)?.command;
  const value = projected?.type === 'toggle' ? projected.value : (connection.timeline.state?.toggles[slot] ?? false);
  void send({ type: 'toggle', slot, value: !value });
}));
updateConnectionLinks();
$('copy-join').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($<HTMLInputElement>('join-url').value); $('copy-join').textContent = 'Link copied'; }
  catch { $<HTMLInputElement>('join-url').select(); notice('Copy the selected audience address.'); }
});
$('enter-mr').addEventListener('click', async () => {
  if (!renderer || !renderReady) { notice('The renderer is still starting.'); return; }
  try { if (renderer.stats.xr) await renderer.exitMR(); else await renderer.enterMR(); }
  catch (error) { notice(error instanceof Error ? error.message : String(error)); }
});
$('calibrate').addEventListener('click', () => renderer?.beginCalibration());
$('reset-calibration').addEventListener('click', () => renderer?.resetCalibration());
$<HTMLSelectElement>('quality').addEventListener('change', () => renderer?.setQuality($<HTMLSelectElement>('quality').value as 'low' | 'medium' | 'high'));

function updateClients() {
  const signature = JSON.stringify(connection.clients.map(c => [c.id, c.name, c.role, c.telemetry && { ...c.telemetry, offset: Math.round(c.telemetry.offset), rtt: Math.round(c.telemetry.rtt), fps: Math.round(c.telemetry.fps) }]));
  if (signature === clientSignature) return;
  clientSignature = signature;
  const clients = connection.clients.filter(c => c.role === 'hmd');
  $('client-count').textContent = `${clients.length} ONLINE`;
  $('clients').replaceChildren();
  if (!clients.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = connection.role === 'dashboard' ? 'Waiting for the audience.' : 'Connect the desk to view all clients.'; $('clients').append(empty);
  }
  for (const client of clients) {
    const row = document.createElement('div'); row.className = 'client-row';
    const name = document.createElement('span'); name.textContent = client.name;
    const detail = document.createElement('small'); detail.textContent = client.telemetry ? `${client.telemetry.xr ? 'MR' : 'Desktop'} · ${client.telemetry.locked ? 'Synced' : 'Acquiring'} · ${client.telemetry.calibrated ? 'Aligned' : 'Local space'}` : 'Awaiting telemetry';
    name.append(detail);
    const latency = document.createElement('b'); latency.textContent = client.telemetry ? `${Math.round(client.telemetry.rtt)} ms` : '—';
    row.append(name, latency); $('clients').append(row);
  }
}

function reportTelemetry(sample: ReturnType<ShowConnection['sample']>, localNow: number) {
  if (!sample || localNow - lastTelemetry <= 1000) return;
  lastTelemetry = localNow;
  const stats = renderer?.stats ?? { fps: 0, xr: false, calibrated: false, quality: 'medium' as const };
  connection.telemetry({ ...stats, scene: sample.state.scene, offset: connection.clock.offset, rtt: connection.clock.rtt, locked: connection.clock.locked });
}

function frame() {
  const localNow = performance.now();
  const sample = connection.sample(localNow);
  if (sample && renderReady) renderer?.update(sample.state, sample.audio, sample.now);
  if (localNow - lastUi > 100) {
    lastUi = localNow;
    $('connection-status').textContent = connection.connected ? (connection.clock.locked ? 'Show connected' : 'Synchronizing') : connection.status;
    $('connection-status').classList.toggle('live', connection.connected);
    const canControl = connection.connected && connection.role === 'dashboard';
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('.command').forEach(element => { element.disabled = !canControl; });
    if (canControl) $('access-status').textContent = 'VJ desk connected · MIDI and screen controls share one show.';
    $('audio-mode').textContent = connection.source.capture === 'synthetic' ? 'SYNTHETIC' : connection.source.capture === 'running' ? 'SYSTEM' : connection.source.capture.toUpperCase();
    $('source-info').textContent = `${connection.source.detail} · MIDI ${connection.source.midi}`;
    if (sample) {
      const { state, audio, now } = sample;
      for (const key of ['level', 'bass', 'lowMid', 'mid', 'high'] as const) {
        $('meter-' + key).style.width = `${audio[key] * 100}%`; $('audio-' + key).textContent = String(Math.round(audio[key] * 100));
      }
      $('bpm').textContent = audio.bpmConfidence > .2 ? String(Math.round(audio.bpm)) : '—';
      $('beat-lamp').style.opacity = String(.1 + audio.beat * .9);
      const sceneSelect = $<HTMLSelectElement>('preview-scene');
      if (document.activeElement !== sceneSelect) sceneSelect.value = String(state.scene);
      $('scene-caption').textContent = SCENES[state.scene]; $('scene-description').textContent = state.running ? SCENE_CATALOG[state.scene].synopsis : 'Show cleared. Press Play to bring the space to life.';
      const pending = connection.timeline.pendingEvents.filter(event => event.command.type === 'scene').at(-1);
      $('scene-status').textContent = pending?.command.type === 'scene' ? `QUEUED → ${sceneNumber(pending.command.scene)}` : `${SCENE_COUNT} PRESETS`;
      document.querySelectorAll<HTMLElement>('[data-scene]').forEach(button => {
        button.classList.toggle('active', Number(button.dataset.scene) === state.scene);
        button.setAttribute('aria-pressed', String(Number(button.dataset.scene) === state.scene));
        button.classList.toggle('pending', pending?.command.type === 'scene' && Number(button.dataset.scene) === pending.command.scene);
      });
      for (const key of CONTROL_KEYS) {
        const input = $<HTMLInputElement>('control-' + key);
        if (document.activeElement !== input && localNow - (editedAt.get(key) ?? -1000) > 500) { input.value = String(state.controls[key]); $('value-' + key).textContent = String(Math.round(state.controls[key] * 100)); }
      }
      for (let i = 0; i < 8; i++) {
        const input = $<HTMLInputElement>('knob-' + i);
        $('knob-name-' + i).textContent = knobLabels[state.scene][i];
        if (document.activeElement !== input && localNow - (editedAt.get('knob' + i) ?? -1000) > 500) { input.value = String(state.sceneParams[i]); $('knob-value-' + i).textContent = String(Math.round(state.sceneParams[i] * 100)); }
        const toggle = document.querySelector<HTMLButtonElement>(`[data-toggle="${i}"]`)!;
        toggle.textContent = `R${i + 1} · ${state.toggles[i] ? 'On' : 'Off'}`; toggle.classList.toggle('enabled', state.toggles[i]); toggle.setAttribute('aria-pressed', String(state.toggles[i]));
      }
      $('preview-clock').textContent = `${state.running ? '● LIVE' : '■ STOPPED'} / ${(now * .001).toFixed(1)}s`;
      $('clock-info').textContent = `${connection.clock.locked ? 'CLOCK LOCKED' : 'CLOCK ACQUIRING'} / ${connection.clock.rtt.toFixed(0)} MS RTT`;
    }
    const stats = renderer?.stats;
    if (stats) { $('fps').textContent = `${stats.fps.toFixed(0)} FPS`; $('xr-status').textContent = stats.xr ? (stats.calibrated ? 'MR / ALIGNED' : 'MR / LOCAL SPACE') : 'DESKTOP PREVIEW'; $('enter-mr').textContent = stats.xr ? 'Exit MR' : 'Enter MR ↗'; }
    updateClients();
  }
  reportTelemetry(sample, localNow);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function initializeRenderer() {
  try {
    renderer = new ShowRenderer($('viewer'));
    renderer.onStatus = notice;
    renderer.sampleProvider = () => {
      const localNow = performance.now();
      const sample = connection.sample(localNow);
      reportTelemetry(sample, localNow);
      return sample;
    };
    await renderer.initialize(); renderReady = true;
  } catch (error) { notice(`Rendering unavailable: ${error instanceof Error ? error.message : String(error)}. The control desk remains available.`); }
}
void initializeRenderer();
window.addEventListener('pagehide', () => { connection.disconnect(); renderer?.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
// Read-only diagnostics for reproducible browser verification; no credentials are exposed.
Object.defineProperty(window, '__nanokon', { get: () => ({ connected: connection.connected, role: connection.role, state: connection.timeline.state, clockLocked: connection.clock.locked, source: connection.source, clients: connection.clients, renderReady, stats: renderer?.stats }) });

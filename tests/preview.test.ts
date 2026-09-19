import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, SCENE_COUNT, type ActiveEffect, type ShowState } from '../shared/protocol';
import { startServer } from '../server/app';
import { EVENT_COOLDOWN_MS, LOSS_TIMEOUT_MS, PreviewDirector, PreviewFrameWatch, SECTION_MS, SHOTS, sectionCamera, type CameraInput } from '../web/preview/camera';
import { isPreviewPage, previewPageLink } from '../web/preview/settings';

function state(): ShowState { return { ...initialState('preview-test'), running: true, seed: 0, sceneStartTime: 0, scene: SCENE_COUNT - 1 }; }
function input(show: ShowState, now: number, extra: Partial<CameraInput> = {}): CameraInput {
  return { state: show, now, localNow: now, connected: true, locked: true, lastFrameAt: now, ...extra };
}
function effect(id: string, effectiveAt: number, kind: 'drop' | 'burst' = 'drop', duration = 1800): ActiveEffect {
  return { id, effectiveAt, kind, duration, strength: .7, slot: 0, seed: 123 };
}
function warm(director: PreviewDirector, show: ShowState): void {
  director.sample(input(show, 0)); director.sample(input(show, 2000));
}

describe('audience camera choreography', () => {
  it('defines four complete shots and supports the full scene catalog', () => {
    expect(Object.keys(SHOTS).sort()).toEqual(['close', 'long', 'mid', 'wide']);
    for (const shot of Object.values(SHOTS)) {
      expect(shot.position.every(Number.isFinite)).toBe(true);
      expect(shot.target).toHaveLength(3);
      expect(shot.fov).toBeGreaterThan(20);
      expect(shot.transitionMs).toBeGreaterThan(0);
    }
    for (let scene = 0; scene < SCENE_COUNT; scene++) {
      const show = { ...state(), scene, seed: 2345 };
      expect(sectionCamera(show, 0).shot).toBe('wide');
      const shots = new Set(Array.from({ length: 4 }, (_, i) => sectionCamera(show, (i + 1) * SECTION_MS + 3000).shot));
      expect(shots.size).toBe(4);
    }
  });
  it('uses identical shared-time poses across frame rates and late section joins', () => {
    const show = state(), fast = new PreviewDirector(), slow = new PreviewDirector();
    warm(fast, show); warm(slow, show);
    for (let time = 2100; time < 37000; time += 17) fast.sample(input(show, time));
    for (let time = 2100; time < 37000; time += 117) slow.sample(input(show, time));
    const a = fast.sample(input(show, 37000)), b = slow.sample(input(show, 37000));
    expect(a).toEqual(b);
    const joining = new PreviewDirector();
    joining.sample(input(show, 34000));
    expect(joining.sample(input(show, 37000))).toEqual(a);
  });
  it('moves within a shot and interpolates continuously at a section boundary', () => {
    const show = state();
    expect(sectionCamera(show, 5000).position).not.toEqual(sectionCamera(show, 6000).position);
    const before = sectionCamera(show, SECTION_MS - .001), after = sectionCamera(show, SECTION_MS + .001);
    for (let i = 0; i < 3; i++) expect(after.position[i]).toBeCloseTo(before.position[i], 4);
    expect(after.fov).toBeCloseTo(before.fov, 4);
  });
  it('cuts to close on DROP at its effective time, independent of sample rate', () => {
    const show = state(), a = new PreviewDirector(), b = new PreviewDirector();
    warm(a, show); warm(b, show);
    show.effects = [effect('drop', 5000)];
    expect(a.sample(input(show, 4999)).reason).toBe('section');
    expect(a.sample(input(show, 5000)).reason).toBe('drop');
    for (let time = 5033; time < 6100; time += 33) a.sample(input(show, time));
    const first = a.sample(input(show, 6100)), late = b.sample(input(show, 6100));
    expect(first).toEqual(late);
    expect(first.shot).toBe('close'); expect(first.fov).toBe(SHOTS.close.fov);
  });
  it('uses mid for BURST and resolves simultaneous events consistently', () => {
    const show = state(), a = new PreviewDirector(), b = new PreviewDirector();
    warm(a, show); warm(b, show);
    const events = [effect('a', 5000, 'burst'), effect('b', 5000)];
    const one = a.sample(input({ ...show, effects: events }, 6000));
    const two = b.sample(input({ ...show, effects: [...events].reverse() }, 6000));
    expect(one).toEqual(two); expect(one.shot).toBe('mid'); expect(one.cutId).toBe('a');
  });
  it('holds a cut after effect expiry and rejects repeated event cuts during cooldown', () => {
    const show = state(), director = new PreviewDirector(); warm(director, show);
    director.sample(input({ ...show, effects: [effect('first', 5000)] }, 5000));
    const held = director.sample(input({ ...show, effects: [effect('repeat', 7000, 'burst')] }, 7100));
    expect(held.cutId).toBe('first'); expect(held.shot).toBe('close');
    const returning = director.sample(input(show, 5000 + EVENT_COOLDOWN_MS + 800));
    expect(returning.fov).toBeGreaterThan(SHOTS.close.fov);
    expect(director.sample(input(show, 11000)).cutId).toBeNull();
    const next = director.sample(input({ ...show, effects: [effect('next', 15000, 'burst')] }, 15000));
    expect(next.cutId).toBe('next');
  });
  it('does not replay expired cues or leak a DROP into another scene or epoch', () => {
    const show = state(), director = new PreviewDirector(); warm(director, show);
    expect(director.sample(input({ ...show, effects: [effect('expired', 3000)] }, 5000)).cutId).toBeNull();
    director.sample(input({ ...show, effects: [effect('drop', 5000)] }, 5000));
    const changed = { ...show, scene: 0, sceneStartTime: 6000, effects: [effect('drop', 5000)] };
    expect(director.sample(input(changed, 6100)).cutId).toBeNull();
    expect(director.sample(input({ ...state(), epoch: 'new-show' }, 0, { localNow: 7000, lastFrameAt: 7000 })).cutId).toBeNull();
  });
  it('clears event cameras when the show is stopped', () => {
    const show = state(), director = new PreviewDirector(); warm(director, show);
    director.sample(input({ ...show, effects: [effect('drop', 5000)] }, 6000));
    const stopped = director.sample(input({ ...show, running: false }, 6100));
    expect(stopped.shot).toBe('wide'); expect(stopped.reason).toBe('stopped'); expect(stopped.cutId).toBeNull();
  });
});

describe('audience loss fallback', () => {
  it('detects stale show frames even when pongs keep the socket alive', () => {
    const show = state(), watch = new PreviewFrameWatch();
    watch.receive(show, 100);
    watch.receive(show, 1500);
    expect(watch.lastFrameAt).toBe(100);
    const locallyApplied = { ...show, revision: 1 };
    watch.sampled(locallyApplied); watch.receive(locallyApplied, 2000);
    expect(watch.lastFrameAt).toBe(100);
    const result = new PreviewDirector().sample(input(show, 2100, { lastFrameAt: watch.lastFrameAt }));
    expect(result.health).toBe('stale'); expect(result.shot).toBe('wide');
    watch.receive({ ...locallyApplied }, 2200);
    expect(watch.lastFrameAt).toBe(2200);
  });
  it('returns smoothly to static wide using local time when shared time is frozen', () => {
    const show = state(), director = new PreviewDirector(); warm(director, show);
    director.sample(input({ ...show, effects: [effect('drop', 5000)] }, 6200));
    const before = director.sample(input(show, 6300));
    const lost = director.sample(input(show, 6300, { localNow: 6400, connected: false }));
    expect(lost.position).toEqual(before.position);
    const settled = director.sample(input(show, 6300, { localNow: 8400, connected: false }));
    expect(settled.position).toEqual(SHOTS.wide.position); expect(settled.fov).toBe(SHOTS.wide.fov);
    expect(settled.reason).toBe('loss');
  });
  it('requires a fresh frame and clock lock, then resumes the shared section smoothly', () => {
    const show = state(), director = new PreviewDirector(); warm(director, show);
    expect(director.sample(input(show, 6000, { locked: false })).health).toBe('acquiring');
    expect(director.sample(input(show, 8000, { lastFrameAt: 8000 - LOSS_TIMEOUT_MS })).health).toBe('stale');
    director.sample(input(show, 10000));
    const restored = director.sample(input(show, 12000));
    expect(restored.health).toBe('live'); expect(restored.position).toEqual(sectionCamera(show, 12000).position);
  });
  it('starts safely without a snapshot', () => {
    const result = new PreviewDirector().sample({ state: null, now: 0, localNow: 500, connected: false, locked: false, lastFrameAt: null });
    expect(result.health).toBe('waiting'); expect(result.position).toEqual(SHOTS.wide.position);
  });
});

describe('audience routing', () => {
  it('supports the dedicated route and query mode without taking over desk or HMD', () => {
    expect(isPreviewPage({ pathname: '/preview', search: '' })).toBe(true);
    expect(isPreviewPage({ pathname: '/', search: '?view=preview' })).toBe(true);
    expect(isPreviewPage({ pathname: '/preview', search: '?view=hmd' })).toBe(false);
    expect(isPreviewPage({ pathname: '/', search: '?view=desk' })).toBe(false);
    expect(isPreviewPage({ pathname: '/hmd', search: '' })).toBe(false);
  });
  it('preserves hosted show selection without adding control credentials', () => {
    expect(previewPageLink('http://localhost:8787', 'ws://localhost:8787/ws', false).href).toBe('http://localhost:8787/preview');
    const hosted = previewPageLink('https://audience.example', 'wss://show.example/ws', true);
    expect(hosted.pathname).toBe('/preview');
    expect([...hosted.searchParams.entries()]).toEqual([['server', 'https://show.example']]);
  });
  it('serves /preview and ?view=preview in production without a Vite fallback', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'nanokon-preview-'));
    const html = '<!doctype html><div id="app">Audience route fixture</div>';
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await writeFile(join(dist, 'index.html'), html);
      server = await startServer({ port: 0, nativePort: 0, production: true, distDirectory: dist, controlToken: 'preview-route-control-token-123456', nativeToken: 'preview-route-native-token-123456' });
      for (const path of ['/preview', '/?view=preview', '/hmd', '/dashboard']) {
        const response = await fetch(server.url + path);
        expect(response.status).toBe(200); expect(await response.text()).toBe(html);
      }
    } finally { await server?.close(); await rm(dist, { recursive: true, force: true }); }
  });
});

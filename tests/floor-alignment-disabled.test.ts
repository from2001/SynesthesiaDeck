import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { ShowRenderer } from '../web/visuals/renderer';

interface RendererHarness {
  initialized: boolean;
  renderer: unknown;
  pipeline: unknown;
  orbit: { enabled: boolean };
  root: THREE.Group;
  calibrationStep: string;
  calibrationMarkers: THREE.Group;
  calibrationLabel: THREE.Sprite;
  createCalibration(): void;
  handleSessionStart(): void;
  handleSessionEnd(): void;
  updateCalibrationCursor(): void;
  resize(): void;
}

function setup() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
  const show = new ShowRenderer({} as HTMLElement);
  const internal = show as unknown as RendererHarness;
  const referenceSpace = new EventTarget();
  const controllers = [new THREE.Group(), new THREE.Group()];
  const xr = {
    isPresenting: true,
    getSession: () => ({}),
    getReferenceSpace: () => referenceSpace,
    getController: (index: number) => controllers[index],
  };
  internal.renderer = { xr, setClearColor: vi.fn() };
  internal.pipeline = {};
  internal.orbit = { enabled: true };
  internal.resize = vi.fn();
  internal.createCalibration();
  internal.initialized = true;
  return { show, internal, referenceSpace, controllers };
}

function expectNoFloorPrompt(internal: RendererHarness) {
  internal.updateCalibrationCursor();
  expect(internal.calibrationStep).toBe('idle');
  expect(internal.calibrationMarkers.visible).toBe(false);
  expect(internal.calibrationLabel.visible).toBe(false);
}

afterEach(() => vi.unstubAllGlobals());

describe('temporary Quest system recenter mode', () => {
  it('keeps MR entry, repeated reference resets, and session re-entry free of floor prompts', () => {
    const { show, internal, referenceSpace } = setup();
    internal.handleSessionStart();
    for (let index = 0; index < 3; index++) {
      referenceSpace.dispatchEvent(new Event('reset'));
      expectNoFloorPrompt(internal);
      expect(internal.root.position.toArray()).toEqual([0, 0, -3]);
      expect(internal.root.rotation.y).toBe(0);
      expect(internal.orbit.enabled).toBe(false);
      expect(show.stats.calibrated).toBe(false);
      expect(show.status).toContain('system button long-press');
    }
    internal.handleSessionEnd();
    expect(internal.root.position.toArray()).toEqual([0, 0, 0]);
    expect(internal.orbit.enabled).toBe(true);
    internal.handleSessionStart();
    expectNoFloorPrompt(internal);
  });

  it('ignores grip and trigger events on either controller', () => {
    const { internal, controllers } = setup();
    internal.handleSessionStart();
    for (const controller of controllers) {
      controller.dispatchEvent({ type: 'squeezestart' } as never);
      controller.dispatchEvent({ type: 'select' } as never);
      expectNoFloorPrompt(internal);
      expect(controller.getObjectByName('calibration-ray')!.visible).toBe(false);
    }
  });

  it('does not start desktop calibration through the public action', () => {
    const { show, internal } = setup();
    show.beginCalibration();
    expectNoFloorPrompt(internal);
    expect(internal.orbit.enabled).toBe(true);
  });
});

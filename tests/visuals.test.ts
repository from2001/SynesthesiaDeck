import { describe, expect, it } from 'vitest';
import { applyEvent, initialState, SILENCE, syntheticAudio, type ShowState } from '../shared/protocol';
import { evaluateEffects, floorIntersection, particleIdentity, sampleParticle, solveCalibration, transformCalibrated, visualFrame } from '../web/visuals/math';
import { PRESET_PARAMETERS, QUALITY_BUDGETS, visibleCount } from '../web/visuals/parameters';

function playing(scene = 0): ShowState { return { ...initialState('test', 1000, 49215), running: true, scene }; }

describe('deterministic procedural scenes', () => {
  it('reproduces the same positions after different frame histories and quality changes', () => {
    for (let scene = 0; scene < 5; scene++) {
      const state = playing(scene), identity = particleIdentity(state.seed, 177);
      const expected = sampleParticle(visualFrame(state, syntheticAudio(8300), 8300), identity);
      for (let frame = 1000; frame < 8300; frame += 1000 / 72) sampleParticle(visualFrame(state, syntheticAudio(frame), frame), identity);
      expect(sampleParticle(visualFrame(state, syntheticAudio(8300), 8300), identity)).toEqual(expected);
      const low = Array.from({ length: QUALITY_BUDGETS.low.particles }, (_, index) => particleIdentity(state.seed, index));
      const high = Array.from({ length: QUALITY_BUDGETS.high.particles }, (_, index) => particleIdentity(state.seed, index));
      expect(low[177]).toEqual(high[177]);
    }
  });

  it('produces distinct finite scenes for extreme controls and long-running clocks', () => {
    const shapes = [];
    for (let scene = 0; scene < 5; scene++) {
      const state = playing(scene);
      shapes.push(sampleParticle(visualFrame(state, SILENCE, 4400), particleIdentity(state.seed, 19)));
      for (const value of [0, 1]) {
        state.sceneParams.fill(value); state.toggles.fill(value === 1);
        for (const key of Object.keys(state.controls) as (keyof ShowState['controls'])[]) state.controls[key] = value;
        for (const time of [1000, 3600000, 100000000]) for (const index of [0, 19, 655, 31999]) {
          const point = sampleParticle(visualFrame(state, syntheticAudio(time), time), particleIdentity(state.seed, index));
          expect(Object.values(point).every(Number.isFinite)).toBe(true);
          expect(point.size).toBeGreaterThan(0);
        }
      }
    }
    expect(new Set(shapes.map(point => JSON.stringify(point))).size).toBe(5);
  });

  it('preserves paused phase and resumes without integrating local frame deltas', () => {
    let state = playing(1);
    state = applyEvent(state, { epoch: 'test', id: 'freeze', sequence: 1, seed: 1, effectiveAt: 2000, command: { type: 'toggle', slot: 7, value: true } });
    const a = sampleParticle(visualFrame(state, SILENCE, 3000), particleIdentity(state.seed, 2));
    const b = sampleParticle(visualFrame(state, SILENCE, 9000), particleIdentity(state.seed, 2));
    expect(a).toEqual(b);
  });

  it('uses bounded audio modulation even after an hour-long show', () => {
    const state = playing(1);
    state.controls.distortion = 0;
    const audio = { ...SILENCE, bass: .3 };
    for (const time of [1000, 3600000]) {
      const a = sampleParticle(visualFrame(state, audio, time), particleIdentity(state.seed, 39));
      const b = sampleParticle(visualFrame(state, { ...audio, bass: .31 }, time), particleIdentity(state.seed, 39));
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(.1);
    }
  });

  it('exposes eight scene-specific parameters and caps tier counts', () => {
    expect(PRESET_PARAMETERS).toHaveLength(5);
    for (const labels of PRESET_PARAMETERS) expect(new Set(labels).size).toBe(8);
    const state = playing();
    state.controls.density = 1;
    expect(visibleCount(QUALITY_BUDGETS.high.particles, state)).toBe(32000);
    state.controls.density = 0;
    expect(visibleCount(QUALITY_BUDGETS.low.particles, state)).toBe(320);
  });
});

describe('scheduled DROP and one-shot effects', () => {
  function dropState() {
    const state = playing();
    state.controls.masterFX = 1;
    state.effects = [{ id: 'drop', kind: 'drop', effectiveAt: 2000, duration: 1800, strength: 1, slot: 0, seed: 581 }];
    return state;
  }

  it('contracts, flashes, expands, and expires on absolute scheduled time', () => {
    const state = dropState();
    expect(evaluateEffects(state, 1999).contraction).toBe(1);
    expect(evaluateEffects(state, 2000 + 1800 * .29).contraction).toBeLessThan(.25);
    expect(evaluateEffects(state, 2000 + 1800 * .32).flash).toBeCloseTo(1);
    const burst = evaluateEffects(state, 2000 + 1800 * .65);
    expect(burst.burst).toBeGreaterThan(5);
    expect(burst.burstOpacity).toBeCloseTo(1);
    expect(burst.burstSeed).toBe(581);
    expect(evaluateEffects(state, 3800).flash).toBe(0);
    expect(evaluateEffects(state, 990000).burst).toBe(0);
  });

  it('clears scheduled effects when stopped and respects zero Master FX', () => {
    const state = dropState();
    state.running = false;
    expect(evaluateEffects(state, 2576).flash).toBe(0);
    state.running = true; state.controls.masterFX = 0;
    expect(evaluateEffects(state, 2576).flash).toBe(0);
    expect(evaluateEffects(state, 2576).contraction).toBe(1);
  });

  it('holds one-shot Freeze at the event phase across unrelated commands', () => {
    let state = playing(1);
    state = applyEvent(state, { epoch: 'test', id: 'freeze', sequence: 1, seed: 1, effectiveAt: 2000, command: { type: 'burst', slot: 7 } });
    const frozen = visualFrame(state, SILENCE, 2100).phase;
    state = applyEvent(state, { epoch: 'test', id: 'density', sequence: 2, seed: 1, effectiveAt: 2300, command: { type: 'control', key: 'density', value: .8 } });
    expect(visualFrame(state, SILENCE, 2500).phase).toBe(frozen);
    expect(visualFrame(state, SILENCE, 3000).phase).toBeGreaterThan(frozen);
  });

  it('routes all eight one-shot slots independently', () => {
    for (let slot = 0; slot < 8; slot++) {
      const state = playing();
      state.effects = [{ id: 'burst', kind: 'burst', effectiveAt: 2000, duration: 850, strength: 1, slot, seed: 111 }];
      const effects = evaluateEffects(state, 2425);
      expect(effects.oneShots[slot]).toBeGreaterThan(.5);
      expect(effects.oneShots.filter(value => value > 0)).toHaveLength(1);
    }
  });
});

describe('two-point floor calibration', () => {
  it('maps the same show origin and forward direction into different headset spaces', () => {
    const first = solveCalibration({ x: 1, y: 1.2, z: 2 }, { x: 1, y: .7, z: 0 });
    const second = solveCalibration({ x: -3, y: .8, z: 4 }, { x: -1, y: .1, z: 4 });
    expect(transformCalibrated({ x: 0, y: 0, z: 0 }, first)).toEqual({ x: 1, y: 0, z: 2 });
    const target = transformCalibrated({ x: 0, y: 1.5, z: -2 }, second);
    expect(target.x).toBeCloseTo(-1); expect(target.z).toBeCloseTo(4); expect(target.y).toBe(1.5);
    expect(first.separation).toBe(2); expect(second.separation).toBe(2);
  });

  it('rejects close, distant and invalid markers without inventing an alignment', () => {
    const origin = { x: 0, y: 0, z: 0 };
    expect(() => solveCalibration(origin, { x: .1, y: 2, z: 0 })).toThrow('30 cm');
    expect(() => solveCalibration(origin, { x: 21, y: 0, z: 0 })).toThrow('20 meters');
    expect(() => solveCalibration(origin, { x: NaN, y: 0, z: 1 })).toThrow('finite');
  });

  it('projects controller rays to the floor and rejects upward or remote rays', () => {
    expect(floorIntersection({ x: 1, y: 1.5, z: 2 }, { x: 0, y: -.5, z: -.5 })).toEqual({ x: 1, y: 0, z: .5 });
    expect(floorIntersection({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
    expect(floorIntersection({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -.01, z: -1 })).toBeNull();
  });
});

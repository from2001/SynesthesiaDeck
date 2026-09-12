import { describe, expect, it } from 'vitest';
import { SILENCE } from '../shared/protocol';
import { LaserPresets } from '../web/visuals/laser-presets';
import { LASER_QUALITY, galvoProjector, sampleFanBeam, sampleFigurePoint, sampleHarpString, sampleRingPoint, sampleSpoke, tunnelEmitter } from '../web/visuals/laser-math';
import { bankFrame, budget, expectFinite, signature } from './bank-helpers';

const FIRST = 20;

describe('laser bank presets', () => {
  it('gives every expression knob a visible geometric or palette effect in every preset', () => {
    const bank = new LaserPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) for (let slot = 0; slot < 8; slot++) {
      const sample = bankFrame(scene);
      sample.state.sceneParams[slot] = 0; bank.update(sample, 'medium', 1);
      const minimum = signature(bank, bank.group.children[scene - FIRST]);
      sample.state.sceneParams[slot] = 1; bank.update(sample, 'medium', 1);
      expect(signature(bank, bank.group.children[scene - FIRST]), `scene ${scene}, knob ${slot}`).not.toBe(minimum);
    }
  });

  it('produces the same rendered geometry after different histories and quality settings', () => {
    const a = new LaserPresets(), b = new LaserPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene, 231.42, 1234);
      a.update(sample, 'medium', .8);
      for (const quality of ['high', 'low'] as const) b.update(bankFrame(FIRST + (scene + 1) % 5, 10000, 99999), quality, 2);
      b.update(sample, 'medium', .8);
      expect(signature(a, a.group.children[scene - FIRST])).toBe(signature(b, b.group.children[scene - FIRST]));
      b.update(bankFrame(scene, 231.42, 4567), 'medium', .8);
      expect(signature(a, a.group.children[scene - FIRST])).not.toBe(signature(b, b.group.children[scene - FIRST]));
    }
  });

  it('keeps generated geometry finite with every effect enabled at both parameter extremes', () => {
    const bank = new LaserPresets();
    for (const edge of [0, 1]) for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene, 1000000.123);
      sample.state.sceneParams.fill(edge); sample.state.toggles.fill(true);
      sample.state.controls.density = edge; sample.state.controls.distortion = 1; sample.state.controls.glitch = 1;
      sample.effects.oneShots.fill(1);
      bank.update(sample, 'high', 1);
      expect(expectFinite(bank, bank.group.children[scene - FIRST]), `scene ${scene}`).toBe(true);
    }
  });

  it('stays within five draw calls and 4000 active vertices at medium quality', () => {
    const bank = new LaserPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene); sample.state.controls.density = 1; sample.state.sceneParams[3] = 1; sample.state.sceneParams[7] = 1;
      bank.update(sample, 'medium', 1);
      const { draws, vertices } = budget(bank, bank.group.children[scene - FIRST]);
      expect(draws, `scene ${scene}`).toBeLessThanOrEqual(5);
      expect(vertices, `scene ${scene}`).toBeLessThan(4000);
    }
  });

  it('hides every world when the bank is not selected or the gain is zero', () => {
    const bank = new LaserPresets();
    bank.update(bankFrame(22), 'medium', 1);
    expect(bank.group.visible).toBe(true); expect(bank.group.children[2].visible).toBe(true);
    bank.update(bankFrame(22), 'medium', 0);
    expect(bank.group.visible).toBe(false);
    bank.update(bankFrame(16), 'medium', 1);
    for (const world of bank.group.children) expect(world.visible).toBe(false);
  });
});

describe('laser bank sampling', () => {
  it('fans every harp string from one floor emitter and cuts plucked strings toward it', () => {
    const sample = bankFrame(FIRST); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    const count = LASER_QUALITY.medium.strings;
    const emitter = sampleHarpString(sample, 0, count).from;
    let plucked = 0;
    for (let index = 0; index < count; index++) {
      const string = sampleHarpString(sample, index, count);
      expect(string.from).toEqual(emitter); expect(string.to.y).toBeGreaterThan(string.from.y);
      const full = bankFrame(FIRST); full.state.sceneParams[6] = 0; full.state.controls.distortion = 0; full.state.controls.glitch = 0;
      const uncut = sampleHarpString(full, index, count);
      if (string.spot > .2) { plucked++; expect(string.to.y).toBeLessThan(uncut.to.y); }
    }
    expect(plucked).toBeGreaterThan(0);
  });

  it('lands downward fan beams and starburst spokes on the floor and keeps rising ones in the air', () => {
    for (const sampler of [
      (frame: ReturnType<typeof bankFrame>, index: number) => sampleFanBeam(frame, index % 3, 3, index, 12),
      (frame: ReturnType<typeof bankFrame>, index: number) => sampleSpoke(frame, index, 40),
    ]) {
      let floor = 0, air = 0;
      for (const phase of [1, 3, 5, 8, 13]) for (let index = 0; index < 40; index++) {
        const sample = bankFrame(FIRST + 1, phase); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
        const beam = sampler(sample, index);
        if (beam.spot > 0) { floor++; expect(beam.to.y).toBeCloseTo(0, 6); }
        else { air++; expect(beam.to.y).toBeGreaterThan(0); }
        expect(Math.hypot(beam.to.x - beam.from.x, beam.to.y - beam.from.y, beam.to.z - beam.from.z)).toBeGreaterThan(.5);
      }
      expect(floor).toBeGreaterThan(0); expect(air).toBeGreaterThan(0);
    }
  });

  it('closes each tunnel ring and places the cone emitter behind the deepest ring', () => {
    const sample = bankFrame(FIRST + 2); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    const rings = LASER_QUALITY.medium.rings;
    const emitter = tunnelEmitter(sample, rings);
    for (let ring = 0; ring < rings; ring++) {
      const start = sampleRingPoint(sample, ring, rings, 0), end = sampleRingPoint(sample, ring, rings, 1);
      expect(start.x).toBeCloseTo(end.x, 8); expect(start.y).toBeCloseTo(end.y, 8);
      expect(emitter.z).toBeLessThan(start.z);
    }
  });

  it('draws a closed Lissajous figure on the screen with the projector behind the audience', () => {
    const sample = bankFrame(FIRST + 3); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    const start = sampleFigurePoint(sample, 0), end = sampleFigurePoint(sample, 1), middle = sampleFigurePoint(sample, .37);
    expect(start.x).toBeCloseTo(end.x, 8); expect(start.y).toBeCloseTo(end.y, 8); expect(middle.z).toBe(start.z);
    expect(galvoProjector(sample).z).toBeGreaterThan(0); expect(start.z).toBeLessThan(0);
  });

  it('responds to audio while keeping motion tied to phase instead of wall time', () => {
    const quiet = bankFrame(FIRST + 4, 5, 48291, SILENCE), loud = bankFrame(FIRST + 4, 5, 48291, { ...SILENCE, bass: 1, beat: 1, mid: 1, high: 1, level: 1 });
    expect(sampleSpoke(quiet, 3, 40).glow).not.toBe(sampleSpoke(loud, 3, 40).glow);
    const frozen = { ...loud, time: loud.time + 500000 };
    expect(sampleSpoke(loud, 3, 40)).toEqual(sampleSpoke(frozen, 3, 40));
    expect(sampleRingPoint(loud, 2, 10, .2)).toEqual(sampleRingPoint(frozen, 2, 10, .2));
  });
});

import { describe, expect, it } from 'vitest';
import { SILENCE } from '../shared/protocol';
import { EchoPresets } from '../web/visuals/echo-presets';
import { ECHO_QUALITY, PENDULUM_CYCLE, linksPerCluster, sampleBubble, sampleCurtain, sampleKelp, sampleLink, sampleNode, samplePendulum, sampleTrace } from '../web/visuals/echo-math';
import { bankFrame, budget, expectFinite, signature } from './bank-helpers';

const FIRST = 15;

describe('echo bank presets', () => {
  it('gives every expression knob a visible geometric or palette effect in every preset', () => {
    const bank = new EchoPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) for (let slot = 0; slot < 8; slot++) {
      const sample = bankFrame(scene);
      sample.state.sceneParams[slot] = 0; bank.update(sample, 'medium', 1);
      const minimum = signature(bank, bank.group.children[scene - FIRST]);
      sample.state.sceneParams[slot] = 1; bank.update(sample, 'medium', 1);
      expect(signature(bank, bank.group.children[scene - FIRST]), `scene ${scene}, knob ${slot}`).not.toBe(minimum);
    }
  });

  it('produces the same rendered geometry after different histories and quality settings', () => {
    const a = new EchoPresets(), b = new EchoPresets();
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
    const bank = new EchoPresets();
    for (const edge of [0, 1]) for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene, 1000000.123);
      sample.state.sceneParams.fill(edge); sample.state.toggles.fill(true);
      sample.state.controls.density = edge; sample.state.controls.distortion = 1; sample.state.controls.glitch = 1;
      sample.effects.oneShots.fill(1);
      bank.update(sample, 'high', 1);
      expect(expectFinite(bank, bank.group.children[scene - FIRST]), `scene ${scene}`).toBe(true);
    }
  });

  it('stays within six draw calls and 15000 active vertices at medium quality', () => {
    const bank = new EchoPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene); sample.state.controls.density = 1; sample.state.sceneParams[3] = 1; sample.state.sceneParams[7] = 1;
      bank.update(sample, 'medium', 1);
      const { draws, vertices } = budget(bank, bank.group.children[scene - FIRST]);
      expect(draws, `scene ${scene}`).toBeLessThanOrEqual(6);
      expect(vertices, `scene ${scene}`).toBeLessThan(15000);
    }
  });

  it('hides every world when the bank is not selected or the gain is zero', () => {
    const bank = new EchoPresets();
    bank.update(bankFrame(17), 'medium', 1);
    expect(bank.group.visible).toBe(true); expect(bank.group.children[2].visible).toBe(true);
    bank.update(bankFrame(17), 'medium', 0);
    expect(bank.group.visible).toBe(false);
    bank.update(bankFrame(3), 'medium', 1);
    expect(bank.group.visible).toBe(false);
    for (const world of bank.group.children) expect(world.visible).toBe(false);
  });
});

describe('echo bank sampling', () => {
  it('responds to audio and freezes with the authoritative phase rather than wall time', () => {
    const quiet = bankFrame(FIRST, 5, 48291, SILENCE), loud = bankFrame(FIRST, 5, 48291, { ...SILENCE, bass: 1, beat: 1, mid: 1, high: 1, level: 1 });
    expect(sampleTrace(quiet, 2, 10, .3)).not.toEqual(sampleTrace(loud, 2, 10, .3));
    expect(sampleKelp(quiet, 1, 12, .8)).not.toEqual(sampleKelp(loud, 1, 12, .8));
    const frozen = { ...loud, time: loud.time + 500000 };
    expect(samplePendulum(loud, 3, 10)).toEqual(samplePendulum(frozen, 3, 10));
    expect(sampleCurtain(loud, 1, .4, .5)).toEqual(sampleCurtain(frozen, 1, .4, .5));
  });

  it('closes a full-curvature waveform wall into a ring', () => {
    const sample = bankFrame(FIRST); sample.state.sceneParams[6] = 1; sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    const start = sampleTrace(sample, 2, 10, 0), end = sampleTrace(sample, 2, 10, 1);
    expect(start.x).toBeCloseTo(end.x, 8); expect(start.z).toBeCloseTo(end.z, 8);
  });

  it('links only existing nodes, always spokes each hub, and moves packets with phase', () => {
    const sample = bankFrame(FIRST + 1);
    const clusters = ECHO_QUALITY.medium.clusters, members = ECHO_QUALITY.medium.members;
    for (let link = 0; link < clusters * linksPerCluster(members); link++) {
      const { a, b, active } = sampleLink(sample, link, clusters, members);
      expect(a).toBeLessThan(clusters * members); expect(b).toBeLessThan(clusters * members); expect(a).not.toBe(b);
      if (link % linksPerCluster(members) < members - 1) expect(active).toBe(true);
    }
    const hub = sampleNode(sample, members, clusters, members), member = sampleNode(sample, members + 3, clusters, members);
    expect(hub.member).toBe(0); expect(member.cluster).toBe(1); expect(hub.size).toBeGreaterThan(member.size);
  });

  it('roots kelp on the floor, raises bubbles over time and keeps strands inside the forest spread', () => {
    const sample = bankFrame(FIRST + 2); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    for (let strand = 0; strand < 12; strand++) {
      expect(sampleKelp(sample, strand, 12, 0).y).toBe(0);
      expect(sampleKelp(sample, strand, 12, 1).y).toBeGreaterThan(1);
      expect(Math.hypot(sampleKelp(sample, strand, 12, 0).x, sampleKelp(sample, strand, 12, 0).z)).toBeLessThan(5);
    }
    const later = bankFrame(FIRST + 2, 5.5); later.state.controls.distortion = 0; later.state.controls.glitch = 0;
    expect(sampleBubble(later, 4, 12).y).not.toBe(sampleBubble(sample, 4, 12).y);
  });

  it('hangs aurora curtains above head height with brighter ray tips than top edges', () => {
    const sample = bankFrame(FIRST + 3);
    for (const u of [0, .33, .8]) {
      const tip = sampleCurtain(sample, 0, u, 0), top = sampleCurtain(sample, 0, u, 1);
      expect(tip.y).toBeGreaterThan(1.5); expect(top.y).toBeGreaterThan(tip.y); expect(tip.glow).toBeGreaterThan(top.glow);
    }
  });

  it('realigns the pendulum wave after one cycle and hangs every bob below its pivot', () => {
    const sample = bankFrame(FIRST + 4); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    for (let index = 0; index < 28; index++) {
      const now = samplePendulum(sample, index, 28), later = samplePendulum(sample, index, 28, undefined, sample.phase + PENDULUM_CYCLE);
      expect(later.x).toBeCloseTo(now.x, 6); expect(later.y).toBeCloseTo(now.y, 6); expect(later.z).toBeCloseTo(now.z, 6);
      expect(now.y).toBeLessThan(now.pivotY); expect(now.length).toBeGreaterThan(0);
      expect(Math.hypot(now.x - now.pivotX, now.y - now.pivotY, now.z - now.pivotZ)).toBeCloseTo(now.length, 6);
    }
    expect(samplePendulum(sample, 0, 28).length).toBeGreaterThan(samplePendulum(sample, 27, 28).length);
  });
});

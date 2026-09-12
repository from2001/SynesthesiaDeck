import { describe, expect, it } from 'vitest';
import { SILENCE } from '../shared/protocol';
import { UnchartedPresets } from '../web/visuals/uncharted-presets';
import { AUTOMATON_RULES, DANCER_JOINTS, automatonBlock, automatonRule, sampleCell, sampleDancer, sampleDomino, sampleLantern, sampleShell, sampleSpark,
  shellPosition } from '../web/visuals/uncharted-math';
import { bankFrame, budget, expectFinite, signature } from './bank-helpers';

const FIRST = 25;

describe('uncharted bank presets', () => {
  it('gives every expression knob a visible geometric or palette effect in every preset', () => {
    const bank = new UnchartedPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) for (let slot = 0; slot < 8; slot++) {
      const sample = bankFrame(scene);
      sample.state.sceneParams[slot] = 0; bank.update(sample, 'medium', 1);
      const minimum = signature(bank, bank.group.children[scene - FIRST]);
      sample.state.sceneParams[slot] = 1; bank.update(sample, 'medium', 1);
      expect(signature(bank, bank.group.children[scene - FIRST]), `scene ${scene}, knob ${slot}`).not.toBe(minimum);
    }
  });

  it('produces the same rendered geometry after different histories and quality settings', () => {
    const a = new UnchartedPresets(), b = new UnchartedPresets();
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
    const bank = new UnchartedPresets();
    for (const edge of [0, 1]) for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene, 1000000.123);
      sample.state.sceneParams.fill(edge); sample.state.toggles.fill(true);
      sample.state.controls.density = edge; sample.state.controls.distortion = 1; sample.state.controls.glitch = 1;
      sample.effects.oneShots.fill(1);
      bank.update(sample, 'high', 1);
      expect(expectFinite(bank, bank.group.children[scene - FIRST]), `scene ${scene}`).toBe(true);
    }
  });

  it('stays within four draw calls and 15000 active vertices at medium quality', () => {
    const bank = new UnchartedPresets();
    for (let scene = FIRST; scene < FIRST + 5; scene++) {
      const sample = bankFrame(scene); sample.state.controls.density = 1; sample.state.sceneParams[3] = 1; sample.state.sceneParams[7] = 1;
      bank.update(sample, 'medium', 1);
      const { draws, vertices } = budget(bank, bank.group.children[scene - FIRST]);
      expect(draws, `scene ${scene}`).toBeLessThanOrEqual(4);
      expect(vertices, `scene ${scene}`).toBeLessThan(15000);
    }
  });

  it('reuses cached automaton blocks and hides every world when unselected', () => {
    const bank = new UnchartedPresets();
    const sample = bankFrame(FIRST + 3);
    bank.update(sample, 'medium', 1);
    const first = signature(bank, bank.group.children[3]);
    bank.update(bankFrame(FIRST + 3, 900), 'medium', 1);
    bank.update(sample, 'medium', 1);
    expect(signature(bank, bank.group.children[3])).toBe(first);
    bank.update(bankFrame(FIRST + 3), 'medium', 0);
    expect(bank.group.visible).toBe(false);
    bank.update(bankFrame(9), 'medium', 1);
    for (const world of bank.group.children) expect(world.visible).toBe(false);
  });
});

describe('uncharted bank sampling', () => {
  it('topples dominoes behind the wave front, leaves the rest standing, and keeps unit tangents', () => {
    const sample = bankFrame(FIRST, 3); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    const count = 180;
    let fallen = 0, standing = 0;
    for (let index = 0; index < count; index++) {
      const domino = sampleDomino(sample, index, count);
      expect(Math.hypot(domino.tangentX, domino.tangentZ)).toBeCloseTo(1, 8);
      expect(domino.y).toBe(0);
      if (domino.fallen > .99) fallen++; else if (domino.fallen < .01) standing++;
    }
    expect(fallen).toBeGreaterThan(5); expect(standing).toBeGreaterThan(5);
    const early = sampleDomino(bankFrame(FIRST, 0), 40, count);
    expect(early.fallen).toBe(0); expect(early.angle).toBe(0);
    expect(Math.hypot(sampleDomino(sample, 100, count).x, sampleDomino(sample, 100, count).z)).toBeGreaterThan(Math.hypot(sampleDomino(sample, 10, count).x, sampleDomino(sample, 10, count).z));
  });

  it('keeps dancers upright on the floor with glowsticks beyond their hands', () => {
    const sample = bankFrame(FIRST + 1); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    for (let index = 0; index < 10; index++) {
      const dancer = sampleDancer(sample, index), joints = dancer.joints;
      expect(joints).toHaveLength(DANCER_JOINTS * 3);
      expect(joints[2 * 3 + 1]).toBeGreaterThan(joints[1 * 3 + 1]);
      expect(joints[1 * 3 + 1]).toBeGreaterThan(joints[0 * 3 + 1]);
      for (const foot of [13, 14]) expect(joints[foot * 3 + 1]).toBeGreaterThanOrEqual(0);
      for (const [hand, tip] of [[7, 15], [8, 16]]) expect(Math.hypot(joints[tip * 3] - joints[hand * 3], joints[tip * 3 + 1] - joints[hand * 3 + 1], joints[tip * 3 + 2] - joints[hand * 3 + 2])).toBeCloseTo(.2 + .5 * .3, 6);
      expect(Array.from(joints).every(Number.isFinite)).toBe(true);
    }
    const later = sampleDancer(bankFrame(FIRST + 1, 5.3), 2);
    expect(Array.from(later.joints)).not.toEqual(Array.from(sampleDancer(sample, 2).joints));
  });

  it('cycles lanterns upward, fading them in at launch and out near the top', () => {
    const sample = bankFrame(FIRST + 2); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    let low = 0, high = 0;
    for (let index = 0; index < 90; index++) {
      const lantern = sampleLantern(sample, index);
      expect(lantern.y).toBeGreaterThanOrEqual(.1); expect(lantern.glow).toBeGreaterThanOrEqual(0);
      if (lantern.cycle < .04) { low++; expect(lantern.glow).toBeLessThan(.7); }
      if (lantern.cycle > .96) { high++; expect(lantern.glow).toBeLessThan(.5); }
    }
    expect(low + high).toBeGreaterThan(0);
  });

  it('derives automaton blocks purely from seed, block, rule and size', () => {
    const width = 72, rows = 36;
    const a = automatonBlock(48291, 3, 30, width, rows, new Uint8Array(width * rows));
    const b = automatonBlock(48291, 3, 30, width, rows, new Uint8Array(width * rows));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(automatonBlock(48291, 4, 30, width, rows, new Uint8Array(width * rows)))).not.toEqual(Array.from(a));
    expect(Array.from(automatonBlock(48291, 3, 90, width, rows, new Uint8Array(width * rows)))).not.toEqual(Array.from(a));
    for (let row = 1; row < rows; row++) for (let x = 0; x < width; x++) {
      const left = a[(row - 1) * width + (x + width - 1) % width], center = a[(row - 1) * width + x], right = a[(row - 1) * width + (x + 1) % width];
      expect(a[row * width + x]).toBe((30 >> (left * 4 + center * 2 + right)) & 1);
    }
    const sample = bankFrame(FIRST + 3);
    sample.state.sceneParams[3] = 0; expect(automatonRule(sample)).toBe(AUTOMATON_RULES[0]);
    sample.state.sceneParams[3] = 1; expect(automatonRule(sample)).toBe(AUTOMATON_RULES[AUTOMATON_RULES.length - 1]);
    const newest = sampleCell(sample, 10, width, 0, rows), oldest = sampleCell(sample, 10, width, rows - 1, rows);
    expect(oldest.y).toBeGreaterThan(newest.y); expect(newest.glow).toBeGreaterThan(oldest.glow);
  });

  it('launches shells that reach their burst point and sparks that fall back with gravity', () => {
    const sample = bankFrame(FIRST + 4); sample.state.controls.distortion = 0; sample.state.controls.glitch = 0;
    for (let slot = 0; slot < 6; slot++) {
      const shell = sampleShell(sample, slot);
      expect(shell.launch.y).toBe(0); expect(shell.burst.y).toBeGreaterThan(2);
      const apex = shellPosition(shell, shell.rise);
      expect(apex.x).toBeCloseTo(shell.burst.x, 8); expect(apex.y).toBeCloseTo(shell.burst.y, 8);
      expect(shellPosition(shell, 0).y).toBe(0);
      const origin = sampleSpark(sample, shell, 5, 100, 0), later = sampleSpark(sample, shell, 5, 100, .6), late = sampleSpark(sample, shell, 5, 100, 3);
      expect(origin.x).toBeCloseTo(shell.burst.x, 8); expect(origin.y).toBeCloseTo(shell.burst.y, 8);
      expect(Math.hypot(later.x - shell.burst.x, later.z - shell.burst.z)).toBeGreaterThan(.2);
      expect(late.y).toBeLessThan(later.y); expect(late.glow).toBeLessThan(origin.glow);
    }
    const quiet = sampleSpark(bankFrame(FIRST + 4, 5, 48291, SILENCE), sampleShell(sample, 0), 5, 100, .5);
    expect(quiet.glow).not.toBe(sampleSpark(sample, sampleShell(sample, 0), 5, 100, .5).glow);
  });
});

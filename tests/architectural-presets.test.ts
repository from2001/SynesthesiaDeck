import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { initialState, SILENCE } from '../shared/protocol';
import { ArchitecturalPresets } from '../web/visuals/architectural-presets';
import { architecturalCounts, architecturalDeform, architecturalPalette, latticePose, loomPoint, monolithPose, origamiPoint, portalPoint } from '../web/visuals/architectural-math';
import { visualFrame, type VisualFrame } from '../web/visuals/math';

function frame(scene = 10, phase = 5, seed = 48291): VisualFrame {
  const state = initialState('architectural-test', 0, seed);
  state.scene = scene; state.running = true;
  state.motion = { at: 0, rate: 1, phase: 0 };
  return visualFrame(state, { ...SILENCE, level: .4, bass: .35, mid: .25, high: .3, beat: .2 }, phase * 1000);
}

/** Hash only rendered vertices and live instances, excluding unused preallocation. */
function signature(bank: ArchitecturalPresets, scene: number): number {
  let hash = 2166136261;
  const add = (value: number) => { hash = Math.imul(hash ^ Math.round(value * 100000), 16777619); };
  bank.group.children[scene - 10].traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    if (object instanceof THREE.InstancedMesh) {
      add(object.count);
      for (let i = 0; i < object.count * 16; i++) add(object.instanceMatrix.array[i]);
      for (let i = 0; i < object.count * 3; i++) add(object.instanceColor!.array[i]);
    } else {
      const geometry = mesh.geometry, count = geometry.drawRange.count;
      add(count);
      for (const key of ['position', 'color']) {
        const attribute = geometry.getAttribute(key);
        for (let i = 0; i < count; i++) {
          const index = geometry.index ? geometry.index.getX(i) : i;
          add(attribute.getX(index)); add(attribute.getY(index)); add(attribute.getZ(index));
        }
      }
    }
  });
  return hash;
}

describe('architectural surface presets', () => {
  it('gives every expression knob a visible geometric or palette effect in every preset', () => {
    const bank = new ArchitecturalPresets();
    for (let scene = 10; scene <= 14; scene++) for (let slot = 0; slot < 8; slot++) {
      const sample = frame(scene);
      sample.state.sceneParams[slot] = 0; bank.update(sample, 'medium', 1);
      const minimum = signature(bank, scene);
      sample.state.sceneParams[slot] = 1; bank.update(sample, 'medium', 1);
      expect(signature(bank, scene), `scene ${scene}, knob ${slot}`).not.toBe(minimum);
    }
  });

  it('uses density for complete cells, lattices, closed loops, arches and portal rings', () => {
    const sample = frame();
    sample.state.controls.density = 0;
    const low = architecturalCounts(sample, 'medium');
    sample.state.controls.density = 1;
    const high = architecturalCounts(sample, 'medium');
    for (const key of Object.keys(low) as (keyof typeof low)[]) expect(high[key]).toBeGreaterThan(low[key]);
    expect(low.monoliths % 8).toBe(0); expect(high.monoliths % 8).toBe(0);
  });

  it('produces the same rendered geometry after different histories and quality settings', () => {
    const a = new ArchitecturalPresets(), b = new ArchitecturalPresets();
    for (let scene = 10; scene <= 14; scene++) {
      const sample = frame(scene, 231.42, 1234);
      a.update(sample, 'medium', .8);
      for (const quality of ['high', 'low'] as const) b.update(frame(10 + (scene + 1) % 5, 10000, 99999), quality, 2);
      b.update(sample, 'medium', .8);
      expect(signature(a, scene)).toBe(signature(b, scene));
      b.update(frame(scene, 231.42, 4567), 'medium', .8);
      expect(signature(a, scene)).not.toBe(signature(b, scene));
    }
  });

  it('responds geometrically to audio without depending on render time or previous samples', () => {
    const a = frame(); a.audio = { ...SILENCE };
    const b = structuredClone(a); b.audio = { ...SILENCE, bass: 1, beat: 1, mid: 1, high: 1 };
    expect(origamiPoint(a, 3, 2, .5, .5, true)).not.toEqual(origamiPoint(b, 3, 2, .5, .5, true));
    expect(latticePose(a, 2, 5, false)).not.toEqual(latticePose(b, 2, 5, false));
    expect(loomPoint(a, 2, .23)).not.toEqual(loomPoint(b, 2, .23));
    expect(monolithPose(a, 16)).not.toEqual(monolithPose(b, 16));
    expect(portalPoint(a, 3, 2, 1, false)).not.toEqual(portalPoint(b, 3, 2, 1, false));
    const frozen = { ...b, time: b.time + 500000 };
    expect(loomPoint(b, 1, .7)).toEqual(loomPoint(frozen, 1, .7));
    expect(architecturalDeform({ x: 2, y: 2, z: -3 }, b, 2)).toEqual(architecturalDeform({ x: 2, y: 2, z: -3 }, frozen, 2));
  });

  it('keeps braided loops and polygon seams closed at parameter extremes', () => {
    for (const edge of [0, 1]) {
      const sample = frame(12, 35.25);
      sample.state.sceneParams.fill(edge);
      for (let loop = 0; loop < 10; loop++) {
        const a = loomPoint(sample, loop, 0), b = loomPoint(sample, loop, 1);
        expect(a.x).toBeCloseTo(b.x, 8); expect(a.y).toBeCloseTo(b.y, 8); expect(a.z).toBeCloseTo(b.z, 8);
      }
      const sides = 3 + Math.floor(edge * 9);
      const a = portalPoint(sample, 3, 0, 1, false), b = portalPoint(sample, 3, sides, 1, false);
      expect(a.x).toBeCloseTo(b.x, 8); expect(a.y).toBeCloseTo(b.y, 8); expect(a.z).toBeCloseTo(b.z, 8);
    }
  });

  it('does not double-cover a tube when the braid winding knob crosses integer steps', () => {
    const sample = frame(12, 9.75);
    for (const value of [0, .2, .3, .5, .7, .9, 1]) {
      sample.state.sceneParams[4] = value;
      const first = loomPoint(sample, 0, .13), halfway = loomPoint(sample, 0, .63);
      expect(Math.hypot(first.x - halfway.x, first.y - halfway.y, first.z - halfway.z)).toBeGreaterThan(.01);
    }
  });

  it('keeps generated geometry finite and bounded with every effect enabled', () => {
    const bank = new ArchitecturalPresets();
    for (const edge of [0, 1]) for (let scene = 10; scene <= 14; scene++) {
      const sample = frame(scene, 1000000.123);
      sample.state.sceneParams.fill(edge); sample.state.toggles.fill(true);
      sample.state.controls.density = 1; sample.state.controls.distortion = 1; sample.state.controls.glitch = 1;
      sample.effects.oneShots.fill(1);
      bank.update(sample, 'high', 1);
      bank.group.children[scene - 10].traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.geometry) return;
        const positions = mesh.geometry.getAttribute('position');
        for (const value of positions.array) expect(Number.isFinite(value)).toBe(true);
        if (object instanceof THREE.InstancedMesh) for (const value of object.instanceMatrix.array) expect(Number.isFinite(value)).toBe(true);
      });
      expect(architecturalPalette(sample, 0, .5)).toBeGreaterThanOrEqual(0);
      expect(architecturalPalette(sample, 0, .5)).toBeLessThan(1);
    }
  });

  it('uses at most two draw calls and fewer than 15000 active vertices at medium quality', () => {
    const bank = new ArchitecturalPresets();
    for (let scene = 10; scene <= 14; scene++) {
      const sample = frame(scene); sample.state.controls.density = 1; sample.state.sceneParams[3] = 1;
      bank.update(sample, 'medium', 1);
      let draws = 0, vertices = 0;
      bank.group.children[scene - 10].traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.geometry) return;
        draws++;
        if (object instanceof THREE.InstancedMesh) vertices += object.geometry.getAttribute('position').count * object.count;
        else if (mesh.geometry.index) {
          const used = new Set<number>();
          for (let index = 0; index < mesh.geometry.drawRange.count; index++) used.add(mesh.geometry.index.getX(index));
          vertices += used.size;
        } else vertices += mesh.geometry.drawRange.count;
      });
      expect(draws).toBeLessThanOrEqual(2); expect(vertices).toBeLessThan(15000);
    }
  });

  it('halves Loom CPU vertex writes and active GPU work in Low without reallocating or opening loops', () => {
    const bank = new ArchitecturalPresets(), sample = frame(12);
    const mesh = bank.group.children[2].children[0] as THREE.Mesh;
    const geometry = mesh.geometry, index = geometry.index!;
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const writes = vi.spyOn(positions, 'setXYZ');
    const counts: { vertices: number; indices: number }[] = [];
    for (const quality of ['high', 'low', 'medium', 'high'] as const) {
      writes.mockClear(); bank.update(sample, quality, 1);
      expect(mesh.geometry).toBe(geometry); expect(geometry.index).toBe(index);
      const used = new Set<number>();
      for (let offset = 0; offset < geometry.drawRange.count; offset++) used.add(index.getX(offset));
      expect(writes.mock.calls.length).toBe(used.size);
      expect(positions.updateRanges).toEqual([{ start: 0, count: used.size * 3 }]);
      const loops = architecturalCounts(sample, quality).loops;
      const stride = used.size / loops;
      for (let loop = 0; loop < loops; loop++) for (let side = 0; side < 6; side++) {
        const first = loop * stride + side, last = (loop + 1) * stride - 6 + side;
        expect(positions.getX(first)).toBeCloseTo(positions.getX(last), 5);
        expect(positions.getY(first)).toBeCloseTo(positions.getY(last), 5);
        expect(positions.getZ(first)).toBeCloseTo(positions.getZ(last), 5);
      }
      counts.push({ vertices: used.size, indices: geometry.drawRange.count });
    }
    expect(counts[1].vertices).toBeLessThan(counts[0].vertices / 2);
    expect(counts[1].indices).toBeLessThan(counts[0].indices / 2);
    expect(counts[2].vertices).toBeGreaterThan(counts[1].vertices);
    expect(counts[2].vertices).toBeLessThan(counts[0].vertices);
    expect(counts[3]).toEqual(counts[0]);
    writes.mockRestore();
  });

  it('makes zero gain invisible and makes Prism visibly color a neutral moire lattice', () => {
    const bank = new ArchitecturalPresets();
    const sample = frame(11);
    bank.update(sample, 'medium', 1); const neutral = signature(bank, 11);
    sample.state.toggles[6] = true;
    bank.update(sample, 'medium', 1); expect(signature(bank, 11)).not.toBe(neutral);
    bank.update(sample, 'medium', 0); expect(bank.group.visible).toBe(false);
    for (const world of bank.group.children) expect(world.visible).toBe(false);
  });
});

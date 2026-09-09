import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { initialState, SILENCE } from '../shared/protocol';
import { visualFrame, type VisualFrame } from '../web/visuals/math';
import { OrganicPresets } from '../web/visuals/organic-presets';
import { organicHue, sampleBell, sampleBird, sampleBranch, sampleMercury, sampleSilk, sampleSpore, sampleTendril,
  type BirdSample, type BranchSample } from '../web/visuals/organic-math';

const branch = (): BranchSample => ({ x: 0, y: 0, z: 0, startX: 0, startY: 0, startZ: 0, radius: 0, depth: 0, hue: 0, glow: 0 });
const bird = (): BirdSample => ({ x: 0, y: 0, z: 0, heading: 0, bank: 0, flap: 0, span: 0, hue: 0, glow: 0 });
function frame(scene: number, time = 8700, seed = 19473): VisualFrame {
  const state = initialState('organic-test', 0, seed); state.running = true; state.scene = scene;
  return visualFrame(state, { ...SILENCE, bass: .2, mid: .3, high: .2, beat: .1 }, time);
}
function fingerprint(input: VisualFrame): number[] {
  const scene = input.state.scene;
  if (scene === 5) return Object.values(sampleSilk(input, 2, .37, .82));
  if (scene === 6) return [...Object.values(sampleBranch(input, 2, 44, branch())), ...Object.values(sampleSpore(input, 11))];
  if (scene === 7) return [...Object.values(sampleBell(input, 2, .37, .82)), ...Object.values(sampleTendril(input, 2, 7, .68))];
  if (scene === 8) return Object.values(sampleMercury(input, 0, .37, .31));
  return Object.values(sampleBird(input, 37, bird()));
}

describe('organic scene determinism and expression', () => {
  it('gives each scene a distinct seeded result independent of previous frame history', () => {
    const shapes: string[] = [];
    for (let scene = 5; scene <= 9; scene++) {
      const expected = fingerprint(frame(scene));
      for (const time of [0, 11, 2000, 4431, 33000, 998000]) fingerprint(frame(scene, time));
      expect(fingerprint(frame(scene))).toEqual(expected);
      expect(fingerprint(frame(scene, 8700, 8831))).not.toEqual(expected);
      shapes.push(JSON.stringify(expected.slice(0, 3)));
    }
    expect(new Set(shapes).size).toBe(5);
  });

  it('has a measurable response to every one of the eight scene parameters', () => {
    for (let scene = 5; scene <= 9; scene++) for (let parameter = 0; parameter < 8; parameter++) {
      const a = frame(scene), b = frame(scene);
      a.state.sceneParams[parameter] = .12; b.state.sceneParams[parameter] = .88;
      const first = fingerprint(a), second = fingerprint(b);
      expect(first.some((value, index) => Math.abs(value - second[index]) > 1e-7), `scene ${scene}, knob ${parameter}`).toBe(true);
    }
  });

  it('remains finite for all extremes, effect combinations and long-running phases', () => {
    for (let scene = 5; scene <= 9; scene++) for (const value of [0, 1]) for (const time of [0, 1000, 3600000, 100000000]) {
      const input = frame(scene, time); input.state.sceneParams.fill(value); input.state.toggles.fill(value === 1);
      for (const control of Object.keys(input.state.controls) as (keyof typeof input.state.controls)[]) input.state.controls[control] = value;
      expect(fingerprint(input).every(Number.isFinite)).toBe(true);
    }
  });

  it('freezes organic motion with the authoritative phase even if wall time changes', () => {
    for (let scene = 5; scene <= 9; scene++) {
      const input = frame(scene), later = frame(scene);
      later.time += 500000;
      expect(fingerprint(later)).toEqual(fingerprint(input));
    }
  });

  it('applies Twist, Mirror, Scatter and Prism without local animation state', () => {
    for (const slot of [2, 3, 4, 6]) {
      const base = frame(5), altered = frame(5);
      altered.state.toggles[slot] = true;
      expect(fingerprint(altered)).not.toEqual(fingerprint(base));
      if (slot === 6) expect(organicHue(altered, 5, 2)).not.toBe(organicHue(base, 5, 2));
    }
  });
});

describe('organic surface and skeleton continuity', () => {
  it('keeps child branches attached to their parent after shared deformations', () => {
    const input = frame(6); input.state.toggles[2] = true; input.state.toggles[4] = true;
    for (let index = 1; index < 63; index++) {
      const parent = sampleBranch(input, 2, Math.floor((index - 1) / 2), branch());
      const child = sampleBranch(input, 2, index, branch());
      expect(child.startX).toBeCloseTo(parent.x, 10);
      expect(child.startY).toBeCloseTo(parent.y, 10);
      expect(child.startZ).toBeCloseTo(parent.z, 10);
    }
  });

  it('closes the jellyfish and mercury azimuth seams without cracks', () => {
    for (const v of [0, .2, .7, 1]) {
      const bellA = sampleBell(frame(7), 1, 0, v), bellB = sampleBell(frame(7), 1, 1, v);
      const metalA = sampleMercury(frame(8), 0, 0, v), metalB = sampleMercury(frame(8), 0, 1, v);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(bellA[axis]).toBeCloseTo(bellB[axis], 10);
        expect(metalA[axis]).toBeCloseTo(metalB[axis], 10);
      }
    }
  });

  it('welds chrome normals at the periodic seam and both pole duplicates', () => {
    const bank = new OrganicPresets();
    for (const quality of ['low', 'medium', 'high'] as const) {
      bank.update(frame(8), quality, 1);
      const metallic = bank.group.children[3].children.find(object => object.visible && object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh)) as THREE.Mesh;
      const normal = metallic.geometry.getAttribute('normal');
      const u = quality === 'low' ? 40 : quality === 'medium' ? 80 : 112;
      const v = quality === 'low' ? 20 : quality === 'medium' ? 40 : 56;
      for (let row = 0; row <= v; row++) {
        const a = row * (u + 1), b = a + u;
        expect(normal.getX(a)).toBeCloseTo(normal.getX(b), 6);
        expect(normal.getY(a)).toBeCloseTo(normal.getY(b), 6);
        expect(normal.getZ(a)).toBeCloseTo(normal.getZ(b), 6);
      }
      for (const row of [0, v]) for (let column = 1; column <= u; column++) {
        const a = row * (u + 1), b = a + column;
        expect(normal.getX(a)).toBeCloseTo(normal.getX(b), 6);
        expect(normal.getY(a)).toBeCloseTo(normal.getY(b), 6);
        expect(normal.getZ(a)).toBeCloseTo(normal.getZ(b), 6);
      }
    }
  });

  it('points each bird along its flight tangent and animates actual wing articulation', () => {
    const input = frame(9); input.state.controls.distortion = 0; input.state.controls.glitch = 0;
    for (const id of [0, 7, 37, 199]) {
      const pose = sampleBird(input, id, bird()), next = sampleBird(input, id, bird(), input.phase + .001);
      const dx = next.x - pose.x, dz = next.z - pose.z;
      expect(-Math.sin(pose.heading) * dx - Math.cos(pose.heading) * dz).toBeGreaterThan(0);
      expect(next.flap).not.toBe(pose.flap);
    }
  });

  it('keeps the medium quality geometry budget below 15000 active vertices per scene', () => {
    const bank = new OrganicPresets();
    for (let scene = 5; scene <= 9; scene++) {
      const input = frame(scene); input.state.controls.density = 1; bank.update(input, 'medium', 1);
      let vertices = 0, calls = 0;
      bank.group.traverseVisible(object => {
        const renderable = object as THREE.Mesh;
        if (!renderable.geometry) return;
        calls++;
        const geometry = renderable.geometry;
        if (object instanceof THREE.InstancedMesh) vertices += object.count * geometry.getAttribute('position').count;
        else if (object instanceof THREE.Sprite) vertices += object.count * 4;
        else if (geometry.index) vertices += new Set(Array.from(geometry.index.array).slice(0, geometry.drawRange.count)).size;
        else vertices += Math.min(geometry.getAttribute('position').count, geometry.drawRange.count);
      });
      expect(vertices, `scene ${scene}`).toBeLessThanOrEqual(15000);
      expect(calls, `scene ${scene}`).toBeLessThanOrEqual(20);
    }
  });
});

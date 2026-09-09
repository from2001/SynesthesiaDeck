import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { initialState, SCENES, syntheticAudio } from '../shared/protocol';
import { OrganicPresets } from '../web/visuals/organic-presets';
import { ArchitecturalPresets } from '../web/visuals/architectural-presets';
import { visualFrame } from '../web/visuals/math';
import type { Quality } from '../web/visuals/parameters';

function resources(group: THREE.Group) {
  const result = new Set<THREE.BufferGeometry | THREE.Material>();
  group.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) result.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) result.add(material);
  });
  return result;
}

function visibleGeometry(group: THREE.Group) {
  let count = 0;
  group.traverseVisible(object => { if ((object as THREE.Mesh).geometry) count++; });
  return count;
}

describe('experimental bank integration', () => {
  it('switches between both banks and back to the original bank without retaining visible geometry', () => {
    const organic = new OrganicPresets(), architectural = new ArchitecturalPresets();
    const state = initialState('library'); state.running = true;
    for (const scene of [5, 14, 9, 10, 6, 11, 7, 12, 8, 13, 0]) {
      state.scene = scene;
      const frame = visualFrame(state, syntheticAudio(3500), 3500);
      organic.update(frame, 'medium', .7); architectural.update(frame, 'medium', .7);
      expect(visibleGeometry(organic.group) > 0).toBe(scene >= 5 && scene < 10);
      expect(visibleGeometry(architectural.group) > 0).toBe(scene >= 10);
    }
  });

  it('reuses geometry and materials across scene, seed and quality changes without mutating shared state', () => {
    const banks = [new OrganicPresets(), new ArchitecturalPresets()];
    const before = banks.map(bank => resources(bank.group));
    for (let scene = 5; scene < SCENES.length; scene++) {
      for (const quality of ['low', 'medium', 'high'] as Quality[]) {
        const state = { ...initialState('library', 0, scene * 371), scene, running: true };
        const unchanged = structuredClone(state);
        const frame = visualFrame(state, syntheticAudio(34000), 34000);
        for (const bank of banks) bank.update(frame, quality, .7);
        expect(state).toEqual(unchanged);
      }
    }
    banks.forEach((bank, index) => {
      expect(resources(bank.group)).toEqual(before[index]);
      before[index].forEach(resource => resource.dispose());
    });
  });
});

import * as THREE from 'three/webgpu';
import { initialState, SILENCE, type AudioFeatures } from '../shared/protocol';
import { visualFrame, type VisualFrame } from '../web/visuals/math';
import type { SpriteBatch } from '../web/visuals/dynamic-geometry';

/** Shared helpers for the Echo, Laser and Uncharted bank tests. */
export interface Bank { group: THREE.Group; sprites: SpriteBatch[]; update(frame: VisualFrame, quality: 'low' | 'medium' | 'high', gain: number): void }
export const LIVE_AUDIO: AudioFeatures = { ...SILENCE, level: .4, bass: .35, lowMid: .3, mid: .25, high: .3, beat: .2 };

export function bankFrame(scene: number, phase = 5, seed = 48291, audio: AudioFeatures = LIVE_AUDIO): VisualFrame {
  const state = initialState('bank-test', 0, seed);
  state.scene = scene; state.running = true;
  state.motion = { at: 0, rate: 1, phase: 0 };
  return visualFrame(state, audio, phase * 1000);
}

/** Hash only rendered vertices, live instances and live sprites, excluding unused preallocation. */
export function signature(bank: Bank, world: THREE.Object3D): number {
  let hash = 2166136261;
  const add = (value: number) => { hash = Math.imul(hash ^ Math.round(value * 100000), 16777619); };
  world.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    if (object instanceof THREE.InstancedMesh) {
      add(object.count);
      for (let i = 0; i < object.count * 16; i++) add(object.instanceMatrix.array[i]);
      for (let i = 0; i < object.count * 3; i++) add(object.instanceColor!.array[i]);
    } else if (object instanceof THREE.Sprite) {
      const batch = bank.sprites.find(candidate => candidate.sprite === object);
      if (!batch) throw new Error('Every dynamic sprite must be registered in bank.sprites.');
      add(object.visible ? batch.count : 0);
      if (!object.visible) return;
      for (let i = 0; i < batch.count * 3; i++) { add(batch.positions.array[i]); add(batch.colors.array[i]); }
      for (let i = 0; i < batch.count; i++) add(batch.sizes.array[i]);
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

/** Draw calls and active vertices for one world at the current state. */
export function budget(bank: Bank, world: THREE.Object3D): { draws: number; vertices: number } {
  let draws = 0, vertices = 0;
  world.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    draws++;
    if (object instanceof THREE.InstancedMesh) vertices += object.geometry.getAttribute('position').count * object.count;
    else if (object instanceof THREE.Sprite) vertices += (bank.sprites.find(candidate => candidate.sprite === object)?.count ?? 0) * 4;
    else if (mesh.geometry.index) {
      const used = new Set<number>();
      for (let index = 0; index < mesh.geometry.drawRange.count; index++) used.add(mesh.geometry.index.getX(index));
      vertices += used.size;
    } else vertices += mesh.geometry.drawRange.count;
  });
  return { draws, vertices };
}

export function expectFinite(bank: Bank, world: THREE.Object3D): boolean {
  let finite = true;
  world.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    if (object instanceof THREE.InstancedMesh) { for (let i = 0; i < object.count * 16; i++) if (!Number.isFinite(object.instanceMatrix.array[i])) finite = false; }
    else if (object instanceof THREE.Sprite) {
      const batch = bank.sprites.find(candidate => candidate.sprite === object)!;
      for (let i = 0; i < batch.count * 3; i++) if (!Number.isFinite(batch.positions.array[i]) || !Number.isFinite(batch.colors.array[i])) finite = false;
    } else {
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < mesh.geometry.drawRange.count && i < positions.count; i++) {
        const index = mesh.geometry.index ? mesh.geometry.index.getX(i) : i;
        if (![positions.getX(index), positions.getY(index), positions.getZ(index)].every(Number.isFinite)) finite = false;
      }
    }
  });
  return finite;
}

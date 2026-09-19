import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { seeded } from '../../shared/protocol';
import type { VisualFrame } from './math';
import type { Quality } from './parameters';
import { organicHue, sampleBell, sampleBird, sampleBranch, samplePetal, sampleSilk, sampleSpore, sampleTendril,
  type BirdSample, type BranchSample, type OrganicSample } from './organic-math';

export const ORGANIC_QUALITY = {
  low: { ribbons: 3, colonies: 2, jellyfish: 3, birds: 90, spores: 70, flowers: 3, petalU: 12, petalV: 4, tendrilSegments: 12 },
  medium: { ribbons: 6, colonies: 5, jellyfish: 5, birds: 240, spores: 180, flowers: 4, petalU: 18, petalV: 6, tendrilSegments: 16 },
  high: { ribbons: 10, colonies: 7, jellyfish: 7, birds: 450, spores: 300, flowers: 6, petalU: 24, petalV: 8, tendrilSegments: 24 },
} as const;
const QUALITY_NAMES: readonly Quality[] = ['low', 'medium', 'high'];
const SILK_U = 96, SILK_V = 12, BELL_U = 32, BELL_V = 12, TENDRIL_SIDES = 6;
const BRANCHES = 63, LEAF_START = 31, BIRD_VERTICES = 11, BIRD_TRAIL_SEGMENTS = 8;
const UP = new THREE.Vector3(0, 1, 0);

interface GeometryBuffer { geometry: THREE.BufferGeometry; positions: THREE.BufferAttribute; colors: THREE.BufferAttribute; normals: THREE.BufferAttribute }
interface Surface extends GeometryBuffer { u: number; v: number; verticesPerItem: number; indicesPerItem: number }

function buffers(vertices: number): GeometryBuffer {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const normals = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions); geometry.setAttribute('color', colors); geometry.setAttribute('normal', normals);
  return { geometry, positions, colors, normals };
}

function surface(items: number, u: number, v: number): Surface {
  const verticesPerItem = (u + 1) * (v + 1), indicesPerItem = u * v * 6;
  const result = buffers(items * verticesPerItem);
  const index = new Uint32Array(items * indicesPerItem);
  let cursor = 0;
  for (let item = 0; item < items; item++) for (let y = 0; y < v; y++) for (let x = 0; x < u; x++) {
    const a = item * verticesPerItem + y * (u + 1) + x, b = a + u + 1;
    index[cursor++] = a; index[cursor++] = b; index[cursor++] = a + 1;
    index[cursor++] = b; index[cursor++] = b + 1; index[cursor++] = a + 1;
  }
  result.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return { ...result, u, v, verticesPerItem, indicesPerItem };
}

function colorAt(attribute: THREE.BufferAttribute, index: number, hue: number, saturation: number, value: number): void {
  const h = (((hue % 1) + 1) % 1) * 6;
  const r = Math.max(0, Math.min(1, Math.abs(h - 3) - 1));
  const g = Math.max(0, Math.min(1, 2 - Math.abs(h - 2)));
  const b = Math.max(0, Math.min(1, 2 - Math.abs(h - 4)));
  attribute.setXYZ(index, value * (1 - saturation + saturation * r), value * (1 - saturation + saturation * g), value * (1 - saturation + saturation * b));
}

function mesh(buffer: GeometryBuffer, material: THREE.Material): THREE.Mesh {
  const result = new THREE.Mesh(buffer.geometry, material); result.frustumCulled = false; return result;
}
function lines(buffer: GeometryBuffer, material: THREE.Material): THREE.LineSegments {
  const result = new THREE.LineSegments(buffer.geometry, material); result.frustumCulled = false; return result;
}
function finish(buffer: GeometryBuffer, count: number): void {
  buffer.geometry.setDrawRange(0, count); buffer.positions.needsUpdate = true; buffer.colors.needsUpdate = true;
}
function activeCount(maximum: number, density: number): number { return Math.max(1, Math.round(maximum * (.3 + .7 * density))); }

/** Organic surfaces and organisms share the authoritative phase but not their visual vocabulary. */
export class OrganicPresets {
  readonly group = new THREE.Group();
  private scenes = Array.from({ length: 5 }, () => new THREE.Group());
  private point: OrganicSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1 };
  private branch: BranchSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1, startX: 0, startY: 0, startZ: 0, radius: 0, depth: 0 };
  private bird: BirdSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1, heading: 0, bank: 0, flap: 0, span: 0 };
  private trailBird: BirdSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1, heading: 0, bank: 0, flap: 0, span: 0 };
  private dummy = new THREE.Object3D();
  private direction = new THREE.Vector3();
  private color = new THREE.Color();

  private silk = surface(10, SILK_U, SILK_V);
  private silkEdges = buffers(10 * SILK_U * 4);
  private silkMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .28, depthWrite: false });
  private silkLineMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .72, depthWrite: false });

  private stemsMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  private canopyMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  private stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(.36, 1, 1, 5, 1, true), this.stemsMaterial, 7 * BRANCHES);
  private canopies = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2), this.canopyMaterial, 7 * 32);
  private sporePositions = new THREE.InstancedBufferAttribute(new Float32Array(300 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private sporeColors = new THREE.InstancedBufferAttribute(new Float32Array(300 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private sporeGain = uniform(1);
  private spores: THREE.Sprite;

  private bells = surface(7, BELL_U, BELL_V);
  private tentacles = QUALITY_NAMES.map(quality => surface(ORGANIC_QUALITY[quality].jellyfish * 18, TENDRIL_SIDES, ORGANIC_QUALITY[quality].tendrilSegments));
  private tentacleMeshes: THREE.Mesh[] = [];
  private before: OrganicSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1 };
  private after: OrganicSample = { x: 0, y: 0, z: 0, hue: 0, glow: 1 };
  private tangent = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private binormal = new THREE.Vector3();
  private bellVeins = buffers(7 * (8 * BELL_V + BELL_U) * 2);
  private bellMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .3, depthWrite: false });
  private tentacleMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private veinMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .58, depthWrite: false });

  private petals = QUALITY_NAMES.map(quality => surface(ORGANIC_QUALITY[quality].flowers * 16, ORGANIC_QUALITY[quality].petalU, ORGANIC_QUALITY[quality].petalV));
  private petalMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private petalMeshes: THREE.Mesh[] = [];

  private birds = buffers(450 * BIRD_VERTICES);
  private birdTrails = buffers(450 * BIRD_TRAIL_SEGMENTS * 2);
  private birdMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private trailMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .7, depthWrite: false });
  private wingX = new Float32Array([0, -.15, .15, 0, -.5, -1.2, -.43, 0, .5, 1.2, .43]);
  private wingZ = new Float32Array([-.55, .38, .38, -.15, -.18, .18, .55, -.15, -.18, .18, .55]);

  constructor() {
    this.group.name = 'Organic procedural presets';
    const names = ['TIDAL SILK', 'MYCELIUM CHOIR', 'ABYSSAL BLOOM', 'LUMEN GARDEN', 'EMBER MIGRATION'];
    this.scenes.forEach((scene, index) => { scene.name = names[index]; scene.visible = false; this.group.add(scene); });
    this.group.visible = false;
    this.scenes[0].add(mesh(this.silk, this.silkMaterial), lines(this.silkEdges, this.silkLineMaterial));

    this.stems.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.canopies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.stems.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(7 * BRANCHES * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.canopies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(7 * 32 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.stems.frustumCulled = false; this.canopies.frustumCulled = false;
    const sporeMaterial = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    sporeMaterial.positionNode = instancedBufferAttribute(this.sporePositions);
    sporeMaterial.colorNode = vec3(instancedBufferAttribute(this.sporeColors)).mul(this.sporeGain);
    sporeMaterial.sizeNode = uniform(.035);
    sporeMaterial.opacityNode = float(1).sub(smoothstep(.08, .5, uv().sub(.5).length()));
    this.spores = new THREE.Sprite(sporeMaterial); this.spores.frustumCulled = false;
    this.scenes[1].add(this.stems, this.canopies, this.spores);

    this.tentacleMeshes = this.tentacles.map(buffer => mesh(buffer, this.tentacleMaterial));
    this.tentacleMeshes.forEach(tube => { tube.name = 'Volumetric jellyfish tendrils'; });
    this.scenes[2].add(mesh(this.bells, this.bellMaterial), ...this.tentacleMeshes, lines(this.bellVeins, this.veinMaterial));

    this.petalMeshes = this.petals.map(buffer => mesh(buffer, this.petalMaterial));
    this.scenes[3].add(...this.petalMeshes);

    const birdIndex = new Uint16Array(450 * 15);
    for (let bird = 0; bird < 450; bird++) {
      const base = bird * BIRD_VERTICES, offset = bird * 15;
      const local = [0, 1, 2, 3, 4, 5, 3, 5, 6, 7, 9, 8, 7, 10, 9];
      for (let index = 0; index < 15; index++) birdIndex[offset + index] = base + local[index];
    }
    this.birds.geometry.setIndex(new THREE.BufferAttribute(birdIndex, 1));
    this.scenes[4].add(mesh(this.birds, this.birdMaterial), lines(this.birdTrails, this.trailMaterial));
  }

  update(frame: VisualFrame, quality: Quality, gain: number): void {
    const index = frame.state.scene - 5;
    this.group.visible = index >= 0 && index < 5 && frame.state.running && gain > 0;
    for (let scene = 0; scene < 5; scene++) this.scenes[scene].visible = scene === index && this.group.visible;
    if (!this.group.visible) return;
    if (index === 0) this.updateSilk(frame, quality, gain);
    else if (index === 1) this.updateMycelium(frame, quality, gain);
    else if (index === 2) this.updateJellyfish(frame, quality, gain);
    else if (index === 3) this.updateGarden(frame, quality, gain);
    else this.updateBirds(frame, quality, gain);
  }

  private updateSilk(frame: VisualFrame, quality: Quality, gain: number): void {
    const count = activeCount(ORGANIC_QUALITY[quality].ribbons, frame.state.controls.density);
    this.silkMaterial.color.setScalar(gain * 1.35); this.silkLineMaterial.color.setScalar(gain * 1.9);
    let vertex = 0, edge = 0;
    for (let ribbon = 0; ribbon < count; ribbon++) {
      for (let v = 0; v <= SILK_V; v++) for (let u = 0; u <= SILK_U; u++) {
        sampleSilk(frame, ribbon, u / SILK_U, v / SILK_V, this.point);
        this.silk.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z);
        const border = .65 + Math.abs(v / SILK_V - .5) * .7;
        colorAt(this.silk.colors, vertex++, this.point.hue, .74, this.point.glow * border);
      }
      for (let side = 0; side < 2; side++) for (let u = 0; u < SILK_U; u++) for (let endpoint = 0; endpoint < 2; endpoint++) {
        sampleSilk(frame, ribbon, (u + endpoint) / SILK_U, side, this.point);
        this.silkEdges.positions.setXYZ(edge, this.point.x, this.point.y, this.point.z);
        colorAt(this.silkEdges.colors, edge++, this.point.hue, .65, .8 + this.point.glow * .4);
      }
    }
    finish(this.silk, count * this.silk.indicesPerItem); finish(this.silkEdges, edge);
  }

  private updateMycelium(frame: VisualFrame, quality: Quality, gain: number): void {
    const p = frame.state.sceneParams, count = activeCount(ORGANIC_QUALITY[quality].colonies, frame.state.controls.density);
    this.stemsMaterial.color.setScalar(gain * 1.65); this.canopyMaterial.color.setScalar(gain * 1.35);
    let stemIndex = 0, capIndex = 0;
    for (let colony = 0; colony < count; colony++) for (let branch = 0; branch < BRANCHES; branch++) {
      const stem = sampleBranch(frame, colony, branch, this.branch);
      this.direction.set(stem.x - stem.startX, stem.y - stem.startY, stem.z - stem.startZ);
      const length = this.direction.length();
      this.dummy.position.set((stem.x + stem.startX) * .5, (stem.y + stem.startY) * .5, (stem.z + stem.startZ) * .5);
      this.dummy.quaternion.setFromUnitVectors(UP, this.direction.normalize());
      this.dummy.scale.set(stem.radius, length, stem.radius); this.dummy.updateMatrix();
      this.stems.setMatrixAt(stemIndex, this.dummy.matrix);
      this.color.setHSL(stem.hue, .62, .35 + stem.depth * .035).multiplyScalar(stem.glow); this.stems.setColorAt(stemIndex++, this.color);
      if (branch >= LEAF_START) {
        const capRadius = (.055 + p[6] * .09) * (1 + frame.audio.beat * .12);
        this.dummy.position.set(stem.x, stem.y, stem.z); this.dummy.quaternion.identity();
        this.dummy.scale.set(capRadius, capRadius * (.45 + p[2] * .3), capRadius); this.dummy.updateMatrix();
        this.canopies.setMatrixAt(capIndex, this.dummy.matrix);
        this.color.setHSL((stem.hue + .075) % 1, .6, .58); this.canopies.setColorAt(capIndex++, this.color);
      }
    }
    this.stems.count = stemIndex; this.canopies.count = capIndex;
    this.stems.instanceMatrix.needsUpdate = true; this.canopies.instanceMatrix.needsUpdate = true;
    if (this.stems.instanceColor) this.stems.instanceColor.needsUpdate = true;
    if (this.canopies.instanceColor) this.canopies.instanceColor.needsUpdate = true;
    this.spores.count = activeCount(ORGANIC_QUALITY[quality].spores, frame.state.controls.density); this.sporeGain.value = gain * 2;
    for (let i = 0; i < this.spores.count; i++) {
      sampleSpore(frame, i, this.point); this.sporePositions.setXYZ(i, this.point.x, this.point.y, this.point.z);
      colorAt(this.sporeColors, i, this.point.hue, .5, this.point.glow);
    }
    this.sporePositions.needsUpdate = true; this.sporeColors.needsUpdate = true;
  }

  private updateJellyfish(frame: VisualFrame, quality: Quality, gain: number): void {
    const count = activeCount(ORGANIC_QUALITY[quality].jellyfish, frame.state.controls.density);
    const tendrils = 6 + Math.floor(frame.state.sceneParams[3] * 12);
    this.bellMaterial.color.setScalar(gain * 1.4); this.tentacleMaterial.color.setScalar(gain * 2); this.veinMaterial.color.setScalar(gain * 1.55);
    const active = QUALITY_NAMES.indexOf(quality), tubes = this.tentacles[active];
    this.tentacleMeshes.forEach((tube, index) => { tube.visible = index === active; });
    let vertex = 0, tubeVertex = 0, vein = 0;
    for (let jelly = 0; jelly < count; jelly++) {
      for (let v = 0; v <= BELL_V; v++) for (let u = 0; u <= BELL_U; u++) {
        sampleBell(frame, jelly, u / BELL_U, v / BELL_V, this.point);
        this.bells.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z);
        colorAt(this.bells.colors, vertex++, this.point.hue, .57, this.point.glow);
      }
      // A closed hexagonal cross-section stays visible from either eye and every viewing angle.
      for (let tendril = 0; tendril < tendrils; tendril++) for (let segment = 0; segment <= tubes.v; segment++) {
        const u = segment / tubes.v;
        sampleTendril(frame, jelly, tendril, u, this.point);
        sampleTendril(frame, jelly, tendril, Math.max(0, u - .001), this.before);
        sampleTendril(frame, jelly, tendril, Math.min(1, u + .001), this.after);
        this.tangent.set(this.after.x - this.before.x, this.after.y - this.before.y, this.after.z - this.before.z).normalize();
        this.normal.set(1, 0, 0).addScaledVector(this.tangent, -this.tangent.x);
        if (this.normal.lengthSq() < .001) this.normal.set(0, 0, 1).addScaledVector(this.tangent, -this.tangent.z);
        this.normal.normalize(); this.binormal.crossVectors(this.tangent, this.normal).normalize();
        const radius = (.025 + frame.state.sceneParams[6] * .025) * (1 - u * .8) * (1 + Math.sin(u * 18 - frame.phase + tendril) * .12);
        for (let side = 0; side <= TENDRIL_SIDES; side++) {
          const angle = side / TENDRIL_SIDES * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
          tubes.positions.setXYZ(tubeVertex,
            this.point.x + radius * (this.normal.x * c + this.binormal.x * s),
            this.point.y + radius * (this.normal.y * c + this.binormal.y * s),
            this.point.z + radius * (this.normal.z * c + this.binormal.z * s));
          colorAt(tubes.colors, tubeVertex++, this.point.hue, .54, this.point.glow * (.65 + .35 * Math.cos(angle - .7)));
        }
      }
      for (let rib = 0; rib < 8; rib++) for (let segment = 0; segment < BELL_V; segment++) for (let endpoint = 0; endpoint < 2; endpoint++) {
        sampleBell(frame, jelly, rib / 8, (segment + endpoint) / BELL_V, this.point);
        this.bellVeins.positions.setXYZ(vein, this.point.x, this.point.y, this.point.z);
        colorAt(this.bellVeins.colors, vein++, this.point.hue, .42, .9);
      }
      for (let segment = 0; segment < BELL_U; segment++) for (let endpoint = 0; endpoint < 2; endpoint++) {
        sampleBell(frame, jelly, (segment + endpoint) / BELL_U, 1, this.point);
        this.bellVeins.positions.setXYZ(vein, this.point.x, this.point.y, this.point.z);
        colorAt(this.bellVeins.colors, vein++, this.point.hue, .42, 1.25);
      }
    }
    finish(this.bells, count * this.bells.indicesPerItem); finish(tubes, count * tendrils * tubes.indicesPerItem); finish(this.bellVeins, vein);
  }

  private updateGarden(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = QUALITY_NAMES.indexOf(quality), buffer = this.petals[active];
    this.petalMeshes.forEach((petals, index) => { petals.visible = index === active; });
    this.petalMaterial.color.setScalar(gain * 1.1);
    const count = activeCount(ORGANIC_QUALITY[quality].flowers, frame.state.controls.density) * 16;
    let vertex = 0;
    for (let petal = 0; petal < count; petal++) for (let v = 0; v <= buffer.v; v++) for (let u = 0; u <= buffer.u; u++) {
      samplePetal(frame, petal, u / buffer.u, v / buffer.v, this.point);
      buffer.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z);
      colorAt(buffer.colors, vertex++, this.point.hue, .85, this.point.glow);
    }
    finish(buffer, count * buffer.indicesPerItem);
  }

  private updateBirds(frame: VisualFrame, quality: Quality, gain: number): void {
    const count = activeCount(ORGANIC_QUALITY[quality].birds, frame.state.controls.density), p = frame.state.sceneParams;
    this.birdMaterial.color.setScalar(gain * 1.75); this.trailMaterial.color.setScalar(gain * 1.6);
    let vertex = 0, line = 0;
    for (let i = 0; i < count; i++) {
      const bird = sampleBird(frame, i, this.bird);
      const ch = Math.cos(bird.heading), sh = Math.sin(bird.heading), cb = Math.cos(bird.bank), sb = Math.sin(bird.bank);
      for (let corner = 0; corner < BIRD_VERTICES; corner++) {
        const localX = this.wingX[corner] * bird.span, localZ = this.wingZ[corner] * bird.span;
        const flapY = corner < 3 ? 0 : Math.abs(this.wingX[corner]) * bird.flap * bird.span;
        const x = localX * cb - flapY * sb, y = localX * sb + flapY * cb;
        this.birds.positions.setXYZ(vertex, bird.x + x * ch + localZ * sh, bird.y + y, bird.z - x * sh + localZ * ch);
        colorAt(this.birds.colors, vertex++, bird.hue, .82, corner < 3 ? .4 : (.7 + Math.abs(this.wingX[corner]) * .55) * bird.glow);
      }
      for (let segment = 0; segment < BIRD_TRAIL_SEGMENTS; segment++) for (let endpoint = 0; endpoint < 2; endpoint++) {
        const u = (segment + endpoint) / BIRD_TRAIL_SEGMENTS;
        sampleBird(frame, i, this.trailBird, frame.phase - u * (.2 + p[7] * 2));
        this.birdTrails.positions.setXYZ(line, this.trailBird.x, this.trailBird.y, this.trailBird.z);
        colorAt(this.birdTrails.colors, line++, bird.hue, .9, Math.pow(1 - u, 2) * (.3 + p[7] * .45));
      }
    }
    finish(this.birds, count * 15); finish(this.birdTrails, line);
  }
}

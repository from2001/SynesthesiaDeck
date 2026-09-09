import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, normalView, positionViewDirection, reflectVector, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { seeded } from '../../shared/protocol';
import type { VisualFrame } from './math';
import type { Quality } from './parameters';
import { organicHue, sampleBell, sampleBird, sampleBranch, sampleMercury, sampleSilk, sampleSpore, sampleTendril,
  type BirdSample, type BranchSample, type OrganicSample } from './organic-math';

export const ORGANIC_QUALITY = {
  low: { ribbons: 3, colonies: 2, jellyfish: 3, birds: 90, spores: 70, mercuryU: 40, mercuryV: 20 },
  medium: { ribbons: 6, colonies: 5, jellyfish: 5, birds: 240, spores: 180, mercuryU: 80, mercuryV: 40 },
  high: { ribbons: 10, colonies: 7, jellyfish: 7, birds: 450, spores: 300, mercuryU: 112, mercuryV: 56 },
} as const;
const QUALITY_NAMES: readonly Quality[] = ['low', 'medium', 'high'];
const SILK_U = 96, SILK_V = 12, BELL_U = 32, BELL_V = 12, TENDRIL_SEGMENTS = 36;
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

/** Update smooth normals in existing buffers without allocating per-frame vectors. */
function updateNormals(buffer: GeometryBuffer, vertices: number, indices: number): void {
  const p = buffer.positions.array as Float32Array, n = buffer.normals.array as Float32Array;
  const triangles = buffer.geometry.index!.array;
  n.fill(0, 0, vertices * 3);
  for (let i = 0; i < indices; i += 3) {
    const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    const x = aby * acz - abz * acy, y = abz * acx - abx * acz, z = abx * acy - aby * acx;
    n[a] += x; n[a + 1] += y; n[a + 2] += z;
    n[b] += x; n[b + 1] += y; n[b + 2] += z;
    n[c] += x; n[c + 1] += y; n[c + 2] += z;
  }
  for (let i = 0; i < vertices * 3; i += 3) {
    const length = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (length > 1e-8) { n[i] /= length; n[i + 1] /= length; n[i + 2] /= length; }
    else { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
  }
  buffer.normals.needsUpdate = true;
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
  private tentacles = buffers(7 * 18 * TENDRIL_SEGMENTS * 2);
  private bellVeins = buffers(7 * (8 * BELL_V + BELL_U) * 2);
  private bellMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .3, depthWrite: false });
  private tentacleMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .82, depthWrite: false });
  private veinMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .58, depthWrite: false });

  private mercury = QUALITY_NAMES.map(quality => surface(1, ORGANIC_QUALITY[quality].mercuryU, ORGANIC_QUALITY[quality].mercuryV));
  private mercuryGain = uniform(1);
  private mercurySheen = uniform(.2);
  private mercuryTint = uniform(new THREE.Color('#bbdce5'));
  private mercuryMaterial = new THREE.MeshPhysicalNodeMaterial({ metalness: .97, roughness: .2, clearcoat: .8, clearcoatRoughness: .08, side: THREE.DoubleSide });
  private mercuryMeshes: THREE.Mesh[] = [];
  private droplets = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), this.mercuryMaterial, 14);

  private birds = buffers(450 * BIRD_VERTICES);
  private birdTrails = buffers(450 * BIRD_TRAIL_SEGMENTS * 2);
  private birdMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private trailMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .7, depthWrite: false });
  private wingX = new Float32Array([0, -.15, .15, 0, -.5, -1.2, -.43, 0, .5, 1.2, .43]);
  private wingZ = new Float32Array([-.55, .38, .38, -.15, -.18, .18, .55, -.15, -.18, .18, .55]);

  constructor() {
    this.group.name = 'Organic procedural presets';
    const names = ['TIDAL SILK', 'MYCELIUM CHOIR', 'ABYSSAL BLOOM', 'LIQUID MERCURY', 'EMBER MIGRATION'];
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

    this.scenes[2].add(mesh(this.bells, this.bellMaterial), lines(this.tentacles, this.tentacleMaterial), lines(this.bellVeins, this.veinMaterial));

    // Procedural reflected illumination supplies a chrome environment without a texture download.
    const sky = smoothstep(-.22, .35, reflectVector.y);
    const reflectedBands = smoothstep(.9, .995, sin(reflectVector.y.mul(9).add(reflectVector.x.mul(4))).abs());
    const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(3);
    this.mercuryMaterial.colorNode = this.mercuryTint;
    this.mercuryMaterial.roughnessNode = this.mercurySheen;
    this.mercuryMaterial.envNode = vec3(.025, .04, .06).add(vec3(.12, .2, .28).mul(sky)).add(vec3(1.8, 1.7, 1.55).mul(reflectedBands)).mul(this.mercuryGain);
    this.mercuryMaterial.emissiveNode = this.mercuryTint.mul(fresnel.mul(.14).add(.015)).mul(this.mercuryGain);
    this.mercuryMeshes = this.mercury.map(buffer => mesh(buffer, this.mercuryMaterial));
    this.droplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.droplets.frustumCulled = false;
    this.scenes[3].add(...this.mercuryMeshes, this.droplets);

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
    this.group.visible = index >= 0 && index < 5;
    for (let scene = 0; scene < 5; scene++) this.scenes[scene].visible = scene === index;
    if (!this.group.visible) return;
    if (index === 0) this.updateSilk(frame, quality, gain);
    else if (index === 1) this.updateMycelium(frame, quality, gain);
    else if (index === 2) this.updateJellyfish(frame, quality, gain);
    else if (index === 3) this.updateMercury(frame, quality, gain);
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
    let vertex = 0, line = 0, vein = 0;
    for (let jelly = 0; jelly < count; jelly++) {
      for (let v = 0; v <= BELL_V; v++) for (let u = 0; u <= BELL_U; u++) {
        sampleBell(frame, jelly, u / BELL_U, v / BELL_V, this.point);
        this.bells.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z);
        colorAt(this.bells.colors, vertex++, this.point.hue, .57, this.point.glow);
      }
      for (let tendril = 0; tendril < tendrils; tendril++) for (let segment = 0; segment < TENDRIL_SEGMENTS; segment++) for (let endpoint = 0; endpoint < 2; endpoint++) {
        sampleTendril(frame, jelly, tendril, (segment + endpoint) / TENDRIL_SEGMENTS, this.point);
        this.tentacles.positions.setXYZ(line, this.point.x, this.point.y, this.point.z);
        colorAt(this.tentacles.colors, line++, this.point.hue, .61, this.point.glow);
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
    finish(this.bells, count * this.bells.indicesPerItem); finish(this.tentacles, line); finish(this.bellVeins, vein);
  }

  private updateMercury(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = QUALITY_NAMES.indexOf(quality), buffer = this.mercury[active], p = frame.state.sceneParams;
    for (let i = 0; i < this.mercuryMeshes.length; i++) this.mercuryMeshes[i].visible = i === active;
    this.mercuryGain.value = gain * (.35 + p[7] * .9);
    this.mercurySheen.value = .08 + (1 - p[7]) * .45;
    this.mercuryTint.value.setHSL(organicHue(frame, 8, 0), .14, .7);
    let vertex = 0;
    for (let v = 0; v <= buffer.v; v++) for (let u = 0; u <= buffer.u; u++) {
      sampleMercury(frame, 0, u / buffer.u, v / buffer.v, this.point);
      buffer.positions.setXYZ(vertex++, this.point.x, this.point.y, this.point.z);
    }
    buffer.geometry.setDrawRange(0, buffer.indicesPerItem); buffer.positions.needsUpdate = true;
    updateNormals(buffer, buffer.verticesPerItem, buffer.indicesPerItem);
    // Average the periodic seam so the reflective surface does not reveal its UV boundary.
    for (let row = 0; row <= buffer.v; row++) {
      const a = row * (buffer.u + 1), b = a + buffer.u;
      this.direction.set(buffer.normals.getX(a) + buffer.normals.getX(b), buffer.normals.getY(a) + buffer.normals.getY(b), buffer.normals.getZ(a) + buffer.normals.getZ(b)).normalize();
      buffer.normals.setXYZ(a, this.direction.x, this.direction.y, this.direction.z);
      buffer.normals.setXYZ(b, this.direction.x, this.direction.y, this.direction.z);
    }
    for (let pole = 0; pole < 2; pole++) {
      const base = pole * buffer.v * (buffer.u + 1);
      this.direction.set(0, 0, 0);
      for (let column = 0; column <= buffer.u; column++) {
        const index = base + column;
        this.direction.x += buffer.normals.getX(index); this.direction.y += buffer.normals.getY(index); this.direction.z += buffer.normals.getZ(index);
      }
      this.direction.normalize();
      for (let column = 0; column <= buffer.u; column++) buffer.normals.setXYZ(base + column, this.direction.x, this.direction.y, this.direction.z);
    }
    this.droplets.count = activeCount(quality === 'low' ? 5 : quality === 'medium' ? 9 : 14, frame.state.controls.density);
    for (let i = 0; i < this.droplets.count; i++) {
      sampleMercury(frame, i + 1, .25, .5, this.point);
      const radius = (.11 + seeded(frame.state.seed, i + 733) * .16) * (.7 + p[0] * .5);
      this.dummy.position.set(this.point.x, this.point.y, this.point.z); this.dummy.quaternion.identity();
      this.dummy.scale.set(radius, radius * (1 + Math.sin(frame.phase + i) * p[2] * .15), radius);
      this.dummy.updateMatrix(); this.droplets.setMatrixAt(i, this.dummy.matrix);
    }
    this.droplets.instanceMatrix.needsUpdate = true;
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

import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, normalView, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import type { Point3 } from './math';

/** Fixed-capacity dynamic buffers shared by every procedural bank. Nothing here allocates per frame. */
export interface GeometryBuffer { geometry: THREE.BufferGeometry; positions: THREE.BufferAttribute; colors: THREE.BufferAttribute; normals: THREE.BufferAttribute }
export interface Surface extends GeometryBuffer { u: number; v: number; verticesPerItem: number; indicesPerItem: number }
const UP = new THREE.Vector3(0, 1, 0);

export function buffers(vertices: number): GeometryBuffer {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const normals = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions); geometry.setAttribute('color', colors); geometry.setAttribute('normal', normals);
  geometry.setDrawRange(0, 0);
  return { geometry, positions, colors, normals };
}

/** Indexed (u + 1) × (v + 1) grids for `items` independent surfaces inside one draw call. */
export function surface(items: number, u: number, v: number): Surface {
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

/** Independent quads (two triangles each) inside one indexed draw call. */
export function quads(count: number): GeometryBuffer {
  const result = buffers(count * 4);
  const index = new Uint32Array(count * 6);
  for (let quad = 0; quad < count; quad++) {
    const offset = quad * 4;
    index.set([offset, offset + 1, offset + 2, offset + 2, offset + 3, offset], quad * 6);
  }
  result.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return result;
}

export function colorAt(attribute: THREE.BufferAttribute, index: number, hue: number, saturation: number, value: number): void {
  const h = (((hue % 1) + 1) % 1) * 6;
  const r = Math.max(0, Math.min(1, Math.abs(h - 3) - 1));
  const g = Math.max(0, Math.min(1, 2 - Math.abs(h - 2)));
  const b = Math.max(0, Math.min(1, 2 - Math.abs(h - 4)));
  attribute.setXYZ(index, value * (1 - saturation + saturation * r), value * (1 - saturation + saturation * g), value * (1 - saturation + saturation * b));
}

/** Update smooth normals in existing buffers without allocating per-frame vectors. */
export function updateNormals(buffer: GeometryBuffer, vertices: number, indices: number): void {
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

export function mesh(buffer: GeometryBuffer, material: THREE.Material): THREE.Mesh {
  const result = new THREE.Mesh(buffer.geometry, material); result.frustumCulled = false; return result;
}
export function lines(buffer: GeometryBuffer, material: THREE.Material): THREE.LineSegments {
  const result = new THREE.LineSegments(buffer.geometry, material); result.frustumCulled = false; return result;
}
export function finish(buffer: GeometryBuffer, count: number): void {
  buffer.geometry.setDrawRange(0, count); buffer.positions.needsUpdate = true; buffer.colors.needsUpdate = true;
}
export function activeCount(maximum: number, density: number): number { return Math.max(1, Math.round(maximum * (.3 + .7 * density))); }

/** Additive instanced point sprites with per-sprite color and size, written sequentially each frame. */
export class SpriteBatch {
  readonly sprite: THREE.Sprite;
  readonly material: THREE.PointsNodeMaterial;
  readonly positions: THREE.InstancedBufferAttribute;
  readonly colors: THREE.InstancedBufferAttribute;
  readonly sizes: THREE.InstancedBufferAttribute;
  readonly gain = uniform(1);
  private cursor = 0;

  constructor(readonly capacity: number, softness = .12) {
    this.positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.material = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.material.positionNode = instancedBufferAttribute(this.positions);
    this.material.colorNode = vec3(instancedBufferAttribute(this.colors)).mul(this.gain);
    this.material.sizeNode = float(instancedBufferAttribute(this.sizes));
    this.material.opacityNode = float(1).sub(smoothstep(softness, .5, uv().sub(.5).length()));
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.count = 0; this.sprite.visible = false; this.sprite.frustumCulled = false;
  }

  get count(): number { return this.cursor; }
  begin(): void { this.cursor = 0; }
  add(x: number, y: number, z: number, hue: number, saturation: number, value: number, size: number): void {
    if (this.cursor >= this.capacity) return;
    this.positions.setXYZ(this.cursor, x, y, z);
    colorAt(this.colors, this.cursor, hue, saturation, value);
    this.sizes.setX(this.cursor++, size);
  }
  end(): void {
    this.sprite.count = this.cursor; this.sprite.visible = this.cursor > 0;
    this.positions.needsUpdate = true; this.colors.needsUpdate = true; this.sizes.needsUpdate = true;
  }
}

/** Additive instanced light beams: open cylinders that fade toward their silhouette so they read as haze. */
export class BeamBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly opacity = uniform(.5);
  private cursor = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly direction = new THREE.Vector3();

  constructor(readonly capacity: number) {
    this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff });
    this.material.opacityNode = normalView.z.abs().pow(1.7).mul(this.opacity);
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.count = 0; this.mesh.visible = false;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  }

  get count(): number { return this.cursor; }
  begin(): void { this.cursor = 0; }
  add(from: Point3, to: Point3, radius: number, color: THREE.Color): void {
    if (this.cursor >= this.capacity) return;
    this.direction.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = this.direction.length();
    if (length < 1e-6) return;
    this.dummy.position.set((from.x + to.x) * .5, (from.y + to.y) * .5, (from.z + to.z) * .5);
    this.dummy.quaternion.setFromUnitVectors(UP, this.direction.divideScalar(length));
    this.dummy.scale.set(radius, length, radius); this.dummy.updateMatrix();
    this.mesh.setMatrixAt(this.cursor, this.dummy.matrix);
    this.mesh.setColorAt(this.cursor++, color);
  }
  end(): void {
    this.mesh.count = this.cursor; this.mesh.visible = this.cursor > 0;
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true;
  }
}

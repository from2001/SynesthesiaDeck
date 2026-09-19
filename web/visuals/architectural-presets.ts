import * as THREE from 'three/webgpu';
import { architecturalCounts, architecturalDeform, architecturalPalette, emptyArchitecturalPose, latticePose, loomPoint, chimePose, origamiPoint, portalPoint,
  type ArchitecturalPose } from './architectural-math';
import type { Point3, VisualFrame } from './math';
import type { Quality } from './parameters';

const cellOrder = Array.from({ length: 120 }, (_, index) => ({ column: index % 12, row: Math.floor(index / 12) }))
  .sort((a, b) => Math.hypot(a.column - 5.5, a.row - 4.5) - Math.hypot(b.column - 5.5, b.row - 4.5));
const zero = (): Point3 => ({ x: 0, y: 0, z: 0 });
const PAPER_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

function dynamicGeometry(vertices: number, indices?: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
  if (indices) geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);
  return geometry;
}

function surfaceMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
}

/** Five surface/line-based worlds with fixed allocation and deterministic shared-clock transforms. */
export class ArchitecturalPresets {
  readonly group = new THREE.Group();
  private readonly worlds = Array.from({ length: 5 }, () => new THREE.Group());
  private readonly paper = new THREE.Mesh(dynamicGeometry(120 * 12), surfaceMaterial());
  private readonly creases = new THREE.LineSegments(dynamicGeometry(120 * 16), new THREE.LineBasicNodeMaterial({ vertexColors: true }));
  private readonly lattice = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide }), 6 * 64 * 2);
  private readonly loom: THREE.Mesh;
  private loomSegments = 112;
  private readonly chimes: THREE.InstancedMesh;
  private readonly portal: THREE.Mesh;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly p0 = zero();
  private readonly p1 = zero();
  private readonly p2 = zero();
  private readonly center = zero();
  private readonly before = zero();
  private readonly after = zero();
  private readonly pose = emptyArchitecturalPose();
  private readonly tangent = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly binormal = new THREE.Vector3();
  private readonly light = new THREE.Vector3(-.35, .7, .6).normalize();

  constructor() {
    this.group.name = 'Architectural presets';
    for (const world of this.worlds) { this.group.add(world); world.visible = false; }
    this.worlds[0].name = 'ORIGAMI ENGINE'; this.worlds[0].add(this.paper, this.creases);
    this.worlds[1].name = 'MOIRE OBSERVATORY'; this.worlds[1].add(this.lattice);

    // The maximum tube allocation is reused with compact active indices at each quality.
    const tubeIndices: number[] = [];
    for (let loop = 0; loop < 10; loop++) for (let segment = 0; segment < 112; segment++) for (let side = 0; side < 6; side++) {
      const a = (loop * 113 + segment) * 6 + side, b = (loop * 113 + segment) * 6 + (side + 1) % 6;
      tubeIndices.push(a, b, a + 6, b, b + 6, a + 6);
    }
    this.loom = new THREE.Mesh(dynamicGeometry(10 * 113 * 6, tubeIndices), surfaceMaterial());
    this.worlds[2].name = 'IMPOSSIBLE LOOM'; this.worlds[2].add(this.loom);

    const prisms = new THREE.LatheGeometry([
      new THREE.Vector2(0, -.5), new THREE.Vector2(.62, -.36),
      new THREE.Vector2(.62, .36), new THREE.Vector2(.32, .5), new THREE.Vector2(0, .5),
    ], 6);
    const normals = prisms.getAttribute('normal');
    const shades = new Float32Array(normals.count * 3);
    for (let index = 0; index < normals.count; index++) {
      const shade = .35 + .65 * Math.max(0, normals.getX(index) * this.light.x + normals.getY(index) * this.light.y + normals.getZ(index) * this.light.z);
      shades.set([shade, shade, shade], index * 3);
    }
    prisms.setAttribute('color', new THREE.BufferAttribute(shades, 3));
    this.chimes = new THREE.InstancedMesh(prisms, new THREE.MeshBasicNodeMaterial({ vertexColors: true }), 56);
    this.worlds[3].name = 'RESONANT CHIMES'; this.worlds[3].add(this.chimes);

    const portalIndices: number[] = [];
    for (let quad = 0; quad < 28 * 12 * 3; quad++) {
      const offset = quad * 4; portalIndices.push(offset, offset + 1, offset + 2, offset + 2, offset + 3, offset);
    }
    this.portal = new THREE.Mesh(dynamicGeometry(28 * 12 * 3 * 4, portalIndices), surfaceMaterial());
    this.worlds[4].name = 'PRISMATIC PORTAL'; this.worlds[4].add(this.portal);
    for (const object of [this.paper, this.creases, this.loom, this.portal, this.lattice, this.chimes]) object.frustumCulled = false;
    this.lattice.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chimes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate instance colors in the constructor rather than on the first visible frame.
    this.lattice.setColorAt(0, this.color.setRGB(1, 1, 1));
    this.chimes.setColorAt(0, this.color.setRGB(1, 1, 1));
  }

  update(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = frame.state.scene - 10;
    this.group.visible = active >= 0 && active < 5 && frame.state.running && gain > 0;
    for (let index = 0; index < this.worlds.length; index++) this.worlds[index].visible = index === active && this.group.visible;
    if (!this.group.visible) return;
    if (active === 0) this.updatePaper(frame, quality, gain);
    else if (active === 1) this.updateLattice(frame, quality, gain);
    else if (active === 2) this.updateLoom(frame, quality, gain);
    else if (active === 3) this.updateChimes(frame, quality, gain);
    else this.updatePortal(frame, quality, gain);
  }

  private finish(geometry: THREE.BufferGeometry, drawCount: number, activeVertices?: number): void {
    geometry.setDrawRange(0, drawCount);
    for (const key of ['position', 'color']) {
      const attribute = geometry.getAttribute(key) as THREE.BufferAttribute;
      if (activeVertices !== undefined) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, activeVertices * 3);
      }
      attribute.needsUpdate = true;
    }
  }

  private vertex(geometry: THREE.BufferGeometry, index: number, point: Point3, color: THREE.Color): void {
    geometry.getAttribute('position').setXYZ(index, point.x, point.y, point.z);
    geometry.getAttribute('color').setXYZ(index, color.r, color.g, color.b);
  }

  private updatePaper(frame: VisualFrame, quality: Quality, gain: number): void {
    const p = frame.state.sceneParams;
    const cells = architecturalCounts(frame, quality).cells;
    let vertex = 0, lineVertex = 0;
    for (let cell = 0; cell < cells; cell++) {
      const { column, row } = cellOrder[cell];
      origamiPoint(frame, column, row, .5, .5, true, this.center);
      architecturalDeform(this.center, frame, cell, this.center);
      for (let edge = 0; edge < 4; edge++) {
        const a = PAPER_CORNERS[edge], b = PAPER_CORNERS[(edge + 1) % 4];
        origamiPoint(frame, column, row, a[0], a[1], false, this.p0);
        origamiPoint(frame, column, row, b[0], b[1], false, this.p1);
        architecturalDeform(this.p0, frame, cell, this.p0); architecturalDeform(this.p1, frame, cell, this.p1);
        this.tangent.set(this.p1.x - this.p0.x, this.p1.y - this.p0.y, this.p1.z - this.p0.z);
        this.normal.set(this.center.x - this.p0.x, this.center.y - this.p0.y, this.center.z - this.p0.z).cross(this.tangent).normalize();
        const shade = .4 + .6 * Math.abs(this.normal.dot(this.light));
        const coral = (column + row + edge) % 5 === 0;
        this.color.setHSL(architecturalPalette(frame, cell, coral ? .025 : .105), coral ? .62 : .19, coral ? .53 : .79)
          .multiplyScalar(gain * (1 - p[7] * .45 + p[7] * shade * .7));
        this.vertex(this.paper.geometry, vertex++, this.p0, this.color);
        this.vertex(this.paper.geometry, vertex++, this.p1, this.color);
        this.vertex(this.paper.geometry, vertex++, this.center, this.color);
        this.color.setHSL(architecturalPalette(frame, cell, .025), .25, .11).multiplyScalar(gain * (.2 + p[7]));
        for (let line = 0; line < 4; line++) {
          const point = line === 3 ? this.center : line === 1 ? this.p1 : this.p0;
          this.p2.x = point.x; this.p2.y = point.y; this.p2.z = point.z + .002;
          this.vertex(this.creases.geometry, lineVertex++, this.p2, this.color);
        }
      }
    }
    this.finish(this.paper.geometry, vertex); this.finish(this.creases.geometry, lineVertex);
  }

  private transform(mesh: THREE.InstancedMesh, index: number, pose: ArchitecturalPose): void {
    this.dummy.position.set(pose.x, pose.y, pose.z); this.dummy.rotation.set(pose.rx, pose.ry, pose.rz);
    this.dummy.scale.set(pose.sx, pose.sy, pose.sz); this.dummy.updateMatrix(); mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private updateLattice(frame: VisualFrame, quality: Quality, gain: number): void {
    const frequency = 12 + Math.floor(frame.state.sceneParams[3] * 52);
    const layers = architecturalCounts(frame, quality).latticeLayers;
    let instance = 0;
    for (let layer = 0; layer < layers; layer++) for (let line = 0; line < frequency; line++) for (let axis = 0; axis < 2; axis++) {
      this.transform(this.lattice, instance, latticePose(frame, layer, line, !!axis, this.pose));
      const prism = (frame.state.toggles[6] ? frame.state.controls.masterFX : 0) + frame.effects.oneShots[6];
      const tint = Math.min(.9, Math.abs(frame.state.sceneParams[5] - .5) * .7 + prism * .6);
      this.color.setHSL(architecturalPalette(frame, layer, .56), tint, layer % 2 ? .54 : .9).multiplyScalar(gain * (1 - layer * .055));
      this.lattice.setColorAt(instance++, this.color);
    }
    this.lattice.count = instance; this.lattice.instanceMatrix.needsUpdate = true; this.lattice.instanceColor!.needsUpdate = true;
  }

  private updateLoom(frame: VisualFrame, quality: Quality, gain: number): void {
    const p = frame.state.sceneParams;
    const loops = architecturalCounts(frame, quality).loops;
    // Pack only the chosen segment count; lower quality reduces CPU evaluation, uploads and GPU vertices.
    const segments = { low: 48, medium: 80, high: 112 }[quality];
    if (segments !== this.loomSegments) {
      const index = this.loom.geometry.index!;
      let offset = 0;
      for (let loop = 0; loop < 10; loop++) for (let segment = 0; segment < segments; segment++) for (let side = 0; side < 6; side++) {
        const a = (loop * (segments + 1) + segment) * 6 + side;
        const b = (loop * (segments + 1) + segment) * 6 + (side + 1) % 6;
        index.setX(offset++, a); index.setX(offset++, b); index.setX(offset++, a + 6);
        index.setX(offset++, b); index.setX(offset++, b + 6); index.setX(offset++, a + 6);
      }
      index.clearUpdateRanges(); index.addUpdateRange(0, offset); index.needsUpdate = true;
      this.loomSegments = segments;
    }
    const radius = (.025 + p[2] * .095) * (1 + frame.audio.beat * .12);
    for (let loop = 0; loop < loops; loop++) for (let segment = 0; segment <= segments; segment++) {
      const u = segment / segments;
      loomPoint(frame, loop, u, this.center); loomPoint(frame, loop, u - .0002, this.before); loomPoint(frame, loop, u + .0002, this.after);
      this.tangent.set(this.after.x - this.before.x, this.after.y - this.before.y, this.after.z - this.before.z).normalize();
      this.normal.set(this.center.x, 0, this.center.z + 2.2).normalize();
      this.normal.addScaledVector(this.tangent, -this.normal.dot(this.tangent));
      if (this.normal.lengthSq() < .001) this.normal.set(0, 1, 0).addScaledVector(this.tangent, -this.tangent.y);
      this.normal.normalize(); this.binormal.crossVectors(this.tangent, this.normal).normalize();
      for (let side = 0; side < 6; side++) {
        const angle = side / 6 * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
        this.p0.x = this.center.x + radius * (this.normal.x * c + this.binormal.x * s);
        this.p0.y = this.center.y + radius * (this.normal.y * c + this.binormal.y * s);
        this.p0.z = this.center.z + radius * (this.normal.z * c + this.binormal.z * s);
        const shade = .35 + .65 * Math.max(0, (this.normal.x * c + this.binormal.x * s) * this.light.x + (this.normal.y * c + this.binormal.y * s) * this.light.y + (this.normal.z * c + this.binormal.z * s) * this.light.z);
        this.color.setHSL(architecturalPalette(frame, loop, (loop * .137 + .58) % 1), .75, .55).multiplyScalar(gain * (shade + frame.audio.high * .2));
        this.vertex(this.loom.geometry, (loop * (segments + 1) + segment) * 6 + side, this.p0, this.color);
      }
    }
    this.finish(this.loom.geometry, loops * segments * 6 * 6, loops * (segments + 1) * 6);
  }

  private updateChimes(frame: VisualFrame, quality: Quality, gain: number): void {
    const count = architecturalCounts(frame, quality).chimes;
    for (let index = 0; index < count; index++) {
      this.transform(this.chimes, index, chimePose(frame, index, this.pose));
      const wave = .5 + .5 * Math.sin(frame.phase * (.5 + frame.state.sceneParams[7]) - index * .32);
      this.color.setHSL(architecturalPalette(frame, index, .48 + (index % 8) * .045), .67, .58)
        .multiplyScalar(gain * (.9 + wave * frame.state.sceneParams[7] * .65 + frame.audio.high * .3));
      this.chimes.setColorAt(index, this.color);
    }
    this.chimes.count = count; this.chimes.instanceMatrix.needsUpdate = true; this.chimes.instanceColor!.needsUpdate = true;
  }

  private updatePortal(frame: VisualFrame, quality: Quality, gain: number): void {
    const p = frame.state.sceneParams;
    const rings = architecturalCounts(frame, quality).portalRings;
    const bands = p[7] > .001 ? 3 : 1;
    const sides = 3 + Math.floor(p[3] * 9);
    let vertex = 0;
    for (let ring = 0; ring < rings; ring++) for (let bandIndex = 0; bandIndex < bands; bandIndex++) for (let edge = 0; edge < sides; edge++) {
      const band = bands === 1 ? 1 : bandIndex;
      this.color.setHSL(architecturalPalette(frame, ring, .52 + band * .18 + ring * .014), .88, .57)
        .multiplyScalar(gain * (1.4 + frame.audio.beat * .3) * Math.max(.2, 1 - ring * .024));
      for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        const corner = edge + (cornerIndex === 1 || cornerIndex === 2 ? 1 : 0);
        portalPoint(frame, ring, corner, band, cornerIndex >= 2, this.p0);
        this.vertex(this.portal.geometry, vertex++, this.p0, this.color);
      }
    }
    this.finish(this.portal.geometry, vertex / 4 * 6);
  }
}

import * as THREE from 'three/webgpu';
import type { VisualFrame } from './math';
import type { Quality } from './parameters';
import { SpriteBatch, buffers, colorAt, finish, lines, mesh, quads, surface } from './dynamic-geometry';
import { activeCount } from './bank-math';
import { CURTAIN_U, CURTAIN_V, ECHO_QUALITY, MAX_BLADES, fresh, freshNode, freshPendulum, kelpHeight, linksPerCluster, packetTravel,
  sampleBlade, sampleBubble, sampleCurtain, sampleKelp, sampleLink, sampleNode, samplePendulum, sampleTrace, type EchoSample } from './echo-math';

const MAX = ECHO_QUALITY.high;
const MAX_NODES = MAX.clusters * MAX.members;
const MAX_LINKS = MAX.clusters * linksPerCluster(MAX.members);

function additiveLines(opacity = 1): THREE.LineBasicNodeMaterial {
  return new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
}

/** Five presets that continue the Signal, Organic and Structures families with new subjects. */
export class EchoPresets {
  readonly group = new THREE.Group();
  /** Dynamic sprite batches, exposed so tests can hash live sprite data. */
  readonly sprites: SpriteBatch[] = [];
  private readonly worlds = Array.from({ length: 5 }, () => new THREE.Group());
  private pointA = fresh();
  private pointB = fresh();
  private readonly node = freshNode();
  private readonly pendulum = freshPendulum();
  private readonly link = { a: 0, b: 0, active: false };
  private readonly color = new THREE.Color();
  private readonly dummy = new THREE.Object3D();

  private readonly traces = buffers(MAX.traces * MAX.samples * 2);
  private readonly traceMaterial = additiveLines();

  private readonly nodeMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  private readonly nodes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), this.nodeMaterial, MAX_NODES);
  private readonly nodePositions = new Float32Array(MAX_NODES * 3);
  private readonly nodeHues = new Float32Array(MAX_NODES);
  private readonly nodeSizes = new Float32Array(MAX_NODES);
  private readonly nodeGlow = new Float32Array(MAX_NODES);
  private readonly links = buffers(MAX_LINKS * 2);
  private readonly linkMaterial = additiveLines(.8);
  private readonly packets = new SpriteBatch(MAX_LINKS * 2, .1);

  private readonly spines = buffers(MAX.strands * MAX.spineSegments * 2);
  private readonly spineMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true });
  private readonly blades = quads(MAX.strands * MAX_BLADES);
  private readonly bladeMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private readonly bubbles = new SpriteBatch(MAX.bubbles, .1);

  private readonly curtains = surface(MAX.curtains, CURTAIN_U, CURTAIN_V);
  private readonly curtainMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .6, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly rays = buffers(MAX.curtains * MAX.rays * 2);
  private readonly rayMaterial = additiveLines(.85);

  private readonly bobMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  private readonly bobs = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), this.bobMaterial, MAX.pendulums);
  private readonly strings = buffers(MAX.pendulums * 2 * 2);
  private readonly stringMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .9 });
  private readonly ghosts = new SpriteBatch(MAX.pendulums * MAX.ghosts, .15);

  constructor() {
    this.group.name = 'Echo presets';
    const names = ['WAVEFORM ATLAS', 'SYNAPSE RELAY', 'KELP FOREST', 'AURORA CURTAIN', 'PENDULUM HALL'];
    this.worlds.forEach((world, index) => { world.name = names[index]; world.visible = false; this.group.add(world); });
    this.group.visible = false;
    this.worlds[0].add(lines(this.traces, this.traceMaterial));
    for (const instanced of [this.nodes, this.bobs]) {
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); instanced.frustumCulled = false; instanced.count = 0;
      instanced.setColorAt(0, this.color.setRGB(1, 1, 1)); instanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    }
    this.worlds[1].add(this.nodes, lines(this.links, this.linkMaterial), this.packets.sprite);
    this.worlds[2].add(lines(this.spines, this.spineMaterial), mesh(this.blades, this.bladeMaterial), this.bubbles.sprite);
    this.worlds[3].add(mesh(this.curtains, this.curtainMaterial), lines(this.rays, this.rayMaterial));
    this.worlds[4].add(this.bobs, lines(this.strings, this.stringMaterial), this.ghosts.sprite);
    this.sprites.push(this.packets, this.bubbles, this.ghosts);
  }

  update(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = frame.state.scene - 15;
    this.group.visible = active >= 0 && active < 5 && frame.state.running && gain > 0;
    for (let index = 0; index < this.worlds.length; index++) this.worlds[index].visible = index === active && this.group.visible;
    if (!this.group.visible) return;
    if (active === 0) this.updateWaveform(frame, quality, gain);
    else if (active === 1) this.updateSynapse(frame, quality, gain);
    else if (active === 2) this.updateKelp(frame, quality, gain);
    else if (active === 3) this.updateAurora(frame, quality, gain);
    else this.updatePendulum(frame, quality, gain);
  }

  private write(buffer: { positions: THREE.BufferAttribute; colors: THREE.BufferAttribute }, index: number, sample: EchoSample, saturation: number, value: number): void {
    buffer.positions.setXYZ(index, sample.x, sample.y, sample.z);
    colorAt(buffer.colors, index, sample.hue, saturation, value);
  }

  private updateWaveform(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = ECHO_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(2, activeCount(Math.min(q.traces, 4 + Math.floor(p[3] * 24)), frame.state.controls.density));
    this.traceMaterial.color.setScalar(gain * 1.9);
    let vertex = 0;
    for (let trace = 0; trace < count; trace++) {
      sampleTrace(frame, trace, count, 0, this.pointA);
      for (let segment = 0; segment < q.samples; segment++) {
        sampleTrace(frame, trace, count, (segment + 1) / q.samples, this.pointB);
        this.write(this.traces, vertex++, this.pointA, .85, this.pointA.glow);
        this.write(this.traces, vertex++, this.pointB, .85, this.pointB.glow);
        const swap = this.pointA; this.pointA = this.pointB; this.pointB = swap;
      }
    }
    finish(this.traces, vertex);
  }

  private updateSynapse(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = ECHO_QUALITY[quality], p = frame.state.sceneParams;
    const nodeCount = activeCount(q.clusters * q.members, frame.state.controls.density);
    for (let index = 0; index < nodeCount; index++) {
      sampleNode(frame, index, q.clusters, q.members, this.node);
      this.nodePositions[index * 3] = this.node.x; this.nodePositions[index * 3 + 1] = this.node.y; this.nodePositions[index * 3 + 2] = this.node.z;
      this.nodeHues[index] = this.node.hue; this.nodeSizes[index] = this.node.size; this.nodeGlow[index] = this.node.glow;
    }
    this.linkMaterial.color.setScalar(gain * 1.1);
    this.packets.gain.value = gain * 2.4; this.packets.begin();
    let vertex = 0;
    const linkCount = q.clusters * linksPerCluster(q.members);
    for (let link = 0; link < linkCount; link++) {
      sampleLink(frame, link, q.clusters, q.members, this.link);
      if (!this.link.active || this.link.a >= nodeCount || this.link.b >= nodeCount) continue;
      const a = this.link.a * 3, b = this.link.b * 3, hue = this.nodeHues[this.link.a];
      this.links.positions.setXYZ(vertex, this.nodePositions[a], this.nodePositions[a + 1], this.nodePositions[a + 2]);
      colorAt(this.links.colors, vertex++, hue, .6, .45 + frame.audio.mid * .25);
      this.links.positions.setXYZ(vertex, this.nodePositions[b], this.nodePositions[b + 1], this.nodePositions[b + 2]);
      colorAt(this.links.colors, vertex++, hue, .6, .45 + frame.audio.mid * .25);
      for (let packet = 0; packet < 2; packet++) {
        const { travel, forward } = packetTravel(frame, link, packet);
        const from = forward ? a : b, to = forward ? b : a;
        this.packets.add(this.nodePositions[from] + (this.nodePositions[to] - this.nodePositions[from]) * travel,
          this.nodePositions[from + 1] + (this.nodePositions[to + 1] - this.nodePositions[from + 1]) * travel,
          this.nodePositions[from + 2] + (this.nodePositions[to + 2] - this.nodePositions[from + 2]) * travel,
          hue + .1, .5, (.5 + frame.audio.beat * .8) * (.4 + p[7]), .02 + p[2] * .05);
        const arrival = Math.exp(-Math.pow((1 - travel) * 7, 2)) * (1 + p[7] * 1.5);
        this.nodeGlow[to / 3] = Math.max(this.nodeGlow[to / 3], .5 + arrival);
      }
    }
    finish(this.links, vertex); this.packets.end();
    this.nodeMaterial.color.setScalar(gain * 1.3);
    for (let index = 0; index < nodeCount; index++) {
      this.dummy.position.set(this.nodePositions[index * 3], this.nodePositions[index * 3 + 1], this.nodePositions[index * 3 + 2]);
      this.dummy.rotation.set(0, frame.phase * .2, 0); this.dummy.scale.setScalar(this.nodeSizes[index]); this.dummy.updateMatrix();
      this.nodes.setMatrixAt(index, this.dummy.matrix);
      this.nodes.setColorAt(index, this.color.setHSL(this.nodeHues[index], .7, .5).multiplyScalar(this.nodeGlow[index]));
    }
    this.nodes.count = nodeCount; this.nodes.instanceMatrix.needsUpdate = true; this.nodes.instanceColor!.needsUpdate = true;
  }

  private updateKelp(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = ECHO_QUALITY[quality], p = frame.state.sceneParams;
    const strands = activeCount(q.strands, frame.state.controls.density);
    const blades = Math.min(MAX_BLADES, 4 + Math.floor(p[3] * 12));
    this.spineMaterial.color.setScalar(gain * 1.5); this.bladeMaterial.color.setScalar(gain * 1.35);
    let vertex = 0, bladeVertex = 0;
    for (let strand = 0; strand < strands; strand++) {
      sampleKelp(frame, strand, q.strands, 0, this.pointA);
      for (let segment = 0; segment < q.spineSegments; segment++) {
        sampleKelp(frame, strand, q.strands, (segment + 1) / q.spineSegments, this.pointB);
        this.write(this.spines, vertex++, this.pointA, .7, this.pointA.glow);
        this.write(this.spines, vertex++, this.pointB, .7, this.pointB.glow);
        const swap = this.pointA; this.pointA = this.pointB; this.pointB = swap;
      }
      for (let blade = 0; blade < blades; blade++) for (let corner = 0; corner < 4; corner++) {
        sampleBlade(frame, strand, q.strands, blade, blades, corner, this.pointA);
        this.write(this.blades, bladeVertex++, this.pointA, .72, this.pointA.glow);
      }
    }
    finish(this.spines, vertex); finish(this.blades, bladeVertex / 4 * 6);
    const bubbles = activeCount(q.bubbles, frame.state.controls.density);
    this.bubbles.gain.value = gain * 2; this.bubbles.begin();
    for (let index = 0; index < bubbles; index++) {
      sampleBubble(frame, index, q.strands, this.pointA);
      if (this.pointA.y > kelpHeight(frame, index % q.strands) * 1.15 + .5) continue;
      this.bubbles.add(this.pointA.x, this.pointA.y, this.pointA.z, this.pointA.hue, .45, this.pointA.glow, .015 + p[7] * .03);
    }
    this.bubbles.end();
  }

  private updateAurora(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = ECHO_QUALITY[quality], curtains = activeCount(q.curtains, frame.state.controls.density);
    this.curtainMaterial.color.setScalar(gain * 1.3); this.rayMaterial.color.setScalar(gain * 1.7);
    let vertex = 0, ray = 0;
    for (let curtain = 0; curtain < curtains; curtain++) {
      for (let v = 0; v <= CURTAIN_V; v++) for (let u = 0; u <= CURTAIN_U; u++) {
        sampleCurtain(frame, curtain, u / CURTAIN_U, v / CURTAIN_V, this.pointA);
        this.write(this.curtains, vertex++, this.pointA, .8, this.pointA.glow);
      }
      for (let index = 0; index < q.rays; index++) {
        const u = (index + .5) / q.rays;
        sampleCurtain(frame, curtain, u, 0, this.pointA); sampleCurtain(frame, curtain, u, 1, this.pointB);
        this.write(this.rays, ray++, this.pointA, .75, this.pointA.glow * 1.4);
        this.write(this.rays, ray++, this.pointB, .75, this.pointA.glow * .15);
      }
    }
    finish(this.curtains, curtains * this.curtains.indicesPerItem); finish(this.rays, ray);
  }

  private updatePendulum(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = ECHO_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(3, Math.round(Math.min(q.pendulums, 6 + p[3] * 34) * (.4 + frame.state.controls.density * .6)));
    const delta = .06 + p[7] * .1;
    this.bobMaterial.color.setScalar(gain * 1.6); this.stringMaterial.color.setScalar(gain * 1.2);
    this.ghosts.gain.value = gain * 1.8; this.ghosts.begin();
    let vertex = 0, previousX = 0, previousY = 0, previousZ = 0;
    for (let index = 0; index < count; index++) {
      const bob = samplePendulum(frame, index, count, this.pendulum);
      this.dummy.position.set(bob.x, bob.y, bob.z); this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(bob.size); this.dummy.updateMatrix();
      this.bobs.setMatrixAt(index, this.dummy.matrix);
      this.bobs.setColorAt(index, this.color.setHSL(bob.hue, .8, .55).multiplyScalar(bob.glow));
      this.strings.positions.setXYZ(vertex, bob.pivotX, bob.pivotY, bob.pivotZ); colorAt(this.strings.colors, vertex++, bob.hue, .3, .45);
      this.strings.positions.setXYZ(vertex, bob.x, bob.y, bob.z); colorAt(this.strings.colors, vertex++, bob.hue, .3, .6);
      if (index > 0) {
        this.strings.positions.setXYZ(vertex, previousX, previousY, previousZ); colorAt(this.strings.colors, vertex++, bob.hue, .2, .5);
        this.strings.positions.setXYZ(vertex, bob.pivotX, bob.pivotY, bob.pivotZ); colorAt(this.strings.colors, vertex++, bob.hue, .2, .5);
      }
      previousX = bob.pivotX; previousY = bob.pivotY; previousZ = bob.pivotZ;
      for (let ghost = 1; ghost <= q.ghosts; ghost++) {
        samplePendulum(frame, index, count, this.pendulum, frame.phase - ghost * delta);
        const fade = Math.pow(1 - ghost / (q.ghosts + 1), 2) * p[7] * 1.2;
        this.ghosts.add(this.pendulum.x, this.pendulum.y, this.pendulum.z, this.pendulum.hue, .7, fade, this.pendulum.size * 1.6);
      }
    }
    this.bobs.count = count; this.bobs.instanceMatrix.needsUpdate = true; this.bobs.instanceColor!.needsUpdate = true;
    finish(this.strings, vertex); this.ghosts.end();
  }
}

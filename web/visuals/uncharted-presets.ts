import * as THREE from 'three/webgpu';
import type { VisualFrame } from './math';
import type { Quality } from './parameters';
import { SpriteBatch, buffers, colorAt, finish, lines } from './dynamic-geometry';
import { activeCount, zero } from './bank-math';
import { DANCER_SEGMENTS, UNCHARTED_QUALITY, automatonBlock, automatonGeneration, automatonRule, freshCell, freshDancer, freshDomino, freshLantern,
  freshShell, freshSpark, sampleCell, sampleDancer, sampleDomino, sampleLantern, sampleShell, sampleSpark, shellPosition } from './uncharted-math';

const MAX = UNCHARTED_QUALITY.high;
const MAX_CELLS = MAX.columns * MAX.rows;
const MAX_SPARKS = MAX.shells * MAX.sparks;
const LIGHT = new THREE.Vector3(-.35, .7, .6).normalize();

/** Bake a directional shade and an optional vertical gradient into vertex colors; instance colors tint it. */
function shaded(geometry: THREE.BufferGeometry, bottom = 1, top = 1): THREE.BufferGeometry {
  const normals = geometry.getAttribute('normal'), positions = geometry.getAttribute('position');
  const colors = new Float32Array(normals.count * 3);
  for (let index = 0; index < normals.count; index++) {
    const shade = .4 + .6 * Math.max(0, normals.getX(index) * LIGHT.x + normals.getY(index) * LIGHT.y + normals.getZ(index) * LIGHT.z);
    const gradient = bottom + (top - bottom) * (positions.getY(index) + .5);
    colors.set([shade * gradient, shade * gradient, shade * gradient], index * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Five presets unlike the earlier banks: a domino run, neon dancers, sky lanterns, a cellular automaton and fireworks. */
export class UnchartedPresets {
  readonly group = new THREE.Group();
  /** Dynamic sprite batches, exposed so tests can hash live sprite data. */
  readonly sprites: SpriteBatch[] = [];
  private readonly worlds = Array.from({ length: 5 }, () => new THREE.Group());
  private readonly domino = freshDomino();
  private readonly dancer = freshDancer();
  private readonly lantern = freshLantern();
  private readonly cell = freshCell();
  private readonly shell = freshShell();
  private readonly spark = freshSpark();
  private readonly tail = freshSpark();
  private readonly pointA = zero();
  private readonly pointB = zero();
  private readonly color = new THREE.Color();
  private readonly dummy = new THREE.Object3D();

  private readonly dominoMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  private readonly dominoes = new THREE.InstancedMesh(shaded(new THREE.BoxGeometry(1, 1, 1)), this.dominoMaterial, MAX.dominoes);
  private readonly path = buffers(MAX.dominoes * 2);
  private readonly pathMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: .6 });

  private readonly figures = buffers(MAX.dancers * DANCER_SEGMENTS.length * 2);
  private readonly figureMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly headMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  private readonly heads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), this.headMaterial, MAX.dancers);

  private readonly lanternMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  private readonly lanterns = new THREE.InstancedMesh(shaded(new THREE.CylinderGeometry(.5, .36, 1, 4, 1), 1.15, .5), this.lanternMaterial, MAX.lanterns);
  private readonly flames = new SpriteBatch(MAX.lanterns, .05);

  private readonly cellMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  private readonly cells = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.cellMaterial, MAX_CELLS);
  private readonly blocks = [{ key: '', data: new Uint8Array(MAX_CELLS) }, { key: '', data: new Uint8Array(MAX_CELLS) }];

  private readonly sparks = new SpriteBatch(MAX_SPARKS, .1);
  private readonly sparkTrails = buffers(MAX_SPARKS * 2);
  private readonly streaks = buffers(MAX.shells * MAX.trail * 2);
  private readonly trailMaterial = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly flashes = new SpriteBatch(MAX.shells * 2, .2);

  constructor() {
    this.group.name = 'Uncharted presets';
    const names = ['DOMINO CASCADE', 'GLOWSTICK CROWD', 'LANTERN ASCENT', 'AUTOMATON WALL', 'HANABI SKY'];
    this.worlds.forEach((world, index) => { world.name = names[index]; world.visible = false; this.group.add(world); });
    this.group.visible = false;
    for (const instanced of [this.dominoes, this.heads, this.lanterns, this.cells]) {
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); instanced.frustumCulled = false; instanced.count = 0;
      instanced.setColorAt(0, this.color.setRGB(1, 1, 1)); instanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    }
    this.worlds[0].add(this.dominoes, lines(this.path, this.pathMaterial));
    this.worlds[1].add(lines(this.figures, this.figureMaterial), this.heads);
    this.worlds[2].add(this.lanterns, this.flames.sprite);
    this.worlds[3].add(this.cells);
    this.worlds[4].add(this.sparks.sprite, lines(this.sparkTrails, this.trailMaterial), lines(this.streaks, this.trailMaterial), this.flashes.sprite);
    this.sprites.push(this.flames, this.sparks, this.flashes);
  }

  update(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = frame.state.scene - 25;
    this.group.visible = active >= 0 && active < 5 && frame.state.running && gain > 0;
    for (let index = 0; index < this.worlds.length; index++) this.worlds[index].visible = index === active && this.group.visible;
    if (!this.group.visible) return;
    if (active === 0) this.updateDominoes(frame, quality, gain);
    else if (active === 1) this.updateCrowd(frame, quality, gain);
    else if (active === 2) this.updateLanterns(frame, quality, gain);
    else if (active === 3) this.updateAutomaton(frame, quality, gain);
    else this.updateHanabi(frame, quality, gain);
  }

  private updateDominoes(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = UNCHARTED_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(12, activeCount(Math.min(q.dominoes, 40 + Math.floor(p[3] * 260)), frame.state.controls.density, .35));
    this.dominoMaterial.color.setScalar(gain * 1.3); this.pathMaterial.color.setScalar(gain * .8);
    let vertex = 0;
    for (let index = 0; index < count; index++) {
      const domino = sampleDomino(frame, index, count, this.domino);
      const yaw = Math.atan2(domino.tangentX, domino.tangentZ), half = domino.height / 2;
      // The domino pivots on its base: the center rises along the tilted local up axis.
      this.dummy.position.set(domino.x + Math.sin(domino.angle) * domino.tangentX * half, domino.y + Math.cos(domino.angle) * half, domino.z + Math.sin(domino.angle) * domino.tangentZ * half);
      this.dummy.rotation.set(domino.angle, yaw, 0, 'YXZ');
      this.dummy.scale.set(domino.width, domino.height, domino.thickness); this.dummy.updateMatrix();
      this.dominoes.setMatrixAt(index, this.dummy.matrix);
      this.dominoes.setColorAt(index, this.color.setHSL(domino.hue, .5 + domino.fallen * .3, .5).multiplyScalar(domino.glow));
      if (index > 0) {
        this.path.positions.setXYZ(vertex, this.pointA.x, .01, this.pointA.z); colorAt(this.path.colors, vertex++, domino.hue, .4, .25);
        this.path.positions.setXYZ(vertex, domino.x, .01, domino.z); colorAt(this.path.colors, vertex++, domino.hue, .4, .25);
      }
      this.pointA.x = domino.x; this.pointA.z = domino.z;
    }
    this.dominoes.count = count; this.dominoes.instanceMatrix.needsUpdate = true; this.dominoes.instanceColor!.needsUpdate = true;
    finish(this.path, vertex);
  }

  private updateCrowd(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = UNCHARTED_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(3, activeCount(Math.min(q.dancers, 6 + Math.floor(p[3] * 34)), frame.state.controls.density, .35));
    this.figureMaterial.color.setScalar(gain * 1.6); this.headMaterial.color.setScalar(gain * 1.2);
    let vertex = 0;
    for (let index = 0; index < count; index++) {
      const dancer = sampleDancer(frame, index, this.dancer), joints = dancer.joints;
      for (let segment = 0; segment < DANCER_SEGMENTS.length; segment++) {
        const [a, b] = DANCER_SEGMENTS[segment], stick = segment >= 12;
        for (const end of [a, b]) {
          this.figures.positions.setXYZ(vertex, joints[end * 3], joints[end * 3 + 1], joints[end * 3 + 2]);
          if (stick) colorAt(this.figures.colors, vertex++, dancer.stickHue, .9, dancer.stickGlow * 1.6);
          else colorAt(this.figures.colors, vertex++, dancer.hue, .35, dancer.glow);
        }
      }
      this.dummy.position.set(joints[6], joints[7], joints[8]); this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(dancer.headRadius); this.dummy.updateMatrix();
      this.heads.setMatrixAt(index, this.dummy.matrix);
      this.heads.setColorAt(index, this.color.setHSL(dancer.hue, .35, .5).multiplyScalar(dancer.glow));
    }
    finish(this.figures, vertex);
    this.heads.count = count; this.heads.instanceMatrix.needsUpdate = true; this.heads.instanceColor!.needsUpdate = true;
  }

  private updateLanterns(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = UNCHARTED_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(4, activeCount(Math.min(q.lanterns, 20 + Math.floor(p[3] * 130)), frame.state.controls.density, .35));
    this.lanternMaterial.color.setScalar(gain * 1.7); this.flames.gain.value = gain * 2.4; this.flames.begin();
    for (let index = 0; index < count; index++) {
      const lantern = sampleLantern(frame, index, this.lantern);
      this.dummy.position.set(lantern.x, lantern.y, lantern.z); this.dummy.rotation.set(lantern.tilt, index * .7, lantern.tilt * .6);
      this.dummy.scale.set(lantern.size, lantern.size * 1.5, lantern.size); this.dummy.updateMatrix();
      this.lanterns.setMatrixAt(index, this.dummy.matrix);
      this.lanterns.setColorAt(index, this.color.setHSL(lantern.hue, .85, .5).multiplyScalar(lantern.glow));
      this.flames.add(lantern.x, lantern.y - lantern.size * .45, lantern.z, lantern.hue + .02, .7, lantern.glow * 1.1, lantern.size * 1.3);
    }
    this.lanterns.count = count; this.lanterns.instanceMatrix.needsUpdate = true; this.lanterns.instanceColor!.needsUpdate = true;
    this.flames.end();
  }

  /** Two cached generation blocks cover every visible row; a block is a pure function of seed, rule and size. */
  private block(frame: VisualFrame, block: number, rule: number, columns: number, rows: number, avoid: string): Uint8Array {
    const key = `${frame.state.seed}:${block}:${rule}:${columns}:${rows}`;
    const cached = this.blocks.find(entry => entry.key === key);
    if (cached) return cached.data;
    const slot = this.blocks[0].key === avoid ? this.blocks[1] : this.blocks[0];
    slot.key = key;
    return automatonBlock(frame.state.seed, block, rule, columns, rows, slot.data);
  }

  private updateAutomaton(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = UNCHARTED_QUALITY[quality];
    const rows = Math.max(6, activeCount(q.rows, frame.state.controls.density, .35)), columns = q.columns;
    const rule = automatonRule(frame), generation = Math.floor(automatonGeneration(frame));
    const newest = Math.floor(generation / rows), older = Math.floor((generation - rows + 1) / rows);
    const newestKey = `${frame.state.seed}:${newest}:${rule}:${columns}:${rows}`;
    const blockA = this.block(frame, newest, rule, columns, rows, ''), blockB = older === newest ? blockA : this.block(frame, older, rule, columns, rows, newestKey);
    this.cellMaterial.color.setScalar(gain * 1.5);
    let instance = 0;
    for (let age = 0; age < rows; age++) {
      const n = generation - age, block = Math.floor(n / rows), row = n - block * rows;
      const data = block === newest ? blockA : blockB;
      for (let column = 0; column < columns; column++) {
        const cell = sampleCell(frame, column, columns, age, rows, this.cell);
        this.dummy.position.set(cell.x, cell.y, cell.z); this.dummy.rotation.set(0, cell.yaw, 0);
        this.dummy.scale.set(cell.width, cell.height, 1); this.dummy.updateMatrix();
        this.cells.setMatrixAt(instance, this.dummy.matrix);
        if (data[row * columns + column]) this.cells.setColorAt(instance++, this.color.setHSL(cell.hue, .85, .55).multiplyScalar(cell.glow));
        else this.cells.setColorAt(instance++, this.color.setHSL(cell.hue, .5, .5).multiplyScalar(.035));
      }
    }
    this.cells.count = instance; this.cells.instanceMatrix.needsUpdate = true; this.cells.instanceColor!.needsUpdate = true;
  }

  private updateHanabi(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = UNCHARTED_QUALITY[quality], p = frame.state.sceneParams;
    const sparks = Math.max(12, activeCount(Math.min(q.sparks, 30 + Math.floor(p[3] * 110)), frame.state.controls.density, .4));
    const trailDelta = .05 + p[7] * .2;
    this.sparks.gain.value = gain * 2.4; this.flashes.gain.value = gain * 2; this.trailMaterial.color.setScalar(gain * 1.5);
    this.sparks.begin(); this.flashes.begin();
    let trail = 0, streak = 0;
    for (let slot = 0; slot < q.shells; slot++) {
      const shell = sampleShell(frame, slot, this.shell);
      if (shell.tau < shell.rise) {
        shellPosition(shell, shell.tau, this.pointA);
        this.flashes.add(this.pointA.x, this.pointA.y, this.pointA.z, shell.hue, .3, 1.4, .05);
        this.flashes.add(shell.launch.x, shell.launch.y + .05, shell.launch.z, shell.hue, .5, Math.exp(-shell.tau * 6) * 1.5, .3);
        for (let segment = 0; segment < q.trail; segment++) {
          shellPosition(shell, shell.tau - segment * .04, this.pointA); shellPosition(shell, shell.tau - (segment + 1) * .04, this.pointB);
          this.streaks.positions.setXYZ(streak, this.pointA.x, this.pointA.y, this.pointA.z); colorAt(this.streaks.colors, streak++, shell.hue, .4, (1 - segment / q.trail) * .9);
          this.streaks.positions.setXYZ(streak, this.pointB.x, this.pointB.y, this.pointB.z); colorAt(this.streaks.colors, streak++, shell.hue, .4, (1 - (segment + 1) / q.trail) * .9);
        }
        continue;
      }
      const since = shell.tau - shell.rise;
      if (since >= shell.life) continue;
      this.flashes.add(shell.burst.x, shell.burst.y, shell.burst.z, shell.hue, .25, Math.exp(-since * 5) * 3, .6);
      for (let index = 0; index < sparks; index++) {
        const spark = sampleSpark(frame, shell, index, sparks, since, this.spark);
        if (spark.y < 0) continue;
        this.sparks.add(spark.x, spark.y, spark.z, spark.hue, .75, spark.glow, spark.size);
        sampleSpark(frame, shell, index, sparks, since - trailDelta, this.tail);
        this.sparkTrails.positions.setXYZ(trail, spark.x, spark.y, spark.z); colorAt(this.sparkTrails.colors, trail++, spark.hue, .75, spark.glow * .6);
        this.sparkTrails.positions.setXYZ(trail, this.tail.x, Math.max(0, this.tail.y), this.tail.z); colorAt(this.sparkTrails.colors, trail++, spark.hue, .75, spark.glow * .1);
      }
    }
    this.sparks.end(); this.flashes.end(); finish(this.sparkTrails, trail); finish(this.streaks, streak);
  }
}

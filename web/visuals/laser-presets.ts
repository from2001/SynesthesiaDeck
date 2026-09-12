import * as THREE from 'three/webgpu';
import type { Point3, VisualFrame } from './math';
import type { Quality } from './parameters';
import { BeamBatch, SpriteBatch, buffers, colorAt, finish, lines, mesh, type GeometryBuffer } from './dynamic-geometry';
import { activeCount, zero } from './bank-math';
import { LASER_QUALITY, figureHead, freshBeam, freshPoint, galvoProjector, sampleFanBeam, sampleFigurePoint, sampleHarpString, sampleRingPoint,
  sampleSpoke, tunnelEmitter, type BeamSample } from './laser-math';

const MAX = LASER_QUALITY.high;
const MAX_FAN_BEAMS = MAX.emitters * MAX.beamsPerFan;

function additiveLines(opacity = 1): THREE.LineBasicNodeMaterial {
  return new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
}

/** Five laser-show presets: crisp additive core lines, soft instanced haze cylinders and floor spots. */
export class LaserPresets {
  readonly group = new THREE.Group();
  /** Dynamic sprite batches, exposed so tests can hash live sprite data. */
  readonly sprites: SpriteBatch[] = [];
  private readonly worlds = Array.from({ length: 5 }, () => new THREE.Group());
  private readonly beam = freshBeam();
  private readonly previous = freshBeam();
  private readonly point = freshPoint();
  private readonly other = freshPoint();
  private readonly emitter = zero();
  private readonly color = new THREE.Color();

  private readonly harpLines = buffers(MAX.strings * 2);
  private readonly harpBeams = new BeamBatch(MAX.strings);
  private readonly harpSpots = new SpriteBatch(MAX.strings + 1);

  private readonly fanLines = buffers(MAX_FAN_BEAMS * 2);
  private readonly fanBeams = new BeamBatch(MAX_FAN_BEAMS);
  private readonly fanSheets = buffers(MAX.emitters * (MAX.beamsPerFan - 1) * 3);
  private readonly fanSpots = new SpriteBatch(MAX_FAN_BEAMS + MAX.emitters);

  private readonly ringLines = buffers(MAX.rings * MAX.ringSegments * 2);
  private readonly coneLines = buffers(MAX.cone * 2);
  private readonly coneBeams = new BeamBatch(MAX.cone);
  private readonly tunnelSpots = new SpriteBatch(1);

  private readonly traceLines = buffers(MAX.trace * 2 + 8);
  private readonly galvoLines = buffers(MAX.traceBeams * 2);
  private readonly galvoBeams = new BeamBatch(MAX.traceBeams);
  private readonly galvoSpots = new SpriteBatch(2);

  private readonly novaLines = buffers(MAX.spokes * 2);
  private readonly novaBeams = new BeamBatch(MAX.spokes);
  private readonly novaSpots = new SpriteBatch(MAX.spokes + 1);

  private readonly coreMaterial = additiveLines();
  private readonly sheetMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending });

  constructor() {
    this.group.name = 'Laser presets';
    const names = ['LASER HARP', 'SPECTRUM FAN', 'PHOTON TUNNEL', 'GALVO LISSAJOUS', 'NOVA STARBURST'];
    this.worlds.forEach((world, index) => { world.name = names[index]; world.visible = false; this.group.add(world); });
    this.group.visible = false;
    this.worlds[0].add(lines(this.harpLines, this.coreMaterial), this.harpBeams.mesh, this.harpSpots.sprite);
    this.worlds[1].add(lines(this.fanLines, this.coreMaterial), this.fanBeams.mesh, mesh(this.fanSheets, this.sheetMaterial), this.fanSpots.sprite);
    this.worlds[2].add(lines(this.ringLines, this.coreMaterial), lines(this.coneLines, this.coreMaterial), this.coneBeams.mesh, this.tunnelSpots.sprite);
    this.worlds[3].add(lines(this.traceLines, this.coreMaterial), lines(this.galvoLines, this.coreMaterial), this.galvoBeams.mesh, this.galvoSpots.sprite);
    this.worlds[4].add(lines(this.novaLines, this.coreMaterial), this.novaBeams.mesh, this.novaSpots.sprite);
    this.sprites.push(this.harpSpots, this.fanSpots, this.tunnelSpots, this.galvoSpots, this.novaSpots);
  }

  update(frame: VisualFrame, quality: Quality, gain: number): void {
    const active = frame.state.scene - 20;
    this.group.visible = active >= 0 && active < 5 && frame.state.running && gain > 0;
    for (let index = 0; index < this.worlds.length; index++) this.worlds[index].visible = index === active && this.group.visible;
    if (!this.group.visible) return;
    this.coreMaterial.color.setScalar(gain * 2.2);
    if (active === 0) this.updateHarp(frame, quality, gain);
    else if (active === 1) this.updateFan(frame, quality, gain);
    else if (active === 2) this.updateTunnel(frame, quality, gain);
    else if (active === 3) this.updateGalvo(frame, quality, gain);
    else this.updateNova(frame, quality, gain);
  }

  /** One beam is a bright core line plus a soft haze cylinder tinted with the same hue. */
  private drawBeam(core: GeometryBuffer, vertex: number, haze: BeamBatch, sample: BeamSample): number {
    core.positions.setXYZ(vertex, sample.from.x, sample.from.y, sample.from.z); colorAt(core.colors, vertex++, sample.hue, .92, sample.glow);
    core.positions.setXYZ(vertex, sample.to.x, sample.to.y, sample.to.z); colorAt(core.colors, vertex++, sample.hue, .92, sample.glow * .7);
    haze.add(sample.from, sample.to, sample.width, this.color.setHSL(sample.hue, 1, .5).multiplyScalar(sample.glow));
    return vertex;
  }

  private spot(batch: SpriteBatch, point: Point3, hue: number, value: number, size: number): void {
    if (value > .01) batch.add(point.x, point.y + .01, point.z, hue, .6, value, size);
  }

  private updateHarp(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = LASER_QUALITY[quality], p = frame.state.sceneParams;
    const count = Math.max(3, activeCount(Math.min(q.strings, 6 + Math.floor(p[3] * 26)), frame.state.controls.density, .4));
    this.harpBeams.material.color.setScalar(gain * 1.6); this.harpBeams.opacity.value = .15 + p[7] * .7;
    this.harpSpots.gain.value = gain * 2.5;
    this.harpBeams.begin(); this.harpSpots.begin();
    let vertex = 0;
    for (let index = 0; index < count; index++) {
      const string = sampleHarpString(frame, index, count, this.beam);
      vertex = this.drawBeam(this.harpLines, vertex, this.harpBeams, string);
      this.spot(this.harpSpots, string.to, string.hue, string.spot * 1.4, .05 + string.spot * .08);
      if (index === 0) this.spot(this.harpSpots, string.from, string.hue, .9, .16);
    }
    finish(this.harpLines, vertex); this.harpBeams.end(); this.harpSpots.end();
  }

  private updateFan(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = LASER_QUALITY[quality], p = frame.state.sceneParams;
    const beams = Math.max(2, activeCount(Math.min(q.beamsPerFan, 4 + Math.floor(p[3] * 12)), frame.state.controls.density, .4));
    this.fanBeams.material.color.setScalar(gain * 1.5); this.fanBeams.opacity.value = .45;
    this.sheetMaterial.color.setScalar(gain * 1.2); this.fanSpots.gain.value = gain * 2.5;
    this.fanBeams.begin(); this.fanSpots.begin();
    let vertex = 0, sheet = 0;
    for (let emitter = 0; emitter < q.emitters; emitter++) {
      for (let beam = 0; beam < beams; beam++) {
        const sample = sampleFanBeam(frame, emitter, q.emitters, beam, beams, this.beam);
        vertex = this.drawBeam(this.fanLines, vertex, this.fanBeams, sample);
        this.spot(this.fanSpots, sample.to, sample.hue, sample.spot, .07);
        if (beam === 0) this.spot(this.fanSpots, sample.from, sample.hue, .8, .14);
        else {
          this.fanSheets.positions.setXYZ(sheet, sample.from.x, sample.from.y, sample.from.z); colorAt(this.fanSheets.colors, sheet++, sample.hue, .9, .8 * p[7]);
          this.fanSheets.positions.setXYZ(sheet, this.previous.to.x, this.previous.to.y, this.previous.to.z); colorAt(this.fanSheets.colors, sheet++, sample.hue, .9, .12 * p[7]);
          this.fanSheets.positions.setXYZ(sheet, sample.to.x, sample.to.y, sample.to.z); colorAt(this.fanSheets.colors, sheet++, sample.hue, .9, .12 * p[7]);
        }
        this.previous.to.x = sample.to.x; this.previous.to.y = sample.to.y; this.previous.to.z = sample.to.z;
      }
    }
    finish(this.fanLines, vertex); finish(this.fanSheets, sheet); this.fanBeams.end(); this.fanSpots.end();
  }

  private updateTunnel(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = LASER_QUALITY[quality], p = frame.state.sceneParams;
    const rings = Math.max(3, activeCount(Math.min(q.rings, 6 + Math.floor(p[3] * 18)), frame.state.controls.density, .4));
    const cone = Math.round(p[7] * q.cone);
    this.coneBeams.material.color.setScalar(gain * 1.5); this.coneBeams.opacity.value = .4; this.tunnelSpots.gain.value = gain * 2.5;
    let vertex = 0;
    for (let ring = 0; ring < rings; ring++) {
      sampleRingPoint(frame, ring, rings, 0, this.point);
      for (let segment = 0; segment < q.ringSegments; segment++) {
        sampleRingPoint(frame, ring, rings, (segment + 1) / q.ringSegments, this.other);
        this.ringLines.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z); colorAt(this.ringLines.colors, vertex++, this.point.hue, .92, this.point.glow);
        this.ringLines.positions.setXYZ(vertex, this.other.x, this.other.y, this.other.z); colorAt(this.ringLines.colors, vertex++, this.other.hue, .92, this.other.glow);
        this.point.x = this.other.x; this.point.y = this.other.y; this.point.z = this.other.z; this.point.hue = this.other.hue; this.point.glow = this.other.glow;
      }
    }
    finish(this.ringLines, vertex);
    tunnelEmitter(frame, rings, this.emitter);
    this.beam.from.x = this.emitter.x; this.beam.from.y = this.emitter.y; this.beam.from.z = this.emitter.z;
    this.beam.width = .006 + p[2] * .03;
    this.coneBeams.begin(); this.tunnelSpots.begin();
    vertex = 0;
    for (let index = 0; index < cone; index++) {
      sampleRingPoint(frame, 0, rings, index / cone, this.point);
      this.beam.to.x = this.point.x; this.beam.to.y = this.point.y; this.beam.to.z = this.point.z;
      this.beam.hue = this.point.hue; this.beam.glow = .5 + this.point.glow * .5;
      vertex = this.drawBeam(this.coneLines, vertex, this.coneBeams, this.beam);
    }
    this.spot(this.tunnelSpots, this.emitter, sampleRingPoint(frame, 0, rings, 0, this.point).hue, .9, .18);
    finish(this.coneLines, vertex); this.coneBeams.end(); this.tunnelSpots.end();
  }

  private updateGalvo(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = LASER_QUALITY[quality], p = frame.state.sceneParams;
    const samples = Math.max(8, activeCount(q.trace, frame.state.controls.density, .4));
    const persistence = .2 + p[7] * .8, head = figureHead(frame);
    this.galvoBeams.material.color.setScalar(gain * 1.5); this.galvoBeams.opacity.value = .4; this.galvoSpots.gain.value = gain * 2.5;
    let vertex = 0;
    sampleFigurePoint(frame, head, this.point);
    for (let index = 0; index < samples; index++) {
      const fade = Math.pow(1 - (index + 1) / samples, 1.5);
      sampleFigurePoint(frame, head - persistence * (index + 1) / samples, this.other);
      this.traceLines.positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z); colorAt(this.traceLines.colors, vertex++, this.point.hue, .9, .2 + Math.pow(1 - index / samples, 1.5) * (1 + frame.audio.beat * .5));
      this.traceLines.positions.setXYZ(vertex, this.other.x, this.other.y, this.other.z); colorAt(this.traceLines.colors, vertex++, this.other.hue, .9, .2 + fade * (1 + frame.audio.beat * .5));
      this.point.x = this.other.x; this.point.y = this.other.y; this.point.z = this.other.z; this.point.hue = this.other.hue;
    }
    // A faint screen frame shows where the galvo figure floats in the room.
    const width = (.8 + p[0] * 2) * 1.15, height = width * .7, centerY = 1.4 + p[1] * 2, z = -(2 + p[6] * 3);
    const corners = [[-width, centerY - height], [width, centerY - height], [width, centerY + height], [-width, centerY + height]];
    for (let edge = 0; edge < 4; edge++) for (let end = 0; end < 2; end++) {
      const corner = corners[(edge + end) % 4];
      this.traceLines.positions.setXYZ(vertex, corner[0], corner[1], z); colorAt(this.traceLines.colors, vertex++, sampleFigurePoint(frame, 0, this.other).hue, .3, .12);
    }
    finish(this.traceLines, vertex);
    galvoProjector(frame, this.emitter);
    this.beam.from.x = this.emitter.x; this.beam.from.y = this.emitter.y; this.beam.from.z = this.emitter.z;
    this.beam.width = .005 + p[2] * .025;
    this.galvoBeams.begin(); this.galvoSpots.begin();
    vertex = 0;
    for (let index = 0; index < q.traceBeams; index++) {
      sampleFigurePoint(frame, head - persistence * index / q.traceBeams, this.point);
      this.beam.to.x = this.point.x; this.beam.to.y = this.point.y; this.beam.to.z = this.point.z;
      this.beam.hue = this.point.hue; this.beam.glow = .35 + Math.pow(1 - index / q.traceBeams, 2) * .8;
      vertex = this.drawBeam(this.galvoLines, vertex, this.galvoBeams, this.beam);
    }
    sampleFigurePoint(frame, head, this.point);
    this.spot(this.galvoSpots, this.point, this.point.hue, 1.2 + frame.audio.beat, .07);
    this.spot(this.galvoSpots, this.emitter, this.point.hue, .8, .14);
    finish(this.galvoLines, vertex); this.galvoBeams.end(); this.galvoSpots.end();
  }

  private updateNova(frame: VisualFrame, quality: Quality, gain: number): void {
    const q = LASER_QUALITY[quality], p = frame.state.sceneParams;
    const spokes = Math.max(4, activeCount(Math.min(q.spokes, 8 + Math.floor(p[3] * 56)), frame.state.controls.density, .4));
    this.novaBeams.material.color.setScalar(gain * 1.5); this.novaBeams.opacity.value = .45; this.novaSpots.gain.value = gain * 2.5;
    this.novaBeams.begin(); this.novaSpots.begin();
    let vertex = 0;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const sample = sampleSpoke(frame, spoke, spokes, this.beam);
      vertex = this.drawBeam(this.novaLines, vertex, this.novaBeams, sample);
      this.spot(this.novaSpots, sample.to, sample.hue, sample.spot, .05 + sample.spot * .05);
      if (spoke === 0) this.spot(this.novaSpots, sample.from, sample.hue, 1.2 + frame.audio.bass, .2 + frame.audio.bass * .1);
    }
    finish(this.novaLines, vertex); this.novaBeams.end(); this.novaSpots.end();
  }
}

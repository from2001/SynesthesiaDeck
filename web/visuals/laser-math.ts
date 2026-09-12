import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';
import { TAU, bankDeform, bankHue, fract, zero } from './bank-math';

/** Laser presets are straight beams between an emitter and a target. Targets deform; emitters stay fixed. */
export interface BeamSample { from: Point3; to: Point3; hue: number; glow: number; width: number; spot: number }
export interface LaserPoint extends Point3 { hue: number; glow: number }
export const LASER_SCENE_IDS = [20, 21, 22, 23, 24] as const;
export const LASER_QUALITY = {
  low: { strings: 12, emitters: 2, beamsPerFan: 8, rings: 10, ringSegments: 24, cone: 12, trace: 64, traceBeams: 10, spokes: 24 },
  medium: { strings: 24, emitters: 3, beamsPerFan: 12, rings: 16, ringSegments: 32, cone: 18, trace: 128, traceBeams: 16, spokes: 40 },
  high: { strings: 32, emitters: 4, beamsPerFan: 16, rings: 24, ringSegments: 40, cone: 24, trace: 192, traceBeams: 24, spokes: 64 },
} as const;
export const freshBeam = (): BeamSample => ({ from: zero(), to: zero(), hue: 0, glow: 1, width: .01, spot: 0 });
export const freshPoint = (): LaserPoint => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1 });
const GOLDEN = 2.399963229728653;

/** Beams travel `reach` meters unless they meet the floor first; a floor hit lights a spot. */
function aim(from: Point3, dx: number, dy: number, dz: number, reach: number, out: BeamSample): boolean {
  const length = Math.hypot(dx, dy, dz) || 1;
  dx /= length; dy /= length; dz /= length;
  const floorHit = dy < -1e-4 && -from.y / dy < reach;
  const travel = floorHit ? -from.y / dy : reach;
  out.to.x = from.x + dx * travel; out.to.y = Math.max(0, from.y + dy * travel); out.to.z = from.z + dz * travel;
  return floorHit;
}

/** LASER HARP: string `index` of `count`, fanned from a floor emitter and cut where a hand plucks it. */
export function sampleHarpString(frame: VisualFrame, index: number, count: number, out = freshBeam()): BeamSample {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio, seed = frame.state.seed;
  const position = count > 1 ? index / (count - 1) : .5;
  const angle = (position - .5) * (.35 + p[4] * 1.3), height = 2.5 + p[1] * 3.5, spread = .5 + p[0] * 1.2;
  out.from.x = 0; out.from.y = .04; out.from.z = -1.6;
  out.to.x = Math.sin(angle) * height * spread; out.to.y = .04 + Math.cos(angle) * height; out.to.z = -1.6 - height * .08;
  bankDeform(frame, index + 2000, out.to, .05);
  const band = [audio.level, audio.bass, audio.lowMid, audio.mid, audio.high][index % 5];
  const hand = fract(t * .11 + seeded(seed, 2000));
  const handPulse = Math.exp(-Math.pow((position - hand) * count * .5, 2));
  const beatPluck = audio.beat * (seeded(seed + Math.floor(t * 2), index + 2010) < .35 ? 1 : 0);
  const pluck = Math.max(handPulse, beatPluck);
  const depth = pluck * p[6] * .65;
  out.to.x += (out.from.x - out.to.x) * depth; out.to.y += (out.from.y - out.to.y) * depth; out.to.z += (out.from.z - out.to.z) * depth;
  out.hue = bankHue(frame, .33, index, position * .08);
  out.glow = .35 + band * 1.3 + pluck * 1.2;
  out.width = (.006 + p[2] * .03) * (1 + pluck * .5) * (.7 + p[7] * .6);
  out.spot = pluck;
  return out;
}

/** SPECTRUM FAN: beam `beam` of emitter `emitter`, sweeping with its fan and colored by emitter. */
export function sampleFanBeam(frame: VisualFrame, emitter: number, emitters: number, beam: number, beams: number, out = freshBeam()): BeamSample {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio, seed = frame.state.seed;
  out.from.x = (emitter - (emitters - 1) / 2) * (1.4 + p[0] * 2.4); out.from.y = .3 + p[1] * 3; out.from.z = -3 - p[0] * .5;
  const sweep = Math.sin(t * (.3 + p[4] * .9) + emitter * 2.1 + seeded(seed, 2100) * TAU) * .9;
  const tilt = Math.sin(t * .23 + emitter * 1.7) * .32 + audio.beat * .08 - .02;
  const yaw = sweep + ((beams > 1 ? beam / (beams - 1) : .5) - .5) * (.3 + p[6] * 1.2);
  const floorHit = aim(out.from, Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt), 6 + p[0] * 3, out);
  bankDeform(frame, emitter * 100 + beam + 2100, out.to, 0);
  out.hue = bankHue(frame, emitter * .28, emitter, beam / Math.max(1, beams) * .04);
  out.glow = .6 + audio.level * .6 + (beam % 2 ? audio.high : audio.mid) * .4;
  out.width = .006 + p[2] * .03;
  out.spot = floorHit ? .6 + audio.beat * .6 : 0;
  return out;
}

/** PHOTON TUNNEL: a point at fraction u around ring `ring` of `rings`. */
export function sampleRingPoint(frame: VisualFrame, ring: number, rings: number, u: number, out = freshPoint()): LaserPoint {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio;
  const centerY = 1.5 + p[1] * 2;
  const radius = (1 + p[0] * 1.8) * (1 - ring / Math.max(1, rings) * .3) * (1 + audio.bass * .06);
  const theta = u * TAU + t * (.2 + p[4] * .8) * (ring % 2 ? -1 : 1) + ring * .3;
  out.x = Math.cos(theta) * radius; out.y = centerY + Math.sin(theta) * radius; out.z = -1 - ring * (.18 + p[6] * .45);
  bankDeform(frame, ring + 2200, out);
  out.hue = bankHue(frame, .55, ring, ring / Math.max(1, rings) * .35);
  out.glow = .35 + Math.pow(.5 + .5 * Math.sin(u * TAU * 3 + t * 2 + ring * .7), 6) * 1.3 + audio.beat * .4;
  return out;
}

export function tunnelEmitter(frame: VisualFrame, rings: number, out: Point3 = zero()): Point3 {
  const p = frame.state.sceneParams;
  out.x = 0; out.y = 1.5 + p[1] * 2; out.z = -1 - rings * (.18 + p[6] * .45) - 2.5;
  return out;
}

/** GALVO LISSAJOUS: the figure point at curve fraction s on the floating screen. */
export function sampleFigurePoint(frame: VisualFrame, s: number, out = freshPoint()): LaserPoint {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio;
  const width = .8 + p[0] * 2, height = width * .7, centerY = 1.4 + p[1] * 2;
  const a = 1 + Math.floor(p[3] * 3.999), b = a + 1 + Math.floor(p[3] * 2.999);
  const delta = t * (.2 + p[4] * .6);
  out.x = width * Math.sin(a * s * TAU + delta) * (1 + audio.mid * .1);
  out.y = centerY + height * Math.sin(b * s * TAU) * (1 + audio.bass * .06);
  out.z = -(2 + p[6] * 3);
  bankDeform(frame, 2300, out);
  out.hue = bankHue(frame, s * .5, 0);
  out.glow = 1;
  return out;
}

export function figureHead(frame: VisualFrame): number { return fract(frame.phase * (.5 + frame.state.sceneParams[4] * 1.5)); }

export function galvoProjector(frame: VisualFrame, out: Point3 = zero()): Point3 {
  out.x = 0; out.y = 2.6 + frame.state.sceneParams[1] * .4; out.z = 2.4;
  return out;
}

/** NOVA STARBURST: spoke `spoke` of `spokes` thrown from a hovering emitter. */
export function sampleSpoke(frame: VisualFrame, spoke: number, spokes: number, out = freshBeam()): BeamSample {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio, seed = frame.state.seed;
  out.from.x = 0; out.from.y = 1.6 + p[1] * 2.2; out.from.z = -1.2;
  const ring = spoke % 3;
  const azimuth = spoke * GOLDEN + t * (.2 + p[4]) * (ring === 1 ? -1 : 1) + seeded(seed, 2400) * TAU;
  const elevation = (ring - 1) * (.25 + p[6] * .6) + Math.sin(t * .5 + spoke) * .1;
  const floorHit = aim(out.from, Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth), 5 + p[0] * 6, out);
  bankDeform(frame, spoke + 2400, out.to, 0);
  out.hue = bankHue(frame, .95, spoke, spoke / Math.max(1, spokes) * .5);
  out.glow = .55 + audio.level * .5 + (seeded(seed + Math.floor(t * 4), spoke + 2450) < .3 ? audio.beat * .8 : 0);
  out.width = .005 + p[2] * .025;
  out.spot = floorHit ? (1 + audio.beat) * p[7] : 0;
  return out;
}

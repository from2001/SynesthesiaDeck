import { motionAt, seeded, type AudioFeatures, type ShowState } from '../../shared/protocol';

export interface Point3 { x: number; y: number; z: number }
export interface Calibration { origin: Point3; yaw: number; separation: number }
export interface ParticleIdentity { a: number; b: number; c: number; d: number; index: number }
export interface VisualSample extends Point3 { size: number; angle: number; hue: number }
export interface EffectFrame { contraction: number; flash: number; burst: number; burstOpacity: number; burstSeed: number; oneShots: number[] }
export interface VisualFrame { state: ShowState; audio: AudioFeatures; time: number; phase: number; effects: EffectFrame }
const TAU = Math.PI * 2;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const fract = (v: number) => v - Math.floor(v);

export function particleIdentity(seed: number, index: number): ParticleIdentity {
  return { index, a: seeded(seed, index * 4), b: seeded(seed, index * 4 + 1), c: seeded(seed, index * 4 + 2), d: seeded(seed, index * 4 + 3) };
}

/** A is the shared floor origin; B defines local -Z. Heights do not affect alignment. */
export function solveCalibration(a: Point3, b: Point3): Calibration {
  if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) throw new Error('Calibration coordinates must be finite.');
  const dx = b.x - a.x, dz = b.z - a.z;
  const separation = Math.hypot(dx, dz);
  if (separation < .3) throw new Error('Choose point B at least 30 cm from point A.');
  if (separation > 20) throw new Error('Calibration points must be within 20 meters.');
  return { origin: { x: a.x, y: 0, z: a.z }, yaw: Math.atan2(-dx, -dz), separation };
}

/** Intersect a controller target ray with the local-floor plane. */
export function floorIntersection(origin: Point3, direction: Point3): Point3 | null {
  if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite) || direction.y >= -.025) return null;
  const distance = -origin.y / direction.y;
  if (distance < 0 || distance > 15) return null;
  return { x: origin.x + direction.x * distance, y: 0, z: origin.z + direction.z * distance };
}

export function transformCalibrated(point: Point3, calibration: Calibration): Point3 {
  const c = Math.cos(calibration.yaw), s = Math.sin(calibration.yaw);
  return { x: point.x * c + point.z * s + calibration.origin.x, y: point.y,
    z: -point.x * s + point.z * c + calibration.origin.z };
}

/** Expired and future effects contribute nothing; rejoining never replays a DROP. */
export function evaluateEffects(state: ShowState, time: number): EffectFrame {
  const result: EffectFrame = { contraction: 1, flash: 0, burst: 0, burstOpacity: 0, burstSeed: 0, oneShots: Array(8).fill(0) };
  if (!state.running) return result;
  for (const effect of state.effects) {
    const progress = (time - effect.effectiveAt) / effect.duration;
    if (progress < 0 || progress >= 1) continue;
    const strength = effect.strength * state.controls.masterFX;
    if (effect.kind === 'burst') {
      result.oneShots[effect.slot] = Math.max(result.oneShots[effect.slot], Math.sin(progress * Math.PI) * strength);
      continue;
    }
    const squeeze = progress < .3 ? Math.sin(progress / .3 * Math.PI / 2) : Math.exp(-(progress - .3) * 15);
    result.contraction = Math.min(result.contraction, 1 - squeeze * .78 * strength);
    result.flash = Math.max(result.flash, Math.exp(-Math.pow((progress - .32) / .046, 2)) * strength);
    const expansion = clamp((progress - .3) / .7);
    if (progress >= .3) {
      result.burst = Math.max(result.burst, expansion * (5 + strength * 8));
      const opacity = Math.sin(expansion * Math.PI) * strength;
      if (opacity > result.burstOpacity) { result.burstOpacity = opacity; result.burstSeed = effect.seed; }
    }
  }
  return result;
}

export function visualFrame(state: ShowState, audio: AudioFeatures, time: number): VisualFrame {
  const effects = evaluateEffects(state, time);
  const freeze = effects.oneShots[7] > .001 ? state.effects.find(effect => effect.kind === 'burst' && effect.slot === 7 && time >= effect.effectiveAt && time < effect.effectiveAt + effect.duration) : undefined;
  const phase = freeze ? (freeze.frozenPhase ?? motionAt(state, freeze.effectiveAt)) : motionAt(state, time);
  return { state, audio, time, phase, effects };
}

/** Evaluate an original-bank particle from absolute phase. Experimental banks own their mesh samplers. */
export function sampleParticle(frame: VisualFrame, identity: ParticleIdentity, out: VisualSample = { x: 0, y: 0, z: 0, size: 1, angle: 0, hue: 0 }): VisualSample {
  const { state, audio, phase: t, effects } = frame;
  const p = state.sceneParams, { a, b, c, d, index } = identity;
  // Bounded phase modulation avoids large jumps when audio changes after a long show.
  const flow = t + Math.sin(t * .7) * audio.bass * .35;
  let angle = a * TAU, radius = 1, x = 0, y = 0, z = 0;
  let size = .025 + p[2] * .07;
  switch (state.scene) {
    case 0: {
      // Six radial code walls leave a clear central aisle and form a vaulted ceiling.
      const wall = index % 6, column = Math.floor(index / 6) % 18;
      angle = wall * TAU / 6;
      radius = 2.2 + p[0] * 2.8 + Math.sin(column / 18 * Math.PI) * p[6];
      const across = (column / 17 - .5) * (1.8 + p[0] * 2);
      const rain = fract(b - flow * (.045 + p[3] * .075) * (1 + audio.mid * .3));
      x = Math.cos(angle) * radius - Math.sin(angle) * across;
      z = Math.sin(angle) * radius + Math.cos(angle) * across;
      y = .15 + rain * (3 + p[1] * 3.5);
      size = (.14 + p[2] * .3) * (1 + audio.beat * .35);
      break;
    }
    case 1: {
      const strands = 2 + Math.floor(p[3] * 10);
      const travel = fract(c + flow * (.025 + p[6] * .07));
      angle += travel * TAU * (1 + p[6] * 3) + (index % strands) * TAU / strands;
      radius = (.5 + b * (2 + p[0] * 4)) * (1 + .2 * Math.sin(travel * TAU * 2 + flow));
      const curl = (p[4] + audio.mid * .5) * Math.sin(angle * 3 + flow * .7 + c * 9);
      x = Math.cos(angle) * radius + curl;
      z = Math.sin(angle) * radius + Math.cos(y + angle * 2) * curl;
      y = .3 + travel * (2 + p[1] * 5) + Math.sin(angle * 2 + flow) * .3;
      size *= .7 + audio.high * p[7] * 1.5 + .3 * d;
      break;
    }
    case 2: {
      const column = index % 31, row = Math.floor(index / 31) % 31;
      const spacing = .25 + p[0] * .25;
      x = (column - 15) * spacing; z = (row - 15) * spacing;
      radius = Math.hypot(x, z);
      const wave = Math.pow(.5 + .5 * Math.sin(radius * (1 + p[3] * 4) - flow * 2), 3);
      y = .15 + (.15 + b * b * (1 + p[1] * 4)) * (.4 + audio.bass * 1.1 + wave * .65);
      size = spacing * (.18 + (1 - p[2]) * .55) * (1 - p[4] * b * .45);
      break;
    }
    case 3: {
      const lane = index % (2 + Math.floor(p[3] * 16));
      const travel = fract(c + flow * (.12 + p[7] * .13));
      angle += flow * (d - .5) * (1 + p[4] * 5) + lane;
      radius = .7 + travel * (2 + p[0] * 5);
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      y = .4 + b * (2 + p[1] * 5) + Math.sin(flow + lane) * .4;
      size = (.025 + p[2] * .18) * (.5 + d);
      break;
    }
    case 4: {
      const inward = 1 - fract(c + flow * (.05 + p[7] * .1));
      const arms = 2 + Math.floor(p[3] * 8);
      radius = .2 + inward * inward * (2 + p[0] * 5);
      angle = (index % arms) * TAU / arms + inward * (4 + p[4] * 14) - flow * .45 + (a - .5) * .55;
      x = Math.cos(angle) * radius; z = Math.sin(angle) * radius;
      y = 1 + p[1] * 2 + (b - .5) * inward * (1 + p[7] * 2);
      size *= .5 + inward * .8;
      break;
    }
  }
  const distortion = state.controls.distortion * (.2 + audio.mid * .7);
  x += Math.sin(y * 2 + t + c * 8) * distortion;
  z += Math.cos(y * 1.7 - t + a * 7) * distortion;
  const twist = (state.toggles[2] ? state.controls.masterFX : 0) + effects.oneShots[2];
  const twisted = y * twist * .5;
  const tx = x * Math.cos(twisted) - z * Math.sin(twisted);
  z = x * Math.sin(twisted) + z * Math.cos(twisted); x = tx;
  if (((state.toggles[3] && state.controls.masterFX > .05) || effects.oneShots[3] > .15) && index % 2 === 0) x = -x;
  const scatter = (state.toggles[4] ? state.controls.masterFX : 0) + effects.oneShots[4];
  x += (a - .5) * scatter * 3; y += (b - .5) * scatter * 2; z += (c - .5) * scatter * 3;
  const glitch = state.controls.glitch * audio.high + effects.oneShots[6] * .2;
  const tick = Math.floor(frame.time / 80);
  if (seeded(state.seed + tick, index) < glitch * .35) x += (d - .5) * (1 + glitch * 5);
  out.x = x; out.y = y; out.z = z;
  out.size = size; out.angle = angle + t * (d - .5) * p[4];
  out.hue = fract([.42, .51, .55, .86, .67][state.scene] + (p[5] - .5) * .6 + a * .16 +
    (state.toggles[6] ? t * .06 : 0) + effects.oneShots[6] * .3);
  return out;
}

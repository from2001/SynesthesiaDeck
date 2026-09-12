import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';

/** Shared deterministic helpers for the Echo, Laser and Uncharted banks. Only absolute phase and seeds are used. */
export const TAU = Math.PI * 2;
export const fract = (value: number): number => value - Math.floor(value);
export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export function smooth(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
export const zero = (): Point3 => ({ x: 0, y: 0, z: 0 });

/** Palette hue shares the knob-6 shift and the Prism toggle/one-shot with every other bank. */
export function bankHue(frame: VisualFrame, baseHue: number, identity: number, variation = 0): number {
  const prism = (frame.state.toggles[6] ? frame.phase * .035 * frame.state.controls.masterFX : 0) + frame.effects.oneShots[6] * .3;
  return fract(baseHue + (frame.state.sceneParams[5] - .5) * .8 + seeded(frame.state.seed, identity + 4111) * .05 + variation + prism);
}

/** Distortion, Twist, Mirror, Scatter and Glitch for one identity; elements sharing an identity deform together. */
export function bankDeform(frame: VisualFrame, identity: number, out: Point3, floor = -Infinity): Point3 {
  const { state, phase: t, audio, effects } = frame;
  const a = seeded(state.seed, identity * 3 + 5301), b = seeded(state.seed, identity * 3 + 5302), c = seeded(state.seed, identity * 3 + 5303);
  const distortion = state.controls.distortion * (.1 + audio.mid * .2);
  out.x += Math.sin(out.y * 1.7 + t * .4 + a * TAU) * distortion;
  out.z += Math.cos(out.y * 1.3 - t * .33 + b * TAU) * distortion;
  const twist = (state.toggles[2] ? state.controls.masterFX : 0) + effects.oneShots[2];
  const angle = out.y * twist * .25, x = out.x;
  out.x = x * Math.cos(angle) - out.z * Math.sin(angle);
  out.z = x * Math.sin(angle) + out.z * Math.cos(angle);
  if (((state.toggles[3] && state.controls.masterFX > .05) || effects.oneShots[3] > .15) && identity % 2 === 0) out.x = -out.x;
  const scatter = (state.toggles[4] ? state.controls.masterFX : 0) + effects.oneShots[4];
  out.x += (a - .5) * scatter * 3; out.y += (b - .5) * scatter * .8; out.z += (c - .5) * scatter * 3;
  const glitch = state.controls.glitch * (.08 + audio.high * .7);
  // Quantize the authoritative motion phase, never local frame count or arrival time.
  if (seeded(state.seed + Math.floor(t * 11), identity + 917) < glitch * .2) out.x += (a - .5) * glitch * 2;
  if (out.y < floor) out.y = floor;
  return out;
}

/** The displacement an anchor receives, so multi-part objects (figures, bursts) can move rigidly with it. */
export function rigidDelta(frame: VisualFrame, identity: number, anchor: Point3, delta: Point3, floor = -Infinity): Point3 {
  delta.x = anchor.x; delta.y = anchor.y; delta.z = anchor.z;
  bankDeform(frame, identity, delta, floor);
  delta.x -= anchor.x; delta.y -= anchor.y; delta.z -= anchor.z;
  return delta;
}

export function activeCount(maximum: number, density: number, floor = .3): number {
  return Math.max(1, Math.round(maximum * (floor + (1 - floor) * density)));
}

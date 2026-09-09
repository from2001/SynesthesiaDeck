import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';

export interface OrganicSample extends Point3 { hue: number; glow: number }
export interface BranchSample extends OrganicSample { startX: number; startY: number; startZ: number; radius: number; depth: number }
export interface BirdSample extends OrganicSample { heading: number; bank: number; flap: number; span: number }
export const TAU = Math.PI * 2;
const ORGANIC_HUES = [.43, .23, .58, .58, .065] as const;
const wrap = (value: number) => ((value % 1) + 1) % 1;
const fresh = (): OrganicSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1 });

export function organicHue(frame: VisualFrame, scene: number, identity: number, variation = 0): number {
  const prism = (frame.state.toggles[6] ? frame.phase * .035 * frame.state.controls.masterFX : 0) + frame.effects.oneShots[6] * .3;
  return wrap(ORGANIC_HUES[scene - 5] + (frame.state.sceneParams[5] - .5) * .8 + seeded(frame.state.seed, identity + 721) * .06 + variation + prism);
}

/** Continuous surfaces share an identity, so their deformation never tears at a vertex seam. */
export function deformOrganic(frame: VisualFrame, identity: number, out: Point3): void {
  const { state, phase: t, audio, effects } = frame;
  const a = seeded(state.seed, identity * 3 + 8301), b = seeded(state.seed, identity * 3 + 8302), c = seeded(state.seed, identity * 3 + 8303);
  const distortion = state.controls.distortion * (.12 + audio.mid * .22);
  out.x += Math.sin(out.y * 1.8 + t * .45 + a * TAU) * distortion;
  out.z += Math.cos(out.y * 1.4 - t * .37 + b * TAU) * distortion;
  const twist = (state.toggles[2] ? state.controls.masterFX : 0) + effects.oneShots[2];
  const angle = out.y * twist * .25, x = out.x;
  out.x = x * Math.cos(angle) - out.z * Math.sin(angle);
  out.z = x * Math.sin(angle) + out.z * Math.cos(angle);
  if (((state.toggles[3] && state.controls.masterFX > .05) || effects.oneShots[3] > .15) && identity % 2 === 0) out.x = -out.x;
  const scatter = (state.toggles[4] ? state.controls.masterFX : 0) + effects.oneShots[4];
  out.x += (a - .5) * scatter * 3; out.y += (b - .5) * scatter * .8; out.z += (c - .5) * scatter * 3;
  const glitch = state.controls.glitch * (.08 + audio.high * .7);
  // Quantize the authoritative motion phase, never local frame count or arrival time.
  if (seeded(state.seed + Math.floor(t * 11), identity + 611) < glitch * .2) out.x += (a - .5) * glitch * 2;
}

/** u follows a ribbon's length; v crosses its translucent curtain. */
export function sampleSilk(frame: VisualFrame, ribbon: number, u: number, v: number, out = fresh()): OrganicSample {
  const p = frame.state.sceneParams, t = frame.phase;
  const a = seeded(frame.state.seed, ribbon * 4 + 10), b = seeded(frame.state.seed, ribbon * 4 + 11);
  const length = 5 + p[6] * 6, width = .25 + p[2] * 1.1;
  const wave = u * TAU * (1 + p[3] * 2) - t * .45 + a * TAU;
  const curl = (.18 + p[4] * .9) * Math.sin(wave);
  out.x = (u - .5) * length + Math.sin(wave * .5) * p[0] * .55;
  out.y = 1.5 + p[1] * 3 + (b - .5) * (1 + p[0]) + curl + (v - .5) * width;
  out.z = (ribbon % 5 - 2) * (.45 + p[0] * .55) + Math.sin(u * TAU * .7 + t * .23 + b * TAU) * (.3 + p[4] * .65);
  out.z += Math.sin(wave * 1.4 + v * Math.PI * (2 + p[3] * 3)) * width * (.12 + p[4] * .25);
  out.y += Math.sin(v * Math.PI * 3 + wave) * p[2] * .12;
  out.hue = organicHue(frame, 5, ribbon, v * .07 + u * .045);
  out.glow = .55 + Math.pow(Math.sin(u * 13 - t + ribbon) * .5 + .5, 5) * p[7] * (.7 + frame.audio.high);
  deformOrganic(frame, ribbon + 100, out);
  return out;
}

/** Binary branch topology has 63 segments and 32 terminal canopies per colony. */
export function sampleBranch(frame: VisualFrame, colony: number, branch: number, out: BranchSample): BranchSample {
  const p = frame.state.sceneParams, t = frame.phase;
  const a = seeded(frame.state.seed, colony * 3 + 200), b = seeded(frame.state.seed, colony * 3 + 201);
  const depth = Math.floor(Math.log2(branch + 1)), code = branch + 1;
  const rootAngle = colony * 2.399963 + a * .5, rootRadius = Math.sqrt(colony + .5) * (.45 + p[0] * .42);
  let x = Math.cos(rootAngle) * rootRadius, y = .06, z = Math.sin(rootAngle) * rootRadius;
  let azimuth = a * TAU, elevation = 0;
  out.startX = x; out.startY = y; out.startZ = z;
  for (let level = 0; level <= depth; level++) {
    const sign = level === 0 ? 0 : ((code >> (depth - level)) & 1) ? 1 : -1;
    azimuth += sign * (.42 + p[3] * .88) + b * .3;
    elevation += sign * (.12 + p[6] * .3);
    const segmentLength = (.68 + p[1] * .84) * Math.pow(.73, level);
    const spread = level === 0 ? .05 : (.32 + p[6] * .5) * (1 + Math.abs(elevation));
    out.startX = x; out.startY = y; out.startZ = z;
    x += Math.cos(azimuth) * segmentLength * spread;
    z += Math.sin(azimuth) * segmentLength * spread;
    y += segmentLength * (.94 - Math.min(.4, Math.abs(elevation) * .22));
    x += Math.sin(t * .48 + colony + y) * p[4] * .04 * (level + 1);
    z += Math.cos(t * .39 + b * TAU + y) * p[4] * .035 * (level + 1);
  }
  out.x = out.startX; out.y = out.startY; out.z = out.startZ;
  deformOrganic(frame, colony + 301, out);
  out.startX = out.x; out.startY = out.y; out.startZ = out.z;
  out.x = x; out.y = y; out.z = z;
  deformOrganic(frame, colony + 301, out);
  out.radius = (.025 + p[2] * .085) * Math.pow(.68, depth) * (1 + frame.audio.bass * .25);
  out.depth = depth;
  out.hue = organicHue(frame, 6, colony, depth * .024);
  out.glow = .65 + frame.audio.mid * .55 + Math.sin(t * .8 + colony) * p[7] * .12;
  return out;
}

/** Spore drift is periodic and seeded, with no lifetime integration. */
export function sampleSpore(frame: VisualFrame, id: number, out = fresh()): OrganicSample {
  const p = frame.state.sceneParams, t = frame.phase;
  const a = seeded(frame.state.seed, id * 3 + 400), b = seeded(frame.state.seed, id * 3 + 401), c = seeded(frame.state.seed, id * 3 + 402);
  const cycle = wrap(c + t * (.025 + p[7] * .06));
  out.x = (a - .5) * (3 + p[0] * 5) + Math.sin(cycle * TAU + b * 8) * (.1 + p[7] * .6);
  out.y = .8 + cycle * (2 + p[1] * 3);
  out.z = (b - .5) * (3 + p[0] * 5) + Math.cos(t * .2 + a * 7) * p[7] * .5;
  out.hue = organicHue(frame, 6, id, .05); out.glow = Math.sin(cycle * Math.PI) * .9;
  deformOrganic(frame, id + 400, out);
  return out;
}

function jellyCenter(frame: VisualFrame, jelly: number, out: Point3): void {
  const p = frame.state.sceneParams;
  const a = seeded(frame.state.seed, jelly * 3 + 500), b = seeded(frame.state.seed, jelly * 3 + 501);
  const angle = jelly * 2.399963 + a, radius = Math.sqrt(jelly + .4) * (.65 + p[0] * .6);
  out.x = Math.cos(angle) * radius + Math.sin(frame.phase * .23 + a * TAU) * .3;
  out.z = Math.sin(angle) * radius + Math.cos(frame.phase * .19 + a * TAU) * .3;
  out.y = 2.5 + p[1] * 2 + b * .5 + Math.sin(frame.phase * .7 + a * TAU) * (.08 + p[4] * .22);
}

export function sampleBell(frame: VisualFrame, jelly: number, u: number, v: number, out = fresh()): OrganicSample {
  const p = frame.state.sceneParams, t = frame.phase;
  jellyCenter(frame, jelly, out);
  const azimuth = u * TAU, polar = v * Math.PI / 2;
  const pulse = 1 + Math.sin(t * (1 + p[4]) + jelly) * (.04 + p[4] * .1) + frame.audio.bass * .055;
  const radius = (.32 + p[6] * .7) * pulse;
  const ribs = 8 + Math.floor(p[2] * 12);
  const radial = Math.sin(polar) * radius * (1 + Math.cos(azimuth * ribs) * .035 * v);
  out.x += Math.cos(azimuth) * radial; out.z += Math.sin(azimuth) * radial;
  out.y += Math.cos(polar) * radius * .7 - Math.pow(v, 5) * (.05 + p[3] * .08) * Math.sin(azimuth * 12);
  out.hue = organicHue(frame, 7, jelly, .1 * v);
  out.glow = .8 + Math.pow(Math.abs(Math.cos(azimuth * ribs / 2)), 10) * .7 + (1 - v) * .2;
  deformOrganic(frame, jelly + 500, out);
  return out;
}

export function sampleTendril(frame: VisualFrame, jelly: number, tendril: number, u: number, out = fresh()): OrganicSample {
  const p = frame.state.sceneParams, t = frame.phase;
  jellyCenter(frame, jelly, out);
  const angle = tendril * 2.399963 + jelly, radius = (.25 + p[6] * .65) * (.55 + (tendril % 3) * .16);
  const curl = Math.sin(u * Math.PI * (2 + p[7] * 3) - t * .8 + tendril) * u * (.09 + p[7] * .4);
  out.x += Math.cos(angle) * radius + curl;
  out.z += Math.sin(angle) * radius + Math.cos(u * Math.PI * 4 - t * .7 + tendril) * u * (.08 + p[7] * .3);
  out.y -= u * (1.5 + p[7] * 1.2 + (tendril % 4) * .13);
  out.hue = organicHue(frame, 7, jelly, u * .12);
  out.glow = 1 - u * .6 + frame.audio.high * .3;
  deformOrganic(frame, jelly + 500, out);
  return out;
}

/** Radial fluid harmonics produce one closed, normal-shaded surface. */
export function sampleMercury(frame: VisualFrame, droplet: number, u: number, v: number, out = fresh()): OrganicSample {
  const p = frame.state.sceneParams, t = frame.phase;
  const a = seeded(frame.state.seed, droplet + 610), azimuth = u * TAU, polar = v * Math.PI;
  const lobes = 2 + Math.floor(p[6] * 6), belt = Math.sin(polar);
  const radius = (1.25 + p[0] * 1.35) * (droplet === 0 ? 1 : .08 + a * .075);
  const viscosity = .16 + (1 - p[4]) * .75;
  const swell = Math.sin(azimuth * lobes + t * viscosity + a * TAU) * belt * belt;
  const ripples = Math.sin(polar * (4 + p[3] * 14) - t * viscosity * 1.8 + a) * belt;
  const r = radius * (1 + swell * (.055 + p[2] * .15) + ripples * p[2] * .055 + frame.audio.bass * .035);
  out.x = Math.cos(azimuth) * belt * r;
  out.y = Math.cos(polar) * r * .82 + (1.25 + p[0] * 1.35) * .9 + .3 + p[1] * 1.4;
  out.z = Math.sin(azimuth) * belt * r;
  if (droplet > 0) {
    const theta = droplet * 2.399963 + t * (.1 + a * .04), orbit = 1.9 + p[0] * 1.65;
    out.x += Math.cos(theta) * orbit;
    out.z += Math.sin(theta) * orbit;
    out.y += Math.sin(theta * 2 + a) * (.3 + p[1] * .6);
  }
  out.hue = organicHue(frame, 8, droplet, belt * .025);
  out.glow = .4 + p[7] * 1.6;
  deformOrganic(frame, droplet + 601, out);
  return out;
}

export function sampleBird(frame: VisualFrame, bird: number, out: BirdSample, phase = frame.phase): BirdSample {
  const p = frame.state.sceneParams;
  const a = seeded(frame.state.seed, bird * 3 + 700), b = seeded(frame.state.seed, bird * 3 + 701), c = seeded(frame.state.seed, bird * 3 + 702);
  const angle = phase * .24 + a * TAU;
  const radius = 1 + p[0] * 2.5 + b * (1 - p[6]) * 2.7;
  out.x = Math.cos(angle) * radius + Math.sin(angle * 2) * (.3 + p[6]);
  out.z = Math.sin(angle) * radius * .72 + (c - .5) * (1 - p[6]);
  out.y = 1.4 + p[1] * 3.4 + Math.sin(angle * 2 + b) * (.3 + p[4] * .4) + (b - .5) * (1.2 - p[6]);
  out.heading = Math.atan2(Math.sin(angle) * radius - Math.cos(angle * 2) * 2 * (.3 + p[6]), -Math.cos(angle) * radius * .72);
  out.bank = Math.sin(angle * 2 + c * TAU) * (.08 + p[4] * .7);
  out.flap = Math.sin(phase * (2 + p[3] * 8) + a * TAU) * (.3 + p[4] * .3);
  out.span = (.11 + p[2] * .38) * (.65 + b * .45) * (1 + frame.audio.beat * .12);
  out.hue = organicHue(frame, 9, bird, (c - .5) * .035);
  out.glow = .8 + frame.audio.high * .4 + p[7] * .25;
  deformOrganic(frame, bird + 700, out);
  return out;
}

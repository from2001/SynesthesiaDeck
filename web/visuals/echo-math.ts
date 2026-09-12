import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';
import { TAU, bankDeform, bankHue, fract } from './bank-math';

/** Echo presets extend the Signal, Organic and Structures vocabularies. Every sampler is a pure function of the frame. */
export interface EchoSample extends Point3 { hue: number; glow: number }
export interface NodeSample extends EchoSample { cluster: number; member: number; size: number }
export interface PendulumSample extends EchoSample { pivotX: number; pivotY: number; pivotZ: number; length: number; size: number }
export interface LinkSample { a: number; b: number; active: boolean }
export const ECHO_SCENE_IDS = [15, 16, 17, 18, 19] as const;
export const ECHO_QUALITY = {
  low: { traces: 10, samples: 64, clusters: 4, members: 6, strands: 12, spineSegments: 18, bubbles: 40, curtains: 2, rays: 32, pendulums: 16, ghosts: 4 },
  medium: { traces: 18, samples: 96, clusters: 6, members: 10, strands: 24, spineSegments: 24, bubbles: 90, curtains: 3, rays: 48, pendulums: 28, ghosts: 8 },
  high: { traces: 28, samples: 128, clusters: 8, members: 12, strands: 36, spineSegments: 32, bubbles: 150, curtains: 4, rays: 64, pendulums: 40, ghosts: 10 },
} as const;
export const CURTAIN_U = 64, CURTAIN_V = 6, MAX_BLADES = 16;
export const PENDULUM_CYCLE = 24, PENDULUM_BASE = 16;
export const fresh = (): EchoSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1 });
export const freshNode = (): NodeSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1, cluster: 0, member: 0, size: 0 });
export const freshPendulum = (): PendulumSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1, pivotX: 0, pivotY: 0, pivotZ: 0, length: 0, size: 0 });
const GOLDEN = 2.399963229728653;

/** WAVEFORM ATLAS: trace `trace` of `count`, sampled at u along a curved signal wall. */
export function sampleTrace(frame: VisualFrame, trace: number, count: number, u: number, out = fresh()): EchoSample {
  const p = frame.state.sceneParams, t = frame.phase, audio = frame.audio, seed = frame.state.seed;
  const a = seeded(seed, trace * 3 + 100), b = seeded(seed, trace * 3 + 101), c = seeded(seed, trace * 3 + 102);
  const radius = 2.2 + p[0] * 3, arc = TAU * (.18 + p[6] * .82), angle = -Math.PI / 2 + (u - .5) * arc;
  const level = count > 1 ? trace / (count - 1) : .5;
  const band = [audio.level, audio.bass, audio.lowMid, audio.mid, audio.high][trace % 5];
  const sweep = t * (.05 + p[4] * .4) * (trace % 2 ? -1 : 1);
  const wave = Math.sin(u * TAU * (2 + a * 4) + sweep * TAU + a * TAU) * .55
    + Math.sin(u * TAU * (5 + b * 9) - sweep * TAU * 1.7 + b * TAU) * .3
    + Math.sin(u * TAU * (11 + c * 13) + sweep * TAU * .6) * .15;
  const spikeDistance = Math.abs(fract(u - fract(sweep * .5 + c) + .5) - .5);
  const spike = Math.exp(-Math.pow(spikeDistance * 28, 2)) * (.3 + audio.beat) * p[7];
  const amplitude = (.06 + p[2] * .35) * (.35 + band * 1.2);
  out.x = Math.cos(angle) * radius; out.z = Math.sin(angle) * radius;
  out.y = .6 + level * (1.5 + p[1] * 3.2) + wave * amplitude + spike * (.15 + p[2] * .3);
  out.hue = bankHue(frame, .5, trace, level * .12);
  out.glow = .45 + Math.abs(wave) * .6 + spike * 1.5 + band * .35;
  bankDeform(frame, trace + 100, out);
  return out;
}

/** SYNAPSE RELAY: node `node` inside `clusters` × `members`; member 0 of each cluster is its hub. */
export function sampleNode(frame: VisualFrame, node: number, clusters: number, members: number, out = freshNode()): NodeSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const cluster = Math.floor(node / members), member = node % members;
  const a = seeded(seed, cluster * 3 + 200), b = seeded(seed, cluster * 3 + 201);
  const angle = cluster * GOLDEN + a * TAU, radius = (1.2 + p[0] * 3.5) * Math.sqrt((cluster + .5) / Math.max(1, clusters));
  out.x = Math.cos(angle) * radius; out.z = Math.sin(angle) * radius; out.y = 1 + p[1] * 3 + (b - .5) * 1.2;
  const ma = seeded(seed, node * 3 + 230), mb = seeded(seed, node * 3 + 231), mc = seeded(seed, node * 3 + 232);
  if (member > 0) {
    const theta = ma * TAU, phi = Math.acos(2 * mb - 1), r = (.35 + p[6] * 1.1) * (.45 + mc * .55);
    out.x += Math.sin(phi) * Math.cos(theta) * r; out.y += Math.cos(phi) * r * .7; out.z += Math.sin(phi) * Math.sin(theta) * r;
  }
  out.x += Math.sin(t * .3 + ma * TAU) * .06; out.y += Math.cos(t * .27 + mb * TAU) * .05; out.z += Math.sin(t * .24 + mc * TAU) * .06;
  out.cluster = cluster; out.member = member;
  out.size = (.03 + p[2] * .09) * (member === 0 ? 1.8 : .7 + mc * .6) * (1 + frame.audio.bass * .2);
  out.hue = bankHue(frame, .64, cluster, member ? .05 : -.04);
  out.glow = .5 + frame.audio.mid * .3;
  bankDeform(frame, node + 200, out);
  return out;
}

export function linksPerCluster(members: number): number { return 2 * members + 1; }

/** Link slots per cluster: hub spokes, seeded ring links, the chain to the next hub and a long jump. */
export function sampleLink(frame: VisualFrame, link: number, clusters: number, members: number, out: LinkSample = { a: 0, b: 0, active: false }): LinkSample {
  const p = frame.state.sceneParams, per = linksPerCluster(members);
  const cluster = Math.floor(link / per), slot = link % per, hub = cluster * members;
  if (slot < members - 1) { out.a = hub; out.b = hub + slot + 1; out.active = true; }
  else if (slot < 2 * members - 1) {
    const member = slot - (members - 1);
    out.a = hub + member; out.b = hub + (member + 1) % members;
    out.active = seeded(frame.state.seed, link + 300) < p[3] * 1.2;
  } else if (slot === 2 * members - 1) { out.a = hub; out.b = ((cluster + 1) % clusters) * members; out.active = clusters > 1; }
  else { out.a = hub; out.b = ((cluster + 2) % clusters) * members; out.active = clusters > 2 && seeded(frame.state.seed, link + 300) < (p[3] - .5) * 2; }
  return out;
}

/** Packet travel is a periodic fraction of absolute phase; the arrival pulse lights the destination node. */
export function packetTravel(frame: VisualFrame, link: number, packet: number): { travel: number; forward: boolean } {
  const p = frame.state.sceneParams, seed = frame.state.seed;
  const a = seeded(seed, link * 2 + packet + 350), b = seeded(seed, link * 2 + packet + 900);
  return { travel: fract(frame.phase * (.15 + p[4] * .55) * (.7 + a * .6) + b), forward: seeded(seed, link + 1200) < .5 };
}

/** KELP FOREST: spine point of strand `strand` at height fraction v (v may exceed 1 for rising bubbles). */
export function sampleKelp(frame: VisualFrame, strand: number, maxStrands: number, v: number, out = fresh()): EchoSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, strand * 3 + 400), b = seeded(seed, strand * 3 + 401);
  const angle = strand * GOLDEN + a * .6, radius = Math.sqrt((strand + .5) / Math.max(1, maxStrands)) * (1 + p[0] * 3.2);
  const height = (1.4 + p[1] * 3.4) * (.6 + b * .5);
  const amplitude = (.12 + p[4] * .8) * (1 + frame.audio.bass * .25);
  out.x = Math.cos(angle) * radius + Math.sin(t * (.35 + p[4] * .6) + v * 2.6 + a * TAU) * v * v * amplitude;
  out.z = Math.sin(angle) * radius + Math.cos(t * (.27 + p[4] * .5) + v * 2.1 + b * TAU) * v * v * amplitude * .6;
  out.y = v * height;
  out.hue = bankHue(frame, .34, strand, v * .07);
  out.glow = .5 + Math.min(1, v) * .4 + frame.audio.mid * .3;
  bankDeform(frame, strand + 400, out, 0);
  return out;
}

export function kelpHeight(frame: VisualFrame, strand: number): number {
  return (1.4 + frame.state.sceneParams[1] * 3.4) * (.6 + seeded(frame.state.seed, strand * 3 + 401) * .5);
}

/** A blade is a rigid diamond attached to its spine point: corners are root, left, tip, right. */
export function sampleBlade(frame: VisualFrame, strand: number, maxStrands: number, blade: number, blades: number, corner: number, out = fresh()): EchoSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, strand * 3 + 400), c = seeded(seed, strand * 41 + blade + 460);
  const v = .12 + (blade + .5) / Math.max(1, blades) * .88;
  sampleKelp(frame, strand, maxStrands, v, out);
  const side = blade % 2 ? 1 : -1, heading = strand * GOLDEN + a * .6 + side * Math.PI / 2 + Math.sin(t * (1.2 + p[4]) + blade + a * TAU) * .35;
  const length = (.15 + p[2] * .45) * (.8 + c * .4), width = length * .35, droop = length * p[6] * .9;
  const dx = Math.cos(heading), dz = Math.sin(heading);
  const along = corner === 2 ? length : corner === 0 ? 0 : length * .45;
  const across = corner === 1 ? width : corner === 3 ? -width : 0;
  out.x += dx * along - dz * across; out.z += dz * along + dx * across;
  out.y += -droop * Math.pow(along / length, 2) + Math.sin(t * .9 + blade) * .01;
  out.hue += (along / length) * .05;
  out.glow = (.55 + (along / length) * .5) * (.7 + frame.audio.high * .5);
  return out;
}

/** Bubbles ride their strand's sway upward on a periodic, seeded cycle. */
export function sampleBubble(frame: VisualFrame, index: number, maxStrands: number, out = fresh()): EchoSample {
  const p = frame.state.sceneParams, seed = frame.state.seed;
  const strand = index % maxStrands, a = seeded(seed, index * 3 + 480), b = seeded(seed, index * 3 + 481);
  const cycle = fract(b + frame.phase * (.04 + p[7] * .12) * (.8 + a * .4));
  sampleKelp(frame, strand, maxStrands, cycle * 1.15, out);
  out.x += (a - .5) * .35 + Math.sin(frame.phase * 1.3 + a * TAU) * .05; out.z += (b - .5) * .35;
  out.glow = Math.sin(cycle * Math.PI) * (.6 + p[7] * .6);
  out.hue = bankHue(frame, .34, strand, .18);
  return out;
}

/** AURORA CURTAIN: u runs along the folded hanging path, v climbs from the ray tips to the top edge. */
export function sampleCurtain(frame: VisualFrame, curtain: number, u: number, v: number, out = fresh()): EchoSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, curtain * 3 + 500), b = seeded(seed, curtain * 3 + 501);
  const span = 3 + p[0] * 6, top = 3.2 + p[1] * 2.5, rayLength = 1 + p[2] * 2;
  const frequency = 1 + p[3] * 3, ripple = t * (.15 + p[4] * .45);
  const pattern = Math.pow(.5 + .5 * Math.sin(u * TAU * (9 + b * 6) - ripple * 3.5 + a * TAU), 3) * (.5 + p[7] * .5 + frame.audio.high * p[7] * 1.6)
    + Math.pow(.5 + .5 * Math.sin(u * TAU * (23 + a * 10) + ripple * 2.2), 5) * .5;
  const bottom = top - rayLength * (.55 + Math.min(1.2, pattern) * .45);
  out.x = (u - .5) * span + (a - .5) * 1.2;
  out.z = -1.8 - curtain * 1.3 + Math.sin(u * TAU * frequency + ripple + a * TAU) * (.25 + p[6] * 1.2)
    + Math.sin(u * TAU * frequency * 2.3 - ripple * 1.4 + b * TAU) * (.1 + p[6] * .35);
  out.y = bottom + v * (top - bottom);
  out.hue = bankHue(frame, .38, curtain, v * .42);
  out.glow = Math.pow(1 - v, 1.6) * (.35 + pattern * .9) + .04;
  bankDeform(frame, curtain + 500, out);
  return out;
}

/** PENDULUM HALL: frequencies (base + index) / cycle realign every PENDULUM_CYCLE phase units. */
export function samplePendulum(frame: VisualFrame, index: number, count: number, out = freshPendulum(), phase = frame.phase): PendulumSample {
  const p = frame.state.sceneParams;
  const span = 2 + p[0] * 5, arc = p[6] * Math.PI * 1.2;
  const position = count > 1 ? index / (count - 1) : .5, s = (position - .5) * span;
  let directionX = 0, directionZ = -1;
  out.pivotY = 2.6 + p[1] * 2.2;
  if (arc < .01) { out.pivotX = s; out.pivotZ = -1.8; }
  else {
    const radius = span / arc, theta = s / radius;
    out.pivotX = radius * Math.sin(theta); out.pivotZ = -1.8 + radius * (1 - Math.cos(theta));
    directionX = Math.sin(theta); directionZ = -Math.cos(theta);
  }
  const frequency = (PENDULUM_BASE + index) / PENDULUM_CYCLE;
  out.length = (out.pivotY - .35) * .85 * Math.pow(PENDULUM_BASE / (PENDULUM_BASE + index), 2);
  const amplitude = (.12 + p[4] * .6) * (1 + frame.audio.bass * .05);
  const angle = amplitude * Math.cos(TAU * frequency * phase + seeded(frame.state.seed, 1900) * TAU);
  out.x = out.pivotX + directionX * Math.sin(angle) * out.length;
  out.z = out.pivotZ + directionZ * Math.sin(angle) * out.length;
  out.y = out.pivotY - Math.cos(angle) * out.length;
  out.size = (.04 + p[2] * .1) * (1 + frame.audio.beat * .1);
  out.hue = bankHue(frame, .11, index, position * .2);
  out.glow = .6 + frame.audio.beat * .5 + p[7] * .2;
  bankDeform(frame, index + 600, out);
  return out;
}

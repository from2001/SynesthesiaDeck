import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';
import { TAU, bankDeform, bankHue, fract, rigidDelta, smooth, zero } from './bank-math';

/** Uncharted presets borrow nothing from the earlier banks: mechanics, figures, lanterns, automata and fireworks. */
export const UNCHARTED_SCENE_IDS = [25, 26, 27, 28, 29] as const;
export const UNCHARTED_QUALITY = {
  low: { dominoes: 90, dancers: 14, lanterns: 40, columns: 48, rows: 24, shells: 4, sparks: 60, trail: 6 },
  medium: { dominoes: 180, dancers: 28, lanterns: 90, columns: 72, rows: 36, shells: 6, sparks: 100, trail: 8 },
  high: { dominoes: 300, dancers: 40, lanterns: 150, columns: 96, rows: 40, shells: 8, sparks: 140, trail: 10 },
} as const;
const GOLDEN = 2.399963229728653;

// ---------------------------------------------------------------------------------------------- DOMINO CASCADE
export interface DominoSample extends Point3 { tangentX: number; tangentZ: number; angle: number; fallen: number; hue: number; glow: number; height: number; width: number; thickness: number }
export const freshDomino = (): DominoSample => ({ x: 0, y: 0, z: 0, tangentX: 0, tangentZ: 1, angle: 0, fallen: 0, hue: 0, glow: 1, height: .2, width: .1, thickness: .03 });

/** Dominoes stand along an Archimedean spiral; a topple front and a later reset front travel along it forever. */
export function sampleDomino(frame: VisualFrame, index: number, count: number, out = freshDomino()): DominoSample {
  const p = frame.state.sceneParams, t = frame.phase;
  out.height = .2 + p[1] * .5; out.width = out.height * (.35 + p[2] * .4); out.thickness = out.height * .16;
  const spacing = out.height * .72, k = (.14 + p[0] * .5) / TAU, inner = .5 + p[6] * 2;
  const s = index * spacing, theta = (-inner + Math.sqrt(inner * inner + 2 * k * s)) / k, radius = inner + k * theta;
  out.x = Math.cos(theta) * radius; out.y = 0; out.z = Math.sin(theta) * radius;
  const tx = -Math.sin(theta) * radius + Math.cos(theta) * k, tz = Math.cos(theta) * radius + Math.sin(theta) * k, length = Math.hypot(tx, tz) || 1;
  out.tangentX = tx / length; out.tangentZ = tz / length;
  const total = count * spacing, period = total * 1.6 + 2;
  const cycle = fract((t * (.6 + p[4] * 2.4) - s) / period);
  const fallWidth = 3 * spacing / period, riseWidth = 6 * spacing / period;
  out.fallen = smooth(0, fallWidth, cycle) * (1 - smooth(.55, .55 + riseWidth, cycle));
  out.angle = out.fallen * (index === count - 1 ? 1.5 : 1.3);
  const age = cycle * period;
  out.glow = .55 + Math.exp(-age / (spacing * 6)) * out.fallen * p[7] * 2.2 + frame.audio.beat * .15;
  out.hue = bankHue(frame, .06, index, index / Math.max(1, count) * .08);
  bankDeform(frame, index + 3000, out, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------- GLOWSTICK CROWD
export const DANCER_JOINTS = 17;
export const DANCER_SEGMENTS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [3, 4], [3, 5], [5, 7], [4, 6], [6, 8], [9, 10], [9, 11], [11, 13], [10, 12], [12, 14], [7, 15], [8, 16],
];
export interface DancerSample { hue: number; stickHue: number; glow: number; stickGlow: number; headRadius: number; joints: Float32Array }
export const freshDancer = (): DancerSample => ({ hue: 0, stickHue: 0, glow: 1, stickGlow: 1, headRadius: .1, joints: new Float32Array(DANCER_JOINTS * 3) });
const anchor = zero(), delta = zero();

function joint(sample: DancerSample, index: number, x: number, y: number, z: number): void {
  sample.joints[index * 3] = x; sample.joints[index * 3 + 1] = y; sample.joints[index * 3 + 2] = z;
}

/** Joints in order: pelvis, neck, head, shoulders L/R, elbows L/R, hands L/R, hips L/R, knees L/R, feet L/R, stick tips L/R. */
export function sampleDancer(frame: VisualFrame, index: number, out = freshDancer()): DancerSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, index * 4 + 3100), b = seeded(seed, index * 4 + 3101), c = seeded(seed, index * 4 + 3102), d = seeded(seed, index * 4 + 3103);
  const angle = a * TAU, radius = .8 + b * (1.5 + p[0] * 4);
  const rootX = Math.cos(angle) * radius, rootZ = Math.sin(angle) * radius, yaw = angle + Math.PI + (c - .5) * .6;
  const S = (1.5 + p[1] * .6) * (.85 + c * .3), intensity = .3 + p[6] * .9;
  const w = t * (1 + p[4] * 2) * Math.PI + a * 8;
  const w0 = d, w1 = seeded(seed, index + 3150), w2 = 1.3 - w0 - w1 + .3, total = w0 + w1 + Math.max(0, w2);
  const m0 = w0 / total, m1 = w1 / total, m2 = Math.max(0, w2) / total;
  const bounce = Math.abs(Math.sin(w)) * .05 * S * intensity + frame.audio.beat * .04;
  const sway = Math.sin(w * .5) * .06 * S * intensity;
  const pelvisY = .53 * S + bounce, neckY = pelvisY + .27 * S, neckX = sway + Math.sin(w * .5 + .5) * .03 * S * intensity;
  joint(out, 0, sway, pelvisY, 0); joint(out, 1, neckX, neckY, 0); joint(out, 2, neckX, neckY + .1 * S, 0);
  for (let side = -1; side <= 1; side += 2) {
    const left = side < 0 ? 0 : 1;
    const shoulderX = neckX + side * .14 * S, shoulderY = neckY - .02 * S;
    joint(out, 3 + left, shoulderX, shoulderY, 0);
    const hand0X = side * .18 * S + Math.sin(w * .5 + side) * .12 * S * intensity, hand0Y = .34 * S + Math.sin(w + side) * .05 * S, hand0Z = .02 * S;
    const hand1X = side * .2 * S, hand1Y = .05 * S + Math.abs(Math.sin(w + side * .3)) * .3 * S * intensity, hand1Z = .1 * S;
    const hand2X = side * (.22 + .14 * Math.sin(w * .5)) * S * intensity, hand2Y = .1 * S + Math.cos(w * .5) * .06 * S, hand2Z = .12 * S * Math.sin(w);
    const handX = shoulderX + m0 * hand0X + m1 * hand1X + m2 * hand2X;
    const handY = shoulderY + m0 * hand0Y + m1 * hand1Y + m2 * hand2Y;
    const handZ = m0 * hand0Z + m1 * hand1Z + m2 * hand2Z;
    const elbowX = (shoulderX + handX) * .5 + side * .07 * S, elbowY = (shoulderY + handY) * .5 - .03 * S, elbowZ = handZ * .5 + .04 * S;
    joint(out, 5 + left, elbowX, elbowY, elbowZ); joint(out, 7 + left, handX, handY, handZ);
    const forearm = Math.hypot(handX - elbowX, handY - elbowY, handZ - elbowZ) || 1, stick = .2 + p[2] * .3;
    joint(out, 15 + left, handX + (handX - elbowX) / forearm * stick, handY + (handY - elbowY) / forearm * stick, handZ + (handZ - elbowZ) / forearm * stick);
    const hipX = sway + side * .08 * S, hipY = pelvisY - .03 * S;
    joint(out, 9 + left, hipX, hipY, 0);
    const lift = Math.max(0, Math.sin(w) * side) * intensity;
    joint(out, 11 + left, hipX, .3 * S + lift * .12 * S, lift * .12 * S);
    joint(out, 13 + left, hipX + side * .02 * S, lift * .08 * S, lift * .05 * S);
  }
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  anchor.x = rootX; anchor.y = 0; anchor.z = rootZ;
  rigidDelta(frame, index + 3100, anchor, delta, 0);
  for (let j = 0; j < DANCER_JOINTS; j++) {
    const x = out.joints[j * 3], z = out.joints[j * 3 + 2];
    out.joints[j * 3] = rootX + x * cy + z * sy + delta.x;
    out.joints[j * 3 + 1] += delta.y;
    out.joints[j * 3 + 2] = rootZ - x * sy + z * cy + delta.z;
  }
  out.headRadius = .055 * S;
  out.hue = bankHue(frame, .58, index);
  out.stickHue = bankHue(frame, .95, index, seeded(seed, index + 3180) * .5);
  out.glow = .5 + frame.audio.level * .2;
  out.stickGlow = (.9 + frame.audio.beat * .6) * (.4 + p[7]);
  return out;
}

// ---------------------------------------------------------------------------------------------- LANTERN ASCENT
export interface LanternSample extends Point3 { hue: number; glow: number; size: number; tilt: number; cycle: number }
export const freshLantern = (): LanternSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1, size: .2, tilt: 0, cycle: 0 });

export function sampleLantern(frame: VisualFrame, index: number, out = freshLantern()): LanternSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, index * 4 + 3200), b = seeded(seed, index * 4 + 3201), c = seeded(seed, index * 4 + 3202), d = seeded(seed, index * 4 + 3203);
  const spread = 3 + p[0] * 6, sway = .1 + p[6] * .6;
  out.cycle = fract(d + t * (.03 + p[4] * .07) * (.8 + a * .4));
  out.x = (a - .5) * spread + Math.sin(t * .5 + a * TAU) * sway * out.cycle + Math.sin(t * .2 + b * TAU) * .2;
  out.z = (b - .5) * spread + Math.cos(t * .4 + c * TAU) * sway * out.cycle;
  out.y = .3 + out.cycle * (4 + p[1] * 5);
  out.size = (.12 + p[2] * .2) * (.8 + b * .4);
  out.tilt = Math.sin(t * .4 + b * TAU) * .08;
  const flicker = 1 + Math.sin(t * 9 + a * 40) * (.1 + p[7] * .25) * (.5 + .5 * Math.sin(t * 3.3 + c * TAU)) + frame.audio.bass * .1;
  out.glow = flicker * (1 - smooth(.85, 1, out.cycle)) * smooth(0, .08, out.cycle);
  out.hue = bankHue(frame, .07, index, (a - .5) * .03);
  bankDeform(frame, index + 3200, out, .1);
  return out;
}

// ---------------------------------------------------------------------------------------------- AUTOMATON WALL
export const AUTOMATON_RULES = [30, 90, 110, 150, 54, 62, 73, 105, 126, 182, 22, 45, 60, 75, 101, 129] as const;
export interface CellPose extends Point3 { yaw: number; width: number; height: number; hue: number; glow: number }
export const freshCell = (): CellPose => ({ x: 0, y: 0, z: 0, yaw: 0, width: .1, height: .1, hue: 0, glow: 1 });

export function automatonRule(frame: VisualFrame): number { return AUTOMATON_RULES[Math.min(AUTOMATON_RULES.length - 1, Math.floor(frame.state.sceneParams[3] * AUTOMATON_RULES.length))]; }
export function automatonGeneration(frame: VisualFrame): number { return frame.phase * (1 + frame.state.sceneParams[4] * 8); }

/** Compute `rows` generations of one block from its seeded first row; blocks are independent so phase stays absolute. */
export function automatonBlock(seed: number, block: number, rule: number, width: number, rows: number, out: Uint8Array): Uint8Array {
  const density = .12 + seeded(seed, block + 3450) * .4;
  for (let x = 0; x < width; x++) out[x] = seeded(seed, block * 7919 + x + 3400) < density ? 1 : 0;
  for (let row = 1; row < rows; row++) {
    const previous = (row - 1) * width, current = row * width;
    for (let x = 0; x < width; x++) {
      const left = out[previous + (x + width - 1) % width], center = out[previous + x], right = out[previous + (x + 1) % width];
      out[current + x] = (rule >> (left * 4 + center * 2 + right)) & 1;
    }
  }
  return out;
}

/** Cell (column, age) on a curved wall; age 0 is the newest generation emerging at the base. */
export function sampleCell(frame: VisualFrame, column: number, columns: number, age: number, rows: number, out = freshCell()): CellPose {
  const p = frame.state.sceneParams;
  const radius = 2 + p[0] * 3, arc = TAU * (.15 + p[6] * .85), u = (column + .5) / columns;
  const angle = -Math.PI / 2 + (u - .5) * arc;
  const pitchW = radius * arc / columns, pitchH = (2 + p[1] * 3) / rows, scroll = fract(automatonGeneration(frame));
  out.x = Math.cos(angle) * radius; out.z = Math.sin(angle) * radius; out.y = .3 + (age + scroll) * pitchH + pitchH / 2;
  out.yaw = Math.atan2(-Math.cos(angle), -Math.sin(angle));
  out.width = pitchW * (.55 + p[2] * .45); out.height = pitchH * (.55 + p[2] * .45);
  const relative = (age + scroll) / rows;
  out.hue = bankHue(frame, .52, 0, relative * .25);
  out.glow = (1 - relative * (.3 + p[7] * .7)) * (1 + (age === 0 ? frame.audio.beat * .8 : 0));
  bankDeform(frame, column + 3300, out);
  return out;
}

// ---------------------------------------------------------------------------------------------- HANABI SKY
export interface ShellSample { launch: Point3; burst: Point3; tau: number; rise: number; life: number; hue: number; pattern: number; launchIndex: number }
export interface SparkSample extends Point3 { hue: number; glow: number; size: number }
export const freshShell = (): ShellSample => ({ launch: zero(), burst: zero(), tau: 0, rise: 1, life: 1, hue: 0, pattern: 0, launchIndex: 0 });
export const freshSpark = (): SparkSample => ({ x: 0, y: 0, z: 0, hue: 0, glow: 1, size: .02 });

/** Slot `slot` launches periodically; every launch has its own seeded position, height, color and pattern. */
export function sampleShell(frame: VisualFrame, slot: number, out = freshShell()): ShellSample {
  const p = frame.state.sceneParams, t = frame.phase, seed = frame.state.seed;
  const a = seeded(seed, slot * 3 + 3500), b = seeded(seed, slot * 3 + 3501);
  const period = (4 + a * 4) / (.35 + p[4] * 1.3), cycle = (t + b * period) / period;
  out.launchIndex = Math.floor(cycle); out.tau = fract(cycle) * period;
  const la = seeded(seed, slot * 97 + out.launchIndex * 5 + 3520), lb = seeded(seed, slot * 97 + out.launchIndex * 5 + 3521);
  const lc = seeded(seed, slot * 97 + out.launchIndex * 5 + 3522), ld = seeded(seed, slot * 97 + out.launchIndex * 5 + 3523);
  const spread = 2 + p[0] * 6;
  out.launch.x = (la - .5) * spread; out.launch.y = 0; out.launch.z = (lb - .5) * spread - 1;
  out.rise = 1.2 + a * .4; out.life = 2.4 + p[7] * .9;
  out.burst.x = out.launch.x + (lc - .5) * .6; out.burst.y = (3 + p[1] * 4) * (.8 + lb * .4); out.burst.z = out.launch.z;
  out.pattern = Math.floor(lc * 2.999);
  out.hue = bankHue(frame, ld, slot);
  bankDeform(frame, slot + 3500, out.launch, 0); bankDeform(frame, slot + 3500, out.burst, .5);
  return out;
}

/** The rising shell eases toward its burst point; tau is measured from launch. */
export function shellPosition(shell: ShellSample, tau: number, out: Point3 = zero()): Point3 {
  const progress = Math.max(0, Math.min(1, tau / shell.rise)), ease = 1 - (1 - progress) * (1 - progress);
  out.x = shell.launch.x + (shell.burst.x - shell.launch.x) * ease;
  out.y = shell.launch.y + (shell.burst.y - shell.launch.y) * ease;
  out.z = shell.launch.z + (shell.burst.z - shell.launch.z) * ease;
  return out;
}

/** Spark `spark` of `sparks` at `since` phase units after the burst, with linear drag and gravity in closed form. */
export function sampleSpark(frame: VisualFrame, shell: ShellSample, spark: number, sparks: number, since: number, out = freshSpark()): SparkSample {
  const p = frame.state.sceneParams, seed = frame.state.seed;
  const sa = seeded(seed, spark * 2 + 3600), sb = seeded(seed, spark * 2 + 3601);
  let y = 1 - 2 * (spark + .5) / sparks;
  if (shell.pattern === 2) y = y * .5 - .4;
  const ring = Math.sqrt(Math.max(0, 1 - y * y)), phi = spark * GOLDEN + sb * .5;
  // A ring shell opens as a vertical hoop facing the audience instead of a flat disc.
  let dx = ring * Math.cos(phi), dy = y, dz = ring * Math.sin(phi);
  if (shell.pattern === 1) { const turn = (spark + .5) / sparks * TAU + sb * .3; dx = Math.cos(turn); dy = Math.sin(turn); dz = (sa - .5) * .12; }
  const radius = (1 + p[6] * 2.5) * (.85 + sa * .3), drag = shell.pattern === 2 ? .9 : 1.6, gravity = shell.pattern === 2 ? 3.5 : 2.5;
  const time = Math.max(0, since), decay = (1 - Math.exp(-drag * time)) / drag;
  out.x = shell.burst.x + dx * radius * drag * decay;
  out.z = shell.burst.z + dz * radius * drag * decay;
  out.y = shell.burst.y + dy * radius * drag * decay - gravity / drag * (time - decay);
  const fade = Math.max(0, 1 - time / shell.life);
  out.glow = Math.pow(fade, 1.2) * (1 + .3 * Math.sin(time * 23 + sa * TAU)) * (1 + frame.audio.beat * .5);
  out.size = (.02 + p[2] * .05) * (1 + frame.audio.bass * .3) * (shell.pattern === 2 ? .8 : 1);
  out.hue = shell.hue + (spark % 3 === 0 ? .08 : 0);
  return out;
}

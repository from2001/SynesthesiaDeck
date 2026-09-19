import { seeded } from '../../shared/protocol';
import type { Point3, VisualFrame } from './math';
import type { Quality } from './parameters';

export interface ArchitecturalPose extends Point3 { rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }
export const ARCHITECTURAL_SCENE_IDS = [10, 11, 12, 13, 14] as const;
const TAU = Math.PI * 2;
const fract = (value: number) => value - Math.floor(value);
export const emptyArchitecturalPose = (): ArchitecturalPose => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

export function architecturalCounts(frame: VisualFrame, quality: Quality) {
  const density = .35 + frame.state.controls.density * .65;
  const p = frame.state.sceneParams;
  return {
    cells: Math.max(24, Math.round(({ low: 60, medium: 100, high: 120 }[quality]) * density)),
    latticeLayers: Math.max(2, Math.round(({ low: 3, medium: 4, high: 6 }[quality]) * density)),
    loops: Math.max(2, Math.round((3 + Math.floor(p[3] * 7)) * density)),
    chimes: Math.max(1, Math.round(Math.min(2 + Math.floor(p[3] * 5), { low: 3, medium: 5, high: 7 }[quality]) * density)) * 8,
    portalRings: Math.max(6, Math.round(({ low: 12, medium: 20, high: 28 }[quality]) * density)),
  };
}

/** All geometry samples use absolute show phase; frame.time and previous frames are deliberately absent. */
export function architecturalPalette(frame: VisualFrame, index: number, baseHue: number): number {
  const prism = (frame.state.toggles[6] ? frame.state.controls.masterFX : 0) + frame.effects.oneShots[6];
  return fract(baseHue + (frame.state.sceneParams[5] - .5) * .8 + prism * (.18 * Math.sin(frame.phase * .25) + seeded(frame.state.seed, index) * .25));
}

export function architecturalDeform(point: Point3, frame: VisualFrame, index: number, out: Point3 = { x: 0, y: 0, z: 0 }): Point3 {
  const { controls, toggles, seed } = frame.state;
  const a = seeded(seed, index * 3), b = seeded(seed, index * 3 + 1), c = seeded(seed, index * 3 + 2);
  const distortion = controls.distortion * (.07 + frame.audio.mid * .18);
  let x = point.x + Math.sin(point.y * 2 + frame.phase * .4) * distortion;
  let z = point.z + Math.cos(point.x * 1.3 - frame.phase * .3) * distortion;
  let y = point.y;
  const twist = ((toggles[2] ? controls.masterFX : 0) + frame.effects.oneShots[2]) * (point.y - 2) * .32;
  const tx = x * Math.cos(twist) - z * Math.sin(twist);
  z = x * Math.sin(twist) + z * Math.cos(twist); x = tx;
  if (((toggles[3] && controls.masterFX > .05) || frame.effects.oneShots[3] > .15) && index % 2 === 0) x = -x;
  const scatter = (toggles[4] ? controls.masterFX : 0) + frame.effects.oneShots[4];
  x += (a - .5) * scatter * 2; y += (b - .5) * scatter * .9; z += (c - .5) * scatter * 2;
  const glitch = controls.glitch * (.15 + frame.audio.high * .85);
  if (seeded(seed + Math.floor(frame.phase * 9), index + 701) < glitch * .18) x += (a - .5) * glitch * 1.4;
  out.x = x; out.y = Math.max(.06, y); out.z = z;
  return out;
}

/** A cell's four corners meet an independently folding center, creating actual triangular facets. */
export function origamiPoint(frame: VisualFrame, column: number, row: number, u: number, v: number, center: boolean, out: Point3 = { x: 0, y: 0, z: 0 }): Point3 {
  const p = frame.state.sceneParams;
  const width = 4 + p[0] * 5, height = 2 + p[1] * 3;
  const cu = column + .5 + (u - .5) * (.65 + p[2] * .35);
  const cv = row + .5 + (v - .5) * (.65 + p[2] * .35);
  const x = (cu - 6) / 12 * width;
  const y = .35 + cv / 10 * height;
  const folds = 2 + Math.floor(p[3] * 10);
  const angle = (cu - 6) / 12 * (1 + p[6] * 1.4);
  const seedPhase = seeded(frame.state.seed, 1001) * TAU;
  const wave = Math.sin(cu * folds * .27 + cv * .5 + frame.phase * .65 + seedPhase);
  const fold = center ? (.04 + p[4] * .5) * (wave * .65 + .35) * (1 + frame.audio.bass * .3 + frame.audio.beat * .18) : 0;
  out.x = x; out.y = y;
  out.z = -2.2 - Math.cos(angle) * (1 + p[6] * 1.5) + Math.sin(cv * .5 + frame.phase * .17) * .12 + fold;
  return out;
}

export function latticePose(frame: VisualFrame, layer: number, line: number, horizontal: boolean, out: ArchitecturalPose = emptyArchitecturalPose()): ArchitecturalPose {
  const p = frame.state.sceneParams;
  const frequency = 12 + Math.floor(p[3] * 52);
  const width = 4 + p[0] * 5, height = 2 + p[1] * 3;
  const angle = (layer % 2 ? -1 : 1) * (p[4] * .6 + .013 * layer + Math.sin(frame.phase * .12 + layer * .7) * p[7] * .1 + frame.audio.bass * .018);
  const offset = (line / Math.max(1, frequency - 1) - .5) * (horizontal ? height : width);
  const x = horizontal ? -Math.sin(angle) * offset : Math.cos(angle) * offset;
  const y = horizontal ? Math.cos(angle) * offset : Math.sin(angle) * offset;
  const drift = Math.sin(frame.phase * .17 + layer * 1.3 + seeded(frame.state.seed, 1200 + layer) * TAU) * p[7] * (.12 + frame.audio.high * .1);
  // Lift the rotated rectangle by its projected half-height so its corners stay above the floor.
  const centerY = .2 + Math.abs(Math.cos(angle)) * height * .5 + Math.abs(Math.sin(angle)) * width * .5;
  out.x = x + drift; out.y = y + centerY; out.z = -2.7 - layer * (.025 + p[6] * .16);
  architecturalDeform(out, frame, layer, out);
  out.rx = 0; out.ry = 0; out.rz = angle + (horizontal ? Math.PI / 2 : 0);
  out.sx = .006 + p[2] * .024; out.sy = horizontal ? width : height; out.sz = 1;
  return out;
}

/** Closed braided torus curves. Integer windings keep every ring watertight at u = 0/1. */
export function loomPoint(frame: VisualFrame, loop: number, u: number, out: Point3 = { x: 0, y: 0, z: 0 }): Point3 {
  const p = frame.state.sceneParams;
  const theta = u * TAU;
  const offset = loop * 2.399963229728653 + seeded(frame.state.seed, 1600) * TAU;
  // Odd windings remain coprime with the two major turns and never double-cover the same tube.
  const windings = 3 + 2 * Math.floor(p[4] * 3);
  const braid = theta * windings + offset + frame.phase * .24;
  const major = 1.35 + p[0] * 1.8;
  const minor = (.18 + p[6] * .52) * (.5 + p[7] * .5) * (1 + frame.audio.bass * .16);
  const radius = major + Math.cos(braid) * minor;
  const turn = theta * 2 + Math.sin(braid) * p[4] * .22 + offset * .055;
  out.x = Math.cos(turn) * radius; out.y = 2 + Math.sin(braid) * minor * (.7 + p[1] * 1.5); out.z = -2.2 + Math.sin(turn) * radius * .6;
  return architecturalDeform(out, frame, loop, out);
}

/** Prismatic pendulums swing from a staggered canopy in a traveling musical wave. */
export function chimePose(frame: VisualFrame, index: number, out: ArchitecturalPose = emptyArchitecturalPose()): ArchitecturalPose {
  const p = frame.state.sceneParams, t = frame.phase;
  const row = Math.floor(index / 8), column = index % 8;
  const a = seeded(frame.state.seed, index + 2100);
  const wave = t * (.5 + p[7] * .6) - column * (.22 + p[7] * .6) + row * .8 + a * .3;
  const swing = Math.sin(wave) * (.06 + p[4] * .65 + frame.audio.mid * .12);
  const length = (.65 + p[2] * 1.4) * (.8 + a * .35);
  const pivotX = (column - 3.5) * (.4 + p[0] * .5) + (row % 2) * .18;
  const pivotY = 2.2 + p[1] * 1.8 + Math.cos(column * .7 + row) * .28;
  const pivotZ = -1.8 - row * (.35 + p[6] * .75);
  out.x = pivotX + Math.sin(swing) * length * .5;
  out.y = pivotY - Math.cos(swing) * length * .5;
  out.z = pivotZ + Math.sin(wave * .7) * p[4] * .18;
  architecturalDeform(out, frame, index, out);
  out.rx = 0; out.ry = a * TAU + t * .12; out.rz = swing;
  out.sx = .11 + p[2] * .14; out.sy = length * (1 + frame.audio.bass * .07); out.sz = out.sx;
  return out;
}

/** Polygon corners, rather than circles, make the recursive portal silhouette explicit. */
export function portalPoint(frame: VisualFrame, ring: number, corner: number, band: number, inner: boolean, out: Point3 = { x: 0, y: 0, z: 0 }): Point3 {
  const p = frame.state.sceneParams;
  const sides = 3 + Math.floor(p[3] * 9);
  const twist = ring * p[4] * .17 + frame.phase * .085 + seeded(frame.state.seed, 3100) * TAU;
  const angle = corner / sides * TAU + twist;
  const split = (band - 1) * p[7] * .07;
  const radius = (1.25 + p[0] * 1.7) * (1 + Math.sin(frame.phase * .3 - ring * .15) * .025 + frame.audio.bass * .025) + split;
  const thickness = .018 + p[2] * .12;
  const r = Math.max(.1, radius - (inner ? thickness : 0));
  const centerY = 1.9 + Math.max(0, radius * (.45 + p[1] * .5) - 1.65);
  out.x = Math.cos(angle) * r + split * .4; out.y = centerY + Math.sin(angle) * r * (.45 + p[1] * .5);
  out.z = -1.7 - ring * (.16 + p[6] * .45) + split * .4;
  return architecturalDeform(out, frame, ring, out);
}

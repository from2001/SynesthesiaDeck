import type { ShowState } from '../../shared/protocol';

export type Quality = 'low' | 'medium' | 'high';

/** Counts are budgets, not a promise of device frame rate. Particle IDs are stable across tiers. */
export const QUALITY_BUDGETS = {
  low: { particles: 4000, instances: 320, pixelRatio: 1, foveation: 1 },
  medium: { particles: 12000, instances: 720, pixelRatio: 1.4, foveation: .7 },
  high: { particles: 32000, instances: 1500, pixelRatio: 1.8, foveation: .4 },
} as const;

export const PRESET_PARAMETERS = [
  ['Column spread', 'Vault height', 'Glyph size', 'Rain length', 'Code tilt', 'Palette hue', 'Arch radius', 'Code shimmer'],
  ['Field radius', 'Vertical spread', 'Particle size', 'Helix strands', 'Curl strength', 'Palette hue', 'Flow pitch', 'Fragmentation'],
  ['City spread', 'Tower height', 'Street width', 'Wave rings', 'Building taper', 'Palette hue', 'Grid height', 'Window pulse'],
  ['Storm spread', 'Vertical spread', 'Shard size', 'Burst lanes', 'Spin', 'Palette hue', 'Code ratio', 'Tear strength'],
  ['Disk radius', 'Core height', 'Particle size', 'Spiral arms', 'Accretion twist', 'Palette hue', 'Core radius', 'Infall stretch'],
] as const;

export const EFFECT_DESCRIPTIONS = [
  'Orbit the installation around its floor origin.',
  'Pulse the whole installation with the beat.',
  'Twist geometry progressively with height.',
  'Reflect alternate elements across the center.',
  'Scatter elements along deterministic directions.',
  'Gate brightness at four flashes per second.',
  'Cycle spectral colors across geometry.',
  'Freeze motion; audio and scheduled flashes remain live.',
] as const;

export function visibleCount(maximum: number, state: ShowState): number {
  return Math.max(1, Math.round(maximum * (.08 + state.controls.density * .92)));
}

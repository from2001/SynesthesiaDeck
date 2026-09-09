/** Stable scene order: the original five IDs remain unchanged. */
export const SCENE_CATALOG = [
  { name: 'CODE CATHEDRAL', group: 'signal', synopsis: 'Descending code builds a vaulted chamber of light.' },
  { name: 'VECTOR FIELD', group: 'signal', synopsis: 'Particles trace invisible currents and curling helices.' },
  { name: 'NEON DATA CITY', group: 'signal', synopsis: 'A wireframe city rises and ripples with the beat.' },
  { name: 'GLITCH STORM', group: 'signal', synopsis: 'Shards and torn glyphs collide inside a broken signal.' },
  { name: 'SINGULARITY', group: 'signal', synopsis: 'Spiral matter falls toward a luminous gravity well.' },
  { name: 'TIDAL SILK', group: 'organic', synopsis: 'Broad silk ribbons fold into a breathing tidal curtain.' },
  { name: 'MYCELIUM CHOIR', group: 'organic', synopsis: 'Branching colonies sway beneath a drifting spore canopy.' },
  { name: 'ABYSSAL BLOOM', group: 'organic', synopsis: 'Translucent bells pulse above curling deep-sea tendrils.' },
  { name: 'LIQUID MERCURY', group: 'organic', synopsis: 'A metallic fluid surface gathers into rippling lobes.' },
  { name: 'EMBER MIGRATION', group: 'organic', synopsis: 'Winged ember silhouettes bank and gather into a flock.' },
  { name: 'ORIGAMI ENGINE', group: 'structure', synopsis: 'Folded facets open into a rhythmic paper mechanism.' },
  { name: 'MOIRE OBSERVATORY', group: 'structure', synopsis: 'Layered lattices drift through optical interference.' },
  { name: 'IMPOSSIBLE LOOM', group: 'structure', synopsis: 'Thick threads interlace into a shifting sculptural knot.' },
  { name: 'GRAVITY PALIMPSEST', group: 'structure', synopsis: 'Eroded blocks float through layers of impossible arches.' },
  { name: 'PRISMATIC PORTAL', group: 'structure', synopsis: 'Nested polygonal apertures twist into a spectral tunnel.' },
] as const;

export const SCENES = Object.freeze(SCENE_CATALOG.map(scene => scene.name));
export const SCENE_COUNT = SCENE_CATALOG.length;
export const MIDI_SCENE_SHORTCUT_COUNT = 8;
export const SCENE_GROUPS = [
  { id: 'signal', name: 'Signal', subtitle: 'Code / currents / collision' },
  { id: 'organic', name: 'Organic', subtitle: 'Silk / growth / living motion' },
  { id: 'structure', name: 'Structures', subtitle: 'Folds / interference / impossible space' },
] as const;

export function sceneNumber(index: number): string { return String(index + 1).padStart(2, '0'); }

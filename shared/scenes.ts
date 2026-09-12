/** Stable scene order: existing IDs never move; new banks append five scenes at a time. */
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
  { name: 'WAVEFORM ATLAS', group: 'echo', synopsis: 'Stacked oscilloscope traces sweep across a curved signal wall.' },
  { name: 'SYNAPSE RELAY', group: 'echo', synopsis: 'Packets of light race along links between firing nodes.' },
  { name: 'KELP FOREST', group: 'echo', synopsis: 'Swaying kelp strands rise from the floor beneath drifting bubbles.' },
  { name: 'AURORA CURTAIN', group: 'echo', synopsis: 'Hanging light curtains ripple with vertical rays overhead.' },
  { name: 'PENDULUM HALL', group: 'echo', synopsis: 'A row of pendulums drifts in and out of interference.' },
  { name: 'LASER HARP', group: 'laser', synopsis: 'Vertical beams fan from the floor and pluck with every band.' },
  { name: 'SPECTRUM FAN', group: 'laser', synopsis: 'Rear emitters sweep colored beam fans and sheets across the room.' },
  { name: 'PHOTON TUNNEL', group: 'laser', synopsis: 'Spinning laser rings and cone beams bore a tunnel through the room.' },
  { name: 'GALVO LISSAJOUS', group: 'laser', synopsis: 'A scanner traces Lissajous figures on a floating screen of light.' },
  { name: 'NOVA STARBURST', group: 'laser', synopsis: 'A hovering emitter throws rotating spokes of beams onto the floor.' },
  { name: 'DOMINO CASCADE', group: 'uncharted', synopsis: 'A spiral of dominoes topples in waves and stands back up.' },
  { name: 'GLOWSTICK CROWD', group: 'uncharted', synopsis: 'Neon stick-figure dancers wave glowsticks in time with the beat.' },
  { name: 'LANTERN ASCENT', group: 'uncharted', synopsis: 'Warm paper lanterns drift upward through the ceiling.' },
  { name: 'AUTOMATON WALL', group: 'uncharted', synopsis: 'A cellular automaton scrolls its pixel generations up a curved wall.' },
  { name: 'HANABI SKY', group: 'uncharted', synopsis: 'Seeded fireworks climb, burst and rain sparks over the room.' },
] as const;

export const SCENES = Object.freeze(SCENE_CATALOG.map(scene => scene.name));
export const SCENE_COUNT = SCENE_CATALOG.length;
export const MIDI_SCENE_SHORTCUT_COUNT = 8;
export const SCENE_GROUPS = [
  { id: 'signal', name: 'Signal', subtitle: 'Code / currents / collision' },
  { id: 'organic', name: 'Organic', subtitle: 'Silk / growth / living motion' },
  { id: 'structure', name: 'Structures', subtitle: 'Folds / interference / impossible space' },
  { id: 'echo', name: 'Echoes', subtitle: 'Signal / organic / structure lineage' },
  { id: 'laser', name: 'Lasers', subtitle: 'Beams / fans / tunnels / scanners' },
  { id: 'uncharted', name: 'Uncharted', subtitle: 'Dominoes / dancers / lanterns / automata / fireworks' },
] as const;

export function sceneNumber(index: number): string { return String(index + 1).padStart(2, '0'); }

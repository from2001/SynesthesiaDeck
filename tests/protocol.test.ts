import { describe, expect, it } from 'vitest';
import { applyEvent, AudioSchema, CommandSchema, initialState, motionAt, NativeMessageSchema, SCENES, SCENE_COUNT, seeded, ShowStateSchema, TelemetrySchema, syntheticAudio, type Command, type ShowEvent } from '../shared/protocol';

import { MIDI_SCENE_SHORTCUT_COUNT, SCENE_CATALOG, SCENE_GROUPS, sceneNumber } from '../shared/scenes';
import { PRESET_PARAMETERS } from '../web/visuals/parameters';

function event(sequence: number, effectiveAt: number, command: Command): ShowEvent {
  return { id: `e${sequence}`, epoch: 'test', sequence, effectiveAt, seed: 42, command };
}
describe('shared contract', () => {
  it('validates defaults and deterministic native-compatible audio', () => {
    expect(ShowStateSchema.parse(initialState('test')).running).toBe(false);
    for (let t = 0; t < 5000; t += 33) AudioSchema.parse(syntheticAudio(t));
    expect(NativeMessageSchema.parse({ version: 1, type: 'audio', timestamp: 40, source: 'synthetic', audio: syntheticAudio(40) }).type).toBe('audio');
  });
  it('rejects invalid bounds, schema versions and unknown commands', () => {
    for (const value of [-1, 2, NaN, Infinity]) expect(CommandSchema.safeParse({ type: 'control', key: 'glow', value }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'scene', scene: SCENE_COUNT }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'start', unexpected: true }).success).toBe(false);
    expect(NativeMessageSchema.safeParse({ version: 2, type: 'audio', timestamp: 0, source: 'system', audio: syntheticAudio(0) }).success).toBe(false);
  });
  it('preserves original IDs and validates all fifteen scene and DROP destinations', () => {
    expect(SCENE_COUNT).toBe(15);
    expect(SCENES.slice(0, 5)).toEqual(['CODE CATHEDRAL', 'VECTOR FIELD', 'NEON DATA CITY', 'GLITCH STORM', 'SINGULARITY']);
    expect(SCENES[14]).toBe('PRISMATIC PORTAL');
    for (let scene = 0; scene < SCENE_COUNT; scene++) {
      const command = CommandSchema.parse({ type: 'scene', scene });
      const state = applyEvent(initialState('test'), event(scene + 1, 100, command));
      expect(ShowStateSchema.parse(state).scene).toBe(scene);
      expect(CommandSchema.parse({ type: 'drop', targetScene: scene }).type).toBe('drop');
      expect(TelemetrySchema.parse({ rtt: 1, offset: 0, locked: true, fps: 60, scene, calibrated: false, xr: false, quality: 'low' }).scene).toBe(scene);
    }
    for (const scene of [-1, 15, 1.5]) {
      expect(CommandSchema.safeParse({ type: 'scene', scene }).success).toBe(false);
      expect(CommandSchema.safeParse({ type: 'drop', targetScene: scene }).success).toBe(false);
      expect(ShowStateSchema.safeParse({ ...initialState('test'), scene }).success).toBe(false);
    }
  });
  it('provides complete scene descriptions, groups, parameter labels and physical shortcuts', () => {
    expect(SCENE_CATALOG).toHaveLength(SCENE_COUNT);
    expect(PRESET_PARAMETERS).toHaveLength(SCENE_COUNT);
    expect(new Set(SCENES).size).toBe(SCENE_COUNT);
    expect(MIDI_SCENE_SHORTCUT_COUNT).toBe(8);
    for (const group of SCENE_GROUPS) expect(SCENE_CATALOG.filter(scene => scene.group === group.id)).toHaveLength(5);
    for (let i = 0; i < SCENE_COUNT; i++) {
      expect(SCENE_CATALOG[i].synopsis.length).toBeGreaterThan(20);
      expect(PRESET_PARAMETERS[i]).toHaveLength(8);
      expect(PRESET_PARAMETERS[i][5]).toBe('Palette hue');
      expect(PRESET_PARAMETERS[i].every(label => label.length > 3)).toBe(true);
      expect(sceneNumber(i)).toBe(String(i + 1).padStart(2, '0'));
    }
    expect(sceneNumber(9)).toBe('10');
    expect(sceneNumber(14)).toBe('15');
  });
  it('integrates speed on the authority timeline independently of render steps', () => {
    let state = applyEvent(initialState('test'), event(1, 1000, { type: 'start' }));
    state = applyEvent(state, event(2, 2000, { type: 'control', key: 'speed', value: 1 }));
    expect(motionAt(state, 3000)).toBeCloseTo(4.05);
    const cleared = applyEvent(state, event(3, 3000, { type: 'clear' }));
    expect(motionAt(cleared, 10000)).toBeCloseTo(4.05);
    expect(state.running).toBe(true);
  });
  it('deduplicates events, rejects epochs and clears transient effects', () => {
    let state = applyEvent(initialState('test'), event(1, 0, { type: 'start' }));
    state = applyEvent(state, event(2, 100, { type: 'drop', duration: 1800, strength: .7 }));
    expect(state.effects).toHaveLength(1);
    expect(applyEvent(state, event(2, 100, { type: 'drop', duration: 1800, strength: .7 }))).toBe(state);
    expect(applyEvent(state, { ...event(3, 200, { type: 'clear' }), epoch: 'old' })).toBe(state);
    expect(applyEvent(state, event(3, 200, { type: 'clear' })).effects).toHaveLength(0);
  });
  it('uses stable seeded identity and resets scene phase', () => {
    expect(seeded(42, 100)).toBe(seeded(42, 100));
    expect(seeded(42, 100)).not.toBe(seeded(43, 100));
    const state = applyEvent(initialState('test'), event(1, 400, { type: 'scene', scene: 2 }));
    expect(state.sceneStartTime).toBe(400);
    expect(state.seed).toBe(42);
    expect(state.motion.phase).toBe(0);
  });
  it('anchors frozen toggle and one-shot phase across subsequent controls', () => {
    let state = applyEvent(initialState('test'), event(1, 0, { type: 'start' }));
    state = applyEvent(state, event(2, 1000, { type: 'burst', slot: 7 }));
    expect(state.effects[0].frozenPhase).toBeCloseTo(1.05);
    state = applyEvent(state, event(3, 1100, { type: 'toggle', slot: 7, value: true }));
    const phase = motionAt(state, 1500);
    state = applyEvent(state, event(4, 1300, { type: 'control', key: 'speed', value: 1 }));
    expect(motionAt(state, 1700)).toBe(phase);
    expect(state.effects[0].frozenPhase).toBeCloseTo(1.05);
  });
});

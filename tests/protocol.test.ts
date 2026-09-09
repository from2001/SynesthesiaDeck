import { describe, expect, it } from 'vitest';
import { applyEvent, AudioSchema, CommandSchema, initialState, motionAt, NativeMessageSchema, seeded, ShowStateSchema, syntheticAudio, type Command, type ShowEvent } from '../shared/protocol';

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
    expect(CommandSchema.safeParse({ type: 'scene', scene: 7 }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'start', unexpected: true }).success).toBe(false);
    expect(NativeMessageSchema.safeParse({ version: 2, type: 'audio', timestamp: 0, source: 'system', audio: syntheticAudio(0) }).success).toBe(false);
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
});

import { describe, expect, it } from 'vitest';
import { Authority } from '../server/authority.js';
import { initialState, SCENE_COUNT, SILENCE, type NativeMessage } from '../shared/protocol.js';
import { MidiMapper, MidiProfileSchema, NANO_KONTROL_2 } from '../server/midi.js';

function setup() {
  let time = 100;
  const events: number[] = [];
  let cancellations = 0;
  const authority = new Authority({ now: () => time, onEvent: event => events.push(event.sequence), onCancel: () => cancellations++ });
  return { authority, events, setTime: (value: number) => { time = value; }, cancellations: () => cancellations };
}
describe('show authority', () => {
  it('keeps future commands out of current state and applies at the boundary', () => {
    const { authority, setTime } = setup();
    const event = authority.schedule({ type: 'scene', scene: 2 });
    expect(event.effectiveAt).toBe(280);
    expect(authority.state.scene).toBe(0);
    expect(authority.projected().scene).toBe(2);
    authority.advance(279.9);
    expect(authority.state.scene).toBe(0);
    setTime(280); authority.advance();
    expect(authority.state.scene).toBe(2);
    expect(authority.state.revision).toBe(event.sequence);
  });
  it('allocates DROP final transition revisions after intervening controls', () => {
    const { authority, setTime } = setup();
    authority.schedule({ type: 'start' });
    setTime(300);
    const drop = authority.schedule({ type: 'drop', duration: 1000, strength: .6, targetScene: 4 });
    setTime(500);
    const control = authority.schedule({ type: 'control', key: 'speed', value: .8 });
    setTime(1200); authority.advance();
    expect(authority.state.scene).toBe(0);
    expect(authority.state.controls.speed).toBe(.8);
    expect(authority.pending).toHaveLength(0);
    setTime(1300); authority.advance();
    const finale = authority.pending[0];
    expect(finale.effectiveAt).toBe(drop.effectiveAt + 1000);
    expect(finale.sequence).toBeGreaterThan(control.sequence);
    setTime(1350);
    const next = authority.schedule({ type: 'control', key: 'density', value: .9 });
    expect(next.sequence).toBeGreaterThan(finale.sequence);
    setTime(1500); authority.advance();
    expect(authority.state.scene).toBe(4);
    setTime(1600); authority.advance();
    expect(authority.state.controls.density).toBe(.9);
    expect(authority.state.revision).toBe(next.sequence);
  });
  it('preserves revisions after a delayed tick and a late-completing older request', () => {
    const { authority, setTime } = setup();
    authority.schedule({ type: 'start' });
    setTime(300);
    authority.schedule({ type: 'drop', duration: 600, strength: .6, targetScene: 4 });
    setTime(600);
    const first = authority.schedule({ type: 'control', key: 'speed', value: .8 });
    setTime(2000);
    authority.advance();
    expect(authority.state.scene).toBe(4);
    expect(authority.state.controls.speed).toBe(.8);
    expect(authority.state.revision).toBeGreaterThan(first.sequence);
    const newer = authority.schedule({ type: 'control', key: 'density', value: .3 });
    const oldBody = authority.schedule({ type: 'control', key: 'glow', value: .9 }, 650);
    expect(oldBody.effectiveAt).toBeGreaterThanOrEqual(newer.effectiveAt);
    setTime(2300); authority.advance();
    expect(authority.state.controls.density).toBe(.3);
    expect(authority.state.controls.glow).toBe(.9);
    expect(authority.state.revision).toBe(oldBody.sequence);
  });
  it('lets a manual scene command override an unfinished DROP destination', () => {
    const { authority, setTime } = setup();
    authority.schedule({ type: 'start' });
    setTime(300);
    authority.schedule({ type: 'drop', duration: 1000, strength: .6, targetScene: 4 });
    setTime(700);
    const scene = authority.schedule({ type: 'scene', scene: 2 });
    setTime(2500); authority.advance();
    expect(authority.state.scene).toBe(2);
    expect(authority.state.revision).toBe(scene.sequence);
  });
  it('clear/reset cancel pending effects and both announced and unannounced finales', () => {
    const { authority, setTime, cancellations } = setup();
    authority.schedule({ type: 'start' });
    setTime(300);
    authority.schedule({ type: 'drop', duration: 600, strength: .6, targetScene: 4 });
    setTime(950); authority.advance();
    expect(authority.pending.some(event => event.command.type === 'scene')).toBe(true);
    authority.schedule({ type: 'clear' });
    expect(authority.pending.some(event => event.command.type === 'scene')).toBe(false);
    setTime(1200); authority.advance();
    expect(authority.state.running).toBe(false);
    expect(authority.state.effects).toHaveLength(0);
    expect(authority.state.scene).toBe(0);
    authority.schedule({ type: 'start' });
    authority.schedule({ type: 'drop', duration: 1800, strength: .8, targetScene: 3 });
    authority.schedule({ type: 'reset' });
    expect(authority.pending.some(event => event.command.type === 'drop')).toBe(false);
    setTime(4000); authority.advance();
    expect(authority.state.running).toBe(false);
    expect(authority.state.scene).toBe(0);
    expect(authority.state.epoch).toBe(authority.epoch);
    expect(cancellations()).toBe(2);
  });
  it('requires running transport for DROP and enforces cooldown and bounded expiry', () => {
    const { authority, setTime } = setup();
    expect(() => authority.schedule({ type: 'drop', duration: 600, strength: .6 })).toThrow('Start');
    authority.schedule({ type: 'start' });
    authority.schedule({ type: 'drop', duration: 600, strength: .6 });
    expect(() => authority.schedule({ type: 'drop', duration: 600, strength: .6 })).toThrow('cooldown');
    for (let i = 0; i < 20; i++) authority.schedule({ type: 'burst', slot: i % 8 });
    setTime(300); authority.advance();
    expect(authority.state.effects).toHaveLength(16);
    setTime(2000); authority.advance();
    expect(authority.state.effects).toHaveLength(0);
  });
  it('decays stale audio to silence and marks synthetic audio explicitly', () => {
    const { authority, setTime } = setup();
    authority.ingest({ version: 1, type: 'audio', timestamp: 100, source: 'system', audio: { ...SILENCE, level: 1, bass: 1 } });
    expect(authority.audioFrame().audio.level).toBe(1);
    setTime(600); expect(authority.audioFrame().audio.level).toBeLessThan(.4);
    setTime(1800); expect(authority.audioFrame().source).toBe('silent');
    expect(authority.source.capture).toBe('error');
    const synthetic = new Authority({ synthetic: true, now: () => 500 });
    expect(synthetic.audioFrame().audio.bpm).toBe(120);
    expect(synthetic.audioFrame().source).toBe('synthetic');
    expect(synthetic.source.capture).toBe('synthetic');
    expect(new Authority().epoch).not.toBe(authority.epoch);
    authority.ingest({ version: 1, type: 'source', capture: 'running', midi: 'connected', detail: 'Native heartbeat' });
    setTime(9000); authority.audioFrame();
    expect(authority.source.midi).toBe('disconnected');
  });
});
const midiMessage = (data1: number, data2: number, status = 0xb0): Extract<NativeMessage, { type: 'midi' }> => ({ version: 1, type: 'midi', timestamp: 0, status, data1, data2 });
describe('MIDI mapping', () => {
  it('uses press edges, releases, debounce and fixed eight scene shortcuts', () => {
    const mapper = new MidiMapper();
    const state = initialState('test');
    expect(mapper.consume(midiMessage(34, 127), state, 0)).toEqual({ type: 'scene', scene: 2 });
    expect(mapper.consume(midiMessage(34, 127), state, 10)).toBeNull();
    expect(mapper.consume(midiMessage(34, 0), state, 11)).toBeNull();
    expect(mapper.consume(midiMessage(34, 127), state, 12)).toBeNull();
    mapper.consume(midiMessage(34, 0), state, 50);
    expect(mapper.consume(midiMessage(34, 127), state, 60)).toEqual({ type: 'scene', scene: 2 });
    for (const cc of [37, 38, 39]) expect(mapper.consume(midiMessage(cc, 127), state, 100)).toEqual({ type: 'scene', scene: cc - 32 });
    expect(mapper.consume(midiMessage(43, 127), state, 100)).toEqual({ type: 'scene', scene: SCENE_COUNT - 1 });
    expect(mapper.consume(midiMessage(44, 127), { ...state, scene: SCENE_COUNT - 1 }, 100)).toEqual({ type: 'scene', scene: 0 });
    expect(mapper.consume(midiMessage(41, 127), state, 100)).toEqual({ type: 'start' });
    expect(mapper.consume(midiMessage(42, 127), state, 100)).toEqual({ type: 'clear' });
    expect(mapper.consume(midiMessage(45, 127), state, 100)?.type).toBe('drop');
  });
  it('routes every preset through REW/FF and preserves fixed S1–S8 on later scenes', () => {
    for (let scene = 0; scene < SCENE_COUNT; scene++) {
      const state = { ...initialState('test'), scene };
      const mapper = new MidiMapper();
      expect(mapper.consume(midiMessage(43, 127), state, 100)).toEqual({ type: 'scene', scene: (scene + SCENE_COUNT - 1) % SCENE_COUNT });
      expect(mapper.consume(midiMessage(44, 127), state, 100)).toEqual({ type: 'scene', scene: (scene + 1) % SCENE_COUNT });
      for (let slot = 0; slot < 8; slot++) expect(mapper.consume(midiMessage(32 + slot, 127), state, 100)).toEqual({ type: 'scene', scene: slot });
    }
  });
  it('toggles authoritative values and handles all one-shot slots', () => {
    const mapper = new MidiMapper();
    const state = initialState('test');
    expect(mapper.consume(midiMessage(64, 127), state, 100)).toEqual({ type: 'toggle', slot: 0, value: true });
    state.toggles[0] = true;
    mapper.consume(midiMessage(64, 0), state, 150);
    expect(mapper.consume(midiMessage(64, 127), state, 200)).toEqual({ type: 'toggle', slot: 0, value: false });
    for (let slot = 0; slot < 8; slot++) expect(mapper.consume(midiMessage(48 + slot, 127), state, 300)).toEqual({ type: 'burst', slot });
  });
  it('requires pickup after dashboard changes and scene-specific knob resets', () => {
    const mapper = new MidiMapper();
    const state = initialState('test');
    expect(mapper.consume(midiMessage(0, 0), state, 0)).toBeNull();
    const picked = mapper.consume(midiMessage(0, 89), state, 10);
    expect(picked?.type).toBe('control');
    state.controls.intensity = 89 / 127;
    expect(mapper.consume(midiMessage(0, 90), state, 20)?.type).toBe('control');
    state.controls.intensity = .2;
    expect(mapper.consume(midiMessage(0, 100), state, 30)).toBeNull();
    expect(mapper.consume(midiMessage(0, 20), state, 40)?.type).toBe('control');
    expect(mapper.consume(midiMessage(16, 64), state, 40)?.type).toBe('knob');
    state.sceneParams[0] = 64 / 127;
    expect(mapper.consume(midiMessage(16, 110), state, 50)?.type).toBe('knob');
    state.scene = 2; state.sceneStartTime = 100; state.sceneParams[0] = .5;
    expect(mapper.consume(midiMessage(16, 110), state, 100)).toBeNull();
    expect(mapper.consume(midiMessage(16, 63), state, 110)?.type).toBe('knob');
  });
  it('supports custom channels and note releases without accepting other channels', () => {
    const profile = MidiProfileSchema.parse({ ...NANO_KONTROL_2, channel: 4, buttonMode: 'note' });
    const mapper = new MidiMapper(profile);
    const state = initialState('test');
    expect(mapper.consume(midiMessage(32, 127, 0x90), state, 0)).toBeNull();
    expect(mapper.consume(midiMessage(32, 127, 0x94), state, 0)?.type).toBe('scene');
    expect(mapper.consume(midiMessage(32, 0, 0x84), state, 50)).toBeNull();
    expect(mapper.consume(midiMessage(32, 127, 0x94), state, 100)?.type).toBe('scene');
  });
});

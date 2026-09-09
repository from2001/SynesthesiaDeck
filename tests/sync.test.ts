import { describe, expect, it } from 'vitest';
import { applyEvent, initialState, motionAt, SILENCE, type ShowEvent } from '../shared/protocol';
import { AudioTimeline, ShowClock, StateTimeline } from '../web/sync';

describe('clock synchronization', () => {
  it('estimates a common timeline despite different RTT and filters poor samples', () => {
    const a = new ShowClock(), b = new ShowClock();
    for (let i = 0; i < 10; i++) {
      a.observe(i * 100, i * 100 + 20, i * 100 + 5010, i * 100 + 5010, 'show');
      b.observe(i * 100, i * 100 + 60, i * 100 + 5030, i * 100 + 5030, 'show');
    }
    expect(a.locked && b.locked).toBe(true);
    expect(a.now(1000)).toBe(b.now(1000));
    a.observe(1100, 2100, 6200, 6200, 'show');
    expect(a.now(2200)).toBeCloseTo(7200);
  });
  it('never goes backwards during correction and resets on epoch changes', () => {
    const clock = new ShowClock();
    clock.reset('one', 0, 1000);
    let previous = clock.now(100);
    clock.observe(100, 120, 1010, 1010, 'one');
    for (let local = 121; local < 300; local++) { const now = clock.now(local); expect(now).toBeGreaterThanOrEqual(previous); previous = now; }
    clock.reset('two', 300, 20);
    expect(clock.locked).toBe(false);
    expect(clock.now(301)).toBe(21);
  });
  it('does not add clock correction when desktop and XR callback samples arrive out of order', () => {
    const makeClock = () => {
      const clock = new ShowClock();
      clock.reset('show', 0, 1000);
      for (const [sent, server] of [[0, 1030], [20, 1050], [40, 1090], [60, 1130]]) clock.observe(sent, sent + 20, server, server, 'show');
      return clock;
    };
    const ordered = makeClock(), interleaved = makeClock();
    ordered.now(100); interleaved.now(100); interleaved.now(90);
    expect(interleaved.now(110)).toBe(ordered.now(110));
  });
});

describe('timestamped audio', () => {
  it('interpolates identically regardless of arrival order and wraps beat phase', () => {
    const a = new AudioTimeline(), b = new AudioTimeline();
    const frames = [
      { timestamp: 100, audio: { ...SILENCE, bass: .2, beatPhase: .99 }, source: 'system' as const },
      { timestamp: 200, audio: { ...SILENCE, bass: .8, beatPhase: .01 }, source: 'system' as const },
    ];
    frames.forEach(f => a.push(f)); [...frames].reverse().forEach(f => b.push(f));
    expect(a.sample(250)).toEqual(b.sample(250));
    expect(a.sample(250).bass).toBeCloseTo(.5);
    expect(a.sample(250).beatPhase).toBeCloseTo(0);
    expect(a.sample(5000).bass).toBeLessThan(.001);
  });
});

describe('state playback', () => {
  const audioFrame = { timestamp: 0, audio: SILENCE, source: 'silent' as const };
  const event: ShowEvent = { id: 'start', epoch: 'show', sequence: 1, effectiveAt: 180, seed: 2, command: { type: 'start' } };
  it('executes at effectiveAt without adding the audio buffer and cancels pending on snapshots', () => {
    const timeline = new StateTimeline();
    timeline.snapshot(initialState('show'), [event], audioFrame, 0);
    expect(timeline.sample(179)?.state.running).toBe(false);
    expect(timeline.sample(180)?.state.running).toBe(true);
    expect(timeline.pendingEvents).toHaveLength(0);
    timeline.snapshot(initialState('show'), [event], audioFrame, 0);
    timeline.snapshot(initialState('show'), [], audioFrame, 10);
    expect(timeline.sample(200)?.state.running).toBe(false);
  });
  it('rejects stale events and epochs; expired effects are not replayed on late join', () => {
    const timeline = new StateTimeline();
    let state = applyEvent(initialState('show'), event);
    state = applyEvent(state, { ...event, id: 'drop', sequence: 2, effectiveAt: 200, command: { type: 'drop', strength: .7, duration: 600 } });
    timeline.snapshot(state, [], audioFrame, 1000);
    timeline.event(event);
    timeline.event({ ...event, epoch: 'old', sequence: 500 });
    expect(timeline.pendingEvents).toHaveLength(0);
    expect(timeline.sample(1000)?.state.effects).toHaveLength(0);
  });
  it('anchors and resumes a frozen motion phase across unrelated commands', () => {
    let state = applyEvent(initialState('show'), event);
    state = applyEvent(state, { ...event, sequence: 2, effectiveAt: 1180, command: { type: 'toggle', slot: 7, value: true } });
    const phase = motionAt(state, 2000);
    state = applyEvent(state, { ...event, sequence: 3, effectiveAt: 2000, command: { type: 'control', key: 'glow', value: .9 } });
    expect(motionAt(state, 3000)).toBe(phase);
    state = applyEvent(state, { ...event, sequence: 4, effectiveAt: 3000, command: { type: 'toggle', slot: 7, value: false } });
    expect(motionAt(state, 4000)).toBeCloseTo(phase + 1.05);
  });
  it('clamps delayed continuous values to known history when a joining client has one snapshot', () => {
    const timeline = new StateTimeline();
    const state = initialState('show');
    const control: ShowEvent = { ...event, effectiveAt: 1000, command: { type: 'control', key: 'glow', value: 1 } };
    timeline.snapshot(state, [control], audioFrame, 900);
    expect(timeline.sample(1000)?.state.controls.glow).toBe(.45);
    const updated = applyEvent(state, control);
    timeline.frame(updated, { ...audioFrame, timestamp: 1010 }, 1010);
    expect(timeline.sample(1200)?.state.controls.glow).toBe(1);
    expect(timeline.sample(800)?.state.controls.glow).toBe(.45);
  });
});

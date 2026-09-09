import { applyEvent, INTERPOLATION_MS, SILENCE, type AudioFeatures, type AudioFrame, type ShowEvent, type ShowState } from '../shared/protocol';

/** NTP-style browser clock; all values are monotonic milliseconds. */
export class ShowClock {
  private samples: { offset: number; rtt: number }[] = [];
  private last = 0;
  private lastLocal = 0;
  private estimate = 0;
  private target = 0;
  private initialized = false;
  epoch = '';
  rtt = 0;
  get locked() { return this.samples.length >= 3; }
  get offset() { return this.estimate; }
  reset(epoch: string, localNow: number, serverNow: number) {
    this.epoch = epoch; this.samples = []; this.last = serverNow; this.lastLocal = localNow;
    this.estimate = this.target = serverNow - localNow; this.initialized = true;
  }
  observe(sentAt: number, receivedLocal: number, serverReceived: number, serverSent: number, epoch: string) {
    const rtt = (receivedLocal - sentAt) - (serverSent - serverReceived);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 2000 || receivedLocal < sentAt || serverSent < serverReceived) return;
    if (!this.initialized || epoch !== this.epoch) this.reset(epoch, receivedLocal, serverSent + rtt / 2);
    const offset = ((serverReceived - sentAt) + (serverSent - receivedLocal)) / 2;
    this.samples.push({ offset, rtt });
    this.samples = this.samples.slice(-24);
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    const offsets = best.map(sample => sample.offset).sort((a, b) => a - b);
    this.target = offsets[Math.floor(offsets.length / 2)];
    this.rtt = best[0].rtt;
    if (this.samples.length === 1) this.estimate = this.target;
  }
  now(localNow: number) {
    if (!this.initialized) return 0;
    localNow = Math.max(localNow, this.lastLocal);
    const elapsed = Math.max(0, localNow - this.lastLocal);
    // Slew corrections after initial lock, without moving the show clock backward.
    const correction = Math.max(-elapsed * .05, Math.min(elapsed * .05, this.target - this.estimate));
    this.estimate += correction;
    this.lastLocal = localNow;
    this.last = Math.max(this.last, localNow + this.estimate);
    return this.last;
  }
}

export class AudioTimeline {
  private frames: AudioFrame[] = [];
  clear() { this.frames = []; }
  push(frame: AudioFrame) {
    const existing = this.frames.findIndex(item => item.timestamp === frame.timestamp);
    if (existing >= 0) this.frames[existing] = frame;
    else this.frames.push(frame);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
    this.frames = this.frames.slice(-180);
  }
  sample(now: number, delay = INTERPOLATION_MS): AudioFeatures {
    const t = now - delay;
    if (!this.frames.length) return { ...SILENCE };
    const first = this.frames[0];
    if (t < first.timestamp) return { ...SILENCE };
    const upper = this.frames.findIndex(frame => frame.timestamp >= t);
    if (upper > 0) {
      const a = this.frames[upper - 1], b = this.frames[upper];
      const mix = (t - a.timestamp) / (b.timestamp - a.timestamp);
      const result = { ...a.audio };
      for (const key of Object.keys(result) as (keyof AudioFeatures)[]) result[key] += (b.audio[key] - a.audio[key]) * mix;
      const phaseDistance = ((b.audio.beatPhase - a.audio.beatPhase + 1.5) % 1) - .5;
      result.beatPhase = (a.audio.beatPhase + phaseDistance * mix + 1) % 1;
      return result;
    }
    const last = upper === 0 ? first : this.frames[this.frames.length - 1];
    const age = Math.max(0, t - last.timestamp);
    const decay = Math.exp(-Math.max(0, age - 100) / 250);
    const result = { ...last.audio };
    for (const key of ['level', 'bass', 'lowMid', 'mid', 'high', 'beat', 'bpmConfidence'] as const) result[key] *= decay;
    result.beatPhase = (result.beatPhase + age * result.bpm / 60000) % 1;
    if (age > 2000) result.bpm = 0;
    return result;
  }
}

export class StateTimeline {
  state: ShowState | null = null;
  private pending = new Map<string, ShowEvent>();
  private history: { timestamp: number; state: ShowState }[] = [];
  readonly audio = new AudioTimeline();
  get pendingEvents() { return [...this.pending.values()].sort((a, b) => a.effectiveAt - b.effectiveAt || a.sequence - b.sequence); }
  snapshot(state: ShowState, pending: ShowEvent[], frame: AudioFrame, timestamp: number) {
    const changedEpoch = this.state?.epoch !== state.epoch;
    if (changedEpoch) { this.audio.clear(); this.history = []; }
    this.state = structuredClone(state);
    // A replacement snapshot is also how canceled scheduled effects are removed.
    this.pending.clear();
    for (const event of pending) this.event(event);
    this.frame(state, frame, timestamp);
  }
  frame(state: ShowState, frame: AudioFrame, timestamp: number) {
    if (!this.state || this.state.epoch !== state.epoch) return;
    if (state.revision >= this.state.revision) this.state = structuredClone(state);
    this.audio.push(frame);
    this.history.push({ timestamp, state: structuredClone(state) });
    this.history.sort((a, b) => a.timestamp - b.timestamp);
    this.history = this.history.slice(-90);
    for (const [id, event] of this.pending) if (event.sequence <= this.state.revision) this.pending.delete(id);
  }
  event(event: ShowEvent) {
    if (!this.state || event.epoch !== this.state.epoch || event.sequence <= this.state.revision) return;
    if (this.pending.size < 512) this.pending.set(event.id, event);
  }
  sample(now: number): { state: ShowState; audio: AudioFeatures } | null {
    if (!this.state) return null;
    for (const event of this.pendingEvents) {
      if (event.effectiveAt > now) break;
      this.state = applyEvent(this.state, event);
      this.pending.delete(event.id);
    }
    const state = structuredClone(this.state);
    state.effects = state.effects.filter(effect => effect.effectiveAt + effect.duration > now);
    // Only interpolate continuous values across frames of this exact scene instance.
    const compatible = this.history.filter(item => item.state.sceneStartTime === state.sceneStartTime && item.state.seed === state.seed);
    const t = now - INTERPOLATION_MS;
    const after = compatible.findIndex(item => item.timestamp >= t);
    if (after > 0) {
      const a = compatible[after - 1], b = compatible[after];
      const denominator = b.timestamp - a.timestamp;
      const alpha = denominator > 0 ? (t - a.timestamp) / denominator : 1;
      for (const key of Object.keys(state.controls) as (keyof ShowState['controls'])[]) state.controls[key] = a.state.controls[key] + (b.state.controls[key] - a.state.controls[key]) * alpha;
      state.sceneParams = a.state.sceneParams.map((value, i) => value + (b.state.sceneParams[i] - value) * alpha);
    } else if (compatible.length) {
      const endpoint = after === 0 ? compatible[0] : compatible[compatible.length - 1];
      state.controls = { ...endpoint.state.controls };
      state.sceneParams = [...endpoint.state.sceneParams];
    }
    return { state, audio: this.audio.sample(now) };
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import {
  applyEvent, EVENT_LEAD_MS, initialState, SILENCE, syntheticAudio,
  type AudioFrame, type Command, type NativeMessage, type ShowEvent, type ShowState, type SourceStatus,
} from '../shared/protocol.js';

interface Transition { effectiveAt: number; scene: number }
export interface AuthorityOptions {
  now?: () => number; leadMs?: number; synthetic?: boolean;
  onEvent?: (event: ShowEvent) => void; onCancel?: () => void;
}

/** Scheduling and state authority; timestamps belong to this process's monotonic clock. */
export class Authority {
  readonly epoch = randomUUID();
  readonly now: () => number;
  readonly leadMs: number;
  state: ShowState;
  pending: ShowEvent[] = [];
  source: SourceStatus;
  private sequence = 0;
  private lastPublishedAt = 0;
  private transitions: Transition[] = [];
  private transitionIds = new Set<string>();
  private audio: AudioFrame;
  private lastAudioAt = -Infinity;
  private lastNativeAt = -Infinity;
  private lastAudioTimestamp = -Infinity;
  private lastDropAt = -Infinity;
  private readonly synthetic: boolean;
  constructor(private options: AuthorityOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.leadMs = options.leadMs ?? EVENT_LEAD_MS;
    this.state = initialState(this.epoch, this.now(), randomBytes(4).readUInt32BE());
    this.synthetic = !!options.synthetic;
    this.source = { capture: this.synthetic ? 'synthetic' : 'stopped', midi: 'disconnected', detail: this.synthetic ? 'Synthetic 120 BPM test signal; no system audio capture' : 'Waiting for the native bridge' };
    this.audio = { timestamp: this.now(), audio: { ...SILENCE }, source: 'silent' };
  }

  private event(command: Command, effectiveAt: number): ShowEvent {
    if (this.pending.length >= 512) throw new Error('Scheduled event queue is full');
    // Preserve execution order even after a delayed tick or an ingress request
    // whose body completed after a newer request. Late transitions may shift.
    effectiveAt = Math.max(effectiveAt, this.lastPublishedAt);
    this.lastPublishedAt = effectiveAt;
    const event: ShowEvent = { id: randomUUID(), epoch: this.epoch, sequence: ++this.sequence,
      effectiveAt, seed: randomBytes(4).readUInt32BE(), command };
    this.pending.push(event);
    this.pending.sort((a, b) => a.effectiveAt - b.effectiveAt || a.sequence - b.sequence);
    this.options.onEvent?.(event);
    return event;
  }

  advance(now = this.now()): void {
    // Only allocate revisions to transitions as their announcement horizon arrives.
    // Reserving a revision at DROP receipt would let later controls overtake it.
    while (this.transitions.length && this.transitions[0].effectiveAt - this.leadMs <= now) {
      const transition = this.transitions.shift()!;
      const event = this.event({ type: 'scene', scene: transition.scene }, transition.effectiveAt);
      this.transitionIds.add(event.id);
    }
    while (this.pending.length && this.pending[0].effectiveAt <= now) {
      const event = this.pending.shift()!;
      this.transitionIds.delete(event.id);
      this.state = applyEvent(this.state, event);
    }
    this.state.effects = this.state.effects.filter(effect => effect.effectiveAt + effect.duration > now);
  }

  projected(now = this.now()): ShowState {
    this.advance(now);
    return this.pending.reduce(applyEvent, this.state);
  }

  schedule(command: Command, now = this.now()): ShowEvent {
    now = Math.max(now, this.now());
    this.advance(now);
    if (this.pending.length >= 500) throw new Error('Too many scheduled commands; wait briefly');
    if (command.type === 'drop') {
      if (!this.projected(now).running) throw new Error('Start the show before triggering DROP');
      if (now - this.lastDropAt < 600) throw new Error('DROP cooldown is 600 ms');
      this.lastDropAt = now;
    }
    const effectiveAt = now + this.leadMs;
    let canceled = false;
    if (command.type === 'clear' || command.type === 'reset') {
      this.transitions = [];
      // Published future DROP/burst commands are removed by a replacement snapshot.
      this.pending = this.pending.filter(event => event.command.type !== 'drop' && event.command.type !== 'burst' && !this.transitionIds.has(event.id));
      this.transitionIds.clear();
      this.lastDropAt = -Infinity;
      canceled = true;
    }
    if (command.type === 'drop' && command.targetScene !== undefined && this.transitionIds.size) {
      this.pending = this.pending.filter(event => !this.transitionIds.has(event.id));
      this.transitionIds.clear();
      canceled = true;
    }
    if (command.type === 'scene') {
      canceled ||= this.transitions.length > 0 || this.transitionIds.size > 0;
      this.transitions = [];
      this.pending = this.pending.filter(event => !this.transitionIds.has(event.id));
      this.transitionIds.clear();
    }
    const event = this.event(command, effectiveAt);
    if (command.type === 'drop' && command.targetScene !== undefined) {
      // A new DROP replaces the earlier unfinished transition; overlapping effects
      // remain bounded by the reducer, while the latest requested finale wins.
      this.transitions = [{ effectiveAt: event.effectiveAt + command.duration, scene: command.targetScene }];
    }
    if (canceled) this.options.onCancel?.();
    return event;
  }

  touchNative(now = this.now()): void { this.lastNativeAt = now; }

  ingest(message: Exclude<NativeMessage, { type: 'midi' }>, now = this.now()): void {
    this.touchNative(now);
    if (message.type === 'source') {
      this.source = { capture: this.synthetic ? 'synthetic' : message.capture, midi: message.midi,
        detail: this.synthetic ? 'Synthetic 120 BPM test signal; no system audio capture' : message.detail };
    } else if (!this.synthetic && message.timestamp > this.lastAudioTimestamp) {
      this.lastAudioTimestamp = message.timestamp;
      this.lastAudioAt = now;
      this.audio = { timestamp: message.timestamp, audio: { ...message.audio }, source: message.source };
      this.source.capture = message.source === 'synthetic' ? 'synthetic' : 'running';
    }
  }

  audioFrame(now = this.now()): AudioFrame {
    if (now - this.lastNativeAt > 6000) this.source.midi = 'disconnected';
    if (this.synthetic) return { timestamp: now, audio: syntheticAudio(now), source: 'synthetic' };
    const age = now - this.lastAudioAt;
    if (age <= 250) return this.audio;
    if (age > 1500) {
      if (this.source.capture === 'running' || this.source.capture === 'synthetic') {
        this.source = { ...this.source, capture: 'error', detail: 'Audio features timed out; output decayed to silence' };
      }
      return { timestamp: now, audio: { ...SILENCE }, source: 'silent' };
    }
    const gain = Math.exp(-(age - 250) / 220);
    const a = this.audio.audio;
    return { timestamp: now, source: this.audio.source, audio: { ...a, level: a.level * gain,
      bass: a.bass * gain, lowMid: a.lowMid * gain, mid: a.mid * gain, high: a.high * gain,
      beat: a.beat * gain, bpmConfidence: a.bpmConfidence * gain } };
  }
}

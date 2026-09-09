import { z } from 'zod';
import { SCENE_COUNT } from './scenes.js';
export { SCENES, SCENE_COUNT } from './scenes.js';

export const VERSION = 1 as const;
export const FRAME_HZ = 30;
export const EVENT_LEAD_MS = 180;
export const INTERPOLATION_MS = 100;
export const CONTROL_KEYS = ['intensity', 'density', 'speed', 'scale', 'distortion', 'glow', 'glitch', 'masterFX'] as const;
export const EFFECT_NAMES = ['Orbit', 'Pulse', 'Twist', 'Mirror', 'Scatter', 'Strobe', 'Prism', 'Freeze'] as const;
export type ControlKey = typeof CONTROL_KEYS[number];
export const unit = z.number().finite().min(0).max(1);
const time = z.number().finite().nonnegative();
const sceneId = z.number().int().min(0).max(SCENE_COUNT - 1);
const slot = z.number().int().min(0).max(7);
export const AudioSchema = z.object({
  level: unit, bass: unit, lowMid: unit, mid: unit, high: unit, beat: unit,
  beatPhase: unit, bpm: z.number().finite().min(0).max(300), bpmConfidence: unit,
}).strict();
export type AudioFeatures = z.infer<typeof AudioSchema>;
export const SILENCE: AudioFeatures = { level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, beat: 0, beatPhase: 0, bpm: 0, bpmConfidence: 0 };
export const ControlsSchema = z.object({
  intensity: unit, density: unit, speed: unit, scale: unit, distortion: unit, glow: unit, glitch: unit, masterFX: unit,
}).strict();
export type Controls = z.infer<typeof ControlsSchema>;
export const DEFAULT_CONTROLS: Controls = { intensity: .7, density: .5, speed: .35, scale: .5, distortion: .2, glow: .45, glitch: .1, masterFX: .7 };

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene'), scene: sceneId }).strict(),
  z.object({ type: z.literal('control'), key: z.enum(CONTROL_KEYS), value: unit }).strict(),
  z.object({ type: z.literal('knob'), slot, value: unit }).strict(),
  z.object({ type: z.literal('toggle'), slot, value: z.boolean() }).strict(),
  z.object({ type: z.literal('burst'), slot }).strict(),
  z.object({ type: z.literal('drop'), duration: z.number().finite().min(600).max(6000).default(1800), strength: unit.default(.7), targetScene: sceneId.optional() }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('clear') }).strict(),
  z.object({ type: z.literal('reset') }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export const EventSchema = z.object({
  id: z.string().max(100), epoch: z.string().max(100), sequence: z.number().int().nonnegative(),
  effectiveAt: time, seed: z.number().int().min(0).max(0xffffffff), command: CommandSchema,
}).strict();
export type ShowEvent = z.infer<typeof EventSchema>;
export const ActiveEffectSchema = z.object({
  id: z.string(), kind: z.enum(['drop', 'burst']), effectiveAt: time,
  duration: z.number().finite().positive(), strength: unit, slot, seed: z.number().int(),
  frozenPhase: z.number().finite().optional(),
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;
export const ShowStateSchema = z.object({
  epoch: z.string().max(100), revision: z.number().int().nonnegative(), scene: sceneId,
  sceneStartTime: time, seed: z.number().int().min(0).max(0xffffffff), running: z.boolean(),
  controls: ControlsSchema, sceneParams: z.array(unit).length(8), toggles: z.array(z.boolean()).length(8),
  motion: z.object({ phase: z.number().finite(), at: time, rate: z.number().finite().min(0).max(3) }).strict(),
  effects: z.array(ActiveEffectSchema).max(16),
}).strict();
export type ShowState = z.infer<typeof ShowStateSchema>;
export const SourceSchema = z.object({
  capture: z.enum(['running', 'stopped', 'error', 'synthetic']),
  midi: z.enum(['connected', 'disconnected']), detail: z.string().max(500),
}).strict();
export type SourceStatus = z.infer<typeof SourceSchema>;
export const AudioFrameSchema = z.object({ timestamp: time, audio: AudioSchema, source: z.enum(['system', 'synthetic', 'silent']) }).strict();
export type AudioFrame = z.infer<typeof AudioFrameSchema>;
export const TelemetrySchema = z.object({
  rtt: z.number().finite().min(0).max(60000), offset: z.number().finite(), locked: z.boolean(),
  fps: z.number().finite().min(0).max(1000), scene: sceneId, calibrated: z.boolean(),
  xr: z.boolean(), quality: z.enum(['low', 'medium', 'high']),
}).strict();
export type Telemetry = z.infer<typeof TelemetrySchema>;
export const ClientInfoSchema = z.object({
  id: z.string(), name: z.string().max(60), role: z.enum(['hmd', 'dashboard']), lastSeen: time,
  telemetry: TelemetrySchema.nullable(),
}).strict();
export type ClientInfo = z.infer<typeof ClientInfoSchema>;
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(VERSION), type: z.literal('hello'), role: z.enum(['hmd', 'dashboard']), name: z.string().min(1).max(60), token: z.string().max(256).optional() }).strict(),
  z.object({ version: z.literal(VERSION), type: z.literal('ping'), id: z.number().int().nonnegative(), sentAt: time }).strict(),
  z.object({ version: z.literal(VERSION), type: z.literal('command'), requestId: z.string().min(1).max(100), command: CommandSchema }).strict(),
  z.object({ version: z.literal(VERSION), type: z.literal('telemetry'), telemetry: TelemetrySchema }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(VERSION), type: z.literal('snapshot'), clientId: z.string(), serverTime: time, state: ShowStateSchema, pending: z.array(EventSchema).max(512), audioFrame: AudioFrameSchema, source: SourceSchema }),
  z.object({ version: z.literal(VERSION), type: z.literal('frame'), timestamp: time, state: ShowStateSchema, audioFrame: AudioFrameSchema, source: SourceSchema }),
  z.object({ version: z.literal(VERSION), type: z.literal('event'), event: EventSchema }),
  z.object({ version: z.literal(VERSION), type: z.literal('pong'), id: z.number().int(), sentAt: time, receivedAt: time, serverTime: time, epoch: z.string() }),
  z.object({ version: z.literal(VERSION), type: z.literal('ack'), requestId: z.string(), eventId: z.string(), effectiveAt: time }),
  z.object({ version: z.literal(VERSION), type: z.literal('error'), message: z.string().max(500), requestId: z.string().optional() }),
  z.object({ version: z.literal(VERSION), type: z.literal('clients'), clients: z.array(ClientInfoSchema).max(128) }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export const NativeMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(VERSION), type: z.literal('audio'), timestamp: time, audio: AudioSchema, source: z.enum(['system', 'synthetic']) }).strict(),
  z.object({ version: z.literal(VERSION), type: z.literal('midi'), timestamp: time, status: z.number().int().min(0x80).max(0xef), data1: z.number().int().min(0).max(127), data2: z.number().int().min(0).max(127) }).strict(),
  z.object({ version: z.literal(VERSION), type: z.literal('source'), ...SourceSchema.shape }).strict(),
]);
export type NativeMessage = z.infer<typeof NativeMessageSchema>;

export function initialState(epoch: string, now = 0, seed = 48291): ShowState {
  return { epoch, revision: 0, scene: 0, sceneStartTime: now, seed, running: false,
    controls: { ...DEFAULT_CONTROLS }, sceneParams: Array(8).fill(.5), toggles: Array(8).fill(false),
    motion: { phase: 0, at: now, rate: DEFAULT_CONTROLS.speed * 3 }, effects: [] };
}

export function motionAt(state: ShowState, now: number): number {
  return state.motion.phase + (state.running && !state.toggles[7] ? Math.max(0, now - state.motion.at) * .001 * state.motion.rate : 0);
}

/** Pure state transitions shared by the authority and scheduled client playback. */
export function applyEvent(state: ShowState, event: ShowEvent): ShowState {
  if (event.epoch !== state.epoch || event.sequence <= state.revision) return state;
  const next = structuredClone(state);
  next.revision = event.sequence;
  next.motion = { phase: motionAt(state, event.effectiveAt), at: event.effectiveAt, rate: state.motion.rate };
  next.effects = next.effects.filter(effect => effect.effectiveAt + effect.duration > event.effectiveAt);
  const c = event.command;
  if (c.type === 'scene') {
    next.scene = c.scene; next.seed = event.seed; next.sceneStartTime = event.effectiveAt;
    next.motion.phase = 0; next.effects = []; next.sceneParams.fill(.5);
  } else if (c.type === 'control') {
    next.controls[c.key] = c.value;
    if (c.key === 'speed') next.motion.rate = c.value * 3;
  } else if (c.type === 'knob') next.sceneParams[c.slot] = c.value;
  else if (c.type === 'toggle') next.toggles[c.slot] = c.value;
  else if (c.type === 'start') next.running = true;
  else if (c.type === 'clear') { next.running = false; next.effects = []; }
  else if (c.type === 'reset') {
    const reset = initialState(state.epoch, event.effectiveAt, event.seed);
    reset.revision = event.sequence;
    return reset;
  } else if ((c.type === 'drop' || c.type === 'burst') && state.running) {
    next.effects.push({ id: event.id, kind: c.type, effectiveAt: event.effectiveAt,
      duration: c.type === 'drop' ? c.duration : 850, strength: c.type === 'drop' ? c.strength : .65,
      slot: c.type === 'burst' ? c.slot : 0, seed: event.seed,
      ...(c.type === 'burst' && c.slot === 7 ? { frozenPhase: motionAt(state, event.effectiveAt) } : {}) });
    next.effects = next.effects.slice(-16);
  }
  return next;
}

/** Stateless integer hash: particle identity survives frame-rate and quality changes. */
export function seeded(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

export function syntheticAudio(now: number): AudioFeatures {
  const beatPhase = (now / 500) % 1;
  const beat = Math.exp(-beatPhase * 15);
  return { level: .18 + beat * .5, bass: .15 + beat * .7, lowMid: .25 + .12 * Math.sin(now * .003),
    mid: .3 + .2 * Math.sin(now * .0017), high: .08 + .3 * Math.pow(Math.sin(now * .008), 8),
    beat, beatPhase, bpm: 120, bpmConfidence: 1 };
}

import { z } from 'zod';
import { CONTROL_KEYS, SCENE_COUNT, type Command, type NativeMessage, type ShowState } from '../shared/protocol.js';

const cc = z.number().int().min(0).max(127);
const bank = z.array(cc).length(8);
export const MidiProfileSchema = z.object({
  name: z.string().min(1).max(100), channel: z.number().int().min(0).max(15).default(0),
  buttonMode: z.enum(['cc', 'note']).default('cc'),
  faders: bank, knobs: bank, scenes: bank, bursts: bank, toggles: bank,
  transport: z.object({ previous: cc, next: cc, clear: cc, start: cc, drop: cc }).strict(),
  pickupTolerance: z.number().min(0).max(.2).default(2 / 127),
  debounceMs: z.number().min(0).max(1000).default(35),
}).strict().refine(profile => {
  const continuous = [...profile.faders, ...profile.knobs];
  const buttons = [...profile.scenes, ...profile.bursts, ...profile.toggles, ...Object.values(profile.transport)];
  const groups = profile.buttonMode === 'cc' ? [[...continuous, ...buttons]] : [continuous, buttons];
  return groups.every(values => new Set(values).size === values.length);
}, 'Each physical input must map to only one control');
export type MidiProfile = z.infer<typeof MidiProfileSchema>;
export const NANO_KONTROL_2: MidiProfile = MidiProfileSchema.parse({
  name: 'Korg nanoKONTROL2 factory CC', faders: [0,1,2,3,4,5,6,7], knobs: [16,17,18,19,20,21,22,23],
  scenes: [32,33,34,35,36,37,38,39], bursts: [48,49,50,51,52,53,54,55], toggles: [64,65,66,67,68,69,70,71],
  transport: { previous: 43, next: 44, clear: 42, start: 41, drop: 45 },
});
interface Pickup { last?: number; target: number; latched: boolean }

/** Converts physical input into the same commands as the authenticated dashboard. */
export class MidiMapper {
  private buttons = new Map<number, { down: boolean; lastPress: number }>();
  private pickup = new Map<string, Pickup>();
  private sceneKey = '';
  constructor(readonly profile: MidiProfile = NANO_KONTROL_2) {}

  reset(): void { this.buttons.clear(); this.pickup.clear(); this.sceneKey = ''; }

  private take(key: string, value: number, target: number): boolean {
    const previous = this.pickup.get(key);
    const entry: Pickup = previous ?? { target, latched: false };
    if (Math.abs(entry.target - target) > .00001) entry.latched = false;
    entry.target = target;
    const close = Math.abs(value - target) <= this.profile.pickupTolerance;
    const crosses = entry.last !== undefined && (entry.last - target) * (value - target) <= 0;
    entry.latched ||= close || crosses;
    entry.last = value;
    if (entry.latched) entry.target = value;
    this.pickup.set(key, entry);
    return entry.latched;
  }

  consume(message: Extract<NativeMessage, { type: 'midi' }>, projected: ShowState, now: number): Command | null {
    if ((message.status & 15) !== this.profile.channel) return null;
    const kind = message.status & 0xf0;
    const p = this.profile;
    const sceneKey = `${projected.scene}:${projected.sceneStartTime}`;
    if (sceneKey !== this.sceneKey) {
      for (let slot = 0; slot < 8; slot++) this.pickup.delete(`knob:${slot}`);
      this.sceneKey = sceneKey;
    }
    if (kind === 0xb0) {
      const value = message.data2 / 127;
      let slot = p.faders.indexOf(message.data1);
      if (slot >= 0) {
        const key = CONTROL_KEYS[slot];
        return this.take(`control:${key}`, value, projected.controls[key]) ? { type: 'control', key, value } : null;
      }
      slot = p.knobs.indexOf(message.data1);
      if (slot >= 0) return this.take(`knob:${slot}`, value, projected.sceneParams[slot]) ? { type: 'knob', slot, value } : null;
    }
    if (p.buttonMode === 'cc' ? kind !== 0xb0 : kind !== 0x90 && kind !== 0x80) return null;
    const down = kind !== 0x80 && message.data2 > 0;
    const button = this.buttons.get(message.data1) ?? { down: false, lastPress: -Infinity };
    const rising = down && !button.down;
    button.down = down;
    this.buttons.set(message.data1, button);
    if (!rising || now - button.lastPress < p.debounceMs) return null;
    button.lastPress = now;
    let slot = p.scenes.indexOf(message.data1);
    if (slot >= 0) return slot < SCENE_COUNT ? { type: 'scene', scene: slot } : null;
    slot = p.bursts.indexOf(message.data1);
    if (slot >= 0) return { type: 'burst', slot };
    slot = p.toggles.indexOf(message.data1);
    if (slot >= 0) return { type: 'toggle', slot, value: !projected.toggles[slot] };
    if (message.data1 === p.transport.previous) return { type: 'scene', scene: (projected.scene + SCENE_COUNT - 1) % SCENE_COUNT };
    if (message.data1 === p.transport.next) return { type: 'scene', scene: (projected.scene + 1) % SCENE_COUNT };
    if (message.data1 === p.transport.clear) return { type: 'clear' };
    if (message.data1 === p.transport.start) return { type: 'start' };
    if (message.data1 === p.transport.drop) return { type: 'drop', duration: 1800, strength: .7 };
    return null;
  }
}

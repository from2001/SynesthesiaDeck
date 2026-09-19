import type { ActiveEffect, ShowState } from '../../shared/protocol';
import type { DesktopCameraPose } from '../visuals/renderer';

export type ShotName = 'wide' | 'mid' | 'close' | 'long';
export interface ShotPreset extends DesktopCameraPose { transitionMs: number }
export const SHOTS: Readonly<Record<ShotName, ShotPreset>> = {
  wide: { position: [13, 9, 16], target: [0, 2.4, 0], fov: 56, transitionMs: 1800 },
  mid: { position: [8, 4.6, 9], target: [0, 2.2, 0], fov: 48, transitionMs: 1600 },
  close: { position: [4.5, 3.2, 5.5], target: [0, 2.1, 0], fov: 42, transitionMs: 900 },
  long: { position: [-16, 6.5, 21], target: [0, 2.4, 0], fov: 36, transitionMs: 2000 },
};
export const SECTION_MS = 16000;
export const EVENT_COOLDOWN_MS = 4000;
export const LOSS_TIMEOUT_MS = 2000;
const RETURN_MS = 1600;
const ORDER: readonly ShotName[] = ['wide', 'mid', 'long', 'close'];
export type SyncHealth = 'live' | 'waiting' | 'acquiring' | 'disconnected' | 'stale';
export interface CameraInput {
  state: ShowState | null;
  now: number;
  localNow: number;
  connected: boolean;
  locked: boolean;
  lastFrameAt: number | null;
}
export interface CameraFrame extends DesktopCameraPose {
  shot: ShotName;
  reason: 'section' | 'drop' | 'burst' | 'loss' | 'stopped';
  section: number;
  sectionProgress: number;
  health: SyncHealth;
  frameAgeMs: number | null;
  cutId: string | null;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function blend(a: DesktopCameraPose, b: DesktopCameraPose, amount: number): DesktopCameraPose {
  const t = ease(amount);
  return {
    position: [lerp(a.position[0], b.position[0], t), lerp(a.position[1], b.position[1], t), lerp(a.position[2], b.position[2], t)],
    target: [lerp(a.target[0], b.target[0], t), lerp(a.target[1], b.target[1], t), lerp(a.target[2], b.target[2], t)],
    fov: lerp(a.fov, b.fov, t),
  };
}

function shotFor(state: ShowState, section: number): ShotName {
  if (section === 0) return 'wide';
  // Each scene starts wide, then visits every shot without assuming a scene count.
  const offset = ((state.seed >>> 0) + state.scene) % 3;
  return ORDER[(section + offset) % ORDER.length];
}

function movingPose(shot: ShotName, state: ShowState, now: number): DesktopCameraPose {
  const preset = SHOTS[shot];
  const time = Math.max(0, now - state.sceneStartTime) * .001;
  const phase = (state.seed % 1024) / 1024 * Math.PI * 2;
  const angle = Math.sin(time * .085 + phase) * .12;
  const x = preset.position[0] - preset.target[0], z = preset.position[2] - preset.target[2];
  return {
    position: [preset.target[0] + x * Math.cos(angle) - z * Math.sin(angle), preset.position[1] + Math.sin(time * .11 + phase) * .18, preset.target[2] + x * Math.sin(angle) + z * Math.cos(angle)],
    target: [...preset.target], fov: preset.fov,
  };
}

/** Absolute show time, not accumulated frame deltas, determines sections and camera motion. */
export function sectionCamera(state: ShowState, now: number): DesktopCameraPose & { shot: ShotName; section: number; sectionProgress: number } {
  const elapsed = Math.max(0, now - state.sceneStartTime);
  const section = Math.floor(elapsed / SECTION_MS), start = state.sceneStartTime + section * SECTION_MS;
  const shot = shotFor(state, section), target = movingPose(shot, state, now);
  const from = section ? movingPose(shotFor(state, section - 1), state, start) : target;
  return { ...blend(from, target, section ? (now - start) / SHOTS[shot].transitionMs : 1), shot, section, sectionProgress: (elapsed % SECTION_MS) / SECTION_MS };
}

/** Track authoritative frame replacements; clock pongs and locally applied cues are not fresh frames. */
export class PreviewFrameWatch {
  private state: ShowState | null = null;
  lastFrameAt: number | null = null;
  receive(state: ShowState | null, localNow: number): void {
    if (state && state !== this.state) this.lastFrameAt = localNow;
    this.state = state;
  }
  sampled(state: ShowState | null): void { this.state = state; }
}

interface EventCut { effect: ActiveEffect; shot: ShotName; from: DesktopCameraPose; returnAt: number; endAt: number }

export class PreviewDirector {
  private identity = '';
  private seen = new Set<string>();
  private cut: EventCut | null = null;
  private nextEventAt = -Infinity;
  private lastPose: DesktopCameraPose = SHOTS.wide;
  private safe = true;
  private settling: { from: DesktopCameraPose; at: number } | null = null;

  sample(input: CameraInput): CameraFrame {
    const { state, now, localNow } = input;
    const frameAgeMs = input.lastFrameAt === null ? null : Math.max(0, localNow - input.lastFrameAt);
    const health: SyncHealth = !state ? 'waiting' : !input.connected ? 'disconnected' : frameAgeMs === null || frameAgeMs >= LOSS_TIMEOUT_MS ? 'stale' : !input.locked ? 'acquiring' : 'live';
    const identity = state ? `${state.epoch}:${state.sceneStartTime}:${state.scene}:${state.seed}:${state.running}` : '';
    if (identity !== this.identity) {
      this.identity = identity; this.seen.clear(); this.cut = null; this.nextEventAt = -Infinity;
      this.settling = { from: this.lastPose, at: localNow };
    }
    const safe = health !== 'live' || !state?.running;
    if (safe !== this.safe) {
      this.settling = { from: this.lastPose, at: localNow };
      this.safe = safe;
    }
    const base = state ? sectionCamera(state, now) : { ...SHOTS.wide, shot: 'wide' as const, section: 0, sectionProgress: 0 };
    let pose: DesktopCameraPose = base, shot = base.shot;
    let reason: CameraFrame['reason'] = 'section', cutId: string | null = null;
    if (safe) {
      pose = SHOTS.wide; shot = 'wide'; reason = health === 'live' ? 'stopped' : 'loss';
    } else if (state) {
      const effects = [...state.effects].sort((a, b) => a.effectiveAt - b.effectiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const effect of effects) {
        if (effect.effectiveAt > now || effect.effectiveAt < state.sceneStartTime || effect.effectiveAt + effect.duration <= now || this.seen.has(effect.id)) continue;
        this.seen.add(effect.id);
        if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
        if (effect.effectiveAt < this.nextEventAt) continue;
        const returnAt = effect.effectiveAt + Math.max(effect.duration, EVENT_COOLDOWN_MS);
        this.cut = { effect: { ...effect }, shot: effect.kind === 'drop' ? 'close' : 'mid', from: sectionCamera(state, effect.effectiveAt), returnAt, endAt: returnAt + RETURN_MS };
        this.nextEventAt = this.cut.endAt + EVENT_COOLDOWN_MS;
      }
      if (this.cut && now < this.cut.endAt) {
        const cut = this.cut;
        const target = movingPose(cut.shot, state, now);
        if (now < cut.returnAt) {
          pose = blend(cut.from, target, (now - cut.effect.effectiveAt) / SHOTS[cut.shot].transitionMs);
          shot = cut.shot; reason = cut.effect.kind;
        } else {
          pose = blend(movingPose(cut.shot, state, cut.returnAt), base, (now - cut.returnAt) / RETURN_MS);
        }
        cutId = cut.effect.id;
      } else this.cut = null;
    }
    // Loss recovery must keep moving even when ShowConnection freezes its shared clock.
    if (this.settling) {
      const amount = (localNow - this.settling.at) / SHOTS.wide.transitionMs;
      pose = blend(this.settling.from, pose, amount);
      if (amount >= 1) this.settling = null;
    }
    this.lastPose = pose;
    return { ...pose, shot, reason, section: base.section, sectionProgress: base.sectionProgress, health, frameAgeMs, cutId };
  }
}

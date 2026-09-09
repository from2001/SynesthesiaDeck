# Validation status — 2026-09-09

The software is integrated and usable for a desktop demonstration. Physical HMD validation is **deferred at the user's explicit request**: the connected Quest 3S belongs to another active project and must not be operated. No headset application, browser session, tracking setting, or device test was launched for this implementation.

## Completed checks

| Check | Evidence/result |
| --- | --- |
| TypeScript protocol, server, client, and renderer | Typecheck and production build pass |
| Automated TypeScript tests | 47 tests across protocol, server HTTP/WS, MIDI mapping, browser connection recovery, clock/interpolation, visual math/effects, and calibration |
| Swift package | Debug/release builds and 13 DSP/MIDI/clock tests pass |
| Dependency audit | Zero reported vulnerabilities at verification time |
| Actual native-to-server integration | `npm run verify:system` uses the real Swift executable, authenticated HTTP ingress and two certificate-validated WSS consumers |
| Native synthetic feature delivery | 238 frames in the eight-second fixture; 29.877 delivered Hz; 33.333 ms analysis timestamp cadence; 52.841 ms feature age p95; acquired BPM 120 |
| Native MIDI replay | 25 input messages → 13 scheduled events received identically by both clients; exactly one DROP; STOP clears; final scene index 3 |
| TLS verification | Temporary CA chain and hostname verified for HTTPS/WSS; untrusted chain rejected. No global trust/keychain changes |
| Server restart | New epoch, stopped transport, and no replay of old effects |
| Desktop production browser | Actual hashed production JS bundle loaded; renderer ready; no page errors or Vite overlay |
| Desk-to-audience flow | Separate Chrome sessions agree on scene/seed; Glow, effect toggle, Freeze burst, DROP destination, Clear/Play, and audience reload verified |
| Server disconnect/reconnect | Audience showed Reconnecting, then recovered a cleared snapshot after production-server restart |
| Visual inspection | All five procedural presets rendered; desktop transparent-Bloom checkerboard and desktop A/B calibration/reset inspected |
| Responsive desk | 1440 × 1000 and 390 × 844 viewports checked; no horizontal overflow at the smaller viewport |

The native source selector in the integrated script deliberately matches no physical MIDI device, and the audio fixture is synthetic. The measured feature age is **not** end-to-end audio-to-visual latency or headset presentation skew. Desktop Chrome FPS samples do not establish a headset frame-time budget. These distinctions must remain visible in future reports.

Before the integration run, the native implementation independently enumerated the existing KORG nanoKONTROL2 CoreMIDI source. Already-granted macOS permission allowed a finite six-second capture of current silence: 48 kHz stereo float32, 180 analyzed frames, approximately 0.150 ms analysis work per frame. This establishes source access and silence handling, not playback from two named applications or physical MIDI movement. No permission dialog or device setting was changed.

## Software delivered and remaining acceptance

| Issues | Delivered | Still required |
| --- | --- | --- |
| #2, #5 | Shared schemas/scaffold, authoritative server, clock contract, native bridge, CI and deterministic fixtures | No known remaining software gate from their current acceptance lists |
| #3, #4 | HTTPS/WSS setup, WebGL2-backed MR sessions, transparent TSL Bloom | Trusted venue access on two HMDs; actual both-eye passthrough/Bloom |
| #6, #7, #13, #14 | Capture, DSP, CoreMIDI, custom profiles and show control mapping | Two named playback apps, live music behavior, all physical controls and hot-plug |
| #8, #9 | Offset filtering, event scheduling, buffered features/controls, snapshots and reconnect | Actual multi-HMD presentation skew and venue jitter measurements |
| #10, #11, #16–#20 | Five presets, deterministic phase/identity, quality tiers and DROP/one-shot/toggle effects | Both-eye visual inspection, peak-load headset performance and real REC execution |
| #15 | Complete operator dashboard and desktop control/client flow | Physical-device telemetry during immersive use remains part of the hardware gate |
| #21 | Two-floor-point transform, controller workflow, session/reset invalidation | Physical A/B/third-point alignment error across two HMDs |
| #12, #22 | Reproducible diagnostic tools, source-specific evidence and rehearsal/runbook | Real audio + physical controller + two-HMD MVP; 30-minute hardware soak and live rehearsal |

Issues with deferred hardware criteria remain open. The parent epic is not complete.

## Reproduce

```sh
npm ci
npm run check
npm run native:build
npm run native:test
VERIFY_OUTPUT=artifacts/system-verification.json npm run verify:system
npm audit
```

For browser verification, run `npm run setup`, then `npm run build` and `npm run start -- --synthetic`. Use one VJ desk and another audience browser session, authenticate only the desk, and exercise the controls described above. Synthetic mode must remain labeled.

Local evidence is intentionally gitignored: `artifacts/system-verification.json`, `artifacts/dashboard-desktop.png`, and `artifacts/dashboard-mobile.png`. CI publishes the system-verification JSON as an artifact. The native guide also documents its standalone retry/epoch integration script.

## Known limits

- Beat/BPM estimation is a basic onset/interval meter; complex rhythms and silent/blocked content require operator judgment. DROP remains manual.
- macOS audio channel averaging can cancel phase-inverted stereo content; non-live-tested PCM formats remain documented in the native guide.
- MR and quality tiers are implemented, but headset support, frame rate, stereo composition and shared-room accuracy are unverified.
- Trusted venue HTTPS certificate setup is an operator step; local HTTP demonstration and the temporary test CA do not configure a headset.
- The show buffer intentionally adds 100 ms for continuous values. Scheduled discrete events use effectiveAt directly. Actual musical alignment should be measured and tuned at the venue.

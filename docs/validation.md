# Validation status — 2026-09-09

The software is integrated and usable for a desktop demonstration. On 2026-09-09, the user reported successfully viewing the content on an HMD. This is user-reported display confirmation; device/browser versions, the exact connection route, per-scene coverage, both-eye composition, and timing measurements were not recorded. The agent has not operated the connected Quest 3S, changed its settings, or launched a device test. The earlier restriction on agent-operated testing remains in place until the device is explicitly made available.

## Completed checks

| Check | Evidence/result |
| --- | --- |
| TypeScript protocol, server, client, and renderer | Typecheck and production build pass |
| Automated TypeScript tests | 120 tests across protocol, server HTTP/WS, MIDI mapping, browser connection recovery, endpoint selection and credential isolation, tunnel supervision and exclusive ownership, clock/interpolation, all 15 presets, visual math/effects, and calibration |
| Swift package | Debug/release builds and 13 DSP/MIDI/clock tests pass |
| Dependency audit | Zero reported vulnerabilities at verification time |
| Actual native-to-server integration | `npm run verify:system` uses the real Swift executable, authenticated HTTP ingress and two certificate-validated WSS consumers |
| Native synthetic feature delivery | Latest expansion run: 239 frames in the eight-second fixture; 30.003 delivered Hz; 33.333 ms analysis timestamp cadence; 17.987 ms feature age p95; acquired BPM 120 |
| Native MIDI replay | 25 input messages → 13 scheduled events received identically by both clients; exactly one DROP; STOP clears; final scene index 3 |
| TLS verification | Temporary CA chain and hostname verified for HTTPS/WSS; untrusted chain rejected. No global trust/keychain changes |
| Server restart | New epoch, stopped transport, and no replay of old effects |
| Desktop production browser | Actual hashed production JS bundle loaded; renderer ready; no page errors or Vite overlay |
| Desk-to-audience flow | Separate Chrome sessions agree on scene/seed; Glow, effect toggle, Freeze burst, DROP destination, Clear/Play, and audience reload verified |
| Server disconnect/reconnect | Audience showed Reconnecting, then recovered a cleared snapshot after production-server restart |
| Visual inspection | All 15 presets rendered and individually inspected in the final production build; desktop transparent-Bloom checkerboard and desktop A/B calibration/reset were inspected during the original five-scene delivery |
| Responsive desk | Original delivery checked 1440 × 1000 and 390 × 844. Expanded catalog checked at the current 876-pixel desk width with no horizontal overflow; expanded mobile layout has not been revalidated |

The native source selector in the integrated script deliberately matches no physical MIDI device, and the audio fixture is synthetic. The measured feature age is **not** end-to-end audio-to-visual latency or headset presentation skew. Desktop Chrome FPS samples do not establish a headset frame-time budget. These distinctions must remain visible in future reports.

Before the integration run, the native implementation independently enumerated the existing KORG nanoKONTROL2 CoreMIDI source. Already-granted macOS permission allowed a finite six-second capture of current silence: 48 kHz stereo float32, 180 analyzed frames, approximately 0.150 ms analysis work per frame. This establishes source access and silence handling, not playback from two named applications or physical MIDI movement. No permission dialog or device setting was changed.

## Ten-scene expansion

The final production bundle `index-Cvwhu4hx.js` was loaded in the Codex desktop browser with separate operator and audience tabs. All 15 presets were selected through the visible dropdown, received by the audience, captured, and visually inspected at Medium. The original scene bank still renders correctly after switching through both new banks. No browser error-level logs or renderer failure messages were observed in these checks.

Additional checks covered Next 15 → 01, Previous 01 → 15, DROP from Prismatic Portal to Liquid Mercury, Clear/Play, audience reload/rejoin, and Low → High → Medium on Mercury and Loom. Mercury surface seams/both poles and bird facing direction were corrected during review. Loom's Low setting uses fewer active vertices, indices, CPU writes, and upload bytes while preserving closed loops and reusing its preallocated resources.

Automated tests cover the expanded schema bounds, fixed S1–S8 shortcuts, full-catalog REW/FF wrapping, every new scene's eight expression knobs, deterministic geometry after different histories, finite geometry at effect/parameter extremes, density, quality budgets, and bank visibility/resource reuse. These are software checks; they do not establish visual quality under every possible live combination.

Local evidence is under ignored `artifacts/scene-expansion/`: `final-01.png` through `final-15.png`, `quality-8-{low,high,medium}.png`, `quality-12-{low,high,medium}.png`, `cleared.png`, `desktop-catalog.png`, and `system-verification.json`. Vite reports a non-fatal bundle-size warning at 969.29 kB minified / 268.38 kB gzip; no additional asset or CDN requests are required.

The [Quest preview guide](hmd-preview.md) documents USB port forwarding, wireless trusted HTTPS/WSS, MR entry, A/B alignment, and scene control from the Mac. The agent has not executed its device commands. The user has since reported successful HMD viewing, while measured stereo composition, passthrough Bloom, physical scale/alignment, two-headset presentation timing, and sustained hardware performance remain pending for the expanded catalog.

## Vercel frontend and Mac HTTPS/WSS preview

The fixed production frontend is [nanokon-sync-mixed-reality.vercel.app](https://nanokon-sync-mixed-reality.vercel.app). Vercel builds the static Vite application with Node 22 in hosted mode. The existing Mac authority remains responsible for time, state, audio features and MIDI; its native ingress stays on `127.0.0.1:8788`. Only the main authority port is forwarded. The [deployment guide](deployment.md) documents startup, endpoint selection and operator/HMD links.

The public ngrok `/health` endpoint and local `/health` returned the same authority epoch with normal TLS verification. A real desktop browser loaded the deployed Vercel page, authenticated the desk, and synchronized Liquid Mercury, Impossible Loom and a DROP into Tidal Silk to a separate deployed audience page through WSS. No browser error-level logs were observed during the successful control flow. These checks use the synthetic feature source; they do not capture music, exercise physical MIDI or measure HMD timing.

The combined runner was then verified using the existing ngrok authentication configuration: public readiness succeeded, only loopback ports 8787/8788 listened, and the ngrok inspection API was disabled. SIGTERM removed readiness and closed both listeners and the owned tunnel; the browser reported Reconnecting. Restarting restored the same ngrok address with a new authority epoch and cleared transport. Runner status and shutdown evidence are under ignored `artifacts/https-preview*.json`; `artifacts/https-preview.log` contains sanitized startup messages.

An exclusive repository lock prevents duplicate invocations from overwriting an active runner's status. Actual second invocations using both the same ports and different ports exited before launching services, preserving the running PID, owner record and ready links. The same protection was verified against a live runner from the earlier version without a lock. Seven focused filesystem tests also cover concurrent stale-owner recovery and ownership-safe release.

The current Wi-Fi resolver could not resolve an allocated Cloudflare Quick Tunnel hostname, so its public readiness check failed. The runner closed its owned resources and ngrok was selected explicitly. No DNS, router, firewall or trust-store settings were changed. No agent-operated HMD test was performed for this deployment.

## Software delivered and remaining acceptance

| Issues | Delivered | Still required |
| --- | --- | --- |
| #2, #5 | Shared schemas/scaffold, authoritative server, clock contract, native bridge, CI and deterministic fixtures | No known remaining software gate from their current acceptance lists |
| #3, #4 | HTTPS/WSS setup, WebGL2-backed MR sessions, transparent TSL Bloom | Trusted venue access on two HMDs; actual both-eye passthrough/Bloom |
| #6, #7, #13, #14 | Capture, DSP, CoreMIDI, custom profiles and show control mapping | Two named playback apps, live music behavior, all physical controls and hot-plug |
| #8, #9 | Offset filtering, event scheduling, buffered features/controls, snapshots and reconnect | Actual multi-HMD presentation skew and venue jitter measurements |
| #10, #11, #16–#20 | Original five presets plus ten experimental additions, deterministic phase/identity, quality tiers and DROP/one-shot/toggle effects | Both-eye visual inspection, peak-load headset performance and real REC execution |
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

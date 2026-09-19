# Hackathon hardware validation: 2026-09-09

## Decision and delivery status

The operator personally confirmed that the system works on both connected headsets and explicitly accepted the current synchronization accuracy for this hackathon. Further clock-precision work is not a hackathon blocker. Optional venue alignment and unperformed production checks are not silently treated as passed.

This work closed issues **#3, #4, #6, #7, #8, #9, #10, #11, #12, #14, #16, #17, #18, #19, #20 and #30**. Issues **#13, #21, #22 and parent #1** remain open for the narrowly identified gaps below.

Changes delivered locally include the read-only audience preview, honest capture-stall detection/retry, preservation of native failure status by the authority, a bounded MR-exit path, and hardware test/evidence tools. The running Mac server and release native host contain the tested local changes. This agent did not commit or push the changes, and did not redeploy the fixed Vercel frontend. GitHub issue updates are not proof that the new source or private artifacts are published.

## Tested environment

| Component | Observed configuration |
| --- | --- |
| Mac | Apple Silicon; macOS 26.6.2, build 25G83; Node 22.17.0 |
| HMD A | Quest 3S; Android 14; OculusBrowser 150.0.0.39.30.1038228660 |
| HMD B | Quest 3S; Android 14; OculusBrowser 149.0.0.24.3.1013217646 |
| Native audio | ScreenCaptureKit; 48 kHz, stereo Float32, two buffers, host-clock timestamps |
| MIDI | Physical nanoKONTROL2, selected with `--midi-source nanoKONTROL2`; no custom profile override |
| Rendering | WebXR immersive AR; WebGL2-backed Three.js node/Bloom path; medium quality for the sustained normal-load run |
| Live transport | Mac authority behind trusted ngrok HTTPS/WSS; Internet access required |

USB was used for ADB/CDP observation. The earlier timing baseline used USB-loopback delivery; the later trusted-WSS tests and long soak used the public tunnel. Do not conflate their timing results or call the tunnel an offline dedicated-LAN deployment.

## Automated software checks

- `npm run check`: 146 TypeScript tests in 15 files, type checking and production build passed.
- `swift test --package-path native`: 19 tests passed, including six capture-watchdog tests.
- `swift build --package-path native -c release`: passed; the resulting host is running.
- `npm run verify:system`: passed with the actual Swift analyzer, explicitly synthetic audio, MIDI replay and two simulated WSS clients. It observed about 30.002 feature Hz and checked certificate trust rejection and restart recovery.
- Preview coverage includes deterministic camera behavior, read-only routing and authorization. Actual desktop/mobile browser checks covered live shots, BURST/DROP response, stale-data fallback and recovery.
- Seven focused XR-exit tests cover the bounded exit helper. Actual human MR lifecycle confirmation is recorded separately below.

Simulation, build success and desktop screenshots are not substituted for physical MIDI or stereo evidence.

## Actual two-headset results

| Check | Result and boundary |
| --- | --- |
| Stereo and passthrough | Operator confirmed both eyes and room passthrough on both headsets. Earlier low/glow-off and high-glow/DROP captures were recorded. |
| MR lifecycle | Operator confirmed real Enter MR, Exit MR, Enter MR on both trusted-HTTPS pages. Synthetic DOM clicks did not establish this result. |
| Initial MR baseline | 600.078 seconds; 597/597 XR samples per headset; median application FPS about 89.987. |
| Initial real audio | afplay, QuickTime Player and Chromium playback exercised system capture. The baseline contained 1,650 non-silent feature frames, not ten uninterrupted minutes of music. |
| Event timing | Earlier USB-loopback run: 31 matched revisions, application-time skew p95 7.051 ms, maximum 7.728 ms. Physical REC/DROP application difference: 1.891125 ms, with both clients in MR and clock-locked. Not photon or GPU timing. |
| Trusted WSS | Both actual browsers were secure contexts and used same-origin WSS, without a certificate bypass. TLS 1.3; current managed certificate expiry 2026-10-25. |
| Actual Wi-Fi recovery | Headset B Wi-Fi was disabled for 15 seconds. A real disconnect, a new snapshot after recovery and common scene/seed/epoch with no expired effects were observed. |
| Tunnel RTT | A median/p95 approximately 69.5/71.2 ms; B approximately 72.4/75.0 ms. These are network RTTs, not rendering latency. |
| Authority restart | Restart during an active DROP created a new epoch. Both existing MR sessions reconnected into revision 0, stopped state and no effects; no previous DROP replay. |
| Basic scene stereo | Ten independently validated screenshots cover all five original scenes on both devices. Actual scene/epoch/revision/seed and XR/quality were checked before and after each capture. All twenty eye views contain artwork over room imagery. |

The stable scene screenshots have fixed viewpoints. NEON DATA CITY towers extend above the frame. SINGULARITY's central core is not distinctly visible in A and only partly visible near B's upper edge. The images do not establish complete composition coverage, central-core stereo quality or physical venue alignment.

## Thirty-minute unattended run

UTC interval: **12:46:55.683 to 13:16:56.411**. Measured loop duration: **1,800.627 seconds**.

The run exercised all 15 scenes, in-place low/medium/high quality changes, 20 automated DROP events and 98 acknowledged commands including setup/restoration. It played the generated stereo 120-BPM fixture through real macOS output in 50 successive afplay runs at volume 0.12. The fixture intentionally includes silence; the final player was terminated normally for cleanup. This was an automated soak, not a new physical-operator rehearsal or a continuous commercial-music test.

| Metric | HMD A | HMD B |
| --- | ---: | ---: |
| Samples | 871 | 871 |
| XR-active samples | 871 | 871 |
| Connected samples | 871 | 871 |
| Clock-unlocked samples | 0 | 0 |
| Fresh instrumented XR callbacks | 161,236 | 161,026 |
| Capture-running samples | 870 | 871 |
| Overall median application FPS | 89.985 | 89.987 |
| Overall p05 application FPS | 89.850 | 89.880 |
| JS heap observed range, decimal MB | 11.83-40.63 | 11.25-33.22 |
| JS heap first / last, decimal MB | 17.78 / 34.93 | 13.46 / 28.47 |

No runtime exception was recorded, and there was no unexpected epoch change. Heap samples show collection and allocation variation; the higher final samples do not establish a leak, nor do these observations prove the absence of one. GPU memory was not measured.

The observer received 53,042 frames at about 29.458 Hz and 46,770,072 frame bytes, approximately 26.0 kB/s for that observer. This is not total network traffic across all clients.

### Quality and occasional stalls

| Tier | A median / p05 FPS | B median / p05 FPS |
| --- | ---: | ---: |
| Low sweep | 89.985 / 89.899 | 89.985 / 89.940 |
| Medium sustained portion | 89.985 / 89.865 | 89.987 / 89.899 |
| High, maximum density/intensity/glow/masterFX | 88.394 / 63.673 | 78.766 / 58.613 |

**Use medium for the hackathon baseline; high/max settings are not certified to meet the target refresh.** The tier samples span different scenes and transition windows, so this is not a controlled per-scene GPU benchmark. Medium data above excludes the initial sweep and immediate return window.

Even in the medium portion, isolated measured JavaScript XR callback durations reached 100.4 ms on A and 171.5 ms on B; maximum callback gaps were about 111.2 and 177.9 ms. Their causes were not isolated. Median FPS must not hide those stalls or be called worst-case frame time. Callback CPU time and application FPS are not compositor/GPU or photon measurements.

### Strict result and known instrumentation defects

The original harness deliberately remains recorded as **`pass: false`, exit code 1**. At 33.9 ms after loop start, A's initial source status still said `stopped` during recovery; subsequent A samples and every B sample said `running`. Every sample after the five-second warm-up had running capture, connected/clock-locked state and active XR. The initial discrepancy is not discarded to manufacture an unconditional pass.

Two test-helper defects were discovered and disclosed. The helper source was not silently rewritten:

- Its audio counters read the wrong envelope path. `report.json` values `nonSilent: 0` and `maxLevel: 0` are invalid measurements, not evidence of silence. Use the independent raw-packet observer described below.
- Initial screenshot filenames use an expected scene index; a scheduled scene transition may not yet have applied. Do not use those filenames as scene identity proof. Use the independent `stable-stereo` captures and their pre/post metadata instead.

The independent actual-path observer recorded `frame.audioFrame.audio` for **1,100.005 seconds**, from 12:55:46.642 to 13:14:06.658 UTC: 32,338 frames, all with capture running and audio source `system`; 25,310 non-silent frames; maximum level 0.352963; about 29.398 Hz; no observer errors. This observer covered only that interval, not the entire thirty minutes.

Future strict acceptance should repair the helper counters, settle/check actual scene state before capture, and explicitly define startup stabilization. Until then, do not use its top-level flag or invalid counters alone as a release decision.

## Native capture recovery and operation

A real unattended failure occurred when the Mac display slept: ScreenCaptureKit returned no eligible displays. The permission preflight succeeded, the lid was open, and the display was reported asleep. The host correctly exposed an error and retried; it did not manufacture zero PCM as healthy capture.

Temporarily waking the display with `caffeinate` allowed the existing host to recover automatically. No host restart, macOS unlock or privacy-permission change was needed. Keep the display/session available during capture. Locking the Mac or changing displays/output devices remains a separate, unqualified scenario.

A display/system idle-sleep assertion is now tied to the running HTTPS runner's process lifetime, rather than a persistent system preference. It ends when that runner exits. See `artifacts/show-awake.json` for the assertion PID and runner PID. This does not unlock macOS or override privacy permissions.

The running host uses:

```sh
./native/.build/release/nanokon-host --capture --midi-source nanoKONTROL2 --monitor
```

Its environment was loaded from the local `.env`, with `SHOW_NATIVE_URL=http://127.0.0.1:8788`. The executable does not load `.env` by itself. Do not expose either token in screenshots, command output or GitHub comments. Refer to `docs/native-host.md` and `docs/deployment.md` for startup configuration.

At test end, automated playback stopped, temporary XR instrumentation was removed, both clients returned to medium quality, and CODE CATHEDRAL was restarted with the original controls. The final runtime observation is saved in the evidence directory. The Mac authority, native host and trusted tunnel remain running for the operator.

The local audience preview is `http://localhost:8787/preview`. Current public URLs and runner health are in `artifacts/https-preview.json`; use that manifest rather than assuming the tunnel address is permanent. The newly implemented preview is served by the current Mac build; it has not been deployed to the fixed Vercel frontend by this work.

## Remaining issue disposition

| Issue | Narrow remaining work |
| --- | --- |
| #13 | Full raw physical MIDI/profile coverage. The operator performed all controls and unplug/replug with PLAY/REC, but retained normalized logs identify only 26 named controls. The software default is channel-1 CC; the physical configuration was not read back. Do not claim all 51 inputs were logged. |
| #21 | Optional venue alignment. Both HMD workflows were exercised, but the earlier A/B point distances differed, about 0.72 m versus 1.57 m. No common independent third-point positional/angular error was measured. |
| #22 | Final acceptance: the manual three-minute rehearsal, full moving-view composition review, peak/GPU/resource profiling, complete controller evidence, additional permission/device/network recovery scenarios, and the documented helper defects. Strict clock precision is no longer a hackathon blocker. |
| #1 | Parent tracking remains open while the explicit remaining gates above are unresolved. Most open work is verification/qualification, not missing core implementation. |

CoreMIDI's configurable profile model was cross-checked against the [official Korg parameter guide](https://cdn.korg.com/us/support/download/files/c8d0cd6808e12d3672845cadcdbbfe9b.pdf), pages 4-8. That reference does not establish the attached device's actual programmed configuration.

## Local evidence index

Artifacts contain private room imagery and device/network information. They were preserved locally, not uploaded to public GitHub issues.

- `artifacts/hardware-2026-09-09-mr/summary.json`: initial ten-minute real MR baseline.
- `artifacts/hardware-2026-09-09-mr/physical-reconnect.json`: actual REC application times in both MR sessions.
- `artifacts/hardware-2026-09-09-mr/physical-midi-coverage.json`: partial logged control coverage.
- `artifacts/hardware-2026-09-09-mr/three-minute-cues.json`: automated cue sequence, not a manual rehearsal.
- `artifacts/native-watchdog-live-analysis.json`: real 45-second capture/watchdog analysis, 1,350 frames, 29.88 Hz and about 0.110 ms analysis work per frame.
- `artifacts/quest-wss-2026-09-09T12-26-33-475Z/report.json`: trusted WSS and actual Wi-Fi recovery.
- `artifacts/quest-wss-2026-09-09T12-26-33-475Z/server-restart.json`: new-epoch recovery without stale DROP replay.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/report.json`: original strict result, including its known limitations.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/samples.jsonl`: timestamped actual HMD state, XR callback, CPU and heap observations.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/analysis.json`: explicit startup/quality interpretation without overwriting the original result.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/system-audio-live-summary.json` and `system-audio-live.jsonl`: independent actual-path audio measurements.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/stable-stereo/2026-09-09T12-53-52.427Z-visual-review.json`: independently validated stereo evidence and viewing limitations.
- `artifacts/hackathon-soak-2026-09-09T12-46-55.683Z/final-runtime.json`: restored ready state after the test.

Re-running `scripts/validate-quest-hackathon.mjs` requires the actual two CDP targets, an authenticated local authority, running real capture, and operator-entered MR sessions. It never handles a permission prompt. Its known counter/capture defects above must be addressed before using it as an unattended strict acceptance gate.

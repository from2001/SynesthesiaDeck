# macOS native host

The Swift host captures system-output PCM locally, analyzes it with Accelerate, and delivers compact audio features plus nanoKONTROL2 control messages to the show server. It never sends PCM, a screen image, or a video stream over the network. System capture uses ScreenCaptureKit; microphone capture is not enabled.

## Requirements and launch

- macOS 13 or newer; Swift 6 toolchain / Command Line Tools (the package uses Swift 5 language mode).
- Screen & System Audio Recording authorization for the launching terminal or packaged host application.
- A running show server with an authenticated loopback native bridge.
- Optional nanoKONTROL2 in CC mode. The operating system's CoreMIDI source must be visible; USB visibility alone is insufficient.

From the repository root:

```sh
cd native
swift build -c release
swift test
export SHOW_NATIVE_URL=http://127.0.0.1:8788
export NATIVE_TOKEN='<same token as the show server>'
.build/release/nanokon-host --capture --monitor
```

The CLI checks `CGPreflightScreenCaptureAccess()` before querying ScreenCaptureKit. It never calls the permission-prompt API. If permission is missing, authorize the launching terminal/host through System Settings > Privacy & Security > Screen & System Audio Recording, quit and reopen that application, and retry. Keep the executable path and signing identity stable: rebuilding or moving an unsigned/ad-hoc executable can change permission attribution. A distributed application needs a stable signed application bundle and its own capture permission; the current deliverable is a local development CLI, not a notarized installer.

Missing credentials fail with an actionable configuration error. `--offline` is the explicit local analysis test mode. All native URLs must be loopback HTTP origins; redirects are refused so the bearer token cannot be redirected to a remote host.

```sh
.build/release/nanokon-host --list-midi
.build/release/nanokon-host --list-displays
.build/release/nanokon-host --synthetic --offline --duration 10 --monitor
.build/release/nanokon-host --capture --duration 30 --display 1 --exclude-bundle com.example.Player
.build/release/nanokon-host --midi-only --midi-source nanoKONTROL2 --monitor
```

`--list-displays` also requires previously granted permission. The display defaults to the first available display. `--exclude-bundle` may be repeated. Current-process audio is excluded. ScreenCaptureKit receives an audio output handler only; unused video configuration is limited to 2 × 2 pixels and 1 Hz. No screen output is retained. Capture interruptions are reported to the dashboard, and the host retries after five seconds. Initial permission/start errors terminate with an explanation so an operator can fix the cause and restart. SIGINT/SIGTERM stop capture, close MIDI, and send stopped status before exit. For a finite verification, use `--duration`.

Capture of protected/DRM content depends on macOS and the playback application. A silent meter alone cannot distinguish silence from a source that blocks capture. Device/display changes can cause interruptions; recovery is implemented but still needs an operator-driven hardware test.

## Audio analysis and clock

The requested input is 48 kHz stereo. The decoder supports interleaved and noninterleaved little-endian float32/float64 and signed int16/int32 PCM, averages channels to mono, and clamps non-finite/out-of-range values before analysis. Its live-tested format is 48 kHz, two noninterleaved float32 buffers. Other supported decoding branches compile but have not been observed from a live capture source in this run. Averaging phase-inverted stereo channels can cancel signal; this is a known limitation of the mono analysis path.

The analyzer uses a 2,048-sample Hann FFT (42.67 ms at 48 kHz), a 1,600-sample hop, and 30 feature frames per second. RMS level and integrated band RMS are mapped from −60 dBFS to 0 dBFS into 0–1, with saturation at each end. The real FFT's scaling and Hann power gain are compensated before normalization.

| Feature | Range |
| --- | --- |
| bass | 20–150 Hz |
| lowMid | 150–500 Hz |
| mid | 500–2,000 Hz |
| high | 2,000–16,000 Hz, limited by Nyquist |
| level | Full-band time-domain RMS |

Attack and release use exponential envelopes with default time constants of 35 ms and 220 ms. `--attack`, `--release`, and `--noise-floor` adjust these settings. Silence decays toward zero. A watchdog supplies local zero samples if capture callbacks stop arriving, and an input time discontinuity or sample-rate change resets the analyzer. Callback retention is bounded to eight PCM blocks of at most 16,384 samples, with overflow dropped instead of blocking capture.

Beat uses positive RMS onset change, a rolling threshold, and a 220 ms refractory interval. Median inter-onset intervals in the 0.25–1.5-second range estimate BPM; at least three agreeing intervals are required. Confidence reflects interval agreement and sample count. The pulse decays over 90 ms; phase wraps in `[0,1)`. Missing onsets lower confidence after two seconds and clear BPM after three seconds. This is a basic music meter, not a guaranteed beat tracker: syncopation, sustained pads, tempo changes, and half/double tempo ambiguity can reduce accuracy. Human DROP commands are independent.

Feature timestamps refer to the analysis window center, not the send time. ScreenCaptureKit presentation timestamps are compared with the host CoreMedia clock and translated into local uptime. A `GET /clock` midpoint sample estimates the local-to-server monotonic offset; it is refreshed every five seconds. Window-center age is approximately 21–55 ms before networking, plus capture delivery latency. The bridge rejects clock samples with a round trip of one second or more and discards queued audio/MIDI when the server's epoch changes.

## Native bridge contract

Requests use `Authorization: Bearer $NATIVE_TOKEN`. The default origin is `http://127.0.0.1:8788`.

```json
{"version":1,"epoch":"server-session-id","serverTime":1234.5}
```

The above is the `GET /clock` response. `POST /ingest` accepts:

```json
{"version":1,"type":"audio","timestamp":1234.5,"audio":{"level":0.6,"bass":0.4,"lowMid":0.2,"mid":0.5,"high":0.1,"beat":0.8,"beatPhase":0.2,"bpm":120,"bpmConfidence":0.9},"source":"system"}
```

```json
{"version":1,"type":"midi","timestamp":1234.5,"status":176,"data1":0,"data2":64}
```

```json
{"version":1,"type":"source","capture":"running","midi":"connected","detail":"ScreenCaptureKit display 1; 48 kHz stereo; system output only"}
```

The bridge has one request in flight, one latest audio frame, one latest source state, and at most 128 MIDI messages. Audio and MIDI older than 250 ms are dropped. Synchronous bounded ingress preserves MIDI order without spawning a Task per message. Connection errors trigger bounded exponential retry and clock reacquisition. Audio is replaced with fresh frames; source state is retried and refreshed every two seconds. Button edges are never retried after an ambiguous POST failure, preventing duplicated DROP operations; a network interruption can therefore lose a button press. The operator can repeat a command after reconnection. The server must apply its own stale-input/held-control recovery.

## nanoKONTROL2 profile

The supplied profile is a documented target configuration for CC mode. Confirm the physical unit's settings in KORG KONTROL Editor; the parameter guide allows customized assignments, so the software profile does not prove the connected hardware has factory/default assignments. [Official Korg parameter guide](https://cdn.korg.com/us/support/download/files/c8d0cd6808e12d3672845cadcdbbfe9b.pdf).

| Controls | Canonical CC numbers | Behavior |
| --- | --- | --- |
| Faders 1–8 | 0–7 | Continuous |
| Knobs 1–8 | 16–23 | Continuous |
| S 1–8 | 32–39 | Momentary |
| M 1–8 | 48–55 | Momentary |
| R 1–8 | 64–71 | Momentary; server owns persistent toggle |
| Rewind / Forward / Stop / Play / Record | 43 / 44 / 42 / 41 / 45 | Momentary |
| Cycle / Previous track / Next track | 46 / 58 / 59 | Momentary |
| Set marker / Previous marker / Next marker | 60 / 61 / 62 | Momentary |

Canonical output uses MIDI channel 1 and 0–127 values. The default profile is in `native/fixtures/nanokontrol2-cc.json`. Each control defines `name`, one-based `channel`, `kind` (`cc` or `note`), `number`, `minimum`, `maximum`, and `behavior` (`continuous`, `momentary`, or `toggle`). Keep canonical names unchanged when customizing hardware numbers. Unrecognized controls are ignored and shown in `--monitor` mode. Custom input ranges are normalized and remapped to canonical channel-1 CC values, so the server can keep its standard profile. Inverted ranges are supported. Note Off and velocity-zero Note On map to release.

For a hardware `toggle` button, each alternating on/off event becomes a canonical press/release pulse. Duplicate values are suppressed. This preserves a physical off press as an action while leaving persistent state ownership with the show server. Set `behavior` to match the hardware setting; declaring a momentary button as toggle would also turn its physical release into a new action.

```sh
.build/release/nanokon-host --write-midi-profile /tmp/my-midi-profile.json
.build/release/nanokon-host --midi-only --midi-profile /tmp/my-midi-profile.json --monitor
.build/release/nanokon-host --midi-replay fixtures/midi-replay.json --duration 3 --monitor
```

CoreMIDI sources are refreshed on setup notifications. Selection defaults to names containing `nanoKONTROL2`; `--midi-source` accepts a case-insensitive name substring or unique source ID. Each connected source has its own running-status parser. Input callbacks bound their retained packet data and skip unrelated messages, SysEx, and realtime bytes. The implementation is an input receiver; it does not configure the device or send LED feedback.

## Verification and remaining physical checks

Run automated verification from `native/`:

```sh
swift test
python3 scripts/verify-bridge.py
swift build -c release
```

Swift tests cover silence, isolated band tones, impulses, attack/release steps, clipping/NaN sanitation, 120 and 90 BPM reacquisition, timestamp cadence/discontinuities, MIDI running status/packet boundaries, malformed messages, profile ranges/channels, toggle off events, clock resets, origin validation, and bounded bridge ingress. The integration script starts its own authenticated loopback mock server and tests the real executable with synthetic audio, an epoch restart, all 14 replay fixture messages, and two temporary HTTP 503 failures. It uses a test-only token and no capture permission.

Observed on September 9, 2026, macOS 26.6.2 (25G83), Apple Silicon, Swift 6.2.3:

- CoreMIDI enumerated `nanoKONTROL2 SLIDER/KNOB`, manufacturer `KORG INC.`, source ID `724678314`, and connected successfully.
- Already-granted capture authorization allowed a finite six-second ScreenCaptureKit run without opening a prompt or changing settings. It received 48 kHz stereo float32 in two buffers, with host-clock presentation timestamps. The input was silence: 180 analyzed frames, approximately 0.150 ms analysis time per frame and 0.43% of elapsed time in analysis (debug build).
- An eight-second synthetic run produced 239 frames, acquired 120 BPM and confidence 1, and averaged approximately 0.188 ms analysis time per frame. Measured wall cadence includes startup/shutdown overhead; window timestamps advance at 33.333 ms.
- The mock bridge integration received 209 audio frames in seven seconds, observed both clock epochs, preserved every replay event, and recovered from two temporary HTTP 503 responses.

Still required before closing the real-device acceptance criteria: named playback from two independent applications; live music meter usefulness and stop/play behavior; all physical faders/knobs/buttons; physical unplug/replug; denied permission and display/device interruption recovery; and a sustained show-length performance run. The connected Quest 3S was not operated because it belongs to another active project. No HMD synchronization or visual behavior is claimed by these native checks.

Implementation references: [Apple ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos), [SCStreamOutput](https://developer.apple.com/documentation/screencapturekit/scstreamoutput).

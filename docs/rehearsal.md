# Operator runbook and rehearsal

## Preparation

1. Install Node dependencies with `npm ci`; run `npm run setup` once. Keep `.env` and TLS private keys out of Git.
2. Configure trusted HTTPS/WSS and the dedicated LAN when physical-device tests are authorized. Ensure client isolation is off. A localhost address only serves this computer.
3. Start the show server, then the native Host Agent using the same native token. Use synthetic mode only for a clearly labeled demonstration.
4. Unlock the desk with the control token. Verify capture mode, MIDI status, feature meters, tempo confidence, and connected-client clock lock.
5. Join audience browsers. If physical alignment is required, record the same floor points A/B on each device and check a third point. Recalibrate after a new reference space/session.
6. Select a scene and press Play. Check the intended quality setting before raising density and glow.

The initial implementation must be rehearsed on actual hardware before live-show acceptance. The connected Quest 3S must not be operated while it is assigned to the user's other project.

## Three-minute manual cue sheet

| Show time | Scene/action | Operator intention |
| --- | --- | --- |
| 00:00 | CODE CATHEDRAL / Play | Quiet code and restrained glow |
| 00:40 | VECTOR FIELD | Introduce flow with the bass |
| 01:20 | NEON DATA CITY | Let columns and grid waves build |
| 02:00 | GLITCH STORM | Increase density, distortion, and one-shots |
| 02:40 | SINGULARITY | Bring the composition inward |
| 02:55 | Transport REC / DROP | Shared contraction, flash, explosion, transition |
| 03:00 | Clear | Finish with a clean passthrough view |

Automatic cue playback is not required; the operator triggers the musical climax. Set the DROP destination on the desk before the final sequence.

## Recovery

- Silent meters: confirm synthetic/system mode, the playback application, capture status and permissions. Capture of silence is a valid stream, not proof of audible playback.
- Missing MIDI: use the native MIDI listing/monitor and verify device selection plus CC profile. Custom toggle/Note mappings are normalized by the Host Agent.
- Stale or reconnecting client: check Wi-Fi and trusted origin. The client requests a fresh snapshot; never manually replay an old DROP to catch it up.
- Capture loss: audio features decay and source health changes. The show clock continues so the operator can choose to Clear.
- Server restart: clients flush old epochs and return to the current cleared state. Reconnect the native bridge and check clock lock before Play.
- Excessive render cost: lower the local quality tier and density/glow; confirm measured device frame times rather than relying on desktop FPS.
- Wrong physical placement: reset alignment and repeat the two floor points after tracking is stable.

## Evidence to record when hardware testing resumes

Device/browser versions, network topology, actual audio source, controller profile, two-eye MR/Bloom observations, event skew, audio-to-visual latency, FPS/frame time at peak density and DROP, calibration error, and a 30-minute soak result. Record each as passed, failed, or not tested.

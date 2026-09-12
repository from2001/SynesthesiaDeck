# Architecture and protocol v1

The Mac is the sole show authority. Swift captures system-output PCM and analyzes it locally. Node publishes numeric features, controls, seeds and scheduled events. Every browser renders its own procedural geometry. No audio, video, or particle positions are transmitted.

## Layout

- `native/`: macOS Swift package, ScreenCaptureKit, Accelerate, CoreMIDI.
- `shared/protocol.ts`: runtime schemas, types, seeded identity and pure event reducer.
- `server/`: HTTP(S), WS(S), state authority and native loopback ingress.
- `web/`: dashboard, synchronized browser client, WebGL2-backed Three.js MR renderer.
- `tests/`: protocol, clock, timeline, server and deterministic visual checks.

## Clock and presentation

All wire timestamps are nonnegative milliseconds in the Node process monotonic clock domain. An epoch UUID changes on a server restart. Browser and Swift clocks estimate the offset using the midpoint of a request/reply sample; lower RTT samples are preferred. Wall-clock time is never used for animation.

Commands become immutable events with an ID, ordered sequence, shared seed, and future `effectiveAt` (initial lead 180 ms). The server and clients use the same reducer. Events execute at the estimated Mac time `effectiveAt`; the client does not delay them again by its audio buffer. Continuous audio is interpolated at estimated server time minus 100 ms. This deliberate audio buffer trades latency for jitter tolerance and is independent of the event clock. Capture timestamps describe the analysis window rather than packet receipt.

Motion phase is anchored in each state by `{phase, at, rate}`. Speed changes advance the old rate exactly to their effective time and establish the new rate. Clients evaluate phase analytically, so render FPS never changes accumulated motion. Future events do not mutate the current snapshot. New clients receive current state, pending events and the latest audio frame. Epoch changes flush all old buffers and pending events. Expired effects are never replayed after joining.

STOP clears visuals and effects; PLAY resumes the paused motion phase. A scene command changes the scene, seed and scene start while preserving the current transport state. Reset clears the show and restores defaults within the current server epoch; monotonic event revisions prevent stale pre-reset state from returning. Restart changes the epoch. Initial transport is stopped.

## Native bridge

The bridge binds to `127.0.0.1:8788`. Both endpoints require `Authorization: Bearer <NATIVE_TOKEN>`. `GET /clock` returns `{version:1, epoch, serverTime}`. `POST /ingest` accepts only the three strict `NativeMessageSchema` variants: audio, MIDI bytes, source status. All producers use bounded queues and timestamp validation; raw PCM is never accepted. The main listener must not expose this bridge remotely.

## Rendering decision

Use the supplied [VoXelo reference](https://github.com/from2001/VoXelo/blob/e4639ad00a10e23737d783403b1b5a5ded974dd6/YPpReXx.html): Three.js 0.183.0 `WebGPURenderer({forceWebGL:true, alpha:true})`, TSL/RenderPipeline Bloom, and luminance-derived MR alpha. The backend is WebGL2. Node materials are used for compatibility with this path. Actual stereo passthrough and Bloom remain separate hardware acceptance gates.

## Validation boundaries

Node tests and browser screenshots do not establish actual XR stereo, a physical MIDI performance, or two-headset synchronization. Required hardware evidence stays open in the GitHub issues until measured. The scene registry now contains 30 stable IDs (0–29), preserving the original five IDs and the ten experimental additions. Physical S1–S8 select the first eight presets; REW/FF browse all 30. The ten experimental presets and the fifteen 2026-09-12 bank presets (Echoes, Lasers, Uncharted) each require their own desktop and HMD acceptance evidence; historical checks of earlier scenes do not validate later additions.

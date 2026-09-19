# Synesthesia Deck

Where sound becomes sight, and the VJ deck becomes an instrument of shared vision.

Nothing crosses the network but the pulse of the music and the motion of a hand on the faders. Every headset paints the same vision, right where it stands. One conducts. Many perform.

Cathedrals of code rise from your floor. Deep-sea blooms unfold above your head. Everyone sees them at the same moment, in the same place, in the same room.

A mixed-reality VJ instrument for a collective hallucination.

## Production URLs

| View | URL |
| --- | --- |
| Controller / VJ desk | [Open controller](https://nanokon-sync-mixed-reality.vercel.app/dashboard) |
| HMD / Quest | [Open HMD view](https://nanokon-sync-mixed-reality.vercel.app/hmd) |
| Audience preview | [Open audience preview](https://nanokon-sync-mixed-reality.vercel.app/preview) |

The production frontend has a default Mac show-server endpoint, so these links do not need a `server` query parameter. `/hmd` is equivalent to `/?view=hmd`. An explicit `server` parameter or a connection remembered within the current browser tab takes priority over the build default.

- Keep the Mac native audio/MIDI host, show server, and HTTPS tunnel running and online. Keep the Mac display/session available for system-audio capture. Vercel hosts the frontend; it does not replace the Mac show authority.
- The controller requires the private `CONTROL_TOKEN`: enter it in **Control token**, then choose **Connect desk**. Do not include this token in shared URLs or repository files.
- On Quest, open the HMD URL over Wi-Fi and choose **Enter MR**. USB is not required for this network connection.
- The audience preview is read-only and uses automatic camera shots; it does not control the show.
- If the Mac's public tunnel address changes, select the new endpoint under **Show connection**, or update `VITE_SHOW_SERVER_URL` in Vercel and redeploy to change the default for new visitors.

See [deployment and connection setup](docs/deployment.md) for startup and recovery details.

A Mac show-control server turns system audio and nanoKONTROL2 input into a shared, deterministic WebXR performance. Each audience browser renders its own geometry. Only numeric features, controls, seeds, and scheduled events cross the network.

## Start a desktop demonstration

Requirements: Node.js 22.12 or newer; macOS and the Swift toolchain for native capture/MIDI.

```sh
npm ci
npm run setup
npm run dev -- --synthetic
```

Open [the VJ desk](http://127.0.0.1:8787). Copy `CONTROL_TOKEN` from the private `.env` file into **Control token**, then **Connect desk** and **Play**. Synthetic audio is explicitly labeled. Open [audience view](http://127.0.0.1:8787/?view=hmd) in another tab to observe the shared show. This local desktop demonstration does not require a headset or native audio permission.

The show starts cleared. **Play** resumes motion, **Clear** removes all visuals/effects, and **Reset** restores defaults. Expand **Scene bank** (collapsed by default) to select one of 15 scenes grouped into Signal, Organic, and Structures, adjust the eight faders and scene knobs, trigger M one-shots or R toggles, and use **DROP** for the contraction/flash/explosion sequence. DROP can stay in the current scene or transition to another. The [scene catalog](docs/scene-catalog.md) covers silk curtains, branching colonies, jellyfish, luminous flowers, flocks, folded mechanisms, moiré lattices, woven knots, swinging prism chimes, and polygonal tunnels alongside the original five signal scenes. Physical S1–S8 select presets 01–08; REW/FF browse all 15.

## Use real system audio and MIDI

Start the server without `--synthetic`. Follow [the native Host Agent guide](docs/native-host.md) for build, existing capture-permission checks, CoreMIDI device selection, and the authenticated loopback bridge. The bridge URL is `http://127.0.0.1:8788`; the native process uses the same `NATIVE_TOKEN` as the server. Do not mistake an enumerated controller or silent capture for a verified live musical performance.

## Connect headsets

For Wi-Fi access, use the [fixed Vercel frontend and Mac HTTPS/WSS setup](docs/deployment.md). The Mac still controls the show; the hosted page provides trusted HTTPS delivery and an explicit show-server selector.

Follow the [Quest preview guide](docs/hmd-preview.md) to browse all 15 scenes in MR. For a first USB preview, ADB reverse maps the headset's `http://localhost:8787/?view=hmd` to the Mac. Wireless headset access requires trusted HTTPS/WSS following [server and TLS setup](docs/server.md). The default server only listens on loopback; a copied loopback URL requires the USB mapping to reach this Mac. **Enter MR** must be initiated in a supported browser, then use the Quest system button long-press to recenter. Two-point floor alignment is temporarily disabled. The Mac's **Preview scene** dropdown and **Previous / Next** buttons switch content while the headset stays in MR.

The renderer follows the supplied VoXelo `forceWebGL` / TSL transparent Bloom path. See [rendering and calibration](docs/rendering.md) for quality controls and limitations.

The user reported successful HMD viewing on 2026-09-09. Measured stereo MR/Bloom, shared physical alignment, sustained performance, and two-HMD synchronization remain separate acceptance checks. **Agent-operated testing of the connected Quest 3S remains deferred until it is explicitly available for this project.** See the [validation record](docs/validation.md) for the distinction between user-reported display confirmation and measured results.

## Validation and delivery

```sh
npm run check
npm run native:build
npm run native:test
npm audit
```

See [architecture and timing](docs/architecture.md), [operator rehearsal](docs/rehearsal.md), and [validation status](docs/validation.md). The [delivery epic](https://github.com/from2001/NanoKonSyncMixedReality/issues/1) retains physical-device acceptance gates until they can be verified.

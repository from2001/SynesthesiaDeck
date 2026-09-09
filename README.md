# NanoKon — MR VJ Instrument

A Mac show-control server turns system audio and nanoKONTROL2 input into a shared, deterministic WebXR performance. Each audience browser renders its own geometry. Only numeric features, controls, seeds, and scheduled events cross the network.

## Start a desktop demonstration

Requirements: Node.js 22.12 or newer; macOS and the Swift toolchain for native capture/MIDI.

```sh
npm ci
npm run setup
npm run dev -- --synthetic
```

Open [the VJ desk](http://127.0.0.1:8787). Copy `CONTROL_TOKEN` from the private `.env` file into **Control token**, then **Connect desk** and **Play**. Synthetic audio is explicitly labeled. Open [audience view](http://127.0.0.1:8787/?view=hmd) in another tab to observe the shared show. This local desktop demonstration does not require a headset or native audio permission.

The show starts cleared. **Play** resumes motion, **Clear** removes all visuals/effects, and **Reset** restores defaults. Select one of 15 scenes grouped into Signal, Organic, and Structures, adjust the eight faders and scene knobs, trigger M one-shots or R toggles, and use **DROP** for the contraction/flash/explosion sequence. DROP can stay in the current scene or transition to another. The [scene catalog](docs/scene-catalog.md) covers silk curtains, branching colonies, jellyfish, liquid surfaces, flocks, folded mechanisms, moiré lattices, woven knots, floating ruins, and polygonal tunnels alongside the original five signal scenes. Physical S1–S8 select presets 01–08; REW/FF browse all 15.

## Use real system audio and MIDI

Start the server without `--synthetic`. Follow [the native Host Agent guide](docs/native-host.md) for build, existing capture-permission checks, CoreMIDI device selection, and the authenticated loopback bridge. The bridge URL is `http://127.0.0.1:8788`; the native process uses the same `NATIVE_TOKEN` as the server. Do not mistake an enumerated controller or silent capture for a verified live musical performance.

## Connect headsets later

Follow the [Quest preview guide](docs/hmd-preview.md) to browse all 15 scenes in MR. For a first USB preview, ADB reverse maps the headset's `http://localhost:8787/?view=hmd` to the Mac. Wireless headset access requires trusted HTTPS/WSS following [server and TLS setup](docs/server.md). The default server only listens on loopback; a copied loopback URL requires the USB mapping to reach this Mac. **Enter MR** must be initiated in a supported browser, then follow the floor A/B alignment prompts. The Mac's **Preview scene** dropdown and **Previous / Next** buttons switch content while the headset stays in MR.

The renderer follows the supplied VoXelo `forceWebGL` / TSL transparent Bloom path. See [rendering and calibration](docs/rendering.md) for quality controls and limitations.

**Hardware testing is currently deferred at the user's request. Do not use the connected Quest 3S; it is assigned to another project.** Desktop results do not prove stereo MR/Bloom, shared physical alignment, or two-HMD synchronization. The ten added presets have separate hardware acceptance requirements; the earlier five-scene validation remains historical evidence for those original scenes only.

## Validation and delivery

```sh
npm run check
npm run native:build
npm run native:test
npm audit
```

See [architecture and timing](docs/architecture.md), [operator rehearsal](docs/rehearsal.md), and [validation status](docs/validation.md). The [delivery epic](https://github.com/from2001/NanoKonSyncMixedReality/issues/1) retains physical-device acceptance gates until they can be verified.

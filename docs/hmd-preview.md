# Preview all 15 scenes on a Quest

The Mac remains the show controller. The headset opens the audience page, enters MR, and follows scene changes from the Mac. No APK installation is required. This guide is prepared for a headset that is available for this project; the connected Quest 3S assigned to another project has not been operated or tested.

## Fixed HTTPS URL over Wi-Fi

Use the [Vercel frontend and Mac tunnel guide](deployment.md) for the configured wireless preview. Keep its Mac runner active, open [the fixed audience page](https://nanokon-sync-mixed-reality.vercel.app/?view=hmd) in Quest Browser, and use [the fixed desk](https://nanokon-sync-mixed-reality.vercel.app) on the Mac. Authenticate only the desk and press **Play**. On the headset, choose **Low**, enter MR, and follow the A/B alignment steps below. This route needs Internet access but no headset USB connection.

If the Mac runner reports a changed public endpoint, use its freshly printed audience link or update **Show connection → Mac show URL**. A deployed page remains available when the Mac is offline, but live show synchronization requires the authority and tunnel to be running.

## First preview over USB

Meta documents ADB reverse port forwarding for loading a local development server in Quest Browser. Forwarding the headset's `localhost` to the Mac allows a potentially trustworthy loopback origin without setting up a LAN certificate. This is different from opening an ordinary HTTP LAN address.

1. Keep the NanoKon server running on the Mac at port 8787. If it is not running, open a terminal in this repository and run:

   ```sh
   npm run build
   npm run start -- --synthetic
   ```

   Synthetic mode animates the scenes with generated feature values. It does not play music. Do not start a second server on an occupied port.

2. When the intended Quest is free for this project, connect it by USB. Developer mode and USB debugging must be available, and any USB debugging request must be accepted inside that headset. List devices and use the intended serial explicitly:

   ```sh
   adb devices -l
   adb -s QUEST_SERIAL reverse --list
   adb -s QUEST_SERIAL reverse --no-rebind tcp:8787 tcp:8787
   ```

   Replace `QUEST_SERIAL` with the chosen device serial. `--no-rebind` preserves an existing mapping. If it reports an existing binding, inspect the list: reuse it only when it already maps `tcp:8787` to this Mac's `tcp:8787`. If another project owns that device port, choose an unused headset port, for example `tcp:8799`, while keeping the Mac destination `tcp:8787`, and use port 8799 in the headset URL. Do not reset ADB or remove another project's mappings.

3. Manually open **`http://localhost:8787/?view=hmd`** in Quest Browser. Keep the USB cable connected. The port forward carries both the page and its `/ws` show connection; port 8788 and native credentials are not needed on the headset.

4. On the Mac, open **`http://127.0.0.1:8787/`**. If the desk is unauthenticated, enter `CONTROL_TOKEN` from the private `.env` file, then click **Connect desk** and **Play**. The headset needs no control token.

5. On the headset page, start with **Quality → Low**, then click **Enter MR** and accept the browser's immersive-session permission. This requires a Quest Browser version that supports `immersive-ar` and `local-floor`; the page reports unsupported sessions instead of silently substituting another mode.

6. Follow the in-headset alignment prompts. Point a controller ray at floor origin **A** and press the trigger, then select forward point **B** at least 30 cm away. For two headsets, mark the same physical A and B and repeat on each device. **Align room** repeats the process; **Reset alignment** clears it.

7. Leave the headset in MR and use the Mac's **Preview scene** dropdown or **Previous / Next** buttons to browse all 15 scenes. Presets 06–15 are the ten additions. The larger scene cards and the MIDI controller also select scenes: S1–S8 select 01–08, while REW/FF wrap through all 15. **Clear** hides the content; **Play** resumes it. **DROP** can transition to the selected destination.

When finished, exit MR in the headset. If this session created the reverse mapping, remove only that mapping, using the actual headset port selected above:

```sh
adb -s QUEST_SERIAL reverse --remove tcp:8787
```

## Local HTTPS alternative

Use a trusted HTTPS/WSS endpoint following [server and TLS setup](server.md#secure-venue-delivery). Open that endpoint with `?view=hmd` on each headset. A remote `http://MAC_LAN_IP:8787` page is not sufficient for WebXR, and the default server only binds to Mac loopback. The desktop audience link is a headset-ready link only when its origin is actually reachable and trusted from that headset, or when the USB mapping above is active.

## What to check

- Inspect every scene in both eyes: transparent empty space, Bloom halos, visible surfaces, depth, and comfortable scale. Mercury's reflections are procedural lighting, not a reflection of the physical room.
- Move and turn while trying Low first. Raise quality only after checking sustained frame timing on the actual headset. Desktop FPS and geometry budgets are not headset performance measurements.
- Exercise scene changes, eight scene knobs, Density/Glow, DROP, Clear/Play, and reconnection. Check that the Mac's scene and seed match the audience.
- For two devices, verify the same A/B alignment and a third physical point, then measure presentation skew and network stability. A matching scene name alone does not prove synchronized display timing.

If the page does not load, check the selected serial, USB authorization, exact reverse mapping, running Mac server, and port. If the page loads but remains disconnected, inspect its connection status and server log. If it connects but stays empty, click Play on the authenticated Mac desk. If Enter MR is unavailable, check the browser support message and use the exact loopback or trusted HTTPS URL; do not treat a certificate-warning bypass as a working secure setup.

## Sources and verification boundary

- [Meta: Browser remote debugging](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/) describes ADB reverse and loading `localhost` in Quest Browser.
- [MDN: Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) describes potentially trustworthy loopback origins and secure remote delivery.

The commands and UI steps were checked against the local implementation and ADB help. No device mapping, headset browser launch, immersive session, or physical validation was executed while preparing this guide. Record actual device/browser versions and results in the [validation record](validation.md) when hardware becomes available.

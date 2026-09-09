# Vercel frontend with a Mac show authority

The fixed frontend is [nanokon-sync-mixed-reality.vercel.app](https://nanokon-sync-mixed-reality.vercel.app). Vercel serves the dashboard, audience page, and rendering assets over trusted HTTPS. The Mac continues to own the shared clock, scenes, audio analysis, MIDI mapping, and event scheduling. Every headset renders locally.

```text
Mac system audio / nanoKONTROL2
              |
       Swift host agent
              | authenticated loopback :8788
       Node show authority :8787
              |
       ngrok HTTPS/WSS tunnel
              |
       Vercel page in each HMD / operator browser
```

Only numeric show state and audio features cross the tunnel. The native bridge remains on Mac loopback and is never forwarded. Display assets come from Vercel; live data travels directly between the browser and the tunnel, without a Vercel Function in the data path.

## Run a wireless preview

Use Node 22.12 or newer within major version 22. On this Mac, ngrok 3.39.8 is already installed at `/opt/homebrew/bin/ngrok` and authenticated through its existing private configuration. The runner uses that configuration unchanged, disables request inspection, and forwards only the main authority port. On another Mac, install and authenticate ngrok following its official setup guide before running this command.

1. Keep the existing private `CONTROL_TOKEN` and `NATIVE_TOKEN` in `.env`. Stop the existing NanoKon server if it owns ports 8787/8788. The runner will refuse occupied ports and will not terminate another process.
2. Build and start the combined authority/tunnel process:

   ```sh
   npm run build
   npm run preview:https -- --provider ngrok --frontend-origin https://nanokon-sync-mixed-reality.vercel.app --synthetic
   ```

   Alternatively set `FRONTEND_ORIGIN` to that exact origin and `TUNNEL_PROVIDER=ngrok` in the private `.env`, then omit those two flags. Synthetic mode generates features without playing music or capturing audio. For real audio/MIDI, omit `--synthetic`, leave `SHOW_SYNTHETIC=0`, and run the [native host agent](native-host.md) against the usual loopback bridge.

3. Wait for the runner's public HTTPS health verification. It prints a **Fixed frontend desk** link and an **Audience / HMD** link, with the selected show address included. These links contain no control token. Current nonsecret links and status are also saved in `artifacts/https-preview.json`.
4. Open the printed desk link on the Mac. Enter the private `CONTROL_TOKEN`, connect the desk, and click **Play**. Open the printed audience link in Quest Browser over Wi-Fi, choose **Low**, then **Enter MR** and follow floor A/B alignment.
5. Use **Preview scene**, **Previous / Next**, knobs, and DROP from the Mac. The HMD stays in MR and follows the show.

The production build defaults to the current nonsecret show endpoint, `https://hastier-berry-unarrogantly.ngrok-free.dev`, using `VITE_SHOW_SERVER_URL`. This lets a fresh browser open the fixed root URL or `/?view=hmd` directly. If the runner reports a different endpoint, open **Show connection**, paste that HTTPS address into **Mac show URL**, and click **Connect show**. **Copy audience link** then includes that endpoint automatically. Explicit URL selection and a remembered selection take priority over the build default. Update the Vercel production variable and rebuild when changing the default for new visitors.

The page stores tokens per normalized show endpoint in tab-scoped session storage. Switching to another server does not transfer the old server's credential. Query-selected servers cannot inherit the original unscoped desktop token. HTTPS pages reject insecure WS endpoints, including loopback.

## Availability and latency

The Vercel frontend URL is stable. Backend address reuse and availability depend on the existing ngrok account; always check the address printed by the runner after restarting. Keep the Mac awake, the runner active, and the Internet connection available. Closing the runner disconnects live synchronization even while Vercel continues serving the page.

This setup is a preview environment using the existing ngrok account; assess its service limits and the venue network before a public performance. The runner does not install a login service, change DNS/firewall/router settings, configure a custom domain, or create a paid subscription. An independently managed tunnel can use the server's existing `PUBLIC_ORIGIN`, `TRUSTED_PROXY=1`, and exact `ALLOWED_ORIGINS` configuration; see [server delivery](server.md#secure-venue-delivery).

Cloudflare Quick Tunnels are also supported with `--provider cloudflare` and an installed `cloudflared` executable. Their temporary address changes on every restart. During this setup, the current Wi-Fi resolver could not resolve the allocated `trycloudflare.com` hostname, so public readiness correctly failed and ngrok was selected. No resolver or certificate checks were bypassed. See [runner details](https-preview-runner.md) for provider configuration and diagnostics.

The tunnel route uses the Internet even when the Mac and HMD share Wi-Fi, so measure latency/jitter before using it for a live musical performance. For a venue that must run without Internet, use local HTTPS with a trusted certificate and local DNS/IP routing instead.

The current audience endpoint is read-only but accessible to anyone with the link. Dashboard commands still require `CONTROL_TOKEN`. For a private event, add audience access control at the delivery layer before distributing the link. Do not put native or control credentials in Vercel build variables, URLs, or repository files.

## Deploy and rollback

`vercel.json` builds only the Vite frontend in hosted mode and publishes `dist/`. `/hmd` and `/dashboard` load the same application with the intended view. `.vercelignore` excludes local credentials, certificates, artifacts, native code and server tooling from manual deployment uploads. Git never contains the private `.env`.

The Vercel project is `nanokon-sync-mixed-reality` in `from2001s-projects`. The Node major is pinned to 22. Use Vercel's Git integration for production builds from `main` and preview builds from branches. The Mac's running process must be restarted separately when server/protocol changes are merged; a frontend deployment does not update the authority process.

Only the fixed production frontend origin is trusted by the default runner. To test live synchronization from a Vercel preview deployment, explicitly add that exact preview origin to `ALLOWED_ORIGINS` before starting the Mac runner. Do not use a wildcard for all Vercel projects. Preview builds have no default server environment variable and require an explicit endpoint selection.

The CLI version used for this setup is pinned below; the previously installed CLI 41 could not use the current deployment endpoint.

```sh
npx --yes vercel@59.13.1 deploy --scope from2001s-projects
npx --yes vercel@59.13.1 deploy --prod --scope from2001s-projects
```

Review the preview deployment before promoting or deploying production. Roll back the production alias to a known compatible deployment using Vercel's deployment controls. For a protocol change, coordinate compatible frontend and Mac releases; the browser reports incompatible snapshots instead of treating them as a successful connection.

## Why not place the authority directly in a Vercel Function?

Vercel added WebSocket support in beta in 2026. Connections still end at a Function's duration limit, and new/reconnected clients are not guaranteed to reach the same instance. Our authority owns an in-memory monotonic clock, event queue and shared state for all HMDs. Keeping that authority on the Mac avoids introducing distributed state coordination solely to obtain HTTPS. This decision can be revisited for a separately designed persistent cloud relay.

## References

- [MDN WebXR startup requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown)
- [MDN secure contexts and loopback exceptions](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
- [Vercel WebSockets: duration and state requirements](https://vercel.com/docs/functions/websockets)
- [ngrok WebSocket support](https://ngrok.com/docs/using-ngrok-with/websockets)
- [ngrok setup](https://ngrok.com/docs/getting-started/)
- [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare WebSocket support](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)

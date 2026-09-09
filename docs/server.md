# Show server and operator networking

The server owns all show state. It publishes 30 state/audio frames per second and announces discrete commands 180 ms before execution. The native bridge sends numeric features and MIDI bytes; it never uploads PCM or rendered geometry. The initial show transport is stopped.

## Local startup

Use Node 22.12 or newer. Run `npm ci`, copy `.env.example` to `.env`, and set independent random `CONTROL_TOKEN` and `NATIVE_TOKEN` values of 24–256 characters. Generate each with `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"`. Never paste either credential into source files, logs, issue comments, or screenshots.

`npm run dev` loads `.env` and serves the Vite UI plus `/ws` at `http://127.0.0.1:8787`. Native ingest always binds to `127.0.0.1`, on port 8788 by default. `npm run dev -- --synthetic` or `SHOW_SYNTHETIC=1` enables a labeled 120 BPM synthetic source. Synthetic mode does not start the show automatically. Use PLAY from the authenticated dashboard.

For production, run `npm run build` and `npm start`. Production serves only `dist/`, including `/`, `/hmd`, and `/dashboard`; it cannot expose `.env`, native files, or repository source. Vite middleware is development-only; its HMR socket is disabled so `/ws` remains the sole application upgrade endpoint. Reload the page after development edits.

`GET /health` reports epoch, monotonic time, connected clients, native source health, and the chosen transport. The same-origin WebSocket path is exactly `/ws`; query-string credentials and other paths are rejected. Dashboard credentials belong in the `hello` message. HMD clients never receive the credential and cannot issue commands. Origin and Host headers are checked against explicit configuration and local loopback origins; arbitrary Host values are not trusted to create an allowlist.

## Secure venue delivery

Choose one delivery path and test it before the venue session:

1. **Trusted DNS certificate.** Use a DNS name with a certificate trusted by the actual headset browser. Route it to this Mac on the venue network. Set `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://your-hostname:8787`, `TLS_CERT`, and `TLS_KEY`. The certificate must contain the accessed hostname or IP in its SAN. The server refuses a missing key/certificate pair and never falls back to HTTP for a LAN bind.
2. **Development CA.** With mkcert already installed and its CA deliberately trusted on the Mac, run `sh scripts/tls-create.sh your-mac.local 192.168.1.10`. It writes private files under ignored `.certs/` without overwriting existing certificates. Set the TLS variables above. Each actual device/browser must independently trust the issuing CA. Trust installation support and exact steps depend on the headset/browser release; a Mac-trusted CA does not establish headset trust. If the browser cannot trust the CA, use the trusted DNS certificate or proxy path. Never distribute the CA private key.
3. **Explicit HTTPS reverse proxy.** Terminate trusted HTTPS/WSS at a proxy/tunnel, preserve the configured public `Host`, and forward `/ws` upgrades and the page to this Mac. Keep `HOST=127.0.0.1` when the proxy runs locally. Set `PUBLIC_ORIGIN=https://your-public-hostname` and `TRUSTED_PROXY=1`. A separate trusted proxy may require a LAN upstream; firewall that upstream to the proxy only. The server does not infer proxy trust from `X-Forwarded-*` headers. Do not proxy port 8788. An external tunnel may expose the read-only HMD view publicly; use proxy access controls when the performance is private.

Use `ALLOWED_ORIGINS` only for additional explicitly trusted page origins, as a comma-separated list. Avoid wildcard origins. Use the public HTTPS origin in both HMDs and the dashboard; the browser selects `wss:` from that page origin. Do not mix an HTTPS page with remote `ws:`.

For a local network, discover the Mac's current Wi-Fi IP in System Settings → Wi-Fi → Details → TCP/IP and hostname in General → Sharing. Use a stable DHCP reservation or DNS entry. Use a dedicated 5/6 GHz access point with the Mac wired to it when practical. Disable guest/client isolation for this show network; allow inbound TCP 8787 (or the chosen HTTPS/proxy port) only where necessary in the Mac/network firewall. The native bridge needs no inbound firewall rule. Test the page and `/health` from another desktop on the same network before connecting any show headset.

If a connection fails, check the public hostname, certificate SAN and chain, exact port, public Host forwarding, Origin allowlist, firewall, and AP client isolation. A token error is distinct from TLS or network failure. The dashboard should indicate connection, clock-lock and source state independently.

### Renewal and reconnect runbook

Record the certificate expiry date and renew before it expires. Stage a newly issued matching certificate/key, preserve the old pair privately for rollback, update `.env` paths if needed, and restart the server. Restart changes the epoch and returns to stopped transport; reconnect clients discard old timeline data and receive a current snapshot. Verify `/health`, trusted page loading, clock re-lock, current scene/seed, and an authenticated harmless scene command before starting the show. For a Wi-Fi change, update DNS/IP SAN and `PUBLIC_ORIGIN` as needed; confirm reachability and repeat the same checks. A certificate-warning bypass is not acceptance evidence.

No real headset or attached Quest was operated for the automated implementation checks. Record device/browser versions, network topology, trust method, `isSecureContext`, immersive-AR support, WSS connection, and synchronized playback in the hardware acceptance record when devices are explicitly available for this project.

## Native bridge

Both endpoints require `Authorization: Bearer <NATIVE_TOKEN>`:

- `GET http://127.0.0.1:8788/clock` → `{version:1, epoch, serverTime}`.
- `POST http://127.0.0.1:8788/ingest` with JSON matching `NativeMessageSchema`.

Audio/MIDI timestamps must be within 10 seconds behind to 2 seconds ahead of current server time. Resynchronize after restart or a clock-window rejection. Audio timestamps describe capture analysis time. Older/out-of-order audio frames are ignored. No native routes are available on the main listener. The native bearer token cannot authenticate a dashboard.

Ingress bodies and WS messages are limited to 8192 bytes. Native ingest has a token bucket of 600 messages/second with a 1200-message burst. Each WS peer has 120 messages/second with a 120-message burst, 5 seconds to send `hello`, protocol heartbeat every 15 seconds, and a 256 KiB outgoing-buffer cap; a blocked peer is disconnected instead of delaying healthy clients. At most 32 peers are accepted by default (hard maximum 128). Pending events are bounded at 512 with command admission stopping at 500 to retain transition headroom. The request-ID acknowledgment cache retains up to 4096 entries for five minutes, including across reconnects. Reusing a retained ID with a different command is an error. Clients should create new UUID request IDs and stop replaying unacknowledged commands after that retention window.

After 250 ms without new features, audio decays exponentially; after 1.5 seconds it becomes silence and capture health becomes an error. After six seconds without native traffic, MIDI status becomes disconnected. Synthetic mode remains explicitly synthetic. Silent/stopped input is not a source of fake beats.

## Event and DROP behavior

Current state does not change when a future command is accepted. A new connection receives state, pending events, latest audio, and source status in one synchronous snapshot. Snapshots replace the client's pending queue, including after cancellation. Effects still in progress are reconstructed from their original times; expired effects are removed before snapshots/frames.

DROP requires running or scheduled-to-run transport, lasts 600–6000 ms, and has a 600 ms retrigger cooldown. The shared reducer keeps at most 16 in-progress one-shot/DROP effects. A new DROP may overlap old effects; the latest DROP that specifies a target scene replaces an earlier unfinished final transition. A DROP without a target does not change an existing final target. M buttons create independent 850 ms bursts. Automatic beats never create operator DROP events.

A target-scene transition is retained privately until it is 180 ms away. Only then is its immutable event ID/revision allocated and broadcast. This keeps revision order consistent with execution even if controls arrive during a long DROP. STOP (`clear`) or reset removes pending DROP/burst events and final transitions, broadcasts a replacement snapshot, and clears active effects when the STOP/reset event takes effect. Reset keeps the server epoch while advancing revision; restart creates a new epoch. Manual scene commands cancel an older DROP destination, preserve transport, and clear scene effects/parameters through the shared reducer. If a delayed announcement would precede an already published event, its effective time shifts to that event's time and sequence order breaks the tie; already published events are never renumbered. Ingress bodies use completion time for scheduling, so a slow older request cannot insert an event before a newer request.

## nanoKONTROL2 mapping

The native bridge emits canonical channel 1 CC messages after its optional hardware profile normalization. Leave `MIDI_PROFILE` unset for that path. For a raw canonical source, `server/midi-profile.example.json` documents the equivalent server profile; custom server profiles can remap channel, CC/note button numbers, tolerance and debounce. Do not remap the same source twice.

| Physical control | Canonical CC | Action |
| --- | --- | --- |
| Faders 1–8 | 0–7 | intensity, density, speed, scale, distortion, glow, glitch, masterFX |
| Knobs 1–8 | 16–23 | Current scene's parameter slots 1–8; scene UI supplies labels |
| S1–S5 | 32–36 | CODE CATHEDRAL, VECTOR FIELD, NEON DATA CITY, GLITCH STORM, SINGULARITY |
| S6–S8 | 37–39 | Reserved; no action |
| M1–M8 | 48–55 | One-shot Orbit, Pulse, Twist, Mirror, Scatter, Strobe, Prism, Freeze slots |
| R1–R8 | 64–71 | Persistent toggle for the same effect slots |
| REW / FF | 43 / 44 | Previous / next of five scenes, wrapping from the projected pending scene |
| STOP / PLAY | 42 / 41 | Visual clear and pause / start or resume |
| Transport REC | 45 | Scheduled DROP, default 1800 ms / strength 0.7 |

Buttons trigger only on the rising edge (positive CC or note-on velocity), and releases never retrigger. Repeated presses inside 35 ms are suppressed. Native profiles for hardware toggle-mode buttons emit one canonical press/release pulse for each physical press. R toggles use projected authoritative state, so rapid separate presses and dashboard changes agree. There is no outbound MIDI feedback, preventing echo loops.

Faders and knobs use soft takeover: after a dashboard/default change, physical input must come within 2/127 of the new value or cross it before it controls the show. Until pickup, physical movement does not overwrite the dashboard. Subsequent movements stay latched until another source changes that parameter. Scene changes reset knob pickup; global fader pickup persists. MIDI disconnect resets pickup/press tracking. Test actual device direction, channel and button mode in the local native monitor before performance.

## Automated checks

`npm test -- tests/server-authority.test.ts tests/server-integration.test.ts` tests scheduling boundaries, revision order across DROP transitions, cancellation, source decay, input mapping/pickup, real HTTP native ingest/clock, two real WebSocket consumers, reconnect/dedup, authorization, origin/Host checks, malformed/oversized input, cadence, heartbeat removal, and a deterministically simulated congested write buffer. These checks do not establish actual stereo MR, physical MIDI feel, network Wi-Fi jitter, certificate trust on a headset, or two-HMD execution skew.

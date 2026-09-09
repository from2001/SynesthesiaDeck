# Fixed frontend with a Mac show authority

The preview runner connects a fixed HTTPS frontend on Vercel or an explicitly trusted custom domain to the production show authority on the Mac. The Mac remains responsible for system-audio features, MIDI input, authoritative state and timing. Either `cloudflared` or `ngrok` forwards only the main HTTP/WebSocket port through HTTPS. Native ingest remains authenticated on its separate loopback port.

## Start the preview

Requirements:

- Node 22.12 or newer within major version 22 and the repository's installed npm dependencies.
- Existing private `.env` credentials from `npm run setup`: separate `CONTROL_TOKEN` and `NATIVE_TOKEN`, each 24–256 characters.
- A built frontend in `dist/`, created with `npm run build`.
- An installed, trusted tunnel executable: `cloudflared` for the default provider, or `ngrok` with an existing authenticated configuration for `--provider ngrok`. Both are discovered through `PATH`, the standard Homebrew locations, or an explicit executable setting.
- The exact trusted frontend origin, such as the project's fixed Vercel production origin.

From the repository root:

```sh
npm run build
FRONTEND_ORIGIN=https://your-project.vercel.app npm run preview:https
```

The equivalent command without the package shortcut is:

```sh
npx tsx scripts/start-https-preview.ts --frontend-origin https://your-project.vercel.app
```

For a clearly labeled synthetic music demo:

```sh
FRONTEND_ORIGIN=https://your-project.vercel.app npm run preview:https -- --synthetic
```

To use the existing ngrok account instead of a Cloudflare Quick Tunnel:

```sh
FRONTEND_ORIGIN=https://your-project.vercel.app npm run preview:https -- --provider ngrok --synthetic
```

Omit `--synthetic` for live music. `TUNNEL_PROVIDER=ngrok` selects the same provider; the command-line flag takes precedence. This is an explicit alternative when, for example, the current network cannot resolve `*.trycloudflare.com`. The runner does not change system DNS or silently switch providers. `npm run preview:https -- --help` prints the options without loading private configuration or starting services.

Transport starts stopped. Open the printed desk URL, authenticate with the existing control credential through the normal UI, and press PLAY. The runner does not start native capture or operate MIDI hardware. For live music, run the existing native host separately using the same private native credential and printed loopback bridge address; see [the native host guide](native-host.md).

The Mac must remain awake and online. Opening the browser frontend does not require a USB cable. A physical MIDI controller still needs its usual connection when you choose to use it.

## Configuration

The runner loads the repository's private `.env` through Node's environment loader. Existing exported variables take precedence, and `--frontend-origin` takes precedence over `FRONTEND_ORIGIN`. It never modifies `.env` or prints its credential values.

| Setting | Behavior |
| --- | --- |
| `FRONTEND_ORIGIN` | Required exact HTTPS origin. Vercel and custom domains are supported; paths, query strings, credentials and wildcards are rejected. |
| `PORT` | Main loopback HTTP/WebSocket listener; default `8787`. |
| `NATIVE_PORT` | Separate authenticated native loopback listener; default `8788`. It must differ from `PORT`. |
| `CLOUDFLARED_BIN` | Optional executable path or name. Set an absolute trusted path to select a particular installation/version. |
| `TUNNEL_PROVIDER` | `cloudflare` by default, or `ngrok`. `--provider` overrides it. |
| `NGROK_BIN` | Optional trusted ngrok executable path or name; ignored for Cloudflare. |
| `NGROK_CONFIG` | Optional path to one existing authenticated ngrok configuration. Defaults to `~/Library/Application Support/ngrok/ngrok.yml` on this Mac runner. Commas in paths are rejected because ngrok treats them as configuration-list separators. |
| `ALLOWED_ORIGINS` | Optional comma-separated exact HTTP(S) origins. The trusted frontend origin is always included. |
| `SHOW_SYNTHETIC` | `1` enables the labeled synthetic source; `--synthetic` also enables it. |
| `MIDI_PROFILE` | Optional existing server MIDI profile, validated with the server's shared schema. |
| `CONTROL_TOKEN`, `NATIVE_TOKEN` | Existing private credentials, supplied only to the in-process authority. |

The runner fixes the authority host to `127.0.0.1`. Its effective `PUBLIC_ORIGIN` is the newly generated tunnel origin, `TRUSTED_PROXY` is enabled, production serving is enabled, and Vite middleware is disabled. Existing `HOST`, `PUBLIC_ORIGIN`, `TRUSTED_PROXY`, `TLS_CERT` and `TLS_KEY` values do not alter this runner's loopback HTTP transport. HTTPS terminates at the tunnel, while the Mac-side hop remains loopback-only.

Only one preview runner may own a repository, including invocations with different ports or providers. Before loading configuration or writing any status, the runner acquires `artifacts/https-preview.lock` with a complete PID and unique owner record. Another live or uncertain owner causes immediate refusal without changing `https-preview.json`. A live ready/starting status from an older runner without a lock is also preserved. Use a separate repository checkout if you intentionally need an independent preview and status file.

Both ports are checked before launching the tunnel. If either is occupied by another application, the runner refuses to continue; it does not terminate the owning process. Stop that application yourself, or select unused ports, for example:

```sh
PORT=8877 NATIVE_PORT=8878 FRONTEND_ORIGIN=https://your-project.vercel.app npm run preview:https
```

Remember to use the chosen native port when starting the separate native host.

For ngrok, authentication stays in its existing configuration file. The runner reads only the top-level format version and creates a separate, temporary version-matched overlay for format 2 or 3. It does not upgrade, copy or rewrite the private file. The child receives both paths in merge order, with local web/API inspection disabled (`web_addr: false`), the local inspection database disabled (`inspect_db_size: -1`), and HTTP introspection disabled (`--inspect=false`). Console UI, update checks and remote management are disabled for this owned process. Only the explicit loopback target is started; named endpoints in the existing configuration are not launched. [ngrok configuration merging](https://ngrok.com/docs/gateway/agent/config), [ngrok version 3 agent settings](https://ngrok.com/docs/gateway/agent/config/v3).

## URLs and readiness

The startup sequence is:

1. Acquire exclusive ownership of this repository, then validate configuration, private credential presence, built `dist/index.html`, executable location and both loopback ports.
2. Create an independent temporary empty cloudflared configuration, or an ngrok overlay referencing the existing private configuration. User configuration files are preserved.
3. Launch one owned tunnel child targeting only `http://127.0.0.1:PORT`. Parse the generated Cloudflare origin or ngrok's JSON `started tunnel` announcement for that exact upstream; require an exact HTTPS origin.
4. Start the existing production authority with the generated public origin and trusted frontend allowlist.
5. Verify that local and public `/health` responses contain the same authority epoch before declaring readiness.

As soon as the provider allocates an origin, the console and the starting-status message show it explicitly as unverified. Public health retries report sanitized DNS, TLS, timeout or HTTP-status diagnostics when the failure category changes. A timeout includes the final diagnostic. After health verification, the console prints the local desk URL, the fixed frontend desk URL with a `server` query parameter, and an audience URL with both `view=hmd` and `server`. No URL includes a credential. The query parameter selects the current Mac authority; the frontend itself keeps its fixed address.

The same nonsecret URLs are written atomically to the ignored file `artifacts/https-preview.json`. It includes a status, provider, timestamp and runner PID. A healthy local authority refreshes the timestamp every five seconds. Normal shutdown and known failures replace the ready record with `stopped` or `failed` and remove its URL fields. After a forced process kill or power loss, an old timestamp can remain; check that the runner is still alive before treating the saved URLs as current.

Cloudflare assigns a new Quick Tunnel URL on every start. Use the newly printed frontend/audience links after restarting; old links still point at the retired authority. Quick Tunnels are intended for testing and development, with no availability guarantee. For a permanent authority address, use a configured named tunnel in a separate deployment workflow. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

With ngrok, address assignment and reuse depend on the existing account. Always use the URL verified by the current runner. This command does not reserve a domain, change a plan, or modify account configuration. [ngrok HTTP agent command](https://ngrok.com/docs/gateway/agent/cli#ngrok-http).

## Shutdown and failure handling

Ctrl+C or SIGTERM closes only this runner's authority and tunnel child, removes its own temporary configuration, writes its final status, and releases its repository lock. The child receives SIGTERM first; if it does not exit within four seconds, the runner sends SIGKILL to that owned child only. Existing unrelated servers, tunnel processes and hardware are not touched. Lock release checks the unique owner record and never deletes a replacement owner's lock.

A lock whose recorded PID is confirmed absent can be reclaimed automatically on restart. A short exclusive `artifacts/https-preview.lock.recovery` directory serializes stale-lock recovery so competing invocations cannot remove a newly acquired lock. PID checks are read-only and do not terminate processes. If the recorded PID is still present, inaccessible, or reused by another process, the runner conservatively refuses to claim ownership.

If a crash interrupts recovery itself, its `.recovery` directory is deliberately retained and prevents further stale-lock reclamation. Likewise, malformed or unverifiable lock records are not automatically deleted. Verify that no preview runner for this repository remains before manually removing that repository's stale `artifacts/https-preview.lock.recovery` directory and, when necessary, `artifacts/https-preview.lock` file. Do not remove them while a runner is active. Restart normally afterward; the existing status is preserved until ownership succeeds.

An unexpected provider exit, failed authority startup, public readiness timeout, or failed local heartbeat also closes the owned resources and withdraws readiness. Either provider has 60 seconds to announce an origin and another 60 seconds for public health verification. The runner does not silently switch an HTTPS failure to another transport or restart into an unreported new URL.

Normal programmatic stop returns `0`. Unexpected successful tunnel termination returns `1`; an explicit nonzero child exit is preserved. SIGINT returns `130`, and SIGTERM returns `143` after cleanup. Startup diagnostics are bounded, credential-free messages. Cloudflared logs produce fixed diagnostic categories for edge connection, QUIC failure, origin connection failure, DNS, TLS and timeout. Ngrok JSON logs produce fixed session/endpoint progress, warning/error categories, and validated `ERR_NGROK_` numeric codes. Each category is printed once. Raw fields are not persisted or echoed; unrelated provider tokens and show credentials are excluded from the child environment. The runner disables cloudflared automatic updates and uses an explicit temporary configuration. [Cloudflare run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/).

## Verification

```sh
npx vitest run tests/https-preview-runner.test.ts
npm run typecheck
```

The tests use mocked services, pure functions and disposable temporary directories for filesystem locking. They cover duplicate invocations preserving ready status, separate-port refusal, concurrent stale-lock recovery, ownership-safe release, legacy runner protection, exact-origin trust boundaries, provider selection and overrides, port validation and collision refusal, main-port-only arguments for both providers, ngrok inspection overlays, secret exclusion, split log parsing and upstream validation, readiness ordering, cleanup after startup/health/tunnel failures, preserved exit codes, cancellation during authority startup, heartbeat failure, and stale-ready withdrawal. These tests do not launch an authority, tunnel, browser, native capture, or hardware session. Actual public HTTPS/WebSocket access must be verified separately after an authorized runner launch.

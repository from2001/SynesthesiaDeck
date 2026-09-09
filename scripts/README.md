# Verification scripts

`npx tsx scripts/verify-system.ts` exercises the actual Swift executable against the real Node authority and two simulated browser consumers over certificate-validated WSS. Build the native debug executable with `npm run native:build` first. The script needs macOS and OpenSSL; use `NATIVE_EXECUTABLE=/absolute/path/nanokon-host` to select another already-built executable. Set `VERIFY_OUTPUT=artifacts/system-verification.json` to save its machine-readable result.

The script generates an eight-second synthetic PCM fixture in Swift, validates the real FFT/beat feature JSON, capture timestamps and 30 Hz delivery, then replays 25 MIDI messages through Swift normalization and the authenticated native bridge. It compares both clients' scheduled scenes/effects, verifies pickup, held-button suppression, STOP/DROP behavior, and checks stopped state after a new server epoch. A temporary CA validates the HTTPS/WSS chain and hostname within the script, while an untrusted chain must fail. Listeners use ephemeral loopback ports and test-only credentials. Temporary keys/files and subprocesses are cleaned up.

No ScreenCaptureKit capture, global CA installation, real headset, or physical MIDI connection is used. The native source selector deliberately matches no physical device. This check does not establish browser WebXR support, actual passthrough/stereo Bloom, physical controller behavior, venue Wi-Fi quality, or two-headset presentation skew.

`sh scripts/tls-create.sh <Mac LAN DNS name> [<Mac LAN IP> ...]` creates a separate operator development certificate using an already-installed mkcert. See `docs/server.md` for the explicit trust and venue-network procedure. The system verification above does not run that script or alter its certificates.

# Audience preview

Open `/preview` or `/?view=preview` on the Mac show server. The desk header also
links to **Audience preview**. On the hosted site, append
`?server=https://YOUR_SHOW_HOST` or use the collapsed **Show connection** form.
Select **Fullscreen** once if required by the browser. Playback and camera
direction then need no manual input.

The preview connects as an unauthenticated `hmd` named `Preview xxxx`. It never
loads a control token, sends a command, enters XR, or changes the HMD camera.
The existing server enforces the role's read-only access. Only clock pings and
standard client telemetry are sent. The shared scene catalog, ShowConnection
sampling, ShowRenderer geometry, and Bloom pipeline remain the source of visuals.

## Camera direction

All presets target the installation's shared local origin at approximately eye
height. Positions are in the renderer's existing meter-scale coordinates.

| Shot | Position | Target | FOV | Transition |
| --- | --- | --- | --- | --- |
| Wide | 13, 9, 16 | 0, 2.4, 0 | 56 | 1800 ms |
| Mid | 8, 4.6, 9 | 0, 2.2, 0 | 48 | 1600 ms |
| Close | 4.5, 3.2, 5.5 | 0, 2.1, 0 | 42 | 900 ms |
| Long | -16, 6.5, 21 | 0, 2.4, 0 | 36 | 2000 ms |

Each scene starts wide. Sixteen-second sections rotate through all four shots;
the scene number and shared seed determine the order. Camera dolly motion and
quintic interpolation use absolute shared time, without accumulated frame deltas.
This applies to every entry in the scene catalog, including experimental scenes.

An active DROP selects close; BURST selects mid. The cue's effective timestamp
anchors the transition. A cut holds for at least four seconds, returns to the
current section over 1600 ms, then leaves a four-second cooldown before accepting
another event. Simultaneous cues use timestamp/ID order. Expired cues are never
replayed, and CLEAR or a new scene/epoch clears camera cue history. Event holds
survive normal effect expiry to avoid a sudden camera snap.

A late viewer reconstructs the current section and any still-active event from
the snapshot. A completed event's camera hold is local history and is not added
to the wire protocol; a viewer joining after that effect expired uses the shared
section instead. Initial connection, scene changes, and recovery blend over
1800 ms. Displays converge on the same section pose after that settling period.

The UI shows scene name, synopsis, live/paused state, scene elapsed time, and
camera-section progress. The protocol has no track-title or track-duration
metadata, so section progress is not presented as music progress.

## Loss behavior and verification

No snapshot, an unlocked clock, a disconnected socket, or 2000 ms without a new
authoritative show frame selects static wide. Clock pongs and locally applied
future cues cannot refresh frame age. Safety transitions use local monotonic
time so they finish even when the shared sample clock freezes. A fresh frame and
clock lock restore automatic direction. Rendering failures remain visible.

Run `npx vitest run tests/preview.test.ts` and `npm run typecheck` for the focused
checks. The route test uses a temporary production directory and ephemeral ports.

Browser verification can inspect the read-only `window.__nanokon` snapshot:

- `mode === 'preview'`, `role === 'hmd'`, `name` begins with `Preview`.
- `renderReady`, `renderingError`, `stats.fps`, `state.scene`, and `clockLocked`.
- `preview.shot`, `reason`, `cutId`, `section`, `sectionProgress`.
- `preview.health`, `frameAgeMs`, `position`, `target`, and `fov`.

Open the preview alongside the authenticated desk, select any catalog scene,
and trigger DROP after Play. Observe `reason === 'drop'` and the close shot, then
the timed return. Trigger rapid BURSTs to exercise cooldown. Block the preview's
WebSocket in browser network tools or temporarily stop the test server: the
health must leave `live`, the shot becomes wide, and its position settles to
`[13, 9, 16]` after 1800 ms. Restore the connection to test recovery. Verify that
the page exposes no transport, scene, effect, login, alignment, or MR controls.
Check `/preview` and `/?view=preview` on desktop, a narrow viewport, and a large
external monitor. Full visual/browser verification is separate from unit tests.

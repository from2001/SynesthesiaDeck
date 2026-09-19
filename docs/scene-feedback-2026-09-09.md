# Headset scene feedback — 2026-09-09

## Requested changes

The user reported that Liquid Mercury was invisible on the headset, Abyssal Bloom's tendrils looked like thin lines, and Abyssal Bloom and Ember Migration were one meter too high. The user also requested a replacement for Gravity Palimpsest. The Mercury rendering failure was reported by the user; its device-specific cause has not been isolated.

| Display / protocol ID | Updated scene | Change |
| --- | --- | --- |
| 08 / 7 | ABYSSAL BLOOM | Move the whole jellyfish group down 1 m; replace line tendrils with tapered hexagonal mesh tubes. |
| 09 / 8 | LUMEN GARDEN | Replace Liquid Mercury with layered, cupped petals; tilt the flowers toward eye-height viewers. |
| 10 / 9 | EMBER MIGRATION | Move birds and their entire trails down 1 m. |
| 14 / 13 | RESONANT CHIMES | Replace Gravity Palimpsest with rows of swinging, faceted prism chimes and traveling color waves. |

Scene IDs, scene order, shared clock, server protocol, and MIDI shortcuts remain compatible. The replacement scenes retain eight functional expression knobs, density, quality tiers, audio response, and shared effects. Their colored basic node materials need no lights, environment texture, or reflective shader. Organic groups now also hide completely at zero intensity.

The height correction is a translation of the show content after its scale, so the correction remains exactly -1 meter at every Scale setting and during DROP contraction. Switching to any other scene restores the content translation to zero. Floor alignment and the headset camera are unaffected. Existing Float height and Flight height controls still adjust their scenes normally.

## Verification

- `npm run check`: TypeScript, 147 tests, and the Vite build passed. The existing non-fatal bundle-size warning remains.
- Regression tests check the new garden's unlit surfaces, tendril cross-section seams and taper, quality resource reuse, determinism, knob responses, and active geometry budgets. The medium organic budget is checked at maximum density and maximum tendril count.
- A separate local browser exercised the actual ShowRenderer on the WebGL2 backend. Forty-three checks covered all 15 scenes on Low, target scenes through High/Low/Medium/High at full density, exact height offsets at Scale 0/0.5/1, and Clear/Play. Four additional checks verified that the height offsets remain correct while DROP contracts content to 22% scale. No page exceptions or error-level console messages were observed.
- Eye-height screenshots and desktop transparent MR-shader composition over a checkerboard were inspected. Lumen Garden, Resonant Chimes, and the thick jellyfish tendrils remained visible with silent audio and Glow = 0.
- The pre-change hosted bundle was rebuilt separately and matched the currently deployed bundle byte for byte (SHA-256 `d5708382fe371d6ca26a5bbb1e0ce1cefc5382fa6fb178effc5735a60e215e3a`). The release preserves that existing frontend behavior, including the audience preview and MR exit work already present in the working tree.

Evidence is saved locally under ignored `artifacts/scene-feedback-2026-09-09/`, including screenshots, `browser-checks.json`, the original deployed bundle, and staged deployment metadata. The temporary review harness is excluded from the release.

## Headset acceptance

The revised scenes have not yet been retested in an actual immersive headset session. Desktop shader composition does not establish stereo, physical comfort, passthrough visibility in the room, or headset performance. Reload both the operator page and headset page after deployment, then re-enter MR and inspect scenes 08, 09, 10, and 14, starting on Low. Confirm the downward placement, tendril thickness, and replacement appearance in both eyes.

## Release

Published to [the fixed frontend](https://nanokon-sync-mixed-reality.vercel.app) as deployment `dpl_5t5UqBzVttEnXZNt2b6vTcCtS3Cw` (READY). The public JavaScript bundle matched the verified staged bundle byte for byte; `/`, `/hmd`, `/dashboard`, and `/preview` returned successfully. This was a frontend-only release; the existing Mac authority and native capture processes were not restarted.

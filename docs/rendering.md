# Procedural rendering and alignment

`web/visuals/renderer.ts` exports `ShowRenderer`. It owns one animation loop and one Three.js scene. The client supplies authoritative state, interpolated audio features and estimated server time. Assign `sampleProvider` so synchronization is sampled on every renderer frame, including XR frames when the browser suspends ordinary `window.requestAnimationFrame` callbacks. `update()` remains available for a simple embedding. Old anchors extrapolate for at most 150 ms.

## Render path

The renderer follows the supplied [VoXelo reference](https://github.com/from2001/VoXelo/blob/e4639ad00a10e23737d783403b1b5a5ded974dd6/YPpReXx.html):

- Pinned Three.js 0.183.0, `WebGPURenderer({ forceWebGL: true, alpha: true })`, followed by `await renderer.init()`.
- WebGL2 backend, node materials, `renderer.setAnimationLoop()`, `RenderPipeline`, TSL scene pass and `bloom()`.
- Desktop uses an opaque dark background and OrbitControls. MR uses an `immersive-ar` session with required `local-floor`, no background or fog, and a transparent clear color.
- MR output color is scene RGB plus Bloom RGB. Output alpha is `smoothstep(0.08, 0.85, luminance(color)) * 0.72`, matching the reference. This keeps the Bloom halo while leaving empty pixels transparent.
- Immersive support and secure context are checked before entry. An opaque immersive-AR blend mode is rejected. Session errors, context loss and renderer errors are surfaced through `onStatus`.

All fonts are system monospace and the code atlas is generated locally. No external textures, fonts, model downloads, audio streams, or CDN imports are required.

## Presets

| Preset | Geometry | Audio response |
| --- | --- | --- |
| CODE CATHEDRAL | Instanced atlas glyphs in six descending code walls, with luminous vault rings | Bass expands the vault, mid modulates rain, beat enlarges glyphs, high increases shimmer and glitch |
| VECTOR FIELD | Instanced particle sprites following an analytic curling helix field | Bass modulates flow phase and particle size, mid bends the field, high fragments particle sizes |
| NEON DATA CITY | Instanced wireframe towers, street grid and expanding rings | Bass raises towers, beat drives street ripples and window brightness |
| GLITCH STORM | Spinning tetrahedron shards, code fragments and particles | High drives seeded tearing, bass and mid deform the storm |
| SINGULARITY | Infalling spiral particles, code fragments, tilted accretion rings and a central polyhedron | Bass enlarges the core and particles; the scheduled DROP contracts, flashes and releases a seeded spherical burst |
| TIDAL SILK | Broad folded ribbon surfaces forming a tidal curtain | Audio modulates ribbon folding and shimmer |
| MYCELIUM CHOIR | Branching stems, layered canopies, and drifting spores | Audio modulates growth-like sway and colony brightness |
| ABYSSAL BLOOM | Pulsing bell surfaces and curling tendrils | Audio changes bell pulse and tendril motion |
| LIQUID MERCURY | A reflective-looking lobed fluid surface | Audio drives ripples and surface deformation |
| EMBER MIGRATION | Winged silhouettes and stretched trails | Audio modulates wingbeats, bank, and flock character |
| ORIGAMI ENGINE | Tessellated folded facets and articulated creases | Audio changes fold angle and crease contrast |
| MOIRE OBSERVATORY | Layered line lattices with interference patterns | Audio modulates lattice angle and interference drift |
| IMPOSSIBLE LOOM | Interlaced thick threads forming sculptural knots | Audio modulates braid twist and weave tension |
| GRAVITY PALIMPSEST | Layers of eroded floating blocks and arches | Audio modulates levitation and erosion character |
| PRISMATIC PORTAL | Nested polygonal apertures extending into a tunnel | Audio changes tunnel twist and spectral separation |
| WAVEFORM ATLAS | Additive oscilloscope traces on a curved wall | Each trace scales with one band (level, bass, low mid, mid, high); beat drives a traveling spike |
| SYNAPSE RELAY | Instanced icosahedron nodes, additive links, packet sprites | Bass swells nodes, mid brightens links, beat brightens packets and arrival glow |
| KELP FOREST | Spine lines, blade quads, bubble sprites | Bass widens the current sway; mid and high brighten spines and blades |
| AURORA CURTAIN | Additive folded surfaces with vertical ray lines | High shimmer sharpens the ray pattern |
| PENDULUM HALL | Instanced bobs, string/rail lines, afterimage sprites | Beat brightens and slightly enlarges bobs; bass nudges swing amplitude |
| LASER HARP | Additive core lines, instanced haze cylinders, pluck spots | Each string follows one band; beat plucks seeded strings, cutting the beam |
| SPECTRUM FAN | Core lines, haze cylinders, additive fan sheets, floor spots | Level, mid and high brighten beams; beat tilts fans and lights floor spots |
| PHOTON TUNNEL | Additive ring polylines, cone core lines and haze | Bass breathes ring radius; beat brightens the traveling ring arcs |
| GALVO LISSAJOUS | Fading trace polyline, projector cone, screen frame | Mid widens the figure, bass lifts it, beat brightens the scan head |
| NOVA STARBURST | Core lines, haze cylinders, emitter and floor-spot sprites | Level brightens spokes; beat flashes seeded spokes and floor spots |
| DOMINO CASCADE | Instanced shaded boxes on a spiral floor path | Beat brightens standing dominoes; topple glow follows the wave front |
| GLOWSTICK CROWD | Additive stick-figure lines with instanced heads | Beat adds bounce and brightens glowsticks; level brightens bodies |
| LANTERN ASCENT | Instanced gradient-shaded lanterns with flame sprites | Bass adds flame flicker |
| AUTOMATON WALL | Instanced cell quads with per-instance color | Beat brightens the newest generation; high adds glitch displacement |
| HANABI SKY | Spark sprites with trail lines, rising streaks, flash sprites | Beat brightens sparks; bass enlarges them |

The catalog preserves IDs 0–4 for the original scenes, appends ten scenes as IDs 5–14, and appends the 2026-09-12 banks as IDs 15–29: Echoes (`web/visuals/echo-presets.ts`), Lasers (`web/visuals/laser-presets.ts`) and Uncharted (`web/visuals/uncharted-presets.ts`), each with a pure sampling module and shared helpers in `bank-math.ts` and `dynamic-geometry.ts`. Signal, Organic, Structures, Echoes, Lasers, and Uncharted are dashboard navigation groups, not controller banks. The physical S buttons remain fixed to the first eight presets; REW/FF wrap the complete 30-scene catalog. [Scene catalog and all knob labels](scene-catalog.md) describe each preset.

Each scene exposes eight knob labels from `PRESET_PARAMETERS` in `web/visuals/parameters.ts`. The corresponding values control dimensions, primitive size, topology, palette and motion character. The shared faders control intensity, density, motion speed, global scale, distortion, Bloom gain, glitch probability and master effect strength.

The eight effect slots are Orbit, Pulse, Twist, Mirror, Scatter, Strobe, Prism and Freeze. Toggles sustain the named effect; one-shots use the scheduled event envelope. Strobe uses a four-Hz brightness gate. Persistent Freeze pauses the authoritative motion phase; one-shot Freeze uses the event's `frozenPhase`. Live audio and scheduled DROP timing continue while motion is frozen.

Geometry identity comes from the shared integer hash. Positions are evaluated from absolute `motionAt()` phase; no animation uses `Math.random()` or integrates local frame deltas. Audio flow modulation is bounded, preventing large phase jumps after long runs. DROP contraction, flash and expansion are evaluated from event `effectiveAt` and `duration`; expired effects contribute nothing. Burst geometry uses the selected DROP event seed. Scene transition scheduling remains the show authority's responsibility.

## Quality budgets

| Quality | Maximum particle sprites | Maximum mesh instances | Desktop pixel-ratio cap | XR foveation |
| --- | ---: | ---: | ---: | ---: |
| Low | 4,000 | 320 | 1.0 | 1.0 |
| Medium | 12,000 | 720 | 1.4 | 0.7 |
| High | 32,000 | 1,500 | 1.8 | 0.4 |

Density selects a prefix of stable particle identities. Other scene primitives have smaller scene-specific caps. City tower placement uses a deterministic permutation so low-density cities cover the complete footprint. Shader instancing keeps draw calls bounded, while analytic positions are evaluated on the CPU and uploaded through dynamic attributes. These are workload limits, not headset performance guarantees. Start hardware acceptance on Low and measure before selecting a higher tier.

## Shared two-point calibration

Every preset uses meters and a floor-relative Y origin. A separate show-root transform applies alignment without changing procedural coordinates, controllers, camera or timing.

1. Choose two physical floor markers visible to all participants. A is the show origin; the direction from A to B is the installation's forward direction (local negative Z).
2. On entering MR, calibration starts automatically. Point a controller ray down at marker A and press its trigger. A green ring confirms the first point.
3. Point at marker B and press the trigger. The points must be 0.3–20 meters apart. A gold ring marks B. A small in-world instruction panel indicates the current step.
4. Squeeze either controller's grip to restart calibration. The webpage also exposes calibration and reset actions; desktop calibration uses two floor clicks for inspection.

Controller target rays intersect the floor. Upward, nearly parallel and remote rays are rejected. Marker heights are projected onto `y = 0`; yaw and horizontal translation are derived from A and B. No scale is inferred from marker separation. All headsets must select the same ordered physical markers. This is manual alignment, not a shared spatial anchor service; floor estimates and manual selection error still matter.

Calibration is cleared on session entry, session exit and reference-space reset. Recalibration starts automatically after a reference-space reset. The last transform is never silently reused across unrelated headset sessions. The default uncalibrated MR show origin is three meters in front of the local-floor origin.

## Verification

`tests/visuals.test.ts` exercises deterministic particle identity, frame-history independence, extreme controls, long-running audio modulation, paused phase, per-scene registries, DROP timing and expiry, one-shot Freeze anchors, floor-ray intersection, calibration validation and coordinate transformation. `tests/echo-presets.test.ts`, `tests/laser-presets.test.ts` and `tests/uncharted-presets.test.ts` cover every knob of the fifteen 2026-09-12 presets, history- and quality-independent geometry, finite output under every effect at both parameter extremes, Medium draw-call and vertex budgets, bank visibility, and scene-specific invariants (closed rings and figures, pendulum realignment, floor-rooted kelp, beam floor hits, domino fronts, dancer posture, lantern fades, automaton rule application and ballistic sparks).

Historical desktop browser checks for the initial implementation compiled and rendered the original five actual TSL scenes without browser errors. The transparent Bloom output was composited over a checkerboard to confirm empty pixels reveal the background. Two desktop floor clicks produced a calibrated state and reset cleared it. These checks do not verify XR stereo, passthrough brightness, controller poses, headset frame rate or real-room alignment. No connected Quest device was used; hardware testing remains deferred at the user's request.

The ten additional scenes require new coverage for each preset, extreme parameter values, quality changes, DROP/STOP, scene switching, transparency, and sustained frame times. Original five-scene browser results do not establish those new results. The fifteen 2026-09-12 presets were rendered from the production bundle in a headless software-rendered Chromium without console errors; that confirms the render path compiles and draws, not headset frame timing or passthrough composition. New real-HMD tests remain deferred: stereo passthrough/Bloom, floor scale, calibration, and two-headset timing have not been established for these additions.

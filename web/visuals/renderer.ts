import * as THREE from 'three/webgpu';
import { attribute, float, instancedBufferAttribute, luminance, pass, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initialState, SILENCE, type AudioFeatures, type ShowState } from '../../shared/protocol';
import { floorIntersection, particleIdentity, sampleParticle, solveCalibration, visualFrame,
  type Calibration, type ParticleIdentity, type Point3, type VisualFrame, type VisualSample } from './math';
import { QUALITY_BUDGETS, visibleCount, type Quality } from './parameters';

const MAX_PARTICLES = QUALITY_BUDGETS.high.particles;
const MAX_INSTANCES = QUALITY_BUDGETS.high.instances;
const BACKGROUND = new THREE.Color('#03070d');
const GLYPHS = '01{}[]<>=+-*/:;()#%$&_|. ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno';
const WHITE = new THREE.Color('#dfffff');

/** The same RenderPipeline is used for desktop and immersive AR, including Bloom. */
export class ShowRenderer {
  onStatus?: (message: string) => void;
  sampleProvider?: () => { state: ShowState; audio: AudioFeatures; now: number } | null;
  private renderer!: THREE.WebGPURenderer;
  private pipeline!: THREE.RenderPipeline;
  private scenePass!: ReturnType<typeof pass>;
  private bloomPass!: ReturnType<typeof bloom>;
  private opaqueOutput!: ReturnType<typeof vec4>;
  private transparentOutput!: ReturnType<typeof vec4>;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, 1, .05, 100);
  private orbit!: OrbitControls;
  private root = new THREE.Group();
  private content = new THREE.Group();
  private resizeObserver!: ResizeObserver;
  private quality: Quality = 'medium';
  private initialized = false;
  private disposed = false;
  private availableMR = false;
  private statusMessage = 'Initializing renderer…';
  private latestState = initialState('preview');
  private latestAudio: AudioFeatures = { ...SILENCE };
  private latestServerTime = 0;
  private receivedAt = 0;
  private fpsValue = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private currentSeed = -1;
  private currentScene = -1;
  private currentHue = -1;
  private identities: ParticleIdentity[] = [];
  private positions = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private colors = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private sizes = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1).setUsage(THREE.DynamicDrawUsage);
  private particleBrightness = uniform(1);
  private particleSize = uniform(1);
  private particles!: THREE.Sprite;
  private particleMaterial!: THREE.PointsNodeMaterial;
  private glyphAtlas!: THREE.CanvasTexture;
  private glyphs!: THREE.InstancedMesh;
  private glyphMaterial!: THREE.MeshBasicNodeMaterial;
  private glyphBrightness = uniform(1);
  private glyphOpacity = uniform(1);
  private towers!: THREE.InstancedMesh;
  private towerMaterial!: THREE.MeshBasicNodeMaterial;
  private shards!: THREE.InstancedMesh;
  private shardMaterial!: THREE.MeshBasicNodeMaterial;
  private grid!: THREE.LineSegments;
  private gridMaterial!: THREE.LineBasicNodeMaterial;
  private rings: THREE.Mesh[] = [];
  private ringMaterial!: THREE.MeshBasicNodeMaterial;
  private core!: THREE.Mesh;
  private coreMaterial!: THREE.MeshBasicNodeMaterial;
  private flash!: THREE.Mesh;
  private flashMaterial!: THREE.MeshBasicNodeMaterial;
  private burstPositions = new THREE.InstancedBufferAttribute(new Float32Array(1500 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private burst!: THREE.Sprite;
  private burstMaterial!: THREE.PointsNodeMaterial;
  private burstBrightness = uniform(0);
  private currentBurstSeed = -1;
  private burstIdentities: ParticleIdentity[] = [];
  private calibration: Calibration | null = null;
  private calibrationStep: 'idle' | 'origin' | 'forward' = 'idle';
  private calibrationA: Point3 | null = null;
  private calibrationMarkers = new THREE.Group();
  private cursor!: THREE.Mesh;
  private originMarker!: THREE.Mesh;
  private forwardMarker!: THREE.Mesh;
  private calibrationLabel!: THREE.Sprite;
  private calibrationLabelTexture!: THREE.CanvasTexture;
  private currentReferenceSpace: XRReferenceSpace | null = null;
  private session: XRSession | null = null;
  private xrStarting = false;
  private controllers: THREE.Group[] = [];
  private desktopPointer = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private sample: VisualSample = { x: 0, y: 0, z: 0, size: 0, angle: 0, hue: 0 };
  private controllerOrigin = new THREE.Vector3();
  private controllerDirection = new THREE.Vector3();
  private controllerRotation = new THREE.Quaternion();

  constructor(private container: HTMLElement) {}

  get stats() { return { fps: this.fpsValue, xr: this.renderer?.xr.isPresenting ?? false,
    calibrated: this.calibration !== null, quality: this.quality }; }
  get support() { return { mr: this.availableMR, secure: window.isSecureContext }; }
  get status() { return this.statusMessage; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error('This renderer has been disposed.');
    this.renderer = new THREE.WebGPURenderer({ forceWebGL: true, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(BACKGROUND, 1);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFoveation(QUALITY_BUDGETS[this.quality].foveation);
    await this.renderer.init();
    if (this.disposed) { this.renderer.dispose(); return; }
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    this.renderer.domElement.setAttribute('aria-label', 'Procedural show preview. Drag to orbit; scroll to zoom.');
    this.container.appendChild(this.renderer.domElement);
    this.scene.background = BACKGROUND;
    this.camera.position.set(8.5, 6.1, 10.5);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 2.1, 0);
    this.orbit.minDistance = 2;
    this.orbit.maxDistance = 32;
    this.orbit.maxPolarAngle = Math.PI * .49;
    this.orbit.enableDamping = true;
    this.orbit.update();
    this.scene.add(this.root);
    this.root.add(this.content);
    this.createGeometry();
    this.createCalibration();
    this.createPipeline();
    this.renderer.xr.addEventListener('sessionstart', this.handleSessionStart);
    this.renderer.xr.addEventListener('sessionend', this.handleSessionEnd);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('pointerdown', this.handleDesktopCalibration);
    this.renderer.domElement.addEventListener('pointermove', this.handleDesktopPointer);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.container);
    this.initialized = true;
    this.resize();
    this.renderer.setAnimationLoop(this.animate);
    if (!window.isSecureContext) this.report('Desktop preview ready. MR requires a trusted HTTPS connection.');
    else if (!navigator.xr) this.report('Desktop preview ready. This browser does not expose WebXR.');
    else {
      try {
        this.availableMR = await navigator.xr.isSessionSupported('immersive-ar');
        this.report(this.availableMR ? 'MR is supported. Enter MR when the headset is available.' : 'Desktop preview ready. Immersive AR is unavailable in this browser.');
      } catch (error) { this.report(`Could not check MR support: ${messageOf(error)}`); }
    }
  }

  update(state: ShowState, audio: AudioFeatures, serverTime: number): void {
    this.latestState = state;
    this.latestAudio = audio;
    this.latestServerTime = serverTime;
    this.receivedAt = performance.now();
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    if (!this.initialized) return;
    this.renderer.xr.setFoveation(QUALITY_BUDGETS[quality].foveation);
    this.resize();
  }

  async enterMR(): Promise<void> {
    if (!this.initialized) throw new Error('The renderer is not ready.');
    if (this.session || this.xrStarting) return;
    if (!window.isSecureContext) throw new Error('MR requires trusted HTTPS.');
    if (!navigator.xr || !this.availableMR) throw new Error('Immersive AR is unavailable in this browser.');
    this.xrStarting = true;
    let requested: XRSession | null = null;
    try {
      // local-floor is required because calibration and every preset use meter-scale floor coordinates.
      requested = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor', 'hand-tracking'] });
      if (requested.environmentBlendMode === 'opaque') {
        await requested.end();
        throw new Error('The session has no passthrough blend mode. MR was not started.');
      }
      this.session = requested;
      await this.renderer.xr.setSession(requested);
    } catch (error) {
      if (requested && this.session === requested) { await requested.end().catch(() => undefined); this.session = null; }
      this.report(`MR could not start: ${messageOf(error)}`);
      throw error;
    } finally { this.xrStarting = false; }
  }

  async exitMR(): Promise<void> { if (this.session) await this.session.end(); }

  beginCalibration(): void {
    if (!this.initialized) return;
    this.calibrationStep = 'origin'; this.calibrationA = null;
    this.calibrationMarkers.visible = true;
    this.originMarker.visible = false; this.forwardMarker.visible = false;
    this.setCalibrationLabel('A · SHARED FLOOR ORIGIN', 'Point down and press the trigger');
    this.orbit.enabled = false;
    this.report(this.session ? 'Point a controller ray at floor marker A and press the trigger. Use the same A and B on every headset.' : 'Calibration preview: click the floor for origin A, then forward B.');
  }

  resetCalibration(): void {
    this.calibration = null; this.calibrationA = null; this.calibrationStep = 'idle';
    this.calibrationMarkers.visible = false;
    this.root.position.set(0, 0, this.session ? -3 : 0);
    this.root.rotation.set(0, 0, 0);
    if (this.orbit) this.orbit.enabled = !this.session;
    this.report('Alignment cleared. Set the same two floor markers on each headset to align the show.');
  }

  dispose(): void {
    this.disposed = true;
    if (!this.renderer) return;
    this.renderer.setAnimationLoop(null);
    if (this.session) void this.session.end().catch(() => undefined);
    this.currentReferenceSpace?.removeEventListener('reset', this.handleReferenceReset);
    this.renderer.xr.removeEventListener('sessionstart', this.handleSessionStart);
    this.renderer.xr.removeEventListener('sessionend', this.handleSessionEnd);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('pointerdown', this.handleDesktopCalibration);
    this.renderer.domElement.removeEventListener('pointermove', this.handleDesktopPointer);
    this.resizeObserver?.disconnect();
    this.orbit?.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    this.scene.traverse(object => {
      const renderable = object as THREE.Mesh;
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (renderable.material) for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) materials.add(material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    this.glyphAtlas?.dispose();
    this.calibrationLabelTexture?.dispose();
    this.scenePass?.dispose(); this.bloomPass?.dispose(); this.pipeline?.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }

  private createPipeline(): void {
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.scenePass = pass(this.scene, this.camera);
    const sceneColor = this.scenePass.getTextureNode('output');
    this.bloomPass = bloom(sceneColor, .42, .08, .55);
    this.bloomPass.smoothWidth.value = .06;
    const combined = sceneColor.rgb.add(this.bloomPass.rgb);
    this.opaqueOutput = vec4(combined, 1);
    // Preserve the supplied VoXelo luminance alpha path, including the Bloom halo.
    // A black background therefore produces zero alpha instead of an opaque fullscreen quad.
    this.transparentOutput = vec4(combined, smoothstep(.08, .85, luminance(combined)).mul(.72));
    this.pipeline.outputNode = this.opaqueOutput;
  }

  private createGeometry(): void {
    this.particleMaterial = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.particleMaterial.positionNode = instancedBufferAttribute(this.positions);
    this.particleMaterial.colorNode = vec3(instancedBufferAttribute(this.colors)).mul(this.particleBrightness);
    this.particleMaterial.sizeNode = float(instancedBufferAttribute(this.sizes)).mul(this.particleSize);
    this.particleMaterial.opacityNode = float(1).sub(smoothstep(.12, .5, uv().sub(.5).length()));
    this.particles = new THREE.Sprite(this.particleMaterial);
    this.particles.count = MAX_PARTICLES;
    this.particles.frustumCulled = false;
    this.content.add(this.particles);

    this.glyphAtlas = this.createGlyphAtlas();
    const glyphGeometry = new THREE.PlaneGeometry(1, 1);
    const atlasOffsets = new Float32Array(MAX_INSTANCES * 2);
    for (let index = 0; index < MAX_INSTANCES; index++) {
      const glyph = index % 64;
      atlasOffsets[index * 2] = glyph % 16;
      atlasOffsets[index * 2 + 1] = 3 - Math.floor(glyph / 16);
    }
    glyphGeometry.setAttribute('atlasOffset', new THREE.InstancedBufferAttribute(atlasOffsets, 2));
    const glyphUV = uv().add(attribute('atlasOffset', 'vec2')).div(vec2(16, 4));
    const glyphTexture = texture(this.glyphAtlas, glyphUV);
    this.glyphMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.glyphMaterial.colorNode = glyphTexture.rgb.mul(this.glyphBrightness);
    this.glyphMaterial.opacityNode = glyphTexture.a.mul(this.glyphOpacity);
    this.glyphs = new THREE.InstancedMesh(glyphGeometry, this.glyphMaterial, MAX_INSTANCES);
    this.glyphs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glyphs.frustumCulled = false;
    this.content.add(this.glyphs);

    this.towerMaterial = new THREE.MeshBasicNodeMaterial({ color: '#61dfff', wireframe: true, transparent: true, opacity: .72 });
    this.towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1, 1, 3, 1), this.towerMaterial, MAX_INSTANCES);
    this.towers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.towers.frustumCulled = false;
    this.content.add(this.towers);
    this.shardMaterial = new THREE.MeshBasicNodeMaterial({ color: '#ff77ee', wireframe: true, transparent: true, opacity: .8 });
    this.shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1), this.shardMaterial, MAX_INSTANCES);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false;
    this.content.add(this.shards);

    const gridPositions: number[] = [];
    for (let index = -15; index <= 15; index++) {
      gridPositions.push(-7.5, 0, index * .5, 7.5, 0, index * .5);
      gridPositions.push(index * .5, 0, -7.5, index * .5, 0, 7.5);
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
    this.gridMaterial = new THREE.LineBasicNodeMaterial({ color: '#0c607e', transparent: true, opacity: .4 });
    this.grid = new THREE.LineSegments(gridGeometry, this.gridMaterial);
    this.grid.position.y = .012;
    this.content.add(this.grid);
    this.ringMaterial = new THREE.MeshBasicNodeMaterial({ color: '#30a4ff', transparent: true, opacity: .7 });
    const ringGeometry = new THREE.TorusGeometry(1, .009, 4, 128);
    for (let index = 0; index < 5; index++) {
      const ring = new THREE.Mesh(ringGeometry, this.ringMaterial);
      this.rings.push(ring); this.content.add(ring);
    }
    this.coreMaterial = new THREE.MeshBasicNodeMaterial({ color: '#e0b9ff', wireframe: true, transparent: true });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(.6, 2), this.coreMaterial);
    this.content.add(this.core);
    this.flashMaterial = new THREE.MeshBasicNodeMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.flashMaterial);
    this.flash.position.y = 2;
    this.content.add(this.flash);
    this.burstMaterial = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.burstMaterial.positionNode = instancedBufferAttribute(this.burstPositions);
    this.burstMaterial.colorNode = uniform(WHITE).mul(this.burstBrightness);
    this.burstMaterial.sizeNode = uniform(.055);
    this.burstMaterial.opacityNode = float(1).sub(smoothstep(.06, .5, uv().sub(.5).length()));
    this.burst = new THREE.Sprite(this.burstMaterial);
    this.burst.count = 1500; this.burst.frustumCulled = false;
    this.content.add(this.burst);
    this.content.visible = false;
  }

  private createGlyphAtlas(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for the code glyph atlas.');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff'; context.font = 'bold 48px monospace';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    for (let index = 0; index < 64; index++) context.fillText(GLYPHS[index % GLYPHS.length], (index % 16) * 64 + 32, Math.floor(index / 16) * 64 + 33);
    const atlas = new THREE.CanvasTexture(canvas);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    return atlas;
  }

  private createCalibration(): void {
    this.scene.add(this.calibrationMarkers);
    this.calibrationMarkers.visible = false;
    const markerGeometry = new THREE.TorusGeometry(.13, .012, 6, 40);
    const marker = (color: string) => {
      const result = new THREE.Mesh(markerGeometry, new THREE.MeshBasicNodeMaterial({ color }));
      result.rotation.x = -Math.PI / 2; result.position.y = .025;
      this.calibrationMarkers.add(result); return result;
    };
    this.cursor = marker('#ffffff'); this.originMarker = marker('#33ffd0'); this.forwardMarker = marker('#ffb84a');
    const labelCanvas = document.createElement('canvas'); labelCanvas.width = 1024; labelCanvas.height = 256;
    this.calibrationLabelTexture = new THREE.CanvasTexture(labelCanvas);
    this.calibrationLabel = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: this.calibrationLabelTexture, transparent: true, depthTest: false, depthWrite: false }));
    this.calibrationLabel.scale.set(1.2, .3, 1); this.calibrationLabel.visible = false;
    this.scene.add(this.calibrationLabel);
    for (let index = 0; index < 2; index++) {
      const controller = this.renderer.xr.getController(index);
      controller.addEventListener('squeezestart', () => this.beginCalibration());
      controller.addEventListener('select', () => {
        if (this.calibrationStep === 'idle') return;
        const point = this.controllerFloorPoint(controller);
        if (point) this.acceptCalibrationPoint(point);
        else this.report('Point the controller down at a nearby floor marker.');
      });
      const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -8)]);
      const ray = new THREE.Line(rayGeometry, new THREE.LineBasicNodeMaterial({ color: '#76ffdb', transparent: true, opacity: .5 }));
      ray.name = 'calibration-ray'; ray.visible = false; controller.add(ray);
      this.scene.add(controller); this.controllers.push(controller);
    }
  }

  private rebuildIdentity(state: ShowState): void {
    if (this.currentSeed === state.seed && this.currentScene === state.scene) return;
    this.currentSeed = state.seed; this.currentScene = state.scene; this.currentHue = -1;
    this.identities = Array.from({ length: MAX_PARTICLES }, (_, index) => particleIdentity(state.seed, index));
    const offsets = this.glyphs.geometry.getAttribute('atlasOffset');
    for (let index = 0; index < MAX_INSTANCES; index++) {
      const glyph = Math.floor(this.identities[index].d * 64);
      offsets.setXY(index, glyph % 16, 3 - Math.floor(glyph / 16));
    }
    offsets.needsUpdate = true;
  }

  private renderVisual(frame: VisualFrame): void {
    const { state, audio, effects, phase } = frame;
    this.content.visible = state.running;
    if (!state.running) return;
    this.rebuildIdentity(state);
    const budget = QUALITY_BUDGETS[this.quality], scene = state.scene, p = state.sceneParams;
    const counts = visibleCount(budget.particles, state);
    const instances = visibleCount(budget.instances, state);
    const fx = state.controls.masterFX;
    const strobe = state.toggles[5] ? (1 - fx * .72 * (Math.sin(frame.time * .001 * Math.PI * 8) > 0 ? 0 : 1)) : 1;
    const oneShotStrobe = 1 - effects.oneShots[5] * .6 * (Math.sin(frame.time * .025) > 0 ? 1 : 0);
    const gain = state.controls.intensity * (1 + audio.level * .35 + effects.flash * 2) * strobe * oneShotStrobe;
    const pulse = (state.toggles[1] ? audio.beat * fx * .12 : 0) + effects.oneShots[1] * .16;
    const scale = (.55 + state.controls.scale * .9) * (1 + pulse + audio.bass * (scene === 0 ? .055 : .015));
    this.content.scale.setScalar(scale * effects.contraction);
    this.content.rotation.y = (state.toggles[0] ? phase * .15 * fx : 0) + effects.oneShots[0] * Math.PI * .5;
    const hue = p[5] + (state.toggles[6] ? phase * .06 * fx : 0) + effects.oneShots[6] * .3;
    if (Math.abs(hue - this.currentHue) > .004 || this.currentHue < 0) {
      this.currentHue = hue;
      const baseHue = [.42, .51, .55, .86, .67][scene];
      for (let index = 0; index < MAX_PARTICLES; index++) {
        this.color.setHSL(((baseHue + (hue - .5) * .6 + this.identities[index].a * .16) % 1 + 1) % 1, .8, .56);
        this.colors.setXYZ(index, this.color.r, this.color.g, this.color.b);
        if (index < MAX_INSTANCES) { this.glyphs.setColorAt(index, this.color); this.towers.setColorAt(index, this.color); this.shards.setColorAt(index, this.color); }
      }
      this.colors.needsUpdate = true;
      if (this.glyphs.instanceColor) this.glyphs.instanceColor.needsUpdate = true;
      if (this.towers.instanceColor) this.towers.instanceColor.needsUpdate = true;
      if (this.shards.instanceColor) this.shards.instanceColor.needsUpdate = true;
    }
    this.particles.count = scene === 1 || scene === 4 ? counts : Math.min(counts, scene === 3 ? 5000 : 1600);
    this.particleBrightness.value = gain * (scene === 1 ? 3.8 : 2.6);
    this.particleSize.value = 1 + audio.bass * .5;
    for (let index = 0; index < this.particles.count; index++) {
      sampleParticle(frame, this.identities[index], this.sample);
      let { x, y, z } = this.sample;
      if (scene === 2) y = .03 + audio.beat * .12 + Math.sin(Math.hypot(x, z) * (1 + p[3] * 4) - phase * 2) * (.03 + p[6] * .08);
      this.positions.setXYZ(index, x, y, z);
      this.sizes.setX(index, scene === 1 || scene === 4 ? this.sample.size : .018);
    }
    this.positions.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.glyphs.visible = scene === 0 || scene === 3 || scene === 4;
    this.glyphs.count = scene === 4 ? Math.min(instances, 220) : scene === 3 ? Math.max(20, Math.round(instances * p[6])) : instances;
    this.glyphBrightness.value = gain * (3.6 + audio.high * p[7] * 1.3);
    this.glyphOpacity.value = Math.min(1, gain + .1);
    if (this.glyphs.visible) {
      for (let index = 0; index < this.glyphs.count; index++) {
        sampleParticle(frame, this.identities[index], this.sample);
        const v = this.sample;
        this.dummy.position.set(v.x, v.y, v.z);
        this.dummy.rotation.set(scene === 3 ? phase * .4 : 0, scene === 0 ? -v.angle + Math.PI / 2 : -v.angle, (p[4] - .5) * .8);
        this.dummy.scale.setScalar(v.size * (scene === 4 ? 3.2 : 1));
        this.dummy.updateMatrix(); this.glyphs.setMatrixAt(index, this.dummy.matrix);
      }
      this.glyphs.instanceMatrix.needsUpdate = true;
    }
    this.towers.visible = scene === 2;
    this.towers.count = Math.min(instances, 961);
    this.towerMaterial.color.setScalar(gain * (1.2 + audio.beat * p[7]));
    if (this.towers.visible) {
      // A seeded permutation distributes low-density buildings across the whole city.
      for (let index = 0; index < this.towers.count; index++) {
        sampleParticle(frame, this.identities[(index * 397) % 961], this.sample);
        const v = this.sample;
        this.dummy.position.set(v.x, v.y * .5, v.z);
        this.dummy.rotation.set(0, 0, 0); this.dummy.scale.set(v.size, v.y, v.size);
        this.dummy.updateMatrix(); this.towers.setMatrixAt(index, this.dummy.matrix);
      }
      this.towers.instanceMatrix.needsUpdate = true;
    }
    this.shards.visible = scene === 3 || scene === 4;
    this.shards.count = scene === 4 ? Math.min(instances, 150) : instances;
    this.shardMaterial.color.setScalar(gain * 1.6);
    if (this.shards.visible) {
      for (let index = 0; index < this.shards.count; index++) {
        sampleParticle(frame, this.identities[index], this.sample);
        const v = this.sample;
        this.dummy.position.set(v.x, v.y, v.z);
        this.dummy.rotation.set(v.angle, v.angle * 1.7, phase * (p[4] + .1));
        this.dummy.scale.set(v.size, v.size * (1 + p[7] * 3), v.size);
        this.dummy.updateMatrix(); this.shards.setMatrixAt(index, this.dummy.matrix);
      }
      this.shards.instanceMatrix.needsUpdate = true;
    }
    this.grid.visible = scene === 2 || (!this.session && scene === 0);
    this.gridMaterial.opacity = (scene === 2 ? .4 + audio.beat * .2 : .1) * gain;
    this.grid.scale.setScalar(scene === 2 ? .5 + p[0] * .5 : .7);
    this.core.visible = scene === 4;
    this.core.position.y = 1 + p[1] * 2;
    this.core.scale.setScalar((.3 + p[6] * 1.2) * (1 + audio.bass * .3));
    this.core.rotation.set(phase * .12, phase * .25, phase * .08);
    this.coreMaterial.color.copy(this.color.setHSL((.64 + hue * .25) % 1, .4, .8)).multiplyScalar(gain * 2);
    for (let index = 0; index < this.rings.length; index++) {
      const ring = this.rings[index];
      ring.visible = scene === 4 || scene === 0 || scene === 2;
      const radius = scene === 4 ? .6 + index * .42 + p[6] : scene === 0 ? 2.6 + p[6] * 1.6 : 1 + ((phase * .6 + index * 1.1) % 5);
      ring.scale.setScalar(radius);
      ring.position.set(0, scene === 4 ? this.core.position.y : scene === 0 ? 1 + index * (1 + p[1] * .3) : .03, 0);
      ring.rotation.set(Math.PI / 2 + (scene === 4 ? Math.sin(index * 1.8) * .55 : 0), scene === 4 ? phase * .06 + index * .45 : 0, 0);
    }
    this.ringMaterial.color.copy(this.color.setHSL((.49 + (hue - .5) * .3) % 1, .85, .6)).multiplyScalar(gain * (1 + audio.beat * .5));
    this.flash.visible = effects.flash > .005;
    this.flash.scale.setScalar(.4 + effects.flash * 2);
    this.flashMaterial.opacity = effects.flash * .65 * gain;
    this.burst.visible = effects.burstOpacity > .001;
    this.burstBrightness.value = effects.burstOpacity * gain * 3;
    if (this.burst.visible) {
      if (this.currentBurstSeed !== effects.burstSeed) {
        this.currentBurstSeed = effects.burstSeed;
        this.burstIdentities = Array.from({ length: 1500 }, (_, index) => particleIdentity(effects.burstSeed, index));
      }
      for (let index = 0; index < 1500; index++) {
        const identity = this.burstIdentities[index];
        const longitude = identity.a * Math.PI * 2, vertical = identity.b * 2 - 1;
        const radius = effects.burst * (.6 + identity.c * .4), horizontal = Math.sqrt(1 - vertical * vertical);
        this.burstPositions.setXYZ(index, Math.cos(longitude) * horizontal * radius, 2 + vertical * radius, Math.sin(longitude) * horizontal * radius);
      }
      this.burstPositions.needsUpdate = true;
    }
    this.bloomPass.strength.value = state.controls.glow * (.18 + fx * .75) + audio.beat * state.controls.glow * .18 + effects.flash * .45;
  }

  private animate = (): void => {
    if (this.disposed) return;
    const synchronized = this.sampleProvider?.();
    if (synchronized) this.update(synchronized.state, synchronized.audio, synchronized.now);
    const now = performance.now();
    this.fpsFrames++;
    if (now - this.fpsStart >= 600) {
      this.fpsValue = Math.min(1000, this.fpsFrames * 1000 / (now - this.fpsStart));
      this.fpsFrames = 0; this.fpsStart = now;
    }
    // A stalled client cannot advance old data indefinitely. The client refreshes this anchor every RAF.
    const time = this.latestServerTime + Math.min(150, Math.max(0, now - this.receivedAt));
    this.renderVisual(visualFrame(this.latestState, this.latestAudio, time));
    if (!this.session) this.orbit.update();
    this.updateCalibrationCursor();
    try { this.pipeline.render(); }
    catch (error) {
      this.renderer.setAnimationLoop(null); this.fpsValue = 0;
      this.report(`Rendering stopped: ${messageOf(error)}`);
    }
  };

  private resize = (): void => {
    if (!this.initialized || this.disposed || this.renderer.xr.isPresenting) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_BUDGETS[this.quality].pixelRatio));
    this.renderer.setSize(width, height, false);
  };

  private handleSessionStart = (): void => {
    this.session = this.renderer.xr.getSession();
    this.scene.background = null; this.scene.fog = null;
    this.renderer.setClearColor(0x000000, 0);
    this.pipeline.outputNode = this.transparentOutput; this.pipeline.needsUpdate = true;
    this.orbit.enabled = false;
    this.currentReferenceSpace = this.renderer.xr.getReferenceSpace();
    this.currentReferenceSpace.addEventListener('reset', this.handleReferenceReset);
    this.resetCalibration();
    this.beginCalibration();
  };

  private handleSessionEnd = (): void => {
    this.currentReferenceSpace?.removeEventListener('reset', this.handleReferenceReset);
    this.currentReferenceSpace = null; this.session = null;
    this.scene.background = BACKGROUND;
    this.renderer.setClearColor(BACKGROUND, 1);
    this.pipeline.outputNode = this.opaqueOutput; this.pipeline.needsUpdate = true;
    this.resetCalibration(); this.orbit.enabled = true; this.resize();
    this.report('MR ended. Alignment was cleared; desktop preview is active.');
  };

  private handleReferenceReset = (): void => {
    this.resetCalibration();
    this.beginCalibration();
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault(); this.renderer.setAnimationLoop(null); this.fpsValue = 0;
    this.report('WebGL context lost. Reload this page to restore the renderer.');
  };

  private controllerFloorPoint(controller: THREE.Group): Point3 | null {
    controller.getWorldPosition(this.controllerOrigin); controller.getWorldQuaternion(this.controllerRotation);
    this.controllerDirection.set(0, 0, -1).applyQuaternion(this.controllerRotation);
    return floorIntersection(this.controllerOrigin, this.controllerDirection);
  }

  private updateCalibrationCursor(): void {
    const active = this.calibrationStep !== 'idle';
    this.calibrationLabel.visible = active && this.session !== null;
    if (this.calibrationLabel.visible) {
      const camera = this.renderer.xr.getCamera();
      camera.getWorldPosition(this.controllerOrigin); camera.getWorldQuaternion(this.controllerRotation);
      this.controllerDirection.set(0, -.25, -1.4).applyQuaternion(this.controllerRotation);
      this.calibrationLabel.position.copy(this.controllerOrigin).add(this.controllerDirection);
    }
    for (const controller of this.controllers) {
      const ray = controller.getObjectByName('calibration-ray');
      if (ray) ray.visible = active;
    }
    if (!active) { this.cursor.visible = false; return; }
    let point: Point3 | null = null;
    if (this.session) {
      for (const controller of this.controllers) {
        if (controller.visible) point = this.controllerFloorPoint(controller);
        if (point) break;
      }
    } else {
      this.raycaster.setFromCamera(this.desktopPointer, this.camera);
      point = floorIntersection(this.raycaster.ray.origin, this.raycaster.ray.direction);
    }
    this.cursor.visible = point !== null;
    if (point) this.cursor.position.set(point.x, .025, point.z);
  }

  private handleDesktopPointer = (event: PointerEvent): void => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.desktopPointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
  };

  private handleDesktopCalibration = (event: PointerEvent): void => {
    if (this.session || this.calibrationStep === 'idle' || event.button !== 0) return;
    this.handleDesktopPointer(event);
    this.raycaster.setFromCamera(this.desktopPointer, this.camera);
    const point = floorIntersection(this.raycaster.ray.origin, this.raycaster.ray.direction);
    if (point) this.acceptCalibrationPoint(point);
    else this.report('Click a floor point nearer the installation.');
  };

  private acceptCalibrationPoint(point: Point3): void {
    if (this.calibrationStep === 'origin') {
      this.calibrationA = point; this.calibrationStep = 'forward';
      this.setCalibrationLabel('B · SHARED FORWARD MARKER', 'Choose a floor point at least 30 cm away');
      this.originMarker.position.set(point.x, .025, point.z); this.originMarker.visible = true;
      this.report('Origin A set. Select forward marker B at least 30 cm away.');
    } else if (this.calibrationStep === 'forward' && this.calibrationA) {
      try {
        this.calibration = solveCalibration(this.calibrationA, point);
        this.root.position.set(this.calibration.origin.x, 0, this.calibration.origin.z);
        this.root.rotation.set(0, this.calibration.yaw, 0);
        this.forwardMarker.position.set(point.x, .025, point.z); this.forwardMarker.visible = true;
        this.calibrationStep = 'idle'; this.orbit.enabled = !this.session;
        this.report(`Aligned to shared floor markers (${this.calibration.separation.toFixed(2)} m apart).`);
      } catch (error) { this.report(messageOf(error)); }
    }
  }

  private setCalibrationLabel(title: string, detail: string): void {
    const canvas = this.calibrationLabelTexture.image as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(2,8,18,0.8)'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillStyle = '#67ffe2'; context.font = 'bold 40px monospace'; context.fillText(title, 512, 92);
    context.fillStyle = '#ffffff'; context.font = '28px monospace'; context.fillText(detail, 512, 161);
    this.calibrationLabelTexture.needsUpdate = true;
  }

  private report(message: string): void { this.statusMessage = message; this.onStatus?.(message); }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

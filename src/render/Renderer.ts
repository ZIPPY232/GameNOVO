import * as THREE from 'three';
import { FULLSCREEN_VERT, COMPOSITE_FRAG } from './shaders/composite';
import { BLOOM_PREFILTER, BLOOM_DOWN, BLOOM_UP, LUM_FRAG, LUM_DOWN, ADAPT_FRAG, FINAL_FRAG, FXAA_FRAG } from './shaders/post';
import type { GraphicsSettings } from '../core/settings';

/**
 * HDR rendering pipeline:
 *   scene (+viewmodel) -> HDR target with float log-depth
 *   -> composite (atmosphere / ocean / clouds of the focus planet)
 *   -> auto exposure + bloom -> ACES tone map + grading -> FXAA -> screen
 *
 * Floating origin: the camera always sits at the render-space origin; every
 * object is positioned relative to it on the CPU in double precision.
 */

export interface PlanetFX {
  hasAtmo: boolean;
  hasOcean: boolean;
  hasClouds: boolean;
  planetPos: THREE.Vector3; // relative to camera, render space
  planetRot: THREE.Matrix3; // render -> planet local
  radius: number;
  atmoTop: number;
  betaR: THREE.Vector3;
  betaM: number;
  hR: number;
  hM: number;
  mieG: number;
  mieColor: THREE.Vector3;
  seaR: number;
  waterDeep: THREE.Vector3;
  waterScatter: THREE.Vector3;
  waterAbsorb: THREE.Vector3;
  cloudR: number;
  cloudCover: number;
  cloudColor: THREE.Vector3;
  cloudScale: number;
  wind: THREE.Vector3;
}

export interface FrameFX {
  sunDir: THREE.Vector3;
  sunColor: THREE.Vector3;
  ambient: THREE.Vector3;
  warp: number;
  heat: number;
  damage: number;
  fade: number;
  chroma: number;
  fogColor: THREE.Vector3;
  fogDensity: number;
  exposureBias: number;
  wetness: number;
  saturation: number;
  contrast: number;
}

function makeNoise3D(size: number): THREE.Data3DTexture {
  // tileable value-noise fBm, computed once
  const data = new Uint8Array(size * size * size);
  const lattice = (period: number, seed: number) => {
    const g = new Float32Array(period * period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return g;
  };
  const octs = [4, 8, 16, 32];
  const grids = octs.map((p, i) => lattice(p, 1234 + i * 977));
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octs.length; o++) {
      const P = octs[o];
      const g = grids[o];
      const fx = (x / size) * P, fy = (y / size) * P, fz = (z / size) * P;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz);
      const at = (a: number, b: number, c: number) => g[((a % P) + P) % P + (((b % P) + P) % P) * P + (((c % P) + P) % P) * P * P];
      const c00 = at(ix, iy, iz) * (1 - tx) + at(ix + 1, iy, iz) * tx;
      const c10 = at(ix, iy + 1, iz) * (1 - tx) + at(ix + 1, iy + 1, iz) * tx;
      const c01 = at(ix, iy, iz + 1) * (1 - tx) + at(ix + 1, iy, iz + 1) * tx;
      const c11 = at(ix, iy + 1, iz + 1) * (1 - tx) + at(ix + 1, iy + 1, iz + 1) * tx;
      const c0 = c00 * (1 - ty) + c10 * ty, c1 = c01 * (1 - ty) + c11 * ty;
      v += (c0 * (1 - tz) + c1 * tz) * amp;
      norm += amp;
      amp *= 0.5;
    }
    data[x + y * size + z * size * size] = Math.round((v / norm) * 255);
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function rt(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType, depth = false): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  if (depth) {
    t.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    t.depthTexture.minFilter = THREE.NearestFilter;
    t.depthTexture.magFilter = THREE.NearestFilter;
  }
  return t;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly noise3D: THREE.Data3DTexture;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private sceneRT!: THREE.WebGLRenderTarget;
  private compRT!: THREE.WebGLRenderTarget;
  private ldrRT!: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private bloomUpRTs: THREE.WebGLRenderTarget[] = [];
  private lumRTs: THREE.WebGLRenderTarget[] = [];
  private expRT: THREE.WebGLRenderTarget[] = [];
  private expIdx = 0;
  private expInit = true;

  private matComposite: THREE.RawShaderMaterial;
  private matPrefilter: THREE.RawShaderMaterial;
  private matDown: THREE.RawShaderMaterial;
  private matUp: THREE.RawShaderMaterial;
  private matLum: THREE.RawShaderMaterial;
  private matLumDown: THREE.RawShaderMaterial;
  private matAdapt: THREE.RawShaderMaterial;
  private matFinal: THREE.RawShaderMaterial;
  private matFxaa: THREE.RawShaderMaterial;

  settings: GraphicsSettings;
  width = 1;
  height = 1;
  scale = 1;
  private dynScale = 1;
  private frameTimes: number[] = [];
  readonly fx: FrameFX = {
    sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Vector3(1, 1, 1), ambient: new THREE.Vector3(0.02, 0.02, 0.03),
    warp: 0, heat: 0, damage: 0, fade: 0, chroma: 0, fogColor: new THREE.Vector3(), fogDensity: 0, exposureBias: 1, wetness: 0,
    saturation: 1.05, contrast: 1.04,
  };
  planet: PlanetFX | null = null;
  time = 0;
  manualExposure = 0;
  /** upper exposure bound (set from scene lighting so sunlit space scenes are not blown out) */
  maxExposure = 30;
  stats = { drawCalls: 0, triangles: 0 };

  constructor(canvas: HTMLCanvasElement, settings: GraphicsSettings) {
    this.settings = settings;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 2e8);
    this.camera.matrixAutoUpdate = true;
    this.noise3D = makeNoise3D(64);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geo);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) => new THREE.RawShaderMaterial({
      vertexShader: 'precision highp float;\nin vec3 position;\n' + FULLSCREEN_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      glslVersion: THREE.GLSL3,
    });
    this.matComposite = mk(COMPOSITE_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, tNoise: { value: this.noise3D },
      uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() }, uCamFwd: { value: new THREE.Vector3() },
      uLogFar: { value: 1 },
      uHasAtmo: { value: 0 }, uHasOcean: { value: 0 }, uHasClouds: { value: 0 },
      uPlanetPos: { value: new THREE.Vector3() }, uPlanetRot: { value: new THREE.Matrix3() },
      uSeaR: { value: 1 }, uWaterDeep: { value: new THREE.Vector3() }, uWaterScatter: { value: new THREE.Vector3() }, uWaterAbsorb: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uCloudR: { value: 1 }, uCloudCover: { value: 0 }, uCloudColor: { value: new THREE.Vector3(1, 1, 1) }, uCloudScale: { value: 1 },
      uWind: { value: new THREE.Vector3() }, uAmbient: { value: new THREE.Vector3() }, uSteps: { value: 12 }, uLSteps: { value: 4 },
      uWetness: { value: 0 }, uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0 }, uDebug: { value: 0 },
      uRg: { value: 1 }, uRa: { value: 1 }, uBetaR: { value: new THREE.Vector3() }, uBetaM: { value: 0 }, uHR: { value: 1 }, uHM: { value: 1 },
      uMieG: { value: 0.76 }, uMieColor: { value: new THREE.Vector3(1, 1, 1) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    });
    this.matPrefilter = mk(BLOOM_PREFILTER, { tSrc: { value: null }, tExposure: { value: null }, uManual: { value: 0 }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 }, uKnee: { value: 0.5 } });
    this.matDown = mk(BLOOM_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.matUp = mk(BLOOM_UP, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.matLum = mk(LUM_FRAG, { tSrc: { value: null } });
    this.matLumDown = mk(LUM_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.matAdapt = mk(ADAPT_FRAG, { tLum: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uKey: { value: 0.19 }, uMin: { value: 0.02 }, uMax: { value: 40 }, uInit: { value: 1 } });
    this.matFinal = mk(FINAL_FRAG, {
      tHDR: { value: null }, tBloom: { value: null }, tExposure: { value: null }, uBloom: { value: 0.06 }, uExposureBias: { value: 1 }, uManualExposure: { value: 0 },
      uSaturation: { value: 1.05 }, uContrast: { value: 1.04 }, uLift: { value: new THREE.Vector3(0.008, 0.01, 0.018) }, uGain: { value: new THREE.Vector3(1.02, 1.0, 0.97) },
      uVignette: { value: 0.35 }, uGrain: { value: 0.012 }, uTime: { value: 0 }, uWarp: { value: 0 }, uHeat: { value: 0 }, uDamage: { value: 0 }, uFade: { value: 0 },
      uChroma: { value: 0 }, uRes: { value: new THREE.Vector2() },
    });
    this.matFxaa = mk(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

    for (let i = 0; i < 2; i++) this.expRT.push(rt(1, 1, THREE.FloatType));
    for (const s of [64, 16, 4, 1]) this.lumRTs.push(rt(s, s, THREE.FloatType));
    this.resize(window.innerWidth, window.innerHeight);
  }

  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.gl.setPixelRatio(1);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.allocTargets();
  }

  private allocTargets(): void {
    const s = Math.max(0.35, Math.min(2, this.settings.resolutionScale * this.dynScale)) * Math.min(this.pixelRatio, 1.5);
    this.scale = s;
    const w = Math.max(64, Math.round(this.width * s));
    const h = Math.max(64, Math.round(this.height * s));
    for (const t of [this.sceneRT, this.compRT, this.ldrRT, ...this.bloomRTs, ...this.bloomUpRTs]) t?.dispose();
    this.sceneRT = rt(w, h, THREE.HalfFloatType, true);
    this.compRT = rt(w, h, THREE.HalfFloatType);
    this.ldrRT = rt(w, h, THREE.UnsignedByteType);
    this.bloomRTs = [];
    this.bloomUpRTs = [];
    let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    for (let i = 0; i < 6; i++) {
      this.bloomRTs.push(rt(bw, bh));
      this.bloomUpRTs.push(rt(bw, bh));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
  }

  applySettings(settings: GraphicsSettings): void {
    this.settings = settings;
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
    this.dynScale = 1;
    this.allocTargets();
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.gl.setRenderTarget(target);
    this.gl.render(this.quadScene, this.orthoCam);
  }

  /** Track frame time for dynamic resolution. */
  private updateDynamicResolution(dt: number): void {
    if (!this.settings.dynamicResolution) {
      if (this.dynScale !== 1) { this.dynScale = 1; this.allocTargets(); }
      return;
    }
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 45) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    let next = this.dynScale;
    if (avg > 1 / 42) next = Math.max(0.55, this.dynScale - 0.08);
    else if (avg < 1 / 58) next = Math.min(1, this.dynScale + 0.05);
    if (Math.abs(next - this.dynScale) > 0.01) {
      this.dynScale = next;
      this.allocTargets();
    }
  }

  render(dt: number): void {
    this.time += dt;
    this.updateDynamicResolution(dt);
    const gl = this.gl;
    const cam = this.camera;
    cam.updateMatrixWorld();

    // 1. scene
    gl.info.reset();
    gl.setRenderTarget(this.sceneRT);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    gl.render(this.scene, cam);
    gl.render(this.viewScene, cam);
    const info = gl.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;

    // 2. composite
    const u = this.matComposite.uniforms;
    u.tColor.value = this.sceneRT.texture;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
    cam.getWorldDirection(u.uCamFwd.value);
    u.uLogFar.value = Math.log2(cam.far + 1);
    u.uTime.value = this.time;
    u.uSunDir.value.copy(this.fx.sunDir);
    u.uSunColor.value.copy(this.fx.sunColor);
    u.uAmbient.value.copy(this.fx.ambient);
    u.uFogColor.value.copy(this.fx.fogColor);
    u.uFogDensity.value = this.fx.fogDensity;
    const aq = this.settings.atmosphereQuality;
    u.uSteps.value = [6, 10, 14, 20][aq] ?? 12;
    u.uLSteps.value = [2, 3, 4, 6][aq] ?? 4;
    const p = this.planet;
    if (p) {
      u.uHasAtmo.value = p.hasAtmo ? 1 : 0;
      u.uHasOcean.value = p.hasOcean ? 1 : 0;
      u.uHasClouds.value = p.hasClouds && p.hasAtmo ? 1 : 0;
      u.uPlanetPos.value.copy(p.planetPos);
      u.uPlanetRot.value.copy(p.planetRot);
      u.uRg.value = p.radius;
      u.uRa.value = p.atmoTop;
      u.uBetaR.value.copy(p.betaR);
      u.uBetaM.value = p.betaM;
      u.uHR.value = p.hR;
      u.uHM.value = p.hM;
      u.uMieG.value = p.mieG;
      u.uMieColor.value.copy(p.mieColor);
      u.uSeaR.value = p.seaR;
      u.uWaterDeep.value.copy(p.waterDeep);
      u.uWaterScatter.value.copy(p.waterScatter);
      u.uWaterAbsorb.value.copy(p.waterAbsorb);
      u.uCloudR.value = p.cloudR;
      u.uCloudCover.value = p.cloudCover;
      u.uCloudColor.value.copy(p.cloudColor);
      u.uCloudScale.value = p.cloudScale;
      u.uWind.value.copy(p.wind);
    } else {
      u.uHasAtmo.value = 0;
      u.uHasOcean.value = 0;
      u.uHasClouds.value = 0;
    }
    this.pass(this.matComposite, this.compRT);

    // 3. exposure
    this.matLum.uniforms.tSrc.value = this.compRT.texture;
    this.pass(this.matLum, this.lumRTs[0]);
    for (let i = 1; i < this.lumRTs.length; i++) {
      const src = this.lumRTs[i - 1];
      this.matLumDown.uniforms.tSrc.value = src.texture;
      this.matLumDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass(this.matLumDown, this.lumRTs[i]);
    }
    const prev = this.expRT[this.expIdx];
    const next = this.expRT[1 - this.expIdx];
    this.matAdapt.uniforms.tLum.value = this.lumRTs[this.lumRTs.length - 1].texture;
    this.matAdapt.uniforms.tPrev.value = prev.texture;
    this.matAdapt.uniforms.uDt.value = Math.min(dt, 0.1);
    this.matAdapt.uniforms.uInit.value = this.expInit ? 1 : 0;
    this.matAdapt.uniforms.uMax.value = this.maxExposure;
    this.expInit = false;
    this.pass(this.matAdapt, next);
    this.expIdx = 1 - this.expIdx;

    // 4. bloom
    const bloomOn = this.settings.bloom;
    if (bloomOn) {
      this.matPrefilter.uniforms.tSrc.value = this.compRT.texture;
      this.matPrefilter.uniforms.tExposure.value = next.texture;
      this.matPrefilter.uniforms.uManual.value = this.manualExposure;
      this.matPrefilter.uniforms.uTexel.value.set(1 / this.compRT.width, 1 / this.compRT.height);
      this.pass(this.matPrefilter, this.bloomRTs[0]);
      for (let i = 1; i < this.bloomRTs.length; i++) {
        const src = this.bloomRTs[i - 1];
        this.matDown.uniforms.tSrc.value = src.texture;
        this.matDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.pass(this.matDown, this.bloomRTs[i]);
      }
      let src = this.bloomRTs[this.bloomRTs.length - 1];
      for (let i = this.bloomRTs.length - 2; i >= 0; i--) {
        this.matUp.uniforms.tSrc.value = src.texture;
        this.matUp.uniforms.tBase.value = this.bloomRTs[i].texture;
        this.matUp.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.pass(this.matUp, this.bloomUpRTs[i]);
        src = this.bloomUpRTs[i];
      }
    }

    // 5. final grade
    const f = this.matFinal.uniforms;
    f.tHDR.value = this.compRT.texture;
    f.tBloom.value = bloomOn ? this.bloomUpRTs[0].texture : this.bloomRTs[5].texture;
    f.uBloom.value = bloomOn ? 0.12 : 0;
    f.tExposure.value = next.texture;
    f.uExposureBias.value = this.fx.exposureBias;
    f.uManualExposure.value = this.manualExposure;
    f.uTime.value = this.time;
    f.uWarp.value = this.fx.warp;
    f.uHeat.value = this.fx.heat;
    f.uDamage.value = this.fx.damage;
    f.uFade.value = this.fx.fade;
    f.uChroma.value = this.fx.chroma;
    f.uSaturation.value = this.fx.saturation;
    f.uContrast.value = this.fx.contrast;
    f.uVignette.value = this.settings.postFx > 0 ? 0.32 : 0;
    f.uGrain.value = this.settings.postFx > 1 ? 0.012 : 0;
    f.uRes.value.set(this.ldrRT.width, this.ldrRT.height);
    if (this.settings.fxaa) {
      this.pass(this.matFinal, this.ldrRT);
      this.matFxaa.uniforms.tSrc.value = this.ldrRT.texture;
      this.matFxaa.uniforms.uTexel.value.set(1 / this.ldrRT.width, 1 / this.ldrRT.height);
      gl.setViewport(0, 0, this.width, this.height);
      this.pass(this.matFxaa, null);
    } else {
      this.pass(this.matFinal, null);
    }
  }

  resetExposure(): void {
    this.expInit = true;
  }
}

import * as THREE from 'three';
import { Galaxy, type StarSummary } from '../universe/galaxy';
import { generateSystem } from '../universe/systemGen';
import { StarSystem, type BodyState, type Frame } from '../universe/StarSystem';
import type { StarSystemDef } from '../universe/types';
import { Renderer, type PlanetFX } from '../render/Renderer';
import { Sky } from '../render/Sky';
import { StarMesh, DistantBody } from '../render/Bodies';
import { WorkerPool } from '../voxel/workerProtocol';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { PlanetLOD, createLodMaterial, type LodUniforms } from '../planet/PlanetLOD';
import { TerrainGenerator } from '../planet/terrain';
import { createTerrainMaterial, createSmoothTerrainMaterial, makeArrayTextures, makeLayerProps, makeBlockLayerTexture, type TerrainUniforms } from '../render/TerrainMaterial';
import type { TextureSet } from '../render/textureGen';
import { VoxelPhysics } from '../physics/VoxelPhysics';
import { Weather } from '../weather/Weather';
import { atmoFromDef, transmittance, skyRadiance, skyEquirect, type AtmoCPU } from '../render/atmosphereCPU';
import type { BakeResult } from '../planet/tilegen';
import type { GraphicsSettings } from '../core/settings';
import { AU_GAME } from '../universe/systemGen';
import { StationModel, AsteroidBelt } from '../render/SpaceObjects';
import { Rng, hash32 } from '../core/rng';

/**
 * Owns the loaded star system and everything rendered at astronomical scale:
 * reference frames, distant bodies, the star, sky, the focus planet (LOD +
 * streaming voxels), sun/ambient lighting and reflection probes.
 */

export class FocusPlanet {
  readonly body: BodyState;
  readonly root = new THREE.Group();
  readonly lod: PlanetLOD;
  readonly gen: TerrainGenerator;
  voxels: VoxelWorld | null = null;
  physics: VoxelPhysics | null = null;
  readonly weather: Weather;
  readonly atmo: AtmoCPU | null;
  readonly key: string;

  constructor(body: BodyState, key: string, pool: WorkerPool, lodMat: THREE.Material) {
    this.body = body;
    this.key = key;
    this.gen = new TerrainGenerator(body.def.gen!);
    this.lod = new PlanetLOD(key, body.def.gen!, pool, lodMat);
    this.root.add(this.lod.group);
    this.weather = new Weather(body.def);
    this.atmo = body.def.atmosphere ? atmoFromDef(body.def.radius, body.def.atmosphere) : null;
    this.root.name = 'focus:' + body.id;
  }

  /** Natural surface radius under a planet-local direction. */
  surfaceRadius(dir: THREE.Vector3): number {
    if (this.voxels) return this.voxels.surfaceRadius(dir.x, dir.y, dir.z);
    const p = this.body.def.gen!;
    const h = this.gen.heightAt(dir.x, dir.y, dir.z);
    const hh = (p.frozenOcean || p.lavaOcean) && h < 0 ? 0 : h;
    return p.baseRadius + Math.floor(p.seaZ + hh) + 1;
  }

  dispose(): void {
    this.lod.dispose();
    this.voxels?.dispose();
    this.root.removeFromParent();
  }
}

export class Universe {
  readonly renderer: Renderer;
  readonly pool: WorkerPool;
  galaxy: Galaxy;
  summary!: StarSummary;
  def!: StarSystemDef;
  system!: StarSystem;
  frame: Frame = null;
  focus: FocusPlanet | null = null;
  sky: Sky;
  star: StarMesh | null = null;
  bodies = new Map<string, DistantBody>();
  bakes = new Map<string, BakeResult>();
  /** player edits per body key (systemId:bodyId) */
  edits = new Map<string, Map<string, Uint8Array>>();
  dirtyEdits = new Set<string>();
  editLoader: ((key: string) => Promise<Map<string, Uint8Array>>) | null = null;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly frameRoot = new THREE.Group();
  readonly worldRoot = new THREE.Group();
  terrainUniforms: TerrainUniforms;
  lodUniforms: LodUniforms;
  matOpaque!: THREE.Material;
  matTrans!: THREE.Material;
  matSmooth!: THREE.Material;
  lodMat: THREE.Material;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  sunDir = new THREE.Vector3(0, 1, 0);
  sunIrradiance = new THREE.Vector3(6, 6, 6);
  sunAtObserver = new THREE.Vector3();
  /** illuminance of nearby artificial light the eye adapts to (flashlight patch) */
  localLight = 0;
  ambient = new THREE.Vector3();
  eclipse = 1;
  sunElevation = 1;
  private creatingVoxels = false;
  settings: GraphicsSettings;
  time = 0;
  station: StationModel | null = null;
  stationHost: BodyState | null = null;
  private stationOrbit = { r: 0, period: 900, phase: 0 };
  /** station state in system frame */
  stationPos = new THREE.Vector3();
  stationQuat = new THREE.Quaternion();
  belt: AsteroidBelt | null = null;

  constructor(renderer: Renderer, galaxySeed: number, settings: GraphicsSettings) {
    this.renderer = renderer;
    this.settings = settings;
    this.pool = new WorkerPool();
    this.galaxy = new Galaxy(galaxySeed);
    this.sky = new Sky(renderer.noise3D, galaxySeed);
    renderer.scene.add(this.sky.group);
    renderer.scene.add(this.worldRoot, this.frameRoot);
    this.sun = new THREE.DirectionalLight(0xffffff, 6);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.applyShadowSettings();
    renderer.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x8899aa, 0x332211, 0.4);
    renderer.scene.add(this.hemi);
    this.pmrem = new THREE.PMREMGenerator(renderer.gl);
    this.terrainUniforms = {
      tAlbedo: { value: null }, tMaterial: { value: null }, tNoise: { value: renderer.noise3D }, uLayerProps: { value: makeLayerProps() },
      uBioTint: { value: new THREE.Vector3(0.4, 0.6, 0.5) }, uRockTint: { value: new THREE.Vector3(1, 1, 1) }, uRenderToPlanet: { value: new THREE.Matrix4() },
      uWetness: { value: 0 }, uUpView: { value: new THREE.Vector3(0, 1, 0) }, uScanCenter: { value: new THREE.Vector3() }, uScanRadius: { value: 0 },
      uScanStrength: { value: 0 }, uTime: { value: 0 }, uSkyAmbient: { value: 0.08 },
      tBlockLayers: { value: makeBlockLayerTexture() }, uTexScale: { value: 0.42 },
    };
    this.lodUniforms = {
      uDiscardDir: { value: new THREE.Vector3(0, 1, 0) }, uDiscardR: { value: 0 }, uPlanetR: { value: 1 }, uRenderToPlanet: this.terrainUniforms.uRenderToPlanet, tNoise: { value: renderer.noise3D },
    };
    this.lodMat = createLodMaterial(this.lodUniforms);
  }

  applyShadowSettings(): void {
    const q = this.settings.shadows;
    this.sun.castShadow = q > 0;
    const size = [512, 1024, 2048, 4096][q] ?? 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as unknown as { map: null }).map = null;
    }
    const ext = q >= 3 ? 70 : 55;
    const cam = this.sun.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1; cam.far = 900;
    cam.updateProjectionMatrix();
  }

  setTextures(set: TextureSet): void {
    const { albedo, material } = makeArrayTextures(set, Math.min(8, this.renderer.gl.capabilities.getMaxAnisotropy()));
    this.terrainUniforms.tAlbedo.value = albedo;
    this.terrainUniforms.tMaterial.value = material;
    this.matOpaque = createTerrainMaterial(this.terrainUniforms, false);
    this.matTrans = createTerrainMaterial(this.terrainUniforms, true);
    this.matSmooth = createSmoothTerrainMaterial(this.terrainUniforms);
  }

  // ------------------------------------------------------------------ systems

  bodyKey(bodyId: string): string {
    return `${this.def.id}:${bodyId}`;
  }

  async loadSystem(summary: StarSummary, time: number): Promise<void> {
    this.unloadSystem();
    this.summary = summary;
    this.def = generateSystem(summary);
    this.system = new StarSystem(this.def);
    this.time = time;
    this.system.update(time);
    this.star = new StarMesh(this.def.star, this.renderer.noise3D);
    this.worldRoot.add(this.star.group);
    for (const b of this.system.bodies) {
      const db = new DistantBody(b.def, this.renderer.noise3D);
      this.bodies.set(b.id, db);
      this.worldRoot.add(db.group);
      if (b.def.gen) {
        const key = this.bodyKey(b.id);
        void this.pool.initBody(key, b.def.gen).then(() =>
          this.pool.run({ type: 'bake', bodyId: key, width: 512, height: 256 }, 50).then((r) => {
            const bake = (r as unknown as { bake: BakeResult }).bake;
            this.bakes.set(b.id, bake);
            this.bodies.get(b.id)?.setBake(bake);
          }),
        ).catch((e) => console.warn('bake failed', e));
      }
    }
    this.sky.setNeighbours(summary.pos, this.galaxy.starsNear(summary.pos, 90), summary.id);
    // orbital station around a giant (or the first rocky world)
    const rng = new Rng(hash32(this.def.seed, 4040));
    if (this.def.hasStation) {
      const host = this.system.bodies.find((b) => b.def.type === 'gas_giant') ?? this.system.bodies.find((b) => b.landable && b.def.kind === 'planet') ?? null;
      if (host) {
        this.stationHost = host;
        this.stationOrbit = { r: host.radius * (host.def.type === 'gas_giant' ? 2.25 : 2.8), period: 1400, phase: rng.range(0, Math.PI * 2) };
        this.station = new StationModel();
        this.worldRoot.add(this.station.group);
      }
    }
    // asteroid belt between two orbits
    if (rng.chance(summary.isStart ? 1 : 0.55)) {
      const planets = this.def.bodies.filter((b) => b.kind === 'planet').map((b) => b.orbit.radius).sort((a, b) => a - b);
      const idx = Math.min(planets.length - 2, Math.max(0, Math.floor(planets.length / 2)));
      const r = planets.length >= 2 ? (planets[idx] + planets[idx + 1]) / 2 : 2 * AU_GAME;
      this.belt = new AsteroidBelt(this.def.seed, r, r * 0.12);
      this.worldRoot.add(this.belt.group);
    }
  }

  /** Station position/orientation in system frame at the current time. */
  private updateStation(): void {
    if (!this.station || !this.stationHost) return;
    const o = this.stationOrbit;
    const a = o.phase + (this.time / o.period) * Math.PI * 2;
    const h = this.stationHost;
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.15);
    this.stationPos.set(Math.cos(a) * o.r, 0, -Math.sin(a) * o.r).applyQuaternion(tilt).add(h.pos);
    // dock faces along the orbit (prograde)
    const prograde = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)).applyQuaternion(tilt);
    const up = this.stationPos.clone().sub(h.pos).normalize();
    this.stationQuat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), prograde, up));
  }

  /** Dock point in system frame. */
  stationDockSys(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(StationModel.DOCK).applyQuaternion(this.stationQuat).add(this.stationPos);
  }

  unloadSystem(): void {
    this.focus?.dispose();
    this.focus = null;
    for (const b of this.bodies.values()) { b.group.removeFromParent(); b.dispose(); }
    this.bodies.clear();
    this.bakes.clear();
    if (this.station) { this.station.group.removeFromParent(); this.station = null; this.stationHost = null; }
    if (this.belt) { this.belt.group.removeFromParent(); this.belt.dispose(); this.belt = null; }
    if (this.star) { this.star.group.removeFromParent(); this.star.dispose(); this.star = null; }
    this.frame = null;
  }

  editsFor(key: string): Map<string, Uint8Array> {
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    return e;
  }

  // ------------------------------------------------------------------ focus

  /** Pick the landable body to render with full LOD detail. */
  updateFocus(observerSys: THREE.Vector3): void {
    let best: BodyState | null = null, bestScore = 30;
    for (const b of this.system.bodies) {
      if (!b.def.gen) continue;
      const s = (b.pos.distanceTo(observerSys) - b.radius) / b.radius;
      if (s < bestScore) { bestScore = s; best = b; }
    }
    if (this.frame && this.frame.def.gen) best = this.frame;
    if ((best?.id ?? null) === (this.focus?.body.id ?? null)) return;
    if (this.focus) {
      this.bodies.get(this.focus.body.id)?.setSurfaceVisible(true);
      this.focus.dispose();
      this.focus = null;
    }
    if (best) {
      const key = this.bodyKey(best.id);
      void this.pool.initBody(key, best.def.gen!);
      this.focus = new FocusPlanet(best, key, this.pool, this.lodMat);
      this.worldRoot.add(this.focus.root);
      const g = best.def.gen!;
      this.terrainUniforms.uBioTint.value.set(...g.bioTint);
      this.terrainUniforms.uRockTint.value.set(...g.rockTint);
      this.lodUniforms.uPlanetR.value = best.radius;
    }
  }

  /** Create/destroy the voxel layer depending on the observer's altitude. */
  async updateVoxels(observerLocal: THREE.Vector3 | null, radiusChunks: number): Promise<void> {
    const f = this.focus;
    if (!f) return;
    const wantVoxels = !!observerLocal && this.frame === f.body && observerLocal.length() - f.body.radius < 2400;
    if (wantVoxels && !f.voxels && !this.creatingVoxels && this.matOpaque) {
      this.creatingVoxels = true;
      try {
        await this.pool.initBody(f.key, f.body.def.gen!);
        let edits = this.edits.get(f.key);
        if (!edits && this.editLoader) {
          edits = await this.editLoader(f.key);
          this.edits.set(f.key, edits);
        }
        if (this.focus === f && !f.voxels) {
          f.voxels = new VoxelWorld(f.key, f.body.def.gen!, this.pool, this.editsFor(f.key), this.matOpaque, this.matTrans, this.matSmooth);
          f.physics = new VoxelPhysics(f.voxels);
          f.root.add(f.voxels.group);
        }
      } finally {
        this.creatingVoxels = false;
      }
    } else if (!wantVoxels && f.voxels && (!observerLocal || observerLocal.length() - f.body.radius > 3200)) {
      f.voxels.dispose();
      f.voxels = null;
      f.physics = null;
      this.lodUniforms.uDiscardR.value = 0;
    }
    if (f.voxels && observerLocal) {
      f.voxels.update(observerLocal, radiusChunks);
      this.lodUniforms.uDiscardDir.value.copy(observerLocal).normalize();
      this.lodUniforms.uDiscardR.value = f.voxels.coverRadius;
    }
  }

  // ------------------------------------------------------------------ per-frame placement & lighting

  /**
   * @param camPos camera position in active frame
   * @param camQuat camera orientation in active frame
   * @param shadowCenter frame position the shadow map should cover
   */
  place(camPos: THREE.Vector3, camQuat: THREE.Quaternion, shadowCenter: THREE.Vector3, dt: number): void {
    const sys = this.system;
    const frame = this.frame;
    const cam = this.renderer.camera;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(camQuat);
    cam.updateMatrixWorld();
    // frame root: objects simulated in the active frame
    this.frameRoot.position.copy(camPos).negate();
    this.frameRoot.updateMatrixWorld();
    // observer in system frame
    const camSys = sys.posToSystem(frame, camPos, new THREE.Vector3());
    // star
    const starFrame = sys.posFromSystem(frame, new THREE.Vector3(), new THREE.Vector3());
    const starRender = starFrame.clone().sub(camPos);
    if (this.star) {
      this.star.group.position.copy(starRender);
      this.star.update(this.time, starRender.length());
    }
    // the corona billboard is a vacuum effect; inside an atmosphere Mie scattering takes over
    if (this.star && this.focus && this.focus.body === frame && frame.def.atmosphere) {
      const alt = camPos.length() - frame.radius;
      this.star.setGlow(THREE.MathUtils.clamp(alt / frame.def.atmosphere.height, 0, 1));
    } else this.star?.setGlow(1);
    this.sunDir.copy(starRender).normalize();
    // irradiance from inverse-square law, softened for gameplay
    const dAU = camSys.length() / AU_GAME;
    const L = this.def.star.luminosity;
    const E = THREE.MathUtils.clamp(6 * L / Math.max(0.05, dAU * dAU), 1.8, 26);
    const sc = this.def.star.color;
    this.sunIrradiance.set(sc[0] * E, sc[1] * E, sc[2] * E);
    // eclipses by other bodies
    this.eclipse = 1;
    for (const b of sys.bodies) {
      const toB = b.pos.clone().sub(camSys);
      const toS = camSys.clone().negate();
      const dS = toS.length();
      const along = toB.dot(toS) / dS;
      if (along <= 0 || along > dS) continue;
      if (frame && b === frame) continue; // own planet handled by terminator/atmosphere
      const perp = Math.sqrt(Math.max(0, toB.lengthSq() - along * along));
      const angB = b.radius / along, angSep = perp / along, angS = this.def.star.radius / dS;
      if (angSep < angB + angS) this.eclipse = Math.min(this.eclipse, THREE.MathUtils.clamp((angSep - (angB - angS)) / (2 * angS), 0, 1));
    }
    // bodies
    const q = new THREE.Quaternion();
    for (const b of sys.bodies) {
      const db = this.bodies.get(b.id)!;
      const pf = sys.posFromSystem(frame, b.pos, new THREE.Vector3());
      db.group.position.copy(pf).sub(camPos);
      sys.frameRotation(b, frame, q);
      db.group.quaternion.copy(q);
      const sd = starFrame.clone().sub(pf).normalize();
      db.update(this.time, sd, this.sunIrradiance);
    }
    // station & belt
    this.updateStation();
    if (this.station) {
      const sp = sys.posFromSystem(frame, this.stationPos, new THREE.Vector3());
      this.station.group.position.copy(sp).sub(camPos);
      sys.quatFromSystem(frame, this.stationQuat, this.station.group.quaternion);
      this.station.update(this.time);
      this.station.group.visible = sp.distanceTo(camPos) < 400000;
    }
    if (this.belt) {
      this.belt.group.position.copy(starFrame).sub(camPos);
      sys.frameRotation(null, frame, this.belt.group.quaternion);
      this.belt.update(this.time);
    }
    // sky orientation
    sys.frameRotation(null, frame, q);
    this.sky.setRotation(q, this.renderer.scale);
    // focus planet
    const f = this.focus;
    let planetFX: PlanetFX | null = null;
    this.sunAtObserver.copy(this.sunIrradiance).multiplyScalar(this.eclipse);
    this.ambient.set(0.01, 0.012, 0.016).multiplyScalar(this.eclipse * 0.5 + 0.5);
    let observerLocal: THREE.Vector3 | null = null;
    if (f) {
      const db = this.bodies.get(f.body.id)!;
      f.root.position.copy(db.group.position);
      f.root.quaternion.copy(db.group.quaternion);
      f.root.updateMatrixWorld();
      const rootInv = f.root.matrixWorld.clone().invert();
      this.terrainUniforms.uRenderToPlanet.value.copy(rootInv);
      observerLocal = new THREE.Vector3(0, 0, 0).applyMatrix4(rootInv);
      f.lod.coverRadius = f.voxels && this.frame === f.body ? this.lodUniforms.uDiscardR.value : 0;
      const lodReady = f.lod.update(observerLocal);
      db.setSurfaceVisible(!lodReady);
      f.lod.detail = this.settings.lodDetail;
      const def = f.body.def;
      const sunLocal = this.sunDir.clone().applyQuaternion(f.root.quaternion.clone().invert());
      const up = observerLocal.clone().normalize();
      this.sunElevation = sunLocal.dot(up);
      if (f.atmo) {
        // sunlight colour after passing through the atmosphere at the observer
        const T = transmittance(f.atmo, observerLocal, sunLocal, new THREE.Vector3());
        this.sunAtObserver.multiply(T);
        // ambient sky light from zenith and horizon radiance
        const zen = skyRadiance(f.atmo, observerLocal, up, sunLocal, this.sunIrradiance, new THREE.Vector3(), 6);
        const tang = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0.3, 0.8, 0.5)).normalize();
        const hor = skyRadiance(f.atmo, observerLocal, up.clone().multiplyScalar(0.15).add(tang).normalize(), sunLocal, this.sunIrradiance, new THREE.Vector3(), 6);
        this.ambient.copy(zen).multiplyScalar(0.5).addScaledVector(hor, 0.5).multiplyScalar(Math.PI * 0.9);
        this.ambient.multiplyScalar(this.eclipse * 0.7 + 0.3);
      } else {
        const lit = THREE.MathUtils.smoothstep(this.sunElevation, -0.08, 0.05);
        this.sunAtObserver.multiplyScalar(lit);
      }
      // night floor: starlight + planetshine so nights are dark but readable
      this.ambient.x += 0.006; this.ambient.y += 0.008; this.ambient.z += 0.014;
      const w = f.weather;
      w.update(dt, this.time);
      if (def.atmosphere || def.gen?.hasOcean) {
        const atm = def.atmosphere;
        const H = atm ? atm.rayleighScale : 1;
        const isOcean = !!def.gen?.hasOcean;
        const tint = def.type === 'exotic' ? new THREE.Vector3(0.05, 0.1, 0.12) : new THREE.Vector3(0.02, 0.11, 0.13);
        planetFX = {
          hasAtmo: !!atm,
          hasOcean: isOcean,
          hasClouds: !!atm && w.cur.cloud > 0.02,
          planetPos: f.root.position.clone(),
          planetRot: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(f.root.quaternion.clone().invert())),
          radius: def.radius,
          atmoTop: atm ? def.radius + atm.height : def.radius,
          betaR: atm ? new THREE.Vector3(...atm.rayleigh) : new THREE.Vector3(),
          betaM: atm ? atm.mie : 0,
          hR: H,
          hM: atm ? atm.mieScale : 1,
          mieG: atm ? atm.mieG : 0.76,
          mieColor: atm ? new THREE.Vector3(...atm.mieColor) : new THREE.Vector3(1, 1, 1),
          seaR: def.gen!.baseRadius + def.gen!.seaZ - 0.15,
          waterDeep: new THREE.Vector3(0.004, 0.02, 0.04),
          waterScatter: tint,
          waterAbsorb: new THREE.Vector3(0.32, 0.075, 0.045),
          cloudR: def.radius + (atm ? atm.rayleighScale * 3.2 : 400),
          cloudCover: w.cur.cloud,
          cloudColor: new THREE.Vector3(...(atm?.cloudColor ?? [1, 1, 1])),
          cloudScale: 1.6 * (def.radius / 3000) ** 0.3,
          wind: new THREE.Vector3(this.time * 0.0012, 0, this.time * 0.0007),
        };
        // weather darkens light under storm clouds
        const overcast = THREE.MathUtils.clamp((w.cur.cloud - 0.6) / 0.4, 0, 1);
        this.sunAtObserver.multiplyScalar(1 - overcast * 0.75);
        this.ambient.multiplyScalar(1 - overcast * 0.35);
      }
      this.renderer.fx.fogColor.set(w.cur.fogColor.r, w.cur.fogColor.g, w.cur.fogColor.b).multiply(this.ambient.clone().multiplyScalar(0.35).addScaledVector(this.sunAtObserver, 0.02));
      this.renderer.fx.fogDensity = w.cur.fog;
      this.terrainUniforms.uWetness.value = w.cur.wet;
    } else {
      this.renderer.fx.fogDensity = 0;
      this.terrainUniforms.uWetness.value = 0;
      this.sunElevation = 1;
    }
    this.renderer.planet = planetFX;
    // lighting
    const sunMax = Math.max(this.sunAtObserver.x, this.sunAtObserver.y, this.sunAtObserver.z);
    this.sun.color.setRGB(this.sunAtObserver.x / Math.max(sunMax, 1e-6), this.sunAtObserver.y / Math.max(sunMax, 1e-6), this.sunAtObserver.z / Math.max(sunMax, 1e-6));
    this.sun.intensity = sunMax;
    const sc0 = shadowCenter.clone().sub(camPos);
    // stable shadow texels: snap the shadow centre in light space
    const lightQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.sunDir);
    const ext = this.sun.shadow.camera.right;
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const shadowW = shadowCenter.clone().applyQuaternion(lightQ.clone().invert());
    shadowW.x = Math.round(shadowW.x / texel) * texel;
    shadowW.y = Math.round(shadowW.y / texel) * texel;
    shadowW.applyQuaternion(lightQ).sub(camPos);
    void sc0;
    this.sun.target.position.copy(shadowW);
    this.sun.position.copy(shadowW).addScaledVector(this.sunDir, 450);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const amb = this.ambient;
    const aMax = Math.max(amb.x, amb.y, amb.z, 1e-6);
    this.hemi.color.setRGB(amb.x / aMax, amb.y / aMax, amb.z / aMax);
    // ground bounce: sunlight reflected by the terrain fills shadows from below
    const bounce = sunMax * Math.max(0, this.sunElevation) * 0.09;
    const total = aMax * 2.0 + bounce;
    this.hemi.groundColor.setRGB(0.42 * bounce + amb.x * 0.6, 0.36 * bounce + amb.y * 0.6, 0.3 * bounce + amb.z * 0.6).multiplyScalar(1 / Math.max(total, 1e-6));
    this.hemi.intensity = total;
    this.terrainUniforms.uTime.value = this.time;
    this.renderer.fx.sunDir.copy(this.sunDir);
    this.renderer.fx.sunColor.copy(this.sunIrradiance).multiplyScalar(this.eclipse);
    this.renderer.fx.ambient.copy(this.ambient);
    // cap auto-exposure by the light actually reaching the observer (sunlit space is not "dark")
    const lum = (v: THREE.Vector3) => v.x * 0.2126 + v.y * 0.7152 + v.z * 0.0722;
    const eEff = lum(this.sunAtObserver) + lum(this.ambient) * 3 + this.localLight;
    this.renderer.maxExposure = THREE.MathUtils.clamp(2.2 / (eEff + 0.02), 0.25, 28);
    if (f) {
      const up = observerLocal!.clone().normalize().applyQuaternion(f.root.quaternion);
      this.terrainUniforms.uUpView.value.copy(up).transformDirection(cam.matrixWorldInverse);
    }
    // reflections
    this.envTimer -= dt;
    if (this.envTimer <= 0 && this.settings.reflections) {
      this.envTimer = 2.5;
      this.updateEnvironment(observerLocal);
    }
  }

  private updateEnvironment(observerLocal: THREE.Vector3 | null): void {
    const f = this.focus;
    let tex: THREE.DataTexture;
    if (f && observerLocal) {
      const inv = f.root.quaternion.clone().invert();
      const sunLocal = this.sunDir.clone().applyQuaternion(inv);
      const up = observerLocal.clone().normalize();
      // build map in render-space orientation: rotate directions by inverse frame
      const atmo = f.atmo;
      tex = skyEquirect(atmo, observerLocal, up, sunLocal, this.sunIrradiance.clone().multiplyScalar(this.eclipse), new THREE.Vector3(0.25, 0.22, 0.18));
      // equirect is in planet-local axes; rotate scene.environment accordingly
      this.renderer.scene.environmentRotation.setFromQuaternion(f.root.quaternion);
    } else {
      tex = skyEquirect(null, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), this.sunDir, this.sunIrradiance, new THREE.Vector3(0, 0, 0));
      this.renderer.scene.environmentRotation.set(0, 0, 0);
    }
    const rt = this.pmrem.fromEquirectangular(tex);
    tex.dispose();
    const old = this.envRT;
    this.envRT = rt;
    this.renderer.scene.environment = rt.texture;
    old?.dispose();
  }

  forceEnvUpdate(): void {
    this.envTimer = 0;
  }
}

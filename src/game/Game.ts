import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { Input } from '../core/input';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import { AudioEngine, type Mood } from '../audio/Audio';
import { HUD, type CompassMarker } from '../ui/HUD';
import { Universe } from './Universe';
import { Effects } from './Effects';
import { Player } from './Player';
import { Pilot, fmtDist } from './Pilot';
import { Vitals, type Environment } from '../survival/Vitals';
import { Inventory } from '../items/Inventory';
import { MachineSystem, type Machine, type MachineData } from '../building/Machines';
import { Campaign } from '../campaign/Campaign';
import { SaveSystem, SAVE_VERSION, type SaveDoc, type DiscoveryEntry } from '../save/SaveSystem';
import { WeatherParticles } from '../weather/Weather';
import { item, type MachineType } from '../items/items';
import { RECIPES, canCraft, type Recipe } from '../items/recipes';
import { B, BLOCKS } from '../voxel/blocks';
import { START_BODY_ID } from '../universe/systemGen';
import { TYPE_LABEL } from '../universe/planetTypes';
import type { BodyState, Frame } from '../universe/StarSystem';
import type { RayHit } from '../physics/VoxelPhysics';
import { ShipModel } from '../ship/ShipModel';
import { CHUNK_VOL, TerrainGenerator, type POI } from '../planet/terrain';
import { gridToPos } from '../planet/cubesphere';
import type { TextureSet } from '../render/textureGen';
import { Fauna } from './Fauna';
import type { UI } from '../ui/UI';

export type Mode = 'boot' | 'menu' | 'onfoot' | 'ship' | 'warp' | 'dead';

const GALAXY_SEED = 1337;
const SLOT = 'slot1';

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly settings: Settings;
  readonly renderer: Renderer;
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly hud: HUD;
  ui!: UI;
  readonly save = new SaveSystem();
  readonly universe: Universe;
  readonly effects = new Effects();
  player!: Player;
  pilot!: Pilot;
  fauna!: Fauna;
  readonly vitals = new Vitals();
  readonly inventory = new Inventory(36);
  readonly machines = new MachineSystem();
  readonly campaign = new Campaign();
  readonly weatherFx = new WeatherParticles();
  mode: Mode = 'boot';
  hotbar = 0;
  navTarget: string | null = null;
  jumpTarget: string | null = null;
  names: Record<string, string> = {};
  discoveries: DiscoveryEntry[] = [];
  visitedSystems: string[] = [];
  stats: Record<string, number> = {};
  uiOpen = false;
  warpState: string | null = null;
  private warpT = 0;
  private autosaveT = 60;
  private envT = 0;
  env: Environment = { breathable: 0, pressure: 0, temperature: 15, radiation: 0, underwater: false, vacuum: false, pressurized: false, heatSource: 0, wind: 0, sunlight: 1 };
  private lastTime = performance.now();
  private menuT = 0;
  private alarmT = 0;
  private lamps = new Map<string, [number, number, number, number][]>();
  private lampLights: THREE.PointLight[] = [];
  private lampT = 0;
  private fpsEl: HTMLElement | null = null;
  private fpsAcc = { t: 0, n: 0, fps: 0 };
  private soiVisited = new Set<string>();
  private machineSimT = 0;
  private rechargeDemand = new Map<number, number>();
  private lastShipBody: string | null = null;
  shipFrameKnown = true;
  private envSampleT = 0;
  private radBlocks = 0;
  private heatBlocks = 0;
  private thunderQueue: number[] = [];
  textures: TextureSet | null = null;
  scans = 0;
  /** POIs revealed by the scanner / visited (ids include system+body) */
  knownPois = new Set<string>();
  lootedPois = new Set<string>();
  private nearPois: { poi: POI; pos: THREE.Vector3; key: string }[] = [];
  private poiT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.settings = loadSettings();
    this.renderer = new Renderer(canvas, this.settings.graphics);
    this.input = new Input(canvas);
    this.hud = new HUD();
    this.universe = new Universe(this.renderer, GALAXY_SEED, this.settings.graphics);
    this.universe.frameRoot.add(this.effects.group);
    this.renderer.scene.add(this.weatherFx.object);
    this.universe.worldRoot.add(this.machines.group);
    this.audio.setVolumes(this.settings.audio);
    this.vitals.onDamage = (amt) => {
      if (amt > 2) { this.hud.damageFlash(amt); this.audio.hurt(); }
    };
    this.inventory.onChange = () => this.hud.updateHotbar(this.inventory, this.hotbar);
    this.campaign.onAdvance = (done, next) => {
      this.audio.ui('objective');
      this.toast(`✓ ${done.title}`, 'var(--green)');
      if (next.id === 'free') this.hud.centerMessage('Conexão restabelecida', 'Você está por conta própria agora', 4);
      void next;
    };
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffe2b8, 0, 18, 1.6);
      this.lampLights.push(l);
      this.universe.worldRoot.add(l);
    }
    window.addEventListener('resize', () => this.renderer.resize(window.innerWidth, window.innerHeight));
    this.input.onLockChange = (locked) => {
      if (!locked && (this.mode === 'onfoot' || this.mode === 'ship') && !this.uiOpen) this.ui?.openPause();
    };
    if (this.settings.showFps) this.showFps(true);
  }

  // ------------------------------------------------------------------ boot
  async boot(progress: (p: number, msg: string) => void): Promise<void> {
    progress(0.05, 'Abrindo banco de dados local…');
    await this.save.open();
    this.universe.editLoader = (key) => {
      const [systemId, bodyId] = key.split(':');
      return this.save.loadChunks(SLOT, systemId, bodyId, CHUNK_VOL);
    };
    progress(0.15, 'Sintetizando materiais PBR (rocha, gelo, metais, cristais)…');
    const res = await this.universe.pool.run({ type: 'textures', size: this.settings.graphics.textureSize }, -1000);
    this.textures = (res as unknown as { set: TextureSet }).set;
    this.universe.setTextures(this.textures);
    progress(0.45, 'Gerando galáxia e sistema estelar inicial…');
    const start = this.universe.galaxy.startStar();
    await this.universe.loadSystem(start, 0);
    this.player = new Player(this);
    this.pilot = new Pilot(this);
    this.fauna = new Fauna(this);
    progress(0.6, 'Compilando shaders…');
    this.setupMenuScene();
    // warm up: run a few frames so shaders compile and LOD roots stream in
    for (let i = 0; i < 90; i++) {
      this.updateMenu(1 / 60);
      if (i % 10 === 0) progress(0.6 + i / 300, 'Construindo planeta…');
      if (this.universe.focus?.lod.readyRoots === 6 && i > 20) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    this.renderer.gl.compile(this.renderer.scene, this.renderer.camera);
    progress(1, 'Pronto');
    this.mode = 'menu';
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ main loop
  private loop = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0.0005, (now - this.lastTime) / 1000));
    this.lastTime = now;
    try {
      if (this.mode === 'menu') this.updateMenu(dt);
      else if (this.mode !== 'boot') this.update(dt);
      this.renderer.render(dt);
    } catch (e) {
      console.error(e);
    }
    this.input.endFrame();
    if (this.fpsEl) {
      this.fpsAcc.t += dt; this.fpsAcc.n++;
      if (this.fpsAcc.t > 0.5) {
        this.fpsAcc.fps = this.fpsAcc.n / this.fpsAcc.t;
        this.fpsAcc.t = 0; this.fpsAcc.n = 0;
        const s = this.renderer.stats;
        this.fpsEl.textContent = `${this.fpsAcc.fps.toFixed(0)} FPS · ${s.drawCalls} draws · ${(s.triangles / 1000).toFixed(0)}k tris · escala ${this.renderer.scale.toFixed(2)} · fila ${this.universe.pool.queued}`;
      }
    }
    requestAnimationFrame(this.loop);
  };

  /** Advance the simulation with fixed steps without presenting frames (automated tests, tooling). */
  debugAdvance(seconds: number, step = 1 / 30): void {
    const n = Math.ceil(seconds / step);
    for (let i = 0; i < n; i++) {
      if (this.mode === 'menu') this.updateMenu(step);
      else if (this.mode !== 'boot') this.update(step);
      this.input.endFrame();
    }
  }

  showFps(on: boolean): void {
    if (on && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps';
      document.getElementById('app')!.appendChild(this.fpsEl);
    } else if (!on && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  }

  // ------------------------------------------------------------------ menu scene
  private menuCam = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  menuParams = { a: 0.42, dist: 4.4, side: 0, tx: 0, ty: 1, look: 0.62, fov: 36, shipDist: 95, shipX: 16, shipY: -9 };
  private setupMenuScene(): void {
    const u = this.universe;
    const moon = u.system.body(START_BODY_ID)!;
    u.frame = moon;
    u.updateFocus(moon.pos);
    this.pilot.ship.landed = false;
    this.pilot.ship.engineOn = true;
    this.hud.showFoot(false);
    this.hud.showShip(false);
    this.player.visible = false;
    this.player.model.rig.root.visible = false;
  }

  private updateMenu(dt: number): void {
    const u = this.universe;
    this.menuT += dt;
    u.time += dt * 4;
    u.system.update(u.time);
    const moon = u.frame!;
    const R = moon.radius;
    // slow drift on the moon's day side, framed so the ringed giant hangs beside its limb
    const giant = u.system.body(moon.def.parentId!)!;
    const giantPos = u.system.posFromSystem(moon, giant.pos, new THREE.Vector3());
    const giantLocal = giantPos.clone().normalize();
    const sunLocal = u.system.posFromSystem(moon, new THREE.Vector3(), new THREE.Vector3()).normalize();
    const perpS = sunLocal.clone().projectOnPlane(giantLocal).normalize();
    const mp = this.menuParams;
    const dist = R * mp.dist;
    let bestB = 1, bestErr = 1e9;
    for (let b = 0.2; b < 2.6; b += 0.02) {
      const P = giantLocal.clone().multiplyScalar(-Math.cos(b)).addScaledVector(perpS, Math.sin(b)).multiplyScalar(dist);
      const ang = P.clone().negate().angleTo(giantPos.clone().sub(P));
      const err = Math.abs(ang - mp.a);
      if (err < bestErr) { bestErr = err; bestB = b; }
    }
    const beta = bestB + Math.sin(this.menuT * 0.02) * 0.03;
    const orbitDir = giantLocal.clone().multiplyScalar(-Math.cos(beta)).addScaledVector(perpS, Math.sin(beta)).normalize();
    const camPos = orbitDir.clone().multiplyScalar(dist);
    const toMoon = camPos.clone().negate().normalize();
    const toGiant = giantPos.clone().sub(camPos).normalize();
    const side = new THREE.Vector3().crossVectors(toMoon, toGiant).normalize();
    const look = toMoon.clone().lerp(toGiant, mp.look).normalize();
    const camUp = side.clone().multiplyScalar(mp.ty >= 0 ? 1 : -1);
    const target = camPos.clone().add(look);
    const m = new THREE.Matrix4().lookAt(camPos, target, camUp);
    this.menuCam.pos.copy(camPos);
    this.menuCam.quat.setFromRotationMatrix(m);
    if (this.renderer.camera.fov !== mp.fov) { this.renderer.camera.fov = mp.fov; this.renderer.camera.updateProjectionMatrix(); }
    // ship cruising across the frame, placed in camera space
    const ship = this.pilot.ship;
    const cq = this.menuCam.quat;
    const cf = new THREE.Vector3(0, 0, -1).applyQuaternion(cq), cr = new THREE.Vector3(1, 0, 0).applyQuaternion(cq), cu = new THREE.Vector3(0, 1, 0).applyQuaternion(cq);
    const drift = Math.sin(this.menuT * 0.05) * 6;
    ship.pos.copy(camPos).addScaledVector(cf, mp.shipDist).addScaledVector(cr, mp.shipX + drift).addScaledVector(cu, mp.shipY);
    const heading = cr.clone().multiplyScalar(-1).addScaledVector(cf, 0.55).normalize();
    ship.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(ship.pos, ship.pos.clone().add(heading), cu));
    ship.quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0, 0.18 + Math.sin(this.menuT * 0.3) * 0.03)));
    ship.throttleVis = 0.35;
    this.pilot.updateModelTransform();
    ship.model.update(u.time, 0.35, 0, 0, false, false);
    ship.model.setCockpitVisible(false);
    u.updateFocus(u.system.posToSystem(u.frame, camPos, new THREE.Vector3()));
    u.place(camPos, this.menuCam.quat, ship.pos, dt);
    this.audio.update(dt, { wind: 0, pressure: 0, rain: 0, engine: 0, engineOn: false, inCockpit: false, roar: 0, mining: false, breathing: 0, exertion: 0, underwater: false, vacuum: true, mood: 'menu', cave: 0 });
  }

  private restoreFov(): void {
    this.renderer.camera.fov = this.settings.graphics.fov;
    this.renderer.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ new game / load
  async newGame(fullSurvival: boolean, progress: (p: number, msg: string) => void): Promise<void> {
    this.mode = 'boot';
    await this.save.deleteSlot(SLOT);
    this.universe.edits.clear();
    this.machines.load([]);
    this.names = {};
    this.discoveries = [];
    this.visitedSystems = [];
    this.stats = {};
    this.navTarget = null;
    this.jumpTarget = null;
    this.knownPois.clear();
    this.lootedPois.clear();
    this.campaign.load({});
    this.vitals.load({ health: 100, oxygen: 100, energy: 85, bodyTemp: 37, integrity: 78, radiation: 0, food: 80, water: 70, fullSurvival, upgrades: {} });
    this.inventory.load([]);
    for (const [id, n] of [['extractor', 1], ['builder', 1], ['scanner', 1], ['flashlight', 1], ['o2_canister', 2], ['battery', 1]] as const) this.inventory.add(id, n);
    const u = this.universe;
    progress(0.1, 'Calculando trajetória de reentrada…');
    if (u.def.id !== u.galaxy.startStar().id) await u.loadSystem(u.galaxy.startStar(), 0);
    const moon = u.system.body(START_BODY_ID)!;
    const { dir, time } = this.findSpawn(moon);
    u.time = time;
    u.system.update(time);
    u.frame = moon;
    u.updateFocus(moon.pos);
    const focus = u.focus!;
    const sr = focus.surfaceRadius(dir);
    const up = dir.clone();
    const tangent = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    // crashed ship: slightly tilted, nose dug in
    const ship = this.pilot.ship;
    const shipDir = dir.clone().addScaledVector(tangent, 14 / sr).normalize();
    const shipR = Math.max(focus.surfaceRadius(shipDir), sr);
    ship.pos.copy(shipDir).multiplyScalar(shipR + 1.75);
    const fwd = tangent.clone().cross(shipDir).normalize();
    ship.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(shipDir, fwd.clone().negate()).normalize(), shipDir, fwd.clone().negate()));
    ship.quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0.6, 0.1)));
    ship.vel.set(0, 0, 0);
    Object.assign(ship, { hull: 34, fuel: 42, powerOnline: false, thrustersOnline: false, engineOn: false, warpCore: false, o2Reserve: 500, energyReserve: 300, landed: true, gearDown: true, gearT: 1, cruise: false, hullTemp: 20, assist: true });
    ship.cargo.load([]);
    ship.cargo.add('rock', 12);
    this.pilot.cockpitView = true;
    // player a few metres off the port bow, looking back at the wreck
    const spot = ship.localToFrame(new THREE.Vector3(-8.5, 0, -5.5));
    const pdir = spot.clone().normalize();
    const pr = focus.surfaceRadius(pdir) + 0.05;
    this.player.placeAt(pdir.clone().multiplyScalar(pr), ship.pos.clone().sub(pdir.clone().multiplyScalar(pr)));
    this.player.firstPerson = true;
    this.player.pitch = 0.05;
    this.player.visible = true;
    this.hotbar = 0;
    progress(0.3, 'Gerando terreno local…');
    await this.waitForTerrain(this.player.pos, progress);
    // re-seat on the actual voxel surface
    this.seatOnGround(this.player.pos);
    this.mode = 'onfoot';
    this.markVisited();
    this.enterSoi(moon);
    this.hud.showFoot(true);
    this.hud.updateHotbar(this.inventory, this.hotbar);
    this.renderer.resetExposure();
    this.audio.init();
    this.restoreFov();
    this.hud.centerMessage('Pouso de emergência', 'Sistemas do traje reiniciados', 5);
    setTimeout(() => this.toast('Diagnóstico: casco 34% · energia OFFLINE · propulsor avariado', 'var(--amber)'), 2500);
    setTimeout(() => this.toast(`Atmosfera ${moon.def.atmosphere?.composition} — respirabilidade limitada`, 'var(--cyan)'), 4500);
    this.autosaveT = 20;
    await this.saveGame(true);
  }

  /** Find a calm, dry spot with the gas giant above the horizon at sunrise. */
  private findSpawn(moon: BodyState): { dir: THREE.Vector3; time: number } {
    const u = this.universe;
    const gen = new TerrainGenerator(moon.def.gen!);
    u.system.update(0);
    const giant = u.system.body(moon.def.parentId!)!;
    const giantDir = u.system.posFromSystem(moon, giant.pos, new THREE.Vector3()).normalize();
    let best: THREE.Vector3 | null = null;
    let bestScore = -1e9;
    const helper = new THREE.Vector3(0.3, 0.9, 0.2).cross(giantDir).normalize();
    for (let i = 0; i < 260; i++) {
      const ang = (i / 260) * Math.PI * 2 * 7.3;
      const tilt = 0.7 + (i % 13) * 0.045; // angle from giant direction (rad)
      const d = giantDir.clone().applyAxisAngle(helper, tilt).applyAxisAngle(giantDir, ang).normalize();
      const h = gen.heightAt(d.x, d.y, d.z);
      if (h < 6 || h > 80) continue;
      const e = 0.002;
      const h1 = gen.heightAt(d.x + e, d.y, d.z), h2 = gen.heightAt(d.x, d.y + e, d.z);
      const slope = (Math.abs(h1 - h) + Math.abs(h2 - h)) / (e * moon.radius);
      const elev = d.dot(giantDir);
      const score = -slope * 30 - Math.abs(elev - 0.55) * 20 - Math.abs(Math.abs(d.y) - 0.25) * 5 + Math.min(h, 30) * 0.05;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    const dir = best ?? giantDir.clone();
    // time of day: sun rising (elevation ~0.18 and increasing)
    const period = moon.def.rotation.period;
    let bestT = 0, bestE = 1e9;
    for (let t = 0; t < period; t += period / 400) {
      u.system.update(t);
      const sunLocal = u.system.posFromSystem(moon, new THREE.Vector3(), new THREE.Vector3()).normalize();
      u.system.update(t + 30);
      const sunLater = u.system.posFromSystem(moon, new THREE.Vector3(), new THREE.Vector3()).normalize();
      const e0 = sunLocal.dot(dir), e1 = sunLater.dot(dir);
      if (e1 <= e0) continue;
      const err = Math.abs(e0 - 0.2);
      if (err < bestE) { bestE = err; bestT = t; }
    }
    return { dir, time: bestT };
  }

  private async waitForTerrain(pos: THREE.Vector3, progress: (p: number, msg: string) => void): Promise<void> {
    const u = this.universe;
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      u.system.update(u.time);
      await u.updateVoxels(pos, Math.min(4, this.settings.graphics.renderDistance));
      const vw = u.focus?.voxels;
      const cover = vw?.coverRadius ?? 0;
      progress(0.3 + Math.min(0.65, cover / 80), `Gerando terreno local… ${vw?.meshCount ?? 0} setores`);
      if (cover > 60 && u.focus?.lod.readyRoots === 6) break;
      // keep rendering so LOD streams too
      u.place(pos.clone().addScaledVector(pos.clone().normalize(), 30), this.player.camQuat, pos, 1 / 60);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Put an entity standing on solid ground at p, nudging it out of trees/walls. */
  private seatOnGround(p: THREE.Vector3): void {
    const phys = this.universe.focus?.physics;
    if (!phys) return;
    const g = { face: 0, x: 0, y: 0, z: 0 };
    phys.toGrid(p, g);
    const free = (x: number, y: number, z: number) => !phys.boxHits(g.face, x, y, z, 0.32, 1.8);
    for (let r = 0; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const I = Math.floor(g.x) + dx, J = Math.floor(g.y) + dy;
        let k = Math.floor(g.z) + 8;
        while (k > 1 && !phys.solid(g.face, I, J, k)) k--;
        const x = I + 0.5, y = J + 0.5, z = k + 1.01;
        if (free(x, y, z)) {
          g.x = x; g.y = y; g.z = z;
          phys.fromGrid(g, p);
          return;
        }
      }
    }
  }

  async continueGame(progress: (p: number, msg: string) => void): Promise<boolean> {
    const doc = await this.save.loadDoc(SLOT);
    if (!doc) return false;
    this.mode = 'boot';
    progress(0.1, 'Restaurando registros…');
    const u = this.universe;
    const summary = u.galaxy.byId(doc.systemId) ?? u.galaxy.startStar();
    u.edits.clear();
    await u.loadSystem(summary, doc.time);
    u.time = doc.time;
    u.system.update(doc.time);
    u.frame = doc.frameBodyId ? u.system.body(doc.frameBodyId) ?? null : null;
    this.vitals.load(doc.vitals);
    this.inventory.load(doc.inventory);
    this.hotbar = doc.hotbarIndex ?? 0;
    this.pilot.ship.load(doc.ship);
    this.campaign.load(doc.campaign);
    this.discoveries = doc.discoveries ?? [];
    this.names = doc.names ?? {};
    this.visitedSystems = doc.visitedSystems ?? [];
    this.machines.load((doc.machines ?? []) as MachineData[]);
    this.stats = doc.stats ?? {};
    this.navTarget = doc.navTarget ?? null;
    this.jumpTarget = doc.jumpTarget ?? null;
    this.knownPois = new Set(doc.pois ?? []);
    this.lootedPois = new Set(doc.looted ?? []);
    this.player.model.setColors(doc.suit);
    this.suit = { ...doc.suit };
    const p = doc.player;
    this.player.pos.fromArray(p.pos);
    this.player.vel.fromArray(p.vel);
    this.player.forward.fromArray(p.forward);
    this.player.up.copy(this.player.pos).normalize();
    this.player.pitch = p.pitch;
    for (const d of this.discoveries) if (d.kind === 'body') this.soiVisited.add(d.id);
    this.mode = doc.mode;
    const obs = this.mode === 'ship' ? this.pilot.ship.pos : this.player.pos;
    u.updateFocus(u.system.posToSystem(u.frame, obs, new THREE.Vector3()));
    if (u.frame && u.focus?.body === u.frame) {
      progress(0.3, 'Gerando terreno local…');
      await this.waitForTerrain(obs, progress);
    }
    this.machines.attach(u.focus?.voxels ?? null, u.focus?.physics ?? null);
    if (this.mode === 'ship') {
      this.player.visible = false;
      this.hud.showShip(true);
    } else {
      this.player.visible = true;
      this.hud.showFoot(true);
    }
    this.hud.updateHotbar(this.inventory, this.hotbar);
    this.renderer.resetExposure();
    this.audio.init();
    this.restoreFov();
    this.toast('Progresso restaurado', 'var(--green)');
    return true;
  }

  suit = { primary: '#e9e7e2', secondary: '#3b3f45', accent: '#ea7a2c', visor: '#16130e' };

  async saveGame(silent = false): Promise<void> {
    if (this.mode !== 'onfoot' && this.mode !== 'ship') return;
    const u = this.universe;
    const doc: SaveDoc = {
      version: SAVE_VERSION, slot: SLOT, updated: Date.now(), galaxySeed: GALAXY_SEED, time: u.time, systemId: u.def.id,
      frameBodyId: u.frame?.id ?? null, mode: this.mode === 'ship' ? 'ship' : 'onfoot', player: this.player.serialize(),
      vitals: this.vitals.serialize(), inventory: this.inventory.serialize(), hotbarIndex: this.hotbar, ship: this.pilot.ship.serialize(),
      shipFrameBodyId: u.frame?.id ?? null, campaign: this.campaign.serialize(), discoveries: this.discoveries, names: this.names,
      visitedSystems: this.visitedSystems, machines: this.machines.allData, suit: this.suit, stats: this.stats, navTarget: this.navTarget, jumpTarget: this.jumpTarget,
      pois: [...this.knownPois], looted: [...this.lootedPois],
    };
    try {
      await this.save.saveDoc(doc);
      for (const key of u.dirtyEdits) {
        const [systemId, bodyId] = key.split(':');
        const e = u.edits.get(key);
        if (e) await this.save.saveChunks(SLOT, systemId, bodyId, e);
      }
      u.dirtyEdits.clear();
      if (!silent) this.toast('Jogo salvo', 'var(--green)');
    } catch (e) {
      console.error(e);
      this.toast('Falha ao salvar', 'var(--red)');
    }
  }

  // ------------------------------------------------------------------ frames
  private switchFrame(next: Frame): void {
    const u = this.universe;
    const sys = u.system;
    const old = u.frame;
    if (old === next) return;
    const rot = sys.frameRotation(old, next, new THREE.Quaternion());
    const conv = (p: THREE.Vector3, v: THREE.Vector3, q?: THREE.Quaternion) => {
      const pSys = sys.posToSystem(old, p, new THREE.Vector3());
      const vSys = sys.velToSystem(old, p, v, new THREE.Vector3());
      p.copy(sys.posFromSystem(next, pSys, new THREE.Vector3()));
      v.copy(sys.velFromSystem(next, pSys, vSys, new THREE.Vector3()));
      if (q) {
        const qs = sys.quatToSystem(old, q, new THREE.Quaternion());
        q.copy(sys.quatFromSystem(next, qs, new THREE.Quaternion()));
      }
    };
    const ship = this.pilot.ship;
    conv(ship.pos, ship.vel, ship.quat);
    if (ship.cruise) ship.cruiseSpeed = ship.vel.length();
    conv(this.player.pos, this.player.vel);
    this.player.forward.applyQuaternion(rot);
    this.player.up.applyQuaternion(rot);
    this.effects.transform((p) => p.copy(sys.posBetween(old, next, p, new THREE.Vector3())), rot);
    u.frame = next;
    if (next) this.enterSoi(next);
  }

  private enterSoi(b: BodyState): void {
    if (this.soiVisited.has(b.id)) return;
    this.soiVisited.add(b.id);
    if (this.discoveries.some((d) => d.id === b.id && d.systemId === this.universe.def.id)) return;
    const def = b.def;
    this.discover({ id: b.id, kind: 'body', title: `${def.name} — ${TYPE_LABEL[def.type]}`, text: `${def.description} Recursos: ${def.resources.slice(0, 6).join(', ')}.`, time: Date.now(), systemId: this.universe.def.id });
    if (this.mode !== 'boot' && this.mode !== 'menu') this.hud.centerMessage(this.displayName(b.id), `${TYPE_LABEL[def.type]} · gravidade ${def.gravity.toFixed(1)} m/s²`, 4);
  }

  private markVisited(): void {
    const id = this.universe.def.id;
    if (!this.visitedSystems.includes(id)) {
      this.visitedSystems.push(id);
      const s = this.universe.def;
      this.discover({ id, kind: 'system', title: `Sistema ${s.name}`, text: `${s.star.label} (${s.star.spectral}), ${Math.round(s.star.temperature)} K, luminosidade ${s.star.luminosity.toFixed(2)}. ${s.bodies.length} corpos catalogados.`, time: Date.now(), systemId: id });
    }
  }

  discover(e: DiscoveryEntry): void {
    if (this.discoveries.some((d) => d.id === e.id && d.kind === e.kind && d.systemId === e.systemId)) return;
    this.discoveries.unshift(e);
    if (this.mode === 'onfoot' || this.mode === 'ship') {
      this.audio.ui('discovery');
      this.toast(`Nova descoberta: ${e.title}`, 'var(--amber)');
    }
  }

  displayName(bodyId: string): string {
    const key = `${this.universe.def.id}:${bodyId}`;
    return this.names[key] ?? this.universe.system.body(bodyId)?.def.name ?? bodyId;
  }

  rename(key: string, name: string): void {
    const n = name.trim().slice(0, 32);
    if (n) this.names[key] = n; else delete this.names[key];
  }

  // ------------------------------------------------------------------ game update
  private update(dt: number): void {
    const u = this.universe;
    const input = this.input;
    if (this.mode === 'dead') {
      u.time += dt;
      u.system.update(u.time);
      this.renderer.fx.fade = Math.min(0.85, this.renderer.fx.fade + dt * 0.5);
      u.place(this.player.camPos, this.player.camQuat, this.player.pos, dt);
      return;
    }
    if (this.mode === 'warp') { this.updateWarp(dt); return; }
    u.time += dt;
    u.system.update(u.time);
    const controls = !this.uiOpen && input.locked;
    if (!this.uiOpen && !input.locked && input.mouseHit(0)) input.lock();
    // global keys
    if (controls) {
      if (input.hit('Tab')) { this.openPanel('inventory'); return; }
      if (input.hit('KeyM')) { this.openPanel('system'); return; }
      if (input.hit('KeyG')) { this.openPanel('galaxy'); return; }
      if (input.hit('KeyJ') && this.mode === 'onfoot') { this.openPanel('journal'); return; }
      if (input.hit('F1')) { this.openPanel('controls'); return; }
    }
    if (input.hit('F3')) { this.settings.showFps = !this.settings.showFps; this.showFps(this.settings.showFps); saveSettings(this.settings); }

    // ---------------------------------------------------- reference frame
    const ship = this.pilot.ship;
    const ctlPos = this.mode === 'ship' ? ship.pos : this.player.pos;
    const ctlSys = u.system.posToSystem(u.frame, ctlPos, new THREE.Vector3());
    const soi = u.system.soiBodyAt(ctlSys, u.frame);
    if (soi !== u.frame) this.switchFrame(soi);
    u.updateFocus(u.system.posToSystem(u.frame, ctlPos, new THREE.Vector3()));

    // ---------------------------------------------------- entities
    if (this.mode === 'ship') {
      this.pilot.update(dt, controls);
      this.player.pos.copy(ship.localToFrame(ShipModel.EYE));
      this.player.vel.copy(ship.vel);
      this.player.visible = false;
      this.pilot.updateCamera(dt);
    } else {
      this.pilot.update(dt, false);
      this.player.update(dt, controls);
    }
    if (this.vitals.dead) { this.die(); return; }

    // ---------------------------------------------------- voxel streaming
    const focus = u.focus;
    const obsLocal = focus && focus.body === u.frame ? (this.mode === 'ship' ? ship.pos.clone() : this.player.pos.clone()) : null;
    void u.updateVoxels(obsLocal, this.settings.graphics.renderDistance);
    if ((focus?.voxels ?? null) !== (this.machines.bodyId ? this.attachedWorld : null)) this.attachMachines();

    // ---------------------------------------------------- survival
    this.updateEnvironment(dt);
    const act = {
      sprinting: this.mode === 'onfoot' && input.down('ShiftLeft') && input.down('KeyW'),
      mining: this.player.mining, jetpack: this.player.jetpacking, flashlight: this.player.flashlightOn, inShip: this.mode === 'ship', dt,
    };
    this.vitals.update(this.env, act);
    if (this.mode === 'ship' && ship.powerOnline) {
      // ship life support tops up the suit
      const needO2 = this.vitals.oxygenMax - this.vitals.oxygen;
      const o2 = Math.min(needO2, 6 * dt, ship.o2Reserve);
      ship.o2Reserve -= o2;
      this.vitals.oxygen += o2;
      const needE = this.vitals.energyMax - this.vitals.energy;
      const e = Math.min(needE, 5 * dt);
      this.vitals.energy += e;
    }
    this.alarmT -= dt;
    if (this.vitals.warnings.length && this.alarmT <= 0 && (this.vitals.oxygen <= 0 || this.vitals.health < 30)) { this.audio.alarm(); this.alarmT = 2; }

    // ---------------------------------------------------- machines & lamps
    this.machineSimT += dt;
    if (this.machineSimT > 0.25) {
      const isNight = u.sunElevation < 0.02;
      this.machines.simulate(this.machineSimT, (p) => this.sunlightAt(p), isNight, this.player.pos, u.time, this.rechargeDemand);
      this.rechargeDemand.clear();
      this.machineSimT = 0;
    }
    this.updateLamps(dt);
    this.fauna.update(dt);
    this.updatePois(dt);

    // ---------------------------------------------------- campaign
    this.campaign.update({
      moved: this.player.moved, scans: this.scans, count: (id) => this.inventory.count(id) + (id === 'iron' ? this.inventory.count('plate') * 2 : 0),
      fabricatorPlaced: this.machines.allData.some((m) => m.type === 'fabricator'),
      shipHull: ship.hull, shipPower: ship.powerOnline, shipThrusters: ship.thrustersOnline, engineOn: ship.engineOn, inShip: this.mode === 'ship',
      altitudeAboveAtmo: u.frame ? this.pilot.altitude - (u.frame.def.atmosphere?.height ?? 0) - 150 : 1,
      navTargetOther: !!this.navTarget && this.navTarget !== START_BODY_ID,
      landedBodyId: this.lastShipBody, startBodyId: START_BODY_ID, mined: this.stats.mined ?? 0, warpJumps: this.stats.jumps ?? 0,
    });

    // ---------------------------------------------------- camera & render placement
    const camPos = this.mode === 'ship' ? this.pilot.camPos : this.player.camPos;
    const camQuat = this.mode === 'ship' ? this.pilot.camQuat : this.player.camQuat;
    const shadowCenter = this.mode === 'ship' && !this.pilot.cockpitView ? ship.pos : this.mode === 'ship' ? ship.pos : this.player.pos;
    this.effects.gravityCenter = u.frame ? new THREE.Vector3(0, 0, 0) : null;
    this.effects.gravity = u.frame ? u.frame.def.gravity : 0;
    this.effects.update(dt);
    u.place(camPos, camQuat, shadowCenter, dt);
    // scanner pulse
    const tu = u.terrainUniforms;
    if (this.player.scanT >= 0) {
      tu.uScanCenter.value.copy(this.player.pos).sub(camPos);
      tu.uScanRadius.value = this.player.scanT * 26;
      tu.uScanStrength.value = Math.max(0, 1 - this.player.scanT / 3.2) * 1.0 + (this.player.scanT < 3 ? 0.4 : 0);
    } else tu.uScanStrength.value = 0;
    this.updateTargetBox(camPos);
    this.updateWeatherFx(camPos, dt);
    this.updateFx(dt);
    this.updateAudio(dt);
    this.updateHud(dt);
    // autosave
    this.autosaveT -= dt;
    if (this.autosaveT <= 0) {
      this.autosaveT = 75;
      void this.saveGame(true);
    }
  }

  private attachedWorld: unknown = null;
  private attachMachines(): void {
    const f = this.universe.focus;
    this.attachedWorld = f?.voxels ?? null;
    this.machines.attach(f?.voxels ?? null, f?.physics ?? null);
    // machine meshes live in planet-local space under the focus root
    if (f) f.root.add(this.machines.group); else this.machines.group.removeFromParent();
    const key = f?.key ?? '';
    for (const [k, l] of this.lamps) if (k !== key) void l;
  }

  private sunlightAt(p: THREE.Vector3): number {
    const u = this.universe;
    const f = u.focus;
    if (!f) return 0;
    const sunLocal = u.sunDir.clone().applyQuaternion(f.root.quaternion.clone().invert());
    const elev = sunLocal.dot(p.clone().normalize());
    const atm = f.body.def.atmosphere;
    const thin = atm ? Math.exp(-0.15 / Math.max(0.05, elev)) : 1;
    const cloud = 1 - f.weather.cur.cloud * 0.6;
    const E = u.sunIrradiance.length() / Math.sqrt(3) / 6;
    return Math.max(0, elev) > 0 ? Math.min(1.6, Math.max(0, elev) * thin * cloud * E * u.eclipse * 1.4) : 0;
  }

  // ------------------------------------------------------------------ environment
  private updateEnvironment(dt: number): void {
    const u = this.universe;
    const frame = u.frame;
    const env = this.env;
    const pos = this.mode === 'ship' ? this.pilot.ship.pos : this.player.pos;
    if (!frame) {
      Object.assign(env, { breathable: 0, pressure: 0, temperature: -150 + 200 * Math.min(1, u.sunIrradiance.x / 10), radiation: 0.35, underwater: false, vacuum: true, pressurized: false, heatSource: 0, wind: 0, sunlight: 1 });
      return;
    }
    const def = frame.def;
    const r = pos.length();
    const alt = r - def.radius;
    const atm = def.atmosphere;
    const p = atm && alt < atm.height ? atm.pressure * Math.exp(-Math.max(0, alt) / (atm.rayleighScale * 1.8)) : 0;
    env.pressure = p;
    env.vacuum = p < 0.02;
    env.breathable = atm ? atm.breathable * Math.min(1, p / Math.max(0.01, atm.pressure)) : 0;
    env.underwater = this.player.underwater && this.mode === 'onfoot';
    // temperature: base, day/night swing (bigger without atmosphere), altitude, biome, weather
    const sunE = u.sunElevation;
    const swing = atm ? 9 + 18 * (1 - Math.min(1, atm.pressure)) : 140;
    let T = def.temperature + swing * Math.max(-0.8, Math.min(1, sunE * 1.6)) - Math.max(0, alt) * 0.012 * (atm ? 1 : 0);
    if (u.focus && u.focus.body === frame) T += u.focus.weather.cur.tempDelta;
    env.wind = u.focus ? u.focus.weather.cur.wind * (atm ? 1 : 0) : 0;
    env.sunlight = Math.max(0, sunE);
    // local sources: sample voxels around the player every 0.5 s
    this.envSampleT -= dt;
    if (this.envSampleT <= 0 && this.mode === 'onfoot') {
      this.envSampleT = 0.5;
      this.sampleLocalSources();
    }
    env.heatSource = this.heatBlocks * 25;
    env.radiation = def.radiation * (atm ? 1 : Math.max(0, sunE) + 0.2) + this.radBlocks * 0.05;
    // habitat pressurisation
    env.pressurized = false;
    const phys = u.focus?.physics;
    if (this.mode === 'onfoot' && phys) {
      const gp = { face: 0, x: 0, y: 0, z: 0 };
      phys.toGrid(this.player.pos.clone().addScaledVector(this.player.up, 0.5), gp);
      env.pressurized = this.machines.isPressurized(gp.face, Math.floor(gp.x), Math.floor(gp.y), Math.floor(gp.z), u.time);
      if (env.pressurized) {
        T = 21;
        const o2 = this.machines.nearest(this.player.pos, 'oxygen', 60);
        if (o2 && o2.powered && this.vitals.oxygen < this.vitals.oxygenMax) {
          const got = this.machines.draw(o2, 1.5 * dt);
          this.rechargeDemand.set(o2.grid, (this.rechargeDemand.get(o2.grid) ?? 0) + 1.5);
          this.vitals.oxygen = Math.min(this.vitals.oxygenMax, this.vitals.oxygen + got * 4 + 2 * dt);
        }
      }
    }
    env.temperature = T;
  }

  private sampleLocalSources(): void {
    const phys = this.universe.focus?.physics;
    this.radBlocks = 0;
    this.heatBlocks = 0;
    if (!phys) return;
    const g = { face: 0, x: 0, y: 0, z: 0 };
    phys.toGrid(this.player.pos, g);
    const I = Math.floor(g.x), J = Math.floor(g.y), K = Math.floor(g.z);
    for (let k = -2; k <= 3; k++) for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const b = phys.world.getLoaded(g.face, I + i, J + j, K + k);
      if (b === B.RADITE) this.radBlocks += 1 / (1 + i * i + j * j + k * k);
      if (b === B.LAVA && Math.abs(i) <= 1 && Math.abs(j) <= 1 && k >= -1 && k <= 0) this.heatBlocks += 10;
      else if (b === B.LAVA) this.heatBlocks += 0.15;
    }
    this.radBlocks *= 6;
  }

  // ------------------------------------------------------------------ interactions (called by Player)
  selectHotbar(i: number): void {
    if (this.hotbar === i) return;
    this.hotbar = i;
    this.audio.ui('hover');
    this.hud.updateHotbar(this.inventory, this.hotbar);
  }

  breakBlock(t: RayHit): void {
    const phys = this.universe.focus?.physics;
    if (!phys) return;
    const def = BLOCKS[t.block];
    phys.world.setBlock(t.face, t.I, t.J, t.K, B.AIR);
    this.universe.dirtyEdits.add(phys.world.bodyId);
    const center = phys.cellCenter(t.face, t.I, t.J, t.K);
    const col = this.player.blockColor(t.block);
    this.effects.burstDebris(center, center.clone().normalize(), col, 10);
    this.effects.sparksAt(center, center.clone().normalize(), col.clone().multiplyScalar(0.5), 14, 2, 0.4, 0.12, 0.9, 2.5);
    this.audio.blockBreak(def.sound);
    this.stats.mined = (this.stats.mined ?? 0) + 1;
    if (t.block === B.LAMP) this.unregisterLamp(t.face, t.I, t.J, t.K);
    if (def.drop) {
      const n = def.dropCount * (this.vitals.upgrades.extractorMk2 && def.ore ? 2 : 1);
      const left = this.inventory.add(def.drop, n);
      if (left < n) {
        this.audio.ui('pickup');
        this.toast(`+${n - left} ${item(def.drop).name}`);
      }
      if (left > 0) this.toast('Inventário cheio', 'var(--red)');
      if (def.ore) {
        const d = item(def.drop);
        this.discover({ id: def.drop, kind: 'resource', title: `Recurso: ${d.name}`, text: d.desc, time: Date.now(), systemId: this.universe.def.id });
      }
    }
  }

  onScan(): void {
    this.scans++;
    const phys = this.universe.focus?.physics;
    if (!phys) { this.toast('Scanner: nenhum terreno ao alcance'); return; }
    const g = { face: 0, x: 0, y: 0, z: 0 };
    phys.toGrid(this.player.pos, g);
    const I = Math.floor(g.x), J = Math.floor(g.y), K = Math.floor(g.z);
    const counts = new Map<number, number>();
    const R = 14;
    for (let k = -R; k <= 6; k++) for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j + k * k > R * R) continue;
      const b = phys.world.getLoaded(g.face, I + i, J + j, K + k);
      if (b !== B.UNKNOWN && BLOCKS[b].ore) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let revealed = 0;
    for (const n of this.nearPois) {
      if (this.knownPois.has(n.key)) continue;
      if (n.pos.distanceTo(this.player.pos) < 650) { this.knownPois.add(n.key); revealed++; }
    }
    if (revealed) { this.toast(`Sinal desconhecido detectado (${revealed}) — veja a bússola`, 'var(--amber)'); this.audio.ui('discovery'); }
    const f = this.universe.focus!;
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([b, n]) => `${BLOCKS[b].name} ×${n}`);
    this.toast(parts.length ? `Pulso: ${parts.join(' · ')}` : 'Pulso: nenhum minério num raio de 14 m', 'var(--cyan)');
    const atm = f.body.def.atmosphere;
    this.toast(`${this.displayName(f.body.id)} · ${Math.round(this.env.temperature)}°C · ${atm ? `${this.env.pressure.toFixed(2)} atm` : 'vácuo'} · rad ${this.env.radiation.toFixed(2)}`, 'var(--dim)');
  }

  useMachine(m: Machine): void {
    const grid = this.machines.gridOf(m);
    switch (m.type) {
      case 'door': this.machines.toggleDoor(m); this.audio.place(); break;
      case 'storage': this.ui.openStorage(m); break;
      case 'fabricator': this.openPanel('craft'); break;
      case 'recharger': {
        if (!m.powered) { this.toast('Estação sem energia — instale painéis solares e baterias', 'var(--red)'); this.audio.ui('error'); break; }
        const needE = this.vitals.energyMax - this.vitals.energy;
        const got = this.machines.draw(m, needE * 0.5);
        this.vitals.energy = Math.min(this.vitals.energyMax, this.vitals.energy + got * 2);
        if (grid.o2) this.vitals.oxygen = Math.min(this.vitals.oxygenMax, this.vitals.oxygen + Math.min(this.vitals.oxygenMax, got * 3));
        this.toast(`Recarga: +${Math.round(got * 2)} energia${grid.o2 ? ' · O₂ reabastecido' : ''}`, 'var(--cyan)');
        this.audio.ui('craft');
        break;
      }
      default: {
        const status = `${item('m_' + m.type).name}: ${m.powered ? 'operando' : 'sem energia'} · rede ${Math.round(grid.stored)}/${grid.capacity} · saldo ${grid.net >= 0 ? '+' : ''}${grid.net.toFixed(1)}/s`;
        this.toast(status, m.powered ? 'var(--green)' : 'var(--amber)');
      }
    }
  }

  pickupMachine(m: Machine): void {
    if (m.inv) for (const s of m.inv.slots) if (s) this.inventory.add(s.id, s.count);
    this.machines.remove(m);
    this.inventory.add('m_' + m.type, 1);
    this.universe.dirtyEdits.add(this.universe.focus!.key);
    this.audio.blockBreak('metal');
    this.toast(`${item('m_' + m.type).name} recolhido`);
  }

  onMachinePlaced(type: MachineType): void {
    this.toast(`${item('m_' + type).name} instalado`, 'var(--green)');
    if (type === 'fabricator') this.discover({ id: 'fabricator', kind: 'note', title: 'Base: Fabricador operacional', text: 'Receitas avançadas desbloqueadas próximas ao Fabricador.', time: Date.now(), systemId: this.universe.def.id });
  }

  nearFabricator(): boolean {
    return this.mode === 'onfoot' && !!this.machines.nearest(this.player.pos, 'fabricator', 6);
  }

  craft(r: Recipe): boolean {
    const ok = canCraft(this.inventory, r, this.nearFabricator());
    if (!ok.ok) { this.audio.ui('error'); this.toast(ok.reason ?? 'Indisponível', 'var(--red)'); return false; }
    for (const [id, n] of r.inputs) this.inventory.remove(id, n);
    this.inventory.add(r.out, r.count);
    this.audio.ui('craft');
    this.stats.crafted = (this.stats.crafted ?? 0) + 1;
    return true;
  }

  consume(id: string): void {
    const d = item(id);
    if (!d.consume) return;
    if (!this.inventory.remove(id, 1)) return;
    this.vitals.applyConsumable(d.consume);
    this.audio.ui('pickup');
    this.toast(`${d.name} utilizado`, 'var(--green)');
  }

  installUpgrade(id: string): void {
    const up = this.vitals.upgrades;
    const map: Record<string, keyof typeof up> = { extractor_mk2: 'extractorMk2', jetpack: 'jetpack', thermal_lining: 'thermal', rad_shield: 'radShield', o2_tank: 'o2Tank', battery_pack: 'batteryPack' };
    if (id === 'warp_core') {
      if (this.mode !== 'ship' && !this.player.nearShip) { this.toast('Instale o Núcleo de Dobra junto à nave (painel R)', 'var(--amber)'); return; }
      if (!this.inventory.remove(id, 1)) return;
      this.pilot.ship.warpCore = true;
      this.toast('Núcleo de Dobra instalado na nave', 'var(--green)');
      this.audio.ui('craft');
      return;
    }
    const k = map[id];
    if (!k) return;
    if (up[k]) { this.toast('Melhoria já instalada'); return; }
    if (!this.inventory.remove(id, 1)) return;
    up[k] = true;
    this.audio.ui('craft');
    this.toast(`${item(id).name} instalado no traje`, 'var(--green)');
  }

  shipAction(action: 'hull' | 'power' | 'thruster' | 'fuel' | 'refill' | 'warp_core'): void {
    const s = this.pilot.ship;
    const need = (id: string) => {
      if (this.inventory.remove(id, 1)) return true;
      this.toast(`Requer: ${item(id).name}`, 'var(--red)');
      this.audio.ui('error');
      return false;
    };
    switch (action) {
      case 'hull': if (s.hull >= 100) return; if (need('hull_patch')) { s.hull = Math.min(100, s.hull + 50); this.toast('Casco reparado', 'var(--green)'); } break;
      case 'power': if (s.powerOnline) return; if (need('power_cell')) { s.powerOnline = true; s.energyReserve = 1000; this.hud.centerMessage('Energia restaurada', 'Sistemas da nave online', 3); } break;
      case 'thruster': if (s.thrustersOnline) return; if (need('thruster_coupling')) { s.thrustersOnline = true; this.toast('Propulsores operacionais', 'var(--green)'); } break;
      case 'fuel': if (s.fuel >= 100) return; if (need('fuel_cell')) { s.fuel = Math.min(100, s.fuel + 25); this.toast('Combustível +25%', 'var(--green)'); } break;
      case 'warp_core': this.installUpgrade('warp_core'); return;
      case 'refill': {
        const o2 = Math.min(this.vitals.oxygenMax - this.vitals.oxygen, s.o2Reserve);
        s.o2Reserve -= o2;
        this.vitals.oxygen += o2;
        if (s.powerOnline) {
          const e = this.vitals.energyMax - this.vitals.energy;
          this.vitals.energy += e;
        } else {
          const e = Math.min(this.vitals.energyMax - this.vitals.energy, s.energyReserve);
          s.energyReserve -= e;
          this.vitals.energy += e;
        }
        this.toast(`Traje reabastecido (reserva O₂ da nave: ${Math.round(s.o2Reserve)})`, 'var(--cyan)');
        break;
      }
    }
    this.audio.ui('craft');
    void this.saveGame(true);
  }

  // ------------------------------------------------------------------ ship enter/exit
  get shipVisible(): boolean {
    return true;
  }

  enterShip(): void {
    const s = this.pilot.ship;
    this.mode = 'ship';
    this.player.visible = false;
    this.player.mining = false;
    this.effects.setBeam(null, null, null, 0);
    this.effects.ghost.visible = false;
    this.player.flashlightOn = false;
    this.hud.showFoot(false);
    this.hud.showShip(true);
    this.pilot.stick.set(0, 0);
    this.audio.ui('open');
    if (!s.powerOnline || !s.thrustersOnline) this.toast('Sistemas da nave danificados — R para tentar ligar, ou saia (E) para reparar', 'var(--amber)');
    else if (!s.engineOn) this.toast('Pressione R para ligar os motores', 'var(--cyan)');
  }

  exitShip(): void {
    const s = this.pilot.ship;
    const frame = this.universe.frame;
    this.mode = 'onfoot';
    const hatch = s.localToFrame(ShipModel.HATCH.clone().add(new THREE.Vector3(-0.8, 0, 0)));
    this.player.visible = true;
    this.player.vel.copy(s.landed ? new THREE.Vector3() : s.vel);
    if (frame) {
      this.player.placeAt(hatch, s.forward());
      this.seatOnGround(this.player.pos);
    } else {
      this.player.pos.copy(hatch);
      this.player.up.copy(s.upVec());
      this.player.forward.copy(s.forward());
    }
    this.hud.showShip(false);
    this.hud.showFoot(true);
    this.audio.ui('close');
  }

  onShipLanded(): void {
    const f = this.universe.frame;
    if (f) {
      this.lastShipBody = f.id;
      this.toast(`Pouso confirmado em ${this.displayName(f.id)}`, 'var(--green)');
      void this.saveGame(true);
    }
  }

  // ------------------------------------------------------------------ warp
  requestWarp(): void {
    const s = this.pilot.ship;
    const u = this.universe;
    if (this.mode !== 'ship' || this.warpState) return;
    if (!s.warpCore) { this.toast('Núcleo de Dobra não instalado', 'var(--red)'); this.audio.ui('error'); return; }
    if (!this.jumpTarget) { this.toast('Defina um destino no Mapa Galáctico (G)', 'var(--amber)'); this.audio.ui('error'); return; }
    if (!this.inventory.has('warp_cell') && !s.cargo.has('warp_cell')) { this.toast('Sem Células de Dobra', 'var(--red)'); this.audio.ui('error'); return; }
    if (u.frame && this.pilot.altitude < (u.frame.def.atmosphere?.height ?? 0) + 2500) { this.toast('Afaste-se mais do planeta para saltar', 'var(--amber)'); this.audio.ui('error'); return; }
    if (!s.engineOn) { this.toast('Ligue os motores', 'var(--amber)'); return; }
    if (!this.inventory.remove('warp_cell', 1)) s.cargo.remove('warp_cell', 1);
    this.mode = 'warp';
    this.warpState = 'CARREGANDO DOBRA';
    this.warpT = 0;
    this.pilot.dropCruise('');
    this.audio.warp();
  }

  private warpLoading = false;
  private updateWarp(dt: number): void {
    const u = this.universe;
    const s = this.pilot.ship;
    this.warpT += dt;
    u.time += dt;
    u.system.update(u.time);
    const fx = this.renderer.fx;
    if (this.warpT < 3) {
      fx.warp = this.warpT / 3 * 0.4;
      s.vel.addScaledVector(s.forward(), dt * 300);
    } else if (this.warpT < 6.5) {
      this.warpState = 'DOBRA';
      fx.warp = Math.min(1, fx.warp + dt * 0.8);
      fx.chroma = fx.warp;
      if (!this.warpLoading && this.warpT > 4.2) {
        this.warpLoading = true;
        void this.arriveInSystem(this.jumpTarget!);
      }
    } else if (!this.warpLoading) {
      fx.warp = Math.max(0, fx.warp - dt * 0.7);
      fx.chroma = fx.warp;
      this.warpState = 'SAINDO DA DOBRA';
      if (fx.warp <= 0) {
        this.warpState = null;
        this.mode = 'ship';
        fx.chroma = 0;
        this.stats.jumps = (this.stats.jumps ?? 0) + 1;
        this.hud.centerMessage(`Sistema ${u.def.name}`, `${u.def.star.label} · ${u.def.bodies.length} corpos`, 5);
        void this.saveGame(true);
      }
    }
    s.pos.addScaledVector(s.vel, dt);
    s.model.update(u.time, 1, 0, 0, false, false);
    this.pilot.updateModelTransform();
    this.pilot.updateCamera(dt);
    u.place(this.pilot.camPos, this.pilot.camQuat, s.pos, dt);
    this.updateAudio(dt);
    this.hud.updateShip(this.pilot.hudState());
  }

  private async arriveInSystem(starId: string): Promise<void> {
    const u = this.universe;
    const summary = u.galaxy.byId(starId);
    if (!summary) { this.warpLoading = false; return; }
    // persist edits of the old system
    await this.saveGame(true);
    u.edits.clear();
    await u.loadSystem(summary, u.time);
    this.machines.attach(null, null);
    // arrive near the most interesting landable world
    const sys = u.system;
    const landable = sys.bodies.filter((b) => b.landable);
    const pick = landable.find((b) => b.def.type === 'terrestrial' || b.def.type === 'ocean' || b.def.type === 'exotic') ?? landable[0] ?? sys.bodies[0];
    const s = this.pilot.ship;
    const toStar = pick.pos.clone().negate().normalize();
    s.pos.copy(pick.pos).addScaledVector(toStar, pick.radius * 9).add(new THREE.Vector3(0, pick.radius * 1.5, 0));
    s.vel.set(0, 0, 0);
    s.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(s.pos, pick.pos, new THREE.Vector3(0, 1, 0)));
    u.frame = null;
    this.navTarget = pick.id;
    this.jumpTarget = null;
    this.soiVisited.clear();
    for (const d of this.discoveries) if (d.kind === 'body' && d.systemId === u.def.id) this.soiVisited.add(d.id);
    this.markVisited();
    u.forceEnvUpdate();
    this.warpLoading = false;
  }

  // ------------------------------------------------------------------ death
  private die(): void {
    this.mode = 'dead';
    this.player.mining = false;
    this.hud.showFoot(false);
    this.hud.showShip(false);
    this.input.unlock();
    const cause = this.vitals.lastCause;
    const msg: Record<string, string> = { oxygen: 'Asfixia', cold: 'Hipotermia', heat: 'Hipertermia', radiation: 'Envenenamento por radiação', fall: 'Queda', hunger: 'Inanição', thirst: 'Desidratação', creature: 'Ataque de criatura', impact: 'Impacto', lava: 'Queimaduras' };
    this.ui.showDeath(msg[cause ?? ''] ?? 'Sinais vitais perdidos');
  }

  respawn(): void {
    const s = this.pilot.ship;
    this.vitals.respawn();
    this.renderer.fx.fade = 0;
    this.mode = 'onfoot';
    // back at the ship (or nearest O2 generator)
    if (this.universe.frame) {
      const o2 = this.machines.machines.find((m) => m.type === 'oxygen');
      if (o2) this.player.placeAt(this.machines.worldPos(o2).addScaledVector(this.machines.worldPos(o2).normalize(), 1.2));
      else this.player.placeAt(s.localToFrame(ShipModel.HATCH.clone().add(new THREE.Vector3(-0.8, 0, 0))), s.forward());
      this.seatOnGround(this.player.pos);
    }
    this.player.visible = true;
    this.hud.showFoot(true);
    this.toast('Sistemas de emergência restauraram os sinais vitais', 'var(--amber)');
  }

  // ------------------------------------------------------------------ points of interest
  private updatePois(dt: number): void {
    this.poiT -= dt;
    const f = this.universe.focus;
    const phys = f?.physics;
    if (!f || !phys || f.body !== this.universe.frame || this.mode !== 'onfoot') { if (this.poiT < -5) this.nearPois = []; return; }
    if (this.poiT <= 0) {
      this.poiT = 1.5;
      const g = { face: 0, x: 0, y: 0, z: 0 };
      phys.toGrid(this.player.pos, g);
      const N = f.body.def.gen!.N, base = f.body.def.gen!.baseRadius;
      const tmp = [0, 0, 0];
      this.nearPois = f.gen.poisNear(g.face, Math.floor(g.x), Math.floor(g.y), 900).map((poi) => {
        gridToPos(poi.face, poi.I + 0.5, poi.J + 0.5, poi.top + 1, N, base, tmp);
        return { poi, pos: new THREE.Vector3(tmp[0], tmp[1], tmp[2]), key: `${f.key}/${poi.id}` };
      });
    }
    for (const n of this.nearPois) {
      if (this.lootedPois.has(n.key)) continue;
      if (n.pos.distanceTo(this.player.pos) < 7) this.visitPoi(n.poi, n.key);
    }
  }

  private visitPoi(poi: POI, key: string): void {
    this.lootedPois.add(key);
    this.knownPois.add(key);
    const loot: Record<string, [string, number][]> = {
      outpost: [['plate', 4], ['wiring', 4], ['battery', 2], ['o2_canister', 2], ['fuel_cell', 1]],
      wreck: [['titanium', 3], ['circuit', 2], ['aurelite', 2], ['hull_patch', 1]],
      monolith: [['luminite', 3], ['radite', 2], ['medkit', 1]],
    };
    const lore: Record<string, string> = {
      outpost: 'Abrigo pré-fabricado abandonado. O registro do terminal termina abruptamente: “…sinal da colônia perdido, iniciando hibernação…”.',
      wreck: 'Destroços de uma nave exploradora de modelo desconhecido. O núcleo de navegação ainda pulsa fracamente.',
      monolith: 'Estrutura monolítica de origem não humana. Os veios luminosos respondem ao scanner com um padrão matemático.',
    };
    const title: Record<string, string> = { outpost: 'Posto avançado abandonado', wreck: 'Destroços de nave', monolith: 'Monólito alienígena' };
    const got: string[] = [];
    for (const [id, n] of loot[poi.kind]) { this.inventory.add(id, n); got.push(`${n} ${item(id).name}`); }
    this.discover({ id: key, kind: 'structure', title: title[poi.kind], text: `${lore[poi.kind]} Recuperado: ${got.join(', ')}.`, time: Date.now(), systemId: this.universe.def.id });
    this.hud.centerMessage(title[poi.kind], 'Suprimentos recuperados', 3.5);
  }

  // ------------------------------------------------------------------ lamps (dynamic lights for lamp blocks / floodlights)
  registerLamp(face: number, I: number, J: number, K: number): void {
    const key = this.universe.focus?.key ?? '';
    const l = this.lamps.get(key) ?? [];
    l.push([face, I, J, K]);
    this.lamps.set(key, l);
  }

  private unregisterLamp(face: number, I: number, J: number, K: number): void {
    const key = this.universe.focus?.key ?? '';
    const l = this.lamps.get(key);
    if (l) this.lamps.set(key, l.filter((x) => !(x[0] === face && x[1] === I && x[2] === J && x[3] === K)));
  }

  private updateLamps(dt: number): void {
    this.lampT -= dt;
    if (this.lampT > 0) return;
    this.lampT = 0.5;
    const f = this.universe.focus;
    const phys = f?.physics;
    for (const l of this.lampLights) l.intensity = 0;
    if (!f || !phys) return;
    const src: { p: THREE.Vector3; color: number; power: number }[] = [];
    for (const c of this.lamps.get(f.key) ?? []) src.push({ p: phys.cellCenter(c[0], c[1], c[2], c[3]), color: 0xffe9c4, power: 60 });
    const night = this.universe.sunElevation < 0.05;
    for (const m of this.machines.machines) {
      if (m.type === 'floodlight' && m.powered && night) src.push({ p: this.machines.worldPos(m).addScaledVector(this.machines.worldPos(m).normalize(), 1.4), color: 0xfff2dd, power: 220 });
    }
    const pp = this.player.pos;
    src.sort((a, b) => a.p.distanceTo(pp) - b.p.distanceTo(pp));
    src.slice(0, this.lampLights.length).forEach((s, i) => {
      const l = this.lampLights[i];
      l.removeFromParent();
      f.root.add(l);
      l.position.copy(s.p);
      l.color.set(s.color);
      l.intensity = s.power;
    });
  }

  // ------------------------------------------------------------------ per-frame presentation
  private updateTargetBox(camPos: THREE.Vector3): void {
    const t = this.mode === 'onfoot' ? this.player.target : null;
    const phys = this.universe.focus?.physics;
    if (!t || !phys) { this.effects.setTargetBox(null, 0); return; }
    // corners are planet-local == frame-local when on a planet
    const corners = phys.cellCorners(t.face, t.I, t.J, t.K, 0.004);
    this.effects.setTargetBox(corners, this.player.mineProgress);
    void camPos;
  }

  private updateWeatherFx(camPos: THREE.Vector3, dt: number): void {
    const u = this.universe;
    const f = u.focus;
    if (!f || f.body !== u.frame || !f.body.def.atmosphere) { this.weatherFx.object.visible = false; return; }
    const w = f.weather;
    const alt = camPos.length() - f.body.radius;
    let density = alt < f.body.def.atmosphere.height * 0.3 ? w.cur.density : 0;
    // sheltered: solid block above the player's head
    const phys = f.physics;
    if (phys && density > 0 && this.mode === 'onfoot') {
      const g = { face: 0, x: 0, y: 0, z: 0 };
      phys.toGrid(this.player.pos, g);
      for (let k = 2; k < 24; k++) if (phys.solid(g.face, Math.floor(g.x), Math.floor(g.y), Math.floor(g.z) + k)) { density = 0; break; }
    }
    const up = camPos.clone().normalize();
    const windDir = new THREE.Vector3(1, 0, 0).cross(up).normalize();
    this.weatherFx.update(u.time, w.cur.particles, density, w.cur.wind, up, windDir, camPos, u.ambient.clone().multiplyScalar(20).add(u.sunAtObserver.clone().multiplyScalar(0.3)));
    this.weatherFx.object.position.set(0, 0, 0);
    // lightning
    if (w.lightningFlash > 0.5 && !w.onThunder) w.onThunder = (d, i) => this.audio.thunder(d, i);
    if (!w.onThunder) w.onThunder = (d, i) => this.audio.thunder(d, i);
    if (!w.onMeteor) w.onMeteor = () => this.meteor();
    this.renderer.fx.exposureBias = 1 + w.lightningFlash * 2.5;
    void dt;
  }

  private meteor(): void {
    const u = this.universe;
    const f = u.focus;
    if (!f || f.body !== u.frame) return;
    const up = this.player.pos.clone().normalize();
    const side = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).projectOnPlane(up).normalize();
    const start = this.player.pos.clone().addScaledVector(up, 600 + Math.random() * 400).addScaledVector(side, (Math.random() - 0.5) * 1500);
    const dir = side.clone().multiplyScalar(-1).addScaledVector(up, -0.4).normalize();
    for (let i = 0; i < 30; i++) this.effects.sparksAt(start.clone().addScaledVector(dir, i * 12), dir, new THREE.Color(4, 3, 2), 1, 1, 0, 2.5, 1.2, 0);
  }

  private updateFx(dt: number): void {
    const fx = this.renderer.fx;
    const ship = this.pilot.ship;
    fx.heat = this.mode === 'ship' ? ship.heat * 0.8 : 0;
    const low = this.vitals.oxygen <= 0 ? 0.6 + Math.sin(this.universe.time * 4) * 0.2 : this.vitals.health < 25 ? 0.35 : 0;
    fx.damage += (low - fx.damage) * Math.min(1, dt * 3);
    if (this.mode !== 'warp') { fx.warp = 0; fx.chroma = this.mode === 'ship' ? ship.heat * 0.4 : 0; }
    if (this.mode !== 'dead') fx.fade = Math.max(0, fx.fade - dt);
    fx.saturation = this.player.underwater ? 0.8 : 1.05;
  }

  private moodFor(): Mood {
    const u = this.universe;
    if (this.vitals.health < 30 || this.vitals.oxygen <= 0 || this.fauna.threat > 0) return 'danger';
    if (this.mode === 'ship') {
      if (this.pilot.ship.heat > 0.2) return 'entry';
      if (!u.frame || this.pilot.altitude > 3000) return 'space';
    }
    const f = u.focus?.body.def;
    if (f && (f.type === 'exotic' || f.type === 'volcanic')) return 'mystery';
    if (this.player.underwater) return 'mystery';
    return 'explore';
  }

  private updateAudio(dt: number): void {
    const s = this.pilot.ship;
    const w = this.universe.focus?.weather.cur;
    const inShip = this.mode === 'ship' || this.mode === 'warp';
    const phys = this.universe.focus?.physics;
    let cave = 0;
    if (phys && this.mode === 'onfoot') {
      const g = { face: 0, x: 0, y: 0, z: 0 };
      phys.toGrid(this.player.pos, g);
      const top = phys.world.gen.surfaceTop(g.face, Math.floor(g.x), Math.floor(g.y));
      cave = THREE.MathUtils.clamp((top - g.z - 2) / 6, 0, 1);
    }
    this.audio.update(dt, {
      wind: this.env.wind, pressure: this.env.pressure, rain: w && w.particles === 'rain' ? w.density : 0,
      engine: s.throttleVis, engineOn: s.engineOn && (inShip || this.player.pos.distanceTo(s.pos) < 80), inCockpit: inShip && this.pilot.cockpitView,
      roar: inShip ? s.heat + Math.min(1, this.pilot.density * s.vel.length() / 700) * 0.4 : 0, mining: this.player.mining,
      breathing: inShip ? 0.4 : 1, exertion: this.player.mining || this.player.jetpacking ? 0.6 : (this.input.down('ShiftLeft') ? 0.8 : 0.1) + (this.vitals.oxygen < 20 ? 0.6 : 0),
      underwater: this.player.underwater && !inShip, vacuum: this.env.vacuum && !inShip, mood: this.moodFor(), cave,
    });
  }

  private updateHud(dt: number): void {
    const u = this.universe;
    if (this.mode === 'ship') { this.hud.updateShip(this.pilot.hudState()); return; }
    if (this.mode !== 'onfoot') return;
    const p = this.player;
    const frame = u.frame;
    const up = p.up;
    // heading: angle of forward relative to local north (planet spin axis)
    let heading = 0;
    let coords = '';
    const markers: CompassMarker[] = [];
    if (frame) {
      const north = new THREE.Vector3(0, 1, 0).projectOnPlane(up).normalize();
      const east = new THREE.Vector3().crossVectors(north, up).normalize().negate();
      const bearing = (v: THREE.Vector3) => {
        const t = v.clone().projectOnPlane(up);
        return Math.atan2(t.dot(east), t.dot(north));
      };
      heading = bearing(p.forward);
      const lat = Math.asin(THREE.MathUtils.clamp(up.y, -1, 1)) * 180 / Math.PI;
      const lon = Math.atan2(-up.z, up.x) * 180 / Math.PI;
      coords = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'L' : 'O'}`;
      const ship = this.pilot.ship;
      const toShip = ship.pos.clone().sub(p.pos);
      markers.push({ bearing: bearing(toShip), label: 'Nave', color: 'var(--orange)', glyph: `▲<br><span style="font-size:9px">${fmtDist(toShip.length())}</span>` });
      for (const n of this.nearPois) {
        if (!this.knownPois.has(n.key)) continue;
        const d = n.pos.distanceTo(p.pos);
        const looted = this.lootedPois.has(n.key);
        markers.push({ bearing: bearing(n.pos.clone().sub(p.pos)), label: 'Sinal', color: looted ? 'var(--dim)' : 'var(--amber)', glyph: `◈<br><span style="font-size:9px">${fmtDist(d)}</span>` });
      }
      for (const m of this.machines.machines) if (m.type === 'beacon') markers.push({ bearing: bearing(this.machines.worldPos(m).sub(p.pos)), label: m.label, color: 'var(--red)', glyph: '⚑' });
      const sunLocal = u.sunDir.clone().applyQuaternion(u.focus!.root.quaternion.clone().invert());
      if (u.focus?.body === frame) markers.push({ bearing: bearing(sunLocal), label: 'Estrela', color: 'var(--amber)', glyph: '☼' });
    }
    const sunE = u.sunElevation;
    const tod = sunE > 0.35 ? 'Dia' : sunE > 0.05 ? 'Manhã/Tarde' : sunE > -0.08 ? 'Crepúsculo' : sunE > -0.3 ? 'Noite' : 'Madrugada';
    const surfR = u.focus ? u.focus.surfaceRadius(up) : 0;
    const t = p.target;
    let prompt: string | null = null;
    let targetInfo: string | null = null;
    if (p.targetMachine) {
      const m = p.targetMachine;
      const name = item('m_' + m.type).name;
      const verb: Record<string, string> = { door: m.open ? 'Fechar' : 'Abrir', storage: 'Abrir contêiner', fabricator: 'Usar fabricador', recharger: 'Recarregar traje' };
      prompt = `<kbd>E</kbd>${verb[m.type] ?? 'Status'} · ${name}`;
      targetInfo = `${m.powered ? '● energizado' : '○ sem energia'} · segure ⟁ para recolher`;
    } else if (p.nearShip) {
      prompt = `<kbd>E</kbd>Entrar na nave <kbd style="margin-left:10px">R</kbd>Painel de reparos`;
    } else if (t) {
      targetInfo = BLOCKS[t.block].name;
    }
    const obj = this.campaign.current;
    const held = p.heldItem();
    const g = this.vitals;
    this.hud.updateFoot({
      bodyName: frame ? this.displayName(frame.id) : 'Espaço profundo',
      bodyType: frame ? TYPE_LABEL[frame.def.type] : u.def.name,
      coords, altitude: frame ? p.pos.length() - surfR + 1 : 0, timeOfDay: tod,
      weather: u.focus?.weather.label ?? '—', heading, markers,
      health: g.health, oxygen: g.oxygen, oxygenMax: g.oxygenMax, energy: g.energy, energyMax: g.energyMax, integrity: g.integrity,
      bodyTemp: g.bodyTemp, ambientTemp: this.env.temperature, radiation: this.env.radiation, radDose: g.radiation,
      food: g.fullSurvival ? g.food : null, water: g.fullSurvival ? g.water : null,
      breathable: this.env.underwater ? 'SUBMERSO' : this.env.vacuum ? 'VÁCUO' : this.env.breathable > 0.8 ? 'AR RESPIRÁVEL' : this.env.breathable > 0.1 ? `AR RAREFEITO ${Math.round(this.env.breathable * 100)}%` : 'ATMOSFERA TÓXICA',
      pressurized: this.env.pressurized, warnings: g.warnings, prompt, targetInfo, mineProgress: p.mineProgress,
      objective: obj ? { title: obj.title, hint: obj.hint, progress: obj.progress ? obj.progress({ moved: 0, scans: 0, count: (id) => this.inventory.count(id), fabricatorPlaced: false, shipHull: this.pilot.ship.hull, shipPower: false, shipThrusters: false, engineOn: false, inShip: false, altitudeAboveAtmo: frame ? this.pilot.altitude - (frame.def.atmosphere?.height ?? 0) - 150 : 1, navTargetOther: false, landedBodyId: null, startBodyId: '', mined: 0, warpJumps: 0 }) : '' } : null,
      hotbarIndex: this.hotbar, toolLabel: held ? item(held).name : 'Mãos livres',
    }, dt);
  }

  // ------------------------------------------------------------------ UI helpers
  toast(msg: string, color?: string): void {
    this.hud.toast(msg, color);
  }

  openPanel(tab: string): void {
    this.ui.openTerminal(tab);
  }

  setNavTarget(id: string | null): void {
    this.navTarget = id;
    if (id) this.toast(`Destino: ${this.displayName(id)}`, 'var(--cyan)');
  }

  craftable(): Recipe[] {
    return RECIPES;
  }

  applySettings(): void {
    saveSettings(this.settings);
    this.renderer.applySettings(this.settings.graphics);
    this.universe.settings = this.settings.graphics;
    this.universe.applyShadowSettings();
    this.audio.setVolumes(this.settings.audio);
    this.showFps(this.settings.showFps);
  }

  setSuit(c: { primary: string; secondary: string; accent: string; visor: string }): void {
    this.suit = { ...c };
    this.player.model.setColors(c);
  }

  quitToMenu(): void {
    void this.saveGame(true).then(() => window.location.reload());
  }
}

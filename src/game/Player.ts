import * as THREE from 'three';
import { Astronaut, AstronautAnimator, type AnimState } from '../player/Astronaut';
import { buildTool, toolMuzzle } from './Tools';
import { B, BLOCKS } from '../voxel/blocks';
import { LAYERS, srgbToLinear } from '../voxel/palette';
import { item, placeableBlock, type ToolId, type MachineType } from '../items/items';
import { buildMachineModel, machineHeight, type Machine } from '../building/Machines';
import type { RayHit, GridPos } from '../physics/VoxelPhysics';
import { canonicalCell } from '../planet/cubesphere';
import { STRUCTURE } from '../planet/terrain';
import { ShipModel } from '../ship/ShipModel';
import type { Game } from './Game';

/**
 * The astronaut on foot: locomotion on curved planetary gravity (walk, run,
 * jump, auto-step, swim, jetpack, zero-g EVA), first/third person cameras with
 * collision, mining, building with previews, scanning and interaction.
 */

const HALF_W = 0.3;
/** radius (m) of the extractor's carving sphere on natural terrain */
export const DIG_RADIUS = 1.0;
const HEIGHT = 1.8;
const EYE = 1.62;

export class Player {
  readonly game: Game;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, -1);
  up = new THREE.Vector3(0, 1, 0);
  pitch = 0;
  grounded = false;
  swimming = false;
  underwater = false;
  jetpacking = false;
  zeroG = false;
  firstPerson = true;
  camDist = 4.2;
  readonly model = new Astronaut();
  readonly animator: AstronautAnimator;
  private tpTool: THREE.Group;
  private tpToolId = '';
  readonly view = new THREE.Group();
  private vmArm: THREE.Group;
  private vmTool: THREE.Group;
  private vmToolId = '';
  private vmLights: THREE.Object3D[] = [];
  flashlightOn = false;
  readonly flashlight: THREE.SpotLight;
  private stepSmooth = 0;
  private stepDist = 0;
  private bob = 0;
  private landImpact = 0;
  private airTime = 0;
  private lastRadialV = 0;
  mineProgress = 0;
  private mineKey = '';
  private digAcc = 0;
  private digTimer = 0;
  private sinceRemove = 0;
  mining = false;
  private buildAnim = 0;
  private interactAnim = 0;
  scanT = -1;
  private scanCooldown = 0;
  rot = 0;
  target: RayHit | null = null;
  creatureHit: THREE.Vector3 | null = null;
  targetMachine: Machine | null = null;
  nearShip = false;
  private ghostType: MachineType | null = null;
  private ghostModel: THREE.Group | null = null;
  private ghostMat = new THREE.MeshBasicMaterial({ color: 0x5fe1ff, transparent: true, opacity: 0.35, depthWrite: false });
  private ghostBad = new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.35, depthWrite: false });
  moved = 0;
  visible = true;
  camPos = new THREE.Vector3();
  camQuat = new THREE.Quaternion();
  lookDir = new THREE.Vector3();
  private tmpG: GridPos = { face: 0, x: 0, y: 0, z: 0 };

  constructor(game: Game) {
    this.game = game;
    this.animator = new AstronautAnimator(this.model);
    this.tpTool = new THREE.Group();
    this.model.rig.handR.add(this.tpTool);
    this.tpTool.position.set(0, -0.05, 0.02);
    this.tpTool.rotation.x = -Math.PI / 2;
    // first-person view model: forearm + glove + tool
    this.vmArm = new THREE.Group();
    const armMat = this.model.mats.primary;
    const gloveMat = this.model.mats.secondary;
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.42), armMat);
    fore.position.set(0, 0, 0.18);
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.14), gloveMat);
    glove.position.set(0, 0, -0.06);
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.17, 0.05), gloveMat);
    cuff.position.set(0, 0, 0.02);
    this.vmArm.add(fore, glove, cuff);
    this.vmTool = new THREE.Group();
    this.vmArm.add(this.vmTool);
    this.vmTool.position.set(0, 0.06, -0.08);
    this.view.add(this.vmArm);
    for (const o of [fore, glove, cuff]) {
      const m = o.material as THREE.Material;
      void m;
    }
    // view-model lights (the view scene does not share the main scene's lights)
    const vSun = new THREE.DirectionalLight(0xffffff, 1);
    const vHemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    this.vmLights = [vSun, vHemi];
    game.renderer.viewScene.add(vSun, vSun.target, vHemi, this.view);
    this.flashlight = new THREE.SpotLight(0xfff1dd, 0, 45, 0.42, 0.55, 1.6);
    this.flashlight.castShadow = false;
    game.universe.frameRoot.add(this.flashlight, this.flashlight.target);
    game.universe.frameRoot.add(this.model.rig.root);
    game.universe.sun.shadow.camera.layers.enable(1);
  }

  get bodyFrame(): boolean {
    return !!this.game.universe.frame;
  }

  // ---------------------------------------------------------------- helpers
  right(out = new THREE.Vector3()): THREE.Vector3 {
    return out.crossVectors(this.forward, this.up).normalize();
  }

  private gravity(): number {
    const f = this.game.universe.frame;
    if (!f) return 0;
    const r = Math.max(1, this.pos.length());
    return f.def.gravity * (f.radius / r) ** 2;
  }

  private physics() {
    const fp = this.game.universe.focus;
    if (!fp || fp.body !== this.game.universe.frame) return null;
    return fp.physics;
  }

  placeAt(pos: THREE.Vector3, forward?: THREE.Vector3): void {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.up.copy(pos).normalize();
    if (forward) this.forward.copy(forward);
    this.reorthonormalize();
  }

  private reorthonormalize(): void {
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up));
    if (this.forward.lengthSq() < 1e-6) {
      this.forward.set(1, 0, 0).addScaledVector(this.up, -this.up.x);
      if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1).addScaledVector(this.up, -this.up.z);
    }
    this.forward.normalize();
  }

  heldItem(): string | null {
    const s = this.game.inventory.slots[this.game.hotbar];
    return s ? s.id : null;
  }

  heldTool(): ToolId | null {
    const id = this.heldItem();
    if (!id) return null;
    return item(id).tool ?? null;
  }

  // ---------------------------------------------------------------- update
  update(dt: number, controls: boolean): void {
    const g = this.game;
    const input = g.input;
    const sens = 0.0022 * g.settings.controls.sensitivity;
    const frame = g.universe.frame;
    this.zeroG = !frame || this.pos.length() > frame.def.soi * 0.9;
    // orientation: keep "up" radial, transport heading smoothly
    if (!this.zeroG) {
      const newUp = this.pos.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(this.up, newUp);
      this.forward.applyQuaternion(q);
      this.up.copy(newUp);
      this.reorthonormalize();
    }
    if (controls && input.locked) {
      const dx = input.mouseDX * sens, dy = input.mouseDY * sens * (g.settings.controls.invertY ? -1 : 1);
      this.forward.applyAxisAngle(this.up, -dx).normalize();
      if (this.zeroG) {
        // free look in space: pitch rotates up/forward together
        const r = this.right();
        this.forward.applyAxisAngle(r, -dy);
        this.up.applyAxisAngle(r, -dy);
        this.reorthonormalize();
        this.pitch = 0;
      } else this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.53, 1.53);
      if (input.hit('KeyV')) this.firstPerson = !this.firstPerson;
      if (!this.firstPerson && input.wheel !== 0 && !this.wheelForHotbar()) this.camDist = THREE.MathUtils.clamp(this.camDist + input.wheel * 0.5, 2, 9);
    }
    this.move(dt, controls);
    this.updateCamera(dt);
    if (controls) this.interact(dt);
    else { this.mining = false; this.mineProgress = 0; }
    this.updateVisuals(dt);
  }

  private wheelForHotbar(): boolean {
    return true;
  }

  private move(dt: number, controls: boolean): void {
    const g = this.game;
    const input = g.input;
    const phys = this.physics();
    const U = this.up, F = this.forward, R = this.right();
    let fwd = 0, side = 0, upIn = 0;
    if (controls) {
      if (input.down('KeyW')) fwd += 1;
      if (input.down('KeyS')) fwd -= 1;
      if (input.down('KeyD')) side += 1;
      if (input.down('KeyA')) side -= 1;
      if (input.down('Space')) upIn += 1;
      if (input.down('KeyC') || input.down('ControlLeft')) upIn -= 1;
    }
    const running = controls && input.down('ShiftLeft') && fwd > 0 && !this.swimming;
    const fp = g.universe.focus;
    const genP = fp?.body.def.gen;
    const seaR = genP && genP.hasOcean ? genP.baseRadius + genP.seaZ : -1;
    const r = this.pos.length();
    this.underwater = seaR > 0 && r + EYE < seaR;
    const wasSwimming = this.swimming;
    this.swimming = seaR > 0 && r + 0.9 < seaR;
    if (this.swimming && !wasSwimming) g.audio.splash();
    this.jetpacking = false;

    if (this.zeroG) {
      // EVA: suit thrusters along camera axes
      const L = this.lookDir.clone();
      const acc = new THREE.Vector3().addScaledVector(L, fwd).addScaledVector(R, side).addScaledVector(U, upIn);
      if (acc.lengthSq() > 0 && g.vitals.energy > 0) {
        this.vel.addScaledVector(acc.normalize(), 4 * dt);
        g.vitals.energy = Math.max(0, g.vitals.energy - 0.4 * dt);
      }
      if (controls && input.down('KeyX')) this.vel.multiplyScalar(1 - Math.min(1, dt * 2));
      this.pos.addScaledVector(this.vel, dt);
      this.grounded = false;
      return;
    }

    const gAcc = this.gravity();
    // tangential motion
    const speed = this.swimming ? 3.2 : running ? 7.4 : 4.3;
    const wish = new THREE.Vector3().addScaledVector(F, fwd).addScaledVector(R, side);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    const vr = this.vel.dot(U);
    const vh = this.vel.clone().addScaledVector(U, -vr);
    const accel = this.swimming ? 6 : this.grounded ? 34 : 6;
    const dv = wish.clone().sub(vh);
    const maxDv = accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    vh.add(dv);
    let newVr = vr;
    if (this.swimming) {
      newVr += (upIn * 2.6 - vr) * Math.min(1, dt * 3);
      newVr -= gAcc * 0.05 * dt;
      vh.multiplyScalar(1 - Math.min(1, dt * 1.2));
      // surface bob: float at the surface
      if (upIn === 0 && r + 1.3 > seaR) newVr += (seaR - (r + 1.3)) * dt * 3;
      // slow ocean current drifting along a fixed planetary direction
      const current = new THREE.Vector3(0.3, 0, 1).projectOnPlane(U).normalize().multiplyScalar(0.45 * Math.sin(g.universe.time * 0.05 + this.pos.x * 0.001) + 0.35);
      vh.addScaledVector(current, dt * 0.8);
    } else {
      newVr -= gAcc * dt;
      if (controls && input.hit('Space') && this.grounded) {
        newVr = 5.2;
        this.grounded = false;
      }
      // jetpack: hold space while airborne
      if (controls && !this.grounded && input.down('Space') && g.vitals.upgrades.jetpack && this.airTime > 0.25 && g.vitals.energy > 0.5) {
        newVr += (gAcc + 7) * dt;
        newVr = Math.min(newVr, 9);
        this.jetpacking = true;
        if (Math.random() < 0.6) {
          const back = this.pos.clone().addScaledVector(U, 1.0).addScaledVector(F, -0.35);
          g.effects.sparksAt(back, U.clone().negate(), new THREE.Color(1.5, 0.8, 0.4), 2, 2.5, 0.3, 0.08, 0.35);
        }
      }
    }
    this.vel.copy(vh).addScaledVector(U, newVr);
    // terminal velocity in atmosphere
    const vmax = 60;
    if (this.vel.length() > vmax) this.vel.setLength(vmax);

    const before = this.pos.clone();
    const prevGrounded = this.grounded;
    const prevRadial = newVr;
    if (phys) {
      // un-stick: if spawned/edited into solid voxels, lift out
      phys.toGrid(this.pos, this.tmpG);
      phys.basis(this.tmpG);
      if (phys.boxHits(this.tmpG.face, this.tmpG.x, this.tmpG.y, this.tmpG.z, HALF_W / phys.gridAxisWorld(0).length() - 0.02, HEIGHT - 0.05)) {
        this.pos.addScaledVector(U, Math.min(1, dt * 6));
        this.vel.addScaledVector(U, -Math.min(0, this.vel.dot(U)));
      }
      const res = phys.move(this.pos, this.vel, this.vel.clone().multiplyScalar(dt), HALF_W, HEIGHT, g.settings.controls.autoStep, this.grounded);
      this.grounded = res.grounded || (this.vel.dot(this.pos.clone().normalize()) <= 0.01 && phys.groundBelow(this.pos, HALF_W));
      if (res.stepped > 0) this.stepSmooth -= res.stepped;
    } else {
      // no voxels yet: rest on the analytic surface
      this.pos.addScaledVector(this.vel, dt);
      const fpl = g.universe.focus;
      if (fpl && fpl.body === g.universe.frame) {
        const sr = fpl.surfaceRadius(this.pos.clone().normalize());
        if (this.pos.length() < sr) {
          this.pos.setLength(sr);
          const up = this.pos.clone().normalize();
          const v = this.vel.dot(up);
          if (v < 0) this.vel.addScaledVector(up, -v);
          this.grounded = true;
        }
      }
    }
    // landing / fall damage
    if (!prevGrounded && this.grounded) {
      const impact = -Math.min(prevRadial, this.lastRadialV);
      this.landImpact = Math.min(0.35, impact * 0.03);
      if (impact > 3) g.audio.footstep(this.stepMaterial());
      const safe = 11.5;
      if (impact > safe && !this.swimming) {
        const dmg = (impact - safe) * 7;
        g.vitals.damage(dmg, 'fall');
        g.vitals.integrity = Math.max(0, g.vitals.integrity - dmg * 0.4);
      }
    }
    this.lastRadialV = newVr;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    // footsteps
    const moved = before.distanceTo(this.pos);
    this.moved += moved;
    if (this.grounded && !this.swimming) {
      this.stepDist += moved;
      const stride = running ? 2.0 : 1.55;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const m = this.stepMaterial();
        g.audio.footstep(m);
        if (m === 'sand' || m === 'snow' || m === 'soil') {
          const feet = this.pos.clone();
          const c = m === 'snow' ? new THREE.Color(0.5, 0.52, 0.55) : m === 'sand' ? new THREE.Color(0.35, 0.28, 0.18) : new THREE.Color(0.2, 0.15, 0.1);
          g.effects.sparksAt(feet, U, c.multiplyScalar(0.25 + g.universe.sunAtObserver.y * 0.03), 3, 0.8, 0.1, 0.12, 0.8, 3);
        }
      }
    }
    this.bob += moved * (running ? 1.5 : 1.9);
    this.stepSmooth *= Math.exp(-dt * 12);
  }

  private stepMaterial(): import('../audio/Audio').StepMaterial {
    const phys = this.physics();
    if (!phys) return 'rock';
    phys.toGrid(this.pos, this.tmpG);
    const b = phys.world.getBlock(this.tmpG.face, Math.floor(this.tmpG.x), Math.floor(this.tmpG.y), Math.floor(this.tmpG.z - 0.55));
    return BLOCKS[b].sound;
  }

  private updateCamera(dt: number): void {
    const U = this.up, F = this.forward, R = this.right();
    const L = F.clone().multiplyScalar(Math.cos(this.pitch)).addScaledVector(U, Math.sin(this.pitch)).normalize();
    this.lookDir.copy(L);
    const bobOn = this.game.settings.controls.headBob && this.grounded;
    const bobY = bobOn ? Math.sin(this.bob * 2) * 0.03 : 0;
    const head = this.pos.clone().addScaledVector(U, EYE + this.stepSmooth + bobY - this.landImpact * 0.6);
    if (this.firstPerson) {
      this.camPos.copy(head).addScaledVector(L, 0.12);
    } else {
      const pivot = this.pos.clone().addScaledVector(U, 1.55 + this.stepSmooth * 0.5);
      const desired = pivot.clone().addScaledVector(L, -this.camDist).addScaledVector(R, 0.55).addScaledVector(U, 0.35);
      const dir = desired.clone().sub(pivot);
      let dist = dir.length();
      dir.normalize();
      const phys = this.physics();
      if (phys) {
        const hit = phys.raycast(pivot, dir, dist + 0.3, false);
        if (hit) dist = Math.max(0.5, hit.dist - 0.3);
      }
      const target = pivot.addScaledVector(dir, dist);
      this.camPos.lerp(target, 1 - Math.exp(-dt * 18));
      if (this.camPos.distanceTo(target) > 3) this.camPos.copy(target);
    }
    const camZ = L.clone().negate();
    const camX = R.clone();
    const camY = new THREE.Vector3().crossVectors(camZ, camX).normalize();
    const m = new THREE.Matrix4().makeBasis(camX, camY, camZ);
    this.camQuat.setFromRotationMatrix(m);
    void dt;
  }

  // ---------------------------------------------------------------- interaction
  private interact(dt: number): void {
    const g = this.game;
    const input = g.input;
    const phys = this.physics();
    const held = this.heldItem();
    const tool = this.heldTool();
    const reach = (g.vitals.upgrades.extractorMk2 ? 7 : 5) + (this.firstPerson ? 0 : this.camDist + 0.5);
    this.target = phys ? phys.raycast(this.camPos, this.lookDir, reach) : null;
    if (this.target) {
      // canonicalise across face seams
      const c = [0, 0];
      const f = canonicalCell(this.target.face, this.target.I, this.target.J, phys!.world.params.N, c);
      this.target.face = f; this.target.I = c[0]; this.target.J = c[1];
      const pv = this.target.prev;
      const fp = canonicalCell(pv.face, pv.I, pv.J, phys!.world.params.N, c);
      pv.face = fp; pv.I = c[0]; pv.J = c[1];
    }
    this.targetMachine = this.target && this.target.block === B.MACHINE || this.target?.block === B.MACHINE_OPEN ? g.machines.at(this.target.face, this.target.I, this.target.J, this.target.K) : null;
    // ship proximity
    const hatch = g.pilot.ship.localToFrame(ShipModel.HATCH);
    this.nearShip = g.shipVisible && hatch.distanceTo(this.pos) < 4.2;

    // hotbar
    for (let i = 0; i < 9; i++) if (input.hit('Digit' + (i + 1))) g.selectHotbar(i);
    if (input.wheel !== 0 && (this.firstPerson || !input.down('AltLeft'))) g.selectHotbar((g.hotbar + (input.wheel > 0 ? 1 : 8)) % 9);
    if (input.hit('KeyF')) this.toggleFlashlight();

    // E: interact
    if (input.hit('KeyE')) {
      if (this.targetMachine) { g.useMachine(this.targetMachine); this.interactAnim = 1; }
      else if (this.nearShip) { g.enterShip(); return; }
    }
    if (input.hit('KeyR') && this.nearShip) g.openPanel('ship');

    // primary / secondary
    const lmb = input.mouse(0), lmbHit = input.mouseHit(0), rmbHit = input.mouseHit(2);
    this.mining = false;
    const blockId = held ? placeableBlock(held) : null;
    const machineType = held ? item(held).machine ?? null : null;
    // creatures in the line of fire take priority over terrain
    const creature = tool === 'extractor' && lmb ? g.fauna.raycast(this.camPos, this.lookDir, reach) : null;
    this.creatureHit = creature && (!this.target || creature.dist < this.target.dist) ? this.camPos.clone().addScaledVector(this.lookDir, creature.dist) : null;
    if (creature && this.creatureHit && g.vitals.energy > 0) {
      g.fauna.hurt(creature.c, 22 * dt);
      this.mining = true;
      if (Math.random() < dt * 20) g.effects.sparksAt(this.creatureHit, this.lookDir.clone().negate(), new THREE.Color(1.6, 0.7, 0.3), 2, 3, 1, 0.05, 0.3);
    } else if (tool === 'extractor') {
      if (lmb && this.target && g.vitals.energy > 0) this.mine(dt);
      else { this.mineProgress = Math.max(0, this.mineProgress - dt * 2); }
      if (lmb && g.vitals.energy <= 0 && lmbHit) g.toast('Energia do traje esgotada', 'var(--red)');
    } else {
      this.mineProgress = 0;
    }
    if (tool === 'scanner') {
      if (lmbHit) this.scan();
      if (rmbHit && this.target) this.analyze(this.target);
    }
    if (tool === 'flashlight' && lmbHit) this.toggleFlashlight();
    if (blockId !== null && lmbHit && this.target && phys) {
      if (STRUCTURE[blockId]) this.placeBlock(held!, blockId);
      else if (g.fillTerrain(this.target, held!, blockId)) this.buildAnim = 1;
    }
    if (machineType) {
      if (rmbHit) this.rot = (this.rot + 1) % 4;
      this.updateGhost(machineType);
      if (lmbHit && this.target) this.placeMachine(held!, machineType);
    } else this.updateGhost(null);
    if (held && item(held).kind === 'consumable' && lmbHit) g.consume(held);
    if (held && item(held).kind === 'upgrade' && lmbHit) g.installUpgrade(held);
    if (tool === 'builder' && lmbHit) g.toast('Selecione um bloco ou módulo na barra (ou TAB › Construção)');
    this.scanCooldown -= dt;
    if (this.scanT >= 0) {
      this.scanT += dt;
      if (this.scanT > 3.2) this.scanT = -1;
    }
  }

  private mine(dt: number): void {
    const g = this.game;
    const t = this.target!;
    const key = `${t.face},${t.I},${t.J},${t.K}`;
    if (key !== this.mineKey) { this.mineKey = key; this.mineProgress = 0; }
    this.mining = true;
    // machines: deconstruct
    if (this.targetMachine) {
      this.mineProgress += dt / 1.2;
      if (this.mineProgress >= 1) {
        g.pickupMachine(this.targetMachine);
        this.mineProgress = 0;
      }
      return;
    }
    const def = BLOCKS[t.block];
    if (!isFinite(def.hardness)) {
      if (Math.random() < dt * 2) g.toast(`${def.name}: indestrutível`, 'var(--amber)');
      return;
    }
    const tierSpeed = g.vitals.upgrades.extractorMk2 ? 2.1 : 1;
    if (Math.random() < dt * 14) g.audio.miningTick();
    // sparks at hit point
    const col = this.blockColor(t.block);
    const n = t.normal;
    if (Math.random() < dt * 30) g.effects.sparksAt(t.point, n, new THREE.Color(1.6, 0.9, 0.4), 2, 3, 1, 0.04, 0.35);
    if (Math.random() < dt * 10) g.effects.sparksAt(t.point, n, col.clone().multiplyScalar(0.4), 1, 1, 0.5, 0.08, 0.6, 2);
    if (STRUCTURE[t.block]) {
      // built pieces come apart one cube at a time
      this.mineProgress += (dt * tierSpeed) / Math.max(0.15, def.hardness);
      if (this.mineProgress >= 1) {
        this.mineProgress = 0;
        g.breakBlock(t);
      }
      return;
    }
    // natural ground: the beam carves a smooth crater continuously
    this.mineKey = '';
    const rate = (dt * tierSpeed) / Math.max(0.2, def.hardness);
    this.digAcc += rate;
    this.sinceRemove += rate;
    this.digTimer -= dt;
    if (this.digTimer <= 0) {
      this.digTimer = 0.1;
      const removed = g.digTerrain(t, this.digAcc * 0.3);
      this.digAcc = 0;
      if (removed > 0) this.sinceRemove = 0;
    }
    this.mineProgress = Math.min(1, this.sinceRemove / 0.8);
  }

  blockColor(b: number): THREE.Color {
    const L = LAYERS[BLOCKS[b].top];
    return new THREE.Color(srgbToLinear(L.color[0] * 0.7 + L.accent[0] * 0.3), srgbToLinear(L.color[1] * 0.7 + L.accent[1] * 0.3), srgbToLinear(L.color[2] * 0.7 + L.accent[2] * 0.3));
  }

  private scan(): void {
    const g = this.game;
    if (this.scanCooldown > 0) return;
    if (!g.vitals.drainEnergy(5)) { g.toast('Energia insuficiente para o pulso', 'var(--red)'); g.audio.ui('error'); return; }
    this.scanCooldown = 3.2;
    this.scanT = 0;
    g.audio.scan();
    g.onScan();
  }

  private analyze(t: RayHit): void {
    const d = BLOCKS[t.block];
    const g = this.game;
    if (t.block === B.MACHINE) return;
    g.toast(`${d.name} · dureza ${isFinite(d.hardness) ? d.hardness.toFixed(1) : '∞'}${d.drop ? ' · rende ' + item(d.drop).name : ''}${d.radiation > 0 ? ' · ☢ radioativo' : ''}`, 'var(--cyan)');
    g.audio.ui('click');
  }

  private playerOccupies(face: number, I: number, J: number, K: number): boolean {
    const phys = this.physics()!;
    const g = this.tmpG;
    phys.toGrid(this.pos, g);
    if (g.face !== face) {
      const c = phys.cellCenter(face, I, J, K);
      return c.distanceTo(this.pos.clone().addScaledVector(this.up, 0.9)) < 1.3;
    }
    const hw = HALF_W;
    return I >= Math.floor(g.x - hw) && I <= Math.floor(g.x + hw) && J >= Math.floor(g.y - hw) && J <= Math.floor(g.y + hw) && K >= Math.floor(g.z) && K <= Math.floor(g.z + HEIGHT);
  }

  private placeBlock(itemId: string, block: number): void {
    const g = this.game;
    const phys = this.physics()!;
    const p = this.target!.prev;
    if (this.playerOccupies(p.face, p.I, p.J, p.K)) return;
    if (phys.world.getBlock(p.face, p.I, p.J, p.K) !== B.AIR) return;
    if (!g.inventory.remove(itemId, 1)) return;
    phys.world.setBlock(p.face, p.I, p.J, p.K, block);
    g.universe.dirtyEdits.add(phys.world.bodyId);
    g.audio.place();
    this.buildAnim = 1;
    g.stats.placed = (g.stats.placed ?? 0) + 1;
    const c = phys.cellCenter(p.face, p.I, p.J, p.K);
    g.effects.sparksAt(c, this.up, new THREE.Color(0.4, 0.9, 1.2), 10, 1.5, 0, 0.06, 0.4);
    if (block === B.LAMP) g.registerLamp(p.face, p.I, p.J, p.K);
  }

  private updateGhost(type: MachineType | null): void {
    const g = this.game;
    const eff = g.effects;
    if (type !== this.ghostType) {
      if (this.ghostModel) eff.ghost.remove(this.ghostModel);
      this.ghostModel = null;
      this.ghostType = type;
      if (type) {
        this.ghostModel = buildMachineModel(type);
        this.ghostModel.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = this.ghostMat; m.castShadow = false; } });
        eff.ghost.add(this.ghostModel);
      }
    }
    const phys = this.physics();
    if (!type || !this.ghostModel || !this.target || !phys) { eff.ghost.visible = false; return; }
    const p = this.target.prev;
    const ok = g.machines.canPlace(type, p.face, p.I, p.J, p.K) && !this.playerOccupies(p.face, p.I, p.J, p.K) && !(machineHeight(type) > 1 && this.playerOccupies(p.face, p.I, p.J, p.K + 1));
    const mx = new THREE.Matrix4();
    g.machines.frameAt(p.face, p.I, p.J, p.K, this.rot, mx);
    this.ghostModel.matrixAutoUpdate = false;
    this.ghostModel.matrix.copy(mx);
    this.ghostModel.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = ok ? this.ghostMat : this.ghostBad; });
    eff.ghost.visible = true;
  }

  private placeMachine(itemId: string, type: MachineType): void {
    const g = this.game;
    const p = this.target!.prev;
    if (this.playerOccupies(p.face, p.I, p.J, p.K)) return;
    if (!g.machines.canPlace(type, p.face, p.I, p.J, p.K)) { g.audio.ui('error'); g.toast('Posição inválida: precisa de solo firme e espaço livre', 'var(--red)'); return; }
    if (!g.inventory.remove(itemId, 1)) return;
    g.machines.place(type, p.face, p.I, p.J, p.K, this.rot);
    g.universe.dirtyEdits.add(this.physics()!.world.bodyId);
    g.audio.place();
    this.buildAnim = 1;
    g.onMachinePlaced(type);
  }

  toggleFlashlight(): void {
    if (!this.flashlightOn && this.game.vitals.energy <= 0) { this.game.toast('Sem energia para a lanterna', 'var(--red)'); return; }
    this.flashlightOn = !this.flashlightOn;
    this.game.audio.ui('click');
  }

  // ---------------------------------------------------------------- visuals
  private updateVisuals(dt: number): void {
    const g = this.game;
    const rig = this.model.rig;
    // body transform (frame space)
    const U = this.up, F = this.forward;
    const X = new THREE.Vector3().crossVectors(U, F).normalize();
    const m = new THREE.Matrix4().makeBasis(X, U, F);
    rig.root.position.copy(this.pos);
    rig.root.quaternion.setFromRotationMatrix(m);
    rig.root.visible = this.visible;
    const fp = this.firstPerson;
    // in first person the body only casts shadows (layer 1)
    const layer = fp ? 1 : 0;
    if (rig.root.userData.layer !== layer) {
      rig.root.userData.layer = layer;
      rig.root.traverse((o) => o.layers.set(layer));
    }
    const vh = this.vel.clone().addScaledVector(U, -this.vel.dot(U));
    this.buildAnim = Math.max(0, this.buildAnim - dt * 3);
    this.interactAnim = Math.max(0, this.interactAnim - dt * 2.5);
    this.landImpact = Math.max(0, this.landImpact - dt * 1.5);
    const tool = this.heldTool();
    const held = this.heldItem();
    const s: AnimState = {
      speed: vh.length(), running: vh.length() > 5.5, grounded: this.grounded, vertical: this.vel.dot(U), swimming: this.swimming,
      zeroG: this.zeroG, gravity: this.gravity(), mining: this.mining, building: this.buildAnim, interact: this.interactAnim,
      landImpact: this.landImpact > 0.01 ? this.landImpact : 0, lookPitch: this.pitch, holding: !!tool && tool !== 'flashlight', seated: false,
    };
    this.animator.update(dt, s);
    // tool models
    const toolKey = tool && tool !== 'flashlight' ? tool : held && placeableBlock(held) !== null ? 'builder' : 'none';
    if (toolKey !== this.tpToolId) {
      this.tpToolId = toolKey;
      this.tpTool.clear();
      this.tpTool.add(buildTool(toolKey as ToolId));
      this.tpTool.traverse((o) => o.layers.set(layer));
    }
    if (toolKey !== this.vmToolId) {
      this.vmToolId = toolKey;
      this.vmTool.clear();
      const t = buildTool(toolKey as ToolId);
      t.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh) {
          mm.material = (mm.material as THREE.Material).clone();
          (mm.material as THREE.Material).depthTest = false;
          mm.renderOrder = 10;
          mm.castShadow = false;
        }
      });
      this.vmTool.add(t);
    }
    // view model placement (render space; camera at origin)
    this.view.visible = fp && this.visible && !this.swimming;
    if (this.view.visible) {
      this.view.quaternion.copy(this.camQuat);
      this.view.position.set(0, 0, 0);
      const sway = Math.sin(this.bob) * 0.012 * Math.min(1, vh.length() / 4);
      const mineShake = this.mining ? (Math.random() - 0.5) * 0.006 : 0;
      const swing = Math.sin(this.buildAnim * Math.PI) * 0.12 + Math.sin(this.interactAnim * Math.PI) * 0.1;
      this.vmArm.position.set(0.27 + sway + mineShake, -0.27 + Math.abs(sway) * 0.6 - swing * 0.3 + mineShake, -0.42 - swing * 0.2);
      this.vmArm.rotation.set(0.12 - swing, 0.08, 0);
      this.vmArm.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && !mm.userData.vmFixed) {
          mm.userData.vmFixed = true;
          mm.material = (mm.material as THREE.Material).clone();
          (mm.material as THREE.Material).depthTest = false;
          mm.renderOrder = 9;
          mm.castShadow = false;
        }
      });
      // light the view model like the world
      const [vSun, vHemi] = this.vmLights as [THREE.DirectionalLight, THREE.HemisphereLight];
      vSun.color.copy(g.universe.sun.color);
      vSun.intensity = g.universe.sun.intensity;
      vSun.position.copy(g.universe.sunDir).multiplyScalar(10);
      vHemi.color.copy(g.universe.hemi.color);
      vHemi.groundColor.copy(g.universe.hemi.groundColor);
      vHemi.intensity = g.universe.hemi.intensity;
    }
    // mining beam
    const beamTo = this.creatureHit ?? (this.target && !this.targetMachine ? this.target.point : null);
    if (this.mining && beamTo) {
      const tip = new THREE.Vector3();
      if (fp) {
        this.view.updateMatrixWorld(true);
        toolMuzzle(this.vmTool, tip); // render space
        tip.add(this.game.player.camPos);
      } else {
        rig.root.updateMatrixWorld(true);
        toolMuzzle(this.tpTool, tip);
        tip.add(this.game.player.camPos);
      }
      g.effects.setBeam(tip, beamTo, null, g.universe.time);
    } else g.effects.setBeam(null, null, null, 0);
    // flashlight
    const fl = this.flashlight;
    if (this.flashlightOn && g.vitals.energy <= 0) this.flashlightOn = false;
    fl.intensity = this.flashlightOn ? 70 : 0;
    const lampPos = this.pos.clone().addScaledVector(U, 1.7).addScaledVector(F, 0.25);
    // the lit patch drives eye adaptation: report its illuminance to the exposure cap
    let local = 0;
    if (this.flashlightOn) {
      const phys = this.physics();
      const hit = phys ? phys.raycast(lampPos, this.lookDir, 30) : null;
      const d = Math.max(1.5, hit ? hit.dist : 30);
      local = (fl.intensity / Math.pow(d, fl.decay)) * 0.5;
    }
    g.universe.localLight = local;
    fl.position.copy(lampPos);
    fl.target.position.copy(lampPos).addScaledVector(this.lookDir, 10);
    this.model.setLightsOn(this.flashlightOn || g.universe.sunElevation < 0);
  }

  serialize(): { pos: number[]; vel: number[]; forward: number[]; pitch: number } {
    return { pos: this.pos.toArray(), vel: this.vel.toArray(), forward: this.forward.toArray(), pitch: this.pitch };
  }

  /** Re-express state in a new reference frame. */
  transformFrame(pos: (p: THREE.Vector3) => THREE.Vector3, vel: (p: THREE.Vector3, v: THREE.Vector3) => THREE.Vector3, rot: THREE.Quaternion): void {
    const p0 = this.pos.clone();
    this.vel.copy(vel(p0, this.vel));
    this.pos.copy(pos(p0));
    this.forward.applyQuaternion(rot);
    this.up.applyQuaternion(rot);
  }
}

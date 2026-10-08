import * as THREE from 'three';
import { Ship, SPEED_LEVELS, type ShipControls, type ShipEnv } from '../ship/Ship';
import { ShipModel } from '../ship/ShipModel';
import { BLOCK_SOLID } from '../voxel/blocks';
import type { ShipHudState } from '../ui/HUD';
import type { Game } from './Game';
import { TYPE_LABEL } from '../universe/planetTypes';

/**
 * Ship piloting: input mapping (virtual stick), environment (gravity, air
 * density, altitude), terrain collision and landing, cameras, cockpit screens
 * and HUD data.
 */

export class Pilot {
  readonly game: Game;
  readonly ship: Ship;
  stick = new THREE.Vector2();
  cockpitView = true;
  camPos = new THREE.Vector3();
  camQuat = new THREE.Quaternion();
  private chasePos = new THREE.Vector3();
  private chaseInit = false;
  private screenTimer = 0;
  private shake = 0;
  altitude = 0;
  private supportTimer = 0;
  surfaceDistance = 1e9;
  density = 0;
  landingLight = false;
  private contactTimer = 0;
  private smokeT = 0;
  impactFlash = 0;
  lastLandedBody: string | null = null;
  docked = false;
  private dockPrev = new THREE.Vector3();
  private dockVel = new THREE.Vector3();
  private dockServiceT = -1e9;
  dockAvailable = false;
  readonly env: ShipEnv = { gravity: new THREE.Vector3(), up: new THREE.Vector3(), density: 0, altitude: 0, surfaceDistance: 1e9 };

  constructor(game: Game) {
    this.game = game;
    this.ship = new Ship();
    game.universe.frameRoot.add(this.ship.model.parts.root);
  }

  // ------------------------------------------------------------------ environment
  private updateEnv(): void {
    const g = this.game;
    const s = this.ship;
    const frame = g.universe.frame;
    const env = this.env;
    env.gravity.set(0, 0, 0);
    env.up.set(0, 0, 0);
    env.density = 0;
    if (frame) {
      const r = s.pos.length();
      env.up.copy(s.pos).normalize();
      const gm = frame.def.gravity * (frame.radius / Math.max(r, frame.radius * 0.5)) ** 2;
      env.gravity.copy(env.up).multiplyScalar(-gm);
      const surf = this.surfaceRadiusAt(s.pos);
      this.altitude = r - surf;
      // near the ground, measure against the real voxels (rocks, ice, trees, buildings)
      const phys = g.universe.focus?.body === frame ? g.universe.focus.physics : null;
      if (phys && this.altitude < 300) {
        const down = env.up.clone().negate();
        const reach = Math.max(8, this.altitude + 40);
        let best = Infinity;
        const hit = phys.raycast(s.pos, down, reach, false);
        if (hit) best = hit.dist;
        // the gear may rest on a ledge while the centre hangs over a gap
        for (const f of ShipModel.FEET) {
          const fp = s.localToFrame(new THREE.Vector3(f.x, 0, f.z));
          const fh = phys.raycast(fp, down, reach, false);
          if (fh) best = Math.min(best, fh.dist + (fp.clone().sub(s.pos).dot(down)));
        }
        if (best < Infinity) this.altitude = best;
      }
      const atm = frame.def.atmosphere;
      if (atm) {
        const h = Math.max(0, r - frame.radius);
        env.density = h > atm.height ? 0 : Math.exp(-h / (atm.rayleighScale * 1.6)) * Math.min(2, atm.pressure);
      }
      this.surfaceDistance = Math.max(1, r - frame.radius);
    } else {
      // system frame: nearest body determines gravity and distance
      const sysPos = s.pos;
      let best = 1e12;
      for (const b of g.universe.system.bodies) {
        const d = b.pos.distanceTo(sysPos) - b.radius;
        if (d < best) best = d;
        const dist = b.pos.distanceTo(sysPos);
        if (dist < b.radius * 4) {
          const gm = b.def.gravity * (b.radius / dist) ** 2;
          env.gravity.addScaledVector(b.pos.clone().sub(sysPos).normalize(), gm);
        }
      }
      const sd = sysPos.length() - g.universe.def.star.radius;
      this.surfaceDistance = Math.min(best, sd);
      this.altitude = best;
    }
    env.altitude = this.altitude;
    env.surfaceDistance = this.surfaceDistance;
    this.density = env.density;
  }

  surfaceRadiusAt(p: THREE.Vector3): number {
    const f = this.game.universe.focus;
    const frame = this.game.universe.frame;
    if (!frame) return 0;
    if (f && f.body === frame) return f.surfaceRadius(p.clone().normalize());
    return frame.radius;
  }

  /** Penetration depth of a frame-space point into terrain (>0 = inside). */
  private penetration(p: THREE.Vector3): number {
    const g = this.game;
    const f = g.universe.focus;
    const frame = g.universe.frame;
    if (!frame) {
      // collide with any body sphere in system frame
      for (const b of g.universe.system.bodies) {
        const d = b.radius - b.pos.distanceTo(p);
        if (d > 0) return d;
      }
      return 0;
    }
    if (f && f.body === frame && f.physics) {
      const gp = { face: 0, x: 0, y: 0, z: 0 };
      f.physics.toGrid(p, gp);
      const w = f.physics.world;
      if (w.sample(gp.face, gp.x, gp.y, gp.z) >= 0.5) {
        // depth to the surface above this point (max 3)
        const top = w.surfaceBelow(gp.face, gp.x, gp.y, gp.z + 3, 3.2);
        return Math.max(0.02, top - gp.z);
      }
      // slightly above the surface: negative distance (for gear contact)
      const below = w.surfaceBelow(gp.face, gp.x, gp.y, gp.z, 0.3);
      return below === -Infinity ? -1 : below - gp.z;
    }
    return this.surfaceRadiusAt(p) - p.length();
  }

  // ------------------------------------------------------------------ update
  update(dt: number, controls: boolean): void {
    const g = this.game;
    const s = this.ship;
    const input = g.input;
    this.updateEnv();
    const c: ShipControls = { pitch: 0, yaw: 0, roll: 0, forward: 0, strafe: 0, lift: 0, boost: false, brake: false };
    if (controls && g.mode === 'ship') {
      const inv = g.settings.controls.shipInvertY ? -1 : 1;
      if (input.locked) {
        this.stick.x += input.mouseDX * 0.0028 * g.settings.controls.sensitivity;
        this.stick.y += input.mouseDY * 0.0028 * g.settings.controls.sensitivity * inv;
      }
      if (this.stick.length() > 1) this.stick.normalize();
      // spring back toward centre
      this.stick.multiplyScalar(1 - Math.min(1, dt * 1.6));
      const dz = (v: number) => (Math.abs(v) < 0.04 ? 0 : v);
      c.yaw = -dz(this.stick.x);
      c.pitch = -dz(this.stick.y);
      if (input.down('KeyA')) c.yaw += 0.8;
      if (input.down('KeyD')) c.yaw -= 0.8;
      if (input.down('KeyQ')) c.roll += 1;
      if (input.down('KeyE') && !s.landed) c.roll -= 1;
      if (input.down('KeyW')) c.forward += 1;
      if (input.down('KeyS')) c.forward -= 1;
      if (input.down('Space')) c.lift += 1;
      if (input.down('KeyC') || input.down('ControlLeft')) c.lift -= 1;
      c.boost = input.down('ShiftLeft');
      c.brake = input.down('KeyB');
      if (input.hit('KeyR')) this.toggleEngine();
      // speed level: 1-5 or mouse wheel
      for (let i = 0; i < SPEED_LEVELS.length; i++) if (input.hit(`Digit${i + 1}`)) this.setSpeedLevel(i);
      if (input.wheel !== 0) this.setSpeedLevel(s.speedLevel + (input.wheel < 0 ? 1 : -1));
      if (input.hit('KeyX')) { s.gearDown = !s.gearDown; g.toast(s.gearDown ? 'Trem de pouso baixado' : 'Trem de pouso recolhido'); }
      if (input.hit('KeyZ')) { s.assist = !s.assist; g.toast(s.assist ? 'Assistência de voo ativada' : 'Assistência de voo DESATIVADA', s.assist ? undefined : 'var(--amber)'); }
      if (input.hit('KeyL')) this.landingLight = !this.landingLight;
      if (input.hit('KeyV')) { this.cockpitView = !this.cockpitView; this.chaseInit = false; }
      if (input.hit('KeyT')) this.toggleCruise();
      if (input.hit('KeyJ')) g.requestWarp();
      if (input.hit('KeyE') && s.landed) { g.exitShip(); return; }
      if (input.hit('KeyE') && !s.landed && (this.env.gravity.lengthSq() < 0.01 || s.vel.length() < 1.5)) {
        if (this.altitude < 3 || this.env.gravity.lengthSq() < 0.01) { g.exitShip(); return; }
      }
    }
    // station docking
    if (this.updateDocking(dt, controls && g.mode === 'ship')) return;
    // cruise auto-disengage
    if (s.cruise) {
      const frame = g.universe.frame;
      const atmTop = frame?.def.atmosphere ? frame.def.atmosphere.height : 300;
      if (frame && this.altitude < atmTop + 600) { this.dropCruise('Motor de cruzeiro desengatado: proximidade planetária'); }
      if (c.forward < 0 || c.brake) this.dropCruise('Motor de cruzeiro desengatado');
    }
    // take-off
    if (s.landed && s.engineOn && s.canFly && (c.lift > 0 || c.forward > 0.5)) {
      s.landed = false;
      g.audio.thrusterPuff();
    }
    // a landed ship whose ground vanished (mined away, or streamed-in terrain lower
    // than the estimate it touched down on) starts falling again
    if (s.landed && !this.docked && this.env.gravity.lengthSq() > 0.01) {
      this.supportTimer -= dt;
      if (this.supportTimer <= 0) {
        this.supportTimer = 0.25;
        let support = 0;
        for (const lf of ShipModel.FEET) if (this.penetration(s.localToFrame(lf.clone().add(new THREE.Vector3(0, -0.3, 0)))) > 0) support++;
        if (support < 2) { s.landed = false; this.contactTimer = 0; }
      }
    }
    const wasLanded = s.landed;
    s.update(dt, c, this.env);
    if (!s.landed) this.collide(dt);
    if (s.landed && !wasLanded) {
      g.audio.landing();
      g.onShipLanded();
    }
    // damage smoke while broken
    this.smokeT -= dt;
    if (s.damaged && this.smokeT <= 0) {
      this.smokeT = 0.08;
      const p = s.localToFrame(new THREE.Vector3(1.95, 0.6, 4.2));
      const up = this.env.up.lengthSq() > 0 ? this.env.up : s.upVec();
      const amb = g.universe.ambient;
      const shade = 0.15 + (amb.x + amb.y) * 0.4;
      g.effects.sparksAt(p, up, new THREE.Color(shade * 0.3, shade * 0.3, shade * 0.32), 1, 0.6, -0.08, 0.6, 3.2, 0.4);
      if (Math.random() < 0.08) g.effects.sparksAt(s.localToFrame(new THREE.Vector3(-1.6, 0.2, 1.0)), up, new THREE.Color(3, 1.6, 0.5), 6, 3, 1, 0.04, 0.4);
    }
    // ground dust from thrusters
    if (!s.landed && s.engineOn && this.altitude < 18 && this.density > 0.05 && Math.random() < 0.6) {
      const down = this.env.up.clone().negate();
      const p = s.pos.clone().addScaledVector(down, Math.max(0, this.altitude - 0.5));
      g.effects.sparksAt(p.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6)), this.env.up, new THREE.Color(0.15, 0.13, 0.11).multiplyScalar(0.3 + g.universe.sunAtObserver.y * 0.05), 2, 4, 0.05, 0.9, 2, 0.6);
    }
    s.model.update(g.universe.time, s.throttleVis, s.gearT, s.heat, this.landingLight || (g.universe.sunElevation < 0.05 && s.gearDown && this.altitude < 200 && s.engineOn), s.damaged);
    this.updateModelTransform();
  }

  /** Returns true when docked (ship is attached to the station this frame). */
  private updateDocking(dt: number, controls: boolean): boolean {
    const g = this.game;
    const u = g.universe;
    const s = this.ship;
    this.dockAvailable = false;
    if (!u.station) { this.docked = false; return false; }
    const dockF = u.system.posFromSystem(u.frame, u.stationDockSys(), new THREE.Vector3());
    if (this.dockPrev.lengthSq() > 0 && dt > 0) this.dockVel.copy(dockF).sub(this.dockPrev).divideScalar(dt);
    this.dockPrev.copy(dockF);
    const qF = u.system.quatFromSystem(u.frame, u.stationQuat, new THREE.Quaternion());
    if (this.docked) {
      s.pos.copy(dockF);
      s.vel.copy(this.dockVel);
      s.quat.slerp(qF.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)), Math.min(1, dt * 2));
      s.cruise = false;
      if (controls && (g.input.hit('KeyE') || g.input.down('KeyW'))) {
        this.docked = false;
        s.vel.addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(qF), -6);
        g.toast('Desacoplado da estação');
        g.audio.thrusterPuff();
      }
      s.model.update(u.time, 0, s.gearT, 0, false, s.damaged);
      this.updateModelTransform();
      return true;
    }
    const rel = s.vel.clone().sub(this.dockVel).length();
    if (dockF.distanceTo(s.pos) < 60 && rel < 30) {
      this.dockAvailable = true;
      if (controls && g.input.hit('KeyE')) {
        this.docked = true;
        g.audio.landing();
        g.hud.centerMessage('Acoplado', 'Estação orbital — serviços disponíveis', 3);
        g.discover({ id: 'station', kind: 'structure', title: `Estação orbital (${u.def.name})`, text: 'Estação de pesquisa automatizada em órbita. Os sistemas de suporte ainda respondem: combustível, oxigênio e reparos básicos disponíveis.', time: Date.now(), systemId: u.def.id });
        if (u.time - this.dockServiceT > 1200) {
          this.dockServiceT = u.time;
          s.fuel = 100;
          s.o2Reserve = 800;
          s.hull = Math.min(100, s.hull + 30);
          g.vitals.refill(999, 999);
          g.toast('Serviços da estação: combustível, O₂ e reparos', 'var(--green)');
        } else g.toast('Reservas da estação ainda reabastecendo', 'var(--amber)');
        return true;
      }
    }
    return false;
  }

  setSpeedLevel(i: number): void {
    const s = this.ship;
    const n = Math.max(0, Math.min(SPEED_LEVELS.length - 1, i));
    if (n === s.speedLevel) return;
    s.speedLevel = n;
    const lv = SPEED_LEVELS[n];
    this.game.audio.ui('click');
    this.game.toast(`Velocidade: ${lv.name} · até ${lv.max >= 1000 ? (lv.max / 1000).toFixed(1) + ' km/s' : lv.max + ' m/s'}`, 'var(--cyan)');
  }

  private toggleEngine(): void {
    const g = this.game;
    const s = this.ship;
    if (s.engineOn) {
      if (!s.landed && this.env.gravity.lengthSq() > 0.01 && this.altitude > 4) { g.toast('Desligar o motor em voo causaria queda — pouse primeiro', 'var(--amber)'); g.audio.ui('error'); return; }
      s.engineOn = false;
      s.cruise = false;
      g.toast('Motores desligados');
      return;
    }
    if (!s.powerOnline) { g.toast('Sem energia: instale uma Célula de Energia (painel da nave, R)', 'var(--red)'); g.audio.alarm(); return; }
    if (!s.thrustersOnline) { g.toast('Propulsores avariados: instale o Acoplamento de Propulsor', 'var(--red)'); g.audio.alarm(); return; }
    if (s.hull <= 20) { g.toast('Integridade do casco crítica', 'var(--red)'); g.audio.alarm(); return; }
    if (s.fuel <= 0) { g.toast('Sem combustível', 'var(--red)'); g.audio.alarm(); return; }
    s.engineOn = true;
    g.audio.thrusterPuff();
    g.hud.centerMessage('Sistemas online', 'Motores principais ativos', 2.5);
  }

  private toggleCruise(): void {
    const g = this.game;
    const s = this.ship;
    if (s.cruise) { this.dropCruise('Motor de cruzeiro desengatado'); return; }
    const frame = g.universe.frame;
    const atmTop = frame?.def.atmosphere ? frame.def.atmosphere.height : 300;
    if (!s.engineOn) { g.toast('Ligue os motores (R)', 'var(--amber)'); return; }
    if (frame && this.altitude < atmTop + 800) { g.toast('Cruzeiro indisponível: saia da atmosfera / afaste-se da superfície', 'var(--amber)'); g.audio.ui('error'); return; }
    if (s.fuel < 1) { g.toast('Combustível insuficiente', 'var(--red)'); return; }
    s.cruise = true;
    s.cruiseSpeed = s.vel.length();
    g.toast('Motor de cruzeiro engatado', 'var(--cyan)');
    g.audio.thrusterPuff();
  }

  dropCruise(msg: string): void {
    const s = this.ship;
    if (!s.cruise) return;
    s.cruise = false;
    s.vel.setLength(Math.min(s.vel.length(), 420));
    this.game.toast(msg, 'var(--amber)');
  }

  private collide(dt: number): void {
    const g = this.game;
    const s = this.ship;
    const up = this.env.up.lengthSq() > 0 ? this.env.up.clone() : s.upVec();
    const speed = s.vel.length();
    // hull probes
    let maxPen = 0;
    for (const lp of ShipModel.HULL_PROBES) {
      const p = s.localToFrame(lp);
      const pen = this.penetration(p);
      if (pen > maxPen) maxPen = pen;
    }
    let feetContact = 0, feetPen = 0;
    if (s.gearT > 0.9) {
      for (const lf of ShipModel.FEET) {
        const pen = this.penetration(s.localToFrame(lf));
        if (pen > -0.05) feetContact++;
        feetPen = Math.max(feetPen, pen);
      }
    }
    const vDown = -s.vel.dot(up);
    if (maxPen > 0 && (maxPen > feetPen + 0.1 || s.gearT < 0.9)) {
      // hull strike
      s.pos.addScaledVector(up, maxPen + 0.02);
      if (speed > 4 && !s.unlimited) {
        const dmg = (speed - 4) * 2.4;
        s.hull = Math.max(0, s.hull - dmg);
        g.audio.landing();
        g.audio.alarm();
        this.impactFlash = 1;
        g.toast(`Impacto! Casco -${Math.round(dmg)}%`, 'var(--red)');
        if (s.cruise) s.cruise = false;
      }
      const vn = s.vel.dot(up);
      if (vn < 0) s.vel.addScaledVector(up, -vn * 1.4);
      s.vel.multiplyScalar(0.6);
    }
    if (feetPen > 0) {
      s.pos.addScaledVector(up, feetPen);
      if (vDown > 0) {
        if (vDown > 7 && !s.unlimited) {
          const dmg = (vDown - 7) * 3;
          s.hull = Math.max(0, s.hull - dmg);
          g.toast(`Pouso duro! Casco -${Math.round(dmg)}%`, 'var(--amber)');
        }
        s.vel.addScaledVector(up, vDown);
      }
      // friction on the ground
      s.vel.multiplyScalar(1 - Math.min(1, dt * 4));
    }
    // settle: all feet on ground and slow
    if (feetContact >= 3 && s.vel.length() < 2.5 && this.env.gravity.lengthSq() > 0.01) {
      this.contactTimer += dt;
      // align to surface
      const sUp = s.upVec();
      const q = new THREE.Quaternion().setFromUnitVectors(sUp, up);
      const qs = new THREE.Quaternion().slerp(q, Math.min(1, dt * 3));
      s.quat.premultiply(qs).normalize();
      if (this.contactTimer > 0.6 && (!s.engineOn || this.idleThrottle())) {
        s.landed = true;
        s.vel.set(0, 0, 0);
        s.angVel.set(0, 0, 0);
        s.cruise = false;
      }
    } else this.contactTimer = 0;
  }

  private idleThrottle(): boolean {
    const i = this.game.input;
    return !i.down('Space') && !i.down('KeyW');
  }

  updateModelTransform(): void {
    const r = this.ship.model.parts.root;
    r.position.copy(this.ship.pos);
    r.quaternion.copy(this.ship.quat);
  }

  // ------------------------------------------------------------------ cameras
  updateCamera(dt: number): void {
    const s = this.ship;
    this.shake = Math.max(s.heat * 0.6, s.throttleVis * (s.cruise ? 0.3 : 0.06), this.impactFlash);
    this.impactFlash = Math.max(0, this.impactFlash - dt * 2);
    const jitter = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), 0).multiplyScalar(this.shake * 0.04);
    if (this.cockpitView) {
      this.camPos.copy(s.localToFrame(ShipModel.EYE.clone().add(jitter)));
      this.camQuat.copy(s.quat);
      s.model.setCockpitVisible(true);
    } else {
      const back = new THREE.Vector3(0, 4.2, 17).applyQuaternion(s.quat).add(s.pos);
      if (!this.chaseInit) { this.chasePos.copy(back); this.chaseInit = true; }
      // smooth follow, but never lag far behind fast motion
      this.chasePos.lerp(back, 1 - Math.exp(-dt * 6));
      this.chasePos.addScaledVector(s.vel, dt);
      if (this.chasePos.distanceTo(back) > 40) this.chasePos.copy(back);
      this.camPos.copy(this.chasePos).add(jitter.multiplyScalar(4));
      const look = s.pos.clone().addScaledVector(s.forward(), 18);
      const m = new THREE.Matrix4().lookAt(this.camPos, look, s.upVec());
      this.camQuat.setFromRotationMatrix(m);
      s.model.setCockpitVisible(false);
    }
    this.screenTimer -= dt;
    if (this.screenTimer <= 0 && this.cockpitView) {
      this.screenTimer = 0.2;
      this.drawScreens();
    }
  }

  private drawScreens(): void {
    const s = this.ship;
    const cv = s.model.parts.screenCanvas;
    const g = cv.getContext('2d')!;
    const PW = 1024 / 3;
    const CY = '#5fe1ff', INK = '#e8f1f8', DIM = '#7f93a3', AMB = '#ffb547', GRN = '#7dffb0', RED = '#ff5a4f';
    g.fillStyle = '#02070b';
    g.fillRect(0, 0, 1024, 256);
    const frame = (i: number, title: string, sub = '') => {
      const x = i * PW;
      g.fillStyle = '#04101a';
      g.fillRect(x + 6, 6, PW - 12, 244);
      g.strokeStyle = 'rgba(95,225,255,0.35)';
      g.lineWidth = 2;
      g.strokeRect(x + 6, 6, PW - 12, 244);
      g.fillStyle = 'rgba(95,225,255,0.12)';
      g.fillRect(x + 6, 6, PW - 12, 30);
      g.fillStyle = CY;
      g.font = '700 20px Rajdhani, sans-serif';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(title, x + 18, 22);
      g.fillStyle = DIM;
      g.textAlign = 'right';
      g.font = '14px JetBrains Mono, monospace';
      g.fillText(sub, x + PW - 18, 22);
      return x;
    };
    // --- flight
    const lv = SPEED_LEVELS[s.speedLevel];
    let x = frame(0, 'VOO', s.cruise ? 'CRUZEIRO' : lv.name);
    const v = s.vel.length();
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = '700 58px JetBrains Mono, monospace';
    g.fillText(v >= 10000 ? (v / 1000).toFixed(1) : String(Math.round(v)), x + 20, 82);
    g.fillStyle = DIM;
    g.font = '18px JetBrains Mono, monospace';
    g.fillText(v >= 10000 ? 'km/s' : 'm/s', x + 250, 92);
    // speed level bar
    for (let i = 0; i < SPEED_LEVELS.length; i++) {
      g.fillStyle = i === s.speedLevel && !s.cruise ? AMB : i < s.speedLevel ? 'rgba(255,181,71,0.35)' : 'rgba(255,255,255,0.1)';
      g.fillRect(x + 20 + i * 60, 120, 54, 10);
    }
    const vs = this.env.up.lengthSq() > 0 ? s.vel.dot(this.env.up) : 0;
    g.font = '18px JetBrains Mono, monospace';
    g.fillStyle = INK;
    g.fillText(`ALT  ${this.altitude >= 10000 ? (this.altitude / 1000).toFixed(1) + ' km' : Math.round(this.altitude) + ' m'}`, x + 20, 160);
    g.fillStyle = vs < -8 ? AMB : INK;
    g.fillText(`V/S  ${vs >= 0 ? '+' : ''}${vs.toFixed(1)} m/s`, x + 20, 190);
    g.fillStyle = INK;
    g.fillText(`EMP  ${Math.round(s.throttleVis * 100)}%`, x + 20, 220);
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(x + 170, 212, 140, 12);
    g.fillStyle = s.cruise ? CY : AMB;
    g.fillRect(x + 170, 212, 140 * s.throttleVis, 12);
    // --- attitude ball
    x = frame(1, 'ATITUDE', this.env.up.lengthSq() > 0 ? '' : 'ESPAÇO');
    const up = this.env.up.lengthSq() > 0 ? this.env.up.clone().normalize().applyQuaternion(s.quat.clone().invert()) : new THREE.Vector3(0, 1, 0);
    const roll = Math.atan2(-up.x, up.y);
    const pitch = Math.asin(THREE.MathUtils.clamp(up.z, -1, 1));
    const bx = x + PW / 2, by = 146, R = 92;
    g.save();
    g.beginPath(); g.arc(bx, by, R, 0, Math.PI * 2); g.clip();
    g.translate(bx, by);
    g.rotate(roll);
    const ppr = R / 0.9; // pixels per radian
    g.fillStyle = '#16405c';
    g.fillRect(-R * 2, -R * 4 + pitch * ppr, R * 4, R * 4);
    g.fillStyle = '#4a3220';
    g.fillRect(-R * 2, pitch * ppr, R * 4, R * 4);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(-R * 2, pitch * ppr); g.lineTo(R * 2, pitch * ppr); g.stroke();
    g.lineWidth = 1.2;
    g.font = '12px JetBrains Mono, monospace';
    g.fillStyle = INK;
    g.textAlign = 'left';
    for (let d = -60; d <= 60; d += 10) {
      if (!d) continue;
      const y = pitch * ppr - THREE.MathUtils.degToRad(d) * ppr;
      const w = d % 20 === 0 ? 30 : 16;
      g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
      if (d % 20 === 0) g.fillText(String(Math.abs(d)), w + 4, y);
    }
    g.restore();
    g.strokeStyle = 'rgba(95,225,255,0.6)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(bx, by, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = AMB;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(bx - 52, by); g.lineTo(bx - 18, by); g.lineTo(bx - 10, by + 8);
    g.moveTo(bx + 52, by); g.lineTo(bx + 18, by); g.lineTo(bx + 10, by + 8);
    g.stroke();
    g.fillStyle = AMB;
    g.beginPath(); g.arc(bx, by, 3, 0, Math.PI * 2); g.fill();
    // --- systems
    x = frame(2, 'SISTEMAS', s.unlimited ? 'EXPLORADOR' : '');
    g.textAlign = 'left';
    const line = (y: number, label: string, val: number, col: string, txt: string) => {
      g.fillStyle = DIM;
      g.font = '16px JetBrains Mono, monospace';
      g.fillText(label, x + 18, y);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x + 92, y - 7, 150, 14);
      g.fillStyle = col;
      g.fillRect(x + 92, y - 7, 150 * Math.max(0, Math.min(1, val)), 14);
      g.fillStyle = INK;
      g.fillText(txt, x + 252, y);
    };
    line(60, 'COMB', s.fuel / 100, '#5fc8ff', s.unlimited ? '∞' : `${Math.round(s.fuel)}%`);
    line(90, 'CASCO', s.hull / 100, '#dfe6ee', `${Math.round(s.hull)}%`);
    line(120, 'TEMP', (s.hullTemp - 20) / 1400, '#ff7a4f', `${Math.round(s.hullTemp)}°`);
    line(150, 'O₂', s.o2Reserve / 800, '#8fe0ff', `${Math.round((s.o2Reserve / 800) * 100)}%`);
    const lamp = (cx: number, cy: number, on: boolean, label: string, warn = false) => {
      g.fillStyle = on ? (warn ? AMB : GRN) : RED;
      g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK;
      g.font = '14px JetBrains Mono, monospace';
      g.fillText(label, cx + 12, cy);
    };
    lamp(x + 26, 192, s.engineOn, 'MOTOR');
    lamp(x + 126, 192, s.assist, 'ASSIST.', false);
    lamp(x + 236, 192, s.gearDown, 'TREM', true);
    lamp(x + 26, 224, s.powerOnline, 'ENERGIA');
    lamp(x + 126, 224, s.thrustersOnline, 'PROPULS.');
    lamp(x + 236, 224, this.landingLight, 'FAROL', true);
    s.model.parts.screens.needsUpdate = true;
  }

  // ------------------------------------------------------------------ HUD
  hudState(): ShipHudState {
    const g = this.game;
    const s = this.ship;
    const cam = g.renderer.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const project = (framePos: THREE.Vector3): { x: number; y: number; on: boolean; behind: boolean } => {
      const v = framePos.clone().sub(this.camPos).applyMatrix4(cam.matrixWorldInverse);
      const behind = v.z > 0;
      const p = v.clone().applyMatrix4(cam.projectionMatrix);
      let x = (p.x * 0.5 + 0.5) * W, y = (-p.y * 0.5 + 0.5) * H;
      if (behind) { x = W - x; y = H - y; }
      const on = !behind && x > 20 && x < W - 20 && y > 20 && y < H - 20;
      return { x, y, on, behind };
    };
    // velocity marker relative to frame
    const vel = s.vel.lengthSq() > 1 ? project(this.camPos.clone().addScaledVector(s.vel.clone().normalize(), 1000)) : null;
    // horizon
    const up = this.env.up.lengthSq() > 0 ? this.env.up.clone().applyQuaternion(this.camQuat.clone().invert()) : null;
    let roll = 0, pitch = 999;
    if (up) { roll = Math.atan2(-up.x, up.y); pitch = Math.asin(THREE.MathUtils.clamp(-up.z, -1, 1)) / 1.2; }
    // navigation target
    let navMarker: ShipHudState['navMarker'] = null;
    let targetLabel: string | null = null;
    const tgt = g.navTarget ? g.universe.system.body(g.navTarget) : null;
    if (tgt) {
      const pf = g.universe.system.posFromSystem(g.universe.frame, tgt.pos, new THREE.Vector3());
      const dist = Math.max(0, pf.distanceTo(s.pos) - tgt.radius);
      const pr = project(pf);
      let x = pr.x, y = pr.y;
      if (!pr.on) {
        const cx = W / 2, cy = H / 2;
        const dx = x - cx, dy = y - cy;
        const k = Math.min((W / 2 - 60) / Math.max(1, Math.abs(dx)), (H / 2 - 60) / Math.max(1, Math.abs(dy)));
        x = cx + dx * k; y = cy + dy * k;
      }
      const sp = Math.max(1, s.vel.length());
      const eta = dist / sp;
      const label = `${g.displayName(tgt.id)} · ${fmtDist(dist)}${s.vel.length() > 5 ? ' · ETA ' + fmtTime(eta) : ''}`;
      navMarker = { x, y, label, edge: !pr.on };
      targetLabel = `DESTINO ${g.displayName(tgt.id)} — ${fmtDist(dist)}`;
    }
    // other bodies
    const bodyMarkers: ShipHudState['bodyMarkers'] = [];
    if (this.altitude > 1500 || !g.universe.frame) {
      for (const b of g.universe.system.bodies) {
        if (b.id === g.navTarget || b === g.universe.frame) continue;
        const pf = g.universe.system.posFromSystem(g.universe.frame, b.pos, new THREE.Vector3());
        const pr = project(pf);
        if (!pr.on) continue;
        bodyMarkers.push({ x: pr.x, y: pr.y + 14, label: `${g.displayName(b.id)} ${fmtDist(pf.distanceTo(s.pos) - b.radius)}` });
      }
    }
    if (g.universe.station) {
      const sp = g.universe.system.posFromSystem(g.universe.frame, g.universe.stationDockSys(), new THREE.Vector3());
      const d = sp.distanceTo(s.pos);
      if (d < 300000) {
        const pr = project(sp);
        if (pr.on) bodyMarkers.push({ x: pr.x, y: pr.y + 14, label: `◇ Estação orbital ${fmtDist(d)}` });
      }
    }
    const frame = g.universe.frame;
    const atmTop = frame?.def.atmosphere?.height ?? 0;
    let mode = 'VOO';
    if (g.warpState) mode = g.warpState;
    else if (this.docked) mode = 'ACOPLADO';
    else if (s.heat > 0.12) mode = 'ENTRADA ATMOSFÉRICA';
    else if (s.landed) mode = s.engineOn ? 'POUSADO · MOTORES ATIVOS' : 'POUSADO';
    else if (s.cruise) mode = 'MOTOR DE CRUZEIRO';
    else if (!frame) mode = 'ESPAÇO INTERPLANETÁRIO';
    else if (frame.def.atmosphere && this.altitude < atmTop) mode = 'VOO ATMOSFÉRICO';
    else mode = 'ÓRBITA';
    let landing: string | null = null;
    if (!s.landed && frame && this.altitude < 120) {
      const vs = s.vel.dot(this.env.up);
      const upOk = s.upVec().dot(this.env.up) > 0.9;
      const gearOk = s.gearDown;
      const slow = Math.abs(vs) < 6;
      const color = gearOk && slow && upOk ? 'var(--green)' : 'var(--amber)';
      landing = `<span style="color:${color}">POUSO ${gearOk ? '▣ TREM' : '□ TREM (X)'} · ${slow ? 'V/S OK' : 'DESCIDA RÁPIDA'} · ${upOk ? 'NIVELADA' : 'INCLINADA'}</span>`;
    }
    if (this.docked) landing = '<span style="color:var(--green)">ACOPLADO · E ou W para desacoplar</span>';
    else if (this.dockAvailable) landing = '<span style="color:var(--cyan)"><span class="key">E</span>ACOPLAR À ESTAÇÃO</span>';
    const warnings: string[] = [];
    if (s.fuel < 10) warnings.push('COMBUSTÍVEL BAIXO');
    if (s.hull < 30) warnings.push('CASCO CRÍTICO');
    if (s.hullTemp > 900) warnings.push('SUPERAQUECIMENTO');
    if (!s.landed && this.altitude < 60 && s.vel.dot(this.env.up) < -15) warnings.push('TERRENO');
    const nearest = g.universe.system.nearestBody(g.universe.system.posToSystem(frame, s.pos, new THREE.Vector3()));
    // attitude, heading and the camera-relative pitch ladder
    const upW = this.env.up.lengthSq() > 0 ? this.env.up.clone().normalize() : null;
    const fwd = s.forward();
    let heading: number | null = null, pitchDeg = 0, rollDeg = 0;
    const ladder: ShipHudState['ladder'] = [];
    if (upW) {
      pitchDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.dot(upW), -1, 1)));
      rollDeg = THREE.MathUtils.radToDeg(Math.atan2(-s.right().dot(upW), s.upVec().dot(upW)));
      if (frame) {
        // the body frame spins about +Y: north is the axis projected on the horizon
        const north = new THREE.Vector3(0, 1, 0).addScaledVector(upW, -upW.y);
        if (north.lengthSq() > 1e-6) {
          north.normalize();
          const east = north.clone().cross(upW);
          const hf = fwd.clone().addScaledVector(upW, -fwd.dot(upW));
          if (hf.lengthSq() > 1e-6) heading = (THREE.MathUtils.radToDeg(Math.atan2(hf.dot(east), hf.dot(north))) + 360) % 360;
        }
      }
      const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camQuat);
      const hf = camF.clone().addScaledVector(upW, -camF.dot(upW));
      if (hf.lengthSq() < 1e-4) hf.set(0, 1, 0).applyQuaternion(this.camQuat).addScaledVector(upW, -1).negate();
      hf.normalize();
      const hr = hf.clone().cross(upW).normalize();
      const camPitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(camF.dot(upW), -1, 1)));
      for (let d = -80; d <= 80; d += 10) {
        if (Math.abs(d - camPitch) > 45) continue;
        const r = THREE.MathUtils.degToRad(d);
        const dir = hf.clone().multiplyScalar(Math.cos(r)).addScaledVector(upW, Math.sin(r));
        const w = d === 0 ? 0.5 : 0.17;
        const a = project(this.camPos.clone().addScaledVector(dir, 1000).addScaledVector(hr, -1000 * w));
        const b = project(this.camPos.clone().addScaledVector(dir, 1000).addScaledVector(hr, 1000 * w));
        if (a.behind || b.behind) continue;
        ladder.push({ deg: d, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
    const nosePr = project(this.camPos.clone().addScaledVector(fwd, 1000));
    return {
      heading, pitchDeg, rollDeg, ladder, nose: { x: nosePr.x, y: nosePr.y, visible: !nosePr.behind },
      speedLevel: s.speedLevel, levels: SPEED_LEVELS.map((l) => ({ name: l.name, max: l.max })), cruise: s.cruise, landingLight: this.landingLight,
      speed: s.vel.length(), vspeed: this.env.up.lengthSq() > 0 ? s.vel.dot(this.env.up) : 0, altitude: this.altitude,
      altLabel: frame ? (this.altitude > atmTop && atmTop > 0 ? 'ACIMA DA ATMOSFERA' : 'SOBRE O TERRENO') : 'ATÉ A SUPERFÍCIE MAIS PRÓXIMA',
      throttle: s.throttleVis, fuel: s.fuel, unlimited: s.unlimited, hull: s.hull, hullTemp: s.hullTemp, power: s.powerOnline, thrusters: s.thrustersOnline, engine: s.engineOn,
      assist: s.assist, gear: s.gearDown, mode,
      nearest: nearest ? `${g.displayName(nearest.body.id)} · ${TYPE_LABEL[nearest.body.def.type]}` : '',
      target: targetLabel, stick: { x: this.stick.x, y: this.stick.y },
      vel: vel ? { x: vel.x, y: vel.y, visible: vel.on } : { x: 0, y: 0, visible: false },
      horizonRoll: roll, horizonPitch: pitch, landing, navMarker, bodyMarkers, warnings, cockpit: this.cockpitView,
    };
  }
}

export function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 1e6) return `${(m / 1000).toFixed(m < 1e4 ? 2 : 1)} km`;
  return `${(m / 1e6).toFixed(2)} Mm`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

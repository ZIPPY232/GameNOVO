import * as THREE from 'three';
import { Rng, hash32 } from '../core/rng';
import { properName } from '../universe/names';
import type { Game } from './Game';

/**
 * Procedural alien fauna. Species are derived from the planet seed by
 * combining anatomical archetypes with bounded parameters, so creatures stay
 * coherent while differing between worlds. Simple behaviours: wander, graze,
 * flee, drift, hunt (hostiles) and rest at night.
 */

type Archetype = 'grazer' | 'floater' | 'crawler';

interface Species {
  id: string;
  name: string;
  arch: Archetype;
  color: THREE.Color;
  accent: THREE.Color;
  scale: number;
  legLen: number;
  neck: number;
  speed: number;
  hostile: boolean;
  glow: number;
  pitch: number;
}

interface Creature {
  sp: Species;
  root: THREE.Group;
  legs: THREE.Object3D[];
  head: THREE.Object3D | null;
  pos: THREE.Vector3;
  heading: THREE.Vector3;
  state: 'wander' | 'graze' | 'flee' | 'hunt' | 'rest';
  timer: number;
  phase: number;
  health: number;
  attackT: number;
  hover: number;
  hurtT: number;
}

const ARCH_LABEL: Record<Archetype, string> = { grazer: 'herbívoro quadrúpede', floater: 'flutuador bioluminescente', crawler: 'predador hexápode' };

export class Fauna {
  readonly game: Game;
  readonly group = new THREE.Group();
  private creatures: Creature[] = [];
  private species: Species[] = [];
  private bodyKey = '';
  private spawnT = 0;
  threat = 0;
  private seen = new Set<string>();

  constructor(game: Game) {
    this.game = game;
  }

  private speciesFor(key: string, seed: number, type: string, hasFlora: boolean): Species[] {
    if (!hasFlora) return [];
    const rng = new Rng(hash32(seed, 777));
    const out: Species[] = [];
    const hue = rng.next();
    const mk = (arch: Archetype, i: number): Species => {
      const r = rng.fork(i);
      const c = new THREE.Color().setHSL((hue + r.range(-0.15, 0.15) + 1) % 1, r.range(0.25, 0.6), r.range(0.25, 0.5));
      const a = new THREE.Color().setHSL((hue + 0.5 + r.range(-0.1, 0.1)) % 1, 0.8, 0.6);
      return {
        id: `${key}/${arch}${i}`,
        name: properName(r),
        arch,
        color: c,
        accent: a,
        scale: arch === 'grazer' ? r.range(0.8, 1.6) : arch === 'floater' ? r.range(0.6, 1.3) : r.range(0.6, 1.0),
        legLen: r.range(0.5, 1.1),
        neck: r.range(0.2, 0.7),
        speed: arch === 'crawler' ? r.range(3.5, 5) : arch === 'grazer' ? r.range(1.6, 2.6) : r.range(0.6, 1.2),
        hostile: arch === 'crawler',
        glow: arch === 'floater' ? r.range(2, 6) : r.range(0, 1.5),
        pitch: r.range(0.7, 1.4),
      };
    };
    out.push(mk('grazer', 0));
    if (rng.chance(0.6)) out.push(mk('grazer', 1));
    out.push(mk('floater', 2));
    if (type === 'exotic' || type === 'volcanic' || rng.chance(0.35)) out.push(mk('crawler', 3));
    return out;
  }

  private build(sp: Species): Creature {
    const root = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.72 });
    const dark = new THREE.MeshStandardMaterial({ color: sp.color.clone().multiplyScalar(0.45), roughness: 0.6 });
    const acc = new THREE.MeshStandardMaterial({ color: sp.accent.clone().multiplyScalar(0.3), emissive: sp.accent, emissiveIntensity: sp.glow });
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      parent.add(o);
      return o;
    };
    const ellipsoid = (rx: number, ry: number, rz: number, seg = 18) => new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7)).scale(rx, ry, rz);
    /** tapered limb hanging down from its joint (length len) */
    const limb = (r0: number, r1: number, len: number) => {
      const prof: THREE.Vector2[] = [new THREE.Vector2(0.001, r0 * 0.9)];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        prof.push(new THREE.Vector2(r0 + (r1 - r0) * t + Math.sin(t * Math.PI) * r0 * 0.15, -t * len));
      }
      prof.push(new THREE.Vector2(0.001, -len - r1 * 0.8));
      return new THREE.LatheGeometry(prof.reverse(), 10);
    };
    const legs: THREE.Object3D[] = [];
    let head: THREE.Object3D | null = null;
    const s = sp.scale;
    if (sp.arch === 'grazer') {
      const L = sp.legLen * s;
      // barrel body with a darker dorsal ridge and soft belly
      add(root, ellipsoid(0.38 * s, 0.34 * s, 0.7 * s), body, 0, L + 0.3 * s, 0);
      add(root, ellipsoid(0.16 * s, 0.1 * s, 0.55 * s), dark, 0, L + 0.6 * s, -0.05 * s);
      for (let i = 0; i < 4; i++) add(root, new THREE.SphereGeometry(0.035 * s, 8, 6), acc, 0, L + 0.66 * s, (0.3 - i * 0.2) * s);
      // tail
      const tail = add(root, limb(0.08 * s, 0.02 * s, 0.5 * s), body, 0, L + 0.4 * s, -0.66 * s);
      tail.rotation.x = 1.0;
      const neck = new THREE.Group();
      neck.position.set(0, L + 0.45 * s, 0.55 * s);
      root.add(neck);
      const nlen = sp.neck * s + 0.15;
      const nk = add(neck, limb(0.15 * s, 0.1 * s, nlen), body, 0, 0, 0);
      nk.rotation.x = -2.0;
      head = new THREE.Group();
      head.position.set(0, 0.42 * nlen + 0.04 * s, 0.91 * nlen);
      neck.add(head);
      add(head, ellipsoid(0.17 * s, 0.16 * s, 0.24 * s), body, 0, 0, 0.08 * s);
      const snout = add(head, new THREE.ConeGeometry(0.12 * s, 0.26 * s, 14).rotateX(Math.PI / 2), body, 0, -0.04 * s, 0.32 * s);
      snout.scale.set(1, 0.8, 1);
      for (const x of [-1, 1]) {
        add(head, new THREE.SphereGeometry(0.04 * s, 10, 8), acc, x * 0.11 * s, 0.06 * s, 0.2 * s);
        const horn = add(head, new THREE.ConeGeometry(0.035 * s, 0.28 * s, 8), dark, x * 0.09 * s, 0.2 * s, -0.02 * s);
        horn.rotation.set(-0.5, 0, x * -0.35);
      }
      for (const [x, z] of [[-0.24, 0.42], [0.24, 0.42], [-0.24, -0.42], [0.24, -0.42]]) {
        const leg = new THREE.Group();
        leg.position.set(x * s, L + 0.08 * s, z * s);
        root.add(leg);
        add(leg, limb(0.1 * s, 0.05 * s, L), body, 0, 0, 0);
        add(leg, new THREE.CylinderGeometry(0.055 * s, 0.075 * s, 0.07 * s, 10), dark, 0, -L + 0.0 * s, 0.01 * s);
        legs.push(leg);
      }
    } else if (sp.arch === 'floater') {
      // jellyfish-like drifter: translucent bell with a glowing core and trailing tentacles
      const bellProf: THREE.Vector2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const a = t * Math.PI * 0.55;
        bellProf.push(new THREE.Vector2(Math.sin(a) * 0.62 * s * (1 + 0.06 * Math.sin(t * 20)), Math.cos(a) * 0.5 * s - 0.1 * s));
      }
      const bell = new THREE.LatheGeometry(bellProf.reverse(), 24);
      const bellMat = new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.25, transparent: true, opacity: 0.55, emissive: sp.accent, emissiveIntensity: sp.glow * 0.25, side: THREE.DoubleSide, depthWrite: false });
      const bm = add(root, bell, bellMat, 0, 0, 0);
      bm.castShadow = false;
      add(root, ellipsoid(0.22 * s, 0.18 * s, 0.22 * s), acc, 0, 0.05 * s, 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const t = new THREE.Group();
        t.position.set(Math.cos(a) * 0.42 * s, -0.08 * s, Math.sin(a) * 0.42 * s);
        root.add(t);
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 6; k++) pts.push(new THREE.Vector3(Math.sin(k * 0.9 + i) * 0.08 * s, -k * 0.22 * s, Math.cos(k * 0.7 + i) * 0.06 * s));
        add(t, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.025 * s, 6), acc, 0, 0, 0);
        legs.push(t);
      }
    } else {
      // segmented crawler: armoured carapace, mandibles and jointed legs
      const L = 0.45 * s;
      for (let i = 0; i < 3; i++) {
        const z = (0.35 - i * 0.38) * s;
        add(root, ellipsoid(0.36 * s * (1 - i * 0.08), 0.2 * s, 0.24 * s), body, 0, L + 0.12 * s, z);
        add(root, ellipsoid(0.33 * s * (1 - i * 0.08), 0.1 * s, 0.22 * s), dark, 0, L + 0.25 * s, z);
      }
      for (let i = 0; i < 4; i++) add(root, new THREE.ConeGeometry(0.05 * s, 0.22 * s, 8), acc, (i % 2 ? 0.16 : -0.16) * s, L + 0.38 * s, (i < 2 ? 0.25 : -0.12) * s);
      head = new THREE.Group();
      head.position.set(0, L + 0.12 * s, 0.62 * s);
      root.add(head);
      add(head, ellipsoid(0.24 * s, 0.14 * s, 0.18 * s), body, 0, 0, 0);
      add(head, ellipsoid(0.2 * s, 0.04 * s, 0.04 * s), acc, 0, 0.06 * s, 0.13 * s);
      for (const x of [-1, 1]) {
        const m = add(head, new THREE.ConeGeometry(0.03 * s, 0.22 * s, 8), dark, x * 0.1 * s, -0.05 * s, 0.2 * s);
        m.rotation.set(Math.PI / 2, 0, x * 0.5);
      }
      for (const z of [0.35, 0, -0.35]) for (const x of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(x * 0.36 * s, L + 0.12 * s, z * s);
        leg.rotation.z = x * 0.6;
        root.add(leg);
        add(leg, limb(0.05 * s, 0.03 * s, L * 1.4), dark, 0, 0, 0);
        legs.push(leg);
      }
    }
    return {
      sp, root, legs, head, pos: new THREE.Vector3(), heading: new THREE.Vector3(1, 0, 0), state: 'wander', timer: 2, phase: Math.random() * 10,
      health: sp.arch === 'crawler' ? 40 : 25, attackT: 0, hover: sp.arch === 'floater' ? 3 + Math.random() * 4 : 0, hurtT: 0,
    };
  }

  private clear(): void {
    for (const c of this.creatures) c.root.removeFromParent();
    this.creatures = [];
  }

  update(dt: number): void {
    const g = this.game;
    const u = g.universe;
    const f = u.focus;
    const phys = f?.physics;
    this.threat = Math.max(0, this.threat - dt);
    if (!f || !phys || f.body !== u.frame || g.mode === 'warp') {
      if (this.creatures.length) this.clear();
      return;
    }
    if (this.bodyKey !== f.key) {
      this.clear();
      this.bodyKey = f.key;
      const def = f.body.def;
      this.species = this.speciesFor(f.key, def.gen!.seed, def.type, def.gen!.flora !== 'none' && !!def.atmosphere);
      f.root.add(this.group);
    }
    if (!this.species.length) return;
    const quality = g.settings.graphics.objectDensity;
    const maxN = Math.round(9 * quality);
    const p = g.mode === 'ship' ? g.pilot.ship.pos : g.player.pos;
    const night = u.sunElevation < -0.05;
    // spawn
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.creatures.length < maxN) {
      this.spawnT = 1.2;
      const sp = this.species[Math.floor(Math.random() * this.species.length)];
      if (sp.hostile && !night && Math.random() < 0.7) return;
      const up = p.clone().normalize();
      const t1 = new THREE.Vector3(0, 1, 0).cross(up);
      if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
      t1.normalize();
      const ang = Math.random() * Math.PI * 2;
      const dist = 35 + Math.random() * 35;
      const dir = up.clone().multiplyScalar(p.length()).add(t1.applyAxisAngle(up, ang).multiplyScalar(dist)).normalize();
      const ground = this.groundRadius(dir, p.length() + 40);
      if (ground > 0) {
        const genP = f.body.def.gen!;
        if (genP.hasOcean && ground < genP.baseRadius + genP.seaZ + 0.5) return;
        const c = this.build(sp);
        c.pos.copy(dir).multiplyScalar(ground);
        c.heading.copy(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).projectOnPlane(dir).normalize());
        this.group.add(c.root);
        this.creatures.push(c);
      }
    }
    // simulate
    for (const c of this.creatures) this.step(c, dt, p, night);
    // despawn
    this.creatures = this.creatures.filter((c) => {
      const far = c.pos.distanceTo(p) > 120;
      if (far || c.health <= 0) {
        if (c.health <= 0) {
          g.effects.burstDebris(c.pos.clone().addScaledVector(c.pos.clone().normalize(), 0.6), c.pos.clone().normalize(), c.sp.color, 8);
          g.inventory.add('organics', 2);
          g.toast('+2 Compostos Orgânicos');
        }
        c.root.removeFromParent();
        return false;
      }
      return true;
    });
  }

  private groundRadius(dir: THREE.Vector3, fromR: number): number {
    const phys = this.game.universe.focus!.physics!;
    const w = phys.world;
    const gp = { face: 0, x: 0, y: 0, z: 0 };
    phys.toGrid(dir.clone().multiplyScalar(fromR), gp);
    const I = Math.floor(gp.x), J = Math.floor(gp.y);
    // start just above the natural surface (covers flora), scan down through loaded data
    const natural = w.gen.groundZ(gp.face, gp.x, gp.y);
    if (w.getLoaded(gp.face, I, J, Math.floor(natural)) === 255) return -1;
    const start = Math.min(gp.z, natural + 3);
    const z = w.surfaceBelow(gp.face, gp.x, gp.y, start, 60);
    return z === -Infinity ? -1 : w.params.baseRadius + z;
  }

  private step(c: Creature, dt: number, player: THREE.Vector3, night: boolean): void {
    const g = this.game;
    const up = c.pos.clone().normalize();
    const toP = player.clone().sub(c.pos);
    const dist = toP.length();
    c.timer -= dt;
    c.hurtT = Math.max(0, c.hurtT - dt);
    // discovery
    if (dist < 14 && !this.seen.has(c.sp.id)) {
      this.seen.add(c.sp.id);
      g.discover({ id: c.sp.id, kind: 'species', title: `Espécie: ${c.sp.name}`, text: `${ARCH_LABEL[c.sp.arch]} — ${c.sp.hostile ? 'agressivo; mantenha distância ou use o extrator para repeli-lo' : 'pacífico'}.`, time: Date.now(), systemId: g.universe.def.id });
      g.audio.creature(c.sp.pitch, c.sp.hostile);
    }
    // behaviour
    let speed = 0;
    if (c.sp.hostile) {
      if (dist < 22 && g.mode === 'onfoot' && (night || c.hurtT > 0 || dist < 8)) c.state = 'hunt';
      else if (c.state === 'hunt' && dist > 30) c.state = 'wander';
    } else if (c.sp.arch === 'grazer' && dist < 8 && g.mode === 'onfoot') {
      c.state = 'flee';
      c.timer = 3;
    }
    if (c.timer <= 0 && c.state !== 'hunt') {
      const r = Math.random();
      c.state = night && c.sp.arch === 'grazer' ? 'rest' : r < 0.4 ? 'graze' : 'wander';
      c.timer = 3 + Math.random() * 6;
      if (c.state === 'wander') c.heading.applyAxisAngle(up, (Math.random() - 0.5) * 2.5);
      if (Math.random() < 0.15 && dist < 40) g.audio.creature(c.sp.pitch, c.sp.hostile);
    }
    switch (c.state) {
      case 'wander': speed = c.sp.speed * 0.5; break;
      case 'flee': c.heading.copy(toP).negate().projectOnPlane(up).normalize(); speed = c.sp.speed * 2.2; break;
      case 'hunt': {
        c.heading.copy(toP).projectOnPlane(up).normalize();
        speed = dist > 1.6 ? c.sp.speed : 0;
        c.attackT -= dt;
        this.threat = 2;
        if (dist < 2 && c.attackT <= 0) {
          c.attackT = 1.3;
          g.vitals.damage(9, 'creature');
          g.vitals.integrity = Math.max(0, g.vitals.integrity - 4);
          g.audio.creature(c.sp.pitch * 0.8, true);
        }
        break;
      }
      default: speed = 0;
    }
    c.heading.projectOnPlane(up).normalize();
    c.pos.addScaledVector(c.heading, speed * dt);
    // follow ground
    const gr = this.groundRadius(up, c.pos.length() + 3);
    if (gr > 0) {
      const target = gr + c.hover;
      const r = c.pos.length();
      c.pos.setLength(r + (target - r) * Math.min(1, dt * (c.sp.arch === 'floater' ? 1 : 10)));
    }
    if (c.sp.arch === 'floater') c.pos.addScaledVector(up, Math.sin(g.universe.time * 0.8 + c.phase) * 0.15 * dt);
    // pose
    c.phase += speed * dt * 3;
    const R = new THREE.Vector3().crossVectors(up, c.heading).normalize();
    c.root.position.copy(c.pos);
    c.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R.clone().negate().negate(), up, c.heading).premultiply(new THREE.Matrix4()));
    c.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R, up, c.heading));
    c.legs.forEach((l, i) => {
      if (c.sp.arch === 'floater') l.rotation.x = Math.sin(g.universe.time * 1.5 + i) * 0.25;
      else l.rotation.x = Math.sin(c.phase + (i % 2 ? Math.PI : 0) + (i >= 2 ? Math.PI / 2 : 0)) * 0.6 * Math.min(1, speed);
    });
    if (c.head) c.head.rotation.x = c.state === 'graze' ? 0.9 : c.state === 'rest' ? 0.5 : Math.sin(g.universe.time + c.phase) * 0.1;
    c.root.scale.setScalar(c.hurtT > 0 ? 1 + Math.sin(c.hurtT * 40) * 0.04 : 1);
  }

  /** Ray test against creatures (planet-local ray). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, max: number): { c: Creature; dist: number } | null {
    let best: { c: Creature; dist: number } | null = null;
    for (const c of this.creatures) {
      const center = c.pos.clone().addScaledVector(c.pos.clone().normalize(), c.hover > 0 ? 0 : 0.7 * c.sp.scale);
      const oc = center.clone().sub(origin);
      const t = oc.dot(dir);
      if (t < 0 || t > max) continue;
      const d2 = oc.lengthSq() - t * t;
      const rad = 0.8 * c.sp.scale;
      if (d2 < rad * rad && (!best || t < best.dist)) best = { c, dist: t };
    }
    return best;
  }

  hurt(c: Creature, amount: number): void {
    c.health -= amount;
    c.hurtT = 0.4;
    if (!c.sp.hostile) { c.state = 'flee'; c.timer = 4; }
  }
}

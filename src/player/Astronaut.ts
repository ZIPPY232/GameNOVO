import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Astronaut in an original exploration suit: soft fabric limbs with bellows
 * joints, hard upper-torso shell, bubble helmet with gold visor, life-support
 * pack, suit lights and boots. All parts hang off a simple rig so procedural
 * animation and customisation share one skeleton.
 */

export interface SuitColors {
  primary: string;
  secondary: string;
  accent: string;
  visor: string;
  helmet?: number;
  pack?: number;
}

export const DEFAULT_SUIT: SuitColors = { primary: '#e9e7e2', secondary: '#3b3f45', accent: '#ea7a2c', visor: '#b8862a' };

function fabricNormal(size = 128): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = Math.sin((x / size) * Math.PI * 2 * 24) * 0.5 + 0.5;
    const wy = Math.sin((y / size) * Math.PI * 2 * 24) * 0.5 + 0.5;
    const seam = Math.abs(((y / size) * 4) % 1 - 0.5) < 0.03 ? -1 : 0;
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    h[x + y * size] = (wx * wy) * 0.6 + seam * 0.8 + (n - Math.floor(n)) * 0.15;
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = (x - 1 + size) % size, xr = (x + 1) % size, yd = (y - 1 + size) % size, yu = (y + 1) % size;
    const dx = (h[xr + y * size] - h[xl + y * size]) * 1.2;
    const dy = (h[x + yu * size] - h[x + yd * size]) * 1.2;
    const l = Math.hypot(dx, dy, 1);
    const i = (x + y * size) * 4;
    data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function chestPanelTexture(accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2e33';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#4a5058';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 240, 240);
  // status display
  g.fillStyle = '#0b1418';
  g.fillRect(36, 40, 184, 70);
  g.fillStyle = '#5fe6ff';
  for (let i = 0; i < 6; i++) g.fillRect(48 + i * 28, 90 - i * 7, 18, 10 + i * 7);
  // dials
  g.fillStyle = accent;
  g.beginPath(); g.arc(80, 170, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#d7dadf';
  g.beginPath(); g.arc(176, 170, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9ff7b8';
  g.fillRect(118, 150, 20, 40);
  // mission emblem: stylised orbit
  g.strokeStyle = '#cfd6de';
  g.lineWidth = 4;
  g.beginPath(); g.ellipse(128, 222, 40, 12, -0.2, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function chestEmissive(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#3fbfff';
  for (let i = 0; i < 6; i++) g.fillRect(48 + i * 28, 90 - i * 7, 18, 10 + i * 7);
  g.fillStyle = '#7fffa0';
  g.fillRect(118, 150, 20, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Rig {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  handR: THREE.Group;
  helmet: THREE.Mesh;
  visor: THREE.Mesh;
  backpack: THREE.Group;
  lights: THREE.Mesh[];
}

export class Astronaut {
  readonly rig: Rig;
  readonly mats: { primary: THREE.MeshStandardMaterial; secondary: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial; light: THREE.MeshStandardMaterial; panel: THREE.MeshStandardMaterial; skin: THREE.MeshStandardMaterial };
  readonly scale = 1;
  /** standing hip height (m) used by the animator */
  readonly hipY = 0.95;

  constructor(colors: SuitColors = DEFAULT_SUIT) {
    const fabric = fabricNormal();
    const primary = new THREE.MeshStandardMaterial({ color: colors.primary, roughness: 0.78, metalness: 0.0, normalMap: fabric, normalScale: new THREE.Vector2(0.3, 0.3) });
    const secondary = new THREE.MeshStandardMaterial({ color: colors.secondary, roughness: 0.5, metalness: 0.3 });
    const accent = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.55, metalness: 0.05 });
    const visor = new THREE.MeshStandardMaterial({ color: colors.visor, roughness: 0.03, metalness: 1.0, envMapIntensity: 1.8 });
    const light = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.55, 0.9, 1.0), emissiveIntensity: 40 });
    const panel = new THREE.MeshStandardMaterial({ map: chestPanelTexture(colors.accent), emissiveMap: chestEmissive(), emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 8, roughness: 0.45, metalness: 0.3 });
    const skin = new THREE.MeshStandardMaterial({ color: '#2a2e33', roughness: 0.6 });
    this.mats = { primary, secondary, accent, visor, light, panel, skin };

    const box = (w: number, h: number, d: number, r = 0.035, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      return o;
    };
    const group = (x = 0, y = 0, z = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      return g;
    };
    /** limb segment hanging from its joint: capsule of radius r and straight length len */
    const limb = (r0: number, r1: number, len: number) => {
      const prof: THREE.Vector2[] = [];
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        // tapered capsule with a soft fabric bulge
        const r = r0 + (r1 - r0) * t + Math.sin(t * Math.PI) * 0.008;
        prof.push(new THREE.Vector2(r, -t * len));
      }
      prof.unshift(new THREE.Vector2(r0 * 0.6, r0 * 0.6), new THREE.Vector2(0.001, r0 * 0.95));
      prof.push(new THREE.Vector2(r1 * 0.6, -len - r1 * 0.6), new THREE.Vector2(0.001, -len - r1 * 0.95));
      return new THREE.LatheGeometry(prof.reverse(), 16);
    };
    /** accordion joint rings */
    const bellows = (r: number, h: number, rings: number) => {
      const prof: THREE.Vector2[] = [];
      for (let i = 0; i <= rings * 4; i++) {
        const t = i / (rings * 4);
        prof.push(new THREE.Vector2(r * (1 + 0.07 * Math.cos(t * rings * Math.PI * 2)), h / 2 - t * h));
      }
      return new THREE.LatheGeometry(prof.reverse(), 16);
    };

    const root = group();
    const inner = group();
    inner.scale.setScalar(this.scale);
    root.add(inner);
    const hips = group(0, this.hipY, 0);
    inner.add(hips);

    // ----- torso: lathed, flattened front-to-back
    const torso = group(0, 0, 0);
    hips.add(torso);
    const torsoProf: THREE.Vector2[] = [
      [0.001, -0.06], [0.15, -0.05], [0.17, 0.02], [0.16, 0.14], [0.17, 0.26], [0.2, 0.38], [0.215, 0.48], [0.2, 0.56], [0.14, 0.62], [0.09, 0.64], [0.001, 0.645],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const torsoGeo = new THREE.LatheGeometry(torsoProf, 24);
    torsoGeo.scale(1.12, 1, 0.72);
    torso.add(mesh(torsoGeo, primary));
    // hard upper torso shell + chest panel
    const shell = box(0.36, 0.22, 0.1, 0.04);
    torso.add(mesh(shell, secondary, 0, 0.44, 0.1));
    const panelMesh = mesh(new THREE.PlaneGeometry(0.16, 0.12), panel, 0.05, 0.45, 0.151);
    torso.add(panelMesh);
    // waist ring, belt and accent band
    torso.add(mesh(new THREE.TorusGeometry(0.165, 0.025, 8, 32).rotateX(Math.PI / 2).scale(1.1, 1, 0.75), secondary, 0, 0.03, 0));
    torso.add(mesh(new THREE.TorusGeometry(0.19, 0.012, 6, 32).rotateX(Math.PI / 2).scale(1.12, 1, 0.74), accent, 0, 0.3, 0));
    // neck ring
    torso.add(mesh(new THREE.TorusGeometry(0.11, 0.03, 10, 32).rotateX(Math.PI / 2), secondary, 0, 0.635, 0));
    // shoulder bearings
    for (const sx of [-1, 1]) torso.add(mesh(new THREE.TorusGeometry(0.07, 0.022, 8, 20).rotateY(Math.PI / 2), secondary, sx * 0.235, 0.52, 0));
    // life-support hoses from pack to chest
    const hose = new THREE.TorusGeometry(0.13, 0.016, 8, 18, Math.PI * 0.9);
    const h1 = mesh(hose, secondary, -0.12, 0.42, 0.02); h1.rotation.set(0, Math.PI / 2, Math.PI / 2.2); torso.add(h1);
    const h2 = mesh(hose, secondary, 0.12, 0.42, 0.02); h2.rotation.set(0, Math.PI / 2, Math.PI / 2.2); torso.add(h2);

    // ----- backpack (life support)
    const backpack = group(0, 0.36, -0.19);
    torso.add(backpack);
    backpack.add(mesh(box(0.36, 0.48, 0.16, 0.05), primary, 0, 0, 0));
    backpack.add(mesh(box(0.3, 0.1, 0.03, 0.012), secondary, 0, 0.13, -0.085));
    for (const tx of [-0.11, 0.11]) {
      backpack.add(mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 14), secondary, tx, -0.02, -0.08));
    }
    backpack.add(mesh(box(0.37, 0.03, 0.17, 0.01), accent, 0, -0.17, 0));
    const lights: THREE.Mesh[] = [];
    for (const lx of [-0.12, 0.12]) {
      const l = mesh(new THREE.SphereGeometry(0.016, 10, 8), light, lx, 0.2, -0.085);
      backpack.add(l);
      lights.push(l);
    }

    const packB = group(0, 0.36, -0.2);
    packB.visible = false;
    torso.add(packB);
    packB.add(mesh(box(0.38, 0.52, 0.17, 0.06), primary, 0, 0, 0));
    for (const tx of [-0.12, 0.12]) {
      packB.add(mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 16), secondary, tx, 0.02, -0.12));
      packB.add(mesh(new THREE.TorusGeometry(0.072, 0.012, 6, 16).rotateX(Math.PI / 2), accent, tx, 0.24, -0.12));
    }
    packB.add(mesh(box(0.24, 0.1, 0.07, 0.02), secondary, 0, -0.28, -0.06));
    packB.add(mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.36, 6), secondary, 0.16, 0.42, -0.04));
    const lb = mesh(new THREE.SphereGeometry(0.02, 10, 8), light, 0, 0.2, -0.09);
    packB.add(lb);
    lights.push(lb);

    // ----- head / helmet
    const head = group(0, 0.64, 0);
    torso.add(head);
    head.add(mesh(new THREE.SphereGeometry(0.1, 16, 12), skin, 0, 0.16, 0.0));
    // helmet A: bubble helmet with gold visor and lamp pods
    const helmetA = group();
    head.add(helmetA);
    const helmet = mesh(new THREE.SphereGeometry(0.165, 32, 24), primary, 0, 0.17, -0.005);
    helmet.scale.set(1, 1.04, 1.02);
    helmetA.add(helmet);
    const visorGeo = new THREE.SphereGeometry(0.168, 32, 20, Math.PI / 2 - Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.26, Math.PI * 0.42);
    const visorMesh = mesh(visorGeo, visor, 0, 0.17, 0);
    visorMesh.scale.set(1.01, 1.05, 1.03);
    helmetA.add(visorMesh);
    // crown stripe, side lamps, antenna
    const crown = mesh(new THREE.TorusGeometry(0.168, 0.012, 6, 40, Math.PI).rotateY(Math.PI / 2), accent, 0, 0.17, 0);
    helmetA.add(crown);
    for (const lx of [-1, 1]) {
      helmetA.add(mesh(box(0.04, 0.05, 0.08, 0.015), secondary, lx * 0.16, 0.2, 0.03));
      const l = mesh(new THREE.CircleGeometry(0.014, 12), light, lx * 0.16, 0.2, 0.072);
      helmetA.add(l);
      lights.push(l);
    }
    helmetA.add(mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.16, 6), secondary, -0.11, 0.37, -0.08));
    // helmet B: expedition helmet, wraparound dark visor and lamp bar
    const helmetB = group();
    helmetB.visible = false;
    head.add(helmetB);
    const hb = mesh(new THREE.CapsuleGeometry(0.155, 0.06, 8, 24), primary, 0, 0.18, -0.01);
    hb.scale.set(1.05, 1, 1.08);
    helmetB.add(hb);
    const visB = mesh(new THREE.SphereGeometry(0.17, 32, 16, Math.PI / 2 - Math.PI * 0.45, Math.PI * 0.9, Math.PI * 0.3, Math.PI * 0.33), visor, 0, 0.18, 0);
    visB.scale.set(1.04, 1.1, 1.08);
    helmetB.add(visB);
    helmetB.add(mesh(box(0.06, 0.05, 0.3, 0.02), secondary, 0, 0.35, -0.02));
    const bar = mesh(box(0.16, 0.025, 0.03, 0.01), light, 0, 0.31, 0.15);
    helmetB.add(bar);
    lights.push(bar);
    helmetB.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.24, 6), secondary, 0.12, 0.4, -0.1));

    // ----- arms
    const makeArm = (side: number) => {
      const shoulder = group(side * 0.25, 0.52, 0);
      torso.add(shoulder);
      shoulder.add(mesh(new THREE.SphereGeometry(0.075, 16, 12), primary, 0, -0.01, 0));
      shoulder.add(mesh(limb(0.066, 0.058, 0.25), primary, 0, -0.03, 0));
      shoulder.add(mesh(new THREE.TorusGeometry(0.064, 0.008, 6, 20).rotateX(Math.PI / 2), accent, 0, -0.1, 0));
      const elbow = group(0, -0.31, 0);
      shoulder.add(elbow);
      elbow.add(mesh(bellows(0.058, 0.07, 3), secondary, 0, 0, 0));
      elbow.add(mesh(limb(0.056, 0.048, 0.2), primary, 0, -0.04, 0));
      // wrist ring + glove
      elbow.add(mesh(new THREE.TorusGeometry(0.05, 0.014, 8, 20).rotateX(Math.PI / 2), secondary, 0, -0.27, 0));
      const hand = group(0, -0.31, 0);
      elbow.add(hand);
      hand.add(mesh(box(0.085, 0.1, 0.07, 0.03), secondary, 0, -0.02, 0.0));
      hand.add(mesh(box(0.02, 0.06, 0.03, 0.01), secondary, -side * 0.05, -0.0, 0.025));
      return { shoulder, elbow, hand };
    };
    const aL = makeArm(-1), aR = makeArm(1);

    // ----- legs
    const makeLeg = (side: number) => {
      const hip = group(side * 0.1, -0.02, 0);
      hips.add(hip);
      hip.add(mesh(limb(0.09, 0.075, 0.38), primary, 0, -0.02, 0));
      hip.add(mesh(new THREE.TorusGeometry(0.083, 0.009, 6, 20).rotateX(Math.PI / 2), accent, 0, -0.16, 0));
      const knee = group(0, -0.45, 0);
      hip.add(knee);
      knee.add(mesh(bellows(0.074, 0.08, 3), secondary, 0, 0, 0));
      knee.add(mesh(limb(0.07, 0.06, 0.32), primary, 0, -0.04, 0));
      // boot: shaped upper, sole and toe cap
      const boot = mesh(box(0.13, 0.13, 0.27, 0.05), secondary, 0, -0.43, 0.04);
      knee.add(boot);
      knee.add(mesh(box(0.135, 0.03, 0.28, 0.012), accent, 0, -0.485, 0.04));
      knee.add(mesh(new THREE.CylinderGeometry(0.075, 0.07, 0.1, 16), primary, 0, -0.36, 0));
      return { hip, knee };
    };
    const lL = makeLeg(-1), lR = makeLeg(1);

    this.rig = {
      root, hips, torso, head, armL: aL.shoulder, armR: aR.shoulder, elbowL: aL.elbow, elbowR: aR.elbow,
      legL: lL.hip, legR: lR.hip, kneeL: lL.knee, kneeR: lR.knee, handR: aR.hand, helmet, visor: visorMesh, backpack, lights,
    };
    this.variants = { helmetA, helmetB, packA: backpack, packB };
  }

  private variants!: { helmetA: THREE.Group; helmetB: THREE.Group; packA: THREE.Group; packB: THREE.Group };

  /** Equipment variants sharing the same rig. */
  setVariant(helmet: number, pack: number): void {
    this.variants.helmetA.visible = helmet === 0;
    this.variants.helmetB.visible = helmet === 1;
    this.variants.packA.visible = pack === 0;
    this.variants.packB.visible = pack === 1;
  }

  setColors(c: SuitColors): void {
    this.mats.primary.color.set(c.primary);
    this.mats.secondary.color.set(c.secondary);
    this.mats.accent.color.set(c.accent);
    this.mats.visor.color.set(c.visor);
    this.setVariant(c.helmet ?? 0, c.pack ?? 0);
  }

  setLightsOn(on: boolean): void {
    this.mats.light.emissiveIntensity = on ? 40 : 2;
  }

  /** Hide head when rendering in first person (avoid clipping the camera). */
  setFirstPerson(fp: boolean): void {
    this.rig.head.visible = !fp;
  }
}

export interface AnimState {
  speed: number;
  running: boolean;
  grounded: boolean;
  vertical: number;
  swimming: boolean;
  zeroG: boolean;
  gravity: number;
  mining: boolean;
  building: number;
  interact: number;
  landImpact: number;
  lookPitch: number;
  holding: boolean;
  seated: boolean;
}

/** Procedural animation layered on the rig: locomotion, actions and reactions. */
export class AstronautAnimator {
  private phase = 0;
  private t = 0;
  private landSpring = 0;
  private landVel = 0;
  private blendRun = 0;
  private blendAir = 0;
  private blendSwim = 0;
  private blendMine = 0;
  constructor(private a: Astronaut) {}

  update(dt: number, s: AnimState): void {
    const r = this.a.rig;
    this.t += dt;
    const lowG = Math.min(1, Math.max(0.35, s.gravity / 9.8));
    const stride = s.running ? 1.7 : 1.15;
    this.phase += (s.speed * dt / stride) * Math.PI * (0.7 + 0.3 * lowG);
    const k = 1 - Math.exp(-dt * 10);
    this.blendRun += ((s.running && s.speed > 0.5 ? 1 : 0) - this.blendRun) * k;
    this.blendAir += ((!s.grounded && !s.swimming && !s.seated ? 1 : 0) - this.blendAir) * k;
    this.blendSwim += ((s.swimming ? 1 : 0) - this.blendSwim) * k;
    this.blendMine += ((s.mining ? 1 : 0) - this.blendMine) * (1 - Math.exp(-dt * 14));
    // landing spring
    if (s.landImpact > 0) this.landVel -= s.landImpact * 0.9;
    this.landVel += (-this.landSpring * 120 - this.landVel * 14) * dt;
    this.landSpring += this.landVel * dt;
    const crouch = Math.max(-0.25, Math.min(0.05, this.landSpring));

    const walkAmt = Math.min(1, s.speed / 3) * (1 - this.blendAir) * (1 - this.blendSwim);
    const sw = Math.sin(this.phase);
    const cw = Math.cos(this.phase);
    const legAmp = 0.55 + 0.25 * this.blendRun;
    const armAmp = 0.45 + 0.4 * this.blendRun;

    // legs
    r.legL.rotation.x = sw * legAmp * walkAmt;
    r.legR.rotation.x = -sw * legAmp * walkAmt;
    r.kneeL.rotation.x = Math.max(0, -cw) * 0.9 * walkAmt;
    r.kneeR.rotation.x = Math.max(0, cw) * 0.9 * walkAmt;
    // arms
    r.armL.rotation.set(-sw * armAmp * walkAmt, 0, -0.06);
    r.armR.rotation.set(sw * armAmp * walkAmt, 0, 0.06);
    r.elbowL.rotation.x = -(0.15 + 0.5 * this.blendRun) * walkAmt;
    r.elbowR.rotation.x = -(0.15 + 0.5 * this.blendRun) * walkAmt;
    // torso
    const breathe = Math.sin(this.t * 1.6) * 0.008;
    r.hips.position.y = this.a.hipY + Math.abs(Math.sin(this.phase)) * 0.04 * walkAmt + crouch * 0.5 + breathe;
    r.torso.rotation.x = 0.08 * this.blendRun * walkAmt + breathe;
    r.torso.rotation.y = sw * 0.06 * walkAmt;
    r.head.rotation.x = -s.lookPitch * 0.6;
    r.head.rotation.y = Math.sin(this.t * 0.37) * 0.05 * (1 - walkAmt);

    // crouch from landing
    r.legL.rotation.x += -crouch * 2.0;
    r.legR.rotation.x += -crouch * 2.0;
    r.kneeL.rotation.x += crouch * -4.0;
    r.kneeR.rotation.x += crouch * -4.0;

    // airborne pose
    if (this.blendAir > 0.01) {
      const b = this.blendAir;
      const rising = s.vertical > 0 ? 1 : 0;
      r.legL.rotation.x += (rising ? -0.5 : -0.2) * b;
      r.legR.rotation.x += (rising ? 0.1 : -0.35) * b;
      r.kneeL.rotation.x += (rising ? 0.9 : 0.4) * b;
      r.kneeR.rotation.x += (rising ? 0.3 : 0.6) * b;
      r.armL.rotation.z += -0.5 * b * (s.zeroG ? 0.6 + 0.2 * Math.sin(this.t) : 1);
      r.armR.rotation.z += 0.5 * b * (s.zeroG ? 0.6 + 0.2 * Math.cos(this.t) : 1);
      r.armL.rotation.x += -0.4 * b * rising;
      r.armR.rotation.x += -0.4 * b * rising;
    }
    // swimming: horizontal body with flutter kicks
    if (this.blendSwim > 0.01) {
      const b = this.blendSwim;
      const kick = Math.sin(this.t * 7);
      r.hips.rotation.x = -1.2 * b * Math.min(1, s.speed / 1.5);
      r.legL.rotation.x = kick * 0.4 * b;
      r.legR.rotation.x = -kick * 0.4 * b;
      const stroke = this.t * 2.2;
      r.armL.rotation.x = (-2.6 + Math.sin(stroke) * 1.4) * b;
      r.armR.rotation.x = (-2.6 + Math.sin(stroke + Math.PI) * 1.4) * b;
    } else {
      r.hips.rotation.x = 0;
    }
    if (s.seated) {
      r.legL.rotation.x = -1.4; r.legR.rotation.x = -1.4;
      r.kneeL.rotation.x = 1.4; r.kneeR.rotation.x = 1.4;
      r.hips.position.y = this.a.hipY * 0.62;
      r.armL.rotation.x = -0.9; r.armR.rotation.x = -0.9;
      r.elbowL.rotation.x = -0.6; r.elbowR.rotation.x = -0.6;
    }
    // tool held forward
    if (s.holding && !s.swimming && !s.seated) {
      r.armR.rotation.x = r.armR.rotation.x * 0.3 - 0.7 - s.lookPitch * 0.8;
      r.elbowR.rotation.x = -0.6;
    }
    // mining: arm locked toward target with vibration
    if (this.blendMine > 0.01) {
      const b = this.blendMine;
      const jitter = Math.sin(this.t * 60) * 0.03;
      r.armR.rotation.x = r.armR.rotation.x * (1 - b) + (-1.45 - s.lookPitch + jitter) * b;
      r.elbowR.rotation.x = r.elbowR.rotation.x * (1 - b) + (-0.15) * b;
      r.armL.rotation.x = r.armL.rotation.x * (1 - b) + (-1.1 - s.lookPitch) * b;
      r.armL.rotation.z = r.armL.rotation.z * (1 - b) + 0.45 * b;
      r.elbowL.rotation.x = r.elbowL.rotation.x * (1 - b) + (-0.5) * b;
    }
    // building / interaction swings
    if (s.building > 0) {
      const p = Math.sin((1 - s.building) * Math.PI);
      r.armR.rotation.x = -0.6 - 1.2 * p;
    }
    if (s.interact > 0) {
      const p = Math.sin((1 - s.interact) * Math.PI);
      r.armR.rotation.x = -1.3 * p - 0.2;
      r.torso.rotation.x += 0.15 * p;
    }
  }
}

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Voxel astronaut. Keeps the reference's blocky geometry (big cubic head,
 * rectangular torso, separate square limbs, blocky feet) and dresses it in an
 * original exploration suit: layered panels, reflective visor, life-support
 * pack, suit lights and magnetic boots. All parts hang off a simple rig so
 * procedural animation and customisation share one skeleton.
 */

export interface SuitColors {
  primary: string;
  secondary: string;
  accent: string;
  visor: string;
}

export const DEFAULT_SUIT: SuitColors = { primary: '#e9e7e2', secondary: '#3b3f45', accent: '#ea7a2c', visor: '#16130e' };

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
  readonly scale = 0.9;

  constructor(colors: SuitColors = DEFAULT_SUIT) {
    const fabric = fabricNormal();
    const primary = new THREE.MeshStandardMaterial({ color: colors.primary, roughness: 0.72, metalness: 0.0, normalMap: fabric, normalScale: new THREE.Vector2(0.35, 0.35) });
    const secondary = new THREE.MeshStandardMaterial({ color: colors.secondary, roughness: 0.48, metalness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.5, metalness: 0.05 });
    const visor = new THREE.MeshStandardMaterial({ color: colors.visor, roughness: 0.04, metalness: 1.0, envMapIntensity: 1.6 });
    const light = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.55, 0.9, 1.0), emissiveIntensity: 40 });
    const panel = new THREE.MeshStandardMaterial({ map: chestPanelTexture(colors.accent), emissiveMap: chestEmissive(), emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 8, roughness: 0.45, metalness: 0.3 });
    const skin = new THREE.MeshStandardMaterial({ color: '#c99a76', roughness: 0.8 });
    this.mats = { primary, secondary, accent, visor, light, panel, skin };

    const box = (w: number, h: number, d: number, r = 0.035, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);
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

    const root = group();
    const inner = group();
    inner.scale.setScalar(this.scale);
    root.add(inner);
    const hips = group(0, 0.86, 0);
    inner.add(hips);

    // ----- torso
    const torso = group(0, 0, 0);
    hips.add(torso);
    torso.add(mesh(box(0.52, 0.64, 0.3, 0.05), primary, 0, 0.33, 0));
    // chest plate + panel
    torso.add(mesh(box(0.42, 0.3, 0.06, 0.02), secondary, 0, 0.46, 0.15));
    const panelMesh = mesh(new THREE.PlaneGeometry(0.22, 0.18), panel, 0.06, 0.46, 0.182);
    torso.add(panelMesh);
    // belt + accent stripes
    torso.add(mesh(box(0.54, 0.09, 0.32, 0.02), secondary, 0, 0.04, 0));
    torso.add(mesh(box(0.535, 0.03, 0.305, 0.01), accent, 0, 0.21, 0));
    // shoulder pads
    torso.add(mesh(box(0.2, 0.08, 0.32, 0.03), secondary, -0.31, 0.63, 0));
    torso.add(mesh(box(0.2, 0.08, 0.32, 0.03), secondary, 0.31, 0.63, 0));
    // collar ring
    torso.add(mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.06, 24), secondary, 0, 0.67, 0));
    // hoses
    const hose = new THREE.TorusGeometry(0.12, 0.022, 8, 16, Math.PI);
    const h1 = mesh(hose, secondary, -0.16, 0.56, 0.08); h1.rotation.set(0, Math.PI / 2, Math.PI / 2); torso.add(h1);
    const h2 = mesh(hose, secondary, 0.16, 0.56, 0.08); h2.rotation.set(0, Math.PI / 2, Math.PI / 2); torso.add(h2);

    // ----- backpack (life support)
    const backpack = group(0, 0.36, -0.25);
    torso.add(backpack);
    backpack.add(mesh(box(0.46, 0.56, 0.2, 0.04), primary, 0, 0, 0));
    backpack.add(mesh(box(0.4, 0.14, 0.04, 0.015), secondary, 0, 0.15, -0.105));
    backpack.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.46, 16), secondary, -0.15, 0, -0.09));
    backpack.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.46, 16), secondary, 0.15, 0, -0.09));
    backpack.add(mesh(box(0.47, 0.035, 0.21, 0.01), accent, 0, -0.2, 0));
    const lights: THREE.Mesh[] = [];
    for (const lx of [-0.15, 0.15]) {
      const l = mesh(box(0.04, 0.04, 0.02, 0.01), light, lx, 0.24, -0.1);
      backpack.add(l);
      lights.push(l);
    }

    // ----- head / helmet
    const head = group(0, 0.68, 0);
    torso.add(head);
    const helmet = mesh(box(0.54, 0.52, 0.54, 0.08, 3), primary, 0, 0.27, 0);
    head.add(helmet);
    const skull = mesh(box(0.44, 0.44, 0.44, 0.03), skin, 0, 0.27, 0);
    head.add(skull);
    const visorMesh = mesh(box(0.44, 0.3, 0.04, 0.02), visor, 0, 0.29, 0.258);
    head.add(visorMesh);
    // visor frame + accent
    head.add(mesh(box(0.5, 0.04, 0.04, 0.015), secondary, 0, 0.455, 0.255));
    head.add(mesh(box(0.5, 0.04, 0.04, 0.015), secondary, 0, 0.125, 0.255));
    head.add(mesh(box(0.06, 0.18, 0.56, 0.02), secondary, -0.27, 0.27, 0));
    head.add(mesh(box(0.06, 0.18, 0.56, 0.02), secondary, 0.27, 0.27, 0));
    head.add(mesh(box(0.556, 0.03, 0.2, 0.01), accent, 0, 0.53, -0.1));
    for (const lx of [-0.29, 0.29]) {
      const l = mesh(box(0.03, 0.05, 0.08, 0.01), light, lx, 0.3, 0.18);
      head.add(l);
      lights.push(l);
    }
    // antenna
    head.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6), secondary, -0.2, 0.62, -0.15));

    // ----- arms
    const makeArm = (side: number) => {
      const shoulder = group(side * 0.335, 0.58, 0);
      torso.add(shoulder);
      shoulder.add(mesh(box(0.16, 0.36, 0.17, 0.03), primary, 0, -0.16, 0));
      shoulder.add(mesh(box(0.17, 0.035, 0.18, 0.01), accent, 0, -0.06, 0));
      const elbow = group(0, -0.34, 0);
      shoulder.add(elbow);
      elbow.add(mesh(box(0.165, 0.08, 0.175, 0.03), secondary, 0, 0, 0));
      elbow.add(mesh(box(0.155, 0.24, 0.165, 0.03), primary, 0, -0.14, 0));
      // wrist cuff + glove
      elbow.add(mesh(box(0.17, 0.05, 0.18, 0.015), secondary, 0, -0.27, 0));
      const hand = group(0, -0.33, 0);
      elbow.add(hand);
      hand.add(mesh(box(0.165, 0.13, 0.18, 0.035), secondary, 0, -0.02, 0.005));
      return { shoulder, elbow, hand };
    };
    const aL = makeArm(-1), aR = makeArm(1);

    // ----- legs
    const makeLeg = (side: number) => {
      const hip = group(side * 0.13, 0.0, 0);
      hips.add(hip);
      hip.add(mesh(box(0.21, 0.42, 0.23, 0.03), primary, 0, -0.21, 0));
      hip.add(mesh(box(0.215, 0.035, 0.235, 0.01), accent, 0, -0.1, 0));
      const knee = group(0, -0.42, 0);
      hip.add(knee);
      knee.add(mesh(box(0.215, 0.09, 0.24, 0.03), secondary, 0, 0, 0.005));
      knee.add(mesh(box(0.2, 0.28, 0.22, 0.03), primary, 0, -0.16, 0));
      // boot
      knee.add(mesh(box(0.23, 0.13, 0.33, 0.035), secondary, 0, -0.37, 0.04));
      knee.add(mesh(box(0.235, 0.025, 0.335, 0.01), accent, 0, -0.43, 0.04));
      return { hip, knee };
    };
    const lL = makeLeg(-1), lR = makeLeg(1);

    this.rig = {
      root, hips, torso, head, armL: aL.shoulder, armR: aR.shoulder, elbowL: aL.elbow, elbowR: aR.elbow,
      legL: lL.hip, legR: lR.hip, kneeL: lL.knee, kneeR: lR.knee, handR: aR.hand, helmet, visor: visorMesh, backpack, lights,
    };
  }

  setColors(c: SuitColors): void {
    this.mats.primary.color.set(c.primary);
    this.mats.secondary.color.set(c.secondary);
    this.mats.accent.color.set(c.accent);
    this.mats.visor.color.set(c.visor);
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
    r.hips.position.y = 0.86 + Math.abs(Math.sin(this.phase)) * 0.04 * walkAmt + crouch * 0.5 + breathe;
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
      r.hips.position.y = 0.55;
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

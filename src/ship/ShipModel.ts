import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Original exploration lander "Arandu-class" (Mk II). Local axes: -Z forward, +Y up.
 *
 * The hull is lofted from superellipse cross-sections (boxy-round, like a
 * machined part), with a bubble canopy and frame, swept delta wings, lathed
 * engine nacelles with spinning fans, twin canted fins, a tiled heat shield on
 * the belly and articulated landing gear. Static parts are merged per material
 * to keep the draw-call count low; animated parts stay separate.
 */

// ------------------------------------------------------------------ textures

function panelTextures(): { map: THREE.CanvasTexture; normal: THREE.DataTexture; rough: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9ccd0';
  g.fillRect(0, 0, S, S);
  const h = new Float32Array(S * S).fill(0.5);
  const rects: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, hh: number, d: number) => {
    if (d > 3 || (d > 1 && Math.random() < 0.3)) { rects.push([x, y, w, hh]); return; }
    if (w > hh) { const s = Math.floor(w * (0.35 + Math.random() * 0.3)); split(x, y, s, hh, d + 1); split(x + s, y, w - s, hh, d + 1); }
    else { const s = Math.floor(hh * (0.35 + Math.random() * 0.3)); split(x, y, w, s, d + 1); split(x, y + s, w, hh - s, d + 1); }
  };
  split(0, 0, S, S, 0);
  for (const [x, y, w, hh] of rects) {
    const shade = 200 + Math.floor(Math.random() * 26);
    g.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
    g.fillRect(x + 2, y + 2, w - 4, hh - 4);
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) {
      const e = Math.min(xx - x, x + w - 1 - xx, yy - y, y + hh - 1 - yy);
      h[xx + yy * S] = e < 2 ? 0 : 0.5;
    }
    g.fillStyle = 'rgba(80,84,90,0.55)';
    for (const [rx, ry] of [[x + 6, y + 6], [x + w - 6, y + 6], [x + 6, y + hh - 6], [x + w - 6, y + hh - 6]]) {
      g.beginPath(); g.arc(rx, ry, 1.6, 0, Math.PI * 2); g.fill();
    }
  }
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(60,55,50,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 10 + Math.random() * 60);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const normal = heightToNormal(h, S);
  const rc = document.createElement('canvas');
  rc.width = 128; rc.height = 128;
  const rg = rc.getContext('2d')!;
  for (let i = 0; i < 128 * 128 / 16; i++) {
    const v = 100 + Math.random() * 60;
    rg.fillStyle = `rgb(${v},${v},${v})`;
    rg.fillRect((i % 32) * 4, Math.floor(i / 32) * 4, 4, 4);
  }
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return { map, normal, rough };
}

function heightToNormal(h: Float32Array, S: number): THREE.DataTexture {
  const nd = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const xr = (x + 1) % S, xl = (x - 1 + S) % S, yu = (y + 1) % S, yd = (y - 1 + S) % S;
    const dx = (h[xr + y * S] - h[xl + y * S]) * 2, dy = (h[x + yu * S] - h[x + yd * S]) * 2;
    const l = Math.hypot(dx, dy, 1);
    const i = (x + y * S) * 4;
    nd[i] = (-dx / l * 0.5 + 0.5) * 255; nd[i + 1] = (-dy / l * 0.5 + 0.5) * 255; nd[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd[i + 3] = 255;
  }
  const t = new THREE.DataTexture(nd, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** dark ceramic heat-shield tiles for the belly */
function tileTextures(): { map: THREE.CanvasTexture; normal: THREE.DataTexture } {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  const h = new Float32Array(S * S).fill(0.5);
  const T = 32;
  for (let ty = 0; ty < S / T; ty++) for (let tx = 0; tx < S / T; tx++) {
    const off = (ty % 2) * T / 2;
    const v = 34 + Math.floor(Math.random() * 18);
    g.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
    const x0 = (tx * T + off) % S, y0 = ty * T;
    g.fillRect(x0 + 1, y0 + 1, T - 2, T - 2);
    if (x0 + T > S) g.fillRect(x0 - S + 1, y0 + 1, T - 2, T - 2);
    for (let yy = 0; yy < T; yy++) for (let xx = 0; xx < T; xx++) {
      const e = Math.min(xx, T - 1 - xx, yy, T - 1 - yy);
      h[((x0 + xx) % S) + (y0 + yy) * S] = e < 1 ? 0.1 : 0.5;
    }
  }
  // scorch gradient
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, 'rgba(90,60,40,0.10)');
  grd.addColorStop(1, 'rgba(0,0,0,0.0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return { map, normal: heightToNormal(h, S) };
}

/** livery: ship name, registration and chevrons (transparent background) */
function liveryTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 1024, 256);
  // orange chevrons
  g.fillStyle = '#ea7a2c';
  for (let i = 0; i < 3; i++) {
    const x = 40 + i * 46;
    g.beginPath();
    g.moveTo(x, 70); g.lineTo(x + 30, 128); g.lineTo(x, 186); g.lineTo(x + 18, 186); g.lineTo(x + 48, 128); g.lineTo(x + 18, 70);
    g.closePath(); g.fill();
  }
  g.fillStyle = '#2b3036';
  g.font = '700 112px Rajdhani, Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name.toUpperCase(), 230, 112);
  g.font = '600 34px JetBrains Mono, monospace';
  g.fillStyle = '#4a5058';
  g.fillText('HV-01 · CLASSE ARANDU · EXPLORAÇÃO', 236, 196);
  g.fillStyle = '#ea7a2c';
  g.fillRect(230, 222, 760, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ loft geometry

interface Station { z: number; hw: number; top: number; bot: number; n: number }

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sectionAt(st: Station[], z: number): Station {
  if (z <= st[0].z) return { ...st[0], z };
  if (z >= st[st.length - 1].z) return { ...st[st.length - 1], z };
  let i = 0;
  while (i < st.length - 2 && st[i + 1].z < z) i++;
  const a = st[Math.max(0, i - 1)], b = st[i], c = st[i + 1], d = st[Math.min(st.length - 1, i + 2)];
  const t = (z - b.z) / (c.z - b.z);
  const f = (k: 'hw' | 'top' | 'bot' | 'n') => catmull(a[k], b[k], c[k], d[k], t);
  return { z, hw: Math.max(0.01, f('hw')), top: f('top'), bot: f('bot'), n: f('n') };
}

function sectionPoint(s: Station, a: number, off = 0, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(a), sn = Math.sin(a);
  const e = 2 / s.n;
  const mid = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2;
  return out.set(Math.sign(c) * Math.pow(Math.abs(c), e) * (s.hw + off), mid + Math.sign(sn) * Math.pow(Math.abs(sn), e) * (hh + off), s.z);
}

interface LoftOpts {
  z0?: number; z1?: number; zSeg?: number;
  a0?: number; a1?: number; aSeg?: number;
  off?: number; capStart?: boolean; capEnd?: boolean;
  /** uv mode: 'tile' (metres / scale) or 'unit' (0..1 over the patch) */
  uv?: 'tile' | 'unit'; uvScale?: number;
}

/** Lofted surface through superellipse stations. Faces point outward. */
function loft(st: Station[], o: LoftOpts = {}): THREE.BufferGeometry {
  const z0 = o.z0 ?? st[0].z, z1 = o.z1 ?? st[st.length - 1].z;
  const zSeg = o.zSeg ?? 48, a0 = o.a0 ?? 0, a1 = o.a1 ?? Math.PI * 2, aSeg = o.aSeg ?? 48;
  const off = o.off ?? 0, sc = o.uvScale ?? 4;
  const closed = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const p = new THREE.Vector3();
  const rings: Station[] = [];
  for (let i = 0; i <= zSeg; i++) rings.push(sectionAt(st, z0 + (z1 - z0) * (i / zSeg)));
  for (let i = 0; i <= zSeg; i++) {
    let arc = 0;
    let prev: THREE.Vector3 | null = null;
    for (let j = 0; j <= aSeg; j++) {
      const a = a0 + (a1 - a0) * (j / aSeg);
      sectionPoint(rings[i], a, off, p);
      if (prev) arc += p.distanceTo(prev);
      prev = (prev ?? new THREE.Vector3()).copy(p);
      pos.push(p.x, p.y, p.z);
      if (o.uv === 'unit') uv.push(i / zSeg, j / aSeg);
      else uv.push(arc / sc, p.z / sc);
    }
  }
  const row = aSeg + 1;
  for (let i = 0; i < zSeg; i++) for (let j = 0; j < aSeg; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (closed) {
    // weld the seam normals
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i <= zSeg; i++) {
      const s0 = i * row, s1 = i * row + aSeg;
      const x = n.getX(s0) + n.getX(s1), y = n.getY(s0) + n.getY(s1), z = n.getZ(s0) + n.getZ(s1);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(s0, x / l, y / l, z / l);
      n.setXYZ(s1, x / l, y / l, z / l);
    }
  }
  const parts = [g.toNonIndexed()];
  const cap = (s: Station, front: boolean) => {
    const cp: number[] = [];
    const mid = (s.top + s.bot) / 2;
    const q = new THREE.Vector3(), r = new THREE.Vector3();
    for (let j = 0; j < aSeg; j++) {
      sectionPoint(s, a0 + (a1 - a0) * (j / aSeg), off, q);
      sectionPoint(s, a0 + (a1 - a0) * ((j + 1) / aSeg), off, r);
      if (front) cp.push(0, mid, s.z, r.x, r.y, r.z, q.x, q.y, q.z);
      else cp.push(0, mid, s.z, q.x, q.y, q.z, r.x, r.y, r.z);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((cp.length / 3) * 2).fill(0), 2));
    cg.computeVertexNormals();
    parts.push(cg);
  };
  if (o.capStart) cap(rings[0], true);
  if (o.capEnd) cap(rings[zSeg], false);
  g.dispose();
  return parts.length > 1 ? mergeGeometries(parts)! : parts[0];
}

/** extruded flat shape lying in the XZ plane (wings); thickness along Y */
function slab(pts: [number, number][], thick: number, bevel: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(Math.PI / 2);
  g.translate(0, thick / 2, 0);
  return g;
}

/** extruded flat shape lying in the ZY plane (fins); thickness along X */
function fin(pts: [number, number][], thick: number, bevel: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  g.rotateY(-Math.PI / 2);
  g.translate(thick / 2, 0, 0);
  return g;
}

function lathe(profile: [number, number][], seg = 32): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.rotateX(Math.PI / 2); // lathe axis Y -> Z (front of the profile = smaller z)
  return g;
}

// ------------------------------------------------------------------ model

export interface ShipParts {
  root: THREE.Group;
  gear: THREE.Group[];
  plumes: THREE.Mesh[];
  nozzles: THREE.Mesh[];
  fans: THREE.Group[];
  navLights: THREE.Mesh[];
  strobe: THREE.Mesh;
  cockpit: THREE.Group;
  screens: THREE.CanvasTexture;
  screenCanvas: HTMLCanvasElement;
  heatShell: THREE.Mesh;
  hatch: THREE.Mesh;
  landingLight: THREE.SpotLight;
  rcs: THREE.Mesh[];
}

/** fuselage cross-sections (z, half width, top, bottom, superellipse exponent) */
const HULL: Station[] = [
  { z: -6.45, hw: 0.08, top: -0.1, bot: -0.28, n: 2.2 },
  { z: -6.1, hw: 0.5, top: 0.12, bot: -0.5, n: 2.4 },
  { z: -5.3, hw: 0.98, top: 0.45, bot: -0.8, n: 2.7 },
  { z: -4.2, hw: 1.3, top: 0.68, bot: -0.95, n: 3.0 },
  { z: -2.6, hw: 1.5, top: 0.82, bot: -1.02, n: 3.2 },
  { z: -0.5, hw: 1.6, top: 0.92, bot: -1.05, n: 3.4 },
  { z: 2.2, hw: 1.62, top: 0.95, bot: -1.02, n: 3.4 },
  { z: 4.1, hw: 1.45, top: 0.86, bot: -0.85, n: 3.2 },
  { z: 5.2, hw: 1.18, top: 0.7, bot: -0.62, n: 3.0 },
  { z: 5.7, hw: 0.95, top: 0.55, bot: -0.45, n: 2.8 },
];

/** canopy bubble (upper half only) */
const CANOPY: Station[] = [
  { z: -4.95, hw: 0.2, top: 0.5, bot: 0.4, n: 2.2 },
  { z: -4.5, hw: 0.72, top: 1.05, bot: 0.45, n: 2.4 },
  { z: -3.6, hw: 0.98, top: 1.52, bot: 0.55, n: 2.6 },
  { z: -2.6, hw: 1.02, top: 1.62, bot: 0.66, n: 2.8 },
  { z: -1.7, hw: 0.9, top: 1.42, bot: 0.74, n: 2.8 },
  { z: -1.05, hw: 0.5, top: 1.02, bot: 0.8, n: 2.6 },
];

export class ShipModel {
  readonly parts: ShipParts;
  readonly mats: Record<string, THREE.MeshStandardMaterial>;
  /** local positions */
  static readonly EYE = new THREE.Vector3(0, 1.22, -3.05);
  static readonly HATCH = new THREE.Vector3(-2.4, -1.2, 0.4);
  static readonly FEET = [new THREE.Vector3(-1.55, -2.05, -2.4), new THREE.Vector3(1.55, -2.05, -2.4), new THREE.Vector3(-1.95, -2.05, 2.7), new THREE.Vector3(1.95, -2.05, 2.7)];
  static readonly HULL_PROBES = [
    new THREE.Vector3(0, 0, -6.3), new THREE.Vector3(0, 0, 5.6), new THREE.Vector3(-4.9, -0.35, 3.7), new THREE.Vector3(4.9, -0.35, 3.7),
    new THREE.Vector3(0, 1.55, -2.6), new THREE.Vector3(0, -1.0, 0), new THREE.Vector3(-2.1, 0.15, 5.9), new THREE.Vector3(2.1, 0.15, 5.9),
    new THREE.Vector3(0, -0.9, -4.2), new THREE.Vector3(0, 1.0, 2.5), new THREE.Vector3(-2.1, 1.7, 4.9), new THREE.Vector3(2.1, 1.7, 4.9),
  ];

  constructor(name = 'Arandu') {
    const tex = panelTextures();
    const tiles = tileTextures();
    const hull = new THREE.MeshStandardMaterial({ color: 0xeef0f2, map: tex.map, normalMap: tex.normal, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: tex.rough, roughness: 0.55, metalness: 0.12 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3e434b, map: tex.map, roughness: 0.48, metalness: 0.35, normalMap: tex.normal, normalScale: new THREE.Vector2(0.4, 0.4) });
    const nacelle = new THREE.MeshStandardMaterial({ color: 0x4a5058, map: tex.map, roughness: 0.42, metalness: 0.45, normalMap: tex.normal, normalScale: new THREE.Vector2(0.35, 0.35), side: THREE.DoubleSide });
    const shield = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tiles.map, normalMap: tiles.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.82, metalness: 0.05 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xea7a2c, roughness: 0.45, metalness: 0.1 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.28, metalness: 0.92 });
    const burnt = new THREE.MeshStandardMaterial({ color: 0x6f6458, roughness: 0.36, metalness: 0.9, side: THREE.DoubleSide });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0a121a, roughness: 0.04, metalness: 0.9, envMapIntensity: 2.0, emissive: new THREE.Color(0.02, 0.05, 0.07) });
    const engine = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.35, metalness: 0.7 });
    const interior = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.7, metalness: 0.2, side: THREE.BackSide });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.85, metalness: 0.0 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.55, 0.85, 1.0), emissiveIntensity: 30 });
    const strip = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.35, 0.85, 1.0), emissiveIntensity: 6 });
    const red = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.08, 0.05), emissiveIntensity: 60 });
    const green = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.1, 1, 0.3), emissiveIntensity: 60 });
    const white = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 120 });
    const buttons = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(1.0, 0.55, 0.2), emissiveIntensity: 2.5 });
    const livery = new THREE.MeshStandardMaterial({ map: liveryTexture(name), transparent: true, roughness: 0.5, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
    this.mats = { hull, dark, nacelle, shield, accent, metal, burnt, glass, engine, interior, seatMat, glow, strip, red, green, white, buttons, livery };

    const root = new THREE.Group();
    // static geometry batched per material, merged at the end
    const batch = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const put = (geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4) => {
      let g = geo.index ? geo.toNonIndexed() : geo;
      if (m) g.applyMatrix4(m);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      const list = batch.get(mat) ?? [];
      list.push(g);
      batch.set(mat, list);
    };
    const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
    const rb = (w: number, h: number, d: number, r = 0.06) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = root, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // ---------------------------------------------------- fuselage
    const SPLIT = 0.22; // belly shield starts this far below the side line
    put(loft(HULL, { a0: -SPLIT, a1: Math.PI + SPLIT, aSeg: 40, zSeg: 56 }), hull);
    put(loft(HULL, { a0: Math.PI + SPLIT, a1: Math.PI * 2 - SPLIT, aSeg: 24, zSeg: 56, uvScale: 2.5 }), shield);
    // nose cone tip cap and tail cap
    put(loft(HULL, { z0: HULL[0].z, z1: HULL[0].z + 0.001, zSeg: 1, capStart: true }), shield);
    put(loft(HULL, { z0: 5.699, z1: 5.7, zSeg: 1, capEnd: true }), dark);
    // tail plate (engine bay) with vents
    const tail = sectionAt(HULL, 5.7);
    for (let i = -2; i <= 2; i++) put(rb(0.08, 0.5, 0.06, 0.02), engine, T(i * 0.28, tail.top - 0.55, 5.72));
    // sculpted chine strakes along the sides
    for (const s of [-1, 1]) {
      const strake: Station[] = HULL.slice(2, 8).map((h) => ({ ...h }));
      const a = s > 0 ? -0.05 : Math.PI + 0.05;
      put(loft(strake, { a0: a - 0.06, a1: a + 0.06, aSeg: 3, zSeg: 30, off: 0.035, z0: -4.6, z1: 4.4 }), dark);
    }
    // dorsal spine with heat-sink fins
    put(loft([
      { z: -1.4, hw: 0.05, top: 0.98, bot: 0.8, n: 2.5 }, { z: -0.6, hw: 0.45, top: 1.18, bot: 0.8, n: 3 },
      { z: 3.6, hw: 0.5, top: 1.2, bot: 0.8, n: 3 }, { z: 4.6, hw: 0.3, top: 1.0, bot: 0.75, n: 3 },
    ], { a0: -0.2, a1: Math.PI + 0.2, aSeg: 16, zSeg: 24, capStart: true, capEnd: true }), dark);
    for (let i = 0; i < 6; i++) put(rb(0.9, 0.1, 0.05, 0.02), dark, T(0, 1.23, 0.2 + i * 0.5));
    // sensor mast + dome behind the canopy
    put(new THREE.CylinderGeometry(0.03, 0.04, 0.55, 8), metal, T(0.3, 1.45, -0.9));
    put(new THREE.SphereGeometry(0.06, 10, 8), metal, T(0.3, 1.74, -0.9));
    put(new THREE.SphereGeometry(0.22, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), dark, T(-0.3, 1.18, -0.75));
    // chin sensor / landing light housing
    put(rb(0.7, 0.22, 0.9, 0.08), dark, T(0, -0.86, -4.6));
    put(new THREE.CircleGeometry(0.16, 16), glass, T(0, -0.86, -5.06, 0, Math.PI, 0));
    // side intakes behind the canopy
    for (const s of [-1, 1]) {
      put(rb(0.18, 0.42, 1.2, 0.06), dark, T(s * 1.42, 0.45, -1.2, 0, 0, s * -0.25));
      for (let k = 0; k < 5; k++) put(rb(0.2, 0.03, 1.0, 0.01), engine, T(s * 1.47, 0.32 + k * 0.065, -1.2, 0, 0, s * -0.25));
    }
    // accent: orange band around the cockpit section + nose stripe
    put(loft(HULL, { z0: -1.55, z1: -1.25, zSeg: 2, a0: -SPLIT, a1: Math.PI + SPLIT, aSeg: 40, off: 0.012 }), accent);
    put(loft(HULL, { z0: -6.0, z1: -4.9, zSeg: 10, a0: Math.PI / 2 - 0.12, a1: Math.PI / 2 + 0.12, aSeg: 3, off: 0.01 }), accent);
    // belly cargo pod
    put(loft([
      { z: -1.0, hw: 0.2, top: -0.9, bot: -1.05, n: 3 }, { z: -0.4, hw: 0.95, top: -0.85, bot: -1.3, n: 3.5 },
      { z: 2.8, hw: 0.95, top: -0.85, bot: -1.3, n: 3.5 }, { z: 3.5, hw: 0.3, top: -0.85, bot: -1.0, n: 3 },
    ], { a0: Math.PI, a1: Math.PI * 2, aSeg: 20, zSeg: 20, capStart: true, capEnd: true }), dark);
    // livery decals conform to the hull sides
    const decal = (side: number) => {
      const a0 = side > 0 ? -0.12 : Math.PI - 0.42, a1 = side > 0 ? 0.42 : Math.PI + 0.12;
      const g = loft(HULL, { z0: -4.75, z1: -1.7, zSeg: 16, a0, a1, aSeg: 8, off: 0.006, uv: 'unit' });
      // remap uv: u along the length (reading direction per side), v by height
      const p = g.getAttribute('position'), uv = g.getAttribute('uv');
      let ymin = 1e9, ymax = -1e9;
      for (let i = 0; i < p.count; i++) { ymin = Math.min(ymin, p.getY(i)); ymax = Math.max(ymax, p.getY(i)); }
      for (let i = 0; i < p.count; i++) {
        const u = (p.getZ(i) + 4.75) / 3.05;
        uv.setXY(i, side < 0 ? u : 1 - u, (p.getY(i) - ymin) / (ymax - ymin));
      }
      const m = new THREE.Mesh(g, livery);
      m.renderOrder = 1;
      root.add(m);
    };
    decal(-1);
    decal(1);

    // ---------------------------------------------------- canopy
    const canopyGlass = loft(CANOPY, { a0: 0, a1: Math.PI, aSeg: 28, zSeg: 30, capStart: true, capEnd: true });
    const cm = mesh(canopyGlass, glass);
    cm.castShadow = false;
    // canopy frame: ribs, spine and sills
    const ribAt = (z: number, r = 0.035) => {
      const s = sectionAt(CANOPY, z);
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 16; j++) pts.push(sectionPoint(s, 0.02 + (Math.PI - 0.04) * (j / 16), 0.02));
      put(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, r, 6), dark);
    };
    for (const z of [-2.3, -1.4]) ribAt(z, 0.035);
    const lineAt = (a: number, r: number, z0 = -4.7) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 14; i++) pts.push(sectionPoint(sectionAt(CANOPY, z0 + ((-1.2 - z0) * i) / 14), a, 0.02));
      put(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, r, 6), dark);
    };
    lineAt(Math.PI / 2, 0.03, -2.3);
    lineAt(0.02, 0.05);
    lineAt(Math.PI - 0.02, 0.05);

    // ---------------------------------------------------- wings
    for (const s of [-1, 1]) {
      const W = (pts: [number, number][]) => pts.map(([x, z]) => [x * s, z] as [number, number]);
      const wing = slab(W([[1.3, -0.4], [4.4, 2.75], [5.05, 2.95], [5.05, 4.25], [1.3, 4.5]]), 0.14, 0.05);
      put(wing, hull, T(0, -0.36, 0, 0, 0, s * -0.05));
      // orange leading-edge band and dark flap strip
      put(slab(W([[1.6, -0.05], [4.3, 2.68], [4.55, 2.85], [1.6, 0.32]]), 0.02, 0.01), accent, T(0, -0.26 + 0.005, 0, 0, 0, s * -0.05));
      put(slab(W([[1.5, 3.95], [5.0, 3.75], [5.0, 4.2], [1.5, 4.45]]), 0.03, 0.01), dark, T(0, -0.26, 0, 0, 0, s * -0.05));
      // wingtip pod with navigation light
      put(loft([
        { z: 2.6, hw: 0.03, top: 0.03, bot: -0.03, n: 2 }, { z: 2.9, hw: 0.14, top: 0.14, bot: -0.14, n: 2.2 },
        { z: 4.1, hw: 0.14, top: 0.14, bot: -0.14, n: 2.2 }, { z: 4.6, hw: 0.08, top: 0.08, bot: -0.08, n: 2 },
      ], { aSeg: 14, zSeg: 12, capEnd: true }), dark, T(s * 5.12, -0.4, 0));
      // engine nacelle (lathed)
      const nx = s * 2.08, ny = 0.12, nz = 1.0;
      put(lathe([[0.5, 0.42], [0.56, 0.02], [0.66, -0.06], [0.76, 0.02], [0.84, 0.35]], 36), nacelle, T(nx, ny, nz));
      put(lathe([[0.84, 0.34], [0.86, 1.6], [0.84, 3.3], [0.76, 4.05], [0.68, 4.3]], 36), hull, T(nx, ny, nz));
      put(lathe([[0.872, 2.9], [0.872, 3.35]], 36), dark, T(nx, ny, nz));
      // nozzle bell (bare metal, heat-tinted) with petals
      put(lathe([[0.66, 4.25], [0.62, 4.4], [0.64, 4.62], [0.7, 4.95]], 36), burnt, T(nx, ny, nz));
      for (let k = 0; k < 14; k++) {
        const ang = (k / 14) * Math.PI * 2;
        const m = new THREE.Matrix4().makeTranslation(nx, ny, nz)
          .multiply(new THREE.Matrix4().makeRotationZ(ang))
          .multiply(T(0, 0.69, 4.78, -0.22, 0, 0));
        put(rb(0.16, 0.025, 0.42, 0.01), burnt, m);
      }
      // intake inner duct
      put(new THREE.CylinderGeometry(0.5, 0.5, 0.6, 28, 1, true), engine, T(nx, ny, nz + 0.7, Math.PI / 2, 0, 0));
      // engine pylon to the hull
      put(rb(0.9, 0.34, 2.8, 0.1), dark, T(s * 1.45, 0.05, 2.9));
      // nacelle accent ring + glowing status strip
      put(new THREE.TorusGeometry(0.865, 0.035, 8, 40), accent, T(nx, ny, nz + 1.2));
      put(rb(0.06, 0.04, 1.6, 0.015), strip, T(nx + s * 0.6, ny + 0.62, nz + 2.4, 0, 0, s * -0.75));
      // canted twin fins on the nacelles
      put(fin([[0, 0], [1.6, 0], [1.75, 1.45], [1.15, 1.5]], 0.1, 0.035), hull, T(nx + s * 0.08, ny + 0.72, nz + 2.6, 0, 0, s * -0.28));
      put(fin([[1.2, 1.42], [1.74, 1.4], [1.76, 1.52], [1.18, 1.56]], 0.11, 0.02), accent, T(nx + s * 0.08, ny + 0.72, nz + 2.6, 0, 0, s * -0.28));
    }

    // ---------------------------------------------------- engine fans, glow and plumes
    const fans: THREE.Group[] = [];
    const nozzles: THREE.Mesh[] = [];
    const plumes: THREE.Mesh[] = [];
    const plumeMat = new THREE.ShaderMaterial({
      uniforms: { uPower: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uPower; uniform float uTime; varying vec3 vP;
void main(){
#include <logdepthbuf_fragment>
  float t = clamp(vP.y / -4.0 + 0.5, 0.0, 1.0);
  float r = length(vP.xz);
  float core = exp(-r * 4.0) * (1.0 - t);
  // shock diamonds
  float diamonds = 0.75 + 0.25 * pow(abs(sin(t * 18.0 - uTime * 3.0)), 6.0);
  float flick = 0.85 + 0.15 * sin(uTime * 60.0 + vP.y * 8.0);
  vec3 c = mix(vec3(0.75, 0.92, 1.0), vec3(0.3, 0.45, 1.0), t) * core * flick * diamonds * uPower * 40.0;
  gl_FragColor = vec4(c, 1.0);
}`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const s of [-1, 1]) {
      const nx = s * 2.08, ny = 0.12, nz = 1.0;
      const fan = new THREE.Group();
      fan.position.set(nx, ny, nz + 0.35);
      const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.38, 20), metal);
      spinner.rotation.x = -Math.PI / 2;
      fan.add(spinner);
      const bladeGeo = new THREE.BoxGeometry(0.06, 0.34, 0.02);
      for (let k = 0; k < 16; k++) {
        const b = new THREE.Mesh(bladeGeo, engine);
        const ang = (k / 16) * Math.PI * 2;
        b.position.set(Math.cos(ang) * 0.32, Math.sin(ang) * 0.32, 0.1);
        b.rotation.set(0, 0.5, ang - Math.PI / 2);
        fan.add(b);
      }
      root.add(fan);
      fans.push(fan);
      const g = mesh(new THREE.CircleGeometry(0.6, 32), glow);
      g.position.set(nx, ny, nz + 4.3);
      g.castShadow = false;
      nozzles.push(g);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.14, 4, 20, 1, true), plumeMat);
      p.position.set(nx, ny, nz + 6.95);
      p.rotation.x = -Math.PI / 2;
      p.frustumCulled = false;
      root.add(p);
      plumes.push(p);
    }

    // ---------------------------------------------------- RCS thruster quads
    const rcs: THREE.Mesh[] = [];
    for (const [x, y, z] of [[-1.15, 0.52, -4.6], [1.15, 0.52, -4.6], [-1.42, -0.55, 4.6], [1.42, -0.55, 4.6]]) {
      const m = mesh(rb(0.3, 0.26, 0.3, 0.05), dark);
      m.position.set(x, y, z);
      for (const [dx, dy, dz] of [[Math.sign(x) * 0.16, 0, 0], [0, 0.14, 0], [0, -0.14, 0]]) {
        put(new THREE.CylinderGeometry(0.035, 0.05, 0.06, 8), engine, T(x + dx, y + dy, z + dz, dy !== 0 ? 0 : 0, 0, dx !== 0 ? Math.PI / 2 : 0));
      }
      rcs.push(m);
    }

    // ---------------------------------------------------- hatch (port side)
    const hatch = mesh(rb(0.07, 1.15, 1.05, 0.03), dark);
    hatch.position.set(-1.6, -0.28, 0.4);
    put(rb(0.06, 1.3, 0.06, 0.02), accent, T(-1.63, -0.28, -0.17));
    put(rb(0.06, 1.3, 0.06, 0.02), accent, T(-1.63, -0.28, 0.97));
    put(rb(0.06, 0.06, 1.2, 0.02), accent, T(-1.63, 0.38, 0.4));
    put(rb(0.05, 0.08, 0.3, 0.02), metal, T(-1.66, -0.28, 0.75));
    put(new THREE.CircleGeometry(0.05, 10), buttons, T(-1.665, 0.1, 0.8, 0, -Math.PI / 2, 0));
    // boarding step
    put(rb(0.5, 0.05, 0.6, 0.02), metal, T(-1.8, -1.12, 0.4));

    // ---------------------------------------------------- landing gear
    const gear: THREE.Group[] = [];
    for (const f of ShipModel.FEET) {
      const pivot = new THREE.Group();
      pivot.position.set(f.x * 0.85, -0.78, f.z);
      root.add(pivot);
      const side = Math.sign(f.x);
      mesh(new THREE.SphereGeometry(0.14, 12, 8), metal, pivot).position.set(0, 0, 0);
      const upper = mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.62, 12), dark, pivot);
      upper.position.set(0, -0.32, 0);
      const piston = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.62, 10), metal, pivot);
      piston.position.set(0, -0.86, 0);
      const brace = mesh(rb(0.06, 0.7, 0.06, 0.02), engine, pivot);
      brace.position.set(-side * 0.18, -0.4, 0.12);
      brace.rotation.z = side * 0.4;
      const pad = mesh(new THREE.CylinderGeometry(0.4, 0.48, 0.1, 18), dark, pivot);
      pad.position.set(f.x * 0.15, -1.22, 0);
      const padRim = mesh(new THREE.TorusGeometry(0.44, 0.03, 6, 22), accent, pivot);
      padRim.position.set(f.x * 0.15, -1.18, 0);
      padRim.rotation.x = Math.PI / 2;
      gear.push(pivot);
    }

    // ---------------------------------------------------- lights
    const navL = mesh(new THREE.SphereGeometry(0.08, 10, 8), red, root, false);
    navL.position.set(-5.12, -0.4, 4.62);
    const navR = mesh(new THREE.SphereGeometry(0.08, 10, 8), green, root, false);
    navR.position.set(5.12, -0.4, 4.62);
    const strobe = mesh(new THREE.SphereGeometry(0.07, 8, 6), white, root, false);
    strobe.position.set(0, 1.32, 4.4);
    const navLights = [navL, navR];
    const landingLight = new THREE.SpotLight(0xfff2dd, 0, 160, 0.55, 0.5, 1.2);
    landingLight.position.set(0, -0.98, -5.05);
    landingLight.target.position.set(0, -12, -11);
    root.add(landingLight, landingLight.target);

    // ---------------------------------------------------- re-entry plasma shell
    const heatMat = new THREE.ShaderMaterial({
      uniforms: { uHeat: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vP;
void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat; uniform float uTime; varying vec3 vN; varying vec3 vP;
void main(){
#include <logdepthbuf_fragment>
  float front = smoothstep(2.0, -7.0, vP.z);
  float rim = pow(1.0 - abs(vN.z), 2.0);
  float n = 0.7 + 0.3 * sin(vP.z * 3.0 + uTime * 40.0) * sin(vP.x * 5.0 - uTime * 31.0);
  vec3 c = mix(vec3(1.0, 0.35, 0.08), vec3(1.0, 0.85, 0.6), front) * front * n * (0.5 + rim) * uHeat * 18.0;
  gl_FragColor = vec4(c, 1.0);
}`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const heatShell = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), heatMat);
    heatShell.scale.set(5.6, 2.6, 7.8);
    heatShell.position.set(0, 0, -0.4);
    heatShell.visible = false;
    root.add(heatShell);

    // ---------------------------------------------------- cockpit interior (pilot view only)
    const cockpit = new THREE.Group();
    const cput = (geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4) => {
      const me = new THREE.Mesh(geo, mat);
      if (m) me.applyMatrix4(m);
      me.castShadow = false;
      me.receiveShadow = true;
      cockpit.add(me);
      return me;
    };
    // inner tub so the hull interior never shows the outside world
    cput(loft(HULL, { z0: -4.85, z1: -1.2, zSeg: 16, aSeg: 32, off: -0.08, capStart: true, capEnd: true }), interior);
    // dashboard
    cput(rb(1.9, 0.3, 0.62, 0.08), engine, T(0, 0.6, -3.82, -0.3, 0, 0));
    cput(rb(1.7, 0.06, 0.3, 0.03), dark, T(0, 0.99, -3.98, -0.1, 0, 0));
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 1024;
    screenCanvas.height = 256;
    const screens = new THREE.CanvasTexture(screenCanvas);
    screens.colorSpace = THREE.SRGBColorSpace;
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x050607, emissive: 0xffffff, emissiveMap: screens, emissiveIntensity: 3.2, roughness: 0.25 });
    const screen = (third: number, m: THREE.Matrix4) => {
      const g = new THREE.PlaneGeometry(0.5, 0.3);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, (third + uv.getX(i)) / 3);
      cput(rb(0.56, 0.36, 0.04, 0.02), engine, m.clone().multiply(T(0, 0, -0.025)));
      cput(g, screenMat, m);
    };
    screen(0, T(-0.55, 0.82, -3.66, -0.6, 0.5, 0));
    screen(1, T(0, 0.83, -3.76, -0.6, 0, 0));
    screen(2, T(0.55, 0.82, -3.66, -0.6, -0.5, 0));
    // side consoles with buttons, throttle, stick and seat
    for (const s of [-1, 1]) {
      cput(rb(0.3, 0.42, 1.5, 0.05), engine, T(s * 0.82, 0.62, -2.85));
      for (let k = 0; k < 6; k++) cput(rb(0.05, 0.02, 0.05, 0.01), buttons, T(s * 0.82 + ((k % 2) - 0.5) * 0.1, 0.84, -3.3 + Math.floor(k / 2) * 0.12));
    }
    cput(rb(0.06, 0.24, 0.06, 0.02), metal, T(-0.78, 0.94, -2.75, 0.4, 0, 0));
    cput(rb(0.12, 0.08, 0.1, 0.03), accent, T(-0.78, 1.06, -2.8));
    cput(new THREE.CylinderGeometry(0.025, 0.03, 0.36, 8), metal, T(0.25, 0.62, -3.15, 0.15, 0, 0));
    cput(rb(0.08, 0.12, 0.08, 0.03), dark, T(0.25, 0.82, -3.18));
    cput(rb(0.72, 0.12, 0.66, 0.05), seatMat, T(0, 0.5, -2.5));
    cput(rb(0.72, 0.95, 0.14, 0.06), seatMat, T(0, 0.98, -2.12, 0.18, 0, 0));
    // overhead panel
    cput(rb(0.5, 0.05, 0.4, 0.02), engine, T(0, 1.55, -2.55, 0.25, 0, 0));
    for (let k = 0; k < 4; k++) cput(rb(0.05, 0.015, 0.05, 0.01), buttons, T(-0.15 + k * 0.1, 1.52, -2.6, 0.25, 0, 0));
    root.add(cockpit);

    // ---------------------------------------------------- merge static batches
    for (const [mat, list] of batch) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      for (const g of list) g.dispose();
      const m = mesh(merged, mat);
      if (mat === glass) m.castShadow = false;
    }

    this.parts = { root, gear, plumes, nozzles, fans, navLights, strobe, cockpit, screens, screenCanvas, heatShell, hatch, landingLight, rcs };
  }

  private fanAngle = 0;

  /** gearT 1 = deployed, 0 = retracted */
  update(t: number, throttle: number, gearT: number, heat: number, landingLightOn: boolean, damaged: boolean): void {
    const p = this.parts;
    for (const pl of p.plumes) {
      const m = pl.material as THREE.ShaderMaterial;
      m.uniforms.uPower.value = throttle;
      m.uniforms.uTime.value = t;
      pl.visible = throttle > 0.02;
      pl.scale.set(1, 0.4 + throttle * 1.2, 1);
    }
    this.mats.glow.emissiveIntensity = damaged ? 0.3 + Math.random() * 1.5 : 0.6 + throttle * 55;
    this.mats.strip.emissiveIntensity = damaged ? (Math.random() < 0.1 ? 4 : 0.2) : 4 + throttle * 6;
    // fans idle when powered, spool with throttle
    this.fanAngle += (damaged ? 0.2 : 2 + throttle * 30) * 0.016;
    for (let i = 0; i < p.fans.length; i++) p.fans[i].rotation.z = (i ? -1 : 1) * this.fanAngle;
    for (let i = 0; i < p.gear.length; i++) {
      const s = i % 2 === 0 ? -1 : 1;
      p.gear[i].rotation.z = s * (1 - gearT) * 1.45;
      p.gear[i].visible = gearT > 0.02;
    }
    this.mats.white.emissiveIntensity = (t % 1.6) < 0.08 ? 160 : 0.5;
    const blink = (t % 1.2) < 0.9 ? 60 : 8;
    this.mats.red.emissiveIntensity = blink;
    this.mats.green.emissiveIntensity = blink;
    const hm = p.heatShell.material as THREE.ShaderMaterial;
    hm.uniforms.uHeat.value = heat;
    hm.uniforms.uTime.value = t;
    p.heatShell.visible = heat > 0.01;
    p.landingLight.intensity = landingLightOn ? 900 : 0;
  }

  setCockpitVisible(v: boolean): void {
    this.parts.cockpit.visible = v;
  }
}

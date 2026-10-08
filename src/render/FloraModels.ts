import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { FK, CRYSTAL_VARIANT } from '../planet/flora';

/**
 * Procedural vegetation models: broadleaf, conifer, palm and dead trees,
 * bushes, ferns, giant and small fungi, crystal clusters, corals and loose
 * rocks. Every model is a few merged geometries per material, built once
 * at boot in two levels of detail (near / far) and rendered instanced.
 *
 * Geometry carries an `aFlex` attribute (0 at the base, 1 at twig and leaf
 * tips) that drives wind sway in the vertex shader. Leaf cards get normals
 * pointing away from the canopy centre so foliage reads as a soft volume.
 */

export type FloraMatKey = 'bark' | 'barkPale' | 'leaf' | 'needle' | 'frond' | 'fungusCap' | 'fungusStem' | 'crystal' | 'coral' | 'rock' | 'glow';

export interface FloraPart { geo: THREE.BufferGeometry; mat: FloraMatKey }
export interface FloraModel { parts: FloraPart[]; height: number }

/** variants per kind (crystals use the variant as their mineral) */
export const VARIANTS: Record<number, number> = {
  [FK.TREE_BROAD]: 3, [FK.TREE_CONIFER]: 3, [FK.TREE_PALM]: 2, [FK.TREE_DEAD]: 3, [FK.BUSH]: 3, [FK.FERN]: 2,
  [FK.FUNGUS_GIANT]: 2, [FK.FUNGUS_SMALL]: 2, [FK.CRYSTAL]: 5, [FK.CORAL]: 3, [FK.ROCK]: 3, [FK.TREE_ALIEN]: 2,
};

// ------------------------------------------------------------------ geometry helpers

/** Tube along a polyline with a radius profile (t in 0..1); flex grows along the tube. */
function tube(pts: THREE.Vector3[], radius: (t: number) => number, radial: number, flex0: number, flex1: number, uvScale = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  const segs = Math.max(2, pts.length * 2);
  const frames = curve.computeFrenetFrames(segs, false);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], flex: number[] = [], idx: number[] = [];
  const len = curve.getLength();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = curve.getPointAt(t);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      const nx = N.x * cx + B.x * sy, ny = N.y * cx + B.y * sy, nz = N.z * cx + B.z * sy;
      pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
      nrm.push(nx, ny, nz);
      uv.push((j / radial) * uvScale, (t * len) / (2 * Math.PI * Math.max(0.05, radius(0))) * uvScale * 0.5);
      flex.push(flex0 + (flex1 - flex0) * t);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * row + j, b = a + row;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(flex, 1));
  g.setIndex(idx);
  return g;
}

/**
 * A leaf card: quad centred at `c`, spanning `right` x `up` half-extents.
 * Normals bend toward `volCenter` outward direction (soft volumetric canopy).
 */
function card(c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, uv: [number, number, number, number], flex: number, volCenter: THREE.Vector3 | null, bendUp = 0.35): THREE.BufferGeometry {
  const corners = [
    c.clone().sub(right).sub(up), c.clone().add(right).sub(up), c.clone().add(right).add(up), c.clone().sub(right).add(up),
  ];
  const [u0, v0, u1, v1] = uv;
  const uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
  const fn = new THREE.Vector3().crossVectors(right, up).normalize();
  const pos: number[] = [], nrm: number[] = [], fl: number[] = [];
  for (const p of corners) {
    pos.push(p.x, p.y, p.z);
    let n = fn.clone();
    if (volCenter) n = p.clone().sub(volCenter).normalize().multiplyScalar(0.8).add(new THREE.Vector3(0, bendUp, 0)).normalize();
    nrm.push(n.x, n.y, n.z);
    fl.push(flex);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(fl, 1));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Curved strip (fronds, fern leaves): points along a path, width profile, flex grows to the tip. */
function strip(path: THREE.Vector3[], side: THREE.Vector3, width: (t: number) => number, flex0: number, flex1: number, uvU: [number, number] = [0, 1]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], fl: number[] = [], idx: number[] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = path[i];
    const dir = path[Math.min(n - 1, i + 1)].clone().sub(path[Math.max(0, i - 1)]).normalize();
    const s = side.clone().addScaledVector(dir, -side.dot(dir)).normalize();
    const nn = new THREE.Vector3().crossVectors(dir, s).normalize();
    if (nn.y < 0) nn.negate();
    const w = width(t);
    pos.push(p.x - s.x * w, p.y - s.y * w, p.z - s.z * w, p.x + s.x * w, p.y + s.y * w, p.z + s.z * w);
    for (let k = 0; k < 2; k++) nrm.push(nn.x * 0.7, nn.y * 0.7 + 0.3, nn.z * 0.7);
    uv.push(uvU[0], t, uvU[1], t);
    const f = flex0 + (flex1 - flex0) * t;
    fl.push(f, f);
    if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(fl, 1));
  g.setIndex(idx);
  return g;
}

function withFlex(g: THREE.BufferGeometry, flex: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const f = new Float32Array(p.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); f[i] = flex(v); }
  g.setAttribute('aFlex', new THREE.BufferAttribute(f, 1));
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const norm = list.map((g) => {
    let x = g.index ? g.toNonIndexed() : g;
    if (!x.getAttribute('uv')) x.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(x.getAttribute('position').count * 2), 2));
    if (!x.getAttribute('aFlex')) x = withFlex(x, () => 0);
    for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv', 'aFlex'].includes(k)) x.deleteAttribute(k);
    return x;
  });
  const m = mergeGeometries(norm, false)!;
  m.computeBoundingSphere();
  return m;
}

/** a branch path from `from` along `dir` with gentle upward curl and noise */
function branchPath(rng: Rng, from: THREE.Vector3, dir: THREE.Vector3, len: number, curl: number, nseg = 4): THREE.Vector3[] {
  const pts = [from.clone()];
  const d = dir.clone().normalize();
  const p = from.clone();
  for (let i = 1; i <= nseg; i++) {
    d.y += curl / nseg;
    d.x += rng.range(-0.15, 0.15); d.z += rng.range(-0.15, 0.15);
    d.normalize();
    p.addScaledVector(d, len / nseg);
    pts.push(p.clone());
  }
  return pts;
}

// atlas regions (u0, v0, u1, v1) inside the shared foliage texture (4 x 2 cells)
const ATLAS = {
  leafA: [0, 0.5, 0.25, 1] as [number, number, number, number],
  leafB: [0.25, 0.5, 0.5, 1] as [number, number, number, number],
  needle: [0.5, 0.5, 0.75, 1] as [number, number, number, number],
  bush: [0.75, 0.5, 1, 1] as [number, number, number, number],
  frond: [0, 0, 0.25, 0.5] as [number, number, number, number],
  fern: [0.25, 0, 0.5, 0.5] as [number, number, number, number],
  twig: [0.5, 0, 0.75, 0.5] as [number, number, number, number],
};

// ------------------------------------------------------------------ species builders

function broadleaf(rng: Rng, far: boolean, alien = false): FloraModel {
  const H = rng.range(8, 11);
  const trunkH = H * rng.range(0.42, 0.52);
  const r0 = rng.range(0.24, 0.34);
  const bark: THREE.BufferGeometry[] = [], leaves: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  const lean = new THREE.Vector3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).normalize();
  const trunkPts = branchPath(rng, new THREE.Vector3(0, -0.4, 0), lean, trunkH + 0.4, 0.1, 5);
  bark.push(tube(trunkPts, (t) => r0 * (1 - t * 0.45) * (1 + Math.max(0, 0.18 - t) * 3.5), far ? 4 : 7, 0, 0.15, 2));
  const top = trunkPts[trunkPts.length - 1];
  const crown = top.clone().add(new THREE.Vector3(0, H * 0.22, 0));
  const nb = far ? 4 : rng.int(5, 7);
  const tips: THREE.Vector3[] = [];
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const at = trunkPts[Math.max(2, trunkPts.length - 1 - rng.int(0, 2))].clone().lerp(top, rng.range(0.2, 1));
    const dir = new THREE.Vector3(Math.cos(a), rng.range(0.55, 1.1), Math.sin(a));
    const len = H * rng.range(0.28, 0.4);
    const pts = branchPath(rng, at, dir, len, 0.25, far ? 2 : 4);
    if (!far || i < 3) bark.push(tube(pts, (t) => r0 * 0.55 * (1 - t * 0.75), far ? 3 : 5, 0.15, 0.6));
    tips.push(pts[pts.length - 1]);
    if (!far) {
      // secondary branches
      for (let k = 0; k < 2; k++) {
        const from = pts[rng.int(1, pts.length - 2)];
        const d2 = dir.clone().add(new THREE.Vector3(rng.range(-0.8, 0.8), rng.range(0, 0.6), rng.range(-0.8, 0.8))).normalize();
        const p2 = branchPath(rng, from, d2, len * 0.55, 0.2, 3);
        bark.push(tube(p2, (t) => r0 * 0.25 * (1 - t * 0.7), 3, 0.4, 0.8));
        tips.push(p2[p2.length - 1]);
      }
    }
  }
  tips.push(crown);
  // foliage: card clusters around branch tips, normals from the crown centre
  const canopyC = crown.clone().add(new THREE.Vector3(0, -H * 0.08, 0));
  const per = far ? 2 : 8;
  const size = far ? H * 0.2 : H * 0.115;
  for (const tip of tips) {
    for (let k = 0; k < per; k++) {
      const c = tip.clone().add(new THREE.Vector3(rng.range(-1, 1), rng.range(-0.6, 0.9), rng.range(-1, 1)).multiplyScalar(H * 0.09));
      const yaw = rng.range(0, Math.PI * 2), tilt = rng.range(-0.6, 0.6);
      const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(size);
      const upv = new THREE.Vector3(-Math.sin(yaw) * Math.sin(tilt), Math.cos(tilt), Math.cos(yaw) * Math.sin(tilt)).multiplyScalar(size);
      leaves.push(card(c, right, upv, rng.chance(0.5) ? ATLAS.leafA : ATLAS.leafB, 1, canopyC));
      if (alien && !far && rng.chance(0.18)) {
        const pod = new THREE.IcosahedronGeometry(rng.range(0.07, 0.12), 0);
        pod.translate(c.x, c.y - size * 0.8, c.z);
        glow.push(withFlex(pod, () => 1));
      }
    }
  }
  const parts: FloraPart[] = [{ geo: merge(bark), mat: 'bark' }, { geo: merge(leaves), mat: 'leaf' }];
  if (glow.length) parts.push({ geo: merge(glow), mat: 'glow' });
  return { parts, height: H };
}

function conifer(rng: Rng, far: boolean): FloraModel {
  const H = rng.range(10, 14);
  const r0 = rng.range(0.22, 0.3);
  const bark = [tube([new THREE.Vector3(0, -0.4, 0), new THREE.Vector3(rng.range(-0.1, 0.1), H * 0.5, rng.range(-0.1, 0.1)), new THREE.Vector3(0, H, 0)], (t) => r0 * (1 - t * 0.9) * (1 + Math.max(0, 0.1 - t) * 4), far ? 5 : 8, 0, 0.5, 2)];
  const needles: THREE.BufferGeometry[] = [];
  const levels = far ? 5 : 12;
  for (let l = 0; l < levels; l++) {
    const t = l / (levels - 1);
    const y = H * (0.22 + t * 0.72);
    const R = (1 - t) * H * 0.26 + 0.35;
    const n = far ? 3 : rng.int(5, 7);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + l * 0.7 + rng.range(-0.2, 0.2);
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const droop = rng.range(0.15, 0.4);
      // branch card from trunk to radius, drooping outward
      const c = new THREE.Vector3(0, y, 0).addScaledVector(out, R * 0.5).add(new THREE.Vector3(0, -R * droop * 0.5, 0));
      const along = out.clone().multiplyScalar(R * 0.55).add(new THREE.Vector3(0, -R * droop * 0.55, 0));
      const side = new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(R * 0.42).add(new THREE.Vector3(0, R * 0.08, 0));
      needles.push(card(c, along, side, ATLAS.needle, 0.3 + t * 0.7, new THREE.Vector3(0, y + R * 0.3, 0), 0.5));
    }
  }
  // spire
  needles.push(card(new THREE.Vector3(0, H * 0.98, 0), new THREE.Vector3(0.5, 0, 0), new THREE.Vector3(0, 0.9, 0), ATLAS.needle, 1, new THREE.Vector3(0, H * 0.9, 0)));
  needles.push(card(new THREE.Vector3(0, H * 0.98, 0), new THREE.Vector3(0, 0, 0.5), new THREE.Vector3(0, 0.9, 0), ATLAS.needle, 1, new THREE.Vector3(0, H * 0.9, 0)));
  return { parts: [{ geo: merge(bark), mat: 'bark' }, { geo: merge(needles), mat: 'needle' }], height: H };
}

function palm(rng: Rng, far: boolean): FloraModel {
  const H = rng.range(7, 9.5);
  const bend = new THREE.Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize().multiplyScalar(H * 0.18);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector3(bend.x * t * t, -0.3 + H * t, bend.z * t * t));
  }
  const bark = [tube(pts, (t) => 0.2 * (1.15 - t * 0.4) + (t < 0.08 ? 0.12 * (1 - t / 0.08) : 0), far ? 5 : 8, 0, 0.35, 3)];
  const top = pts[pts.length - 1];
  const fronds: THREE.BufferGeometry[] = [];
  const n = far ? 6 : rng.int(10, 13);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const len = rng.range(3.0, 4.2);
    const lift = rng.range(0.2, 0.7);
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= (far ? 3 : 7); i++) {
      const t = i / (far ? 3 : 7);
      path.push(top.clone().addScaledVector(out, len * t).add(new THREE.Vector3(0, lift * len * t - len * 0.75 * t * t, 0)));
    }
    fronds.push(strip(path, new THREE.Vector3(-out.z, 0, out.x), (t) => 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)), 0.35, 1, [ATLAS.frond[0], ATLAS.frond[2]]));
  }
  // remap frond v to the atlas cell
  const fg = merge(fronds);
  const uv = fg.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, ATLAS.frond[1] + uv.getY(i) * (ATLAS.frond[3] - ATLAS.frond[1]));
  return { parts: [{ geo: merge(bark), mat: 'bark' }, { geo: fg, mat: 'frond' }], height: H };
}

function deadTree(rng: Rng, far: boolean): FloraModel {
  const H = rng.range(5, 7.5);
  const r0 = rng.range(0.16, 0.24);
  const bark: THREE.BufferGeometry[] = [];
  const trunk = branchPath(rng, new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(rng.range(-0.25, 0.25), 1, rng.range(-0.25, 0.25)), H * 0.75, 0, 5);
  bark.push(tube(trunk, (t) => r0 * (1 - t * 0.7) * (1 + Math.max(0, 0.15 - t) * 3), far ? 4 : 7, 0, 0.3, 2));
  const nb = far ? 3 : rng.int(4, 7);
  for (let i = 0; i < nb; i++) {
    const a = rng.range(0, Math.PI * 2);
    const from = trunk[rng.int(2, trunk.length - 1)];
    const p = branchPath(rng, from, new THREE.Vector3(Math.cos(a), rng.range(0.3, 1.0), Math.sin(a)), H * rng.range(0.25, 0.4), 0.15, far ? 2 : 4);
    bark.push(tube(p, (t) => r0 * 0.45 * (1 - t * 0.85), far ? 3 : 5, 0.2, 0.6));
    if (!far) {
      const p2 = branchPath(rng, p[2], new THREE.Vector3(rng.range(-1, 1), rng.range(0.4, 1), rng.range(-1, 1)), H * 0.15, 0.1, 3);
      bark.push(tube(p2, (t) => r0 * 0.18 * (1 - t * 0.8), 3, 0.5, 0.8));
    }
  }
  return { parts: [{ geo: merge(bark), mat: 'barkPale' }], height: H };
}

function bush(rng: Rng, far: boolean, variant: number): FloraModel {
  const R = rng.range(0.8, 1.2);
  const leaves: THREE.BufferGeometry[] = [];
  const n = far ? 5 : rng.int(12, 18);
  const c0 = new THREE.Vector3(0, R * 0.45, 0);
  for (let k = 0; k < n; k++) {
    const d = new THREE.Vector3(rng.range(-1, 1), rng.range(0.1, 1), rng.range(-1, 1)).normalize();
    const c = c0.clone().addScaledVector(d, R * rng.range(0.2, 0.6));
    const yaw = rng.range(0, Math.PI * 2);
    const s = R * rng.range(0.45, 0.65);
    leaves.push(card(c, new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(s), new THREE.Vector3(0, s * 0.85, 0).add(new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(s * rng.range(-0.4, 0.4))), variant === 2 ? ATLAS.twig : ATLAS.bush, 0.6, c0, 0.5));
  }
  return { parts: [{ geo: merge(leaves), mat: 'leaf' }], height: R * 1.1 };
}

function fern(rng: Rng): FloraModel {
  const fronds: THREE.BufferGeometry[] = [];
  const n = rng.int(7, 10);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const len = rng.range(0.7, 1.1);
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      path.push(out.clone().multiplyScalar(len * t * 0.9).add(new THREE.Vector3(0, len * (0.9 * t - 0.75 * t * t), 0)));
    }
    fronds.push(strip(path, new THREE.Vector3(-out.z, 0, out.x), (t) => 0.2 * Math.sin(Math.PI * Math.min(1, t + 0.05)), 0.2, 1, [ATLAS.fern[0], ATLAS.fern[2]]));
  }
  const g = merge(fronds);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, ATLAS.fern[1] + uv.getY(i) * (ATLAS.fern[3] - ATLAS.fern[1]));
  return { parts: [{ geo: g, mat: 'frond' }], height: 0.9 };
}

function fungusGiant(rng: Rng, far: boolean): FloraModel {
  const H = rng.range(4.5, 7);
  const stem = tube([new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(rng.range(-0.3, 0.3), H * 0.5, rng.range(-0.3, 0.3)), new THREE.Vector3(0, H, 0)], (t) => 0.35 * (1.3 - t * 0.5) + (t < 0.1 ? 0.25 * (1 - t / 0.1) : 0), far ? 6 : 10, 0, 0.3, 1);
  const capR = H * rng.range(0.32, 0.45);
  const prof: THREE.Vector2[] = [];
  const steps = far ? 6 : 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 0.5;
    prof.push(new THREE.Vector2(Math.sin(a) * capR * (1 + 0.08 * Math.sin(t * 9)), Math.cos(a) * capR * 0.45));
  }
  prof.reverse();
  const cap = new THREE.LatheGeometry(prof, far ? 10 : 24);
  cap.translate(0, H - capR * 0.1, 0);
  const gills = new THREE.CircleGeometry(capR * 0.97, far ? 10 : 24);
  gills.rotateX(Math.PI / 2);
  gills.translate(0, H - capR * 0.1 + 0.02, 0);
  return {
    parts: [
      { geo: merge([stem]), mat: 'fungusStem' },
      { geo: merge([withFlex(cap, (p) => Math.min(1, p.y / H) * 0.3)]), mat: 'fungusCap' },
      { geo: merge([withFlex(gills, () => 0.3)]), mat: 'glow' },
    ],
    height: H,
  };
}

function fungusSmall(rng: Rng): FloraModel {
  const stems: THREE.BufferGeometry[] = [], caps: THREE.BufferGeometry[] = [];
  const n = rng.int(3, 6);
  for (let k = 0; k < n; k++) {
    const x = rng.range(-0.35, 0.35), z = rng.range(-0.35, 0.35), h = rng.range(0.25, 0.7);
    stems.push(tube([new THREE.Vector3(x, -0.05, z), new THREE.Vector3(x + rng.range(-0.05, 0.05), h * 0.5, z), new THREE.Vector3(x, h, z)], () => 0.035 + h * 0.03, 6, 0, 0.3));
    const r = h * rng.range(0.35, 0.55);
    const cap = new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
    cap.scale(1, 0.55, 1);
    cap.translate(x, h, z);
    caps.push(cap);
  }
  return { parts: [{ geo: merge(stems), mat: 'fungusStem' }, { geo: merge(caps), mat: 'fungusCap' }], height: 0.8 };
}

function crystal(rng: Rng): FloraModel {
  const list: THREE.BufferGeometry[] = [];
  const n = rng.int(5, 9);
  for (let k = 0; k < n; k++) {
    const h = k === 0 ? rng.range(1.6, 2.4) : rng.range(0.5, 1.6);
    const r = h * rng.range(0.12, 0.2);
    const g = new THREE.CylinderGeometry(r * 0.75, r, h, 6, 1);
    const tip = new THREE.ConeGeometry(r * 0.75, r * 1.6, 6);
    tip.translate(0, h / 2 + r * 0.8, 0);
    const prism = merge([g, tip]);
    prism.translate(0, h / 2, 0);
    const tilt = k === 0 ? rng.range(0, 0.15) : rng.range(0.25, 0.8);
    prism.rotateZ(tilt);
    prism.rotateY(rng.range(0, Math.PI * 2));
    prism.translate(rng.range(-0.25, 0.25), -0.15, rng.range(-0.25, 0.25));
    list.push(prism);
  }
  return { parts: [{ geo: merge(list), mat: 'crystal' }], height: 2.2 };
}

function coral(rng: Rng): FloraModel {
  const list: THREE.BufferGeometry[] = [];
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const p = branchPath(rng, from, dir, len, 0.3, 3);
    list.push(tube(p, (t) => r * (1 - t * 0.5), 6, depth * 0.3, depth * 0.3 + 0.3));
    if (depth < 2) for (let k = 0; k < 2; k++) grow(p[p.length - 1], new THREE.Vector3(rng.range(-1, 1), rng.range(0.5, 1.2), rng.range(-1, 1)), len * 0.7, r * 0.7, depth + 1);
  };
  for (let k = 0; k < 3; k++) grow(new THREE.Vector3(rng.range(-0.2, 0.2), -0.1, rng.range(-0.2, 0.2)), new THREE.Vector3(rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5)), rng.range(0.5, 0.8), 0.08, 0);
  return { parts: [{ geo: merge(list), mat: 'coral' }], height: 1.6 };
}

function rock(rng: Rng, far = false): FloraModel {
  const g = new THREE.IcosahedronGeometry(1, far ? 1 : 3);
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  const seeds = [rng.range(0, 100), rng.range(0, 100), rng.range(0, 100)];
  const flat = rng.range(0.45, 0.75);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 3.1 + seeds[0]) * 0.12 + Math.sin(v.y * 4.3 + seeds[1]) * 0.1 + Math.sin(v.z * 5.7 + seeds[2]) * 0.08 + Math.sin((v.x + v.z) * 9.1 + seeds[0]) * 0.04;
    v.multiplyScalar(1 + n);
    v.y *= flat;
    // chipped faces
    if (v.y > 0.35 * flat) v.y = 0.35 * flat + (v.y - 0.35 * flat) * 0.4;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return { parts: [{ geo: g.index ? g.toNonIndexed() : g, mat: 'rock' }], height: flat };
}

/** Build every species/variant in both detail levels. */
export function buildFloraModels(): Map<string, FloraModel> {
  const out = new Map<string, FloraModel>();
  for (let kind = 0; kind < FK.COUNT; kind++) {
    const nv = VARIANTS[kind] ?? 1;
    for (let v = 0; v < nv; v++) {
      for (const far of [false, true]) {
        const rng = new Rng(9100 + kind * 97 + v * 13);
        let m: FloraModel;
        switch (kind) {
          case FK.TREE_BROAD: m = broadleaf(rng, far); break;
          case FK.TREE_ALIEN: m = broadleaf(rng, far, true); break;
          case FK.TREE_CONIFER: m = conifer(rng, far); break;
          case FK.TREE_PALM: m = palm(rng, far); break;
          case FK.TREE_DEAD: m = deadTree(rng, far); break;
          case FK.BUSH: m = bush(rng, far, v); break;
          case FK.FERN: m = fern(rng); break;
          case FK.FUNGUS_GIANT: m = fungusGiant(rng, far); break;
          case FK.FUNGUS_SMALL: m = fungusSmall(rng); break;
          case FK.CRYSTAL: m = crystal(rng); break;
          case FK.CORAL: m = coral(rng); break;
          default: m = rock(rng, far); break;
        }
        out.set(`${kind}:${v}:${far ? 1 : 0}`, m);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** Foliage atlas (4 x 2 cells): two leaf clusters, needles, bush leaves, palm frond, fern, twigs. Neutral greens (tinted per planet). */
export function foliageTexture(): THREE.CanvasTexture {
  const S = 1024, CW = S / 4, CH = S / 2;
  const [c, g] = canvas(S, S);
  g.clearRect(0, 0, S, S);
  const rnd = new Rng(4242);
  const shade = (k: number, a = 1) => {
    const v = 0.55 + k * 0.45;
    return `rgba(${Math.round(120 * v)},${Math.round(150 * v)},${Math.round(95 * v)},${a})`;
  };
  // canvas y grows downward; atlas v grows upward: cell (cx, row) -> v in [row*0.5, row*0.5+0.5]
  const cell = (cx: number, row: number) => ({ x: cx * CW, y: (1 - row) * CH });
  const leafShape = (x: number, y: number, len: number, wid: number, ang: number, col: string) => {
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid, -len * 0.45, 0, -len);
    g.quadraticCurveTo(-wid, -len * 0.45, 0, 0);
    g.fill();
    g.strokeStyle = 'rgba(40,55,30,0.35)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -len * 0.95); g.stroke();
    g.restore();
  };
  // leaf clusters (two styles)
  for (const [cx, style] of [[0, 0], [1, 1]] as const) {
    const o = cell(cx, 1);
    for (let i = 0; i < (style ? 150 : 190); i++) {
      const a = rnd.range(0, Math.PI * 2), r = Math.sqrt(rnd.next()) * CW * 0.44;
      const x = o.x + CW / 2 + Math.cos(a) * r, y = o.y + CH / 2 + Math.sin(a) * r;
      const len = style ? rnd.range(26, 40) : rnd.range(18, 28);
      leafShape(x, y, len, len * (style ? 0.22 : 0.4), rnd.range(0, Math.PI * 2), shade(rnd.next() * (0.4 + 0.6 * (1 - r / (CW * 0.44)))));
    }
  }
  // needles: drooping branch with dense needles
  {
    const o = cell(2, 1);
    g.strokeStyle = 'rgb(70,55,40)';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(o.x + CW * 0.5, o.y + CH * 0.98); g.lineTo(o.x + CW * 0.5, o.y + CH * 0.04); g.stroke();
    for (let i = 0; i < 520; i++) {
      const t = rnd.next();
      const y = o.y + CH * (0.04 + t * 0.94);
      const side = rnd.chance(0.5) ? 1 : -1;
      const len = CW * 0.46 * (1 - Math.abs(t - 0.45) * 0.9) * rnd.range(0.6, 1);
      g.strokeStyle = shade(rnd.range(0.1, 0.6));
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(o.x + CW * 0.5, y); g.lineTo(o.x + CW * 0.5 + side * len, y + rnd.range(4, 18)); g.stroke();
    }
  }
  // bush leaves: rounder, denser
  {
    const o = cell(3, 1);
    for (let i = 0; i < 260; i++) {
      const a = rnd.range(0, Math.PI * 2), r = Math.sqrt(rnd.next()) * CW * 0.46;
      leafShape(o.x + CW / 2 + Math.cos(a) * r, o.y + CH / 2 + Math.sin(a) * r * 0.9, rnd.range(14, 22), 9, rnd.range(0, Math.PI * 2), shade(rnd.next() * 0.9));
    }
  }
  // palm frond: rachis along v with long leaflets
  const frondCell = (cx: number, leaflet: number, count: number) => {
    const o = cell(cx, 0);
    g.strokeStyle = 'rgb(110,105,60)';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(o.x + CW / 2, o.y + CH); g.lineTo(o.x + CW / 2, o.y); g.stroke();
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const y = o.y + CH * (1 - t);
      for (const side of [-1, 1]) {
        const len = CW * 0.48 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.04)) * rnd.range(0.85, 1);
        leafShape(o.x + CW / 2, y, len, leaflet, side * (Math.PI / 2 - 0.5) + rnd.range(-0.1, 0.1), shade(rnd.range(0.2, 0.8)));
      }
    }
  };
  frondCell(0, 7, 60);
  frondCell(1, 5, 44);
  // twigs (dry bush)
  {
    const o = cell(2, 0);
    g.strokeStyle = 'rgb(120,95,70)';
    for (let i = 0; i < 60; i++) {
      g.lineWidth = rnd.range(1, 3);
      const x = o.x + CW / 2 + rnd.range(-20, 20), y = o.y + CH;
      const a = rnd.range(-1.2, 1.2);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * CH * 0.9, y - Math.cos(a) * CH * 0.9); g.stroke();
    }
    for (let i = 0; i < 90; i++) leafShape(o.x + rnd.range(20, CW - 20), o.y + rnd.range(20, CH - 30), 10, 5, rnd.range(0, 6.28), 'rgba(140,130,80,0.9)');
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  return t;
}

/** Bark: vertical fissures (albedo + normal). `pale` gives weathered dead wood. */
export function barkTextures(pale: boolean): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const W = 256, H = 512;
  const [c, g] = canvas(W, H);
  const [cn, gn] = canvas(W, H);
  const rnd = new Rng(pale ? 77 : 33);
  const base = pale ? [150, 140, 128] : [92, 72, 56];
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0, 0, W, H);
  gn.fillStyle = 'rgb(128,128,255)';
  gn.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {
    let x = rnd.range(0, W);
    const w = rnd.range(2, 6);
    const y0 = rnd.range(-H * 0.2, H), len = rnd.range(H * 0.2, H * 0.7);
    const k = rnd.range(0.45, 0.7);
    g.strokeStyle = `rgb(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)})`;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y0);
    for (let y = y0; y < y0 + len; y += 16) { x += rnd.range(-3, 3); g.lineTo(x, y); }
    g.stroke();
    gn.strokeStyle = 'rgb(70,128,230)';
    gn.lineWidth = w * 0.6;
    gn.stroke();
  }
  for (let i = 0; i < 1600; i++) {
    const k = rnd.range(0.85, 1.15);
    g.fillStyle = `rgba(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)},0.35)`;
    g.fillRect(rnd.range(0, W), rnd.range(0, H), rnd.range(2, 8), rnd.range(2, 10));
  }
  if (!pale) for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${rnd.int(90, 130)},${rnd.int(120, 150)},${rnd.int(80, 100)},0.25)`;
    g.beginPath(); g.arc(rnd.range(0, W), rnd.range(0, H), rnd.range(4, 14), 0, Math.PI * 2); g.fill();
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const normal = new THREE.CanvasTexture(cn);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  return { map, normal };
}

export const CRYSTAL_COLORS: Record<number, [number, number, number]> = {
  [CRYSTAL_VARIANT.QUARTZ]: [0.85, 0.9, 0.95],
  [CRYSTAL_VARIANT.LUMINITE]: [0.65, 0.35, 1.0],
  [CRYSTAL_VARIANT.ICE]: [0.6, 0.85, 1.0],
  [CRYSTAL_VARIANT.CRYOLITH]: [0.4, 0.95, 1.0],
  [CRYSTAL_VARIANT.AURELITE]: [1.0, 0.72, 0.25],
};

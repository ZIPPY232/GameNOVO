import * as THREE from 'three';
import { FK, FLORA_STRIDE, FLORA_INFO, CRYSTAL_DROP } from '../planet/flora';
import { buildFloraModels, foliageTexture, barkTextures, VARIANTS, CRYSTAL_COLORS, type FloraMatKey, type FloraModel } from '../render/FloraModels';
import { gridToPos, canonicalCell, posToGrid } from '../planet/cubesphere';
import { CHUNK } from '../planet/terrain';
import { hashFloat } from '../core/rng';
import type { WorkerPool } from '../voxel/workerProtocol';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import type { PlanetGenParams } from '../universe/types';

/**
 * 3D vegetation around the player: per chunk column the terrain worker returns
 * deterministic instances (species, position, scale, yaw); this system turns
 * them into instanced meshes with two levels of detail, wind sway, trunk
 * collisions and harvesting. Harvested plants are remembered per planet.
 */

interface Column {
  key: string;
  face: number;
  cx: number;
  cy: number;
  inst: Float32Array | null;
  /** planet-local base position per instance */
  pos: Float32Array | null;
  pending: boolean;
  lastNeeded: number;
}

interface Batch {
  meshes: THREE.InstancedMesh[];
  capacity: number;
  count: number;
  far: boolean;
}

export interface FloraHit {
  col: string;
  index: number;
  kind: number;
  variant: number;
  dist: number;
  point: THREE.Vector3;
}

/** kinds only drawn close by (small plants) */
const SMALL = new Set<number>([FK.BUSH, FK.FERN, FK.FUNGUS_SMALL, FK.CORAL]);

export class FloraSystem {
  readonly group = new THREE.Group();
  /** harvested plants per body key: "face,cx,cy#index" */
  readonly removed = new Map<string, Set<string>>();
  private models: Map<string, FloraModel>;
  private mats: Record<FloraMatKey, THREE.Material>;
  private batches = new Map<string, Batch>();
  private cols = new Map<string, Column>();
  private pool: WorkerPool;
  private world: VoxelWorld | null = null;
  private params: PlanetGenParams | null = null;
  private bodyKey = '';
  private frame = 0;
  private center = new THREE.Vector3(1e9, 0, 0);
  private dirty = true;
  private rebuildT = 0;
  private wind = { uTime: { value: 0 }, uWind: { value: 1 } };
  readonly rockMat: THREE.IUniform<number> = { value: 2 };
  nearR = 75;
  /** planet-local areas kept clear of plants (landed ship, bases, ruins) */
  clearZones: { p: THREE.Vector3; r: number }[] = [];
  private clearKey = '';
  farR = 300;
  enabled = true;

  constructor(pool: WorkerPool, rockMaterial: (force: THREE.IUniform<number>) => THREE.Material) {
    this.pool = pool;
    this.group.name = 'flora';
    this.models = buildFloraModels();
    const foliage = foliageTexture();
    const bark = barkTextures(false), pale = barkTextures(true);
    const windy = (m: THREE.MeshStandardMaterial, flutter: boolean, tintEmissive = false): THREE.MeshStandardMaterial => {
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.wind);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWind;
attribute float aFlex;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 ip = vec3(instanceMatrix[3]);
#else
vec3 ip = vec3(0.0);
#endif
float ph = dot(ip, vec3(0.131, 0.173, 0.117));
float f2 = aFlex * aFlex;
float sw = sin(uTime * 1.05 + ph) * 0.6 + sin(uTime * 2.27 + ph * 1.7) * 0.25;
transformed.x += sw * f2 * 0.22 * uWind;
transformed.z += cos(uTime * 0.87 + ph * 1.3) * f2 * 0.12 * uWind;
${flutter ? 'transformed += objectNormal * sin(uTime * 6.5 + position.x * 2.7 + position.z * 3.1 + ph) * 0.035 * aFlex * uWind;' : ''}`);
        if (tintEmissive) {
          shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_INSTANCING_COLOR
totalEmissiveRadiance *= vColor;
#endif`);
        }
      };
      m.customProgramCacheKey = () => `flora-${flutter ? 1 : 0}-${tintEmissive ? 1 : 0}-${m.alphaTest > 0 ? 1 : 0}`;
      return m;
    };
    const leafBase = { map: foliage, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.72, metalness: 0 } as const;
    this.mats = {
      bark: windy(new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normal, normalScale: new THREE.Vector2(1, 1), roughness: 0.92 }), false),
      barkPale: windy(new THREE.MeshStandardMaterial({ map: pale.map, normalMap: pale.normal, roughness: 0.88 }), false),
      leaf: windy(new THREE.MeshStandardMaterial({ ...leafBase }), true),
      needle: windy(new THREE.MeshStandardMaterial({ ...leafBase, color: 0x6f8a70 }), true),
      frond: windy(new THREE.MeshStandardMaterial({ ...leafBase, color: 0xc8d49a }), true),
      fungusCap: windy(new THREE.MeshStandardMaterial({ color: 0xb07ad8, roughness: 0.55, emissive: 0x2a0f3a, emissiveIntensity: 0.6 }), false),
      fungusStem: windy(new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 }), false),
      glow: windy(new THREE.MeshStandardMaterial({ color: 0x223322, emissive: 0x7dfff0, emissiveIntensity: 1.4 }), false),
      crystal: windy(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.9, transparent: false }), false, true),
      coral: windy(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, emissive: 0xffffff, emissiveIntensity: 0.25 }), false, true),
      rock: rockMaterial(this.rockMat),
    };
  }

  /** Point at the planet whose surface we are on (or null). */
  setPlanet(bodyKey: string, world: VoxelWorld | null, params: PlanetGenParams | null, parent: THREE.Object3D | null): void {
    if (bodyKey !== this.bodyKey || world !== this.world) {
      this.cols.clear();
      this.clearBatches();
      this.bodyKey = bodyKey;
      this.world = world;
      this.params = params;
      this.center.set(1e9, 0, 0);
      this.dirty = true;
      if (params) {
        const t = params.bioTint;
        (this.mats.leaf as THREE.MeshStandardMaterial).color.setRGB(t[0] * 1.6, t[1] * 1.6, t[2] * 1.6);
        (this.mats.needle as THREE.MeshStandardMaterial).color.setRGB(t[0] * 1.05, t[1] * 1.15, t[2] * 1.05);
        (this.mats.frond as THREE.MeshStandardMaterial).color.setRGB(t[0] * 1.9, t[1] * 1.8, t[2] * 1.3);
        (this.mats.fungusCap as THREE.MeshStandardMaterial).color.setRGB(0.4 + t[2] * 0.8, 0.25 + t[0] * 0.5, 0.45 + t[1] * 0.7);
        (this.mats.glow as THREE.MeshStandardMaterial).emissive.setRGB(0.25 + t[2] * 0.6, 0.55 + t[1] * 0.5, 0.65 + t[0] * 0.4);
        this.rockMat.value = params.palette.rock;
      }
    }
    if (parent && this.group.parent !== parent) parent.add(this.group);
    if (!parent) this.group.removeFromParent();
  }

  private removedSet(): Set<string> {
    let s = this.removed.get(this.bodyKey);
    if (!s) { s = new Set(); this.removed.set(this.bodyKey, s); }
    return s;
  }

  private clearBatches(): void {
    for (const b of this.batches.values()) for (const m of b.meshes) { m.removeFromParent(); m.dispose(); }
    this.batches.clear();
  }

  private batch(key: string, need: number): Batch {
    let b = this.batches.get(key);
    if (b && b.capacity >= need) return b;
    const cap = Math.max(16, Math.ceil(need * 1.5));
    if (b) for (const m of b.meshes) { m.removeFromParent(); m.dispose(); }
    const model = this.models.get(key)!;
    const far = key.endsWith(':1');
    const kind = Number(key.split(':')[0]);
    const meshes = model.parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geo, this.mats[p.mat], cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      m.frustumCulled = false;
      m.castShadow = !far && kind !== FK.FERN;
      m.receiveShadow = true;
      m.count = 0;
      this.group.add(m);
      return m;
    });
    b = { meshes, capacity: cap, count: 0, far };
    this.batches.set(key, b);
    return b;
  }

  /** Stream columns and rebuild instance buffers around a planet-local position. */
  update(local: THREE.Vector3 | null, dt: number, time: number, wind: number, density: number): void {
    this.wind.uTime.value = time;
    this.wind.uWind.value = 0.5 + Math.min(2.5, wind / 7);
    if (!this.world || !this.params || !local || !this.enabled) { this.group.visible = false; return; }
    this.group.visible = true;
    this.frame++;
    this.farR = 140 + 220 * Math.min(1.2, density);
    const p = this.params;
    const g = [0, 0, 0], c = [0, 0];
    const face = posToGrid(local.x, local.y, local.z, p.N, p.baseRadius, g);
    const pcx = Math.floor(g[0] / CHUNK), pcy = Math.floor(g[1] / CHUNK);
    const R = Math.ceil(this.farR / CHUNK) + 1;
    const cpc = p.N / CHUNK;
    let requested = 0;
    for (let ring = 0; ring <= R; ring++) {
      for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        let f = face, cx = pcx + dx, cy = pcy + dy;
        if (cx < 0 || cx >= cpc || cy < 0 || cy >= cpc) {
          f = canonicalCell(face, cx * CHUNK + 16, cy * CHUNK + 16, p.N, c);
          cx = c[0] >> 5; cy = c[1] >> 5;
        }
        const key = f + ',' + cx + ',' + cy;
        let col = this.cols.get(key);
        if (!col) {
          if (requested > 6) continue;
          col = { key, face: f, cx, cy, inst: null, pos: null, pending: true, lastNeeded: this.frame };
          this.cols.set(key, col);
          requested++;
          const cc = col;
          this.pool.run({ type: 'flora', bodyId: this.world.bodyId, face: f, cx, cy }, 20 + ring * 4, [], () => this.cols.get(key) !== cc)
            .then((r) => {
              if (this.cols.get(key) !== cc) return;
              cc.inst = (r as unknown as { inst: Float32Array }).inst;
              cc.pending = false;
              this.computePositions(cc);
              this.dirty = true;
            })
            .catch(() => { if (this.cols.get(key) === cc) this.cols.delete(key); });
        }
        col.lastNeeded = this.frame;
      }
    }
    if (this.frame % 60 === 0) for (const [k, col] of this.cols) if (this.frame - col.lastNeeded > 120) this.cols.delete(k);
    this.rebuildT -= dt;
    if ((this.dirty && this.rebuildT <= 0) || local.distanceTo(this.center) > 8) {
      this.rebuild(local);
      this.rebuildT = 0.5;
    }
  }

  private computePositions(col: Column): void {
    const inst = col.inst!;
    const n = inst.length / FLORA_STRIDE;
    const pos = new Float32Array(n * 3);
    const p = this.params!;
    const out = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const o = i * FLORA_STRIDE;
      gridToPos(col.face, inst[o + 1], inst[o + 2], inst[o + 3], p.N, p.baseRadius, out);
      pos[i * 3] = out[0]; pos[i * 3 + 1] = out[1]; pos[i * 3 + 2] = out[2];
    }
    col.pos = pos;
  }

  /** Mark a column's instances for a ground re-check (after digging). */
  invalidate(): void {
    this.dirty = true;
  }

  private rebuild(local: THREE.Vector3): void {
    this.dirty = false;
    this.center.copy(local);
    const removed = this.removedSet();
    const w = this.world!;
    // gather instances per model key
    const lists = new Map<string, number[]>();
    const push = (key: string, col: Column, i: number) => {
      let l = lists.get(key);
      if (!l) { l = []; lists.set(key, l); }
      l.push(this.colIndex(col), i);
    };
    this.colList.length = 0;
    const near2 = this.nearR * this.nearR, far2 = this.farR * this.farR, small2 = 60 * 60;
    for (const col of this.cols.values()) {
      if (!col.inst || !col.pos) continue;
      const edited = w.columnEdited(col.face, col.cx, col.cy);
      const inst = col.inst, pos = col.pos;
      const n = inst.length / FLORA_STRIDE;
      for (let i = 0; i < n; i++) {
        const dx = pos[i * 3] - local.x, dy = pos[i * 3 + 1] - local.y, dz = pos[i * 3 + 2] - local.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > far2) continue;
        const o = i * FLORA_STRIDE;
        const kind = inst[o];
        if (SMALL.has(kind) && d2 > small2) continue;
        if (removed.has(col.key + '#' + i)) continue;
        if (this.inClearZone(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], kind)) continue;
        // ground dug out from under the plant?
        if (edited && w.sample(col.face, inst[o + 1], inst[o + 2], inst[o + 3] - 0.35) < 0.5) continue;
        const v = (inst[o + 6] | 0) % (VARIANTS[kind] ?? 1);
        const far = d2 > (kind === FK.ROCK || kind === FK.CRYSTAL ? near2 * 0.5 : near2);
        push(`${kind}:${v}:${far ? 1 : 0}`, col, i);
      }
    }
    for (const b of this.batches.values()) { b.count = 0; for (const m of b.meshes) m.count = 0; }
    const m4 = new THREE.Matrix4(), up = new THREE.Vector3(), t = new THREE.Vector3(), bt = new THREE.Vector3(), q = new THREE.Vector3();
    const color = new THREE.Color();
    for (const [key, l] of lists) {
      const count = l.length / 2;
      const b = this.batch(key, count);
      const arr = b.meshes[0].instanceMatrix.array as Float32Array;
      const carr = b.meshes[0].instanceColor!.array as Float32Array;
      for (let k = 0; k < count; k++) {
        const col = this.colList[l[k * 2]], i = l[k * 2 + 1];
        const o = i * FLORA_STRIDE;
        const inst = col.inst!, pos = col.pos!;
        const kind = inst[o];
        q.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        up.copy(q).normalize();
        t.set(0, 1, 0).cross(up);
        if (t.lengthSq() < 1e-6) t.set(1, 0, 0).cross(up);
        t.normalize().applyAxisAngle(up, inst[o + 5]);
        bt.crossVectors(t, up);
        const s = inst[o + 4];
        m4.makeBasis(t.multiplyScalar(s), up.clone().multiplyScalar(s), bt.multiplyScalar(s));
        m4.setPosition(q);
        m4.toArray(arr, k * 16);
        // per-instance tint
        const h = hashFloat(inst[o + 7] | 0, 5);
        if (kind === FK.CRYSTAL) { const cc = CRYSTAL_COLORS[(inst[o + 6] | 0) % 5]; color.setRGB(cc[0], cc[1], cc[2]); }
        else if (kind === FK.CORAL) color.setHSL((0.95 + h * 0.2) % 1, 0.6, 0.55);
        else { const v = 0.82 + h * 0.36; color.setRGB(v, v * (0.96 + h * 0.08), v * 0.96); }
        color.toArray(carr, k * 3);
      }
      b.count = count;
      for (let pi = 0; pi < b.meshes.length; pi++) {
        const m = b.meshes[pi];
        if (pi > 0) {
          (m.instanceMatrix.array as Float32Array).set(arr.subarray(0, count * 16));
          (m.instanceColor!.array as Float32Array).set(carr.subarray(0, count * 3));
        }
        m.count = count;
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor!.needsUpdate = true;
      }
    }
  }

  /** Replace the clear zones; triggers a rebuild when they changed. */
  setClearZones(z: { p: THREE.Vector3; r: number }[]): void {
    const key = z.map((c) => `${c.p.x.toFixed(0)},${c.p.y.toFixed(0)},${c.p.z.toFixed(0)},${c.r}`).join('|');
    if (key === this.clearKey) return;
    this.clearKey = key;
    this.clearZones = z;
    this.dirty = true;
    this.rebuildT = 0;
  }

  private inClearZone(x: number, y: number, z: number, kind: number): boolean {
    const small = kind === FK.FERN || kind === FK.FUNGUS_SMALL;
    for (const c of this.clearZones) {
      const r = small ? c.r * 0.6 : c.r;
      const dx = x - c.p.x, dy = y - c.p.y, dz = z - c.p.z;
      if (dx * dx + dy * dy + dz * dz < r * r) return true;
    }
    return false;
  }

  private colList: Column[] = [];
  private colIndex(col: Column): number {
    const i = this.colList.indexOf(col);
    if (i >= 0) return i;
    this.colList.push(col);
    return this.colList.length - 1;
  }

  /** visit solid plants near a planet-local point */
  private forNear(local: THREE.Vector3, radius: number, fn: (col: Column, i: number, kind: number, base: THREE.Vector3, scale: number) => void): void {
    if (!this.params) return;
    const p = this.params;
    const g = [0, 0, 0], c = [0, 0];
    const face = posToGrid(local.x, local.y, local.z, p.N, p.baseRadius, g);
    const pcx = Math.floor(g[0] / CHUNK), pcy = Math.floor(g[1] / CHUNK);
    const removed = this.removedSet();
    const base = new THREE.Vector3();
    const r2 = radius * radius;
    const seen = new Set<string>();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let f = face, cx = pcx + dx, cy = pcy + dy;
      if (cx < 0 || cy < 0 || cx >= p.N / CHUNK || cy >= p.N / CHUNK) {
        f = canonicalCell(face, cx * CHUNK + 16, cy * CHUNK + 16, p.N, c);
        cx = c[0] >> 5; cy = c[1] >> 5;
      }
      const key = f + ',' + cx + ',' + cy;
      if (seen.has(key)) continue;
      seen.add(key);
      const col = this.cols.get(key);
      if (!col || !col.inst || !col.pos) continue;
      const n = col.inst.length / FLORA_STRIDE;
      for (let i = 0; i < n; i++) {
        base.set(col.pos[i * 3], col.pos[i * 3 + 1], col.pos[i * 3 + 2]);
        if (base.distanceToSquared(local) > r2) continue;
        if (removed.has(col.key + '#' + i)) continue;
        fn(col, i, col.inst[i * FLORA_STRIDE], base, col.inst[i * FLORA_STRIDE + 4]);
      }
    }
  }

  /** Push a body (planet-local feet position) out of trunks and rocks. */
  collide(pos: THREE.Vector3, vel: THREE.Vector3, bodyR: number): void {
    const up = pos.clone().normalize();
    this.forNear(pos, 6, (_c, _i, kind, base, s) => {
      const info = FLORA_INFO[kind];
      if (!info.solid) return;
      const h = info.height * s;
      const rel = pos.clone().sub(base);
      const along = rel.dot(up);
      if (along > h * 0.9 || along < -1.5) return;
      const horiz = rel.addScaledVector(up, -along);
      const d = horiz.length();
      const minD = info.radius * s + bodyR;
      if (d >= minD || d < 1e-5) return;
      const n = horiz.multiplyScalar(1 / d);
      pos.addScaledVector(n, minD - d);
      const vn = vel.dot(n);
      if (vn < 0) vel.addScaledVector(n, -vn);
    });
  }

  /** Nearest plant hit by a ray (planet-local), for harvesting. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): FloraHit | null {
    let best: FloraHit | null = null;
    const up = origin.clone().normalize();
    this.forNear(origin, maxDist + 8, (col, i, kind, base, s) => {
      const info = FLORA_INFO[kind];
      const rad = info.radius * s * (info.solid ? 1.4 : 1.1);
      const top = base.clone().addScaledVector(up, info.height * s * (kind === FK.TREE_PALM || kind === FK.TREE_CONIFER ? 0.5 : 0.75));
      // closest approach between the ray and the plant axis segment
      const u = dir, v = top.clone().sub(base);
      const w0 = origin.clone().sub(base);
      const a = u.dot(u), b = u.dot(v), c = v.dot(v), d = u.dot(w0), e = v.dot(w0);
      const den = a * c - b * b;
      let sc = den > 1e-8 ? (b * e - c * d) / den : 0;
      let tc = den > 1e-8 ? (a * e - b * d) / den : 0;
      tc = Math.max(0, Math.min(1, tc));
      sc = Math.max(0, Math.min(maxDist, (tc * b - d) / a));
      const pr = origin.clone().addScaledVector(u, sc);
      const pa = base.clone().addScaledVector(v, tc);
      if (pr.distanceTo(pa) > rad) return;
      if (!best || sc < best.dist) {
        const o = i * FLORA_STRIDE;
        best = { col: col.key, index: i, kind, variant: col.inst![o + 6] | 0, dist: sc, point: pr };
      }
    });
    return best;
  }

  /** Remove a harvested plant; returns its drop. */
  harvest(hit: FloraHit): { drop: string | null; count: number } {
    this.removedSet().add(hit.col + '#' + hit.index);
    this.dirty = true;
    this.rebuildT = 0;
    const info = FLORA_INFO[hit.kind];
    if (hit.kind === FK.CRYSTAL) return { drop: CRYSTAL_DROP[hit.variant % 5] ?? 'silicon', count: info.count };
    return { drop: info.drop, count: info.count };
  }

  serialize(): Record<string, string[]> {
    const o: Record<string, string[]> = {};
    for (const [k, s] of this.removed) if (s.size) o[k] = [...s];
    return o;
  }

  load(d: Record<string, string[]> | undefined): void {
    this.removed.clear();
    if (d) for (const [k, v] of Object.entries(d)) this.removed.set(k, new Set(v));
    this.dirty = true;
  }
}

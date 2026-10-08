import * as THREE from 'three';
import { TerrainGenerator, CHUNK, CHUNK_SHIFT, CHUNK_VOL, STRUCTURE, densByte } from '../planet/terrain';
import { canonicalCell, posToGrid } from '../planet/cubesphere';
import { B, BLOCK_SOLID } from './blocks';
import { PAD, PAD2 } from './mesher';
import type { WorkerPool } from './workerProtocol';
import type { PlanetGenParams } from '../universe/types';
import { buildChunkGeometry, buildSmoothGeometry } from '../render/TerrainMaterial';

/**
 * Streams editable terrain chunks around the player for one planet.
 * Each chunk holds a material id and a density byte per cell (one buffer:
 * [materials | densities]); natural terrain is rendered as a smooth surface
 * and built blocks as cubes. Generated data is deterministic; only modified
 * chunks are persisted (see `edits`). Coordinates are planet-local.
 */

export enum ChunkState { Requested, Ready }

export interface ChunkRec {
  key: string;
  face: number;
  cx: number;
  cy: number;
  cz: number;
  /** materials view (first half of buf) */
  data: Uint8Array | null;
  /** densities view (second half of buf) */
  dens: Uint8Array | null;
  buf: Uint8Array | null;
  state: ChunkState;
  smooth: THREE.Mesh | null;
  /** padding was filled from the generator (neighbour not loaded yet) */
  padFallback: boolean;
  mesh: THREE.Mesh | null;
  trans: THREE.Mesh | null;
  version: number;
  meshedVersion: number;
  meshing: boolean;
  empty: boolean;
  modified: boolean;
  lastNeeded: number;
}

/** shared all-air chunk used for lookups into generated-empty chunks */
const EMPTY_CHUNK = new Uint8Array(CHUNK_VOL);

/** Upgrades a saved chunk from the old blocks-only format (densities from solidity). */
export function upgradeChunk(v: Uint8Array): Uint8Array {
  if (v.length === CHUNK_VOL * 2) return v;
  const out = new Uint8Array(CHUNK_VOL * 2);
  out.set(v.subarray(0, CHUNK_VOL));
  for (let i = 0; i < CHUNK_VOL; i++) {
    const b = out[i];
    out[CHUNK_VOL + i] = b === B.AIR || STRUCTURE[b] ? 0 : 255;
  }
  return out;
}

export function chunkKey(face: number, cx: number, cy: number, cz: number): string {
  return face + ',' + cx + ',' + cy + ',' + cz;
}

export class VoxelWorld {
  readonly bodyId: string;
  readonly params: PlanetGenParams;
  readonly gen: TerrainGenerator;
  readonly group = new THREE.Group();
  readonly chunks = new Map<string, ChunkRec>();
  /** persistent edited chunks: key -> [materials | densities] */
  readonly edits: Map<string, Uint8Array>;
  private pool: WorkerPool;
  private colRange = new Map<string, { min: number; max: number } | 'pending'>();
  private editCols = new Map<string, Set<number>>();
  private matOpaque: THREE.Material;
  private matTrans: THREE.Material;
  private matSmooth: THREE.Material;
  private frame = 0;
  private tmp = [0, 0, 0];
  private tmpC = [0, 0];
  /** radius (m) around the player fully covered by meshed voxel chunks */
  coverRadius = 0;
  private needed: { face: number; cx: number; cy: number; ring: number }[] = [];
  readonly cpc: number; // chunks per face edge
  onChunkMeshed: ((rec: ChunkRec) => void) | null = null;
  disposed = false;

  constructor(bodyId: string, params: PlanetGenParams, pool: WorkerPool, edits: Map<string, Uint8Array>, matOpaque: THREE.Material, matTrans: THREE.Material, matSmooth: THREE.Material) {
    this.bodyId = bodyId;
    this.params = params;
    this.gen = new TerrainGenerator(params);
    this.pool = pool;
    for (const [k, v] of edits) if (v.length !== CHUNK_VOL * 2) edits.set(k, upgradeChunk(v));
    this.edits = edits;
    this.matOpaque = matOpaque;
    this.matTrans = matTrans;
    this.matSmooth = matSmooth;
    this.cpc = params.N / CHUNK;
    for (const k of edits.keys()) this.indexEdit(k);
    this.group.name = 'voxels:' + bodyId;
  }

  private indexEdit(k: string): void {
    const [f, cx, cy, cz] = k.split(',').map(Number);
    const ck = f + ',' + cx + ',' + cy;
    let s = this.editCols.get(ck);
    if (!s) { s = new Set(); this.editCols.set(ck, s); }
    s.add(cz);
  }

  /** Has the player edited any chunk in this chunk column? */
  columnEdited(face: number, cx: number, cy: number): boolean {
    return this.editCols.has(face + ',' + cx + ',' + cy);
  }

  // ------------------------------------------------------------------ queries

  /** Block at integer cell, loaded data or edits; UNKNOWN if not available. */
  getLoaded(face: number, I: number, J: number, K: number): number {
    const p = this.params;
    if (K < 0) return B.BEDROCK;
    if (K >= p.layers) return B.AIR;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0]; J = this.tmpC[1];
    }
    const cx = I >> CHUNK_SHIFT, cy = J >> CHUNK_SHIFT, cz = K >> CHUNK_SHIFT;
    let data: Uint8Array | null;
    if (cx === this.lc[1] && cy === this.lc[2] && cz === this.lc[3] && face === this.lc[0] && this.lcFrame === this.frame) data = this.lcData;
    else {
      const key = chunkKey(face, cx, cy, cz);
      const rec = this.chunks.get(key);
      data = rec?.data ?? this.edits.get(key) ?? null;
      if (!data && rec && rec.state === ChunkState.Ready && rec.empty) data = EMPTY_CHUNK;
      this.lc[0] = face; this.lc[1] = cx; this.lc[2] = cy; this.lc[3] = cz;
      this.lcData = data;
      this.lcFrame = this.frame;
    }
    if (!data) return B.UNKNOWN;
    return data[(I & 31) + (J & 31) * CHUNK + (K & 31) * 1024];
  }

  /** last-chunk lookup cache (invalidated every streaming frame and on edits) */
  private lc = [-1, 0, 0, 0];
  private lcData: Uint8Array | null = null;
  private lcFrame = -1;

  /** Block at cell; falls back to deterministic generation (no flora) if not loaded. */
  getBlock(face: number, I: number, J: number, K: number): number {
    const b = this.getLoaded(face, I, J, K);
    if (b !== B.UNKNOWN) return b;
    // cheap fallback: above natural surface = air, below = solid rock
    const top = this.gen.surfaceTop(face, I, J);
    return K <= top ? B.ROCK : B.AIR;
  }

  isSolid(face: number, I: number, J: number, K: number): boolean {
    return BLOCK_SOLID[this.getBlock(face, I, J, K)] === 1;
  }

  /** raycasts that should pass through machine collision cells */
  ignoreMachines = false;
  private dk = [-1, 0, 0, 0];
  private dkData: Uint8Array | null = null;
  private dkFrame = -1;

  /**
   * Collision field at a cell, 0..1 (surface at 0.5): natural terrain density,
   * built cubes fully solid. Unloaded cells fall back to the generator's
   * continuous heights (no caves).
   */
  field(face: number, I: number, J: number, K: number): number {
    const p = this.params;
    if (K < 0) return 1;
    if (K >= p.layers) return 0;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0]; J = this.tmpC[1];
    }
    const cx = I >> CHUNK_SHIFT, cy = J >> CHUNK_SHIFT, cz = K >> CHUNK_SHIFT;
    let buf: Uint8Array | null;
    if (cx === this.dk[1] && cy === this.dk[2] && cz === this.dk[3] && face === this.dk[0] && this.dkFrame === this.frame) buf = this.dkData;
    else {
      const key = chunkKey(face, cx, cy, cz);
      const rec = this.chunks.get(key);
      buf = rec?.buf ?? this.edits.get(key) ?? null;
      if (!buf && rec && rec.state === ChunkState.Ready && rec.empty) buf = EMPTY_CHUNK;
      this.dk[0] = face; this.dk[1] = cx; this.dk[2] = cy; this.dk[3] = cz;
      this.dkData = buf;
      this.dkFrame = this.frame;
    }
    if (!buf) return this.fallbackField(face, I, J, K);
    if (buf === EMPTY_CHUNK) return 0;
    const idx = (I & 31) + (J & 31) * CHUNK + (K & 31) * 1024;
    const b = buf[idx];
    if (STRUCTURE[b]) return b === B.MACHINE_OPEN || (this.ignoreMachines && b === B.MACHINE) ? 0 : 1;
    return buf[CHUNK_VOL + idx] / 255;
  }

  /** natural field from continuous heights only (unloaded areas) */
  private fallbackField(face: number, I: number, J: number, K: number): number {
    const cs = this.gen.getColumns(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT);
    const ci = (I & 31) + (J & 31) * CHUNK;
    let d = cs.hz[ci] - (K + 0.5);
    if (cs.fill[ci]) d = Math.max(d, this.params.seaZ - (K + 0.5));
    return densByte(d) / 255;
  }

  /** Trilinear collision field at continuous grid coordinates (cell centres at +0.5). */
  sample(face: number, x: number, y: number, z: number): number {
    const fx = x - 0.5, fy = y - 0.5, fz = z - 0.5;
    const I = Math.floor(fx), J = Math.floor(fy), K = Math.floor(fz);
    const tx = fx - I, ty = fy - J, tz = fz - K;
    const c000 = this.field(face, I, J, K), c100 = this.field(face, I + 1, J, K);
    const c010 = this.field(face, I, J + 1, K), c110 = this.field(face, I + 1, J + 1, K);
    const c001 = this.field(face, I, J, K + 1), c101 = this.field(face, I + 1, J, K + 1);
    const c011 = this.field(face, I, J + 1, K + 1), c111 = this.field(face, I + 1, J + 1, K + 1);
    const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }

  /**
   * Height (grid z) of the highest surface crossing at (x, y) at or below zStart,
   * searching down to zStart - maxDown. Returns -Infinity if none.
   */
  surfaceBelow(face: number, x: number, y: number, zStart: number, maxDown: number): number {
    const step = 0.5;
    let zPrev = zStart;
    let fPrev = this.sample(face, x, y, zPrev);
    if (fPrev >= 0.5) {
      // start inside: climb to the surface (at most maxDown upward)
      for (let z = zStart + step; z <= zStart + maxDown; z += step) {
        const f = this.sample(face, x, y, z);
        if (f < 0.5) return this.refine(face, x, y, z - step, z);
      }
      return zStart + maxDown;
    }
    for (let z = zStart - step; z >= zStart - maxDown; z -= step) {
      const f = this.sample(face, x, y, z);
      if (f >= 0.5) return this.refine(face, x, y, z, zPrev);
      zPrev = z; fPrev = f;
    }
    return -Infinity;
  }

  /** bisection between a solid z (lo) and an empty z (hi) */
  private refine(face: number, x: number, y: number, lo: number, hi: number): number {
    for (let i = 0; i < 6; i++) {
      const m = (lo + hi) * 0.5;
      if (this.sample(face, x, y, m) >= 0.5) lo = m; else hi = m;
    }
    return (lo + hi) * 0.5;
  }

  /** Density byte of a loaded cell (generator fallback otherwise). */
  densAt(face: number, I: number, J: number, K: number): number {
    const p = this.params;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0]; J = this.tmpC[1];
    }
    const key = chunkKey(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT, K >> CHUNK_SHIFT);
    const rec = this.chunks.get(key);
    const buf = rec?.buf ?? this.edits.get(key) ?? null;
    if (!buf) return rec && rec.state === ChunkState.Ready && rec.empty ? 0 : Math.round(this.fallbackField(face, I, J, K) * 255);
    return buf[CHUNK_VOL + (I & 31) + (J & 31) * CHUNK + (K & 31) * 1024];
  }

  /** Natural surface radius at a planet-local direction (no edits). */
  surfaceRadius(dx: number, dy: number, dz: number): number {
    const h = this.gen.heightAt(dx, dy, dz);
    const p = this.params;
    const hh = (p.frozenOcean || p.lavaOcean) && h < 0 ? 0 : h;
    return p.baseRadius + p.seaZ + hh;
  }

  /** Highest solid cell in the column at or below startK (uses loaded data). */
  columnTop(face: number, I: number, J: number, startK: number): number {
    for (let k = Math.min(startK, this.params.layers - 1); k > 0; k--) {
      if (this.isSolid(face, I, J, k)) return k;
    }
    return 0;
  }

  // ------------------------------------------------------------------ edits

  setBlock(face: number, I: number, J: number, K: number, block: number, density?: number): boolean {
    this.lcFrame = -1;
    this.dkFrame = -1;
    const p = this.params;
    if (K < 1 || K >= p.layers) return false;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0]; J = this.tmpC[1];
    }
    const cx = I >> CHUNK_SHIFT, cy = J >> CHUNK_SHIFT, cz = K >> CHUNK_SHIFT;
    const key = chunkKey(face, cx, cy, cz);
    let rec = this.chunks.get(key);
    if (!rec || !rec.buf) {
      // ensure data exists synchronously (rare: editing an unloaded chunk)
      const buf = this.edits.get(key) ?? this.generateSync(face, cx, cy, cz);
      if (!rec) {
        rec = this.newRec(face, cx, cy, cz);
        this.chunks.set(key, rec);
      }
      this.attach(rec, buf);
      rec.state = ChunkState.Ready;
    }
    const idx = (I & 31) + (J & 31) * CHUNK + (K & 31) * 1024;
    const dens = density ?? (block === B.AIR || STRUCTURE[block] ? (STRUCTURE[block] ? 0 : Math.min(rec.dens![idx], 100)) : 255);
    if (rec.data![idx] === block && rec.dens![idx] === dens) return false;
    rec.data![idx] = block;
    rec.dens![idx] = dens;
    rec.modified = true;
    rec.empty = false;
    if (!this.edits.has(key)) {
      this.edits.set(key, rec.buf!);
      this.indexEdit(key);
    }
    rec.version++;
    this.requestMesh(rec, -1000);
    // neighbours whose padding contains this cell
    const lx = I & 31, ly = J & 31, lz = K & 31;
    const touched = new Set<string>([key]);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      if ((dx === -1 && lx !== 0) || (dx === 1 && lx !== 31)) continue;
      if ((dy === -1 && ly !== 0) || (dy === 1 && ly !== 31)) continue;
      if ((dz === -1 && lz !== 0) || (dz === 1 && lz !== 31)) continue;
      let nf = face, nI = I + dx, nJ = J + dy;
      if (nI < 0 || nI >= p.N || nJ < 0 || nJ >= p.N) {
        nf = canonicalCell(face, nI, nJ, p.N, this.tmpC);
        nI = this.tmpC[0]; nJ = this.tmpC[1];
      }
      const nK = K + dz;
      if (nK < 0 || nK >= p.layers) continue;
      const nk = chunkKey(nf, nI >> CHUNK_SHIFT, nJ >> CHUNK_SHIFT, nK >> CHUNK_SHIFT);
      if (touched.has(nk)) continue;
      touched.add(nk);
      const nr = this.chunks.get(nk);
      if (nr && nr.data) { nr.version++; this.requestMesh(nr, -900); }
      else if (nr && nr.state === ChunkState.Ready && nr.empty) { nr.version++; this.requestMesh(nr, -900); }
    }
    return true;
  }

  /**
   * Smoothly removes terrain inside a sphere (grid-space centre, radius in
   * cells). `amount` (0..1 per call) lowers densities with a soft falloff;
   * cells crossing below the surface become air. Returns the materials removed
   * (one entry per cell) so the caller can award resources. Bedrock, built
   * cubes and machines are untouched; `canDig(block)` filters harder blocks.
   */
  dig(face: number, x: number, y: number, z: number, radius: number, amount: number, canDig: (b: number) => boolean): number[] {
    const removed: number[] = [];
    const r = Math.ceil(radius + 1);
    const I0 = Math.floor(x), J0 = Math.floor(y), K0 = Math.floor(z);
    for (let k = K0 - r; k <= K0 + r; k++) for (let j = J0 - r; j <= J0 + r; j++) for (let i = I0 - r; i <= I0 + r; i++) {
      const dist = Math.hypot(i + 0.5 - x, j + 0.5 - y, k + 0.5 - z);
      const fall = 1 - dist / (radius + 0.75);
      if (fall <= 0) continue;
      const b = this.getBlock(face, i, j, k);
      if (b === B.AIR) {
        // shave fractional density outside the surface too, so the crater stays smooth
        const d0 = this.densAt(face, i, j, k);
        if (d0 > 0) this.setBlock(face, i, j, k, B.AIR, Math.max(0, Math.round(d0 - amount * fall * 255)));
        continue;
      }
      if (STRUCTURE[b] || b === B.BEDROCK || b >= B.MACHINE || !canDig(b)) continue;
      const d0 = this.densAt(face, i, j, k);
      const d1 = Math.round(d0 - amount * fall * 255);
      if (d1 < 128) {
        removed.push(b);
        this.setBlock(face, i, j, k, B.AIR, Math.max(0, d1));
      } else this.setBlock(face, i, j, k, b, d1);
    }
    return removed;
  }

  /**
   * Adds terrain material inside a sphere (grid-space centre, radius in cells):
   * densities rise with a soft falloff and cells crossing the surface become
   * `block`. Returns how many cells became solid.
   */
  fill(face: number, x: number, y: number, z: number, radius: number, amount: number, block: number): number {
    let added = 0;
    const r = Math.ceil(radius + 1);
    const I0 = Math.floor(x), J0 = Math.floor(y), K0 = Math.floor(z);
    for (let k = K0 - r; k <= K0 + r; k++) for (let j = J0 - r; j <= J0 + r; j++) for (let i = I0 - r; i <= I0 + r; i++) {
      const dist = Math.hypot(i + 0.5 - x, j + 0.5 - y, k + 0.5 - z);
      const fall = 1 - dist / (radius + 0.75);
      if (fall <= 0) continue;
      const b = this.getBlock(face, i, j, k);
      if (b !== B.AIR) {
        if (!STRUCTURE[b] && b < B.MACHINE) {
          const d0 = this.densAt(face, i, j, k);
          if (d0 < 255) this.setBlock(face, i, j, k, b, Math.min(255, Math.round(d0 + amount * fall * 255)));
        }
        continue;
      }
      const d0 = this.densAt(face, i, j, k);
      const d1 = Math.min(255, Math.round(d0 + amount * fall * 255));
      if (d1 >= 128) { added++; this.setBlock(face, i, j, k, block, d1); }
      else this.setBlock(face, i, j, k, B.AIR, d1);
    }
    return added;
  }

  /** Make the cell under (I,J,K) a full, flat floor (machines sit level). */
  flattenUnder(face: number, I: number, J: number, K: number): void {
    const b = this.getBlock(face, I, J, K - 1);
    if (b !== B.AIR && !STRUCTURE[b] && b < B.MACHINE) this.setBlock(face, I, J, K - 1, b, 255);
  }

  private generateSync(face: number, cx: number, cy: number, cz: number): Uint8Array {
    const buf = new Uint8Array(CHUNK_VOL * 2);
    this.gen.fillChunk(face, cx, cy, cz, buf.subarray(0, CHUNK_VOL), buf.subarray(CHUNK_VOL));
    return buf;
  }

  private attach(rec: ChunkRec, buf: Uint8Array): void {
    rec.buf = buf;
    rec.data = buf.subarray(0, CHUNK_VOL);
    rec.dens = buf.subarray(CHUNK_VOL);
  }

  // ------------------------------------------------------------------ streaming

  private newRec(face: number, cx: number, cy: number, cz: number): ChunkRec {
    return {
      key: chunkKey(face, cx, cy, cz), face, cx, cy, cz, data: null, dens: null, buf: null, state: ChunkState.Requested,
      mesh: null, trans: null, smooth: null, padFallback: false, version: 0, meshedVersion: -1, meshing: false, empty: false, modified: false, lastNeeded: this.frame,
    };
  }

  /**
   * Update streaming around a planet-local position. `radius` in chunks.
   * Returns the number of chunks still pending.
   */
  update(local: THREE.Vector3, radius: number): number {
    this.frame++;
    const p = this.params;
    const g = this.tmp;
    const face = posToGrid(local.x, local.y, local.z, p.N, p.baseRadius, g);
    const pcx = Math.floor(g[0] / CHUNK), pcy = Math.floor(g[1] / CHUNK), pcz = Math.floor(g[2] / CHUNK);
    const playerK = g[2];
    // columns needed, ring-ordered
    this.needed.length = 0;
    const seen = new Set<string>();
    for (let ring = 0; ring <= radius; ring++) {
      for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        if (dx * dx + dy * dy > (radius + 0.5) * (radius + 0.5)) continue;
        let f = face, cx = pcx + dx, cy = pcy + dy;
        if (cx < 0 || cx >= this.cpc || cy < 0 || cy >= this.cpc) {
          f = canonicalCell(face, cx * CHUNK + 16, cy * CHUNK + 16, p.N, this.tmpC);
          cx = this.tmpC[0] >> CHUNK_SHIFT;
          cy = this.tmpC[1] >> CHUNK_SHIFT;
        }
        const ck = f + ',' + cx + ',' + cy;
        if (seen.has(ck)) continue;
        seen.add(ck);
        this.needed.push({ face: f, cx, cy, ring });
      }
    }
    let pending = 0;
    let completeRing = radius + 1;
    for (const col of this.needed) {
      const ck = col.face + ',' + col.cx + ',' + col.cy;
      let range = this.colRange.get(ck);
      if (!range) {
        this.colRange.set(ck, 'pending');
        this.pool.run({ type: 'columns', bodyId: this.bodyId, face: col.face, cx: col.cx, cy: col.cy }, col.ring - 100)
          .then((r) => {
            const rr = r as unknown as { minTop: number; maxTop: number };
            this.colRange.set(ck, { min: rr.minTop, max: rr.maxTop });
          })
          .catch(() => this.colRange.delete(ck));
        range = 'pending';
      }
      if (range === 'pending') {
        pending++;
        completeRing = Math.min(completeRing, col.ring);
        continue;
      }
      let z0 = Math.max(0, Math.floor((range.min - 6) / CHUNK));
      let z1 = Math.min(p.layers / CHUNK - 1, Math.floor((range.max + 18) / CHUNK));
      if (col.ring <= 1) {
        z0 = Math.min(z0, Math.max(0, pcz - 1));
        z1 = Math.max(z1, Math.min(p.layers / CHUNK - 1, pcz + 1));
      }
      const ec = this.editCols.get(ck);
      const zs = new Set<number>();
      for (let z = z0; z <= z1; z++) zs.add(z);
      if (ec) for (const z of ec) zs.add(z);
      for (const cz of zs) {
        const key = chunkKey(col.face, col.cx, col.cy, cz);
        let rec = this.chunks.get(key);
        if (!rec) {
          rec = this.newRec(col.face, col.cx, col.cy, cz);
          this.chunks.set(key, rec);
          this.requestData(rec, col.ring * 10 + Math.abs(cz * CHUNK + 16 - playerK) / 32);
        }
        rec.lastNeeded = this.frame;
        if (rec.state !== ChunkState.Ready || rec.meshedVersion < rec.version || rec.meshing) {
          if (!(rec.state === ChunkState.Ready && rec.empty)) {
            pending++;
            completeRing = Math.min(completeRing, col.ring);
          }
        }
      }
    }
    this.coverRadius = Math.max(0, (completeRing - 0.5) * CHUNK - 6);
    // unload
    if (this.frame % 30 === 0) {
      for (const [key, rec] of this.chunks) {
        if (this.frame - rec.lastNeeded > 90) this.unload(key, rec);
      }
    }
    return pending;
  }

  private requestData(rec: ChunkRec, priority: number): void {
    const edited = this.edits.get(rec.key);
    if (edited) {
      this.attach(rec, edited);
      rec.modified = true;
      rec.state = ChunkState.Ready;
      rec.empty = false;
      this.requestMesh(rec, priority);
      return;
    }
    this.pool.run({ type: 'gen', bodyId: this.bodyId, face: rec.face, cx: rec.cx, cy: rec.cy, cz: rec.cz }, priority, [], () => !this.chunks.has(rec.key) || this.disposed)
      .then((res) => {
        const r = res as unknown as { data: Uint8Array; count: number };
        if (this.chunks.get(rec.key) !== rec || this.disposed) return;
        if (rec.data) return; // edited meanwhile
        rec.state = ChunkState.Ready;
        this.dkFrame = -1;
        this.lcFrame = -1;
        // an all-air chunk may still carry fractional densities just above the ground
        let hasDens = false;
        if (r.count === 0) for (let i = CHUNK_VOL; i < r.data.length; i++) if (r.data[i]) { hasDens = true; break; }
        if (r.count === 0 && !hasDens) {
          rec.empty = true;
          rec.data = null;
          rec.meshedVersion = rec.version;
        } else {
          this.attach(rec, r.data);
          this.requestMesh(rec, priority);
        }
        this.refreshNeighbours(rec);
      })
      .catch(() => {
        if (this.chunks.get(rec.key) === rec) this.chunks.delete(rec.key);
      });
  }

  /** Re-mesh face neighbours whose padding was guessed before this chunk existed. */
  private refreshNeighbours(rec: ChunkRec): void {
    const p = this.params;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      let f = rec.face, cx = rec.cx + dx, cy = rec.cy + dy;
      const cz = rec.cz + dz;
      if (cz < 0 || cz >= p.layers / CHUNK) continue;
      if (cx < 0 || cx >= this.cpc || cy < 0 || cy >= this.cpc) {
        f = canonicalCell(rec.face, cx * CHUNK + 16, cy * CHUNK + 16, p.N, this.tmpC);
        cx = this.tmpC[0] >> CHUNK_SHIFT; cy = this.tmpC[1] >> CHUNK_SHIFT;
      }
      const nr = this.chunks.get(chunkKey(f, cx, cy, cz));
      if (nr && nr.padFallback && nr.data && nr.meshedVersion >= 0) { nr.version++; this.requestMesh(nr, 50); }
    }
  }

  private buildPadded(rec: ChunkRec): { vox: Uint8Array; dens: Uint8Array } {
    const vox = new Uint8Array(PAD * PAD2);
    const dens = new Uint8Array(PAD * PAD2);
    vox.fill(B.UNKNOWN);
    const p = this.params;
    const I0 = rec.cx * CHUNK - 1, J0 = rec.cy * CHUNK - 1, K0 = rec.cz * CHUNK - 1;
    // fast path: copy own data
    const own = rec.data, ownD = rec.dens;
    for (let z = 0; z < CHUNK; z++) for (let y = 0; y < CHUNK; y++) {
      const src = y * CHUNK + z * 1024;
      const dst = 1 + (y + 1) * PAD + (z + 1) * PAD2;
      if (own && ownD) { vox.set(own.subarray(src, src + CHUNK), dst); dens.set(ownD.subarray(src, src + CHUNK), dst); }
      else vox.fill(B.AIR, dst, dst + CHUNK);
    }
    // neighbour shells (per-cell via loaded lookup; handles face seams)
    let fallback = false;
    for (let z = 0; z < PAD; z++) for (let y = 0; y < PAD; y++) for (let x = 0; x < PAD; x++) {
      if (x > 0 && x < PAD - 1 && y > 0 && y < PAD - 1 && z > 0 && z < PAD - 1) continue;
      const K = K0 + z;
      const i = x + y * PAD + z * PAD2;
      if (K < 0) { vox[i] = B.BEDROCK; dens[i] = 255; continue; }
      if (K >= p.layers) { vox[i] = B.AIR; dens[i] = 0; continue; }
      const v = this.getLoaded(rec.face, I0 + x, J0 + y, K);
      vox[i] = v;
      if (v === B.UNKNOWN) { fallback = true; continue; }
      dens[i] = this.densAt(rec.face, I0 + x, J0 + y, K);
    }
    rec.padFallback = fallback;
    return { vox, dens };
  }

  private requestMesh(rec: ChunkRec, priority: number): void {
    if (rec.meshing) { (rec as ChunkRec & { remesh?: boolean }).remesh = true; return; }
    rec.meshing = true;
    const version = rec.version;
    const { vox, dens } = this.buildPadded(rec);
    this.pool.run({ type: 'mesh', bodyId: this.bodyId, face: rec.face, cx: rec.cx, cy: rec.cy, cz: rec.cz, vox, dens }, priority, [vox.buffer, dens.buffer], () => this.chunks.get(rec.key) !== rec || this.disposed)
      .then((res) => {
        rec.meshing = false;
        if (this.chunks.get(rec.key) !== rec || this.disposed) return;
        const r = (res as unknown as { result: import('./mesher').MeshResult }).result;
        this.applyMesh(rec, r);
        rec.meshedVersion = version;
        const rr = rec as ChunkRec & { remesh?: boolean };
        if (rr.remesh || rec.version !== version) {
          rr.remesh = false;
          this.requestMesh(rec, -800);
        }
      })
      .catch(() => { rec.meshing = false; });
  }

  private applyMesh(rec: ChunkRec, r: import('./mesher').MeshResult): void {
    const setMesh = (old: THREE.Mesh | null, buf: import('./mesher').MeshBuffers | null, mat: THREE.Material, trans: boolean): THREE.Mesh | null => {
      if (old) {
        old.geometry.dispose();
        this.group.remove(old);
      }
      if (!buf) return null;
      const geo = buildChunkGeometry(buf);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(r.origin[0], r.origin[1], r.origin[2]);
      m.castShadow = !trans;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (trans) m.renderOrder = 2;
      this.group.add(m);
      return m;
    };
    rec.mesh = setMesh(rec.mesh, r.opaque, this.matOpaque, false);
    rec.trans = setMesh(rec.trans, r.translucent, this.matTrans, true);
    if (rec.smooth) { rec.smooth.geometry.dispose(); this.group.remove(rec.smooth); rec.smooth = null; }
    if (r.smooth) {
      const m = new THREE.Mesh(buildSmoothGeometry(r.smooth), this.matSmooth);
      m.position.set(r.origin[0], r.origin[1], r.origin[2]);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      rec.smooth = m;
    }
    this.onChunkMeshed?.(rec);
  }

  private unload(key: string, rec: ChunkRec): void {
    for (const m of [rec.mesh, rec.trans, rec.smooth]) {
      if (!m) continue;
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.chunks.delete(key);
  }

  get meshCount(): number {
    let n = 0;
    for (const r of this.chunks.values()) if (r.mesh || r.smooth) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    for (const [k, r] of this.chunks) this.unload(k, r);
    this.group.removeFromParent();
  }
}

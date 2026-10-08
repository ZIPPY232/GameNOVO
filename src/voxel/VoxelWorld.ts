import * as THREE from 'three';
import { TerrainGenerator, CHUNK, CHUNK_SHIFT, CHUNK_VOL } from '../planet/terrain';
import { canonicalCell, posToGrid } from '../planet/cubesphere';
import { B, BLOCK_SOLID } from './blocks';
import { PAD, PAD2 } from './mesher';
import type { WorkerPool } from './workerProtocol';
import type { PlanetGenParams } from '../universe/types';
import { buildChunkGeometry } from '../render/TerrainMaterial';

/**
 * Streams editable voxel chunks around the player for one planet.
 * Generated data is deterministic; only modified chunks are persisted
 * (see `edits`). Coordinates here are planet-local (body frame).
 */

export const enum ChunkState { Requested, Ready }

export interface ChunkRec {
  key: string;
  face: number;
  cx: number;
  cy: number;
  cz: number;
  data: Uint8Array | null;
  state: ChunkState;
  mesh: THREE.Mesh | null;
  trans: THREE.Mesh | null;
  version: number;
  meshedVersion: number;
  meshing: boolean;
  empty: boolean;
  modified: boolean;
  lastNeeded: number;
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
  /** persistent edited chunks: key -> full voxel data */
  readonly edits: Map<string, Uint8Array>;
  private pool: WorkerPool;
  private colRange = new Map<string, { min: number; max: number } | 'pending'>();
  private editCols = new Map<string, Set<number>>();
  private matOpaque: THREE.Material;
  private matTrans: THREE.Material;
  private frame = 0;
  private tmp = [0, 0, 0];
  private tmpC = [0, 0];
  /** radius (m) around the player fully covered by meshed voxel chunks */
  coverRadius = 0;
  private needed: { face: number; cx: number; cy: number; ring: number }[] = [];
  readonly cpc: number; // chunks per face edge
  onChunkMeshed: ((rec: ChunkRec) => void) | null = null;
  disposed = false;

  constructor(bodyId: string, params: PlanetGenParams, pool: WorkerPool, edits: Map<string, Uint8Array>, matOpaque: THREE.Material, matTrans: THREE.Material) {
    this.bodyId = bodyId;
    this.params = params;
    this.gen = new TerrainGenerator(params);
    this.pool = pool;
    this.edits = edits;
    this.matOpaque = matOpaque;
    this.matTrans = matTrans;
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
    const key = chunkKey(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT, K >> CHUNK_SHIFT);
    const rec = this.chunks.get(key);
    const data = rec?.data ?? this.edits.get(key) ?? null;
    if (!data) return B.UNKNOWN;
    return data[(I & 31) + (J & 31) * CHUNK + (K & 31) * 1024];
  }

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

  /** Natural surface radius at a planet-local direction (no edits). */
  surfaceRadius(dx: number, dy: number, dz: number): number {
    const h = this.gen.heightAt(dx, dy, dz);
    const p = this.params;
    const hh = (p.frozenOcean || p.lavaOcean) && h < 0 ? 0 : h;
    return p.baseRadius + Math.floor(p.seaZ + hh) + 1;
  }

  /** Highest solid cell in the column at or below startK (uses loaded data). */
  columnTop(face: number, I: number, J: number, startK: number): number {
    for (let k = Math.min(startK, this.params.layers - 1); k > 0; k--) {
      if (this.isSolid(face, I, J, k)) return k;
    }
    return 0;
  }

  // ------------------------------------------------------------------ edits

  setBlock(face: number, I: number, J: number, K: number, block: number): boolean {
    const p = this.params;
    if (K < 1 || K >= p.layers) return false;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0]; J = this.tmpC[1];
    }
    const cx = I >> CHUNK_SHIFT, cy = J >> CHUNK_SHIFT, cz = K >> CHUNK_SHIFT;
    const key = chunkKey(face, cx, cy, cz);
    let rec = this.chunks.get(key);
    if (!rec || !rec.data) {
      // ensure data exists synchronously (rare: editing an unloaded chunk)
      const data = this.edits.get(key) ?? this.generateSync(face, cx, cy, cz);
      if (!rec) {
        rec = this.newRec(face, cx, cy, cz);
        this.chunks.set(key, rec);
      }
      rec.data = data;
      rec.state = ChunkState.Ready;
    }
    const idx = (I & 31) + (J & 31) * CHUNK + (K & 31) * 1024;
    if (rec.data![idx] === block) return false;
    rec.data![idx] = block;
    rec.modified = true;
    rec.empty = false;
    if (!this.edits.has(key)) {
      this.edits.set(key, rec.data!);
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

  private generateSync(face: number, cx: number, cy: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_VOL);
    this.gen.fillChunk(face, cx, cy, cz, data);
    return data;
  }

  // ------------------------------------------------------------------ streaming

  private newRec(face: number, cx: number, cy: number, cz: number): ChunkRec {
    return {
      key: chunkKey(face, cx, cy, cz), face, cx, cy, cz, data: null, state: ChunkState.Requested,
      mesh: null, trans: null, version: 0, meshedVersion: -1, meshing: false, empty: false, modified: false, lastNeeded: this.frame,
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
      rec.data = edited;
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
        if (r.count === 0) {
          rec.empty = true;
          rec.data = null;
          rec.meshedVersion = rec.version;
          return;
        }
        rec.data = r.data;
        this.requestMesh(rec, priority);
      })
      .catch(() => {
        if (this.chunks.get(rec.key) === rec) this.chunks.delete(rec.key);
      });
  }

  private buildPadded(rec: ChunkRec): Uint8Array {
    const vox = new Uint8Array(PAD * PAD2);
    vox.fill(B.UNKNOWN);
    const p = this.params;
    const I0 = rec.cx * CHUNK - 1, J0 = rec.cy * CHUNK - 1, K0 = rec.cz * CHUNK - 1;
    // fast path: copy own data
    const own = rec.data;
    for (let z = 0; z < CHUNK; z++) for (let y = 0; y < CHUNK; y++) {
      const src = y * CHUNK + z * 1024;
      const dst = 1 + (y + 1) * PAD + (z + 1) * PAD2;
      if (own) vox.set(own.subarray(src, src + CHUNK), dst);
      else vox.fill(B.AIR, dst, dst + CHUNK);
    }
    // neighbour shells (per-voxel via loaded lookup; handles face seams)
    for (let z = 0; z < PAD; z++) for (let y = 0; y < PAD; y++) for (let x = 0; x < PAD; x++) {
      if (x > 0 && x < PAD - 1 && y > 0 && y < PAD - 1 && z > 0 && z < PAD - 1) continue;
      const K = K0 + z;
      let v: number;
      if (K < 0) v = B.BEDROCK;
      else if (K >= p.layers) v = B.AIR;
      else v = this.getLoaded(rec.face, I0 + x, J0 + y, K);
      vox[x + y * PAD + z * PAD2] = v;
    }
    return vox;
  }

  private requestMesh(rec: ChunkRec, priority: number): void {
    if (rec.meshing) { (rec as ChunkRec & { remesh?: boolean }).remesh = true; return; }
    rec.meshing = true;
    const version = rec.version;
    const vox = this.buildPadded(rec);
    this.pool.run({ type: 'mesh', bodyId: this.bodyId, face: rec.face, cx: rec.cx, cy: rec.cy, cz: rec.cz, vox }, priority, [vox.buffer], () => this.chunks.get(rec.key) !== rec || this.disposed)
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
    this.onChunkMeshed?.(rec);
  }

  private unload(key: string, rec: ChunkRec): void {
    for (const m of [rec.mesh, rec.trans]) {
      if (!m) continue;
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.chunks.delete(key);
  }

  get meshCount(): number {
    let n = 0;
    for (const r of this.chunks.values()) if (r.mesh) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    for (const [k, r] of this.chunks) this.unload(k, r);
    this.group.removeFromParent();
  }
}

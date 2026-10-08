import { Noise3 } from '../core/noise';
import { hash32, hashFloat } from '../core/rng';
import { gridToDir, canonicalCell } from './cubesphere';
import { B } from '../voxel/blocks';
import type { PlanetGenParams } from '../universe/types';

/**
 * Deterministic planet terrain generator. Given the same PlanetGenParams it
 * always produces identical voxels, so only player edits need persisting.
 *
 * Pipeline per chunk column (32x32 cells on a cube face):
 *   heights on a 34x34 grid (1-cell border for slopes) -> biome classification
 * Per chunk:
 *   3D fields (caves + ores) on a 9x9x9 lattice (4-cell spacing), trilinearly
 *   interpolated -> layered materials -> flora / outcrop structures.
 */

export const CHUNK = 32;
export const CHUNK_SHIFT = 5;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;
const LAT = 9; // lattice points per axis (spacing 4)
const COLS_EXT = 34;

export type PoiKind = 'outpost' | 'wreck' | 'monolith';

export interface POI {
  id: string;
  kind: PoiKind;
  face: number;
  I: number;
  J: number;
  /** ground top z at the centre */
  top: number;
}

const POI_CELL = 150;

export interface ColumnSet {
  /** top solid z per column (32x32) */
  top: Int16Array;
  /** top solid z on the extended 34x34 grid (border included) */
  topExt: Int16Array;
  h: Float32Array;
  surface: Uint8Array;
  sub: Uint8Array;
  rock: Uint8Array;
  deep: Uint8Array;
  subDepth: Uint8Array;
  fill: Uint8Array;
  fillTop: Int16Array;
  slope: Float32Array;
  temp: Float32Array;
  moist: Float32Array;
  minTop: number;
  maxTop: number;
}

// Field channel indices in the lattice
const F_CAVE_A = 0, F_CAVE_B = 1, F_CHEESE = 2, F_ENTRANCE = 3, F_ORE0 = 4;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

class LRU<V> {
  private map = new Map<string, V>();
  constructor(private limit: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.set(k, v);
    if (this.map.size > this.limit) {
      const first = this.map.keys().next().value as string;
      this.map.delete(first);
    }
  }
}

export class TerrainGenerator {
  readonly p: PlanetGenParams;
  private nWarp: Noise3;
  private nCont: Noise3;
  private nMount: Noise3;
  private nHill: Noise3;
  private nDetail: Noise3;
  private nCanyon: Noise3;
  private nBiome: Noise3;
  private nCave: Noise3;
  private nCave2: Noise3;
  private nOre: Noise3[];
  private colCache = new LRU<ColumnSet>(160);
  private latCache = new LRU<Float32Array>(96);
  private fieldCount: number;
  private tmp = [0, 0, 0];
  private tmpC = [0, 0];

  constructor(params: PlanetGenParams) {
    this.p = params;
    const s = params.seed;
    this.nWarp = new Noise3(hash32(s, 1));
    this.nCont = new Noise3(hash32(s, 2));
    this.nMount = new Noise3(hash32(s, 3));
    this.nHill = new Noise3(hash32(s, 4));
    this.nDetail = new Noise3(hash32(s, 5));
    this.nCanyon = new Noise3(hash32(s, 6));
    this.nBiome = new Noise3(hash32(s, 7));
    this.nCave = new Noise3(hash32(s, 8));
    this.nCave2 = new Noise3(hash32(s, 9));
    this.nOre = params.ores.map((_, i) => new Noise3(hash32(s, 100 + i)));
    this.fieldCount = F_ORE0 + params.ores.length;
  }

  // ---------------------------------------------------------------- heights

  /** Terrain height in metres relative to the datum (sea level) for a unit direction. */
  heightAt(dx: number, dy: number, dz: number): number {
    const p = this.p;
    const R = p.radius;
    const x = dx * R, y = dy * R, z = dz * R;
    const wf = 1 / 1900;
    const wx = this.nWarp.fbm(x * wf, y * wf, z * wf, 3) * 380;
    const wy = this.nWarp.fbm(y * wf + 31.7, z * wf, x * wf, 3) * 380;
    const wz = this.nWarp.fbm(z * wf - 17.3, x * wf, y * wf, 3) * 380;
    const px = x + wx, py = y + wy, pz = z + wz;

    const cf = p.continentFreq;
    const c = this.nCont.fbm(px * cf, py * cf, pz * cf, 5) + p.continentBias;
    const land = smoothstep(-0.04, 0.22, c);
    // base shelf: oceans deepen smoothly, land rises gently
    let h = c < 0 ? c * 260 : c * 70;
    // mountains: ridged noise, concentrated inland
    if (p.mountainHeight > 0) {
      const mf = 1 / 1150;
      const m = this.nMount.ridged(px * mf, py * mf, pz * mf, 5);
      const mask = smoothstep(0.05, 0.45, c + this.nMount.noise(px * 0.0003, py * 0.0003, pz * 0.0003) * 0.25);
      h += Math.pow(m, 2.3) * p.mountainHeight * mask * land;
    }
    h += this.nHill.fbm(x / 300, y / 300, z / 300, 4) * p.hillHeight * (0.35 + 0.65 * land);
    h += this.nDetail.fbm(x / 58, y / 58, z / 58, 2) * p.detailHeight;

    if (p.canyonDepth > 0) {
      const cn = Math.abs(this.nCanyon.fbm(px / 1500, py / 1500, pz / 1500, 3));
      const carve = 1 - smoothstep(0.0, 0.065, cn);
      h -= carve * p.canyonDepth * (0.4 + 0.6 * land);
    }
    if (p.duneHeight > 0) {
      const dw = this.nCanyon.noise(x / 700, y / 700, z / 700) * 40;
      const ridge = Math.sin((x + y * 0.6 + dw) / 23) * 0.5 + 0.5;
      const ridge2 = Math.sin((z - x * 0.4 + dw * 1.3) / 37) * 0.5 + 0.5;
      h += (ridge * ridge * 0.65 + ridge2 * 0.35) * p.duneHeight * (0.4 + 0.6 * smoothstep(-0.2, 0.4, this.nBiome.noise(x / 900, y / 900, z / 900)));
    }
    if (p.craterDensity > 0) h += this.craters(x, y, z);
    if (p.volcanoes > 0) h += this.volcanoField(x, y, z);
    if (p.terraceStep > 0) {
      const t = h / p.terraceStep;
      const f = t - Math.floor(t);
      h = (Math.floor(t) + smoothstep(0.25, 0.75, f)) * p.terraceStep;
    }
    return h;
  }

  private craters(x: number, y: number, z: number): number {
    const p = this.p;
    let total = 0;
    const scales = [520, 170, 60];
    for (let si = 0; si < scales.length; si++) {
      const S = scales[si];
      const prob = p.craterDensity * (si === 0 ? 0.35 : si === 1 ? 0.55 : 0.75);
      const ix = Math.floor(x / S), iy = Math.floor(y / S), iz = Math.floor(z / S);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const cx = ix + a, cy = iy + b, cz = iz + c;
        const hsh = hash32(p.seed, si, cx, cy, cz);
        if ((hsh & 0xffff) / 65536 > prob) continue;
        let px = (cx + hashFloat(hsh, 1)) * S;
        let py = (cy + hashFloat(hsh, 2)) * S;
        let pz = (cz + hashFloat(hsh, 3)) * S;
        const len = Math.sqrt(px * px + py * py + pz * pz);
        if (Math.abs(len - p.radius) > S * 0.5) continue;
        const k = p.radius / len;
        px *= k; py *= k; pz *= k;
        const rad = S * (0.12 + 0.3 * hashFloat(hsh, 4));
        const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2) / rad;
        if (d > 1.8) continue;
        const depth = rad * 0.22 * p.craterDepth;
        if (d < 1) total -= depth * (1 - d * d) * 0.9;
        total += depth * 0.35 * Math.exp(-(((d - 1) / 0.22) ** 2));
      }
    }
    return total;
  }

  private volcanoField(x: number, y: number, z: number): number {
    const p = this.p;
    const S = 1500;
    let total = 0;
    const ix = Math.floor(x / S), iy = Math.floor(y / S), iz = Math.floor(z / S);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = ix + a, cy = iy + b, cz = iz + c;
      const hsh = hash32(p.seed, 77, cx, cy, cz);
      if ((hsh & 0xffff) / 65536 > p.volcanoes) continue;
      let px = (cx + hashFloat(hsh, 1)) * S, py = (cy + hashFloat(hsh, 2)) * S, pz = (cz + hashFloat(hsh, 3)) * S;
      const len = Math.sqrt(px * px + py * py + pz * pz);
      if (Math.abs(len - p.radius) > S * 0.5) continue;
      const k = p.radius / len;
      px *= k; py *= k; pz *= k;
      const rad = S * (0.25 + 0.2 * hashFloat(hsh, 4));
      const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2) / rad;
      if (d > 1) continue;
      const hgt = 160 + 120 * hashFloat(hsh, 5);
      let v = hgt * Math.pow(1 - d, 1.6);
      if (d < 0.12) v -= (hgt * 0.35) * (1 - d / 0.12);
      total += v;
    }
    return total;
  }

  // ---------------------------------------------------------------- biomes

  /** Surface classification. Writes block ids into the column set at index i. */
  private classify(cs: ColumnSet, i: number, h: number, slope: number, dx: number, dy: number, dz: number): void {
    const p = this.p;
    const pal = p.palette;
    const R = p.radius;
    const lat = Math.abs(dy);
    const bn = this.nBiome.fbm(dx * R / 800, dy * R / 800, dz * R / 800, 3);
    const temp = p.temperature + 16 * (1 - 1.9 * lat * lat) - Math.max(0, h) * 0.045 + bn * 7;
    const moist = Math.min(1, Math.max(0, p.moisture + this.nBiome.fbm(dx * R / 1300 + 9, dy * R / 1300, dz * R / 1300, 3) * 0.45));
    cs.temp[i] = temp;
    cs.moist[i] = moist;
    cs.slope[i] = slope;

    let surface = pal.surface, sub = pal.subsurface, subDepth = 3;
    const underwater = (p.hasOcean || p.frozenOcean || p.lavaOcean) && h < -0.5;
    const steep = slope > 1.25;

    switch (p.type) {
      case 'terrestrial':
      case 'ocean':
        if (underwater) { surface = pal.seabed; sub = B.SAND; }
        else if (h < 2.5 && p.hasOcean) { surface = pal.beach; sub = B.SAND; subDepth = 4; }
        else if (steep) { surface = pal.steep; sub = pal.rock; subDepth = 1; }
        else if (temp < -4) { surface = pal.cold; sub = B.SOIL; }
        else if (moist < 0.22) { surface = pal.dry; sub = pal.dry === B.SAND ? B.SANDSTONE : pal.rock; }
        break;
      case 'desert':
        if (steep) { surface = pal.steep; sub = pal.steep; subDepth = 2; }
        else if (moist > 0.62 && bn > 0.2) { surface = pal.dry; sub = pal.rock; }
        if (temp < -6) surface = B.SNOW;
        break;
      case 'frozen':
        if (underwater) { surface = B.ICE; sub = B.ICE; }
        else if (steep) { surface = slope > 1.8 ? pal.rock : B.ICE; sub = pal.rock; }
        break;
      case 'volcanic':
        if (steep) { surface = pal.steep; sub = pal.steep; }
        else if (bn > 0.25) { surface = pal.dry; }
        break;
      case 'barren':
        if (steep) { surface = pal.steep; sub = pal.steep; subDepth = 1; }
        break;
      case 'exotic':
        if (underwater) { surface = pal.seabed; }
        else if (steep) { surface = pal.steep; sub = pal.rock; subDepth = 1; }
        else if (temp < -35) { surface = B.SNOW; }
        else if (moist < 0.3) { surface = pal.dry; }
        break;
      default:
        break;
    }
    cs.surface[i] = surface;
    cs.sub[i] = sub;
    cs.subDepth[i] = subDepth;
    cs.rock[i] = pal.rock;
    cs.deep[i] = pal.deep;
    if (p.frozenOcean && h < -0.5) { cs.fill[i] = B.ICE; cs.fillTop[i] = p.seaZ - 1; }
    else if (p.lavaOcean && h < -0.5) { cs.fill[i] = B.LAVA; cs.fillTop[i] = p.seaZ - 1; }
    else { cs.fill[i] = 0; cs.fillTop[i] = -1; }
  }

  private pointCS: ColumnSet | null = null;
  /** Surface block for an arbitrary point (used by far LOD tiles and planet bakes). */
  surfaceBlockAt(h: number, slope: number, dx: number, dy: number, dz: number): number {
    if (!this.pointCS) {
      this.pointCS = {
        top: new Int16Array(1), topExt: new Int16Array(1), h: new Float32Array(1), surface: new Uint8Array(1), sub: new Uint8Array(1),
        rock: new Uint8Array(1), deep: new Uint8Array(1), subDepth: new Uint8Array(1), fill: new Uint8Array(1), fillTop: new Int16Array(1),
        slope: new Float32Array(1), temp: new Float32Array(1), moist: new Float32Array(1), minTop: 0, maxTop: 0,
      };
    }
    const cs = this.pointCS;
    this.classify(cs, 0, h, slope, dx, dy, dz);
    if (cs.fill[0]) return cs.fill[0];
    return cs.surface[0];
  }

  /** Column set for chunk column (face, cx, cy). Cached. */
  getColumns(face: number, cx: number, cy: number): ColumnSet {
    const key = face + ':' + cx + ':' + cy;
    const hit = this.colCache.get(key);
    if (hit) return hit;
    const p = this.p;
    const N = p.N;
    const hExt = new Float32Array(COLS_EXT * COLS_EXT);
    const dirs = new Float64Array(COLS_EXT * COLS_EXT * 3);
    const I0 = cx * CHUNK - 1, J0 = cy * CHUNK - 1;
    const d = this.tmp;
    for (let j = 0; j < COLS_EXT; j++) {
      for (let i = 0; i < COLS_EXT; i++) {
        gridToDir(face, I0 + i + 0.5, J0 + j + 0.5, N, d);
        const o = (i + j * COLS_EXT);
        dirs[o * 3] = d[0]; dirs[o * 3 + 1] = d[1]; dirs[o * 3 + 2] = d[2];
        hExt[o] = this.heightAt(d[0], d[1], d[2]);
      }
    }
    const cs: ColumnSet = {
      top: new Int16Array(1024), topExt: new Int16Array(COLS_EXT * COLS_EXT), h: new Float32Array(1024),
      surface: new Uint8Array(1024), sub: new Uint8Array(1024), rock: new Uint8Array(1024), deep: new Uint8Array(1024),
      subDepth: new Uint8Array(1024), fill: new Uint8Array(1024), fillTop: new Int16Array(1024),
      slope: new Float32Array(1024), temp: new Float32Array(1024), moist: new Float32Array(1024),
      minTop: 1e9, maxTop: -1e9,
    };
    const maxZ = p.layers - 8;
    for (let o = 0; o < COLS_EXT * COLS_EXT; o++) {
      cs.topExt[o] = Math.min(maxZ, Math.max(3, Math.floor(p.seaZ + hExt[o])));
    }
    for (let j = 0; j < CHUNK; j++) {
      for (let i = 0; i < CHUNK; i++) {
        const o = (i + 1) + (j + 1) * COLS_EXT;
        const h = hExt[o];
        const sx = (hExt[o + 1] - hExt[o - 1]) * 0.5;
        const sy = (hExt[o + COLS_EXT] - hExt[o - COLS_EXT]) * 0.5;
        const slope = Math.sqrt(sx * sx + sy * sy);
        const ci = i + j * CHUNK;
        cs.h[ci] = h;
        const top = cs.topExt[o];
        cs.top[ci] = top;
        if (top < cs.minTop) cs.minTop = top;
        if (top > cs.maxTop) cs.maxTop = top;
        this.classify(cs, ci, h, slope, dirs[o * 3], dirs[o * 3 + 1], dirs[o * 3 + 2]);
        if (cs.fill[ci] && cs.fillTop[ci] > cs.maxTop) cs.maxTop = cs.fillTop[ci];
      }
    }
    this.colCache.set(key, cs);
    return cs;
  }

  // ---------------------------------------------------------------- 3D fields

  private getLattice(face: number, cx: number, cy: number, cz: number): Float32Array {
    const key = face + ':' + cx + ':' + cy + ':' + cz;
    const hit = this.latCache.get(key);
    if (hit) return hit;
    const p = this.p;
    const F = this.fieldCount;
    const out = new Float32Array(LAT * LAT * LAT * F);
    const d = this.tmp;
    const I0 = cx * CHUNK, J0 = cy * CHUNK, K0 = cz * CHUNK;
    for (let b = 0; b < LAT; b++) {
      for (let a = 0; a < LAT; a++) {
        gridToDir(face, I0 + a * 4, J0 + b * 4, p.N, d);
        const dx = d[0], dy = d[1], dz = d[2];
        for (let c = 0; c < LAT; c++) {
          const r = p.baseRadius + K0 + c * 4;
          const x = dx * r, y = dy * r, z = dz * r;
          const o = (a + b * LAT + c * LAT * LAT) * F;
          out[o + F_CAVE_A] = this.nCave.noise(x / 44, y / 44, z / 44);
          out[o + F_CAVE_B] = this.nCave2.noise(x / 44, y / 44, z / 44);
          out[o + F_CHEESE] = this.nCave.noise(x / 95 + 100, y / 95, z / 95);
          out[o + F_ENTRANCE] = this.nCave2.noise(x / 260, y / 260 + 50, z / 260);
          for (let k = 0; k < p.ores.length; k++) {
            const f = p.ores[k].freq;
            out[o + F_ORE0 + k] = this.nOre[k].noise(x * f, y * f, z * f) * 0.5 + 0.5;
          }
        }
      }
    }
    this.latCache.set(key, out);
    return out;
  }

  /** Material for a voxel given its column data and interpolated fields. */
  private material(cs: ColumnSet, ci: number, K: number, fields: Float32Array, fo: number, jitter: number): number {
    const p = this.p;
    if (K <= 1 || (K === 2 && jitter > 0.5)) return B.BEDROCK;
    const top = cs.top[ci];
    if (K > top) {
      if (cs.fill[ci] && K <= cs.fillTop[ci]) return cs.fill[ci];
      return B.AIR;
    }
    const depth = top - K;
    // caves
    if (p.caveDensity > 0 && K > 6) {
      const ca = fields[fo + F_CAVE_A], cb = fields[fo + F_CAVE_B];
      const w = 0.0042 * p.caveDensity;
      const worm = ca * ca + cb * cb < w;
      const entrance = fields[fo + F_ENTRANCE] > 0.38;
      const underSea = (p.hasOcean && top < p.seaZ + 1);
      if (!underSea && (depth >= 4 || (entrance && depth >= 0))) {
        if (worm) return B.AIR;
        if (depth > 24 && fields[fo + F_CHEESE] > 0.66 - 0.06 * p.caveDensity) return B.AIR;
      }
    }
    let base: number;
    if (depth === 0) base = cs.surface[ci];
    else if (depth < cs.subDepth[ci]) base = cs.sub[ci];
    else if (depth > 48 + jitter * 6) base = cs.deep[ci];
    else base = cs.rock[ci];
    if (depth >= 1) {
      const ores = p.ores;
      for (let k = 0; k < ores.length; k++) {
        const o = ores[k];
        if (depth < o.minDepth || depth > o.maxDepth) continue;
        if (fields[fo + F_ORE0 + k] + (jitter - 0.5) * 0.05 > o.threshold) return o.block;
      }
    }
    return base;
  }

  private interpFields(lat: Float32Array, lx: number, ly: number, lz: number, out: Float32Array): void {
    const F = this.fieldCount;
    const ax = lx >> 2, ay = ly >> 2, az = lz >> 2;
    const fx = (lx & 3) / 4, fy = (ly & 3) / 4, fz = (lz & 3) / 4;
    const o000 = (ax + ay * LAT + az * LAT * LAT) * F;
    const sx = F, sy = LAT * F, sz = LAT * LAT * F;
    for (let f = 0; f < F; f++) {
      const c000 = lat[o000 + f], c100 = lat[o000 + sx + f];
      const c010 = lat[o000 + sy + f], c110 = lat[o000 + sx + sy + f];
      const c001 = lat[o000 + sz + f], c101 = lat[o000 + sx + sz + f];
      const c011 = lat[o000 + sy + sz + f], c111 = lat[o000 + sx + sy + sz + f];
      const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
      const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
      const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
      out[f] = y0 + (y1 - y0) * fz;
    }
  }

  // ---------------------------------------------------------------- chunks

  /** Fills a chunk. Returns number of non-air voxels. */
  fillChunk(face: number, cx: number, cy: number, cz: number, out: Uint8Array): number {
    const p = this.p;
    const cs = this.getColumns(face, cx, cy);
    const K0 = cz * CHUNK;
    // Entirely above terrain: only flora may intrude.
    if (K0 > cs.maxTop + 1) {
      out.fill(0);
      return this.placeStructures(face, cx, cy, cz, out, cs) + this.stampPois(face, cx, cy, cz, out);
    }
    const lat = this.getLattice(face, cx, cy, cz);
    const fields = new Float32Array(this.fieldCount);
    let count = 0;
    const I0 = cx * CHUNK, J0 = cy * CHUNK;
    for (let z = 0; z < CHUNK; z++) {
      const K = K0 + z;
      for (let y = 0; y < CHUNK; y++) {
        for (let x = 0; x < CHUNK; x++) {
          const ci = x + y * CHUNK;
          const top = cs.top[ci];
          let m: number;
          if (K > top && !(cs.fill[ci] && K <= cs.fillTop[ci])) m = B.AIR;
          else {
            this.interpFields(lat, x, y, z, fields);
            const jitter = (hash32(p.seed, face, I0 + x, J0 + y, K) & 1023) / 1023;
            m = this.material(cs, ci, K, fields, 0, jitter);
          }
          out[x + y * CHUNK + z * 1024] = m;
          if (m) count++;
        }
      }
    }
    count += this.placeStructures(face, cx, cy, cz, out, cs);
    count += this.stampPois(face, cx, cy, cz, out);
    return count;
  }

  /** Single voxel (without flora); identical to fillChunk for terrain. */
  voxelAt(face: number, I: number, J: number, K: number): number {
    const p = this.p;
    if (K < 0) return B.BEDROCK;
    if (K >= p.layers) return B.AIR;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0];
      J = this.tmpC[1];
    }
    const cx = I >> CHUNK_SHIFT, cy = J >> CHUNK_SHIFT, cz = K >> CHUNK_SHIFT;
    const cs = this.getColumns(face, cx, cy);
    const ci = (I & 31) + (J & 31) * CHUNK;
    if (K > cs.top[ci] && !(cs.fill[ci] && K <= cs.fillTop[ci])) return B.AIR;
    const lat = this.getLattice(face, cx, cy, cz);
    const fields = new Float32Array(this.fieldCount);
    this.interpFields(lat, I & 31, J & 31, K & 31, fields);
    const jitter = (hash32(p.seed, face, I, J, K) & 1023) / 1023;
    return this.material(cs, ci, K, fields, 0, jitter);
  }

  /** Natural surface top z for a cell (cheap, cached). */
  surfaceTop(face: number, I: number, J: number): number {
    const p = this.p;
    if (I < 0 || I >= p.N || J < 0 || J >= p.N) {
      face = canonicalCell(face, I, J, p.N, this.tmpC);
      I = this.tmpC[0];
      J = this.tmpC[1];
    }
    const cs = this.getColumns(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT);
    const ci = (I & 31) + (J & 31) * CHUNK;
    return Math.max(cs.top[ci], cs.fill[ci] ? cs.fillTop[ci] : -1);
  }

  // ---------------------------------------------------------------- points of interest

  /** Deterministic POI for a POI-grid cell, or null. */
  poiAt(face: number, a: number, b: number): POI | null {
    const p = this.p;
    const h = hash32(p.seed, 9001, face, a, b);
    const density = p.type === 'barren' ? 0.18 : p.type === 'ocean' ? 0.08 : 0.24;
    if ((h & 0xffff) / 65536 > density) return null;
    const I = Math.floor(a * POI_CELL + 24 + ((h >>> 16) & 0xff) / 255 * (POI_CELL - 48));
    const J = Math.floor(b * POI_CELL + 24 + hashFloat(h, 3) * (POI_CELL - 48));
    if (I < 12 || J < 12 || I >= p.N - 12 || J >= p.N - 12) return null;
    const cs = this.getColumns(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT);
    const ci = (I & 31) + (J & 31) * CHUNK;
    const top = cs.top[ci];
    if ((p.hasOcean && top < p.seaZ + 1) || cs.fill[ci]) return null;
    if (cs.slope[ci] > 0.8) return null;
    const r = hashFloat(h, 7);
    const kind: PoiKind = r < 0.45 ? 'outpost' : r < 0.82 ? 'wreck' : 'monolith';
    return { id: `poi:${face}:${a}:${b}`, kind, face, I, J, top };
  }

  /** POIs whose centre lies within `radius` cells (same face neighbourhood). */
  poisNear(face: number, I: number, J: number, radius: number): POI[] {
    const out: POI[] = [];
    const a0 = Math.floor((I - radius) / POI_CELL), a1 = Math.floor((I + radius) / POI_CELL);
    const b0 = Math.floor((J - radius) / POI_CELL), b1 = Math.floor((J + radius) / POI_CELL);
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) {
      if (a < 0 || b < 0 || a * POI_CELL >= this.p.N || b * POI_CELL >= this.p.N) continue;
      const poi = this.poiAt(face, a, b);
      if (poi && Math.hypot(poi.I - I, poi.J - J) <= radius) out.push(poi);
    }
    return out;
  }

  private stampPois(face: number, cx: number, cy: number, cz: number, out: Uint8Array): number {
    const I0 = cx * CHUNK, J0 = cy * CHUNK, K0 = cz * CHUNK;
    const R = 10;
    const pois = this.poisNear(face, I0 + 16, J0 + 16, 16 + R + 2);
    let added = 0;
    for (const poi of pois) {
      if (poi.top + 14 < K0 || poi.top - 4 > K0 + CHUNK) continue;
      const put = (I: number, J: number, K: number, b: number) => {
        const x = I - I0, y = J - J0, z = K - K0;
        if (x < 0 || y < 0 || z < 0 || x >= CHUNK || y >= CHUNK || z >= CHUNK) return;
        const idx = x + y * CHUNK + z * 1024;
        if (!out[idx] && b) added++;
        out[idx] = b;
      };
      const rnd = (n: number) => hashFloat(hash32(this.p.seed, poi.I, poi.J), n);
      const { I, J, top } = poi;
      if (poi.kind === 'outpost') {
        // ruined prefab shelter: foundation, broken walls, partial roof, lamp, data core
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
          put(I + dx, J + dy, top, B.CONCRETE);
          for (let k = 1; k <= 4; k++) put(I + dx, J + dy, top + k, B.AIR);
          const edge = Math.abs(dx) === 4 || Math.abs(dy) === 4;
          if (edge) {
            const door = dy === -4 && Math.abs(dx) <= 1;
            for (let k = 1; k <= 3; k++) {
              if (door && k <= 2) continue;
              const broken = rnd(100 + dx * 13 + dy * 31 + k * 7) < 0.18 + k * 0.08;
              if (!broken) put(I + dx, J + dy, top + k, k === 2 && (dx === 0 || dy === 0) && !door ? B.GLASS : B.METAL_PLATE);
            }
          } else {
            put(I + dx, J + dy, top, B.FLOOR);
            if (rnd(500 + dx * 17 + dy * 3) > 0.45) put(I + dx, J + dy, top + 4, B.HULL);
          }
        }
        put(I + 2, J + 2, top + 1, B.AURELITE);
        put(I - 3, J + 3, top + 1, B.LAMP);
        put(I - 3, J - 3, top + 1, B.METAL_PLATE);
        put(I - 3, J - 3, top + 2, B.METAL_PLATE);
      } else if (poi.kind === 'wreck') {
        // crashed hull half-buried along a heading, debris trail behind it
        const dirX = rnd(1) < 0.5 ? 1 : 0;
        const len = 12;
        for (let t = -len / 2; t <= len / 2; t++) {
          const sink = Math.floor((t + len / 2) / 4);
          for (let w = -1; w <= 1; w++) for (let k = 0; k <= 2; k++) {
            const shell = Math.abs(w) === 1 || k === 0 || k === 2;
            const gx = dirX ? I + t : I + w, gy = dirX ? J + w : J + t;
            const kk = top - sink + k;
            if (!shell) { put(gx, gy, kk, B.AIR); continue; }
            if (rnd(200 + t * 7 + w * 11 + k * 3) < 0.15) continue;
            put(gx, gy, kk, k === 2 && w === 0 ? B.GLASS : B.HULL);
          }
        }
        // fin and engine glow
        put(dirX ? I + len / 2 : I, dirX ? J : J + len / 2, top + 3, B.HULL);
        put(dirX ? I + len / 2 + 1 : I, dirX ? J : J + len / 2 + 1, top + 1, B.LAMP);
        for (let d = 0; d < 9; d++) {
          const t = -len / 2 - 2 - d * 2;
          const gx = dirX ? I + t : I + Math.round((rnd(300 + d) - 0.5) * 6), gy = dirX ? J + Math.round((rnd(300 + d) - 0.5) * 6) : J + t;
          put(gx, gy, top + 1, rnd(400 + d) < 0.5 ? B.METAL_PLATE : B.HULL);
        }
      } else {
        // alien monolith with luminous inlays
        for (let k = 1; k <= 11; k++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
          put(I + dx, J + dy, top + k, k % 3 === 0 && (dx + dy) % 2 === 0 ? B.LUMINITE : B.BASALT);
        }
        for (let dy = -3; dy <= 4; dy++) for (let dx = -3; dx <= 4; dx++) {
          if (Math.hypot(dx - 0.5, dy - 0.5) > 4) continue;
          put(I + dx, J + dy, top, B.BASALT);
        }
      }
    }
    return added;
  }

  // ---------------------------------------------------------------- flora & structures

  private placeStructures(face: number, cx: number, cy: number, cz: number, out: Uint8Array, cs: ColumnSet): number {
    const p = this.p;
    if (p.flora === 'none' && p.outcrops <= 0) return 0;
    const N = p.N;
    const M = 4;
    const I0 = cx * CHUNK, J0 = cy * CHUNK, K0 = cz * CHUNK;
    let added = 0;
    const put = (I: number, J: number, K: number, block: number, replace = false) => {
      const x = I - I0, y = J - J0, z = K - K0;
      if (x < 0 || y < 0 || z < 0 || x >= CHUNK || y >= CHUNK || z >= CHUNK) return;
      const idx = x + y * CHUNK + z * 1024;
      if (out[idx] && !replace) return;
      if (!out[idx]) added++;
      out[idx] = block;
    };
    for (let J = J0 - M; J < J0 + CHUNK + M; J++) {
      if (J < 6 || J >= N - 6) continue;
      for (let I = I0 - M; I < I0 + CHUNK + M; I++) {
        if (I < 6 || I >= N - 6) continue;
        const hsh = hash32(p.seed, 501, face, I, J);
        const r = (hsh & 0xfffff) / 0xfffff;
        const floraP = p.floraDensity * 0.012;
        const outcropP = p.outcrops * 0.0018;
        if (r > floraP + outcropP) continue;
        // column data (may belong to a neighbouring chunk column on the same face)
        const ncs = (I >= I0 && I < I0 + CHUNK && J >= J0 && J < J0 + CHUNK) ? cs : this.getColumns(face, I >> CHUNK_SHIFT, J >> CHUNK_SHIFT);
        const ci = (I & 31) + (J & 31) * CHUNK;
        const top = ncs.top[ci];
        if (top + 20 < K0 || top - 6 > K0 + CHUNK) continue;
        if (ncs.slope[ci] > 0.9) continue;
        const underwater = p.hasOcean && top < p.seaZ - 1;
        const filled = ncs.fill[ci] !== 0 && ncs.fillTop[ci] >= top;
        if (filled) continue;
        const surf = ncs.surface[ci];
        const rnd = (n: number) => hashFloat(hsh, n);
        if (r < outcropP) {
          this.outcrop(I, J, top, rnd, put);
          continue;
        }
        const kind = p.flora;
        if (underwater) {
          if (kind === 'coral' || p.type === 'ocean') this.coral(I, J, top, rnd, put);
          continue;
        }
        if (p.hasOcean && top < p.seaZ + 1) continue;
        const temp = ncs.temp[ci];
        if (kind === 'alien_forest') {
          if (surf !== B.MOSS) continue;
          if (ncs.moist[ci] < 0.35 && rnd(9) > 0.25) continue;
          if (rnd(8) < 0.25) this.fungus(I, J, top, rnd, put);
          else this.tree(I, J, top, rnd, put);
        } else if (kind === 'fungal') {
          if (rnd(8) < 0.7) this.fungus(I, J, top, rnd, put); else this.crystal(I, J, top, rnd, put, B.LUMINITE);
        } else if (kind === 'crystal') {
          this.crystal(I, J, top, rnd, put, rnd(7) < 0.5 ? B.QUARTZ : B.LUMINITE);
        } else if (kind === 'desert_spires') {
          if (rnd(8) < 0.18) this.spire(I, J, top, rnd, put);
        } else if (kind === 'frost_flora') {
          if (temp < 5) this.crystal(I, J, top, rnd, put, rnd(6) < 0.3 ? B.CRYOLITH : B.ICE);
        } else if (kind === 'coral') {
          if (rnd(8) < 0.3) this.tree(I, J, top, rnd, put);
        }
      }
    }
    return added;
  }

  private tree(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void): void {
    const h = 5 + Math.floor(rnd(1) * 7);
    for (let k = 1; k <= h; k++) put(I, J, top + k, B.STALK);
    const cr = 2 + Math.floor(rnd(2) * 2);
    const cyTop = top + h;
    for (let dz = -1; dz <= cr; dz++) {
      const rr = dz <= 0 ? cr : cr - dz * 0.6;
      for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > rr + 0.3) continue;
        if (dz === -1 && d < cr - 0.5) continue; // hollow underside, drooping rim
        if (rnd(20 + dx * 7 + dy * 13 + dz * 31) < 0.12) continue;
        put(I + dx, J + dy, cyTop + dz, B.CANOPY);
      }
    }
    // hanging tendrils
    for (let t = 0; t < 3; t++) {
      const dx = Math.round((rnd(40 + t) - 0.5) * 2 * cr), dy = Math.round((rnd(50 + t) - 0.5) * 2 * cr);
      const len = 1 + Math.floor(rnd(60 + t) * 3);
      for (let k = 1; k <= len; k++) put(I + dx, J + dy, cyTop - 1 - k, B.CANOPY);
    }
  }

  private fungus(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void): void {
    const h = 2 + Math.floor(rnd(1) * 4);
    for (let k = 1; k <= h; k++) put(I, J, top + k, B.STALK);
    const r = 1 + Math.floor(rnd(2) * 3);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 0.4) continue;
      put(I + dx, J + dy, top + h + 1, B.FUNGUS);
      if (d < r - 0.8) put(I + dx, J + dy, top + h + 2, B.FUNGUS);
    }
  }

  private crystal(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void, block: number): void {
    const h = 2 + Math.floor(rnd(1) * 6);
    for (let k = 0; k <= h; k++) put(I, J, top + k, block, k === 0);
    const arms = Math.floor(rnd(2) * 4);
    for (let a = 0; a < arms; a++) {
      const dx = rnd(10 + a) < 0.5 ? -1 : 1;
      const dy = rnd(20 + a) < 0.5 ? 0 : (rnd(30 + a) < 0.5 ? -1 : 1);
      const hh = 1 + Math.floor(rnd(40 + a) * (h - 1));
      for (let k = 1; k <= hh; k++) put(I + dx, J + dy, top + k, block);
    }
  }

  private spire(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void): void {
    const h = 6 + Math.floor(rnd(1) * 14);
    const r0 = 1 + rnd(2) * 1.5;
    for (let k = 0; k <= h; k++) {
      const rr = r0 * (1 - k / (h + 3)) + 0.4 + (k % 4 === 0 ? 0.4 : 0);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > rr * rr) continue;
        put(I + dx, J + dy, top + k, k % 5 === 2 ? B.RED_ROCK : B.SANDSTONE);
      }
    }
  }

  private coral(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void): void {
    const h = 1 + Math.floor(rnd(1) * 5);
    for (let k = 1; k <= h; k++) {
      put(I, J, top + k, B.CORAL);
      if (rnd(10 + k) < 0.4) put(I + (rnd(20 + k) < 0.5 ? 1 : -1), J, top + k, B.CORAL);
      if (rnd(30 + k) < 0.4) put(I, J + (rnd(40 + k) < 0.5 ? 1 : -1), top + k, B.CORAL);
    }
  }

  /** Surface boulder with exposed ore so early resources are discoverable without deep digging. */
  private outcrop(I: number, J: number, top: number, rnd: (n: number) => number, put: (I: number, J: number, K: number, b: number, r?: boolean) => void): void {
    const p = this.p;
    const ores = p.ores.filter((o) => o.minDepth <= 6);
    const rich = ores.length ? ores[Math.floor(rnd(3) * ores.length)].block : B.IRON_ORE;
    const r = 1.2 + rnd(1) * 1.4;
    const host = p.palette.rock;
    for (let dz = -1; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy + (dz * 1.3) ** 2);
      if (d > r) continue;
      const v = rnd(100 + dx * 7 + dy * 11 + dz * 13);
      put(I + dx, J + dy, top + dz, v < 0.45 ? rich : host, dz <= 0);
    }
    // crystalline aurelite growths on some outcrops
    if (rnd(4) < 0.3) {
      const h = 1 + Math.floor(rnd(5) * 3);
      for (let k = 1; k <= h; k++) put(I, J, top + Math.ceil(r) + k - 1, B.AURELITE, true);
    }
  }
}

/** Squared length helper for vector-like triplets. */
export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

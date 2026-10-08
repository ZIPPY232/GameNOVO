import { gridToDir } from './cubesphere';
import type { TerrainGenerator } from './terrain';
import { BLOCKS } from '../voxel/blocks';
import { layerAverageLinear } from '../voxel/palette';

/**
 * Far-terrain LOD tiles and whole-planet bakes, computed in workers from the
 * same height/biome functions as the voxel terrain so silhouettes, colours and
 * coastlines stay consistent across all levels of detail.
 */

export const TILE_RES = 32;
export const TILE_VERTS = (TILE_RES + 1) * (TILE_RES + 1);
export const TILE_SKIRT_VERTS = TILE_RES * 4;

export interface TileResult {
  position: Float32Array;
  normal: Int8Array;
  color: Uint8Array;
  center: [number, number, number];
  minR: number;
  maxR: number;
}

const colorCache = new Map<number, [number, number, number]>();
function blockColor(gen: TerrainGenerator, block: number): [number, number, number] {
  const k = block;
  let c = colorCache.get(k);
  if (!c) {
    c = layerAverageLinear(BLOCKS[block].top, gen.p.bioTint, gen.p.rockTint);
    colorCache.set(k, c);
  }
  return c;
}

function surfaceHeight(gen: TerrainGenerator, h: number): number {
  const p = gen.p;
  if ((p.frozenOcean || p.lavaOcean) && h < 0) return 0;
  return h;
}

export function generateTile(gen: TerrainGenerator, face: number, x0: number, y0: number, size: number): TileResult {
  colorCache.clear();
  const p = gen.p;
  const R = TILE_RES;
  const E = R + 3; // extended grid with 1-cell border
  const hs = new Float32Array(E * E);
  const dirs = new Float64Array(E * E * 3);
  const d = [0, 0, 0];
  const step = size / R;
  for (let j = 0; j < E; j++) for (let i = 0; i < E; i++) {
    gridToDir(face, x0 + (i - 1) * step, y0 + (j - 1) * step, p.N, d);
    const o = i + j * E;
    dirs[o * 3] = d[0]; dirs[o * 3 + 1] = d[1]; dirs[o * 3 + 2] = d[2];
    hs[o] = gen.heightAt(d[0], d[1], d[2]);
  }
  gridToDir(face, x0 + size / 2, y0 + size / 2, p.N, d);
  const cR = p.baseRadius + p.seaZ;
  const center: [number, number, number] = [d[0] * cR, d[1] * cR, d[2] * cR];
  const cellMeters = (Math.PI * p.radius) / (2 * p.N) * step;
  const sink = 0.6 + Math.min(4, step * 0.15);
  const nv = (R + 1) * (R + 1) + R * 4;
  const position = new Float32Array(nv * 3);
  const normal = new Int8Array(nv * 3);
  const color = new Uint8Array(nv * 3);
  const P = (o: number, out: number[]) => {
    const r = p.baseRadius + p.seaZ + surfaceHeight(gen, hs[o]) - sink;
    out[0] = dirs[o * 3] * r; out[1] = dirs[o * 3 + 1] * r; out[2] = dirs[o * 3 + 2] * r;
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], e = [0, 0, 0], f = [0, 0, 0];
  let minR = 1e12, maxR = 0;
  for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) {
    const o = (i + 1) + (j + 1) * E;
    P(o, a);
    const vi = i + j * (R + 1);
    position[vi * 3] = a[0] - center[0]; position[vi * 3 + 1] = a[1] - center[1]; position[vi * 3 + 2] = a[2] - center[2];
    const rr = Math.hypot(a[0], a[1], a[2]);
    if (rr < minR) minR = rr;
    if (rr > maxR) maxR = rr;
    P(o - 1, b); P(o + 1, c); P(o - E, e); P(o + E, f);
    const ux = c[0] - b[0], uy = c[1] - b[1], uz = c[2] - b[2];
    const vx = f[0] - e[0], vy = f[1] - e[1], vz = f[2] - e[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // ensure outward
    if (nx * a[0] + ny * a[1] + nz * a[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
    normal[vi * 3] = Math.round(nx * 127); normal[vi * 3 + 1] = Math.round(ny * 127); normal[vi * 3 + 2] = Math.round(nz * 127);
    const sx = (hs[o + 1] - hs[o - 1]) / (2 * cellMeters);
    const sy = (hs[o + E] - hs[o - E]) / (2 * cellMeters);
    const slope = Math.sqrt(sx * sx + sy * sy);
    const block = gen.surfaceBlockAt(hs[o], slope, dirs[o * 3], dirs[o * 3 + 1], dirs[o * 3 + 2]);
    const cc = blockColor(gen, block);
    const g = 1 / 2.2;
    color[vi * 3] = Math.round(Math.min(1, Math.pow(cc[0], g)) * 255);
    color[vi * 3 + 1] = Math.round(Math.min(1, Math.pow(cc[1], g)) * 255);
    color[vi * 3 + 2] = Math.round(Math.min(1, Math.pow(cc[2], g)) * 255);
  }
  // skirts around the border, dropped toward the centre to hide LOD cracks
  const skirtDrop = 2 + step * 1.5;
  let si = (R + 1) * (R + 1);
  const border: number[] = [];
  for (let i = 0; i < R; i++) border.push(i);
  for (let j = 0; j < R; j++) border.push(R + j * (R + 1));
  for (let i = R; i > 0; i--) border.push(i + R * (R + 1));
  for (let j = R; j > 0; j--) border.push(j * (R + 1));
  for (const vi of border) {
    const px = position[vi * 3] + center[0], py = position[vi * 3 + 1] + center[1], pz = position[vi * 3 + 2] + center[2];
    const l = Math.hypot(px, py, pz);
    const k = (l - skirtDrop) / l;
    position[si * 3] = px * k - center[0]; position[si * 3 + 1] = py * k - center[1]; position[si * 3 + 2] = pz * k - center[2];
    normal[si * 3] = normal[vi * 3]; normal[si * 3 + 1] = normal[vi * 3 + 1]; normal[si * 3 + 2] = normal[vi * 3 + 2];
    color[si * 3] = color[vi * 3]; color[si * 3 + 1] = color[vi * 3 + 1]; color[si * 3 + 2] = color[vi * 3 + 2];
    si++;
  }
  return { position, normal, color, center, minR: minR - skirtDrop, maxR };
}

/** Shared index buffer for LOD tiles (grid + skirts), CCW seen from outside. */
export function buildTileIndex(): Uint16Array {
  const R = TILE_RES;
  const idx: number[] = [];
  const V = (i: number, j: number) => i + j * (R + 1);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  // skirts: border ring order matches generateTile
  const border: number[] = [];
  for (let i = 0; i < R; i++) border.push(V(i, 0));
  for (let j = 0; j < R; j++) border.push(V(R, j));
  for (let i = R; i > 0; i--) border.push(V(i, R));
  for (let j = R; j > 0; j--) border.push(V(0, j));
  const base = (R + 1) * (R + 1);
  const n = border.length;
  for (let k = 0; k < n; k++) {
    const t0 = border[k], t1 = border[(k + 1) % n];
    const s0 = base + k, s1 = base + ((k + 1) % n);
    // both windings so skirts are visible regardless of orientation
    idx.push(t0, s0, t1, t1, s0, s1);
    idx.push(t0, t1, s0, t1, s1, s0);
  }
  return new Uint16Array(idx);
}

export interface BakeResult {
  width: number;
  height: number;
  /** RGBA8: rgb = sRGB albedo, a = 0 water / 1..255 land height */
  data: Uint8Array;
}

/** Equirectangular albedo + height bake for distant rendering of a planet. */
export function bakePlanet(gen: TerrainGenerator, width: number, height: number): BakeResult {
  colorCache.clear();
  const p = gen.p;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      const dx = cl * Math.cos(lon), dy = sl, dz = -cl * Math.sin(lon);
      const h = gen.heightAt(dx, dy, dz);
      const i = (x + y * width) * 4;
      const water = p.hasOcean && h < 0;
      const block = gen.surfaceBlockAt(h, 0.3, dx, dy, dz);
      const cc = blockColor(gen, block);
      const g = 1 / 2.2;
      data[i] = Math.round(Math.min(1, Math.pow(cc[0], g)) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.pow(cc[1], g)) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.pow(cc[2], g)) * 255);
      data[i + 3] = water ? 0 : Math.max(1, Math.min(255, Math.round(((surfaceHeight(gen, h) + 300) / 900) * 254) + 1));
    }
  }
  return { width, height, data };
}

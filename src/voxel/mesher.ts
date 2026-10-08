import { gridToDir } from '../planet/cubesphere';
import { BLOCK_LAYERS, BLOCK_OPAQUE, BLOCK_TRANSLUCENT, B } from './blocks';
import { CHUNK } from '../planet/terrain';

/**
 * Greedy mesher for curved cube-sphere voxel chunks.
 *
 * Faces are merged per slice when they share material, ambient-occlusion
 * pattern and sky-light level. Merged quads are capped at MAX_RUN cells so the
 * straight edges of a merged quad never deviate noticeably from the curved
 * grid of neighbouring quads (sagitta < 1 cm at planetary radii >= 1.5 km).
 *
 * Vertex format (interleaving avoided for simplicity):
 *   position  Float32 x3  chunk-local metres
 *   normal    Int8   x3  normalised
 *   tangent   Int8   x4  normalised, w = bitangent sign
 *   uv        Uint16 x2  global grid coordinates along the face axes (texture repeats per block,
 *                        floor() identifies the block for per-block variation)
 *   data      Uint8  x4  [texture layer, ao 0..3, sky 0..15, unused]
 */

export const PAD = CHUNK + 2;
export const PAD2 = PAD * PAD;
const MAX_RUN = 8;

export interface MeshBuffers {
  position: Float32Array;
  normal: Int8Array;
  tangent: Int8Array;
  uv: Uint16Array;
  data: Uint8Array;
  index: Uint32Array | Uint16Array;
}

export interface MeshResult {
  opaque: MeshBuffers | null;
  translucent: MeshBuffers | null;
  origin: [number, number, number];
}

class Builder {
  pos: Float32Array; nrm: Int8Array; tan: Int8Array; uv: Uint16Array; dat: Uint8Array; idx: Uint32Array;
  vc = 0; ic = 0;
  constructor(cap = 4096) {
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Int8Array(cap * 3);
    this.tan = new Int8Array(cap * 4);
    this.uv = new Uint16Array(cap * 2);
    this.dat = new Uint8Array(cap * 4);
    this.idx = new Uint32Array(cap * 1.5);
  }
  ensure(nv: number): void {
    if (this.vc + nv <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.vc + nv);
    const grow = <T extends Float32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array>(a: T, n: number): T => {
      const b = new (a.constructor as { new (n: number): T })(n);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos, cap * 3);
    this.nrm = grow(this.nrm, cap * 3);
    this.tan = grow(this.tan, cap * 4);
    this.uv = grow(this.uv, cap * 2);
    this.dat = grow(this.dat, cap * 4);
    this.idx = grow(this.idx, Math.ceil(cap * 1.5));
  }
  finish(): MeshBuffers | null {
    if (this.vc === 0) return null;
    const index = this.vc > 65535 ? this.idx.slice(0, this.ic) : Uint16Array.from(this.idx.subarray(0, this.ic));
    return {
      position: this.pos.slice(0, this.vc * 3),
      normal: this.nrm.slice(0, this.vc * 3),
      tangent: this.tan.slice(0, this.vc * 4),
      uv: this.uv.slice(0, this.vc * 2),
      data: this.dat.slice(0, this.vc * 4),
      index,
    };
  }
}

export interface MeshInput {
  face: number;
  cx: number;
  cy: number;
  cz: number;
  N: number;
  baseRadius: number;
  /** 34^3 padded voxels: index (x+1) + (y+1)*34 + (z+1)*34*34 */
  vox: Uint8Array;
  /** natural surface top per column on the 34x34 padded grid */
  topExt: Int16Array;
}

export function meshChunk(inp: MeshInput): MeshResult {
  const { face, cx, cy, cz, N, baseRadius, vox, topExt } = inp;
  const I0 = cx * CHUNK, J0 = cy * CHUNK, K0 = cz * CHUNK;

  // Corner direction table (33 x 33)
  const C = CHUNK + 1;
  const dirs = new Float64Array(C * C * 3);
  const tmp = [0, 0, 0];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    gridToDir(face, I0 + i, J0 + j, N, tmp);
    const o = (i + j * C) * 3;
    dirs[o] = tmp[0]; dirs[o + 1] = tmp[1]; dirs[o + 2] = tmp[2];
  }
  gridToDir(face, I0 + CHUNK / 2, J0 + CHUNK / 2, N, tmp);
  const oR = baseRadius + K0 + CHUNK / 2;
  const origin: [number, number, number] = [tmp[0] * oR, tmp[1] * oR, tmp[2] * oR];

  const corner = (i: number, j: number, k: number, out: number[]) => {
    const o = (i + j * C) * 3;
    const r = baseRadius + K0 + k;
    out[0] = dirs[o] * r - origin[0];
    out[1] = dirs[o + 1] * r - origin[1];
    out[2] = dirs[o + 2] * r - origin[2];
  };

  const vAt = (x: number, y: number, z: number) => vox[(x + 1) + (y + 1) * PAD + (z + 1) * PAD2];

  const opaque = new Builder(4096);
  const trans = new Builder(256);

  // mask of face keys for a slice: key = layer | ao<<8 | sky<<16 | trans<<21 ; 0 = none
  const mask = new Int32Array(CHUNK * CHUNK);
  const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
  const q = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    // axis: 0 = x(I), 1 = y(J), 2 = z(K radial)
    const ua = axis === 0 ? 1 : 0; // u axis
    const va = axis === 2 ? 1 : 2; // v axis
    for (let s = -1; s <= 1; s += 2) {
      for (let w = 0; w < CHUNK; w++) {
        // build mask
        let any = false;
        for (let v = 0; v < CHUNK; v++) {
          for (let u = 0; u < CHUNK; u++) {
            q[axis] = w; q[ua] = u; q[va] = v;
            const b = vAt(q[0], q[1], q[2]);
            let key = 0;
            if (b !== B.AIR && b < B.MACHINE) {
              q[axis] = w + s;
              const n = vAt(q[0], q[1], q[2]);
              const bOpaque = BLOCK_OPAQUE[b] === 1;
              const visible = bOpaque ? BLOCK_OPAQUE[n] === 0 : (BLOCK_OPAQUE[n] === 0 && n !== b);
              if (visible) {
                // texture layer for this face
                let layer: number;
                if (axis === 2) layer = BLOCK_LAYERS[b * 3 + (s > 0 ? 0 : 2)];
                else layer = BLOCK_LAYERS[b * 3 + 1];
                // ambient occlusion (in the neighbour slice)
                const wn = w + s;
                const occ = (du: number, dv: number) => {
                  q[axis] = wn; q[ua] = u + du; q[va] = v + dv;
                  return BLOCK_OPAQUE[vAt(q[0], q[1], q[2])];
                };
                const sL = occ(-1, 0), sR = occ(1, 0), sD = occ(0, -1), sU = occ(0, 1);
                const cLD = occ(-1, -1), cRD = occ(1, -1), cRU = occ(1, 1), cLU = occ(-1, 1);
                const ao = (a: number, b2: number, c: number) => (a && b2 ? 0 : 3 - (a + b2 + c));
                const a0 = ao(sL, sD, cLD), a1 = ao(sR, sD, cRD), a2 = ao(sR, sU, cRU), a3 = ao(sL, sU, cLU);
                // sky exposure from the air-side cell's column
                q[axis] = wn; q[ua] = u; q[va] = v;
                const colTop = topExt[(q[0] + 1) + (q[1] + 1) * PAD];
                const depth = colTop - (K0 + q[2]);
                const sky = depth < 0 ? 15 : Math.max(0, Math.round(15 * (1 - depth / 9)));
                key = (layer + 1) | (a0 << 8) | (a1 << 10) | (a2 << 12) | (a3 << 14) | (sky << 16) | ((BLOCK_TRANSLUCENT[b]) << 21);
                any = true;
              }
            }
            mask[u + v * CHUNK] = key;
          }
        }
        if (!any) continue;
        // greedy merge
        for (let v = 0; v < CHUNK; v++) {
          for (let u = 0; u < CHUNK;) {
            const key = mask[u + v * CHUNK];
            if (key === 0) { u++; continue; }
            let wdt = 1;
            while (u + wdt < CHUNK && wdt < MAX_RUN && mask[u + wdt + v * CHUNK] === key) wdt++;
            let hgt = 1;
            outer: while (v + hgt < CHUNK && hgt < MAX_RUN) {
              for (let k = 0; k < wdt; k++) if (mask[u + k + (v + hgt) * CHUNK] !== key) break outer;
              hgt++;
            }
            for (let dv = 0; dv < hgt; dv++) for (let du = 0; du < wdt; du++) mask[u + du + (v + dv) * CHUNK] = 0;

            // emit quad
            const plane = s > 0 ? w + 1 : w;
            const setP = (uu: number, vv: number, out: number[]) => {
              q[axis] = plane; q[ua] = uu; q[va] = vv;
              corner(q[0], q[1], q[2], out);
            };
            setP(u, v, p0);
            setP(u + wdt, v, p1);
            setP(u + wdt, v + hgt, p2);
            setP(u, v + hgt, p3);
            const layer = (key & 0xff) - 1;
            const ao0 = (key >> 8) & 3, ao1 = (key >> 10) & 3, ao2 = (key >> 12) & 3, ao3 = (key >> 14) & 3;
            const sky = (key >> 16) & 15;
            const isTrans = (key >> 21) & 1;
            const bld = isTrans ? trans : opaque;
            bld.ensure(4);
            // geometric normal and outward orientation
            const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
            const e2x = p3[0] - p0[0], e2y = p3[1] - p0[1], e2z = p3[2] - p0[2];
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            // outward reference: for radial axis use radial dir; otherwise step along axis
            let rx: number, ry: number, rz: number;
            {
              const cxm = (p0[0] + p2[0]) * 0.5 + origin[0], cym = (p0[1] + p2[1]) * 0.5 + origin[1], czm = (p0[2] + p2[2]) * 0.5 + origin[2];
              if (axis === 2) {
                const l = Math.hypot(cxm, cym, czm);
                rx = (cxm / l) * s; ry = (cym / l) * s; rz = (czm / l) * s;
              } else {
                // vector from the cell's centre across the face
                q[axis] = w; q[ua] = u; q[va] = v;
                const ci = Math.min(q[0], CHUNK - 1), cj = Math.min(q[1], CHUNK - 1);
                const o0 = (ci + cj * C) * 3;
                const o1 = axis === 0 ? (ci + 1 + cj * C) * 3 : (ci + (cj + 1) * C) * 3;
                rx = (dirs[o1] - dirs[o0]) * s; ry = (dirs[o1 + 1] - dirs[o0 + 1]) * s; rz = (dirs[o1 + 2] - dirs[o0 + 2]) * s;
              }
            }
            const flip = nx * rx + ny * ry + nz * rz < 0;
            if (flip) { nx = -nx; ny = -ny; nz = -nz; }
            // tangent along u
            const tl = Math.hypot(e1x, e1y, e1z) || 1;
            const tx = e1x / tl, ty = e1y / tl, tz = e1z / tl;
            // bitangent sign: does cross(N,T) point along +v (e2)?
            const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
            const bs = bx * e2x + by * e2y + bz * e2z >= 0 ? 127 : -127;

            const base = bld.vc;
            const P = [p0, p1, p2, p3];
            // global grid coordinates of the quad along its u/v axes
            const G0 = [I0, J0, K0];
            const gu = G0[ua] + u, gv = G0[va] + v;
            const U = [gu, gu + wdt, gu + wdt, gu];
            const V = [gv, gv, gv + hgt, gv + hgt];
            const AO = [ao0, ao1, ao2, ao3];
            for (let c = 0; c < 4; c++) {
              const vi = bld.vc++;
              const pp = P[c];
              bld.pos[vi * 3] = pp[0]; bld.pos[vi * 3 + 1] = pp[1]; bld.pos[vi * 3 + 2] = pp[2];
              let vnx = nx, vny = ny, vnz = nz;
              if (axis === 2) {
                // smooth spherical normal for horizontal faces
                const ax = pp[0] + origin[0], ay = pp[1] + origin[1], az = pp[2] + origin[2];
                const l = Math.hypot(ax, ay, az);
                vnx = (ax / l) * s; vny = (ay / l) * s; vnz = (az / l) * s;
              }
              bld.nrm[vi * 3] = Math.round(vnx * 127); bld.nrm[vi * 3 + 1] = Math.round(vny * 127); bld.nrm[vi * 3 + 2] = Math.round(vnz * 127);
              bld.tan[vi * 4] = Math.round(tx * 127); bld.tan[vi * 4 + 1] = Math.round(ty * 127); bld.tan[vi * 4 + 2] = Math.round(tz * 127); bld.tan[vi * 4 + 3] = bs;
              bld.uv[vi * 2] = U[c]; bld.uv[vi * 2 + 1] = V[c];
              bld.dat[vi * 4] = layer; bld.dat[vi * 4 + 1] = AO[c]; bld.dat[vi * 4 + 2] = sky; bld.dat[vi * 4 + 3] = 0;
            }
            // triangulation: flip along the diagonal with stronger AO, keep CCW from outside
            const flipDiag = ao0 + ao2 < ao1 + ao3;
            let tri: number[] = flipDiag ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
            if (flip) tri = [tri[0], tri[2], tri[1], tri[3], tri[5], tri[4]];
            for (const t of tri) bld.idx[bld.ic++] = base + t;
            u += wdt;
          }
        }
      }
    }
  }
  return { opaque: opaque.finish(), translucent: trans.finish(), origin };
}

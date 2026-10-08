import { gridToPos } from '../planet/cubesphere';
import { CHUNK, STRUCTURE } from '../planet/terrain';
import { B } from './blocks';
import { PAD, PAD2 } from './mesher';

/**
 * Smooth terrain mesher (naive Surface Nets) for the cube-sphere density field.
 *
 * Samples sit at cell centres; a cube spans 2x2x2 samples. Every cube crossing
 * the iso-level (0.5) gets one vertex at the mean of its edge crossings, and
 * every sample edge crossing the iso-level emits a quad joining the four cubes
 * around it. A chunk owns the edges that start inside it, so neighbouring
 * chunks (which see the same padded samples) stitch without cracks.
 *
 * Output is non-indexed so each triangle can carry the materials of its three
 * vertices; the shader blends them with barycentric weights (gl_VertexID % 3).
 *
 * Vertex format:
 *   position Float32 x3  chunk-local metres
 *   normal   Int8    x3  from the density gradient (continuous across chunks)
 *   mats     Uint8   x4  block ids of the triangle's 3 vertices, w unused
 *   data     Uint8   x4  [ambient occlusion 0..255, sky 0..255, 0, 0]
 */

export interface SmoothBuffers {
  position: Float32Array;
  normal: Int8Array;
  mats: Uint8Array;
  data: Uint8Array;
}

export interface SmoothInput {
  face: number;
  cx: number;
  cy: number;
  cz: number;
  N: number;
  baseRadius: number;
  /** PAD^3 materials and densities (index (x+1) + (y+1)*PAD + (z+1)*PAD2) */
  vox: Uint8Array;
  dens: Uint8Array;
  /** natural surface top per padded column (sky exposure) */
  topExt: Int16Array;
  origin: [number, number, number];
}

const C = PAD - 1; // cubes per axis (min corner padded 0..C-1)

// cube edges as corner pairs (corner bit layout: x | y<<1 | z<<2)
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) EDGES.push([a, a | bit]);

export function meshSmooth(inp: SmoothInput): SmoothBuffers | null {
  const { face, cx, cy, cz, N, baseRadius, vox, dens, topExt, origin } = inp;
  const I0 = cx * CHUNK, J0 = cy * CHUNK, K0 = cz * CHUNK;

  // field at padded samples: built cubes are not part of the natural surface
  const F = new Float32Array(PAD * PAD2);
  let anyIn = false, anyOut = false;
  for (let i = 0; i < F.length; i++) {
    const b = vox[i];
    const v = STRUCTURE[b] ? 0 : dens[i] / 255;
    F[i] = v;
    if (v >= 0.5) anyIn = true; else anyOut = true;
  }
  if (!anyIn || !anyOut) return null;

  // local Jacobian (world metres per grid unit) at the chunk centre -> dual basis for normals
  const tmp = [0, 0, 0];
  const g0 = [I0 + 16, J0 + 16, K0 + 16];
  const axisVec = (ax: number): number[] => {
    const a = g0.slice(), b = g0.slice();
    a[ax] -= 0.5; b[ax] += 0.5;
    gridToPos(face, a[0], a[1], a[2], N, baseRadius, tmp); const p0 = tmp.slice();
    gridToPos(face, b[0], b[1], b[2], N, baseRadius, tmp);
    return [tmp[0] - p0[0], tmp[1] - p0[1], tmp[2] - p0[2]];
  };
  const ex = axisVec(0), ey = axisVec(1), ez = axisVec(2);
  // dual basis: rows of the inverse Jacobian
  const det = ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) - ey[0] * (ex[1] * ez[2] - ex[2] * ez[1]) + ez[0] * (ex[1] * ey[2] - ex[2] * ey[1]);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dx = cross(ey, ez).map((v) => v / det), dy = cross(ez, ex).map((v) => v / det), dz = cross(ex, ey).map((v) => v / det);

  // ---------------------------------------------------------------- vertices (one per crossing cube)
  const vIdx = new Int32Array(C * C * C).fill(-1);
  const cap0 = 4096;
  let vp = new Float32Array(cap0 * 3), vn = new Float32Array(cap0 * 3), vm = new Uint8Array(cap0), vd = new Uint8Array(cap0 * 2);
  let vc = 0;
  const grow = () => {
    const n = vp.length / 3 * 2;
    const p2 = new Float32Array(n * 3); p2.set(vp); vp = p2;
    const n2 = new Float32Array(n * 3); n2.set(vn); vn = n2;
    const m2 = new Uint8Array(n); m2.set(vm); vm = m2;
    const d2 = new Uint8Array(n * 2); d2.set(vd); vd = d2;
  };
  const cv = new Float32Array(8);
  const ci = new Int32Array(8);
  for (let z = 0; z < C; z++) for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const i = (x + (c & 1)) + (y + ((c >> 1) & 1)) * PAD + (z + ((c >> 2) & 1)) * PAD2;
      ci[c] = i;
      cv[c] = F[i];
      if (F[i] >= 0.5) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    // mean of edge crossings
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      const ia = (mask >> a) & 1, ib = (mask >> b) & 1;
      if (ia === ib) continue;
      const t = (0.5 - cv[a]) / (cv[b] - cv[a]);
      sx += (a & 1) + ((b & 1) - (a & 1)) * t;
      sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
      sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
      n++;
    }
    const ax = sx / n, ay = sy / n, az = sz / n;
    // trilinear gradient of the cube at the vertex
    const lx = (c0: number, c1: number) => (1 - ax) * c0 + ax * c1;
    const ly = (c0: number, c1: number) => (1 - ay) * c0 + ay * c1;
    const lz = (c0: number, c1: number) => (1 - az) * c0 + az * c1;
    const gX = lz(ly(cv[1] - cv[0], cv[3] - cv[2]), ly(cv[5] - cv[4], cv[7] - cv[6]));
    const gY = lz(lx(cv[2] - cv[0], cv[3] - cv[1]), lx(cv[6] - cv[4], cv[7] - cv[5]));
    const gZ = ly(lx(cv[4] - cv[0], cv[5] - cv[1]), lx(cv[6] - cv[2], cv[7] - cv[3]));
    let nx = -(gX * dx[0] + gY * dy[0] + gZ * dz[0]);
    let ny = -(gX * dx[1] + gY * dy[1] + gZ * dz[1]);
    let nz = -(gX * dx[2] + gY * dy[2] + gZ * dz[2]);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // material: the most solid natural corner
    let best = -1, bestV = -1;
    for (let c = 0; c < 8; c++) {
      const b = vox[ci[c]];
      if (b === B.AIR || STRUCTURE[b] || b === B.UNKNOWN) continue;
      if (cv[c] > bestV) { bestV = cv[c]; best = b; }
    }
    if (best < 0) best = B.ROCK;
    // ambient occlusion: solidity of the 4x4x4 neighbourhood (flat ground ~ 0.5)
    let occ = 0, on = 0;
    for (let kz = -1; kz <= 2; kz++) for (let ky = -1; ky <= 2; ky++) for (let kx = -1; kx <= 2; kx++) {
      const X = x + kx, Y = y + ky, Z = z + kz;
      if (X < 0 || Y < 0 || Z < 0 || X >= PAD || Y >= PAD || Z >= PAD) continue;
      occ += F[X + Y * PAD + Z * PAD2] >= 0.5 ? 1 : F[X + Y * PAD + Z * PAD2] * 2 * 0.5;
      on++;
    }
    occ /= on;
    const ao = Math.max(0.18, Math.min(1, 1 - (occ - 0.42) * 2.1));
    // sky exposure from the natural column top
    const colTop = topExt[Math.min(PAD - 1, x + (ax > 0.5 ? 1 : 0)) + Math.min(PAD - 1, y + (ay > 0.5 ? 1 : 0)) * PAD];
    const K = K0 + z - 1 + az;
    const depth = colTop - K;
    const sky = depth < 0 ? 1 : Math.max(0, 1 - depth / 9);

    if (vc * 3 >= vp.length) grow();
    // padded sample x <-> cell (x-1) centre at grid I0 + x - 0.5
    gridToPos(face, I0 + x + ax - 0.5, J0 + y + ay - 0.5, K0 + z + az - 0.5, N, baseRadius, tmp);
    vp[vc * 3] = tmp[0] - origin[0]; vp[vc * 3 + 1] = tmp[1] - origin[1]; vp[vc * 3 + 2] = tmp[2] - origin[2];
    vn[vc * 3] = nx; vn[vc * 3 + 1] = ny; vn[vc * 3 + 2] = nz;
    vm[vc] = best;
    vd[vc * 2] = Math.round(ao * 255);
    vd[vc * 2 + 1] = Math.round(sky * 255);
    vIdx[x + y * C + z * C * C] = vc;
    vc++;
  }
  if (vc === 0) return null;

  // ---------------------------------------------------------------- quads (one per crossing sample edge owned by the chunk)
  let cap = 8192;
  let op = new Float32Array(cap * 3), on8 = new Int8Array(cap * 3), om = new Uint8Array(cap * 4), od = new Uint8Array(cap * 4);
  let oc = 0;
  const ensure = (k: number) => {
    if (oc + k <= cap) return;
    cap = Math.max(cap * 2, oc + k);
    const p2 = new Float32Array(cap * 3); p2.set(op); op = p2;
    const n2 = new Int8Array(cap * 3); n2.set(on8); on8 = n2;
    const m2 = new Uint8Array(cap * 4); m2.set(om); om = m2;
    const d2 = new Uint8Array(cap * 4); d2.set(od); od = d2;
  };
  const tri = (a: number, b: number, c: number) => {
    ensure(3);
    const vs = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const v = vs[k], o = oc + k;
      op[o * 3] = vp[v * 3]; op[o * 3 + 1] = vp[v * 3 + 1]; op[o * 3 + 2] = vp[v * 3 + 2];
      on8[o * 3] = Math.round(vn[v * 3] * 127); on8[o * 3 + 1] = Math.round(vn[v * 3 + 1] * 127); on8[o * 3 + 2] = Math.round(vn[v * 3 + 2] * 127);
      om[o * 4] = vm[a]; om[o * 4 + 1] = vm[b]; om[o * 4 + 2] = vm[c]; om[o * 4 + 3] = 0;
      od[o * 4] = vd[v * 2]; od[o * 4 + 1] = vd[v * 2 + 1]; od[o * 4 + 2] = 0; od[o * 4 + 3] = 0;
    }
    oc += 3;
  };
  const quad = (q0: number, q1: number, q2: number, q3: number) => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return;
    // orient by the gradient normal
    const P = (v: number, k: number) => vp[v * 3 + k];
    const e1 = [P(q1, 0) - P(q0, 0), P(q1, 1) - P(q0, 1), P(q1, 2) - P(q0, 2)];
    const e2 = [P(q2, 0) - P(q0, 0), P(q2, 1) - P(q0, 1), P(q2, 2) - P(q0, 2)];
    const tn = cross(e1, e2);
    const avg = [0, 1, 2].map((k) => vn[q0 * 3 + k] + vn[q1 * 3 + k] + vn[q2 * 3 + k] + vn[q3 * 3 + k]);
    const flip = tn[0] * avg[0] + tn[1] * avg[1] + tn[2] * avg[2] < 0;
    // split along the shorter diagonal
    const d02 = (P(q2, 0) - P(q0, 0)) ** 2 + (P(q2, 1) - P(q0, 1)) ** 2 + (P(q2, 2) - P(q0, 2)) ** 2;
    const d13 = (P(q3, 0) - P(q1, 0)) ** 2 + (P(q3, 1) - P(q1, 1)) ** 2 + (P(q3, 2) - P(q1, 2)) ** 2;
    if (d02 <= d13) {
      if (!flip) { tri(q0, q1, q2); tri(q0, q2, q3); } else { tri(q0, q2, q1); tri(q0, q3, q2); }
    } else {
      if (!flip) { tri(q0, q1, q3); tri(q1, q2, q3); } else { tri(q0, q3, q1); tri(q1, q3, q2); }
    }
  };
  const V = (x: number, y: number, z: number) => vIdx[x + y * C + z * C * C];
  for (let z = 1; z <= CHUNK; z++) for (let y = 1; y <= CHUNK; y++) for (let x = 1; x <= CHUNK; x++) {
    const s0 = F[x + y * PAD + z * PAD2] >= 0.5;
    if (s0 !== (F[x + 1 + y * PAD + z * PAD2] >= 0.5)) quad(V(x, y - 1, z - 1), V(x, y, z - 1), V(x, y, z), V(x, y - 1, z));
    if (s0 !== (F[x + (y + 1) * PAD + z * PAD2] >= 0.5)) quad(V(x - 1, y, z - 1), V(x, y, z - 1), V(x, y, z), V(x - 1, y, z));
    if (s0 !== (F[x + y * PAD + (z + 1) * PAD2] >= 0.5)) quad(V(x - 1, y - 1, z), V(x, y - 1, z), V(x, y, z), V(x - 1, y, z));
  }
  if (oc === 0) return null;
  return { position: op.slice(0, oc * 3), normal: on8.slice(0, oc * 3), mats: om.slice(0, oc * 4), data: od.slice(0, oc * 4) };
}

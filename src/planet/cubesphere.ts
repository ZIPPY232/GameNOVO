/**
 * Cube-sphere mapping (equiangular). A planet is six cube faces, each a grid of
 * N x N columns; every column is a stack of radial voxel layers. Voxels stay
 * aligned with local "up" everywhere on the sphere, so blocks always sit flat
 * under the player's feet regardless of where on the planet they stand.
 *
 * Coordinates:
 *  - face   0..5 (+X,-X,+Y,-Y,+Z,-Z)
 *  - x, y   continuous grid coords in [0, N] across a face
 *  - z      continuous radial layer, radius = baseRadius + z
 */

export const FACE_COUNT = 6;
export const QUARTER_PI = Math.PI / 4;

// normal, u axis, v axis for each face (u x v = normal)
export const FACE_N: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
export const FACE_U: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0],
];
export const FACE_V: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0],
];

export interface Vec3Like { x: number; y: number; z: number }

/** Unit direction for grid coords (x, y) on a face with N cells per edge. Writes into out[0..2]. */
export function gridToDir(face: number, x: number, y: number, N: number, out: Float64Array | number[], o = 0): void {
  const a = (x / N) * 2 - 1;
  const b = (y / N) * 2 - 1;
  const tu = Math.tan(a * QUARTER_PI);
  const tv = Math.tan(b * QUARTER_PI);
  const n = FACE_N[face], u = FACE_U[face], v = FACE_V[face];
  const px = n[0] + tu * u[0] + tv * v[0];
  const py = n[1] + tu * u[1] + tv * v[1];
  const pz = n[2] + tu * u[2] + tv * v[2];
  const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
  out[o] = px * inv;
  out[o + 1] = py * inv;
  out[o + 2] = pz * inv;
}

/** Face of a direction (largest absolute component). */
export function dirFace(dx: number, dy: number, dz: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax >= ay && ax >= az) return dx >= 0 ? 0 : 1;
  if (ay >= az) return dy >= 0 ? 2 : 3;
  return dz >= 0 ? 4 : 5;
}

/** Continuous grid coords (x, y) of a direction projected onto a given face. */
export function dirToGridOnFace(face: number, dx: number, dy: number, dz: number, N: number, out: number[]): void {
  const n = FACE_N[face], u = FACE_U[face], v = FACE_V[face];
  const dn = dx * n[0] + dy * n[1] + dz * n[2];
  const s = (dx * u[0] + dy * u[1] + dz * u[2]) / dn;
  const t = (dx * v[0] + dy * v[1] + dz * v[2]) / dn;
  out[0] = ((Math.atan(s) / QUARTER_PI) + 1) * 0.5 * N;
  out[1] = ((Math.atan(t) / QUARTER_PI) + 1) * 0.5 * N;
}

/** Converts a planet-local position to (face, x, y, z). Returns face; writes x,y,z. */
export function posToGrid(px: number, py: number, pz: number, N: number, baseRadius: number, out: number[]): number {
  const r = Math.sqrt(px * px + py * py + pz * pz) || 1e-9;
  const dx = px / r, dy = py / r, dz = pz / r;
  const face = dirFace(dx, dy, dz);
  dirToGridOnFace(face, dx, dy, dz, N, out);
  out[2] = r - baseRadius;
  return face;
}

const tmpDir = [0, 0, 0];
/** Planet-local position for continuous grid coordinates (may extend slightly past face edges). */
export function gridToPos(face: number, x: number, y: number, z: number, N: number, baseRadius: number, out: number[]): void {
  gridToDir(face, x, y, N, tmpDir);
  const r = baseRadius + z;
  out[0] = tmpDir[0] * r;
  out[1] = tmpDir[1] * r;
  out[2] = tmpDir[2] * r;
}

const tmpG = [0, 0, 0];
/**
 * Canonicalises integer cell coords that may lie outside [0, N) on a face by
 * re-projecting the cell centre onto the owning face. Returns face, writes I,J.
 */
export function canonicalCell(face: number, I: number, J: number, N: number, out: number[]): number {
  if (I >= 0 && I < N && J >= 0 && J < N) {
    out[0] = I;
    out[1] = J;
    return face;
  }
  gridToDir(face, I + 0.5, J + 0.5, N, tmpDir);
  const f = dirFace(tmpDir[0], tmpDir[1], tmpDir[2]);
  dirToGridOnFace(f, tmpDir[0], tmpDir[1], tmpDir[2], N, tmpG);
  out[0] = Math.min(N - 1, Math.max(0, Math.floor(tmpG[0])));
  out[1] = Math.min(N - 1, Math.max(0, Math.floor(tmpG[1])));
  return f;
}

/** Choose a face resolution (multiple of chunk size) so blocks are ~1 m at the surface. */
export function faceResolutionForRadius(radius: number, chunk = 32): number {
  const n = (Math.PI * radius) / 2;
  return Math.max(chunk * 8, Math.round(n / chunk) * chunk);
}

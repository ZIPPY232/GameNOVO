import * as THREE from 'three';
import { posToGrid, gridToPos } from '../planet/cubesphere';
import { BLOCK_SOLID, B } from '../voxel/blocks';
import type { VoxelWorld } from '../voxel/VoxelWorld';

/**
 * Collision and ray casting against curved cube-sphere voxels.
 *
 * Entities are simulated in planet-local world space, but collisions are
 * resolved in the planet's continuous grid space (face, x, y, z) where every
 * voxel is a unit cube and +z is always "up". World deltas are mapped into
 * grid space through the local Jacobian of the mapping, which is accurate over
 * the short distances moved per sub-step.
 */

export interface GridPos {
  face: number;
  x: number;
  y: number;
  z: number;
}

export interface MoveResult {
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  grounded: boolean;
  ceiling: boolean;
  stepped: number;
}

export interface RayHit {
  face: number;
  I: number;
  J: number;
  K: number;
  block: number;
  /** cell adjacent to the hit face (for placement) */
  prev: { face: number; I: number; J: number; K: number };
  dist: number;
  point: THREE.Vector3;
  /** grid axis of the hit face: 0 x, 1 y, 2 z(radial) and sign */
  axis: number;
  sign: number;
}

const tmpG = [0, 0, 0];
const tmpP = [0, 0, 0];

export class VoxelPhysics {
  readonly world: VoxelWorld;
  private N: number;
  private base: number;
  private ex = new THREE.Vector3();
  private ey = new THREE.Vector3();
  private ez = new THREE.Vector3();
  private m = new THREE.Matrix3();
  private mInv = new THREE.Matrix3();

  constructor(world: VoxelWorld) {
    this.world = world;
    this.N = world.params.N;
    this.base = world.params.baseRadius;
  }

  toGrid(p: THREE.Vector3, out: GridPos): GridPos {
    out.face = posToGrid(p.x, p.y, p.z, this.N, this.base, tmpG);
    out.x = tmpG[0]; out.y = tmpG[1]; out.z = tmpG[2];
    return out;
  }

  fromGrid(g: GridPos, out: THREE.Vector3): THREE.Vector3 {
    gridToPos(g.face, g.x, g.y, g.z, this.N, this.base, tmpP);
    return out.set(tmpP[0], tmpP[1], tmpP[2]);
  }

  /** Local basis: world displacement per unit grid step along x, y, z. */
  basis(g: GridPos): void {
    const h = 0.5;
    gridToPos(g.face, g.x + h, g.y, g.z, this.N, this.base, tmpP); const ax = tmpP[0], ay = tmpP[1], az = tmpP[2];
    gridToPos(g.face, g.x - h, g.y, g.z, this.N, this.base, tmpP);
    this.ex.set(ax - tmpP[0], ay - tmpP[1], az - tmpP[2]);
    gridToPos(g.face, g.x, g.y + h, g.z, this.N, this.base, tmpP); const bx = tmpP[0], by = tmpP[1], bz = tmpP[2];
    gridToPos(g.face, g.x, g.y - h, g.z, this.N, this.base, tmpP);
    this.ey.set(bx - tmpP[0], by - tmpP[1], bz - tmpP[2]);
    gridToPos(g.face, g.x, g.y, g.z + h, this.N, this.base, tmpP); const cx = tmpP[0], cy = tmpP[1], cz = tmpP[2];
    gridToPos(g.face, g.x, g.y, g.z - h, this.N, this.base, tmpP);
    this.ez.set(cx - tmpP[0], cy - tmpP[1], cz - tmpP[2]);
    this.m.set(
      this.ex.x, this.ey.x, this.ez.x,
      this.ex.y, this.ey.y, this.ez.y,
      this.ex.z, this.ey.z, this.ez.z,
    );
    this.mInv.copy(this.m).invert();
  }

  worldToGridDelta(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(d).applyMatrix3(this.mInv);
  }

  gridAxisWorld(axis: number): THREE.Vector3 {
    return axis === 0 ? this.ex : axis === 1 ? this.ey : this.ez;
  }

  solid(face: number, I: number, J: number, K: number): boolean {
    return BLOCK_SOLID[this.world.getBlock(face, I, J, K)] === 1;
  }

  /** AABB in grid space: centre (x,y), feet z, half width hw (grid units), height h. */
  boxHits(face: number, x: number, y: number, z: number, hw: number, h: number): boolean {
    const e = 1e-4;
    const x0 = Math.floor(x - hw + e), x1 = Math.floor(x + hw - e);
    const y0 = Math.floor(y - hw + e), y1 = Math.floor(y + hw - e);
    const z0 = Math.floor(z + e), z1 = Math.floor(z + h - e);
    for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      if (this.solid(face, i, j, k)) return true;
    }
    return false;
  }

  /**
   * Moves an upright box by a world-space delta with sliding collisions and
   * optional auto step-up. Modifies `pos` (planet-local) and `vel`.
   */
  move(pos: THREE.Vector3, vel: THREE.Vector3, delta: THREE.Vector3, halfWidth: number, height: number, stepUp: boolean, grounded: boolean): MoveResult {
    const res: MoveResult = { hitX: false, hitY: false, hitZ: false, grounded: false, ceiling: false, stepped: 0 };
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    this.toGrid(pos, g);
    this.basis(g);
    const dg = this.worldToGridDelta(delta, new THREE.Vector3());
    const hw = halfWidth / this.ex.length();
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dg.x), Math.abs(dg.y), Math.abs(dg.z)) / 0.35));
    const sx = dg.x / steps, sy = dg.y / steps, sz = dg.z / steps;
    for (let s = 0; s < steps; s++) {
      // radial first
      if (sz !== 0) {
        const nz = g.z + sz;
        if (this.boxHits(g.face, g.x, g.y, nz, hw, height)) {
          res.hitZ = true;
          if (sz < 0) { g.z = Math.floor(nz + 1e-4) + 1; res.grounded = true; }
          else { g.z = Math.ceil(nz + height) - height - 1e-3; res.ceiling = true; }
        } else g.z = nz;
      }
      for (let axis = 0; axis < 2; axis++) {
        const d = axis === 0 ? sx : sy;
        if (d === 0) continue;
        const nx = axis === 0 ? g.x + d : g.x;
        const ny = axis === 1 ? g.y + d : g.y;
        if (!this.boxHits(g.face, nx, ny, g.z, hw, height)) {
          g.x = nx; g.y = ny;
          continue;
        }
        // try stepping up one block
        if (stepUp && (grounded || res.grounded)) {
          const top = Math.floor(g.z + 1e-4) + 1;
          const lift = top - g.z;
          if (lift <= 1.05 && !this.boxHits(g.face, g.x, g.y, top + 0.001, hw, height) && !this.boxHits(g.face, nx, ny, top + 0.001, hw, height)) {
            g.z = top + 0.001;
            g.x = nx; g.y = ny;
            res.stepped += lift;
            continue;
          }
        }
        if (axis === 0) {
          res.hitX = true;
          g.x = d > 0 ? Math.floor(nx + hw) - hw - 1e-3 : Math.floor(nx - hw) + 1 + hw + 1e-3;
          if (this.boxHits(g.face, g.x, g.y, g.z, hw, height)) g.x -= d; // safety
        } else {
          res.hitY = true;
          g.y = d > 0 ? Math.floor(ny + hw) - hw - 1e-3 : Math.floor(ny - hw) + 1 + hw + 1e-3;
          if (this.boxHits(g.face, g.x, g.y, g.z, hw, height)) g.y -= d;
        }
      }
    }
    // remove velocity into collided axes
    const newPos = this.fromGrid(g, new THREE.Vector3());
    if (res.hitZ) {
      const up = newPos.clone().normalize();
      const vr = vel.dot(up);
      if ((res.grounded && vr < 0) || (res.ceiling && vr > 0)) vel.addScaledVector(up, -vr);
    }
    if (res.hitX) {
      const a = this.ex.clone().normalize();
      vel.addScaledVector(a, -vel.dot(a));
    }
    if (res.hitY) {
      const a = this.ey.clone().normalize();
      vel.addScaledVector(a, -vel.dot(a));
    }
    pos.copy(newPos);
    // if moved off a face, re-derive face (toGrid does it on the next call)
    return res;
  }

  /** Is there ground directly below the box (within eps)? */
  groundBelow(pos: THREE.Vector3, halfWidth: number, eps = 0.06): boolean {
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    this.toGrid(pos, g);
    this.basis(g);
    const hw = halfWidth / this.ex.length();
    return this.boxHits(g.face, g.x, g.y, g.z - eps, hw, 0.05);
  }

  /** Voxel ray cast (DDA in locally linearised grid space). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, pickMachines = true): RayHit | null {
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    this.toGrid(origin, g);
    this.basis(g);
    const d = this.worldToGridDelta(dir, new THREE.Vector3()); // grid units per metre
    let I = Math.floor(g.x), J = Math.floor(g.y), K = Math.floor(g.z);
    const stepX = d.x > 0 ? 1 : -1, stepY = d.y > 0 ? 1 : -1, stepZ = d.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (d.x || 1e-12)), tDeltaY = Math.abs(1 / (d.y || 1e-12)), tDeltaZ = Math.abs(1 / (d.z || 1e-12));
    let tMaxX = (d.x > 0 ? I + 1 - g.x : g.x - I) * tDeltaX;
    let tMaxY = (d.y > 0 ? J + 1 - g.y : g.y - J) * tDeltaY;
    let tMaxZ = (d.z > 0 ? K + 1 - g.z : g.z - K) * tDeltaZ;
    let pI = I, pJ = J, pK = K, axis = -1, t = 0;
    for (let i = 0; i < 64 && t <= maxDist; i++) {
      const b = this.world.getBlock(g.face, I, J, K);
      if (b !== B.AIR && (pickMachines || b < B.MACHINE) && axis >= 0) {
        const hit: RayHit = {
          face: g.face, I, J, K, block: b,
          prev: { face: g.face, I: pI, J: pJ, K: pK },
          dist: t,
          point: origin.clone().addScaledVector(dir, t),
          axis,
          sign: axis === 0 ? -stepX : axis === 1 ? -stepY : -stepZ,
        };
        return hit;
      }
      pI = I; pJ = J; pK = K;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { I += stepX; t = tMaxX; tMaxX += tDeltaX; axis = 0; }
      else if (tMaxY < tMaxZ) { J += stepY; t = tMaxY; tMaxY += tDeltaY; axis = 1; }
      else { K += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; axis = 2; }
    }
    return null;
  }

  /** The 8 world-space corners of a cell (planet-local). */
  cellCorners(face: number, I: number, J: number, K: number, pad = 0): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let c = 0; c < 8; c++) {
      const dx = c & 1 ? 1 + pad : -pad, dy = c & 2 ? 1 + pad : -pad, dz = c & 4 ? 1 + pad : -pad;
      gridToPos(face, I + dx, J + dy, K + dz, this.N, this.base, tmpP);
      out.push(new THREE.Vector3(tmpP[0], tmpP[1], tmpP[2]));
    }
    return out;
  }

  cellCenter(face: number, I: number, J: number, K: number, out = new THREE.Vector3()): THREE.Vector3 {
    gridToPos(face, I + 0.5, J + 0.5, K + 0.5, this.N, this.base, tmpP);
    return out.set(tmpP[0], tmpP[1], tmpP[2]);
  }
}

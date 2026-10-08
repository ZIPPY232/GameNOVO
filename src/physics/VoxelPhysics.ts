import * as THREE from 'three';
import { posToGrid, gridToPos } from '../planet/cubesphere';
import { BLOCK_SOLID, B } from '../voxel/blocks';
import type { VoxelWorld } from '../voxel/VoxelWorld';

/**
 * Collision and ray casting against the planet's smooth terrain field.
 *
 * Entities are simulated in planet-local world space, but collisions are
 * resolved in the planet's continuous grid space (face, x, y, z) where cells
 * are ~1 m and +z is always "up". The terrain is the 0.5 iso-surface of the
 * trilinear density field (built cubes count as fully solid), so walking
 * follows slopes smoothly, steep faces block the body and small ledges are
 * stepped over.
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
  /** dominant grid axis of the surface normal: 0 x, 1 y, 2 z(radial) and sign */
  axis: number;
  sign: number;
  /** surface normal (planet-local world space) */
  normal: THREE.Vector3;
}

/** max height climbed without jumping (m) */
const STEP_H = 0.55;
/** body sample heights above the feet (m) used for wall contacts */
const BODY_H = [0.6, 1.05, 1.5];

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

  /** Is the upright body (feet at z) overlapping the terrain? (grid units) */
  boxHits(face: number, x: number, y: number, z: number, hw: number, h: number): boolean {
    const w = this.world;
    for (const hh of [Math.min(0.65, h * 0.5), h * 0.55, Math.max(0.4, h - 0.1)]) {
      if (w.sample(face, x, y, z + hh) >= 0.5) return true;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.785;
        if (w.sample(face, x + Math.cos(a) * hw * 0.8, y + Math.sin(a) * hw * 0.8, z + hh) >= 0.5) return true;
      }
    }
    return false;
  }

  /** field gradient (grid space, points into the terrain) */
  private grad(face: number, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const w = this.world, e = 0.2;
    return out.set(
      w.sample(face, x + e, y, z) - w.sample(face, x - e, y, z),
      w.sample(face, x, y + e, z) - w.sample(face, x, y - e, z),
      w.sample(face, x, y, z + e) - w.sample(face, x, y, z - e),
    ).multiplyScalar(1 / (2 * e));
  }

  /** highest ground under the feet footprint (grid z), searching from z + up down by `down` */
  groundAt(face: number, x: number, y: number, z: number, hw: number, up = STEP_H, down = 2): number {
    const w = this.world;
    let best = w.surfaceBelow(face, x, y, z + up, up + down);
    const r = hw * 0.7;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const gz = w.surfaceBelow(face, x + Math.cos(a) * r, y + Math.sin(a) * r, z + up, up + down);
      if (gz > best) best = gz;
    }
    return best;
  }

  /**
   * Moves an upright body by a world-space delta: ground following on slopes,
   * small ledges stepped over, walls and ceilings blocking. Modifies `pos`
   * (planet-local) and removes velocity into contacts from `vel`.
   */
  move(pos: THREE.Vector3, vel: THREE.Vector3, delta: THREE.Vector3, halfWidth: number, height: number, stepUp: boolean, grounded: boolean): MoveResult {
    const res: MoveResult = { hitX: false, hitY: false, hitZ: false, grounded: false, ceiling: false, stepped: 0 };
    const w = this.world;
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    this.toGrid(pos, g);
    this.basis(g);
    const dg = this.worldToGridDelta(delta, new THREE.Vector3());
    const hw = halfWidth / this.ex.length();
    const steps = Math.max(1, Math.ceil(Math.max(Math.hypot(dg.x, dg.y), Math.abs(dg.z)) / 0.25));
    const sx = dg.x / steps, sy = dg.y / steps, sz = dg.z / steps;
    const gr = new THREE.Vector3();
    const push = new THREE.Vector2();
    let onGround = grounded;
    for (let s = 0; s < steps; s++) {
      const ox = g.x, oy = g.y;
      // ---- horizontal, with wall push-out at body heights
      g.x += sx; g.y += sy;
      for (let it = 0; it < 3; it++) {
        push.set(0, 0);
        let any = false;
        for (const hh of BODY_H) {
          if (hh > height - 0.05) continue;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const px = g.x + Math.cos(a) * hw, py = g.y + Math.sin(a) * hw, pz = g.z + hh;
            const f = w.sample(g.face, px, py, pz);
            if (f < 0.5) continue;
            this.grad(g.face, px, py, pz, gr);
            const gl = Math.hypot(gr.x, gr.y);
            if (gl < 1e-4) continue;
            const pen = Math.min(0.3, (f - 0.5) / Math.max(0.12, gr.length()) + 0.01);
            push.x -= (gr.x / gl) * pen;
            push.y -= (gr.y / gl) * pen;
            any = true;
          }
        }
        if (!any) break;
        const pl = push.length();
        if (pl > 0.3) push.multiplyScalar(0.3 / pl);
        g.x += push.x; g.y += push.y;
        res.hitX = true; res.hitY = true;
        // cancel velocity into the wall
        const nW = this.ex.clone().multiplyScalar(push.x).addScaledVector(this.ey, push.y);
        if (nW.lengthSq() > 1e-10) {
          nW.normalize();
          const vn = vel.dot(nW);
          if (vn < 0) vel.addScaledVector(nW, -vn);
        }
      }
      // ---- vertical: ground following, small ledges, ceilings
      const zBefore = g.z;
      g.z += sz;
      const ground = this.groundAt(g.face, g.x, g.y, g.z, hw, STEP_H + Math.max(0, -sz), 2);
      if (ground > -Infinity) {
        const rise = ground - g.z;
        if (rise > STEP_H + 0.02) {
          // too tall to step: treat as a wall
          g.x = ox; g.y = oy; g.z = zBefore + sz;
          res.hitX = true; res.hitY = true;
          const back = this.groundAt(g.face, g.x, g.y, g.z, hw, STEP_H, 2);
          if (back >= g.z - 1e-3) { g.z = back; res.grounded = true; res.hitZ = true; onGround = true; }
        } else if (rise >= 0) {
          if (sz <= 0 || rise > 0.02) {
            if (onGround && rise > 0.12 && stepUp) res.stepped += rise;
            else if (rise > 0.12 && !onGround && !stepUp) { /* airborne bump: still land on it */ }
            g.z = ground;
            res.grounded = true; res.hitZ = true; onGround = true;
          }
        } else if (onGround && sz <= 0 && rise > -0.45) {
          // stick to the ground when walking downhill
          g.z = ground;
          res.grounded = true; onGround = true;
        } else onGround = false;
      } else onGround = false;
      // ceiling
      if (sz > 0 && w.sample(g.face, g.x, g.y, g.z + height) >= 0.5) {
        g.z = zBefore;
        res.ceiling = true; res.hitZ = true;
      }
    }
    const newPos = this.fromGrid(g, new THREE.Vector3());
    if (res.hitZ || res.grounded) {
      const up = newPos.clone().normalize();
      const vr = vel.dot(up);
      if ((res.grounded && vr < 0) || (res.ceiling && vr > 0)) vel.addScaledVector(up, -vr);
    }
    pos.copy(newPos);
    return res;
  }

  /** Is there ground directly below the body (within eps)? */
  groundBelow(pos: THREE.Vector3, halfWidth: number, eps = 0.06): boolean {
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    this.toGrid(pos, g);
    this.basis(g);
    const hw = halfWidth / this.ex.length();
    const gz = this.groundAt(g.face, g.x, g.y, g.z, hw, 0.1, eps + 0.1);
    return gz > -Infinity && g.z - gz <= eps + 0.02;
  }

  /**
   * Ray cast against the terrain field (and built cubes). Marches the ray,
   * refines the crossing by bisection and reports the solid cell behind it.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, pickMachines = true): RayHit | null {
    const w = this.world;
    const g: GridPos = { face: 0, x: 0, y: 0, z: 0 };
    const p = new THREE.Vector3();
    w.ignoreMachines = !pickMachines;
    try {
      const at = (t: number) => {
        p.copy(origin).addScaledVector(dir, t);
        this.toGrid(p, g);
        return w.sample(g.face, g.x, g.y, g.z);
      };
      let t = 0, tPrev = 0;
      let f = at(0);
      if (f >= 0.5) return null; // starting inside
      const far = maxDist > 40;
      while (t < maxDist) {
        tPrev = t;
        t = Math.min(maxDist, t + (f < 0.01 ? (far ? 1.0 : 0.35) : 0.12));
        f = at(t);
        if (f >= 0.5) {
          let lo = tPrev, hi = t;
          for (let i = 0; i < 7; i++) {
            const m = (lo + hi) * 0.5;
            if (at(m) >= 0.5) hi = m; else lo = m;
          }
          const th = (lo + hi) * 0.5;
          const point = origin.clone().addScaledVector(dir, th);
          // solid cell just behind the surface
          this.toGrid(p.copy(point).addScaledVector(dir, 0.08), g);
          let I = Math.floor(g.x), J = Math.floor(g.y), K = Math.floor(g.z);
          const face = g.face;
          let b = w.getBlock(face, I, J, K);
          if (b === B.AIR || (!pickMachines && b >= B.MACHINE)) {
            // the surface crossed inside an air cell: take the most solid neighbour
            let best = -1;
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const bb = w.getBlock(face, I + dx, J + dy, K + dz);
              if (bb === B.AIR || bb === B.UNKNOWN || (!pickMachines && bb >= B.MACHINE)) continue;
              const cxx = I + dx + 0.5 - g.x, cyy = J + dy + 0.5 - g.y, czz = K + dz + 0.5 - g.z;
              const score = w.field(face, I + dx, J + dy, K + dz) - Math.hypot(cxx, cyy, czz) * 0.3;
              if (score > best) { best = score; b = bb; I = I + dx; J = J + dy; K = K + dz; }
            }
          }
          // air cell in front (placement)
          this.toGrid(p.copy(point).addScaledVector(dir, -0.35), g);
          const prev = { face: g.face, I: Math.floor(g.x), J: Math.floor(g.y), K: Math.floor(g.z) };
          // normal from the field gradient
          this.toGrid(point, g);
          this.basis(g);
          const gr = this.grad(g.face, g.x, g.y, g.z, new THREE.Vector3());
          const ax = Math.abs(gr.x) > Math.abs(gr.y) ? (Math.abs(gr.x) > Math.abs(gr.z) ? 0 : 2) : Math.abs(gr.y) > Math.abs(gr.z) ? 1 : 2;
          const sign = -Math.sign(ax === 0 ? gr.x : ax === 1 ? gr.y : gr.z) || 1;
          // world normal: -(grad) through the dual basis (cells are ~orthonormal)
          const n = this.ex.clone().multiplyScalar(-gr.x / this.ex.lengthSq())
            .addScaledVector(this.ey, -gr.y / this.ey.lengthSq())
            .addScaledVector(this.ez, -gr.z / this.ez.lengthSq());
          if (n.lengthSq() < 1e-8) n.copy(dir).negate();
          n.normalize();
          return { face, I, J, K, block: b, prev, dist: th, point, axis: ax, sign, normal: n };
        }
      }
      return null;
    } finally {
      w.ignoreMachines = false;
    }
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

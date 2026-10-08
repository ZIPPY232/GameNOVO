import * as THREE from 'three';
import type { BodyDef, StarSystemDef } from './types';

/**
 * Runtime star system: evaluates body positions/orientations at a given game
 * time and converts states between reference frames.
 *
 * Reference frames:
 *  - system frame: inertial, star at origin
 *  - body frame:   centred on a rocky body and co-rotating with it, so terrain
 *                  is static and the player/ship simulate in small coordinates
 *
 * All values are JS doubles; only camera-relative values ever reach the GPU.
 */

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

export class BodyState {
  readonly def: BodyDef;
  parent: BodyState | null = null;
  /** position in system frame */
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  /** orientation (body-local -> system) */
  rot = new THREE.Quaternion();
  rotInv = new THREE.Quaternion();
  /** angular velocity in system frame (rad/s) */
  omega = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private tiltQ = new THREE.Quaternion();
  private orbitQ = new THREE.Quaternion();

  constructor(def: BodyDef) {
    this.def = def;
    const t = def.rotation.tilt;
    this.tiltQ.setFromAxisAngle(X, t);
    this.axis.copy(Y).applyQuaternion(this.tiltQ);
    this.orbitQ.setFromAxisAngle(Y, def.orbit.node).multiply(new THREE.Quaternion().setFromAxisAngle(X, def.orbit.inclination));
  }

  get id(): string { return this.def.id; }
  get radius(): number { return this.def.radius; }
  get landable(): boolean { return this.def.type !== 'gas_giant'; }

  update(t: number): void {
    const o = this.def.orbit;
    const w = (Math.PI * 2) / o.period;
    const a = o.phase + w * t;
    const local = new THREE.Vector3(Math.cos(a) * o.radius, 0, -Math.sin(a) * o.radius).applyQuaternion(this.orbitQ);
    const lv = new THREE.Vector3(-Math.sin(a) * o.radius * w, 0, -Math.cos(a) * o.radius * w).applyQuaternion(this.orbitQ);
    if (this.parent) {
      this.pos.copy(this.parent.pos).add(local);
      this.vel.copy(this.parent.vel).add(lv);
    } else {
      this.pos.copy(local);
      this.vel.copy(lv);
    }
    const r = this.def.rotation;
    const wr = (Math.PI * 2) / r.period;
    const ang = r.phase + wr * t;
    const spin = new THREE.Quaternion().setFromAxisAngle(Y, ang);
    this.rot.copy(this.tiltQ).multiply(spin);
    this.rotInv.copy(this.rot).invert();
    this.omega.copy(this.axis).multiplyScalar(wr);
  }

  /** Unit direction of the body's spin axis in system frame. */
  spinAxis(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.axis);
  }
}

export type Frame = BodyState | null;

export class StarSystem {
  readonly def: StarSystemDef;
  readonly bodies: BodyState[] = [];
  private byId = new Map<string, BodyState>();
  time = 0;

  constructor(def: StarSystemDef) {
    this.def = def;
    for (const b of def.bodies) {
      const s = new BodyState(b);
      this.bodies.push(s);
      this.byId.set(b.id, s);
    }
    for (const s of this.bodies) if (s.def.parentId) s.parent = this.byId.get(s.def.parentId) ?? null;
    // parents must update before children
    this.bodies.sort((a, b) => depth(a) - depth(b));
    this.update(0);
  }

  body(id: string): BodyState | undefined {
    return this.byId.get(id);
  }

  update(t: number): void {
    this.time = t;
    for (const b of this.bodies) b.update(t);
  }

  // ------------------------------------------------------------------ frames

  posToSystem(frame: Frame, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!frame) return out.copy(p);
    return out.copy(p).applyQuaternion(frame.rot).add(frame.pos);
  }

  posFromSystem(frame: Frame, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!frame) return out.copy(p);
    return out.copy(p).sub(frame.pos).applyQuaternion(frame.rotInv);
  }

  /** Position of `p` given in frame `from`, expressed in frame `to`. */
  posBetween(from: Frame, to: Frame, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (from === to) return out.copy(p);
    const tmp = this.posToSystem(from, p, new THREE.Vector3());
    return this.posFromSystem(to, tmp, out);
  }

  velToSystem(frame: Frame, p: THREE.Vector3, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!frame) return out.copy(v);
    const r = p.clone().applyQuaternion(frame.rot);
    const wxr = new THREE.Vector3().crossVectors(frame.omega, r);
    return out.copy(v).applyQuaternion(frame.rot).add(frame.vel).add(wxr);
  }

  velFromSystem(frame: Frame, pSys: THREE.Vector3, vSys: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!frame) return out.copy(vSys);
    const r = pSys.clone().sub(frame.pos);
    const wxr = new THREE.Vector3().crossVectors(frame.omega, r);
    return out.copy(vSys).sub(frame.vel).sub(wxr).applyQuaternion(frame.rotInv);
  }

  quatToSystem(frame: Frame, q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
    if (!frame) return out.copy(q);
    return out.copy(frame.rot).multiply(q);
  }

  quatFromSystem(frame: Frame, q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
    if (!frame) return out.copy(q);
    return out.copy(frame.rotInv).multiply(q);
  }

  /** Orientation that maps frame `from` axes into frame `to` axes. */
  frameRotation(from: Frame, to: Frame, out: THREE.Quaternion): THREE.Quaternion {
    const a = from ? from.rot : new THREE.Quaternion();
    const bInv = to ? to.rotInv : new THREE.Quaternion();
    return out.copy(bInv).multiply(a);
  }

  /** Landable body whose SOI contains a system-frame point (deepest/nearest wins). */
  soiBodyAt(pSys: THREE.Vector3, current: Frame): BodyState | null {
    let best: BodyState | null = null;
    let bestR = Infinity;
    for (const b of this.bodies) {
      if (!b.landable) continue;
      const d = b.pos.distanceTo(pSys);
      // hysteresis: keep current frame until 8% beyond its SOI
      const lim = b === current ? b.def.soi * 1.08 : b.def.soi;
      if (d < lim && b.def.radius < bestR) {
        best = b;
        bestR = b.def.radius;
      }
    }
    return best;
  }

  /** Body with the smallest distance/radius ratio from a system point. */
  nearestBody(pSys: THREE.Vector3): { body: BodyState; distance: number; altitude: number } | null {
    let best: BodyState | null = null;
    let bestScore = Infinity;
    for (const b of this.bodies) {
      const d = b.pos.distanceTo(pSys);
      const score = (d - b.radius) / b.radius;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (!best) return null;
    const d = best.pos.distanceTo(pSys);
    return { body: best, distance: d, altitude: d - best.radius };
  }
}

function depth(b: BodyState): number {
  let d = 0;
  let p = b.parent;
  while (p) { d++; p = p.parent; }
  return d;
}

import * as THREE from 'three';
import { ShipModel } from './ShipModel';
import { Inventory } from '../items/Inventory';

/**
 * Ship state and flight model: 6-DOF rigid body with simplified aerodynamics,
 * planetary gravity, flight assist (hover / drift cancellation / auto-level),
 * cruise drive and heat from atmospheric entry. Positions/velocities are in
 * the active reference frame.
 */

export interface ShipControls {
  pitch: number;
  yaw: number;
  roll: number;
  forward: number;
  strafe: number;
  lift: number;
  boost: boolean;
  brake: boolean;
}

export interface ShipEnv {
  /** gravity acceleration vector (frame) */
  gravity: THREE.Vector3;
  /** local up (frame), zero in deep space */
  up: THREE.Vector3;
  /** atmospheric density 0..~1.5 relative */
  density: number;
  /** altitude above terrain (m) */
  altitude: number;
  /** distance to nearest body surface (m) */
  surfaceDistance: number;
}

export class Ship {
  readonly model = new ShipModel();
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  angVel = new THREE.Vector3();
  // systems
  hull = 100;
  fuel = 100;
  powerOnline = true;
  thrustersOnline = true;
  engineOn = false;
  warpCore = false;
  hullTemp = 20;
  o2Reserve = 800;
  energyReserve = 1000;
  assist = true;
  gearDown = true;
  gearT = 1;
  landed = true;
  throttleVis = 0;
  cruise = false;
  cruiseCharge = 0;
  cruiseSpeed = 0;
  heat = 0;
  readonly cargo = new Inventory(16);
  name = 'Arandu';
  /** visual damage smoke while not repaired */
  get damaged(): boolean {
    return !this.powerOnline || !this.thrustersOnline || this.hull < 50;
  }
  get canFly(): boolean {
    return this.powerOnline && this.thrustersOnline && this.hull > 20 && this.fuel > 0;
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }
  upVec(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.quat);
  }
  right(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(1, 0, 0).applyQuaternion(this.quat);
  }

  localToFrame(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(v).applyQuaternion(this.quat).add(this.pos);
  }

  update(dt: number, c: ShipControls, env: ShipEnv): { thrust: number; accel: THREE.Vector3 } {
    const accel = new THREE.Vector3();
    const flying = this.engineOn && this.canFly;
    const hasGrav = env.gravity.lengthSq() > 1e-6;

    // ---------------------------------------------------------- rotation
    const maxRate = new THREE.Vector3(1.25, 0.95, 2.1);
    const target = flying ? new THREE.Vector3(c.pitch * maxRate.x, c.yaw * maxRate.y, c.roll * maxRate.z) : new THREE.Vector3();
    const angAcc = 5;
    for (const k of ['x', 'y', 'z'] as const) {
      const d = target[k] - this.angVel[k];
      const step = Math.sign(d) * Math.min(Math.abs(d), angAcc * dt);
      this.angVel[k] += step;
    }
    // auto-level near ground when assist is on and no roll/pitch input
    if (flying && this.assist && hasGrav && env.altitude < 400 && Math.abs(c.roll) < 0.05) {
      const upL = env.up.clone().applyQuaternion(this.quat.clone().invert());
      // roll toward upright, gentle pitch toward horizon when low & slow
      this.angVel.z += -upL.x * 2.2 * dt * 3;
      if (env.altitude < 60 && Math.abs(c.pitch) < 0.05) this.angVel.x += upL.z * 2.0 * dt * 2;
    }
    if (!this.landed || flying) {
      const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'YXZ'));
      this.quat.multiply(dq).normalize();
    } else this.angVel.set(0, 0, 0);

    // ---------------------------------------------------------- thrust
    let thrust = 0;
    if (flying) {
      const fwd = c.forward > 0 ? c.forward * (c.boost ? 55 : 28) : c.forward * 18;
      const local = new THREE.Vector3(c.strafe * 14, c.lift * 15, -fwd);
      accel.add(local.applyQuaternion(this.quat));
      thrust = Math.min(1, Math.abs(c.forward) * (c.boost ? 1 : 0.6) + Math.abs(c.lift) * 0.4 + Math.abs(c.strafe) * 0.3);
      if (this.assist) {
        // hover: cancel gravity
        if (hasGrav) { accel.sub(env.gravity); thrust = Math.max(thrust, 0.25); }
        // damp velocity along axes without input
        const vl = this.vel.clone().applyQuaternion(this.quat.clone().invert());
        const damp = new THREE.Vector3(
          Math.abs(c.strafe) < 0.05 ? -vl.x * 1.6 : 0,
          Math.abs(c.lift) < 0.05 ? -vl.y * 1.6 : 0,
          Math.abs(c.forward) < 0.05 && !this.cruise ? -vl.z * (c.brake ? 2.5 : 0.35) : 0,
        );
        accel.add(damp.applyQuaternion(this.quat));
      }
      if (c.brake) accel.addScaledVector(this.vel, -1.8);
      this.fuel = Math.max(0, this.fuel - (0.012 + thrust * 0.05) * dt);
    }
    if (!this.landed) accel.add(env.gravity);

    // ---------------------------------------------------------- aerodynamics & heat
    const speed = this.vel.length();
    if (env.density > 0 && speed > 0.01) {
      const dragK = 0.0009 * env.density;
      accel.addScaledVector(this.vel, -dragK * speed);
      // atmospheric lift keeps winged flight stable
      const heatGain = Math.max(0, speed - 230) ** 2 * env.density * 0.0009;
      this.hullTemp += (heatGain - (this.hullTemp - 20) * 0.08) * dt;
    } else {
      this.hullTemp += (20 - this.hullTemp) * 0.05 * dt;
    }
    this.heat = Math.min(1, Math.max(0, (this.hullTemp - 300) / 900));
    if (this.hullTemp > 1300) this.hull = Math.max(0, this.hull - (this.hullTemp - 1300) * 0.002 * dt);

    // ---------------------------------------------------------- cruise drive
    if (this.cruise) {
      const fwd = this.forward();
      const limit = Math.max(500, Math.min(250000, env.surfaceDistance * 0.45));
      this.cruiseCharge = Math.min(1, this.cruiseCharge + dt * 0.6);
      this.cruiseSpeed += (limit * this.cruiseCharge - this.cruiseSpeed) * Math.min(1, dt * 0.9);
      this.vel.copy(fwd).multiplyScalar(this.cruiseSpeed);
      accel.set(0, 0, 0);
      this.fuel = Math.max(0, this.fuel - 0.02 * dt);
      thrust = 1;
    } else {
      this.cruiseCharge = 0;
      this.cruiseSpeed = 0;
      this.vel.addScaledVector(accel, dt);
      const maxV = env.density > 0.05 ? 650 : 2000;
      if (this.vel.length() > maxV) this.vel.setLength(maxV);
    }
    if (!this.landed) this.pos.addScaledVector(this.vel, dt);
    else if (!this.cruise) this.vel.set(0, 0, 0);

    this.throttleVis += ((flying ? thrust : 0) - this.throttleVis) * Math.min(1, dt * 6);
    const gearTarget = this.gearDown ? 1 : 0;
    this.gearT += Math.sign(gearTarget - this.gearT) * Math.min(Math.abs(gearTarget - this.gearT), dt * 0.8);
    return { thrust, accel };
  }

  serialize(): Record<string, unknown> {
    return {
      pos: this.pos.toArray(), vel: this.vel.toArray(), quat: this.quat.toArray(), hull: this.hull, fuel: this.fuel,
      powerOnline: this.powerOnline, thrustersOnline: this.thrustersOnline, warpCore: this.warpCore, o2Reserve: this.o2Reserve,
      energyReserve: this.energyReserve, landed: this.landed, gearDown: this.gearDown, cargo: this.cargo.serialize(), name: this.name,
    };
  }

  load(d: Record<string, unknown>): void {
    this.pos.fromArray(d.pos as number[]);
    this.vel.fromArray(d.vel as number[]);
    this.quat.fromArray(d.quat as number[]);
    this.hull = d.hull as number;
    this.fuel = d.fuel as number;
    this.powerOnline = d.powerOnline as boolean;
    this.thrustersOnline = d.thrustersOnline as boolean;
    this.warpCore = d.warpCore as boolean;
    this.o2Reserve = d.o2Reserve as number;
    this.energyReserve = d.energyReserve as number;
    this.landed = d.landed as boolean;
    this.gearDown = d.gearDown as boolean;
    this.gearT = this.gearDown ? 1 : 0;
    if (d.cargo) this.cargo.load(d.cargo as never);
    if (d.name) this.name = d.name as string;
  }
}

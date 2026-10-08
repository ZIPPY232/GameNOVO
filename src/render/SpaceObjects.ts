import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Rng } from '../core/rng';

/**
 * Orbital structures and small bodies: a derelict research station that can
 * be docked with, and asteroid belts rendered with instancing.
 */

export class StationModel {
  readonly group = new THREE.Group();
  private ring: THREE.Group;
  private lights: THREE.MeshStandardMaterial;
  /** dock point in local coordinates (ship stops here) */
  static readonly DOCK = new THREE.Vector3(0, 0, -34);

  constructor() {
    const hull = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.55, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.45, metalness: 0.5 });
    const panel = new THREE.MeshStandardMaterial({ color: 0x0d1a33, roughness: 0.2, metalness: 0.8, emissive: 0x020612 });
    this.lights = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.75, 0.4), emissiveIntensity: 40 });
    const green = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.3, 1, 0.5), emissiveIntensity: 60 });
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    // central spine and core
    add(new THREE.CylinderGeometry(4, 4, 60, 24).rotateX(Math.PI / 2), hull, 0, 0, 0);
    add(new RoundedBoxGeometry(14, 14, 14, 3, 2), hull, 0, 0, 6);
    add(new THREE.CylinderGeometry(6, 6, 3, 24).rotateX(Math.PI / 2), dark, 0, 0, -26);
    // docking collar with guidance lights
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(new THREE.SphereGeometry(0.35, 8, 6), green, Math.cos(a) * 6.5, Math.sin(a) * 6.5, -27.6);
    }
    // habitat ring
    this.ring = new THREE.Group();
    this.group.add(this.ring);
    add(new THREE.TorusGeometry(30, 3.2, 12, 64), hull, 0, 0, 6, this.ring);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const spoke = add(new THREE.CylinderGeometry(1.2, 1.2, 26, 10), dark, Math.cos(a) * 15, Math.sin(a) * 15, 6, this.ring);
      spoke.rotation.z = a + Math.PI / 2;
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      add(new THREE.BoxGeometry(1.2, 0.5, 0.5), this.lights, Math.cos(a) * 33.3, Math.sin(a) * 33.3, 6, this.ring);
    }
    // solar wings
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(1, 1, 20), dark, s * 12, 0, 22);
      const w = add(new THREE.BoxGeometry(34, 0.3, 16), panel, s * 30, 0, 22);
      w.castShadow = true;
    }
    this.group.name = 'station';
  }

  update(t: number): void {
    this.ring.rotation.z = t * 0.05;
    this.lights.emissiveIntensity = 30 + Math.sin(t * 1.3) * 8;
  }
}

/** Instanced asteroid belt around the star (system-frame positions). */
export class AsteroidBelt {
  readonly group = new THREE.Group();
  readonly radius: number;
  readonly width: number;
  private mesh: THREE.InstancedMesh;
  private spin = new THREE.Group();

  constructor(seed: number, radius: number, width: number, count = 2600) {
    this.radius = radius;
    this.width = width;
    const rng = new Rng(seed);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    // lumpy rocks: displace vertices once
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      v.multiplyScalar(0.75 + Math.abs(Math.sin(v.x * 3.1 + v.y * 5.7 + v.z * 2.3)) * 0.45);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 0.95, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = radius + rng.gaussian() * width * 0.35;
      const y = rng.gaussian() * width * 0.05;
      const s = 20 + Math.pow(rng.next(), 4) * 900;
      q.setFromEuler(new THREE.Euler(rng.next() * 6, rng.next() * 6, rng.next() * 6));
      m.compose(new THREE.Vector3(Math.cos(a) * r, y, -Math.sin(a) * r), q, new THREE.Vector3(s, s * rng.range(0.6, 1), s * rng.range(0.6, 1)));
      this.mesh.setMatrixAt(i, m);
      const k = rng.range(0.6, 1.1);
      this.mesh.setColorAt(i, c.setRGB(0.55 * k, 0.5 * k, 0.45 * k));
    }
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.spin.add(this.mesh);
    this.group.add(this.spin);
    this.group.name = 'asteroids';
  }

  update(t: number): void {
    this.spin.rotation.y = t * 2e-5;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

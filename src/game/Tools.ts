import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ToolId } from '../items/items';

/** Hand-held tool models shared by the third-person rig and first-person view model. */

const rb = (w: number, h: number, d: number, r = 0.01) => new RoundedBoxGeometry(w, h, d, 2, r);
let mats: Record<string, THREE.MeshStandardMaterial> | null = null;
function M(): Record<string, THREE.MeshStandardMaterial> {
  if (!mats) {
    mats = {
      body: new THREE.MeshStandardMaterial({ color: 0xdedfe2, roughness: 0.45, metalness: 0.4 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.4, metalness: 0.7 }),
      orange: new THREE.MeshStandardMaterial({ color: 0xea7a2c, roughness: 0.5 }),
      cyan: new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.35, 0.9, 1), emissiveIntensity: 25 }),
      green: new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.4, 1, 0.6), emissiveIntensity: 18 }),
      emit: new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.6, 0.25), emissiveIntensity: 30 }),
    };
  }
  return mats;
}

/** Tool model with its muzzle at local (0, 0, -len). Hand grip at origin. Forward = -Z. */
export function buildTool(id: ToolId | 'block' | 'none'): THREE.Group {
  const g = new THREE.Group();
  const m = M();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, mat);
    o.position.set(x, y, z);
    o.castShadow = true;
    g.add(o);
    return o;
  };
  switch (id) {
    case 'extractor': {
      // grip, capsule body with cooling coils, emitter bell and an energy cell on top
      const grip = add(rb(0.05, 0.13, 0.055, 0.02), m.dark, 0, -0.06, 0.02);
      grip.rotation.x = -0.25;
      add(new THREE.CapsuleGeometry(0.045, 0.24, 6, 16).rotateX(Math.PI / 2), m.body, 0, 0.03, -0.11);
      for (let i = 0; i < 3; i++) add(new THREE.TorusGeometry(0.047, 0.008, 8, 20), m.orange, 0, 0.03, -0.17 - i * 0.03);
      add(new THREE.CylinderGeometry(0.028, 0.048, 0.07, 16).rotateX(Math.PI / 2), m.dark, 0, 0.03, -0.3);
      add(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 12).rotateX(Math.PI / 2), m.emit, 0, 0.03, -0.34).name = 'muzzle';
      add(new THREE.CapsuleGeometry(0.018, 0.08, 4, 10).rotateX(Math.PI / 2), m.cyan, 0, 0.085, -0.06);
      add(rb(0.03, 0.025, 0.12, 0.01), m.dark, 0, 0.07, -0.06);
      break;
    }
    case 'scanner': {
      const grip = add(rb(0.05, 0.12, 0.05, 0.02), m.dark, 0, -0.05, 0.02);
      grip.rotation.x = -0.2;
      add(rb(0.17, 0.11, 0.05, 0.025), m.body, 0, 0.05, -0.08);
      add(new THREE.PlaneGeometry(0.12, 0.075), m.green, 0, 0.055, -0.052).rotation.y = Math.PI;
      add(new THREE.TorusGeometry(0.03, 0.008, 8, 20), m.orange, 0, 0.05, -0.115);
      add(new THREE.CylinderGeometry(0.026, 0.03, 0.05, 16).rotateX(Math.PI / 2), m.dark, 0, 0.05, -0.13);
      add(new THREE.SphereGeometry(0.02, 12, 10), m.cyan, 0, 0.05, -0.16).name = 'muzzle';
      break;
    }
    case 'builder': {
      const grip = add(rb(0.05, 0.12, 0.05, 0.02), m.dark, 0, -0.05, 0.02);
      grip.rotation.x = -0.2;
      add(new THREE.CapsuleGeometry(0.04, 0.18, 6, 14).rotateX(Math.PI / 2), m.body, 0, 0.03, -0.1);
      add(rb(0.11, 0.02, 0.12, 0.008), m.orange, 0, 0.07, -0.08);
      add(new THREE.ConeGeometry(0.035, 0.08, 16).rotateX(-Math.PI / 2), m.dark, 0, 0.03, -0.24);
      add(new THREE.SphereGeometry(0.015, 10, 8), m.cyan, 0, 0.03, -0.29).name = 'muzzle';
      break;
    }
    default:
      break;
  }
  return g;
}

export function toolMuzzle(g: THREE.Group, out: THREE.Vector3): THREE.Vector3 {
  const m = g.getObjectByName('muzzle');
  if (m) return m.getWorldPosition(out);
  return g.getWorldPosition(out);
}

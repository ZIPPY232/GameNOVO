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
    case 'extractor':
      add(rb(0.07, 0.12, 0.06), m.dark, 0, -0.05, 0.02);
      add(rb(0.09, 0.09, 0.32), m.body, 0, 0.03, -0.12);
      add(rb(0.095, 0.03, 0.2), m.orange, 0, 0.085, -0.1);
      add(new THREE.CylinderGeometry(0.03, 0.04, 0.1, 10).rotateX(Math.PI / 2), m.dark, 0, 0.03, -0.32);
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 10).rotateX(Math.PI / 2), m.emit, 0, 0.03, -0.375).name = 'muzzle';
      add(rb(0.05, 0.05, 0.12), m.dark, 0, -0.03, -0.18);
      add(rb(0.02, 0.03, 0.06), m.cyan, 0.05, 0.05, -0.05);
      break;
    case 'scanner':
      add(rb(0.06, 0.12, 0.05), m.dark, 0, -0.05, 0.02);
      add(rb(0.16, 0.11, 0.05), m.body, 0, 0.05, -0.08);
      add(new THREE.PlaneGeometry(0.12, 0.075), m.green, 0, 0.055, -0.052).rotation.y = Math.PI;
      add(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 12).rotateX(Math.PI / 2), m.dark, 0, 0.05, -0.13);
      add(new THREE.SphereGeometry(0.02, 10, 8), m.cyan, 0, 0.05, -0.16).name = 'muzzle';
      break;
    case 'builder':
      add(rb(0.06, 0.12, 0.05), m.dark, 0, -0.05, 0.02);
      add(rb(0.1, 0.07, 0.24), m.body, 0, 0.03, -0.1);
      add(rb(0.12, 0.02, 0.12), m.orange, 0, 0.075, -0.06);
      add(new THREE.ConeGeometry(0.04, 0.08, 4).rotateX(-Math.PI / 2), m.dark, 0, 0.03, -0.25);
      add(new THREE.SphereGeometry(0.015, 8, 6), m.cyan, 0, 0.03, -0.3).name = 'muzzle';
      break;
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

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { B, BLOCK_SOLID } from '../voxel/blocks';
import type { VoxelWorld } from '../voxel/VoxelWorld';
import type { MachineType } from '../items/items';
import type { VoxelPhysics } from '../physics/VoxelPhysics';
import { Inventory } from '../items/Inventory';

/**
 * Base machines placed on the voxel grid. Each machine occupies voxel cells
 * (B.MACHINE so collisions and building work) and has a real function:
 *   solar -> produces power from starlight (day/night, atmosphere, weather)
 *   battery -> stores power
 *   oxygen -> pressurises an enclosed habitat (flood-fill) and refills suits
 *   recharger -> refills suit energy (+O2 when the grid has an O2 generator)
 *   fabricator -> unlocks advanced recipes
 *   storage, floodlight, door, beacon
 * Machines within LINK_RANGE metres form one power grid.
 */

export const LINK_RANGE = 40;

export interface MachineData {
  id: number;
  type: MachineType;
  bodyId: string;
  face: number;
  I: number;
  J: number;
  K: number;
  rot: number;
  stored: number;
  open: boolean;
  items: ({ id: string; count: number } | null)[] | null;
  label: string;
}

export interface Machine extends MachineData {
  mesh: THREE.Group;
  powered: boolean;
  grid: number;
  inv: Inventory | null;
  light: THREE.Object3D | null;
  anim: number;
}

const cache = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = cache.get(key);
  if (!m) { m = make(); cache.set(key, m); }
  return m;
}
const M = {
  body: () => mat('body', () => new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.55, metalness: 0.45 })),
  dark: () => mat('dark', () => new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.45, metalness: 0.7 })),
  accent: () => mat('accent', () => new THREE.MeshStandardMaterial({ color: 0xea7a2c, roughness: 0.5 })),
  solar: () => mat('solar', () => new THREE.MeshStandardMaterial({ color: 0x0d1830, roughness: 0.15, metalness: 0.9, emissive: 0x050a20, envMapIntensity: 1.5 })),
  glowC: () => mat('glowC', () => new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.3, 0.9, 1), emissiveIntensity: 20 })),
  glowG: () => mat('glowG', () => new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.3, 1, 0.4), emissiveIntensity: 20 })),
  glowR: () => mat('glowR', () => new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.15, 0.1), emissiveIntensity: 30 })),
  lamp: () => mat('lamp', () => new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.93, 0.8), emissiveIntensity: 60 })),
  glass: () => mat('glass', () => new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35 })),
  crate: () => mat('crate', () => new THREE.MeshStandardMaterial({ color: 0x7a6a55, roughness: 0.7, metalness: 0.2 })),
};

function rb(w: number, h: number, d: number, r = 0.04): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, 2, r);
}

/** Build a model in a local frame where +Y is up, the cell spans x,z in [-0.5,0.5], y in [0,1]. */
export function buildMachineModel(type: MachineType): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    o.receiveShadow = true;
    g.add(o);
    return o;
  };
  switch (type) {
    case 'fabricator':
      add(rb(0.95, 0.55, 0.8), M.body(), 0, 0.28, 0);
      add(rb(0.9, 0.05, 0.7), M.dark(), 0, 0.58, 0);
      add(rb(0.12, 0.6, 0.12), M.dark(), -0.35, 0.85, -0.25);
      add(rb(0.5, 0.08, 0.1), M.dark(), -0.12, 1.12, -0.25).rotation.z = -0.2;
      add(rb(0.08, 0.2, 0.08), M.accent(), 0.12, 1.0, -0.25);
      add(rb(0.4, 0.28, 0.04), M.glowC(), 0.25, 0.85, -0.32).rotation.x = -0.3;
      add(rb(0.96, 0.04, 0.82), M.accent(), 0, 0.1, 0);
      break;
    case 'solar': {
      add(rb(0.12, 0.7, 0.12), M.dark(), 0, 0.35, 0);
      add(rb(0.4, 0.08, 0.4), M.body(), 0, 0.05, 0);
      const p = add(rb(1.4, 0.05, 1.0, 0.02), M.solar(), 0, 0.78, 0);
      p.rotation.x = -0.45;
      p.name = 'panel';
      add(rb(1.42, 0.03, 0.04), M.body(), 0, 0.8, 0.45).rotation.x = -0.45;
      break;
    }
    case 'battery':
      add(rb(0.8, 0.9, 0.6), M.body(), 0, 0.45, 0);
      for (let i = 0; i < 4; i++) add(rb(0.12, 0.6, 0.04), M.dark(), -0.27 + i * 0.18, 0.5, 0.3);
      add(rb(0.6, 0.06, 0.03), M.glowG(), 0, 0.85, 0.31).name = 'level';
      add(rb(0.82, 0.04, 0.62), M.accent(), 0, 0.08, 0);
      break;
    case 'oxygen':
      add(rb(0.85, 0.25, 0.6), M.dark(), 0, 0.12, 0);
      for (const x of [-0.22, 0.22]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.8, 18), M.body());
        c.position.set(x, 0.62, 0);
        c.castShadow = true;
        g.add(c);
        add(rb(0.36, 0.04, 0.36), M.accent(), x, 0.95, 0);
      }
      add(rb(0.2, 0.08, 0.04), M.glowC(), 0, 0.2, 0.31);
      {
        const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 6), M.dark());
        fan.position.set(0, 0.26, 0);
        fan.name = 'fan';
        g.add(fan);
      }
      break;
    case 'recharger':
      add(rb(0.45, 1.6, 0.35), M.body(), 0, 0.8, 0);
      add(rb(0.35, 0.5, 0.05), M.glowC(), 0, 1.15, 0.18);
      add(rb(0.47, 0.06, 0.37), M.accent(), 0, 0.5, 0);
      add(rb(0.6, 0.1, 0.5), M.dark(), 0, 0.05, 0);
      break;
    case 'storage':
      add(rb(0.95, 0.75, 0.75), M.crate(), 0, 0.375, 0);
      add(rb(0.97, 0.08, 0.77), M.dark(), 0, 0.72, 0);
      add(rb(0.97, 0.08, 0.77), M.dark(), 0, 0.06, 0);
      add(rb(0.2, 0.06, 0.02), M.accent(), 0, 0.5, 0.38);
      break;
    case 'floodlight':
      add(rb(0.08, 1.8, 0.08), M.dark(), 0, 0.9, 0);
      add(rb(0.35, 0.06, 0.35), M.body(), 0, 0.03, 0);
      add(rb(0.45, 0.22, 0.22), M.body(), 0, 1.85, 0.05);
      add(rb(0.38, 0.15, 0.02), M.lamp(), 0, 1.84, 0.17).name = 'lamp';
      break;
    case 'door': {
      add(rb(0.12, 2.0, 0.3), M.dark(), -0.44, 1.0, 0);
      add(rb(0.12, 2.0, 0.3), M.dark(), 0.44, 1.0, 0);
      add(rb(1.0, 0.12, 0.3), M.dark(), 0, 1.94, 0);
      const panel = add(rb(0.78, 1.86, 0.1), M.body(), 0, 0.95, 0);
      panel.name = 'panel';
      add(rb(0.05, 0.05, 0.02), M.glowG(), 0.32, 1.2, 0.17).name = 'status';
      break;
    }
    case 'beacon':
      add(rb(0.06, 1.5, 0.06), M.dark(), 0, 0.75, 0);
      add(rb(0.3, 0.06, 0.3), M.body(), 0, 0.03, 0);
      add(new THREE.SphereGeometry(0.1, 12, 8), M.glowR(), 0, 1.55, 0).name = 'blink';
      break;
  }
  return g;
}

/** Cells occupied (offsets in K) */
export function machineHeight(type: MachineType): number {
  return type === 'door' || type === 'recharger' || type === 'floodlight' ? 2 : 1;
}

export class MachineSystem {
  machines: Machine[] = [];
  private nextId = 1;
  readonly group = new THREE.Group();
  private world: VoxelWorld | null = null;
  private phys: VoxelPhysics | null = null;
  bodyId = '';
  gridStored = new Map<number, number>();
  gridCapacity = new Map<number, number>();
  gridProduction = new Map<number, number>();
  gridHasO2 = new Map<number, boolean>();
  private gridDirty = true;
  pressurizedCache: { time: number; result: boolean; cell: string } = { time: -1, result: false, cell: '' };
  private all: MachineData[] = [];

  /** All machines across bodies (persisted). */
  get allData(): MachineData[] {
    this.syncData();
    return this.all;
  }

  load(all: MachineData[]): void {
    this.all = all.map((m) => ({ ...m }));
    this.nextId = Math.max(1, ...this.all.map((m) => m.id + 1));
  }

  private syncData(): void {
    for (const m of this.machines) {
      const d = this.all.find((x) => x.id === m.id);
      if (d) {
        d.stored = m.stored;
        d.open = m.open;
        d.items = m.inv ? m.inv.serialize() : null;
        d.label = m.label;
      }
    }
  }

  /** Attach to the planet the player is on: instantiate its machines. */
  attach(world: VoxelWorld | null, phys: VoxelPhysics | null): void {
    this.syncData();
    for (const m of this.machines) this.group.remove(m.mesh);
    this.machines = [];
    this.world = world;
    this.phys = phys;
    this.bodyId = world?.bodyId ?? '';
    if (!world || !phys) return;
    for (const d of this.all) if (d.bodyId === world.bodyId) this.instantiate(d);
    this.gridDirty = true;
  }

  private instantiate(d: MachineData): Machine {
    const mesh = buildMachineModel(d.type);
    const m: Machine = { ...d, mesh, powered: false, grid: 0, inv: null, light: null, anim: 0 };
    if (d.type === 'storage') {
      m.inv = new Inventory(24);
      if (d.items) m.inv.load(d.items);
    }
    this.placeMesh(m);
    this.group.add(mesh);
    this.machines.push(m);
    return m;
  }

  /** Orientation: +Y radial, facing along a grid axis chosen by rot. */
  frameAt(face: number, I: number, J: number, K: number, rot: number, out: THREE.Matrix4): void {
    const phys = this.phys!;
    const base = phys.cellCenter(face, I, J, K);
    const up = base.clone().normalize();
    base.addScaledVector(up, -0.5);
    const g = { face, x: I + 0.5, y: J + 0.5, z: K };
    phys.basis(g);
    const axes = [phys.gridAxisWorld(1).clone(), phys.gridAxisWorld(0).clone(), phys.gridAxisWorld(1).clone().negate(), phys.gridAxisWorld(0).clone().negate()];
    const fwd = axes[((rot % 4) + 4) % 4].projectOnPlane(up).normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const f2 = new THREE.Vector3().crossVectors(right, up).normalize();
    // model +Z faces `fwd`, +Y is local up
    out.makeBasis(right, up, f2).setPosition(base);
  }

  private placeMesh(m: Machine): void {
    const mx = new THREE.Matrix4();
    this.frameAt(m.face, m.I, m.J, m.K, m.rot, mx);
    m.mesh.matrixAutoUpdate = false;
    m.mesh.matrix.copy(mx);
    m.mesh.matrixWorldNeedsUpdate = true;
  }

  canPlace(type: MachineType, face: number, I: number, J: number, K: number): boolean {
    const w = this.world;
    if (!w) return false;
    const h = machineHeight(type);
    for (let k = 0; k < h; k++) if (w.getBlock(face, I, J, K + k) !== B.AIR) return false;
    if (BLOCK_SOLID[w.getBlock(face, I, J, K - 1)] !== 1) return false;
    return true;
  }

  place(type: MachineType, face: number, I: number, J: number, K: number, rot: number): Machine | null {
    if (!this.world || !this.canPlace(type, face, I, J, K)) return null;
    const d: MachineData = { id: this.nextId++, type, bodyId: this.world.bodyId, face, I, J, K, rot, stored: 0, open: false, items: null, label: type === 'beacon' ? `Baliza ${this.nextId - 1}` : '' };
    this.all.push(d);
    const m = this.instantiate(d);
    const h = machineHeight(type);
    for (let k = 0; k < h; k++) this.world.setBlock(face, I, J, K + k, B.MACHINE);
    this.gridDirty = true;
    this.pressurizedCache.time = -1;
    return m;
  }

  remove(m: Machine): void {
    if (!this.world) return;
    const h = machineHeight(m.type);
    for (let k = 0; k < h; k++) this.world.setBlock(m.face, m.I, m.J, m.K + k, B.AIR);
    this.group.remove(m.mesh);
    this.machines = this.machines.filter((x) => x !== m);
    this.all = this.all.filter((x) => x.id !== m.id);
    this.gridDirty = true;
    this.pressurizedCache.time = -1;
  }

  at(face: number, I: number, J: number, K: number): Machine | null {
    for (const m of this.machines) {
      if (m.face !== face || m.I !== I || m.J !== J) continue;
      if (K >= m.K && K < m.K + machineHeight(m.type)) return m;
    }
    return null;
  }

  toggleDoor(m: Machine): void {
    if (!this.world || m.type !== 'door') return;
    m.open = !m.open;
    for (let k = 0; k < 2; k++) this.world.setBlock(m.face, m.I, m.J, m.K + k, m.open ? B.MACHINE_OPEN : B.MACHINE);
    this.pressurizedCache.time = -1;
  }

  worldPos(m: Machine, out = new THREE.Vector3()): THREE.Vector3 {
    return this.phys!.cellCenter(m.face, m.I, m.J, m.K, out);
  }

  private rebuildGrids(): void {
    const n = this.machines.length;
    const parent = this.machines.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const pos = this.machines.map((m) => this.worldPos(m));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (pos[i].distanceTo(pos[j]) < LINK_RANGE) parent[find(i)] = find(j);
    }
    const oldStored = new Map<number, number>();
    for (const m of this.machines) if (m.type === 'battery') oldStored.set(m.id, m.stored);
    this.machines.forEach((m, i) => (m.grid = find(i)));
    this.gridDirty = false;
  }

  /**
   * Power simulation. `sunlightAt` returns 0..1 irradiance factor at a planet-local position.
   * `demand` reports extra consumption per grid (e.g. recharging the player).
   */
  simulate(dt: number, sunlightAt: (p: THREE.Vector3) => number, isNight: boolean, playerPos: THREE.Vector3 | null, time: number, extraDemand: Map<number, number>): void {
    if (this.gridDirty) this.rebuildGrids();
    const prod = new Map<number, number>(), cons = new Map<number, number>(), cap = new Map<number, number>(), stored = new Map<number, number>(), o2 = new Map<number, boolean>();
    for (const m of this.machines) {
      const g = m.grid;
      if (m.type === 'solar') prod.set(g, (prod.get(g) ?? 0) + 3.2 * sunlightAt(this.worldPos(m)));
      if (m.type === 'battery') { cap.set(g, (cap.get(g) ?? 0) + 400); stored.set(g, (stored.get(g) ?? 0) + m.stored); }
      if (m.type === 'oxygen') { cons.set(g, (cons.get(g) ?? 0) + 0.8); o2.set(g, true); }
      if (m.type === 'floodlight' && isNight) cons.set(g, (cons.get(g) ?? 0) + 0.25);
      if (m.type === 'fabricator') cons.set(g, (cons.get(g) ?? 0) + 0.1);
    }
    for (const [g, v] of extraDemand) cons.set(g, (cons.get(g) ?? 0) + v);
    for (const g of new Set(this.machines.map((m) => m.grid))) {
      const p = prod.get(g) ?? 0, c = cons.get(g) ?? 0, capacity = cap.get(g) ?? 0;
      let s = stored.get(g) ?? 0;
      const net = (p - c) * dt;
      let powered = true;
      if (net >= 0) s = Math.min(capacity, s + net);
      else if (s + net >= 0) s += net;
      else { s = 0; powered = p > 0 && p >= c * 0.999; }
      // distribute stored energy back to batteries
      const bats = this.machines.filter((m) => m.grid === g && m.type === 'battery');
      for (const b of bats) b.stored = bats.length ? s / bats.length : 0;
      for (const m of this.machines) if (m.grid === g) m.powered = powered && (p > 0 || s > 0);
      this.gridStored.set(g, s);
      this.gridCapacity.set(g, capacity);
      this.gridProduction.set(g, p - c);
      this.gridHasO2.set(g, o2.get(g) ?? false);
    }
    // visuals
    for (const m of this.machines) {
      m.anim += dt;
      if (m.type === 'oxygen') {
        const fan = m.mesh.getObjectByName('fan');
        if (fan && m.powered) fan.rotation.y += dt * 12;
      }
      if (m.type === 'beacon') {
        const b = m.mesh.getObjectByName('blink');
        if (b) b.visible = (time % 1.2) < 0.25;
      }
      if (m.type === 'door') {
        const p = m.mesh.getObjectByName('panel');
        if (p) p.position.x += ((m.open ? 0.82 : 0) - p.position.x) * Math.min(1, dt * 8);
      }
      if (m.type === 'floodlight') {
        const l = m.mesh.getObjectByName('lamp');
        if (l) l.visible = m.powered && isNight;
      }
      if (m.type === 'battery') {
        const l = m.mesh.getObjectByName('level');
        if (l) l.scale.x = Math.max(0.02, m.stored / 400);
      }
    }
    void playerPos;
  }

  gridOf(m: Machine): { stored: number; capacity: number; net: number; o2: boolean } {
    return {
      stored: this.gridStored.get(m.grid) ?? 0,
      capacity: this.gridCapacity.get(m.grid) ?? 0,
      net: this.gridProduction.get(m.grid) ?? 0,
      o2: this.gridHasO2.get(m.grid) ?? false,
    };
  }

  /** Draw energy from a machine's grid; returns amount obtained. */
  draw(m: Machine, amount: number): number {
    const bats = this.machines.filter((x) => x.grid === m.grid && x.type === 'battery');
    const prod = Math.max(0, this.gridProduction.get(m.grid) ?? 0);
    let got = Math.min(amount, prod * 0.5);
    let need = amount - got;
    for (const b of bats) {
      const k = Math.min(need, b.stored);
      b.stored -= k;
      need -= k;
      got += k;
    }
    return got;
  }

  nearest(pos: THREE.Vector3, type: MachineType | null, maxDist: number): Machine | null {
    let best: Machine | null = null, bd = maxDist;
    for (const m of this.machines) {
      if (type && m.type !== type) continue;
      const d = this.worldPos(m).distanceTo(pos);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  /**
   * Habitat check: flood-fill passable cells from the given cell. Enclosed if the
   * fill stays bounded and touches a powered O2 generator.
   */
  isPressurized(face: number, I: number, J: number, K: number, time: number): boolean {
    const key = `${face},${I},${J},${K}`;
    if (this.pressurizedCache.cell === key && time - this.pressurizedCache.time < 1.0) return this.pressurizedCache.result;
    let result = false;
    const w = this.world;
    if (w && this.machines.some((m) => m.type === 'oxygen' && m.powered)) {
      const LIMIT = 900;
      const seen = new Set<string>();
      const stack: [number, number, number][] = [[I, J, K]];
      let open = false, o2 = false;
      while (stack.length && !open) {
        const [i, j, k] = stack.pop()!;
        const kk = `${i},${j},${k}`;
        if (seen.has(kk)) continue;
        seen.add(kk);
        if (seen.size > LIMIT) { open = true; break; }
        const b = w.getBlock(face, i, j, k);
        if (b === B.MACHINE) {
          const m = this.at(face, i, j, k);
          if (m && m.type === 'oxygen' && m.powered) o2 = true;
          continue;
        }
        if (BLOCK_SOLID[b] === 1) continue;
        if (b === B.UNKNOWN) { open = true; break; }
        stack.push([i + 1, j, k], [i - 1, j, k], [i, j + 1, k], [i, j - 1, k], [i, j, k + 1], [i, j, k - 1]);
      }
      result = !open && o2;
    }
    this.pressurizedCache = { time, result, cell: key };
    return result;
  }
}

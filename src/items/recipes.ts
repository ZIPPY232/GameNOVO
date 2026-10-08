import type { Inventory } from './Inventory';

/**
 * Crafting recipes. `station` = where it can be crafted:
 *   suit       — the suit's portable micro-fabricator (always available)
 *   fabricator — requires standing near a placed Fabricator machine
 * A small tech tree: early suit recipes unlock the Fabricator, which unlocks
 * base machines, ship repairs, upgrades and the warp drive.
 */

export interface Recipe {
  id: string;
  out: string;
  count: number;
  inputs: [string, number][];
  station: 'suit' | 'fabricator';
  time: number;
  category: 'Componentes' | 'Consumíveis' | 'Construção' | 'Máquinas' | 'Melhorias' | 'Nave';
}

export const RECIPES: Recipe[] = [
  // components
  { id: 'plate', out: 'plate', count: 1, inputs: [['iron', 2]], station: 'suit', time: 1.2, category: 'Componentes' },
  { id: 'wiring', out: 'wiring', count: 2, inputs: [['copper', 1]], station: 'suit', time: 1.0, category: 'Componentes' },
  { id: 'circuit', out: 'circuit', count: 1, inputs: [['silicon', 1], ['copper', 1], ['wiring', 1]], station: 'fabricator', time: 2.0, category: 'Componentes' },
  // consumables
  { id: 'o2_canister', out: 'o2_canister', count: 1, inputs: [['ice', 2]], station: 'suit', time: 1.5, category: 'Consumíveis' },
  { id: 'battery', out: 'battery', count: 1, inputs: [['copper', 2], ['silicon', 1]], station: 'suit', time: 1.5, category: 'Consumíveis' },
  { id: 'suit_patch', out: 'suit_patch', count: 1, inputs: [['plate', 1], ['carbon', 1]], station: 'suit', time: 1.5, category: 'Consumíveis' },
  { id: 'medkit', out: 'medkit', count: 1, inputs: [['organics', 2], ['carbon', 1]], station: 'suit', time: 2.0, category: 'Consumíveis' },
  { id: 'ration', out: 'ration', count: 1, inputs: [['organics', 2]], station: 'suit', time: 1.2, category: 'Consumíveis' },
  { id: 'water', out: 'water', count: 1, inputs: [['ice', 1]], station: 'suit', time: 1.0, category: 'Consumíveis' },
  // building blocks
  { id: 'metal_block', out: 'metal_block', count: 4, inputs: [['plate', 1]], station: 'suit', time: 1.0, category: 'Construção' },
  { id: 'glass', out: 'glass', count: 4, inputs: [['silicon', 1], ['sand', 1]], station: 'suit', time: 1.0, category: 'Construção' },
  { id: 'concrete', out: 'concrete', count: 4, inputs: [['rock', 3]], station: 'suit', time: 1.0, category: 'Construção' },
  { id: 'floor', out: 'floor', count: 4, inputs: [['plate', 1], ['carbon', 1]], station: 'suit', time: 1.0, category: 'Construção' },
  { id: 'lamp', out: 'lamp', count: 2, inputs: [['silicon', 1], ['wiring', 1]], station: 'suit', time: 1.0, category: 'Construção' },
  { id: 'hull_block', out: 'hull_block', count: 4, inputs: [['plate', 2], ['titanium', 1]], station: 'fabricator', time: 2.0, category: 'Construção' },
  // machines
  { id: 'm_fabricator', out: 'm_fabricator', count: 1, inputs: [['plate', 4], ['wiring', 4], ['silicon', 2]], station: 'suit', time: 3.0, category: 'Máquinas' },
  { id: 'm_solar', out: 'm_solar', count: 1, inputs: [['plate', 2], ['silicon', 3], ['wiring', 2]], station: 'fabricator', time: 2.5, category: 'Máquinas' },
  { id: 'm_battery', out: 'm_battery', count: 1, inputs: [['plate', 2], ['copper', 4], ['wiring', 2]], station: 'fabricator', time: 2.5, category: 'Máquinas' },
  { id: 'm_oxygen', out: 'm_oxygen', count: 1, inputs: [['plate', 3], ['wiring', 3], ['circuit', 1]], station: 'fabricator', time: 3.0, category: 'Máquinas' },
  { id: 'm_recharger', out: 'm_recharger', count: 1, inputs: [['plate', 2], ['wiring', 4], ['copper', 2]], station: 'fabricator', time: 2.5, category: 'Máquinas' },
  { id: 'm_storage', out: 'm_storage', count: 1, inputs: [['plate', 3]], station: 'suit', time: 1.5, category: 'Máquinas' },
  { id: 'm_floodlight', out: 'm_floodlight', count: 1, inputs: [['plate', 1], ['wiring', 1], ['silicon', 1]], station: 'suit', time: 1.5, category: 'Máquinas' },
  { id: 'm_door', out: 'm_door', count: 1, inputs: [['plate', 2], ['wiring', 1]], station: 'fabricator', time: 2.0, category: 'Máquinas' },
  { id: 'm_beacon', out: 'm_beacon', count: 1, inputs: [['plate', 1], ['wiring', 1]], station: 'suit', time: 1.0, category: 'Máquinas' },
  // upgrades
  { id: 'extractor_mk2', out: 'extractor_mk2', count: 1, inputs: [['titanium', 2], ['aurelite', 1], ['circuit', 1]], station: 'fabricator', time: 4.0, category: 'Melhorias' },
  { id: 'jetpack', out: 'jetpack', count: 1, inputs: [['plate', 3], ['wiring', 2], ['aurelite', 1]], station: 'fabricator', time: 4.0, category: 'Melhorias' },
  { id: 'thermal_lining', out: 'thermal_lining', count: 1, inputs: [['organics', 2], ['plate', 2], ['carbon', 2]], station: 'fabricator', time: 3.0, category: 'Melhorias' },
  { id: 'rad_shield', out: 'rad_shield', count: 1, inputs: [['plate', 3], ['carbon', 3], ['titanium', 1]], station: 'fabricator', time: 3.0, category: 'Melhorias' },
  { id: 'o2_tank', out: 'o2_tank', count: 1, inputs: [['plate', 3], ['titanium', 1]], station: 'fabricator', time: 3.0, category: 'Melhorias' },
  { id: 'battery_pack', out: 'battery_pack', count: 1, inputs: [['copper', 4], ['aurelite', 2]], station: 'fabricator', time: 3.0, category: 'Melhorias' },
  // ship
  { id: 'hull_patch', out: 'hull_patch', count: 1, inputs: [['plate', 4], ['carbon', 2]], station: 'suit', time: 2.5, category: 'Nave' },
  { id: 'power_cell', out: 'power_cell', count: 1, inputs: [['aurelite', 2], ['copper', 3], ['silicon', 2]], station: 'fabricator', time: 3.0, category: 'Nave' },
  { id: 'thruster_coupling', out: 'thruster_coupling', count: 1, inputs: [['titanium', 2], ['wiring', 2]], station: 'fabricator', time: 3.0, category: 'Nave' },
  { id: 'fuel_cell', out: 'fuel_cell', count: 1, inputs: [['ice', 3], ['carbon', 1]], station: 'suit', time: 2.0, category: 'Nave' },
  { id: 'warp_cell', out: 'warp_cell', count: 1, inputs: [['radite', 2], ['aurelite', 2]], station: 'fabricator', time: 4.0, category: 'Nave' },
  { id: 'warp_core', out: 'warp_core', count: 1, inputs: [['aurelite', 6], ['titanium', 4], ['radite', 4], ['circuit', 2]], station: 'fabricator', time: 6.0, category: 'Nave' },
];

export function canCraft(inv: Inventory, r: Recipe, nearFabricator: boolean): { ok: boolean; reason?: string } {
  if (r.station === 'fabricator' && !nearFabricator) return { ok: false, reason: 'Requer um Fabricador próximo' };
  for (const [id, n] of r.inputs) if (!inv.has(id, n)) return { ok: false, reason: 'Recursos insuficientes' };
  if (inv.freeSlots() === 0 && inv.count(r.out) === 0) return { ok: false, reason: 'Inventário cheio' };
  return { ok: true };
}

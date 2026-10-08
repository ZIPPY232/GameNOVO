import { B, BLOCKS, ITEM_TO_BLOCK } from '../voxel/blocks';
import { LAYERS } from '../voxel/palette';

/** Item definitions. Every item has a real use: build, craft, consume or equip. */

export type ItemKind = 'resource' | 'block' | 'component' | 'tool' | 'consumable' | 'machine' | 'upgrade';

export type ToolId = 'extractor' | 'builder' | 'scanner' | 'flashlight';

export type MachineType =
  | 'fabricator' | 'solar' | 'battery' | 'oxygen' | 'recharger' | 'storage' | 'floodlight' | 'door' | 'beacon';

export interface Consumable {
  oxygen?: number;
  energy?: number;
  health?: number;
  integrity?: number;
  food?: number;
  water?: number;
  radiation?: number;
}

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  stack: number;
  color: string;
  desc: string;
  block?: number;
  tool?: ToolId;
  machine?: MachineType;
  consume?: Consumable;
  /** short symbol for icons */
  glyph?: string;
}

const items = new Map<string, ItemDef>();
function add(d: Omit<ItemDef, 'stack'> & { stack?: number }): void {
  items.set(d.id, { stack: 99, ...d });
}

function blockColor(b: number): string {
  const c = LAYERS[BLOCKS[b].top].color;
  const a = LAYERS[BLOCKS[b].top].accent;
  const m = (i: number) => Math.round(c[i] * 0.6 + a[i] * 0.4);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

// --- raw resources
add({ id: 'rock', name: 'Rocha', kind: 'block', color: blockColor(B.ROCK), desc: 'Silicato comum. Pode ser recolocado como bloco.', block: B.ROCK });
add({ id: 'basalt', name: 'Basalto', kind: 'block', color: blockColor(B.BASALT), desc: 'Rocha vulcânica densa.', block: B.BASALT });
add({ id: 'soil', name: 'Solo', kind: 'block', color: blockColor(B.SOIL), desc: 'Regolito orgânico.', block: B.SOIL });
add({ id: 'sand', name: 'Areia', kind: 'block', color: blockColor(B.SAND), desc: 'Grãos de sílica. Matéria-prima de vidro.', block: B.SAND });
add({ id: 'ice', name: 'Gelo', kind: 'block', color: blockColor(B.ICE), desc: 'Água congelada: oxigênio, hidrogênio e água potável.', block: B.ICE });
add({ id: 'iron', name: 'Ferro', kind: 'resource', color: '#b0603c', desc: 'Metal estrutural básico.', glyph: 'Fe' });
add({ id: 'copper', name: 'Cobre', kind: 'resource', color: '#3fae98', desc: 'Condutor para fiação e baterias.', glyph: 'Cu' });
add({ id: 'silicon', name: 'Silício', kind: 'resource', color: '#d9dee6', desc: 'Semicondutor para eletrônica e vidro.', glyph: 'Si' });
add({ id: 'carbon', name: 'Carbono', kind: 'resource', color: '#4c4c52', desc: 'Compósitos, filtros e combustível.', glyph: 'C' });
add({ id: 'titanium', name: 'Titânio', kind: 'resource', color: '#a9bfd8', desc: 'Liga leve e resistente para naves.', glyph: 'Ti' });
add({ id: 'radite', name: 'Radita', kind: 'resource', color: '#7dff5a', desc: 'Mineral radioativo. Combustível de dobra. Manuseie com proteção.', glyph: 'Rd' });
add({ id: 'aurelite', name: 'Aurelita', kind: 'resource', color: '#ffb43a', desc: 'Cristal energético que armazena luz estelar.', glyph: 'Au*' });
add({ id: 'organics', name: 'Compostos Orgânicos', kind: 'resource', color: '#7fc8a0', desc: 'Biomassa alienígena: rações e filtros.', glyph: 'Org' });
add({ id: 'sulfur', name: 'Enxofre', kind: 'resource', color: '#d8c43a', desc: 'Comum em mundos vulcânicos. Explosivos e químicos.', glyph: 'S' });
add({ id: 'cryolith', name: 'Criolita', kind: 'resource', color: '#7fe6ff', desc: 'Cristal criogênico raro de mundos congelados.', glyph: 'Cr' });
add({ id: 'luminite', name: 'Luminita', kind: 'resource', color: '#c060ff', desc: 'Mineral exótico bioluminescente.', glyph: 'Lm' });

// --- components
add({ id: 'plate', name: 'Placa Metálica', kind: 'component', color: '#9aa2ab', desc: 'Chapa estrutural.', glyph: '▤' });
add({ id: 'wiring', name: 'Fiação', kind: 'component', color: '#d58a3c', desc: 'Condutores isolados.', glyph: '∿' });
add({ id: 'circuit', name: 'Circuito', kind: 'component', color: '#4fd18b', desc: 'Lógica de controle.', glyph: '⌗' });
add({ id: 'power_cell', name: 'Célula de Energia', kind: 'component', color: '#ffc34d', desc: 'Núcleo de aurelita estabilizado. Restaura sistemas de energia.', glyph: '⚡' });
add({ id: 'hull_patch', name: 'Kit de Casco', kind: 'component', color: '#7d8791', desc: 'Remendo estrutural para fuselagem.', glyph: '⬢' });
add({ id: 'thruster_coupling', name: 'Acoplamento de Propulsor', kind: 'component', color: '#9fb8d8', desc: 'Peça de titânio para motores.', glyph: '⊛' });
add({ id: 'fuel_cell', name: 'Célula de Combustível', kind: 'component', color: '#62c4ff', desc: 'Hidrogênio comprimido. +25% de combustível da nave.', glyph: 'H₂' });
add({ id: 'warp_cell', name: 'Célula de Dobra', kind: 'component', color: '#a46bff', desc: 'Consumida a cada salto interestelar.', glyph: '✦' });
add({ id: 'warp_core', name: 'Núcleo de Dobra', kind: 'upgrade', color: '#c49bff', desc: 'Instale na nave para habilitar saltos interestelares.', glyph: '✧', stack: 1 });

// --- blocks (crafted)
add({ id: 'metal_block', name: 'Painel Metálico', kind: 'block', color: blockColor(B.METAL_PLATE), desc: 'Bloco de construção hermético.', block: B.METAL_PLATE });
add({ id: 'glass', name: 'Vidro Reforçado', kind: 'block', color: '#a8d4ec', desc: 'Janela hermética.', block: B.GLASS });
add({ id: 'concrete', name: 'Compósito Estrutural', kind: 'block', color: blockColor(B.CONCRETE), desc: 'Bloco de fundação resistente.', block: B.CONCRETE });
add({ id: 'lamp', name: 'Bloco Luminoso', kind: 'block', color: '#ffe9c4', desc: 'Iluminação integrada.', block: B.LAMP });
add({ id: 'floor', name: 'Piso Técnico', kind: 'block', color: blockColor(B.FLOOR), desc: 'Piso hermético para habitats.', block: B.FLOOR });
add({ id: 'hull_block', name: 'Blindagem Escura', kind: 'block', color: blockColor(B.HULL), desc: 'Blindagem contra radiação.', block: B.HULL });

// --- consumables
add({ id: 'o2_canister', name: 'Cilindro de O₂', kind: 'consumable', color: '#8fd3ff', desc: '+45 de oxigênio.', consume: { oxygen: 45 }, glyph: 'O₂', stack: 20 });
add({ id: 'battery', name: 'Bateria', kind: 'consumable', color: '#ffd166', desc: '+50 de energia do traje.', consume: { energy: 50 }, glyph: '▮', stack: 20 });
add({ id: 'suit_patch', name: 'Remendo de Traje', kind: 'consumable', color: '#e8e6e1', desc: '+40 de integridade do traje.', consume: { integrity: 40 }, glyph: '✚', stack: 20 });
add({ id: 'medkit', name: 'Kit Médico', kind: 'consumable', color: '#ff6b6b', desc: '+45 de vida e reduz radiação.', consume: { health: 45, radiation: -25 }, glyph: '+', stack: 10 });
add({ id: 'ration', name: 'Ração', kind: 'consumable', color: '#c8a26a', desc: 'Alimento processado (+40 nutrição).', consume: { food: 40 }, glyph: '◆', stack: 20 });
add({ id: 'water', name: 'Bolsa de Água', kind: 'consumable', color: '#6fb6ff', desc: 'Água purificada (+45 hidratação).', consume: { water: 45 }, glyph: '◇', stack: 20 });

// --- tools & upgrades
add({ id: 'extractor', name: 'Extrator Multifuncional', kind: 'tool', color: '#ea7a2c', desc: 'Desagrega voxels e coleta recursos.', tool: 'extractor', stack: 1, glyph: '⟁' });
add({ id: 'builder', name: 'Ferramenta de Construção', kind: 'tool', color: '#5fd0ff', desc: 'Posiciona blocos e módulos.', tool: 'builder', stack: 1, glyph: '⬚' });
add({ id: 'scanner', name: 'Scanner Geológico', kind: 'tool', color: '#7dffb0', desc: 'Pulso que revela minérios e analisa o ambiente.', tool: 'scanner', stack: 1, glyph: '◎' });
add({ id: 'flashlight', name: 'Lanterna', kind: 'tool', color: '#fff2c4', desc: 'Iluminação (F).', tool: 'flashlight', stack: 1, glyph: '☀' });
add({ id: 'extractor_mk2', name: 'Extrator Mk II', kind: 'upgrade', color: '#ff9b4a', desc: 'Mineração 2x mais rápida e alcance maior.', stack: 1, glyph: 'II' });
add({ id: 'jetpack', name: 'Mochila Propulsora', kind: 'upgrade', color: '#b5c3d1', desc: 'Segure ESPAÇO no ar para voar. Consome energia.', stack: 1, glyph: '⇡' });
add({ id: 'thermal_lining', name: 'Revestimento Térmico', kind: 'upgrade', color: '#ff8f6b', desc: 'Amplia a faixa de temperatura suportada pelo traje.', stack: 1, glyph: '℃' });
add({ id: 'rad_shield', name: 'Blindagem Anti-Radiação', kind: 'upgrade', color: '#9cff6b', desc: 'Reduz a absorção de radiação em 70%.', stack: 1, glyph: '☢' });
add({ id: 'o2_tank', name: 'Tanque de O₂ Expandido', kind: 'upgrade', color: '#8fd3ff', desc: 'Dobra a capacidade de oxigênio.', stack: 1, glyph: 'O₂+' });
add({ id: 'battery_pack', name: 'Pacote de Baterias', kind: 'upgrade', color: '#ffd166', desc: 'Dobra a capacidade de energia.', stack: 1, glyph: '▮+' });

// --- machines
add({ id: 'm_fabricator', name: 'Fabricador', kind: 'machine', color: '#7d8a99', desc: 'Estação de fabricação avançada.', machine: 'fabricator', stack: 5, glyph: '⚙' });
add({ id: 'm_solar', name: 'Painel Solar', kind: 'machine', color: '#3a5f9a', desc: 'Gera energia durante o dia (depende da estrela e da atmosfera).', machine: 'solar', stack: 10, glyph: '☼' });
add({ id: 'm_battery', name: 'Banco de Baterias', kind: 'machine', color: '#ffd166', desc: 'Armazena 400 unidades de energia da base.', machine: 'battery', stack: 10, glyph: '▣' });
add({ id: 'm_oxygen', name: 'Gerador de O₂', kind: 'machine', color: '#8fd3ff', desc: 'Pressuriza habitats fechados e recarrega o traje. Consome energia.', machine: 'oxygen', stack: 5, glyph: 'O₂' });
add({ id: 'm_recharger', name: 'Estação de Recarga', kind: 'machine', color: '#5fd0ff', desc: 'Recarrega energia e oxigênio do traje (E).', machine: 'recharger', stack: 5, glyph: '⚡' });
add({ id: 'm_storage', name: 'Contêiner', kind: 'machine', color: '#8b7a63', desc: 'Armazena 24 pilhas de itens.', machine: 'storage', stack: 10, glyph: '▦' });
add({ id: 'm_floodlight', name: 'Holofote', kind: 'machine', color: '#fff2c4', desc: 'Iluminação de base. Consome pouca energia.', machine: 'floodlight', stack: 10, glyph: '✺' });
add({ id: 'm_door', name: 'Porta Hermética', kind: 'machine', color: '#9aa2ab', desc: 'Porta pressurizada (E para abrir/fechar).', machine: 'door', stack: 10, glyph: '▯' });
add({ id: 'm_beacon', name: 'Baliza', kind: 'machine', color: '#ff5f5f', desc: 'Marca um ponto de interesse na bússola.', machine: 'beacon', stack: 10, glyph: '⚑' });

export const ITEMS = items;

export function item(id: string): ItemDef {
  const d = items.get(id);
  if (!d) throw new Error('unknown item ' + id);
  return d;
}

export function placeableBlock(id: string): number | null {
  const d = items.get(id);
  if (d?.block !== undefined) return d.block;
  return ITEM_TO_BLOCK[id] ?? null;
}

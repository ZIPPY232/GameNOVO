/**
 * Flora instance format shared by the terrain worker (placement) and the
 * renderer. Each instance is FLORA_STRIDE floats:
 *   [kind, gx, gy, gz, scale, yaw, variant, seed]
 * where (gx, gy) are continuous grid coordinates on the cube face and gz is the
 * continuous ground height in grid units (cell K spans [K, K+1]).
 */

export const FLORA_STRIDE = 8;

export enum FK {
  TREE_BROAD = 0,
  TREE_CONIFER = 1,
  TREE_PALM = 2,
  TREE_DEAD = 3,
  BUSH = 4,
  FERN = 5,
  FUNGUS_GIANT = 6,
  FUNGUS_SMALL = 7,
  CRYSTAL = 8,
  CORAL = 9,
  ROCK = 10,
  TREE_ALIEN = 11,
  COUNT = 12,
}

/** crystal variants (material) */
export enum CRYSTAL_VARIANT { QUARTZ = 0, LUMINITE = 1, ICE = 2, CRYOLITH = 3, AURELITE = 4 }

export interface FloraInfo {
  name: string;
  /** item dropped when harvested, and how many */
  drop: string | null;
  count: number;
  /** seconds to harvest with the Mk1 extractor */
  hardness: number;
  /** collision/harvest proxy: trunk radius (m, before scale) and height */
  radius: number;
  height: number;
  /** blocks the player (trunks, rocks, crystals) */
  solid: boolean;
}

export const FLORA_INFO: FloraInfo[] = [];
FLORA_INFO[FK.TREE_BROAD] = { name: 'Árvore', drop: 'organics', count: 4, hardness: 2.2, radius: 0.32, height: 9, solid: true };
FLORA_INFO[FK.TREE_CONIFER] = { name: 'Conífera', drop: 'organics', count: 4, hardness: 2.2, radius: 0.28, height: 12, solid: true };
FLORA_INFO[FK.TREE_PALM] = { name: 'Palmeira', drop: 'organics', count: 3, hardness: 1.6, radius: 0.2, height: 8, solid: true };
FLORA_INFO[FK.TREE_DEAD] = { name: 'Árvore seca', drop: 'carbon', count: 2, hardness: 1.4, radius: 0.22, height: 6, solid: true };
FLORA_INFO[FK.BUSH] = { name: 'Arbusto', drop: 'organics', count: 1, hardness: 0.5, radius: 0.7, height: 1.2, solid: false };
FLORA_INFO[FK.FERN] = { name: 'Samambaia', drop: 'organics', count: 1, hardness: 0.3, radius: 0.6, height: 0.9, solid: false };
FLORA_INFO[FK.FUNGUS_GIANT] = { name: 'Fungo gigante', drop: 'organics', count: 3, hardness: 1.2, radius: 0.4, height: 6, solid: true };
FLORA_INFO[FK.FUNGUS_SMALL] = { name: 'Fungo', drop: 'organics', count: 1, hardness: 0.3, radius: 0.35, height: 0.8, solid: false };
FLORA_INFO[FK.CRYSTAL] = { name: 'Formação cristalina', drop: 'silicon', count: 2, hardness: 1.5, radius: 0.55, height: 2.2, solid: true };
FLORA_INFO[FK.CORAL] = { name: 'Coral', drop: 'organics', count: 1, hardness: 0.6, radius: 0.5, height: 1.6, solid: false };
FLORA_INFO[FK.ROCK] = { name: 'Rocha solta', drop: 'rock', count: 2, hardness: 1.0, radius: 0.6, height: 0.9, solid: true };
FLORA_INFO[FK.TREE_ALIEN] = { name: 'Árvore bioluminescente', drop: 'organics', count: 4, hardness: 2.0, radius: 0.3, height: 8, solid: true };

/** drop for a crystal by variant */
export const CRYSTAL_DROP: Record<number, string> = {
  [CRYSTAL_VARIANT.QUARTZ]: 'silicon',
  [CRYSTAL_VARIANT.LUMINITE]: 'luminite',
  [CRYSTAL_VARIANT.ICE]: 'ice',
  [CRYSTAL_VARIANT.CRYOLITH]: 'cryolith',
  [CRYSTAL_VARIANT.AURELITE]: 'aurelite',
};

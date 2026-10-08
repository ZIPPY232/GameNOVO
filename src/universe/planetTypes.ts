import { Rng } from '../core/rng';
import { B } from '../voxel/blocks';
import { faceResolutionForRadius } from '../planet/cubesphere';
import type { AtmosphereDef, OreDef, PaletteDef, PlanetGenParams, PlanetType, FloraKind } from './types';

/**
 * Planet classification templates. Each type changes terrain shape, materials,
 * flora, ores, atmosphere optics and survival conditions — not just colours.
 */

export const TYPE_LABEL: Record<PlanetType, string> = {
  terrestrial: 'Terrestre',
  desert: 'Desértico',
  frozen: 'Congelado',
  ocean: 'Oceânico',
  volcanic: 'Vulcânico',
  barren: 'Sem atmosfera',
  exotic: 'Exótico',
  gas_giant: 'Gigante gasoso',
};

const LAYERS_Z = 512;
const SEA_Z = 224;

function ores(rng: Rng, extra: OreDef[] = []): OreDef[] {
  const j = () => rng.range(-0.015, 0.015);
  return [
    { block: B.AURELITE, freq: 1 / 9, threshold: 0.855 + j(), minDepth: 3, maxDepth: 999 },
    { block: B.RADITE, freq: 1 / 10, threshold: 0.875 + j(), minDepth: 18, maxDepth: 999 },
    { block: B.TITANIUM_ORE, freq: 1 / 10, threshold: 0.835 + j(), minDepth: 9, maxDepth: 999 },
    ...extra,
    { block: B.IRON_ORE, freq: 1 / 11, threshold: 0.775 + j(), minDepth: 1, maxDepth: 999 },
    { block: B.COPPER_ORE, freq: 1 / 11, threshold: 0.795 + j(), minDepth: 1, maxDepth: 999 },
    { block: B.QUARTZ, freq: 1 / 9, threshold: 0.805 + j(), minDepth: 2, maxDepth: 999 },
    { block: B.CARBON, freq: 1 / 12, threshold: 0.79 + j(), minDepth: 1, maxDepth: 70 },
  ];
}

function palette(p: Partial<PaletteDef>): PaletteDef {
  return {
    surface: B.MOSS, subsurface: B.SOIL, rock: B.ROCK, deep: B.BASALT, beach: B.SAND, steep: B.ROCK,
    cold: B.SNOW, seabed: B.SAND, dry: B.SAND, ...p,
  };
}

const vec = (a: number, b: number, c: number): [number, number, number] => [a, b, c];

export function buildGenParams(type: PlanetType, seed: number, radius: number, temperature: number, rng: Rng): PlanetGenParams {
  const N = faceResolutionForRadius(radius);
  const base: PlanetGenParams = {
    seed, type, radius, N, baseRadius: radius - SEA_Z, layers: LAYERS_Z, seaZ: SEA_Z,
    hasOcean: false, frozenOcean: false, lavaOcean: false,
    continentFreq: 1 / rng.range(2000, 3200), continentBias: 0.1,
    mountainHeight: rng.range(120, 240), hillHeight: rng.range(12, 26), detailHeight: rng.range(2, 4),
    craterDensity: 0, craterDepth: 1, canyonDepth: 0, duneHeight: 0, terraceStep: 0, volcanoes: 0,
    caveDensity: rng.range(0.8, 1.3), temperature, moisture: 0.5,
    palette: palette({}), ores: ores(rng), flora: 'none', floraDensity: 0, outcrops: 1,
    bioTint: vec(0.42, 0.62, 0.5), rockTint: vec(1, 1, 1),
  };
  switch (type) {
    case 'terrestrial': {
      base.hasOcean = true;
      base.continentBias = rng.range(0.05, 0.25);
      base.moisture = rng.range(0.45, 0.7);
      base.flora = 'alien_forest';
      base.floraDensity = rng.range(0.6, 1.2);
      const tints: [number, number, number][] = [vec(0.35, 0.62, 0.48), vec(0.3, 0.55, 0.62), vec(0.62, 0.6, 0.3), vec(0.55, 0.42, 0.58)];
      base.bioTint = rng.pick(tints);
      base.rockTint = vec(rng.range(0.95, 1.05), 1, rng.range(0.92, 1.05));
      break;
    }
    case 'ocean': {
      base.hasOcean = true;
      base.continentBias = rng.range(-0.38, -0.25);
      base.mountainHeight *= 0.6;
      base.moisture = 0.8;
      base.flora = 'coral';
      base.floraDensity = 1.2;
      base.bioTint = vec(0.3, 0.6, 0.58);
      base.palette = palette({ seabed: B.SAND, surface: B.MOSS });
      break;
    }
    case 'desert': {
      base.continentBias = 0.4;
      base.moisture = 0.12;
      base.duneHeight = rng.range(6, 14);
      base.canyonDepth = rng.range(40, 90);
      base.terraceStep = rng.chance(0.5) ? rng.range(10, 18) : 0;
      base.mountainHeight *= 0.7;
      base.flora = 'desert_spires';
      base.floraDensity = 0.5;
      base.palette = palette({ surface: B.SAND, subsurface: B.SAND, rock: B.SANDSTONE, steep: B.RED_ROCK, dry: B.RED_ROCK, deep: B.RED_ROCK });
      base.rockTint = vec(1.05, 0.95, 0.85);
      break;
    }
    case 'frozen': {
      base.frozenOcean = true;
      base.continentBias = rng.range(-0.1, 0.15);
      base.moisture = 0.5;
      base.flora = 'frost_flora';
      base.floraDensity = 0.35;
      base.palette = palette({ surface: B.SNOW, subsurface: B.ICE, rock: B.ROCK, steep: B.ICE, cold: B.SNOW, seabed: B.ICE, dry: B.ICE });
      base.ores = ores(rng, [{ block: B.CRYOLITH, freq: 1 / 9, threshold: 0.84, minDepth: 2, maxDepth: 999 }]);
      base.rockTint = vec(0.9, 0.95, 1.05);
      break;
    }
    case 'volcanic': {
      base.lavaOcean = true;
      base.continentBias = rng.range(0.05, 0.2);
      base.volcanoes = rng.range(0.25, 0.5);
      base.moisture = 0.1;
      base.craterDensity = 0.15;
      base.flora = 'crystal';
      base.floraDensity = 0.15;
      base.palette = palette({ surface: B.ASH, subsurface: B.BASALT, rock: B.BASALT, deep: B.BASALT, steep: B.BASALT, dry: B.BASALT, beach: B.BASALT, seabed: B.BASALT });
      base.ores = ores(rng, [{ block: B.SULFUR, freq: 1 / 8, threshold: 0.76, minDepth: 0, maxDepth: 40 }]);
      break;
    }
    case 'barren': {
      base.continentBias = 0.3;
      base.mountainHeight *= 0.55;
      base.hillHeight *= 0.8;
      base.craterDensity = rng.range(0.45, 0.8);
      base.craterDepth = rng.range(0.9, 1.4);
      base.moisture = 0;
      base.caveDensity *= 0.6;
      base.palette = palette({ surface: B.REGOLITH, subsurface: B.REGOLITH, rock: B.ROCK, steep: B.ROCK, dry: B.REGOLITH, deep: B.BASALT });
      base.rockTint = vec(rng.range(0.9, 1.1), rng.range(0.9, 1.0), rng.range(0.85, 1.0));
      break;
    }
    case 'exotic': {
      base.hasOcean = rng.chance(0.5) && temperature > -10 && temperature < 90;
      base.continentBias = 0.2;
      base.moisture = rng.range(0.4, 0.8);
      base.flora = temperature < -45 ? 'crystal' : rng.chance(0.5) ? 'fungal' : 'crystal';
      base.floraDensity = rng.range(0.8, 1.4);
      base.terraceStep = rng.chance(0.4) ? rng.range(6, 12) : 0;
      base.bioTint = rng.pick([vec(0.62, 0.3, 0.7), vec(0.25, 0.6, 0.75), vec(0.75, 0.42, 0.3)]);
      base.palette = palette({ surface: B.MOSS, subsurface: B.MUD, rock: B.BASALT, steep: B.RED_ROCK, dry: B.ASH, seabed: B.MUD, deep: B.BASALT });
      base.ores = ores(rng, [{ block: B.LUMINITE, freq: 1 / 9, threshold: 0.835, minDepth: 2, maxDepth: 999 }]);
      break;
    }
    case 'gas_giant':
      break;
  }
  return base;
}

/** Atmosphere optics derived from type, radius and a random density. */
export function buildAtmosphere(type: PlanetType, radius: number, rng: Rng): AtmosphereDef | null {
  if (type === 'barren') return null;
  const H = radius * 0.05;
  const mk = (tau: [number, number, number], density: number, mieTau: number, mieColor: [number, number, number], pressure: number, breathable: number, composition: string, clouds: number, cloudColor: [number, number, number]): AtmosphereDef => ({
    height: H * 7.5,
    rayleigh: [tau[0] * density / H, tau[1] * density / H, tau[2] * density / H],
    rayleighScale: H,
    mie: mieTau / (H * 0.22),
    mieScale: H * 0.22,
    mieG: 0.76,
    mieColor,
    pressure,
    breathable,
    composition,
    clouds,
    cloudColor,
  });
  const earth: [number, number, number] = [0.046, 0.108, 0.265];
  switch (type) {
    case 'terrestrial':
      return mk(earth, rng.range(0.85, 1.25), rng.range(0.02, 0.05), [1, 1, 1], rng.range(0.6, 1.2), rng.range(0.3, 0.8), 'N₂ / O₂ / Ar', rng.range(0.35, 0.6), [1, 1, 1]);
    case 'ocean':
      return mk(earth, rng.range(1.0, 1.4), 0.05, [1, 1, 1], rng.range(0.9, 1.5), rng.range(0.4, 0.9), 'N₂ / O₂ / H₂O', rng.range(0.5, 0.75), [1, 1, 1]);
    case 'desert':
      return mk([0.09, 0.07, 0.05], rng.range(0.6, 1.0), rng.range(0.12, 0.25), [1.0, 0.72, 0.45], rng.range(0.2, 0.7), 0, 'CO₂ / N₂ / poeira', rng.range(0.05, 0.2), [1, 0.9, 0.8]);
    case 'frozen':
      return mk([0.03, 0.08, 0.16], rng.range(0.5, 0.9), 0.03, [0.9, 0.95, 1.0], rng.range(0.2, 0.6), rng.range(0, 0.25), 'N₂ / CH₄', rng.range(0.3, 0.55), [0.95, 0.97, 1]);
    case 'volcanic':
      return mk([0.12, 0.08, 0.035], rng.range(1.0, 1.6), rng.range(0.15, 0.3), [0.9, 0.62, 0.4], rng.range(1.5, 4), 0, 'CO₂ / SO₂', rng.range(0.4, 0.7), [0.55, 0.48, 0.42]);
    case 'exotic': {
      const tints: [number, number, number][] = [[0.18, 0.04, 0.22], [0.04, 0.16, 0.1], [0.2, 0.1, 0.03], [0.05, 0.08, 0.3]];
      return mk(rng.pick(tints), rng.range(0.8, 1.3), rng.range(0.05, 0.15), [1, 0.9, 1], rng.range(0.8, 2.5), rng.range(0, 0.5), 'Ne / Xe / compostos orgânicos', rng.range(0.25, 0.6), [1, 0.92, 1]);
    }
    case 'gas_giant':
      return mk([0.05, 0.08, 0.14], 1, 0.05, [1, 1, 1], 100, 0, 'H₂ / He', 0, [1, 1, 1]);
    default:
      return null;
  }
}

export function floraLabel(f: FloraKind): string {
  switch (f) {
    case 'alien_forest': return 'Florestas bioluminescentes';
    case 'fungal': return 'Colônias fúngicas';
    case 'coral': return 'Recifes minerais';
    case 'crystal': return 'Formações cristalinas';
    case 'desert_spires': return 'Pináculos de arenito';
    case 'frost_flora': return 'Flora criogênica dormente';
    default: return 'Sem vida detectável';
  }
}

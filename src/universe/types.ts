/** Shared data types describing the procedural universe. Plain JSON-able data only. */

export type PlanetType =
  | 'terrestrial' | 'desert' | 'frozen' | 'ocean' | 'volcanic' | 'barren' | 'exotic' | 'gas_giant';

export type FloraKind = 'none' | 'alien_forest' | 'fungal' | 'coral' | 'crystal' | 'desert_spires' | 'frost_flora';

export interface OreDef {
  block: number;
  /** spatial frequency in 1/m of the ore field */
  freq: number;
  /** field threshold in [0,1]; higher = rarer */
  threshold: number;
  /** minimum depth below surface (m) */
  minDepth: number;
  maxDepth: number;
}

export interface PaletteDef {
  surface: number;
  subsurface: number;
  rock: number;
  deep: number;
  beach: number;
  steep: number;
  cold: number;
  seabed: number;
  dry: number;
}

export interface PlanetGenParams {
  seed: number;
  type: PlanetType;
  /** sea-level radius (m) */
  radius: number;
  /** cells per cube-face edge */
  N: number;
  /** radius of voxel layer z = 0 */
  baseRadius: number;
  /** number of radial layers (multiple of 32) */
  layers: number;
  /** z of the sea / datum level */
  seaZ: number;
  hasOcean: boolean;
  frozenOcean: boolean;
  lavaOcean: boolean;
  continentFreq: number;
  continentBias: number;
  mountainHeight: number;
  hillHeight: number;
  detailHeight: number;
  craterDensity: number;
  craterDepth: number;
  canyonDepth: number;
  duneHeight: number;
  terraceStep: number;
  volcanoes: number;
  caveDensity: number;
  temperature: number;
  moisture: number;
  palette: PaletteDef;
  ores: OreDef[];
  flora: FloraKind;
  floraDensity: number;
  outcrops: number;
  /** vegetation tint (linear rgb) */
  bioTint: [number, number, number];
  /** rock tint (linear rgb multiplier) */
  rockTint: [number, number, number];
}

export interface AtmosphereDef {
  /** top of atmosphere altitude above sea level (m) */
  height: number;
  /** Rayleigh scattering coefficients at sea level (1/m) */
  rayleigh: [number, number, number];
  rayleighScale: number;
  mie: number;
  mieScale: number;
  mieG: number;
  /** absorption tint applied to Mie (dusty atmospheres) */
  mieColor: [number, number, number];
  /** surface pressure in atm (gameplay) */
  pressure: number;
  /** 0 = toxic / none, 1 = fully breathable */
  breathable: number;
  /** label of composition */
  composition: string;
  clouds: number;
  cloudColor: [number, number, number];
}

export interface OrbitDef {
  /** orbit radius around parent (m) */
  radius: number;
  /** orbital period (s of game time) */
  period: number;
  phase: number;
  inclination: number;
  /** longitude of ascending node */
  node: number;
}

export interface RotationDef {
  period: number;
  tilt: number;
  phase: number;
}

export interface RingDef {
  inner: number;
  outer: number;
  color: [number, number, number];
  opacity: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: 'planet' | 'moon';
  type: PlanetType;
  parentId: string | null; // null = orbits star
  orbit: OrbitDef;
  rotation: RotationDef;
  radius: number;
  /** surface gravity m/s^2 */
  gravity: number;
  /** mean surface temperature °C */
  temperature: number;
  /** background radiation (units/s) */
  radiation: number;
  atmosphere: AtmosphereDef | null;
  gen: PlanetGenParams | null;
  /** colours for distant rendering */
  colorA: [number, number, number];
  colorB: [number, number, number];
  rings: RingDef | null;
  /** short description shown in scanner / journal */
  description: string;
  resources: string[];
  /** sphere of influence radius (m) for reference-frame switching */
  soi: number;
}

export interface StarDef {
  spectral: 'M' | 'K' | 'G' | 'F' | 'A' | 'B' | 'RG';
  label: string;
  temperature: number;
  luminosity: number;
  mass: number;
  radius: number;
  color: [number, number, number];
  habitableInner: number;
  habitableOuter: number;
}

export interface StarSystemDef {
  id: string;
  seed: number;
  name: string;
  /** galaxy position in light-years */
  galaxyPos: [number, number, number];
  star: StarDef;
  bodies: BodyDef[];
  hasStation: boolean;
  hasDerelict: boolean;
}

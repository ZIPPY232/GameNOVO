import { Rng, hash32 } from '../core/rng';
import type { BodyDef, PlanetType, StarDef, StarSystemDef, RingDef } from './types';
import { buildAtmosphere, buildGenParams, TYPE_LABEL, floraLabel } from './planetTypes';
import { properName, ROMAN } from './names';
import { BLOCKS } from '../voxel/blocks';
import type { StarSummary } from './galaxy';

/**
 * Star-system generator. Uses simplified physics (luminosity -> habitable zone
 * and frost line, equilibrium temperature, mass -> gravity) so planets make
 * sense for their star rather than being random colour swaps.
 *
 * Distances are compressed: 1 "game AU" = AU_GAME metres.
 */

export const AU_GAME = 420_000;

export function kelvinToRGB(k: number): [number, number, number] {
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (v: number) => Math.min(1, Math.max(0, v / 255));
  return [c(r), c(g), c(b)];
}

export function makeStar(spectral: StarDef['spectral'], rng: Rng): StarDef {
  const table: Record<StarDef['spectral'], [number, number, number, number, number, string]> = {
    //        tempMin tempMax  lumMin lumMax  massApprox label
    M: [2800, 3700, 0.04, 0.12, 0.4, 'Anã vermelha'],
    K: [3900, 5200, 0.3, 0.7, 0.75, 'Anã laranja'],
    G: [5300, 6000, 0.8, 1.3, 1.0, 'Anã amarela'],
    F: [6100, 7300, 1.6, 3.5, 1.3, 'Estrela branco-amarelada'],
    A: [7500, 9800, 6, 20, 2.0, 'Estrela branca'],
    B: [11000, 20000, 60, 300, 5.0, 'Gigante azul'],
    RG: [3300, 4400, 60, 200, 1.2, 'Gigante vermelha'],
  };
  const [t0, t1, l0, l1, mass, label] = table[spectral];
  const temperature = rng.range(t0, t1);
  const luminosity = rng.range(l0, l1);
  const radiusScale = spectral === 'RG' ? 6 : spectral === 'B' ? 2.4 : spectral === 'A' ? 1.6 : spectral === 'M' ? 0.55 : spectral === 'K' ? 0.8 : spectral === 'F' ? 1.2 : 1;
  const sq = Math.sqrt(luminosity);
  return {
    spectral, label, temperature, luminosity, mass,
    radius: 9000 * radiusScale,
    color: kelvinToRGB(temperature),
    habitableInner: 0.92 * sq,
    habitableOuter: 1.45 * sq,
  };
}

function equilibriumTempC(luminosity: number, au: number): number {
  return 278 * Math.pow(luminosity, 0.25) / Math.sqrt(au) - 273;
}

function choosePlanetType(rng: Rng, tempC: number, au: number, frostLine: number): PlanetType {
  if (au > frostLine) return rng.weighted<PlanetType>(['gas_giant', 'frozen', 'barren', 'exotic'], [0.55, 0.25, 0.12, 0.08]);
  if (tempC > 160) return rng.weighted<PlanetType>(['volcanic', 'barren', 'desert'], [0.55, 0.3, 0.15]);
  if (tempC > 55) return rng.weighted<PlanetType>(['desert', 'volcanic', 'exotic', 'barren'], [0.55, 0.2, 0.15, 0.1]);
  if (tempC > -25) return rng.weighted<PlanetType>(['terrestrial', 'ocean', 'exotic', 'desert'], [0.42, 0.25, 0.18, 0.15]);
  if (tempC > -90) return rng.weighted<PlanetType>(['frozen', 'barren', 'exotic'], [0.6, 0.25, 0.15]);
  return rng.weighted<PlanetType>(['frozen', 'barren', 'gas_giant'], [0.5, 0.35, 0.15]);
}

/** Surface temperature given equilibrium temperature and atmosphere (greenhouse). */
function surfaceTemp(type: PlanetType, eqC: number, pressure: number): number {
  const greenhouse = type === 'volcanic' ? 90 : type === 'barren' ? 0 : 12 * Math.min(3, pressure);
  return eqC + greenhouse;
}

function describe(b: BodyDef): string {
  const atm = b.atmosphere;
  const parts: string[] = [];
  parts.push(`${TYPE_LABEL[b.type]}.`);
  if (b.type === 'gas_giant') {
    parts.push('Sem superfície sólida — tempestades em camadas de hidrogênio e hélio.');
  } else {
    parts.push(atm ? `Atmosfera ${atm.composition}, ${atm.pressure.toFixed(2)} atm${atm.breathable > 0.2 ? ' (parcialmente respirável)' : ' (não respirável)'}.` : 'Sem atmosfera: vácuo e radiação estelar direta.');
    parts.push(`Gravidade ${b.gravity.toFixed(1)} m/s², temperatura média ${Math.round(b.temperature)} °C.`);
    if (b.gen) parts.push(floraLabel(b.gen.flora) + '.');
  }
  return parts.join(' ');
}

function bodyColors(type: PlanetType, rng: Rng): [[number, number, number], [number, number, number]] {
  switch (type) {
    case 'gas_giant': {
      const pal: [number, number, number][][] = [
        [[0.78, 0.62, 0.42], [0.55, 0.38, 0.26]],
        [[0.62, 0.72, 0.82], [0.32, 0.42, 0.6]],
        [[0.82, 0.74, 0.6], [0.66, 0.46, 0.38]],
        [[0.6, 0.78, 0.7], [0.3, 0.5, 0.52]],
        [[0.86, 0.66, 0.5], [0.6, 0.3, 0.2]],
      ];
      const p = rng.pick(pal);
      return [p[0], p[1]];
    }
    default:
      return [[0.5, 0.5, 0.5], [0.3, 0.3, 0.3]];
  }
}

interface BodySpec {
  type: PlanetType;
  radius: number;
  au?: number;
  orbitRadius?: number;
  gravity?: number;
  name?: string;
  rings?: boolean;
  breathable?: number;
  temperature?: number;
}

function makeBody(sys: { star: StarDef; seed: number; name: string }, rng: Rng, id: string, name: string, kind: 'planet' | 'moon', parent: BodyDef | null, spec: BodySpec, index: number): BodyDef {
  const star = sys.star;
  const au = parent ? parent.orbit.radius / AU_GAME : spec.au!;
  const orbitRadius = parent ? spec.orbitRadius! : au * AU_GAME;
  const eq = equilibriumTempC(star.luminosity, au);
  const type = spec.type;
  const atmosphere = buildAtmosphere(type, spec.radius, rng);
  if (atmosphere && spec.breathable !== undefined) atmosphere.breathable = spec.breathable;
  const temperature = spec.temperature ?? surfaceTemp(type, eq, atmosphere?.pressure ?? 0);
  const seed = hash32(sys.seed, index, 911);
  const gen = type === 'gas_giant' ? null : buildGenParams(type, seed, spec.radius, temperature, rng.fork(index));
  const gravity = spec.gravity ?? (type === 'gas_giant' ? rng.range(16, 26) : kind === 'moon' ? 2.2 + (spec.radius - 1400) / 2000 * 3.5 + rng.range(-0.4, 0.4) : 4 + (spec.radius - 2200) / 3200 * 8 + rng.range(-0.8, 0.8));
  const period = parent
    ? 2400 * Math.pow(orbitRadius / (parent.radius * 4), 1.5)
    : 3600 * 7 * Math.pow(au, 1.5) / Math.sqrt(star.mass);
  const [colorA, colorB] = bodyColors(type, rng);
  let rings: RingDef | null = null;
  if (spec.rings || (type === 'gas_giant' && rng.chance(0.45))) {
    rings = { inner: spec.radius * rng.range(1.35, 1.6), outer: spec.radius * rng.range(2.1, 2.7), color: [rng.range(0.7, 0.9), rng.range(0.65, 0.8), rng.range(0.55, 0.72)], opacity: rng.range(0.5, 0.85) };
  }
  const radiation = (type === 'barren' ? 0.25 : atmosphere ? 0.02 / Math.max(0.2, atmosphere.pressure) : 0.2) * Math.sqrt(star.luminosity) / Math.max(0.3, au);
  const body: BodyDef = {
    id, name, kind, type,
    parentId: parent ? parent.id : null,
    orbit: { radius: orbitRadius, period, phase: rng.range(0, Math.PI * 2), inclination: rng.range(-0.06, 0.06), node: rng.range(0, Math.PI * 2) },
    rotation: { period: type === 'gas_giant' ? rng.range(500, 1100) : rng.range(900, 2200), tilt: rng.range(0, 0.4), phase: rng.range(0, Math.PI * 2) },
    radius: spec.radius,
    gravity,
    temperature,
    radiation,
    atmosphere,
    gen,
    colorA, colorB,
    rings,
    description: '',
    resources: [],
    soi: 0,
  };
  if (gen) {
    const res = new Set<string>();
    for (const o of gen.ores) res.add(BLOCKS[o.block].name);
    body.resources = [...res];
  }
  body.soi = type === 'gas_giant' ? spec.radius * 1.6 : parent ? Math.min(spec.radius * 4.5, orbitRadius * 0.3) : spec.radius * 6;
  body.description = describe(body);
  return body;
}

function addMoons(sys: { star: StarDef; seed: number; name: string }, rng: Rng, parent: BodyDef, bodies: BodyDef[], count: number): void {
  let orbitR = parent.radius * (parent.type === 'gas_giant' ? rng.range(3.2, 4.2) : rng.range(7, 10));
  for (let m = 0; m < count; m++) {
    const eq = equilibriumTempC(sys.star.luminosity, parent.orbit.radius / AU_GAME);
    let type: PlanetType = eq < -40 ? rng.weighted<PlanetType>(['frozen', 'barren'], [0.6, 0.4]) : rng.weighted<PlanetType>(['barren', 'volcanic', 'exotic', 'desert', 'frozen'], [0.45, 0.15, 0.15, 0.15, 0.1]);
    if (parent.type === 'gas_giant' && eq > -30 && eq < 50 && rng.chance(0.35)) type = 'terrestrial';
    const radius = rng.range(1500, 2600);
    const id = `${parent.id}-${String.fromCharCode(97 + m)}`;
    const name = `${parent.name} ${String.fromCharCode(97 + m)}`;
    bodies.push(makeBody(sys, rng.fork(500 + m), id, name, 'moon', parent, { type, radius, orbitRadius: orbitR }, bodies.length + 100));
    orbitR *= rng.range(1.5, 1.9);
  }
}

/** Fully deterministic system for a galaxy star. */
export function generateSystem(summary: StarSummary): StarSystemDef {
  if (summary.isStart) return generateStartSystem(summary);
  const rng = new Rng(summary.seed);
  const star = makeStar(summary.spectral, rng);
  const sys = { star, seed: summary.seed, name: summary.name };
  const bodies: BodyDef[] = [];
  const frostLine = 2.7 * Math.sqrt(star.luminosity);
  const count = rng.int(2, 7);
  let au = rng.range(0.32, 0.55) * Math.sqrt(star.luminosity);
  for (let i = 0; i < count; i++) {
    const eq = equilibriumTempC(star.luminosity, au);
    const type = choosePlanetType(rng, eq, au, frostLine);
    const radius = type === 'gas_giant' ? rng.range(15000, 32000) : rng.range(2300, 5000);
    const id = `p${i}`;
    const name = `${summary.name} ${ROMAN[i]}`;
    const b = makeBody(sys, rng.fork(i), id, name, 'planet', null, { type, radius, au }, i);
    bodies.push(b);
    const moonCount = type === 'gas_giant' ? rng.int(1, 3) : rng.chance(0.3) ? 1 : 0;
    addMoons(sys, rng.fork(1000 + i), b, bodies, moonCount);
    au *= rng.range(1.45, 1.9);
  }
  // occasionally rename a planet with a proper name
  for (const b of bodies) if (b.kind === 'planet' && rng.chance(0.3)) b.name = properName(rng);
  return {
    id: summary.id, seed: summary.seed, name: summary.name, galaxyPos: summary.pos, star, bodies,
    hasStation: rng.chance(0.4), hasDerelict: rng.chance(0.6),
  };
}

/** The handcrafted-by-rules starting system: a habitable moon orbiting a ringed gas giant. */
function generateStartSystem(summary: StarSummary): StarSystemDef {
  const rng = new Rng(summary.seed);
  const star = makeStar('G', rng);
  star.luminosity = 1.0;
  star.temperature = 5650;
  star.color = kelvinToRGB(5650);
  star.habitableInner = 0.92;
  star.habitableOuter = 1.45;
  const sys = { star, seed: summary.seed, name: summary.name };
  const bodies: BodyDef[] = [];
  const P = (i: number, spec: BodySpec, name: string) => {
    const b = makeBody(sys, rng.fork(i), `p${i}`, name, 'planet', null, spec, i);
    bodies.push(b);
    return b;
  };
  P(0, { type: 'volcanic', radius: 2900, au: 0.42 }, 'Pyrrhos');
  P(1, { type: 'desert', radius: 3600, au: 0.74 }, 'Sereth');
  const giant = P(2, { type: 'gas_giant', radius: 21000, au: 1.12, rings: true }, 'Thalassor');
  // the starting moon: terrestrial, partially breathable, forests and oceans
  const startMoon = makeBody(sys, rng.fork(300), 'p2-a', 'Kepra', 'moon', giant, { type: 'terrestrial', radius: 3000, orbitRadius: giant.radius * 3.6, gravity: 7.4, breathable: 0.35, temperature: 14 }, 300);
  // tidally locked: the giant hangs motionless in the sky while the star rises and sets
  startMoon.rotation.period = startMoon.orbit.period;
  startMoon.rotation.phase = startMoon.orbit.phase;
  startMoon.rotation.tilt = 0.12;
  startMoon.gen!.bioTint = [0.42, 0.58, 0.36];
  startMoon.gen!.floraDensity = 0.32;
  startMoon.gen!.outcrops = 1.6;
  bodies.push(startMoon);
  const iceMoon = makeBody(sys, rng.fork(301), 'p2-b', 'Velune', 'moon', giant, { type: 'frozen', radius: 1800, orbitRadius: giant.radius * 5.6, gravity: 3.1 }, 301);
  bodies.push(iceMoon);
  const ocean = P(3, { type: 'ocean', radius: 4200, au: 1.5 }, 'Maris');
  void ocean;
  P(4, { type: 'frozen', radius: 3300, au: 2.6 }, 'Glacia');
  const outer = P(5, { type: 'exotic', radius: 3100, au: 3.9 }, 'Nyxara');
  addMoons(sys, rng.fork(77), outer, bodies, 1);
  return {
    id: summary.id, seed: summary.seed, name: summary.name, galaxyPos: summary.pos, star, bodies,
    hasStation: true, hasDerelict: true,
  };
}

export const START_BODY_ID = 'p2-a';

import { Rng, hash32 } from '../core/rng';
import { Noise3 } from '../core/noise';
import { systemName } from './names';
import type { StarDef } from './types';

/**
 * Galaxy: an unbounded grid of sectors (SECTOR ly cubes). Each sector holds a
 * deterministic number of stars derived from the galaxy seed and a large-scale
 * density field (arms, clusters, voids). Nothing is stored — any star can be
 * regenerated from its id alone.
 */

export const SECTOR = 12; // light years

export interface StarSummary {
  id: string;
  seed: number;
  name: string;
  pos: [number, number, number];
  spectral: StarDef['spectral'];
  isStart: boolean;
}

export class Galaxy {
  readonly seed: number;
  private density: Noise3;
  private cache = new Map<string, StarSummary[]>();

  constructor(seed: number) {
    this.seed = seed;
    this.density = new Noise3(hash32(seed, 4242));
  }

  static sectorKey(sx: number, sy: number, sz: number): string {
    return `${sx}:${sy}:${sz}`;
  }

  starsInSector(sx: number, sy: number, sz: number): StarSummary[] {
    const key = Galaxy.sectorKey(sx, sy, sz);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rng = new Rng(hash32(this.seed, sx, sy, sz));
    const cx = (sx + 0.5) * SECTOR, cy = (sy + 0.5) * SECTOR, cz = (sz + 0.5) * SECTOR;
    // thin disc + spiral-ish density modulation
    const disc = Math.exp(-Math.abs(cy) / 40);
    const arms = 0.5 + 0.5 * this.density.fbm(cx / 220, cy / 220, cz / 220, 3);
    const lambda = 0.75 * disc * (0.2 + arms * 1.6);
    let n = 0;
    let L = Math.exp(-lambda), p = 1;
    do { n++; p *= rng.next(); } while (p > L && n < 8);
    n -= 1;
    const out: StarSummary[] = [];
    const isOrigin = sx === 0 && sy === 0 && sz === 0;
    if (isOrigin) n = Math.max(n, 1);
    for (let i = 0; i < n; i++) {
      const seed = hash32(this.seed, sx, sy, sz, i, 17);
      const r = new Rng(seed);
      const pos: [number, number, number] = [
        (sx + r.range(0.05, 0.95)) * SECTOR,
        (sy + r.range(0.05, 0.95)) * SECTOR,
        (sz + r.range(0.05, 0.95)) * SECTOR,
      ];
      const spectral = r.weighted<StarDef['spectral']>(['M', 'K', 'G', 'F', 'A', 'B', 'RG'], [0.42, 0.24, 0.16, 0.09, 0.05, 0.015, 0.025]);
      const isStart = isOrigin && i === 0;
      if (isStart) {
        pos[0] = SECTOR * 0.5; pos[1] = SECTOR * 0.5; pos[2] = SECTOR * 0.5;
      }
      out.push({
        id: `S${sx}_${sy}_${sz}_${i}`,
        seed,
        name: isStart ? 'Aurora' : systemName(r),
        pos,
        spectral: isStart ? 'G' : spectral,
        isStart,
      });
    }
    this.cache.set(key, out);
    return out;
  }

  /** All stars within `radius` ly of a point. */
  starsNear(pos: [number, number, number], radius: number): StarSummary[] {
    const out: StarSummary[] = [];
    const s0 = pos.map((v) => Math.floor((v - radius) / SECTOR));
    const s1 = pos.map((v) => Math.floor((v + radius) / SECTOR));
    for (let sx = s0[0]; sx <= s1[0]; sx++) for (let sy = s0[1]; sy <= s1[1]; sy++) for (let sz = s0[2]; sz <= s1[2]; sz++) {
      for (const s of this.starsInSector(sx, sy, sz)) {
        const d = Math.hypot(s.pos[0] - pos[0], s.pos[1] - pos[1], s.pos[2] - pos[2]);
        if (d <= radius) out.push(s);
      }
    }
    return out;
  }

  byId(id: string): StarSummary | null {
    const m = /^S(-?\d+)_(-?\d+)_(-?\d+)_(\d+)$/.exec(id);
    if (!m) return null;
    const list = this.starsInSector(+m[1], +m[2], +m[3]);
    return list[+m[4]] ?? null;
  }

  startStar(): StarSummary {
    return this.starsInSector(0, 0, 0)[0];
  }
}

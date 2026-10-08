import { TileNoise2 } from '../core/noise';
import { hash32 } from '../core/rng';
import { LAYERS, type LayerMaterial } from '../voxel/palette';
import { LAYER_COUNT } from '../voxel/blocks';

/**
 * Procedural PBR material textures for voxel layers. Runs in a worker at boot.
 * Output per layer (size x size):
 *   albedo   RGBA8  sRGB colour, A = vegetation tint mask
 *   material RGBA8  R,G = tangent-space normal xy, B = roughness, A = emissive mask
 * Textures tile per block and include a subtle bevel so blocks read as
 * chiselled solids rather than flat pixel art.
 */

export interface TextureSet {
  size: number;
  layers: number;
  albedo: Uint8Array;
  material: Uint8Array;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

interface Texel {
  h: number;
  r: number; g: number; b: number;
  rough: number;
  tint: number;
  emit: number;
}

export function generateTextures(size: number): TextureSet {
  const layers = LAYER_COUNT;
  const albedo = new Uint8Array(size * size * 4 * layers);
  const material = new Uint8Array(size * size * 4 * layers);
  const height = new Float32Array(size * size);
  for (let l = 0; l < layers; l++) {
    const m = LAYERS[l];
    const nz = new TileNoise2(hash32(9137, l));
    const out: Texel = { h: 0, r: 0, g: 0, b: 0, rough: 0, tint: 0, emit: 0 };
    const base = l * size * size * 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size;
        shade(m, nz, u, v, out, l);
        // bevel
        const e = Math.min(u, 1 - u, v, 1 - v);
        const panel = m.pattern === 'metal' || m.pattern === 'hull' || m.pattern === 'concrete' || m.pattern === 'floor' || m.pattern === 'lamp' || m.pattern === 'glass';
        const bw = panel ? 0.05 : 0.04;
        const bevel = 1 - smooth(0, bw, e);
        out.h -= bevel * (panel ? 0.5 : 0.35);
        const cav = 1 - bevel * (panel ? 0.25 : 0.18);
        const i = base + (x + y * size) * 4;
        albedo[i] = Math.round(clamp01(out.r * cav) * 255);
        albedo[i + 1] = Math.round(clamp01(out.g * cav) * 255);
        albedo[i + 2] = Math.round(clamp01(out.b * cav) * 255);
        albedo[i + 3] = Math.round(clamp01(out.tint) * 255);
        material[i + 2] = Math.round(clamp01(out.rough) * 255);
        material[i + 3] = Math.round(clamp01(out.emit) * 255);
        height[x + y * size] = out.h;
      }
    }
    const strength = normalStrength(m);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xl = (x - 1 + size) % size, xr = (x + 1) % size;
        const yd = (y - 1 + size) % size, yu = (y + 1) % size;
        const dhdx = (height[xr + y * size] - height[xl + y * size]) * 0.5 * size;
        const dhdy = (height[x + yu * size] - height[x + yd * size]) * 0.5 * size;
        let nx = -dhdx * strength, ny = -dhdy * strength;
        const nzv = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nzv * nzv);
        nx *= inv; ny *= inv;
        const i = base + (x + y * size) * 4;
        material[i] = Math.round((nx * 0.5 + 0.5) * 255);
        material[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      }
    }
  }
  return { size, layers, albedo, material };
}

function normalStrength(m: LayerMaterial): number {
  switch (m.pattern) {
    case 'snow': case 'mud': case 'ice': case 'glass': return 0.012;
    case 'sand': case 'regolith': case 'ash': return 0.02;
    case 'metal': case 'hull': case 'floor': case 'concrete': case 'lamp': return 0.03;
    default: return 0.035;
  }
}

function col(c: [number, number, number]): [number, number, number] {
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

function shade(m: LayerMaterial, n: TileNoise2, u: number, v: number, o: Texel, layer: number): void {
  const A = col(m.color), Bc = col(m.accent);
  let t = 0, h = 0, rough = m.roughness, tint = m.tint ? 1 : 0, emit = 0;
  let r = A[0], g = A[1], b = A[2];
  const setMix = (k: number) => {
    r = mix(A[0], Bc[0], k); g = mix(A[1], Bc[1], k); b = mix(A[2], Bc[2], k);
  };
  const scale = (k: number) => { r *= k; g *= k; b *= k; };

  switch (m.pattern) {
    case 'rock':
    case 'bedrock': {
      const f = n.fbm(u, v, 4, 5);
      const [f1, f2] = n.worley(u, v, 5);
      const crack = 1 - smooth(0.0, 0.06, f2 - f1);
      t = clamp01(0.5 + f * 0.9);
      setMix(t * 0.7);
      h = f * 0.6 + (1 - f1) * 0.3 - crack * 0.6;
      scale(1 - crack * 0.35 + n.fbm(u, v, 32, 2) * 0.08);
      rough = m.roughness + crack * 0.1;
      break;
    }
    case 'basalt': {
      const [f1, f2] = n.worley(u, v, 3);
      const edge = 1 - smooth(0.0, 0.08, f2 - f1);
      const f = n.fbm(u, v, 8, 4);
      setMix(clamp01(0.4 + f));
      h = 0.6 - edge * 0.8 + f * 0.25;
      scale(1 - edge * 0.45);
      rough = m.roughness - (1 - edge) * 0.1;
      break;
    }
    case 'soil':
    case 'mud': {
      const f = n.fbm(u, v, 6, 5);
      const [p1] = n.worley(u, v, 9);
      const pebble = 1 - smooth(0.12, 0.3, p1);
      setMix(clamp01(0.5 + f));
      h = f * 0.5 + pebble * 0.6;
      scale(1 + pebble * 0.25);
      if (m.pattern === 'mud') {
        const puddle = smooth(0.1, 0.35, n.fbm(u, v, 2, 3));
        rough = mix(m.roughness, 0.08, puddle);
        h *= 1 - puddle;
        scale(1 - puddle * 0.2);
      }
      break;
    }
    case 'moss': {
      const f = n.fbm(u, v, 5, 5);
      const fib = n.fbm(u, v, 48, 2);
      const [c1] = n.worley(u, v, 7);
      setMix(clamp01(0.5 - f * 0.8));
      h = f * 0.4 + fib * 0.25 + (1 - c1) * 0.35;
      scale(0.85 + (1 - c1) * 0.25 + fib * 0.12);
      tint = 1;
      break;
    }
    case 'moss_side':
    case 'snow_side': {
      // soil below, cap above (v -> 1 is the top edge)
      const f = n.fbm(u, v, 6, 5);
      const edge = 0.74 + n.fbm(u * 3, 0.5, 4, 3) * 0.12 + n.fbm(u, v, 24, 2) * 0.04;
      const cap = smooth(edge - 0.02, edge + 0.02, v);
      const soil = col([104, 78, 58]);
      const soil2 = col([78, 58, 42]);
      const ks = clamp01(0.5 + f);
      const capC = m.pattern === 'moss_side' ? col([150, 158, 140]) : col([236, 241, 246]);
      r = mix(mix(soil[0], soil2[0], ks), capC[0], cap);
      g = mix(mix(soil[1], soil2[1], ks), capC[1], cap);
      b = mix(mix(soil[2], soil2[2], ks), capC[2], cap);
      h = f * 0.5 + cap * 0.4;
      scale(1 - (1 - cap) * smooth(edge - 0.1, edge, v) * 0.25);
      tint = m.pattern === 'moss_side' ? cap : 0;
      rough = m.pattern === 'snow_side' ? mix(0.9, 0.6, cap) : 0.92;
      break;
    }
    case 'sand':
    case 'regolith':
    case 'ash': {
      const grain = n.fbm(u, v, 64, 2);
      const f = n.fbm(u, v, 3, 4);
      const ripple = m.pattern === 'sand' ? Math.sin((v + n.fbm(u, v, 2, 3) * 0.15) * Math.PI * 2 * 4) * 0.5 + 0.5 : 0;
      setMix(clamp01(0.5 + f * 0.8));
      h = grain * 0.25 + ripple * 0.35 + f * 0.2;
      scale(0.92 + grain * 0.12 + ripple * 0.05);
      if (m.pattern === 'regolith') {
        const [c1] = n.worley(u, v, 6);
        const pit = 1 - smooth(0.05, 0.2, c1);
        h -= pit * 0.4;
        scale(1 - pit * 0.15);
      }
      if (m.pattern === 'ash') {
        const ember = smooth(0.82, 0.95, n.fbm(u, v, 16, 2) * 0.5 + 0.5);
        emit = ember * 0.6;
        r += ember * 0.4;
        g += ember * 0.1;
      }
      break;
    }
    case 'snow': {
      const f = n.fbm(u, v, 4, 4);
      const sparkle = smooth(0.86, 0.95, n.fbm(u, v, 64, 1) * 0.5 + 0.5);
      setMix(clamp01(0.5 - f));
      h = f * 0.4;
      scale(1 + sparkle * 0.08);
      rough = m.roughness - sparkle * 0.4;
      break;
    }
    case 'ice': {
      const f = n.fbm(u, v, 3, 4);
      const [f1, f2] = n.worley(u, v, 4);
      const crack = 1 - smooth(0.0, 0.025, f2 - f1);
      const bubbles = smooth(0.7, 0.9, n.fbm(u, v, 24, 2) * 0.5 + 0.5);
      setMix(clamp01(crack * 0.8 + bubbles * 0.4 + f * 0.2));
      h = f * 0.2 - crack * 0.3;
      rough = m.roughness + crack * 0.3;
      break;
    }
    case 'ore': {
      const f = n.fbm(u, v, 4, 5);
      const [f1, f2] = n.worley(u, v, 5);
      const crack = 1 - smooth(0.0, 0.05, f2 - f1);
      const [o1] = n.worley(u, v, 7, 31);
      const nod = 1 - smooth(0.16, 0.3, o1 + n.fbm(u, v, 12, 2) * 0.06);
      const rockC = clamp01(0.5 + f);
      r = mix(A[0], A[0] * 0.75, rockC); g = mix(A[1], A[1] * 0.75, rockC); b = mix(A[2], A[2] * 0.75, rockC);
      r = mix(r, Bc[0] * (0.8 + f * 0.3), nod); g = mix(g, Bc[1] * (0.8 + f * 0.3), nod); b = mix(b, Bc[2] * (0.8 + f * 0.3), nod);
      h = f * 0.5 + nod * 0.6 - crack * 0.5;
      scale(1 - crack * 0.3);
      rough = mix(m.roughness, 0.35, nod);
      emit = nod * (m.emissive > 0 ? 1 : 0);
      break;
    }
    case 'crystal': {
      const [f1, f2] = n.worley(u, v, 4);
      const facet = f2 - f1;
      const cell = n.fbm(u, v, 4, 1);
      const edge = 1 - smooth(0.0, 0.05, facet);
      const k = clamp01(0.25 + facet * 1.4 + cell * 0.3);
      setMix(k);
      h = facet * 1.4 - edge * 0.3 + cell * 0.2;
      scale(1 + edge * 0.35);
      emit = smooth(0.25, 0.7, k);
      rough = m.roughness + edge * 0.2;
      break;
    }
    case 'carbon': {
      const f = n.fbm(u, v, 6, 4);
      const fleck = smooth(0.78, 0.9, n.fbm(u, v, 48, 1) * 0.5 + 0.5);
      setMix(fleck);
      h = f * 0.5 + fleck * 0.2;
      rough = mix(0.7, 0.2, fleck);
      break;
    }
    case 'lava': {
      const [f1, f2] = n.worley(u, v, 4);
      const crack = 1 - smooth(0.0, 0.11, f2 - f1 + n.fbm(u, v, 8, 2) * 0.04);
      const f = n.fbm(u, v, 6, 4);
      r = mix(A[0] * (0.8 + f * 0.4), Bc[0], crack);
      g = mix(A[1] * (0.8 + f * 0.4), Bc[1] * (0.6 + crack * 0.6), crack);
      b = mix(A[2] * (0.8 + f * 0.4), Bc[2], crack);
      h = (1 - crack) * 0.7 + f * 0.3;
      emit = crack;
      rough = mix(0.95, 0.5, crack);
      break;
    }
    case 'metal':
    case 'hull': {
      const brushed = n.fbm(u * 0.1, v, 64, 2) * 0.5;
      const scratch = smooth(0.92, 0.98, n.fbm(u, v * 0.2, 24, 2) * 0.5 + 0.5);
      // inner panel inset
      const inset = Math.min(u, 1 - u, v, 1 - v);
      const seam = 1 - smooth(0.085, 0.1, inset);
      const rivet = [0.15, 0.85].some((a) => [0.15, 0.85].some((c) => Math.hypot(u - a, v - c) < 0.025)) ? 1 : 0;
      setMix(seam * 0.6);
      scale(1 + brushed * 0.08 + scratch * 0.15 - rivet * 0.1);
      h = 0.5 - seam * 0.25 + rivet * 0.5;
      rough = m.roughness + brushed * 0.1 - scratch * 0.15 + seam * 0.15;
      if (m.pattern === 'hull') {
        const stripe = v > 0.86 && v < 0.93 ? 1 : 0;
        r = mix(r, Bc[0], stripe); g = mix(g, Bc[1], stripe); b = mix(b, Bc[2], stripe);
        rough = mix(rough, 0.55, stripe);
      }
      break;
    }
    case 'floor': {
      const gx = (u * 6) % 1, gy = (v * 18) % 1;
      const slot = gx > 0.12 && gx < 0.88 && gy > 0.3 && gy < 0.7 ? 1 : 0;
      const wear = n.fbm(u, v, 8, 3) * 0.5 + 0.5;
      setMix(slot);
      scale(1 + wear * 0.1);
      h = slot ? 0.1 : 0.6;
      rough = m.roughness + wear * 0.2 + slot * 0.3;
      break;
    }
    case 'glass': {
      const frame = 1 - smooth(0.05, 0.065, Math.min(u, 1 - u, v, 1 - v));
      setMix(frame);
      const smudge = n.fbm(u, v, 4, 3) * 0.5 + 0.5;
      h = 0.5 + frame * 0.2;
      rough = mix(m.roughness + smudge * 0.06, 0.4, frame);
      break;
    }
    case 'concrete': {
      const f = n.fbm(u, v, 8, 4);
      const [p1] = n.worley(u, v, 14);
      const pore = 1 - smooth(0.03, 0.08, p1);
      const seam = 1 - smooth(0.02, 0.03, Math.abs(v - 0.5));
      setMix(clamp01(0.5 + f * 0.6));
      scale(1 - pore * 0.3 - seam * 0.2);
      h = 0.5 + f * 0.2 - pore * 0.4 - seam * 0.4;
      break;
    }
    case 'lamp': {
      const inner = smooth(0.12, 0.14, Math.min(u, 1 - u, v, 1 - v));
      const diff = n.fbm(u, v, 12, 2) * 0.04;
      r = mix(Bc[0], A[0], inner) + diff; g = mix(Bc[1], A[1], inner) + diff; b = mix(Bc[2], A[2], inner) + diff;
      h = 0.4 + inner * 0.2;
      emit = inner;
      rough = mix(0.4, 0.2, inner);
      break;
    }
    case 'strata': {
      const warp = n.fbm(u, v, 3, 3) * 0.08;
      const band = Math.sin((v + warp) * Math.PI * 2 * 5) * 0.5 + 0.5;
      const band2 = Math.sin((v + warp * 2) * Math.PI * 2 * 13) * 0.5 + 0.5;
      const f = n.fbm(u, v, 8, 3);
      setMix(clamp01(band * 0.7 + band2 * 0.2 + f * 0.3));
      h = band * 0.4 + f * 0.3 + band2 * 0.15;
      break;
    }
    case 'bark': {
      const fib = n.fbm(u * 0.25, v, 16, 3);
      const vein = (1 - smooth(0.0, 0.025, Math.abs(n.fbm(u, v * 0.3, 4, 3)))) * smooth(0.2, 0.6, n.fbm(u, v, 3, 2) * 0.5 + 0.5);
      setMix(0);
      scale(0.8 + fib * 0.3);
      r = mix(r, Bc[0], vein * 0.8); g = mix(g, Bc[1], vein * 0.8); b = mix(b, Bc[2], vein * 0.8);
      h = 0.5 + fib * 0.6 - vein * 0.2;
      emit = vein;
      break;
    }
    case 'bark_top': {
      const d = Math.hypot(u - 0.5, v - 0.5);
      const ring = Math.sin((d + n.fbm(u, v, 4, 2) * 0.03) * 60) * 0.5 + 0.5;
      setMix(ring * 0.6);
      h = ring * 0.3;
      break;
    }
    case 'leaves': {
      const [f1, f2] = n.worley(u, v, 6);
      const leaf = smooth(0.0, 0.12, f2 - f1);
      const [s1] = n.worley(u, v, 3, 57);
      const spot = 1 - smooth(0.015, 0.04, s1);
      setMix(0);
      scale(0.55 + leaf * 0.55);
      h = leaf * 0.8;
      tint = 1 - spot;
      r = mix(r, Bc[0], spot); g = mix(g, Bc[1], spot); b = mix(b, Bc[2], spot);
      emit = spot;
      break;
    }
    case 'coral': {
      const [f1] = n.worley(u, v, 8);
      const pore = 1 - smooth(0.08, 0.2, f1);
      const f = n.fbm(u, v, 6, 3);
      setMix(clamp01(f * 0.5 + 0.3));
      scale(1 - pore * 0.4);
      h = 0.6 - pore * 0.7 + f * 0.2;
      emit = pore * 0.6;
      break;
    }
    case 'fungus': {
      const [f1] = n.worley(u, v, 5);
      const spot = 1 - smooth(0.1, 0.16, f1);
      const f = n.fbm(u, v, 6, 3);
      setMix(spot);
      scale(0.9 + f * 0.15);
      h = 0.4 + spot * 0.3 + f * 0.2;
      emit = spot;
      break;
    }
  }
  void layer;
  o.h = h;
  o.r = r; o.g = g; o.b = b;
  o.rough = rough;
  o.tint = tint;
  o.emit = emit;
}

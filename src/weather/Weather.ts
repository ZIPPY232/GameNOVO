import * as THREE from 'three';
import { Rng, hash32 } from '../core/rng';
import type { BodyDef } from '../universe/types';

/**
 * Planetary weather. Each planet type allows only physically coherent events
 * (no rain without an atmosphere, sandstorms on dry worlds, ash on volcanic
 * ones...). The schedule is deterministic per body and time window, and state
 * changes blend smoothly.
 */

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow' | 'blizzard' | 'sandstorm' | 'ash' | 'electric' | 'meteors' | 'spores';

export interface WeatherParams {
  cloud: number;
  fog: number;
  fogColor: THREE.Color;
  wet: number;
  particles: 'none' | 'rain' | 'snow' | 'dust' | 'ash' | 'spores';
  density: number;
  wind: number;
  lightning: number;
  tempDelta: number;
  meteors: number;
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Céu limpo', cloudy: 'Nublado', rain: 'Chuva', storm: 'Tempestade elétrica', fog: 'Névoa', snow: 'Neve',
  blizzard: 'Nevasca', sandstorm: 'Tempestade de areia', ash: 'Chuva de cinzas', electric: 'Tempestade elétrica seca', meteors: 'Chuva de meteoros', spores: 'Nuvem de esporos',
};

function allowed(def: BodyDef): [WeatherKind, number][] {
  const atm = def.atmosphere;
  if (!atm) return [['clear', 5], ['meteors', 1]];
  switch (def.type) {
    case 'terrestrial': return [['clear', 4], ['cloudy', 3], ['rain', 2], ['storm', 1], ['fog', 1]];
    case 'ocean': return [['cloudy', 3], ['clear', 2], ['rain', 3], ['storm', 2]];
    case 'desert': return [['clear', 5], ['sandstorm', 2], ['electric', 0.5]];
    case 'frozen': return [['clear', 3], ['snow', 3], ['blizzard', 1], ['fog', 1]];
    case 'volcanic': return [['ash', 3], ['clear', 1], ['electric', 1.5], ['meteors', 0.5]];
    case 'exotic': return [['clear', 3], ['fog', 2], ['spores', 2], ['electric', 1]];
    default: return [['clear', 1]];
  }
}

function params(kind: WeatherKind, def: BodyDef): WeatherParams {
  const baseCloud = def.atmosphere?.clouds ?? 0;
  const p: WeatherParams = { cloud: baseCloud, fog: 0, fogColor: new THREE.Color(0.6, 0.65, 0.7), wet: 0, particles: 'none', density: 0, wind: 2, lightning: 0, tempDelta: 0, meteors: 0 };
  switch (kind) {
    case 'cloudy': p.cloud = Math.min(0.85, baseCloud + 0.25); p.wind = 4; break;
    case 'rain': p.cloud = 0.85; p.fog = 0.0016; p.wet = 1; p.particles = 'rain'; p.density = 0.7; p.wind = 6; p.tempDelta = -4; p.fogColor.setRGB(0.42, 0.46, 0.5); break;
    case 'storm': p.cloud = 0.95; p.fog = 0.0028; p.wet = 1; p.particles = 'rain'; p.density = 1; p.wind = 13; p.lightning = 0.25; p.tempDelta = -6; p.fogColor.setRGB(0.3, 0.33, 0.37); break;
    case 'fog': p.fog = 0.006; p.wet = 0.35; p.wind = 1; p.fogColor.setRGB(0.7, 0.72, 0.74); break;
    case 'snow': p.cloud = 0.75; p.fog = 0.002; p.particles = 'snow'; p.density = 0.6; p.wind = 4; p.tempDelta = -8; p.fogColor.setRGB(0.78, 0.8, 0.85); break;
    case 'blizzard': p.cloud = 0.95; p.fog = 0.009; p.particles = 'snow'; p.density = 1; p.wind = 18; p.tempDelta = -22; p.fogColor.setRGB(0.82, 0.85, 0.9); break;
    case 'sandstorm': p.fog = 0.012; p.particles = 'dust'; p.density = 1; p.wind = 20; p.tempDelta = 4; p.fogColor.setRGB(0.66, 0.5, 0.33); break;
    case 'ash': p.cloud = Math.max(baseCloud, 0.6); p.fog = 0.004; p.particles = 'ash'; p.density = 0.7; p.wind = 5; p.fogColor.setRGB(0.28, 0.25, 0.23); break;
    case 'electric': p.cloud = Math.max(baseCloud, 0.7); p.lightning = 0.35; p.wind = 9; p.fog = 0.0015; p.fogColor.setRGB(0.35, 0.33, 0.4); break;
    case 'meteors': p.meteors = 1; break;
    case 'spores': p.fog = 0.003; p.particles = 'spores'; p.density = 0.6; p.wind = 2; p.fogColor.setRGB(0.5, 0.42, 0.6); break;
    default: break;
  }
  return p;
}

export class Weather {
  kind: WeatherKind = 'clear';
  readonly cur: WeatherParams;
  private target: WeatherParams;
  private def: BodyDef;
  private epoch = -1;
  lightningFlash = 0;
  private nextBolt = 5;
  onThunder: ((delay: number, intensity: number) => void) | null = null;
  onMeteor: (() => void) | null = null;
  private meteorTimer = 3;
  forced: WeatherKind | null = null;

  constructor(def: BodyDef) {
    this.def = def;
    this.cur = params('clear', def);
    this.target = params('clear', def);
  }

  get label(): string {
    return WEATHER_LABEL[this.kind];
  }

  private pick(time: number): WeatherKind {
    const epoch = Math.floor(time / 300);
    const rng = new Rng(hash32(this.def.orbit.radius | 0, epoch, this.def.id.length * 97));
    const opts = allowed(this.def);
    // the start of the campaign is always calm
    if (time < 600 && this.def.id === 'p2-a') return 'clear';
    return rng.weighted(opts.map((o) => o[0]), opts.map((o) => o[1]));
  }

  update(dt: number, time: number): void {
    const epoch = Math.floor(time / 300);
    if (epoch !== this.epoch || this.forced) {
      this.epoch = epoch;
      const k = this.forced ?? this.pick(time);
      if (k !== this.kind || this.forced) {
        this.kind = k;
        this.target = params(k, this.def);
      }
    }
    const a = 1 - Math.exp(-dt / 12);
    const c = this.cur, t = this.target;
    c.cloud += (t.cloud - c.cloud) * a;
    c.fog += (t.fog - c.fog) * a;
    c.fogColor.lerp(t.fogColor, a);
    c.wet += (t.wet - c.wet) * (t.wet > c.wet ? a : a * 0.25);
    c.density += (t.density - c.density) * a;
    if (c.density < 0.05) c.particles = t.particles; else if (t.particles !== 'none') c.particles = t.particles;
    c.wind += (t.wind - c.wind) * a;
    c.lightning = t.lightning;
    c.tempDelta += (t.tempDelta - c.tempDelta) * a;
    c.meteors = t.meteors;
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 4);
    if (c.lightning > 0) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 2 + Math.random() * 10 / c.lightning;
        this.lightningFlash = 1;
        const dist = 200 + Math.random() * 2500;
        this.onThunder?.(dist / 340, Math.min(1, 800 / dist));
      }
    }
    if (c.meteors > 0) {
      this.meteorTimer -= dt;
      if (this.meteorTimer <= 0) {
        this.meteorTimer = 0.6 + Math.random() * 3;
        this.onMeteor?.();
      }
    }
  }
}

/** Camera-local precipitation/dust particles wrapping in a box around the observer. */
export class WeatherParticles {
  readonly object: THREE.Group = new THREE.Group();
  private rain: THREE.LineSegments;
  private dots: THREE.Points;
  private rainPos: Float32Array;
  private dotPos: Float32Array;
  private seeds: Float32Array;
  private readonly N = 2400;
  /** particle budget scale from settings (0..1) */
  quality = 1;
  private readonly box = 26;
  private dotMat: THREE.PointsMaterial;
  private rainMat: THREE.LineBasicMaterial;

  constructor() {
    this.rainPos = new Float32Array(this.N * 6);
    this.dotPos = new Float32Array(this.N * 3);
    this.seeds = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N * 3; i++) this.seeds[i] = Math.random();
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.55, 0.6, 0.68), transparent: true, opacity: 0.35, depthWrite: false });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    this.dotMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true });
    this.dots = new THREE.Points(dg, this.dotMat);
    this.dots.frustumCulled = false;
    this.object.add(this.rain, this.dots);
  }

  /**
   * @param up local up (render space)
   * @param offset camera position in a stable frame (for wrapping continuity)
   */
  update(time: number, kind: WeatherParams['particles'], density: number, wind: number, up: THREE.Vector3, windDir: THREE.Vector3, offset: THREE.Vector3, light: THREE.Vector3): void {
    const active = kind !== 'none' && density > 0.02;
    this.object.visible = active;
    if (!active) return;
    const B = this.box;
    const n = Math.floor(this.N * Math.min(1, density) * this.quality);
    const side = new THREE.Vector3().crossVectors(up, windDir).normalize();
    const fwd = new THREE.Vector3().crossVectors(side, up).normalize();
    let fall = 9, swirl = 0.2, len = 0.6;
    if (kind === 'snow') { fall = 1.4; swirl = 1.2; len = 0; }
    if (kind === 'dust') { fall = 0.3; swirl = 2.5; len = 0; }
    if (kind === 'ash') { fall = 0.8; swirl = 0.8; len = 0; }
    if (kind === 'spores') { fall = -0.15; swirl = 0.6; len = 0; }
    const isRain = kind === 'rain';
    this.rain.visible = isRain;
    this.dots.visible = !isRain;
    const L = Math.max(0.2, (light.x + light.y + light.z) / 3);
    if (isRain) this.rainMat.color.setRGB(0.12 * L + 0.05, 0.13 * L + 0.05, 0.15 * L + 0.06);
    else {
      const c = kind === 'snow' ? [0.9, 0.92, 1] : kind === 'dust' ? [0.6, 0.45, 0.3] : kind === 'ash' ? [0.25, 0.23, 0.22] : [0.7, 0.5, 1.4];
      this.dotMat.color.setRGB(c[0] * (kind === 'spores' ? 1 : L * 0.25 + 0.05), c[1] * (kind === 'spores' ? 1 : L * 0.25 + 0.05), c[2] * (kind === 'spores' ? 1 : L * 0.25 + 0.05));
      this.dotMat.size = kind === 'dust' ? 0.04 : kind === 'spores' ? 0.05 : 0.07;
    }
    const tmp = new THREE.Vector3();
    const mod = (v: number) => ((v % B) + B) % B - B / 2;
    for (let i = 0; i < this.N; i++) {
      const sx = this.seeds[i * 3], sy = this.seeds[i * 3 + 1], sz = this.seeds[i * 3 + 2];
      if (i >= n) {
        this.dotPos[i * 3] = 0; this.dotPos[i * 3 + 1] = -9999; this.dotPos[i * 3 + 2] = 0;
        for (let k = 0; k < 6; k++) this.rainPos[i * 6 + k] = k % 3 === 1 ? -9999 : 0;
        continue;
      }
      const t = time * (0.8 + sz * 0.4);
      const a = mod(sx * B - offset.dot(side) + Math.sin(t * swirl + sy * 30) * swirl);
      const b = mod(sy * B - offset.dot(fwd) + t * wind * 0.8 + Math.cos(t * swirl + sx * 30) * swirl);
      const h = mod(sz * B - offset.dot(up) - t * fall);
      tmp.copy(side).multiplyScalar(a).addScaledVector(fwd, b).addScaledVector(up, h);
      if (isRain) {
        this.rainPos[i * 6] = tmp.x; this.rainPos[i * 6 + 1] = tmp.y; this.rainPos[i * 6 + 2] = tmp.z;
        tmp.addScaledVector(up, len).addScaledVector(fwd, -len * wind * 0.05);
        this.rainPos[i * 6 + 3] = tmp.x; this.rainPos[i * 6 + 4] = tmp.y; this.rainPos[i * 6 + 5] = tmp.z;
      } else {
        this.dotPos[i * 3] = tmp.x; this.dotPos[i * 3 + 1] = tmp.y; this.dotPos[i * 3 + 2] = tmp.z;
      }
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.dots.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

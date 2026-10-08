import * as THREE from 'three';
import type { AtmosphereDef } from '../universe/types';

/**
 * CPU mirror of the scattering model (few samples) used for lighting decisions:
 * sun colour at the observer (red sunsets on terrain), ambient sky colour,
 * reflection environment maps and gameplay (is it dark?).
 */

export interface AtmoCPU {
  Rg: number;
  Ra: number;
  betaR: [number, number, number];
  betaM: number;
  HR: number;
  HM: number;
  g: number;
  mieColor: [number, number, number];
}

export function atmoFromDef(radius: number, a: AtmosphereDef): AtmoCPU {
  return { Rg: radius, Ra: radius + a.height, betaR: a.rayleigh, betaM: a.mie, HR: a.rayleighScale, HM: a.mieScale, g: a.mieG, mieColor: a.mieColor };
}

function raySphere(o: THREE.Vector3, d: THREE.Vector3, r: number): [number, number] | null {
  const b = o.dot(d);
  const lr = o.length();
  const c = (lr - r) * (lr + r);
  const h = b * b - c;
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

const P = new THREE.Vector3();

/** Optical depths (rayleigh, mie) from o along d to the top of the atmosphere; null if blocked by ground. */
export function opticalDepth(at: AtmoCPU, o: THREE.Vector3, d: THREE.Vector3, steps = 8): [number, number] | null {
  const g = raySphere(o, d, at.Rg * 0.999);
  if (g && g[0] > 0) return null;
  const s = raySphere(o, d, at.Ra);
  if (!s || s[1] <= 0) return [0, 0];
  const t0 = Math.max(0, s[0]), t1 = s[1];
  const ds = (t1 - t0) / steps;
  let r = 0, m = 0;
  for (let i = 0; i < steps; i++) {
    P.copy(o).addScaledVector(d, t0 + ds * (i + 0.5));
    const h = Math.max(0, P.length() - at.Rg);
    r += Math.exp(-h / at.HR) * ds;
    m += Math.exp(-h / at.HM) * ds;
  }
  return [r, m];
}

export function transmittance(at: AtmoCPU, o: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const od = opticalDepth(at, o, d);
  if (!od) return out.set(0, 0, 0);
  const me = at.betaM * 1.1;
  return out.set(
    Math.exp(-(at.betaR[0] * od[0] + me * od[1])),
    Math.exp(-(at.betaR[1] * od[0] + me * od[1])),
    Math.exp(-(at.betaR[2] * od[0] + me * od[1])),
  );
}

const Q = new THREE.Vector3();
/** Single-scattered sky radiance along d from o (sun irradiance = sunColor). */
export function skyRadiance(at: AtmoCPU, o: THREE.Vector3, d: THREE.Vector3, sunDir: THREE.Vector3, sunColor: THREE.Vector3, out: THREE.Vector3, steps = 8): THREE.Vector3 {
  out.set(0, 0, 0);
  const s = raySphere(o, d, at.Ra);
  if (!s || s[1] <= 0) return out;
  let t1 = s[1];
  const g = raySphere(o, d, at.Rg);
  if (g && g[0] > 0) t1 = Math.min(t1, g[0]);
  const t0 = Math.max(0, s[0]);
  const ds = (t1 - t0) / steps;
  let odR = 0, odM = 0;
  const sr = [0, 0, 0], sm = [0, 0, 0];
  const me = at.betaM * 1.1;
  for (let i = 0; i < steps; i++) {
    Q.copy(o).addScaledVector(d, t0 + ds * (i + 0.5));
    const h = Math.max(0, Q.length() - at.Rg);
    const dR = Math.exp(-h / at.HR) * ds, dM = Math.exp(-h / at.HM) * ds;
    odR += dR; odM += dM;
    const l = opticalDepth(at, Q, sunDir, 4);
    if (!l) continue;
    for (let c = 0; c < 3; c++) {
      const tau = at.betaR[c] * (odR + l[0]) + me * (odM + l[1]);
      const a = Math.exp(-tau);
      sr[c] += dR * a;
      sm[c] += dM * a;
    }
  }
  const mu = d.dot(sunDir);
  const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
  const g2 = at.g * at.g;
  const pM = 3 / (8 * Math.PI) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * at.g * mu, 1e-4), 1.5));
  const sc = [sunColor.x, sunColor.y, sunColor.z];
  const v = [0, 0, 0];
  for (let c = 0; c < 3; c++) v[c] = sc[c] * (sr[c] * at.betaR[c] * pR + sm[c] * at.betaM * pM * at.mieColor[c] + sr[c] * at.betaR[c] * 0.02);
  return out.set(v[0], v[1], v[2]);
}

/** Small equirect radiance map for PMREM reflections (sky + crude ground). */
export function skyEquirect(at: AtmoCPU | null, o: THREE.Vector3, up: THREE.Vector3, sunDir: THREE.Vector3, sunColor: THREE.Vector3, groundColor: THREE.Vector3, w = 64, h = 32): THREE.DataTexture {
  const data = new Float32Array(w * h * 4);
  const d = new THREE.Vector3(), c = new THREE.Vector3();
  // build a tangent frame so the map is oriented around local up
  const t1 = new THREE.Vector3(1, 0, 0);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w) * Math.PI * 2 - Math.PI;
      d.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
      if (at) {
        skyRadiance(at, o, d, sunDir, sunColor, c, 5);
      } else c.set(0, 0, 0);
      const below = d.dot(up);
      if (below < -0.02) {
        const k = Math.max(0, sunDir.dot(up));
        c.set(groundColor.x * sunColor.x * k * 0.12 + c.x * 0.2, groundColor.y * sunColor.y * k * 0.12 + c.y * 0.2, groundColor.z * sunColor.z * k * 0.12 + c.z * 0.2);
      }
      // sun disk highlight for specular glints
      const sd = d.dot(sunDir);
      if (sd > 0.9995) c.addScaledVector(sunColor, 40);
      const i = (x + y * w) * 4;
      data[i] = c.x; data[i + 1] = c.y; data[i + 2] = c.z; data[i + 3] = 1;
    }
  }
  void t1;
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

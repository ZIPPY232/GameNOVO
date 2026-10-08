import * as THREE from 'three';
import { Rng, hash32 } from '../core/rng';
import { kelvinToRGB } from '../universe/systemGen';
import type { StarSummary } from '../universe/galaxy';

/**
 * Deep-space backdrop: procedural galactic band with dust lanes, distant
 * nebulae, a background star field and the real neighbouring stars of the
 * galaxy placed in their true directions (they shift after a jump).
 */

const SKY_R = 5e7;

const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const SKY_FRAG = /* glsl */ `
precision highp sampler3D;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler3D tNoise;
uniform vec3 uGalNormal;
uniform vec3 uGalCore;
uniform vec3 uNebDir[3];
uniform vec3 uNebColor[3];
uniform float uNebSize[3];
uniform float uBrightness;
uniform mat3 uSkyRot;
varying vec3 vDir;
float fbm(vec3 p) {
  return texture(tNoise, p).r * 0.5 + texture(tNoise, p * 2.03 + 0.17).r * 0.3 + texture(tNoise, p * 4.11 - 0.31).r * 0.2;
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(uSkyRot * vDir);
  float lat = dot(d, uGalNormal);
  float core = max(dot(d, uGalCore), 0.0);
  float band = exp(-lat * lat / (0.018 + 0.03 * core));
  float n = fbm(d * 0.9);
  float dust = smoothstep(0.42, 0.68, fbm(d * 2.1 + 3.7)) * exp(-lat * lat / 0.004);
  vec3 armCol = mix(vec3(0.55, 0.62, 0.9), vec3(1.0, 0.82, 0.62), pow(core, 3.0));
  vec3 col = armCol * band * (0.35 + 0.9 * n) * (0.4 + 1.6 * pow(core, 4.0));
  col *= 1.0 - dust * 0.85;
  // grainy unresolved stars inside the band
  float grain = smoothstep(0.62, 0.9, texture(tNoise, d * 9.0).r);
  col += vec3(0.9, 0.9, 1.0) * grain * band * 0.25;
  for (int i = 0; i < 3; i++) {
    float a = max(dot(d, uNebDir[i]), 0.0);
    float shape = smoothstep(1.0 - uNebSize[i], 1.0, a);
    float tex = fbm(d * 3.0 + float(i) * 7.1);
    float wisps = smoothstep(0.35, 0.75, tex) * shape;
    col += uNebColor[i] * wisps * (0.6 + tex);
  }
  gl_FragColor = vec4(col * uBrightness, 1.0);
}`;

const STAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aMag;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uScale;
void main() {
  vColor = aColor * aMag;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(1.4 + aMag * 2.6, 1.0, 6.0) * uScale;
  #include <logdepthbuf_vertex>
}`;

const STAR_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
uniform float uBrightness;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float core = exp(-r * r * 40.0);
  float halo = exp(-r * 9.0) * 0.25;
  float a = core + halo;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * uBrightness, 1.0);
}`;

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private bgStars: THREE.Points;
  private nearStars: THREE.Points | null = null;
  private domeMat: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;

  constructor(noise: THREE.Data3DTexture, galaxySeed: number) {
    const rng = new Rng(hash32(galaxySeed, 99));
    const galNormal = new THREE.Vector3(0.18, 0.95, -0.25).normalize();
    const galCore = new THREE.Vector3(0.85, -0.05, 0.5).projectOnPlane(galNormal).normalize();
    const nebDirs: THREE.Vector3[] = [], nebCols: THREE.Vector3[] = [], nebSizes: number[] = [];
    const palette = [[0.5, 0.12, 0.35], [0.1, 0.3, 0.5], [0.45, 0.2, 0.08], [0.15, 0.4, 0.35], [0.3, 0.15, 0.55]];
    for (let i = 0; i < 3; i++) {
      nebDirs.push(new THREE.Vector3(rng.range(-1, 1), rng.range(-0.6, 0.6), rng.range(-1, 1)).normalize());
      const c = rng.pick(palette);
      nebCols.push(new THREE.Vector3(c[0], c[1], c[2]).multiplyScalar(0.012));
      nebSizes.push(rng.range(0.05, 0.16));
    }
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        tNoise: { value: noise }, uGalNormal: { value: galNormal }, uGalCore: { value: galCore },
        uNebDir: { value: nebDirs }, uNebColor: { value: nebCols }, uNebSize: { value: nebSizes },
        uBrightness: { value: 0.006 }, uSkyRot: { value: new THREE.Matrix3() },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 64, 32), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;

    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uBrightness: { value: 0.02 }, uScale: { value: 1 } },
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    // background stars, denser toward the galactic band
    const n = 7000;
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
    let i = 0;
    while (i < n) {
      const v = new THREE.Vector3(rng.gaussian(), rng.gaussian(), rng.gaussian()).normalize();
      const lat = v.dot(galNormal);
      if (rng.next() > 0.35 + 0.65 * Math.exp(-lat * lat / 0.05)) continue;
      v.multiplyScalar(SKY_R * 0.9);
      pos.set([v.x, v.y, v.z], i * 3);
      const m = Math.pow(rng.next(), 6);
      mag[i] = 0.08 + m * 1.6;
      const c = kelvinToRGB(rng.range(2800, 14000));
      col.set(c, i * 3);
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.bgStars = new THREE.Points(g, this.starMat);
    this.bgStars.frustumCulled = false;
    this.bgStars.renderOrder = -99;
    this.group.add(this.dome, this.bgStars);
    this.group.name = 'sky';
  }

  /** Real neighbouring stars in their galactic directions from the current system. */
  setNeighbours(from: [number, number, number], stars: StarSummary[], excludeId: string): void {
    if (this.nearStars) {
      this.nearStars.geometry.dispose();
      this.group.remove(this.nearStars);
    }
    const list = stars.filter((s) => s.id !== excludeId);
    const pos = new Float32Array(list.length * 3), mag = new Float32Array(list.length), col = new Float32Array(list.length * 3);
    list.forEach((s, i) => {
      const v = new THREE.Vector3(s.pos[0] - from[0], s.pos[1] - from[1], s.pos[2] - from[2]);
      const d = Math.max(0.5, v.length());
      v.normalize().multiplyScalar(SKY_R * 0.85);
      pos.set([v.x, v.y, v.z], i * 3);
      const lum = { M: 0.3, K: 0.6, G: 1, F: 1.6, A: 3, B: 8, RG: 6 }[s.spectral];
      mag[i] = Math.min(2.2, 0.35 + (lum * 30) / (d * d) * 6);
      const t = { M: 3200, K: 4500, G: 5700, F: 6700, A: 8500, B: 15000, RG: 3800 }[s.spectral];
      col.set(kelvinToRGB(t), i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.nearStars = new THREE.Points(g, this.starMat);
    this.nearStars.frustumCulled = false;
    this.nearStars.renderOrder = -98;
    this.group.add(this.nearStars);
  }

  /** Orientation of the sky in render space (frame rotation). */
  setRotation(q: THREE.Quaternion, pixelScale: number): void {
    this.group.quaternion.copy(q);
    this.group.updateMatrixWorld();
    this.domeMat.uniforms.uSkyRot.value.identity();
    this.starMat.uniforms.uScale.value = pixelScale;
  }
}

import * as THREE from 'three';
import type { BodyDef, StarDef } from '../universe/types';
import type { BakeResult } from '../planet/tilegen';

/**
 * Renderers for celestial bodies seen from afar: the star (animated
 * photosphere + corona glow), rocky planets (baked albedo/height, oceans,
 * clouds, atmospheric rim), gas giants (procedural bands and storms) and rings
 * (with planet shadow).
 */

const COMMON_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const STAR_FRAG = /* glsl */ `
precision highp sampler3D;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler3D tNoise;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(-vPosW);
  float mu = max(dot(normalize(vNormalW), V), 0.0);
  vec3 p = normalize(vLocal);
  float g = texture(tNoise, p * 3.0 + vec3(uTime * 0.004)).r * 0.6 + texture(tNoise, p * 9.0 - vec3(uTime * 0.01)).r * 0.4;
  float limb = 0.35 + 0.65 * pow(mu, 0.45);
  vec3 c = uColor * (0.75 + 0.5 * g) * limb;
  gl_FragColor = vec4(c * uIntensity, 1.0);
}`;

const GLOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mvCenter.xy += position.xy * scale;
  gl_Position = projectionMatrix * mvCenter;
  #include <logdepthbuf_vertex>
}`;

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float corona = exp(-r * 7.0) * 1.2 + exp(-r * 2.6) * 0.18;
  float rays = pow(abs(sin(a * 7.0 + uTime * 0.05)) * abs(sin(a * 3.0 - uTime * 0.03)), 6.0) * exp(-r * 4.0) * 0.35;
  float v = (corona + rays) * smoothstep(1.0, 0.6, r);
  gl_FragColor = vec4(uColor * v * uIntensity, 1.0);
}`;

const PLANET_FRAG = /* glsl */ `
precision highp sampler3D;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tBake;
uniform sampler3D tNoise;
uniform int uHasBake;
uniform int uGas;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAtmoColor;
uniform float uAtmo;
uniform float uClouds;
uniform float uTime;
uniform float uSeed;
uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uRingShadowN;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;

vec2 equirect(vec3 d) {
  float lon = atan(-d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(-vPosW);
  vec3 d = normalize(vLocal);
  vec3 alb;
  float water = 0.0;
  vec3 Nshade = N;
  if (uGas == 1) {
    float turb = texture(tNoise, d * 1.6 + vec3(uSeed, 0.0, uTime * 0.002)).r;
    float lat = d.y + (turb - 0.5) * 0.18;
    float bands = sin(lat * 22.0 + uSeed) * 0.5 + 0.5;
    float bands2 = sin(lat * 57.0 + uSeed * 2.0) * 0.5 + 0.5;
    alb = mix(uColorA, uColorB, bands * 0.75 + bands2 * 0.25);
    float fine = texture(tNoise, vec3(d.x * 4.0 + uTime * 0.003 * sign(sin(lat * 22.0)), d.y * 14.0, d.z * 4.0)).r;
    alb *= 0.8 + 0.4 * fine;
    // great storm
    vec3 sc = normalize(vec3(cos(uSeed), -0.35, sin(uSeed)));
    float st = smoothstep(0.985, 0.998, dot(d, sc));
    alb = mix(alb, uColorB * vec3(1.25, 0.8, 0.7), st * 0.8);
  } else if (uHasBake == 1) {
    vec2 uv = equirect(d);
    vec4 b = texture(tBake, uv);
    alb = pow(b.rgb, vec3(2.2));
    water = b.a < 0.002 ? 1.0 : 0.0;
    if (water > 0.5) alb = vec3(0.01, 0.035, 0.07);
    // relief normal from height
    vec2 px = vec2(1.0 / 512.0, 1.0 / 256.0);
    float hx = texture(tBake, uv + vec2(px.x, 0.0)).a - texture(tBake, uv - vec2(px.x, 0.0)).a;
    float hy = texture(tBake, uv + vec2(0.0, px.y)).a - texture(tBake, uv - vec2(0.0, px.y)).a;
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), N) + 1e-4);
    vec3 bt = cross(N, t);
    Nshade = normalize(N - (t * hx + bt * -hy) * 6.0 * (1.0 - water));
  } else {
    alb = uColorA;
  }
  float ndl = dot(Nshade, uSunDir);
  float lit = max(ndl, 0.0);
  vec3 col = alb * uSunColor * lit / PI;
  if (water > 0.5) {
    vec3 H = normalize(V + uSunDir);
    col += uSunColor * pow(max(dot(N, H), 0.0), 120.0) * 0.6 * step(0.0, ndl);
  }
  if (uClouds > 0.0) {
    float c = texture(tNoise, d * 2.2 + vec3(uTime * 0.001, 0.0, uSeed)).r * 0.65 + texture(tNoise, d * 6.0).r * 0.35;
    float cov = smoothstep(1.0 - uClouds, 1.0 - uClouds + 0.25, c);
    col = mix(col, uSunColor * max(dot(N, uSunDir), 0.0) / PI * 0.95, cov);
  }
  // shadow cast by rings
  // atmospheric rim + scattering tint
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float sunFacing = smoothstep(-0.25, 0.4, dot(N, uSunDir));
  col = col * (1.0 - uAtmo * 0.25) + uAtmoColor * uSunColor * (fres * 1.2 + 0.12) * sunFacing * uAtmo * 0.08;
  gl_FragColor = vec4(col, 1.0);
}`;

const RIM_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAtmoColor;
uniform float uAtmo;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(-vPosW);
  float rim = 1.0 - abs(dot(N, V));
  float glow = pow(rim, 5.0) * smoothstep(1.0, 0.86, rim);
  float sun = smoothstep(-0.35, 0.3, dot(N, uSunDir));
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  vec3 c = uAtmoColor * uSunColor * glow * (sun + fwd * 2.0) * uAtmo * 0.15;
  gl_FragColor = vec4(c, 1.0);
}`;

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const RING_FRAG = /* glsl */ `
precision highp sampler3D;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler3D tNoise;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uInner;
uniform float uOuter;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCenter;
uniform float uPlanetR;
uniform float uSeed;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vLocal.xy);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float n1 = texture(tNoise, vec3(t * 2.0, uSeed * 0.1, 0.5)).r;
  float n2 = texture(tNoise, vec3(t * 9.0, uSeed * 0.1 + 0.3, 0.2)).r;
  // band-limit fine ringlets by their screen-space frequency to avoid moire
  float fw = fwidth(t);
  float fine = 1.0 - smoothstep(0.004, 0.012, fw);
  float mid = 1.0 - smoothstep(0.015, 0.045, fw);
  float bands = 0.55 + 0.25 * sin(t * 140.0 + n1 * 6.0) * fine + 0.2 * sin(t * 37.0 + n2 * 4.0) * mid;
  float dens = clamp(bands * (0.35 + n1 * 0.9), 0.0, 1.0) * smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.92, t);
  dens *= 1.0 - smoothstep(0.55, 0.6, t) * smoothstep(0.66, 0.6, t) * 0.9; // gap
  // planet shadow
  vec3 p = vPosW - uCenter;
  float b = dot(p, uSunDir);
  float shadow = 1.0;
  if (b < 0.0) {
    float d2 = dot(p, p) - b * b;
    shadow = smoothstep(uPlanetR * 0.97, uPlanetR * 1.03, sqrt(max(d2, 0.0)));
  }
  vec3 V = normalize(-vPosW);
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 4.0);
  vec3 c = uColor * (0.5 + n2 * 0.5) * uSunColor * (0.08 + fwd * 0.5) * shadow / PI;
  float a = dens * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c * a, a);
}`;

export class StarMesh {
  readonly group = new THREE.Group();
  private sphere: THREE.Mesh;
  private glow: THREE.Mesh;
  private sMat: THREE.ShaderMaterial;
  private gMat: THREE.ShaderMaterial;
  readonly star: StarDef;

  constructor(star: StarDef, noise: THREE.Data3DTexture) {
    this.star = star;
    const color = new THREE.Vector3(...star.color);
    this.sMat = new THREE.ShaderMaterial({
      vertexShader: COMMON_VERT, fragmentShader: STAR_FRAG,
      uniforms: { tNoise: { value: noise }, uColor: { value: color }, uIntensity: { value: 3000 }, uTime: { value: 0 } },
    });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(star.radius, 64, 32), this.sMat);
    this.gMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      uniforms: { uColor: { value: color.clone() }, uIntensity: { value: 40 }, uTime: { value: 0 } },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.gMat);
    this.glow.scale.setScalar(star.radius * 6);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.sphere.frustumCulled = false;
    this.group.add(this.sphere, this.glow);
  }

  private glowFactor = 1;
  setGlow(f: number): void {
    this.glowFactor = f;
    this.glow.visible = f > 0.01;
  }

  update(t: number, distance: number): void {
    this.sMat.uniforms.uTime.value = t;
    this.gMat.uniforms.uTime.value = t;
    // keep the glow perceptible from the far edges of the system, but never let the
    // billboard exceed ~40 degrees of sky when close to the star
    const k = Math.min(4, Math.max(1, distance / 1.5e6));
    const size = Math.min(this.star.radius * 6 * k, distance * 0.35);
    this.glow.scale.setScalar(size);
    const lum = Math.min(3, Math.sqrt(this.star.luminosity));
    this.gMat.uniforms.uIntensity.value = (40 / (k * k)) * this.glowFactor * lum;
  }

  dispose(): void {
    this.sphere.geometry.dispose();
    this.glow.geometry.dispose();
    this.sMat.dispose();
    this.gMat.dispose();
  }
}

export function atmosphereColor(def: BodyDef): THREE.Vector3 {
  if (!def.atmosphere) return new THREE.Vector3();
  const r = def.atmosphere.rayleigh;
  const m = Math.max(r[0], r[1], r[2]);
  return new THREE.Vector3(r[0] / m, r[1] / m, r[2] / m);
}

export class DistantBody {
  readonly def: BodyDef;
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private rim: THREE.Mesh | null = null;
  private rimMat: THREE.ShaderMaterial | null = null;
  private ring: THREE.Mesh | null = null;
  private ringMat: THREE.ShaderMaterial | null = null;
  private bakeTex: THREE.DataTexture | null = null;

  constructor(def: BodyDef, noise: THREE.Data3DTexture) {
    this.def = def;
    const gas = def.type === 'gas_giant';
    const atmo = def.atmosphere ? Math.min(1.5, def.atmosphere.pressure * 0.7 + 0.3) : 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: COMMON_VERT, fragmentShader: PLANET_FRAG,
      uniforms: {
        tBake: { value: null }, tNoise: { value: noise }, uHasBake: { value: 0 }, uGas: { value: gas ? 1 : 0 },
        uColorA: { value: new THREE.Vector3(...def.colorA) }, uColorB: { value: new THREE.Vector3(...def.colorB) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Vector3(6, 6, 6) },
        uAtmoColor: { value: atmosphereColor(def) }, uAtmo: { value: atmo }, uClouds: { value: def.atmosphere?.clouds ?? 0 },
        uTime: { value: 0 }, uSeed: { value: (def.id.length * 1.7 + def.radius * 0.001) % 6.28 },
        uCenter: { value: new THREE.Vector3() }, uRadius: { value: def.radius }, uRingShadowN: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(def.radius, 96, 64), this.mat);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    if (def.atmosphere && atmo > 0) {
      this.rimMat = new THREE.ShaderMaterial({
        vertexShader: COMMON_VERT, fragmentShader: RIM_FRAG,
        uniforms: { uSunDir: this.mat.uniforms.uSunDir, uSunColor: this.mat.uniforms.uSunColor, uAtmoColor: this.mat.uniforms.uAtmoColor, uAtmo: { value: atmo } },
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.BackSide,
      });
      this.rim = new THREE.Mesh(new THREE.SphereGeometry(def.radius * (gas ? 1.03 : 1.06), 64, 48), this.rimMat);
      this.rim.frustumCulled = false;
      this.group.add(this.rim);
    }
    if (def.rings) {
      const r = def.rings;
      this.ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: {
          tNoise: { value: noise }, uColor: { value: new THREE.Vector3(...r.color) }, uOpacity: { value: r.opacity },
          uInner: { value: r.inner }, uOuter: { value: r.outer }, uSunDir: this.mat.uniforms.uSunDir, uSunColor: this.mat.uniforms.uSunColor,
          uCenter: this.mat.uniforms.uCenter, uPlanetR: { value: def.radius }, uSeed: this.mat.uniforms.uSeed,
        },
        side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      this.ring = new THREE.Mesh(new THREE.RingGeometry(r.inner, r.outer, 256, 1), this.ringMat);
      this.ring.rotation.x = -Math.PI / 2;
      this.ring.frustumCulled = false;
      this.ring.renderOrder = 3;
      this.group.add(this.ring);
    }
  }

  setBake(b: BakeResult): void {
    const t = new THREE.DataTexture(b.data, b.width, b.height, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    this.bakeTex = t;
    this.mat.uniforms.tBake.value = t;
    this.mat.uniforms.uHasBake.value = 1;
  }

  update(time: number, sunDir: THREE.Vector3, sunColor: THREE.Vector3): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uSunDir.value.copy(sunDir);
    this.mat.uniforms.uSunColor.value.copy(sunColor);
    this.mat.uniforms.uCenter.value.copy(this.group.position);
  }

  /** Hide the solid sphere but keep rings (used when the body is the LOD focus). */
  setSurfaceVisible(v: boolean): void {
    this.mesh.visible = v;
    if (this.rim) this.rim.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.rim?.geometry.dispose();
    this.rimMat?.dispose();
    this.ring?.geometry.dispose();
    this.ringMat?.dispose();
    this.bakeTex?.dispose();
  }
}

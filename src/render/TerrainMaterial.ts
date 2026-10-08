import * as THREE from 'three';
import { LAYERS, isRockLike } from '../voxel/palette';
import { LAYER_COUNT, BLOCKS, B, L } from '../voxel/blocks';
import type { TextureSet } from './textureGen';

/**
 * Voxel terrain material. Extends MeshStandardMaterial (shadows, IBL, lights)
 * with:
 *   - albedo/material texture arrays sampled per block with textureGrad
 *   - tangent-space normal maps and per-layer roughness/metalness/emission
 *   - per-vertex ambient occlusion and sky exposure (dark caves)
 *   - planet-space macro variation to break tiling
 *   - planet-specific vegetation tint, rain wetness and scanner pulses
 */

export interface TerrainUniforms {
  tAlbedo: THREE.IUniform<THREE.DataArrayTexture | null>;
  tMaterial: THREE.IUniform<THREE.DataArrayTexture | null>;
  tNoise: THREE.IUniform<THREE.Data3DTexture | null>;
  uLayerProps: THREE.IUniform<THREE.Vector4[]>;
  uBioTint: THREE.IUniform<THREE.Vector3>;
  uRockTint: THREE.IUniform<THREE.Vector3>;
  uRenderToPlanet: THREE.IUniform<THREE.Matrix4>;
  uWetness: THREE.IUniform<number>;
  uUpView: THREE.IUniform<THREE.Vector3>;
  uScanCenter: THREE.IUniform<THREE.Vector3>;
  uScanRadius: THREE.IUniform<number>;
  uScanStrength: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uSkyAmbient: THREE.IUniform<number>;
  tBlockLayers: THREE.IUniform<THREE.DataTexture | null>;
  uTexScale: THREE.IUniform<number>;
}

/**
 * Per-block lookup for the smooth terrain: [top layer, slope layer, bottom layer, 0].
 * On a smooth surface the "side" of a block is the look of its steep slopes.
 */
export function makeBlockLayerTexture(): THREE.DataTexture {
  const d = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const b = BLOCKS[i];
    let side = b.side;
    if (i === B.MOSS) side = L.SOIL;
    if (i === B.SNOW) side = L.SNOW;
    d[i * 4] = b.top; d[i * 4 + 1] = side; d[i * 4 + 2] = b.bottom; d[i * 4 + 3] = 0;
  }
  const t = new THREE.DataTexture(d, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export function makeLayerProps(): THREE.Vector4[] {
  const ore = new Set<number>();
  for (const b of BLOCKS) if (b.ore) { ore.add(b.top); ore.add(b.side); }
  const out: THREE.Vector4[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    const m = LAYERS[i];
    const rotatable = ['rock', 'basalt', 'soil', 'moss', 'sand', 'snow', 'ice', 'ore', 'crystal', 'carbon', 'lava', 'regolith', 'ash', 'mud', 'bedrock', 'leaves', 'coral', 'fungus'].includes(m.pattern);
    const flags = (isRockLike(m.pattern) ? 1 : 0) | (ore.has(i) ? 2 : 0) | (rotatable ? 4 : 0);
    out.push(new THREE.Vector4(m.metalness, m.emissive, m.opacity, flags));
  }
  return out;
}

export function makeArrayTextures(set: TextureSet, anisotropy: number): { albedo: THREE.DataArrayTexture; material: THREE.DataArrayTexture } {
  const albedo = new THREE.DataArrayTexture(set.albedo, set.size, set.size, set.layers);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = true;
  albedo.anisotropy = anisotropy;
  albedo.needsUpdate = true;
  const material = new THREE.DataArrayTexture(set.material, set.size, set.size, set.layers);
  material.format = THREE.RGBAFormat;
  material.type = THREE.UnsignedByteType;
  material.colorSpace = THREE.NoColorSpace;
  material.wrapS = material.wrapT = THREE.RepeatWrapping;
  material.minFilter = THREE.LinearMipmapLinearFilter;
  material.magFilter = THREE.LinearFilter;
  material.generateMipmaps = true;
  material.anisotropy = anisotropy;
  material.needsUpdate = true;
  return { albedo, material };
}

export function createTerrainMaterial(uniforms: TerrainUniforms, translucent: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: translucent,
    depthWrite: !translucent,
    envMapIntensity: 1,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = shader.defines ?? {};
    shader.defines.LAYER_COUNT = LAYER_COUNT;
    if (translucent) shader.defines.TRANSLUCENT = 1;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aTangent;
attribute vec2 aBlockUv;
attribute vec4 aData;
uniform mat4 uRenderToPlanet;
varying vec2 vBlockUv;
varying vec3 vData;
varying vec4 vTangentV;
varying vec3 vPlanetPos;
varying vec3 vRenderPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBlockUv = aBlockUv;
vData = aData.xyz;
vTangentV = vec4(normalize(normalMatrix * aTangent.xyz), aTangent.w);
vec4 wp4 = modelMatrix * vec4(position, 1.0);
vRenderPos = wp4.xyz;
vPlanetPos = (uRenderToPlanet * wp4).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
precision highp sampler3D;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tMaterial;
uniform sampler3D tNoise;
uniform vec4 uLayerProps[LAYER_COUNT];
uniform vec3 uBioTint;
uniform vec3 uRockTint;
uniform float uWetness;
uniform vec3 uUpView;
uniform vec3 uScanCenter;
uniform float uScanRadius;
uniform float uScanStrength;
uniform float uTime;
uniform float uSkyAmbient;
varying vec2 vBlockUv;
varying vec3 vData;
varying vec4 vTangentV;
varying vec3 vPlanetPos;
varying vec3 vRenderPos;
vec4 gAlb; vec4 gMat; vec4 gProps; float gWet; mat2 gRot;`)
      .replace('#include <map_fragment>', `
float layerF = floor(vData.x + 0.5);
gProps = uLayerProps[int(layerF)];
int lflags = int(gProps.w + 0.5);
// per-block identity from global grid coordinates
vec2 cell = floor(vBlockUv);
uvec2 uc = uvec2(ivec2(cell) + 32768);
uint hh = uc.x * 1664525u ^ (uc.y * 22695477u + uint(layerF) * 2654435761u);
hh ^= hh >> 15; hh *= 2246822519u; hh ^= hh >> 13;
float h1 = float(hh & 1023u) / 1023.0;
float h2 = float((hh >> 10) & 1023u) / 1023.0;
vec2 fuv = fract(vBlockUv);
vec2 dUx = dFdx(vBlockUv), dUy = dFdy(vBlockUv);
mat2 rot = mat2(1.0, 0.0, 0.0, 1.0);
if ((lflags & 4) != 0) {
  int r = int(hh >> 20) & 3;
  rot = r == 0 ? mat2(1.0, 0.0, 0.0, 1.0) : r == 1 ? mat2(0.0, 1.0, -1.0, 0.0) : r == 2 ? mat2(-1.0, 0.0, 0.0, -1.0) : mat2(0.0, -1.0, 1.0, 0.0);
  fuv = rot * (fuv - 0.5) + 0.5;
  dUx = rot * dUx; dUy = rot * dUy;
}
gRot = rot;
vec3 tuv = vec3(fuv, layerF);
gAlb = textureGrad(tAlbedo, tuv, dUx, dUy);
gMat = textureGrad(tMaterial, tuv, dUx, dUy);
vec3 alb = gAlb.rgb;
// subtle per-block tone variation so repeated blocks never look stamped
alb *= 0.9 + 0.2 * h1;
alb = mix(alb, alb * vec3(1.04, 0.98, 0.94), (h2 - 0.5) * 0.5);
alb = mix(alb, alb * uBioTint * 1.6, gAlb.a);
if ((lflags & 1) != 0) alb *= uRockTint;
// macro variation in planet space
float mn = texture(tNoise, vPlanetPos * 0.0071).r * 0.65 + texture(tNoise, vPlanetPos * 0.031).r * 0.35;
alb *= 0.8 + 0.4 * mn;
// rain wetness on upward faces
float upF = clamp(dot(normalize(vNormal), uUpView), 0.0, 1.0);
gWet = uWetness * smoothstep(0.3, 0.9, upF) * (1.0 - gProps.x) * (0.6 + 0.4 * texture(tNoise, vPlanetPos * 0.05).r);
alb *= 1.0 - gWet * 0.45;
diffuseColor.rgb *= alb;
#ifdef TRANSLUCENT
diffuseColor.a = gProps.z;
#endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(gMat.b, 0.08, gWet);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = gProps.x;`)
      .replace('#include <normal_fragment_maps>', `
{
  vec3 mapN = vec3(gMat.rg * 2.0 - 1.0, 0.0);
  mapN.xy = transpose(gRot) * mapN.xy;
  mapN.xy *= 1.0 - gWet * 0.6;
  mapN.z = sqrt(max(0.0, 1.0 - dot(mapN.xy, mapN.xy)));
  vec3 Nn = normal;
  vec3 T = normalize(vTangentV.xyz - Nn * dot(Nn, vTangentV.xyz));
  vec3 Bt = cross(Nn, T) * (vTangentV.w >= 0.0 ? 1.0 : -1.0);
  normal = normalize(mat3(T, Bt, Nn) * mapN);
}`)
      .replace('#include <emissivemap_fragment>', `
totalEmissiveRadiance = gAlb.rgb * gProps.y * gMat.a;
if (uScanStrength > 0.0) {
  float dist = length(vRenderPos - uScanCenter);
  float ring = exp(-pow((dist - uScanRadius) / 1.4, 2.0)) * uScanStrength;
  totalEmissiveRadiance += vec3(0.2, 0.9, 1.0) * ring * 1.5;
  if ((lflags & 2) != 0 && dist < uScanRadius) {
    float pulse = 0.6 + 0.4 * sin(uTime * 6.0 - dist * 0.4);
    totalEmissiveRadiance += mix(vec3(0.3, 1.0, 0.9), gAlb.rgb * 2.0, 0.5) * uScanStrength * pulse * 2.5;
  }
}`)
      .replace('#include <aomap_fragment>', `
{
  float vao = mix(0.25, 1.0, clamp(vData.y / 3.0, 0.0, 1.0));
  vao = vao * vao * (3.0 - 2.0 * vao);
  float sky = clamp(vData.z / 15.0, 0.0, 1.0);
  float skyAmb = mix(uSkyAmbient, 1.0, sky * sky);
  reflectedLight.indirectDiffuse *= vao * skyAmb;
  reflectedLight.indirectSpecular *= vao * skyAmb;
  reflectedLight.directDiffuse *= mix(0.7, 1.0, vao);
}`);
  };
  mat.customProgramCacheKey = () => (translucent ? 'terrain-t' : 'terrain-o');
  return mat;
}

/**
 * Smooth natural terrain: triplanar-mapped procedural PBR layers, up to three
 * materials blended per triangle (barycentric weights from gl_VertexID), slope
 * aware top/side layers, field ambient occlusion and sky exposure.
 */
export function createSmoothTerrainMaterial(uniforms: TerrainUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 1 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = shader.defines ?? {};
    shader.defines.LAYER_COUNT = LAYER_COUNT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMats;
attribute vec4 aData;
uniform mat4 uRenderToPlanet;
flat varying vec3 vMats;
varying vec3 vBary;
varying vec2 vAoSky;
varying vec3 vPlanetPos;
varying vec3 vPlanetNormal;
varying vec3 vRenderPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
int vid = gl_VertexID % 3;
vBary = vec3(vid == 0 ? 1.0 : 0.0, vid == 1 ? 1.0 : 0.0, vid == 2 ? 1.0 : 0.0);
vMats = aMats.xyz;
vAoSky = aData.xy / 255.0;
vec4 wp4 = modelMatrix * vec4(position, 1.0);
vRenderPos = wp4.xyz;
vPlanetPos = (uRenderToPlanet * wp4).xyz;
vPlanetNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
precision highp sampler3D;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tMaterial;
uniform sampler3D tNoise;
uniform sampler2D tBlockLayers;
uniform vec4 uLayerProps[LAYER_COUNT];
uniform vec3 uBioTint;
uniform vec3 uRockTint;
uniform float uWetness;
uniform vec3 uScanCenter;
uniform float uScanRadius;
uniform float uScanStrength;
uniform float uTime;
uniform float uSkyAmbient;
uniform float uTexScale;
uniform mat4 uRenderToPlanet;
flat varying vec3 vMats;
varying vec3 vBary;
varying vec2 vAoSky;
varying vec3 vPlanetPos;
varying vec3 vPlanetNormal;
varying vec3 vRenderPos;
vec3 gNP; float gRough; float gMetal; vec3 gEmit; float gWet; float gOre;
vec3 gTW; vec3 gP;

// triplanar sample of one layer: albedo (rgb + tint mask) and material (normal xy, rough, emissive)
void triLayer(float layer, out vec4 alb, out vec4 mat, out vec3 nrm) {
  alb = vec4(0.0); mat = vec4(0.0); nrm = vec3(0.0);
  if (gTW.x > 0.02) {
    vec4 a = texture(tAlbedo, vec3(gP.zy, layer)); vec4 m = texture(tMaterial, vec3(gP.zy, layer));
    alb += a * gTW.x; mat += m * gTW.x; vec2 t = m.rg * 2.0 - 1.0; nrm += vec3(0.0, t.y, t.x) * gTW.x;
  }
  if (gTW.y > 0.02) {
    vec4 a = texture(tAlbedo, vec3(gP.xz, layer)); vec4 m = texture(tMaterial, vec3(gP.xz, layer));
    alb += a * gTW.y; mat += m * gTW.y; vec2 t = m.rg * 2.0 - 1.0; nrm += vec3(t.x, 0.0, t.y) * gTW.y;
  }
  if (gTW.z > 0.02) {
    vec4 a = texture(tAlbedo, vec3(gP.xy, layer)); vec4 m = texture(tMaterial, vec3(gP.xy, layer));
    alb += a * gTW.z; mat += m * gTW.z; vec2 t = m.rg * 2.0 - 1.0; nrm += vec3(t.x, t.y, 0.0) * gTW.z;
  }
  float s = gTW.x * step(0.02, gTW.x) + gTW.y * step(0.02, gTW.y) + gTW.z * step(0.02, gTW.z);
  alb /= s; mat /= s; nrm /= s;
}

// one block material: top layer on flat ground, slope layer on steep faces
void blockSample(float id, float slopeK, out vec3 col, out vec4 mat, out vec3 nrm, out vec4 props) {
  vec4 lay = texelFetch(tBlockLayers, ivec2(int(id + 0.5), 0), 0) * 255.0;
  float topL = floor(lay.x + 0.5), sideL = floor(lay.y + 0.5);
  vec4 a; vec4 m; vec3 n;
  if (topL == sideL || slopeK > 0.98) { triLayer(topL, a, m, n); props = uLayerProps[int(topL)]; }
  else if (slopeK < 0.02) { triLayer(sideL, a, m, n); props = uLayerProps[int(sideL)]; }
  else {
    vec4 a2; vec4 m2; vec3 n2;
    triLayer(topL, a, m, n); triLayer(sideL, a2, m2, n2);
    // height-aware transition: the top layer survives in the hollows first
    float k = smoothstep(0.0, 1.0, clamp(slopeK + (a.a - 0.5) * 0.3, 0.0, 1.0));
    a = mix(a2, a, k); m = mix(m2, m, k); n = mix(n2, n, k);
    props = mix(uLayerProps[int(sideL)], uLayerProps[int(topL)], k);
  }
  col = a.rgb;
  col = mix(col, col * uBioTint * 1.6, a.a);
  int fl = int(props.w + 0.5);
  if ((fl & 1) != 0) col *= uRockTint;
  mat = m; nrm = n;
}`)
      .replace('#include <map_fragment>', `
{
  vec3 Np = normalize(vPlanetNormal);
  vec3 upP = normalize(vPlanetPos);
  float slope = dot(Np, upP);
  float slopeK = smoothstep(0.62, 0.86, slope);
  gTW = pow(abs(Np), vec3(4.0));
  gTW /= gTW.x + gTW.y + gTW.z;
  gP = vPlanetPos * uTexScale;
  // barycentric material weights, sharpened so blends stay narrow and natural
  vec3 w = pow(vBary, vec3(2.2));
  float m0 = vMats.x, m1 = vMats.y, m2 = vMats.z;
  if (m1 == m0) { w.x += w.y; w.y = 0.0; }
  if (m2 == m0) { w.x += w.z; w.z = 0.0; } else if (m2 == m1) { w.y += w.z; w.z = 0.0; }
  w /= w.x + w.y + w.z;
  vec3 col = vec3(0.0); vec4 mt = vec4(0.0); vec3 nr = vec3(0.0); vec4 pr = vec4(0.0);
  vec3 c; vec4 mm; vec3 nn; vec4 pp;
  blockSample(m0, slopeK, c, mm, nn, pp); col += c * w.x; mt += mm * w.x; nr += nn * w.x; pr += pp * w.x;
  if (w.y > 0.01) { blockSample(m1, slopeK, c, mm, nn, pp); col += c * w.y; mt += mm * w.y; nr += nn * w.y; pr += pp * w.y; }
  if (w.z > 0.01) { blockSample(m2, slopeK, c, mm, nn, pp); col += c * w.z; mt += mm * w.z; nr += nn * w.z; pr += pp * w.z; }
  // large-scale variation so tiling never reads
  float mn = texture(tNoise, vPlanetPos * 0.0071).r * 0.65 + texture(tNoise, vPlanetPos * 0.031).r * 0.35;
  float fine = texture(tNoise, vPlanetPos * 0.17).r;
  col *= 0.78 + 0.4 * mn;
  col *= 0.92 + 0.16 * fine;
  // wet ground in rain (flat areas first)
  gWet = uWetness * smoothstep(0.55, 0.9, slope) * (1.0 - pr.x) * (0.6 + 0.4 * texture(tNoise, vPlanetPos * 0.05).r);
  col *= 1.0 - gWet * 0.45;
  diffuseColor.rgb *= col;
  gRough = mix(mt.b, 0.08, gWet);
  gMetal = pr.x;
  gEmit = col * pr.y * mt.a;
  gOre = (int(pr.w + 0.5) & 2) != 0 ? 1.0 : 0.0;
  nr *= 1.0 - gWet * 0.6;
  gNP = normalize(Np + nr * 0.9);
}`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = gMetal;`)
      .replace('#include <normal_fragment_maps>', `
normal = normalize(mat3(viewMatrix) * (transpose(mat3(uRenderToPlanet)) * gNP));`)
      .replace('#include <emissivemap_fragment>', `
totalEmissiveRadiance = gEmit;
if (uScanStrength > 0.0) {
  float dist = length(vRenderPos - uScanCenter);
  float ring = exp(-pow((dist - uScanRadius) / 1.4, 2.0)) * uScanStrength;
  totalEmissiveRadiance += vec3(0.2, 0.9, 1.0) * ring * 1.5;
  if (gOre > 0.5 && dist < uScanRadius) {
    float pulse = 0.6 + 0.4 * sin(uTime * 6.0 - dist * 0.4);
    totalEmissiveRadiance += vec3(0.3, 1.0, 0.9) * uScanStrength * pulse * 2.5;
  }
}`)
      .replace('#include <aomap_fragment>', `
{
  float vao = clamp(vAoSky.x, 0.0, 1.0);
  vao = vao * vao * (3.0 - 2.0 * vao);
  float sky = clamp(vAoSky.y, 0.0, 1.0);
  float skyAmb = mix(uSkyAmbient, 1.0, sky * sky);
  reflectedLight.indirectDiffuse *= vao * skyAmb;
  reflectedLight.indirectSpecular *= vao * skyAmb;
  reflectedLight.directDiffuse *= mix(0.75, 1.0, vao);
}`);
  };
  mat.customProgramCacheKey = () => 'terrain-smooth';
  return mat;
}

/** Builds a BufferGeometry from smooth mesher output (non-indexed). */
export function buildSmoothGeometry(m: { position: Float32Array; normal: Int8Array; mats: Uint8Array; data: Uint8Array }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3, true));
  g.setAttribute('aMats', new THREE.BufferAttribute(m.mats, 4, false));
  g.setAttribute('aData', new THREE.BufferAttribute(m.data, 4, false));
  g.computeBoundingSphere();
  return g;
}

/** Builds a BufferGeometry from mesher output. */
export function buildChunkGeometry(m: { position: Float32Array; normal: Int8Array; tangent: Int8Array; uv: Uint16Array; data: Uint8Array; index: Uint32Array | Uint16Array }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3, true));
  g.setAttribute('aTangent', new THREE.BufferAttribute(m.tangent, 4, true));
  g.setAttribute('aBlockUv', new THREE.BufferAttribute(m.uv, 2, false));
  g.setAttribute('aData', new THREE.BufferAttribute(m.data, 4, false));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere();
  return g;
}

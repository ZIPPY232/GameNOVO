import * as THREE from 'three';
import { LAYERS, isRockLike } from '../voxel/palette';
import { LAYER_COUNT, BLOCKS } from '../voxel/blocks';
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

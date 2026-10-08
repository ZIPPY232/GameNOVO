import * as THREE from 'three';
import { gridToDir } from './cubesphere';
import { buildTileIndex, TILE_RES } from './tilegen';
import type { TileResult } from './tilegen';
import type { WorkerPool } from '../voxel/workerProtocol';
import type { PlanetGenParams } from '../universe/types';

/**
 * Quadtree LOD over the six cube-sphere faces. Tiles are generated in workers
 * from the same height/biome functions as the voxels. Near the player, tile
 * fragments are discarded inside the radius covered by loaded voxel chunks so
 * the editable terrain takes over without overlap.
 */

interface Node {
  face: number;
  x0: number;
  y0: number;
  size: number;
  level: number;
  center: THREE.Vector3; // on datum sphere
  children: Node[] | null;
  mesh: THREE.Mesh | null;
  pending: boolean;
  dead: boolean;
  maxR: number;
}

let sharedIndex: THREE.BufferAttribute | null = null;

export interface LodUniforms {
  uDiscardDir: THREE.IUniform<THREE.Vector3>;
  uDiscardR: THREE.IUniform<number>;
  uPlanetR: THREE.IUniform<number>;
  uRenderToPlanet: THREE.IUniform<THREE.Matrix4>;
  tNoise: THREE.IUniform<THREE.Data3DTexture | null>;
}

export function createLodMaterial(u: LodUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform mat4 uRenderToPlanet;
varying vec3 vPlanetPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPlanetPos = (uRenderToPlanet * (modelMatrix * vec4(position, 1.0))).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler3D;
uniform vec3 uDiscardDir;
uniform float uDiscardR;
uniform float uPlanetR;
uniform sampler3D tNoise;
varying vec3 vPlanetPos;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (uDiscardR > 0.0) {
  float dd = length(normalize(vPlanetPos) - uDiscardDir) * uPlanetR;
  if (dd < uDiscardR) discard;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float mn = texture(tNoise, vPlanetPos * 0.0071).r * 0.65 + texture(tNoise, vPlanetPos * 0.031).r * 0.35;
float far = texture(tNoise, vPlanetPos * 0.0009).r;
diffuseColor.rgb *= (0.8 + 0.4 * mn) * (0.85 + 0.3 * far);`);
  };
  m.customProgramCacheKey = () => 'planet-lod';
  return m;
}

export class PlanetLOD {
  readonly group = new THREE.Group();
  private roots: Node[] = [];
  private pool: WorkerPool;
  private params: PlanetGenParams;
  private bodyId: string;
  private material: THREE.Material;
  private maxLevel: number;
  private cellMeters: number;
  disposed = false;
  detail = 1;
  readyRoots = 0;
  pendingTiles = 0;

  constructor(bodyId: string, params: PlanetGenParams, pool: WorkerPool, material: THREE.Material) {
    this.bodyId = bodyId;
    this.params = params;
    this.pool = pool;
    this.material = material;
    this.maxLevel = Math.max(2, Math.floor(Math.log2(params.N / 72)));
    this.cellMeters = (Math.PI * params.radius) / (2 * params.N);
    if (!sharedIndex) sharedIndex = new THREE.BufferAttribute(buildTileIndex(), 1);
    for (let f = 0; f < 6; f++) this.roots.push(this.makeNode(f, 0, 0, params.N, 0));
    this.group.name = 'lod:' + bodyId;
  }

  private makeNode(face: number, x0: number, y0: number, size: number, level: number): Node {
    const d = [0, 0, 0];
    gridToDir(face, x0 + size / 2, y0 + size / 2, this.params.N, d);
    const r = this.params.radius;
    return { face, x0, y0, size, level, center: new THREE.Vector3(d[0] * r, d[1] * r, d[2] * r), children: null, mesh: null, pending: false, dead: false, maxR: r + 400 };
  }

  private request(n: Node, priority: number): void {
    if (n.pending || n.mesh) return;
    n.pending = true;
    this.pendingTiles++;
    this.pool.run({ type: 'tile', bodyId: this.bodyId, face: n.face, x0: n.x0, y0: n.y0, size: n.size }, priority, [], () => n.dead || this.disposed)
      .then((res) => {
        n.pending = false;
        this.pendingTiles--;
        if (n.dead || this.disposed) return;
        const t = (res as unknown as { tile: TileResult }).tile;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3, true));
        g.setAttribute('color', new THREE.BufferAttribute(t.color, 3, true));
        g.setIndex(sharedIndex);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.material);
        m.position.set(t.center[0], t.center[1], t.center[2]);
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        m.receiveShadow = true;
        m.castShadow = false;
        m.visible = false;
        n.maxR = t.maxR;
        n.mesh = m;
        this.group.add(m);
        if (n.level === 0) this.readyRoots++;
      })
      .catch(() => {
        n.pending = false;
        this.pendingTiles--;
      });
  }

  private kill(n: Node): void {
    n.dead = true;
    if (n.mesh) {
      n.mesh.geometry.dispose();
      this.group.remove(n.mesh);
      n.mesh = null;
      if (n.level === 0) this.readyRoots--;
    }
    if (n.children) for (const c of n.children) this.kill(c);
    n.children = null;
  }

  /** Update visibility/splits for a camera at planet-local position. Returns true if the root level is complete. */
  update(cam: THREE.Vector3): boolean {
    const camR = cam.length();
    const R = this.params.radius;
    // horizon angle from camera (with margin for mountains)
    const hor = camR > R ? Math.acos(Math.min(1, R / camR)) + Math.acos(Math.min(1, R / (R + 600))) : Math.PI;
    const camDir = cam.clone().normalize();
    for (const r of this.roots) this.visit(r, cam, camDir, hor);
    return this.readyRoots === 6;
  }

  /** Returns true if this node (or its descendants) fully cover its area with visible meshes. */
  private visit(n: Node, cam: THREE.Vector3, camDir: THREE.Vector3, hor: number): boolean {
    const sizeM = n.size * this.cellMeters;
    const dist = Math.max(0, cam.distanceTo(n.center) - sizeM * 0.75);
    // horizon cull (angular)
    const ang = Math.acos(Math.max(-1, Math.min(1, n.center.dot(camDir) / n.center.length())));
    const angR = (sizeM * 0.75) / this.params.radius;
    const hidden = ang - angR > hor;
    const wantSplit = !hidden && n.level < this.maxLevel && dist < sizeM * 1.5 * this.detail;
    if (!n.mesh && !n.pending) this.request(n, n.level * 3 + dist / 2000 - 50);
    if (wantSplit) {
      if (!n.children) {
        const h = n.size / 2;
        n.children = [
          this.makeNode(n.face, n.x0, n.y0, h, n.level + 1),
          this.makeNode(n.face, n.x0 + h, n.y0, h, n.level + 1),
          this.makeNode(n.face, n.x0, n.y0 + h, h, n.level + 1),
          this.makeNode(n.face, n.x0 + h, n.y0 + h, h, n.level + 1),
        ];
      }
      let allReady = true;
      for (const c of n.children) {
        if (!c.mesh) { allReady = false; if (!c.pending) this.request(c, c.level * 3 + dist / 2000 - 50); }
      }
      if (allReady) {
        if (n.mesh) n.mesh.visible = false;
        let covered = true;
        for (const c of n.children) covered = this.visit(c, cam, camDir, hor) && covered;
        return covered;
      }
      // children not ready: keep showing this node
      for (const c of n.children) this.hideTree(c);
      if (n.mesh) n.mesh.visible = !hidden;
      return !!n.mesh;
    }
    if (n.children) {
      // merge: drop children
      for (const c of n.children) this.kill(c);
      n.children = null;
    }
    if (n.mesh) n.mesh.visible = !hidden;
    return !!n.mesh;
  }

  private hideTree(n: Node): void {
    if (n.mesh) n.mesh.visible = false;
    if (n.children) for (const c of n.children) this.hideTree(c);
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.roots) this.kill(r);
    this.group.removeFromParent();
  }
}

export { TILE_RES };

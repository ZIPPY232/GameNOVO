import * as THREE from 'three';
import { B } from '../voxel/blocks';
import { gridToPos } from '../planet/cubesphere';
import { hash32, hashFloat } from '../core/rng';
import type { VoxelPhysics } from '../physics/VoxelPhysics';

/**
 * Instanced alien grass on exposed moss tops around the player. Each tuft is
 * three crossed alpha-tested cards, tinted by the planet's vegetation colour
 * and swayed by wind in the vertex shader. Placement is deterministic per cell
 * (hash), so tufts never shuffle when the field is rebuilt.
 */

function bladeTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 22; i++) {
    const x = 8 + Math.random() * (S - 16);
    const h = S * (0.45 + Math.random() * 0.55);
    const w = 2 + Math.random() * 3.5;
    const bend = (Math.random() - 0.5) * 22;
    const grad = g.createLinearGradient(0, S, 0, S - h);
    const tone = 150 + Math.random() * 80;
    grad.addColorStop(0, `rgb(${tone * 0.45},${tone * 0.5},${tone * 0.45})`);
    grad.addColorStop(1, `rgb(${tone},${tone},${tone * 0.95})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, S);
    g.quadraticCurveTo(x + bend * 0.3, S - h * 0.6, x + bend, S - h);
    g.quadraticCurveTo(x + bend * 0.3 + w * 0.3, S - h * 0.6, x + w, S);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  return t;
}

function tuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.PlaneGeometry(0.9, 0.55, 1, 2);
    p.translate(0, 0.275, 0);
    p.rotateY((i / 3) * Math.PI);
    parts.push(p);
  }
  // merge manually (avoid pulling BufferGeometryUtils)
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  let off = 0;
  for (const p of parts) {
    const a = p.attributes;
    for (let i = 0; i < a.position.count; i++) {
      pos.push(a.position.getX(i), a.position.getY(i), a.position.getZ(i));
      uv.push(a.uv.getX(i), a.uv.getY(i));
      nrm.push(0, 1, 0); // lit like the ground it grows on
    }
    const ix = p.index!;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += a.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  private uniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  private center = new THREE.Vector3(1e9, 0, 0);
  private readonly max = 7000;
  private pending = false;

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ map: bladeTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float hgt = clamp(position.y / 0.55, 0.0, 1.0);
vec4 iw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float ph = iw.x * 0.37 + iw.z * 0.29 + iw.y * 0.11;
float sway = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 3.1 + ph * 1.7) * 0.25;
transformed.x += sway * hgt * hgt * 0.12 * uWind;
transformed.z += cos(uTime * 1.3 + ph) * hgt * hgt * 0.06 * uWind;`);
    };
    mat.customProgramCacheKey = () => 'grass';
    this.mesh = new THREE.InstancedMesh(tuftGeometry(), mat, this.max);
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'grass';
  }

  update(time: number, wind: number): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value = 0.6 + Math.min(3, wind / 6);
  }

  /** Rebuild around a planet-local position if it moved enough. Spread over frames by the caller. */
  maybeRebuild(phys: VoxelPhysics, pos: THREE.Vector3, tint: [number, number, number], density: number, force = false): void {
    if (this.pending) return;
    if (!force && pos.distanceTo(this.center) < 6) return;
    if (density <= 0) { this.mesh.count = 0; return; }
    this.pending = true;
    this.center.copy(pos);
    const w = phys.world;
    const N = w.params.N, base = w.params.baseRadius;
    const g = { face: 0, x: 0, y: 0, z: 0 };
    phys.toGrid(pos, g);
    const R = density >= 2 ? 22 : 15;
    const I0 = Math.floor(g.x), J0 = Math.floor(g.y), Kp = Math.floor(g.z);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = [0, 0, 0];
    const up = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const seed = w.params.seed;
    let n = 0;
    for (let dj = -R; dj <= R && n < this.max; dj++) {
      for (let di = -R; di <= R && n < this.max; di++) {
        if (di * di + dj * dj > R * R) continue;
        const I = I0 + di, J = J0 + dj;
        // find the exposed top near the player's height
        let top = -1;
        for (let k = Kp + 6; k >= Kp - 10; k--) {
          const b = w.getLoaded(g.face, I, J, k);
          if (b === B.UNKNOWN) break;
          if (b !== B.AIR) {
            if (b === B.MOSS && w.getLoaded(g.face, I, J, k + 1) === B.AIR) top = k;
            break;
          }
        }
        if (top < 0) continue;
        const hsh = hash32(seed, 777, g.face, I, J);
        const count = (hsh & 3) + (density >= 2 ? 1 : 0);
        for (let t = 0; t < count && n < this.max; t++) {
          const rx = hashFloat(hsh, t * 3 + 1), ry = hashFloat(hsh, t * 3 + 2), rs = hashFloat(hsh, t * 3 + 3);
          gridToPos(g.face, I + 0.12 + rx * 0.76, J + 0.12 + ry * 0.76, top + 1, N, base, p);
          up.set(p[0], p[1], p[2]).normalize();
          q.setFromUnitVectors(yAxis, up);
          q.multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, rs * 6.28));
          const sc = 0.55 + rs * 0.75;
          m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(sc, sc * (0.8 + rx * 0.6), sc));
          this.mesh.setMatrixAt(n, m);
          const v = 0.75 + ry * 0.4;
          col.setRGB(tint[0] * 1.6 * v, tint[1] * 1.6 * v, tint[2] * 1.6 * v);
          this.mesh.setColorAt(n, col);
          n++;
        }
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.pending = false;
  }

  invalidate(): void {
    this.center.set(1e9, 0, 0);
  }
}

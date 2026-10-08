import * as THREE from 'three';

/**
 * Pooled visual effects simulated in the active frame (frameRoot space):
 * voxel debris (instanced cubes with gravity), sparks/dust (points),
 * mining beam, target highlight and crack overlay.
 */

interface Debris { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; size: number; color: THREE.Color; rot: THREE.Euler; spin: THREE.Vector3 }
interface Spark { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; color: THREE.Color; size: number; drag: number; grav: number }

const SPARK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * 300.0 / max(0.5, -mv.z);
  #include <logdepthbuf_vertex>
}`;
const SPARK_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor * a, a);
}`;

export class Effects {
  /** particle count scale from settings */
  quality = 1;
  readonly group = new THREE.Group();
  private debris: Debris[] = [];
  private sparks: Spark[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private sparkPts: THREE.Points;
  private sparkPos: Float32Array;
  private sparkCol: Float32Array;
  private sparkSize: Float32Array;
  private readonly MAXD = 220;
  private readonly MAXS = 1200;
  readonly beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  readonly highlight: THREE.LineSegments;
  /** circular marker on smooth terrain (dig area) */
  readonly ring: THREE.Group;
  private ringArc: THREE.Line;
  readonly crack: THREE.Mesh;
  private crackMat: THREE.ShaderMaterial;
  readonly ghost: THREE.Group = new THREE.Group();
  gravityCenter: THREE.Vector3 | null = null;
  gravity = 9.8;

  constructor() {
    const dm = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), dm, this.MAXD);
    this.debrisMesh.count = 0;
    this.debrisMesh.castShadow = true;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.MAXD * 3), 3);
    this.sparkPos = new Float32Array(this.MAXS * 3);
    this.sparkCol = new Float32Array(this.MAXS * 3);
    this.sparkSize = new Float32Array(this.MAXS);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.sparkCol, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.sparkSize, 1));
    this.sparkPts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.sparkPts.frustumCulled = false;
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(1, 0.55, 0.2) } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
void main(){
#include <logdepthbuf_fragment>
  float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
  core = pow(core, 3.0);
  float pulse = 0.7 + 0.3 * sin(vUv.y * 40.0 - uTime * 50.0);
  gl_FragColor = vec4(uColor * core * pulse * 30.0, 1.0);
}`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, 1, 6, 1, true), this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this.highlight = new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 0.95, 1.0).multiplyScalar(2), transparent: true, opacity: 0.7, depthWrite: false }));
    this.highlight.frustumCulled = false;
    this.highlight.visible = false;
    this.crackMat = new THREE.ShaderMaterial({
      uniforms: { uProgress: { value: 0 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uProgress; varying vec3 vP;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
void main(){
#include <logdepthbuf_fragment>
  vec3 q = floor(vP * 6.0);
  float n = h(q);
  float lines = step(0.94 - uProgress * 0.3, fract(vP.x * 6.0 + n)) + step(0.94 - uProgress * 0.3, fract(vP.y * 6.0 - n)) + step(0.94 - uProgress * 0.3, fract(vP.z * 6.0 + n * 2.0));
  float a = clamp(lines, 0.0, 1.0) * uProgress;
  if (a < 0.05) discard;
  gl_FragColor = vec4(vec3(0.0), a * 0.8);
}`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36 * 3), 3));
    this.crack = new THREE.Mesh(cg, this.crackMat);
    this.crack.frustumCulled = false;
    this.crack.visible = false;
    this.ghost.visible = false;
    // dig marker: thin circle plus a progress arc
    this.ring = new THREE.Group();
    const circle = (n: number, r: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
      return new THREE.BufferGeometry().setFromPoints(pts);
    };
    const ringMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 0.95, 1.0).multiplyScalar(2), transparent: true, opacity: 0.55, depthWrite: false });
    this.ring.add(new THREE.Line(circle(48, 1), ringMat));
    this.ringArc = new THREE.Line(circle(48, 0.86), new THREE.LineBasicMaterial({ color: new THREE.Color(1.0, 0.75, 0.3).multiplyScalar(3), transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.add(this.ringArc);
    this.ring.visible = false;
    this.ring.traverse((o) => { o.frustumCulled = false; });
    this.group.add(this.debrisMesh, this.sparkPts, this.beam, this.highlight, this.crack, this.ghost, this.ring);
  }

  /** Set the highlight box and crack overlay from 8 corners (frame space). Order: bit0=x, bit1=y, bit2=z. */
  setTargetBox(corners: THREE.Vector3[] | null, progress: number): void {
    if (!corners) {
      this.highlight.visible = false;
      this.crack.visible = false;
      return;
    }
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const pa = this.highlight.geometry.attributes.position as THREE.BufferAttribute;
    edges.forEach(([a, b], i) => {
      pa.setXYZ(i * 2, corners[a].x, corners[a].y, corners[a].z);
      pa.setXYZ(i * 2 + 1, corners[b].x, corners[b].y, corners[b].z);
    });
    pa.needsUpdate = true;
    this.highlight.visible = true;
    this.crack.visible = progress > 0.01;
    if (progress > 0.01) {
      const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
      const ca = this.crack.geometry.attributes.position as THREE.BufferAttribute;
      let i = 0;
      for (const f of faces) {
        for (const t of [0, 1, 2, 0, 2, 3]) {
          const c = corners[f[t]];
          ca.setXYZ(i++, c.x, c.y, c.z);
        }
      }
      ca.needsUpdate = true;
      this.crackMat.uniforms.uProgress.value = progress;
    }
  }

  /** Ring marker lying on the surface at `point` (frame space), `progress` 0..1 drawn as an arc. */
  setTargetRing(point: THREE.Vector3 | null, normal: THREE.Vector3 | null, radius: number, progress: number): void {
    if (!point || !normal) { this.ring.visible = false; return; }
    this.ring.visible = true;
    this.ring.position.copy(point).addScaledVector(normal, 0.04);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.ring.scale.setScalar(radius);
    const n = Math.round(Math.max(0, Math.min(1, progress)) * 48);
    this.ringArc.geometry.setDrawRange(0, n > 0 ? n + 1 : 0);
  }

  setBeam(from: THREE.Vector3 | null, to: THREE.Vector3 | null, color: THREE.Color | null, time: number): void {
    if (!from || !to) { this.beam.visible = false; return; }
    const d = to.clone().sub(from);
    const len = d.length();
    this.beam.visible = true;
    this.beam.position.copy(from).addScaledVector(d, 0.5);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    this.beam.scale.set(1, len, 1);
    if (color) this.beamMat.uniforms.uColor.value.copy(color);
    this.beamMat.uniforms.uTime.value = time;
  }

  burstDebris(center: THREE.Vector3, up: THREE.Vector3, color: THREE.Color, count: number): void {
    count = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < count; i++) {
      if (this.debris.length >= this.MAXD) this.debris.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4).addScaledVector(up, 2 + Math.random() * 3);
      const c = color.clone().multiplyScalar(0.7 + Math.random() * 0.5);
      this.debris.push({
        p: center.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.6)),
        v, life: 0, max: 1.2 + Math.random() * 1.0, size: 0.08 + Math.random() * 0.12, color: c,
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6), spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14),
      });
    }
  }

  sparksAt(p: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count: number, speed = 3, grav = 1, size = 0.05, life = 0.5, drag = 1.5): void {
    count = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= this.MAXS) this.sparks.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(speed).addScaledVector(normal, speed * 0.6 * Math.random());
      this.sparks.push({ p: p.clone(), v, life: 0, max: life * (0.5 + Math.random()), color: color.clone(), size: size * (0.6 + Math.random() * 0.8), drag, grav });
    }
  }

  update(dt: number): void {
    const center = this.gravityCenter;
    const tmp = new THREE.Vector3();
    // debris
    const m = new THREE.Matrix4();
    let n = 0;
    this.debris = this.debris.filter((d) => (d.life += dt) < d.max);
    for (const d of this.debris) {
      if (center) d.v.addScaledVector(tmp.copy(center).sub(d.p).normalize(), this.gravity * dt);
      d.v.multiplyScalar(1 - dt * 0.6);
      d.p.addScaledVector(d.v, dt);
      d.rot.x += d.spin.x * dt; d.rot.y += d.spin.y * dt; d.rot.z += d.spin.z * dt;
      const s = d.size * Math.min(1, (d.max - d.life) * 3);
      m.compose(d.p, new THREE.Quaternion().setFromEuler(d.rot), new THREE.Vector3(s, s, s));
      this.debrisMesh.setMatrixAt(n, m);
      this.debrisMesh.setColorAt(n, d.color);
      n++;
    }
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    // sparks
    this.sparks = this.sparks.filter((s) => (s.life += dt) < s.max);
    let i = 0;
    for (const s of this.sparks) {
      if (center) s.v.addScaledVector(tmp.copy(center).sub(s.p).normalize(), this.gravity * s.grav * dt);
      s.v.multiplyScalar(1 - Math.min(0.9, dt * s.drag));
      s.p.addScaledVector(s.v, dt);
      const k = 1 - s.life / s.max;
      this.sparkPos[i * 3] = s.p.x; this.sparkPos[i * 3 + 1] = s.p.y; this.sparkPos[i * 3 + 2] = s.p.z;
      this.sparkCol[i * 3] = s.color.r * k; this.sparkCol[i * 3 + 1] = s.color.g * k; this.sparkCol[i * 3 + 2] = s.color.b * k;
      this.sparkSize[i] = s.size;
      i++;
    }
    for (let j = i; j < this.MAXS; j++) this.sparkSize[j] = 0;
    this.sparkPts.geometry.setDrawRange(0, Math.max(1, i));
    (this.sparkPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkPts.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkPts.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Re-express all particles after a reference-frame switch. */
  transform(fn: (p: THREE.Vector3) => void, rot: THREE.Quaternion): void {
    for (const d of this.debris) { fn(d.p); d.v.applyQuaternion(rot); }
    for (const s of this.sparks) { fn(s.p); s.v.applyQuaternion(rot); }
  }

  clear(): void {
    this.debris = [];
    this.sparks = [];
  }
}

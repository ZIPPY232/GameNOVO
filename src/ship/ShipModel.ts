import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Original exploration lander "Arandu-class". Local axes: -Z forward, +Y up.
 * Chunky bevelled forms keep it consistent with the voxel astronaut while PBR
 * metals and emissive systems keep it believable.
 */

function panelTextures(): { map: THREE.CanvasTexture; normal: THREE.DataTexture; rough: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9ccd0';
  g.fillRect(0, 0, S, S);
  const h = new Float32Array(S * S).fill(0.5);
  // panel layout
  const rects: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, hh: number, d: number) => {
    if (d > 3 || (d > 1 && Math.random() < 0.3)) { rects.push([x, y, w, hh]); return; }
    if (w > hh) { const s = Math.floor(w * (0.35 + Math.random() * 0.3)); split(x, y, s, hh, d + 1); split(x + s, y, w - s, hh, d + 1); }
    else { const s = Math.floor(hh * (0.35 + Math.random() * 0.3)); split(x, y, w, s, d + 1); split(x, y + s, w, hh - s, d + 1); }
  };
  split(0, 0, S, S, 0);
  for (const [x, y, w, hh] of rects) {
    const shade = 195 + Math.floor(Math.random() * 30);
    g.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
    g.fillRect(x + 2, y + 2, w - 4, hh - 4);
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) {
      const e = Math.min(xx - x, x + w - 1 - xx, yy - y, y + hh - 1 - yy);
      h[xx + yy * S] = e < 2 ? 0 : 0.5;
    }
    // rivets
    g.fillStyle = 'rgba(80,84,90,0.6)';
    for (const [rx, ry] of [[x + 6, y + 6], [x + w - 6, y + 6], [x + 6, y + hh - 6], [x + w - 6, y + hh - 6]]) {
      g.beginPath(); g.arc(rx, ry, 1.6, 0, Math.PI * 2); g.fill();
    }
  }
  // grime streaks
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(60,55,50,${Math.random() * 0.06})`;
    const x = Math.random() * S, y = Math.random() * S;
    g.fillRect(x, y, 1 + Math.random() * 3, 10 + Math.random() * 60);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const nd = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const xr = (x + 1) % S, xl = (x - 1 + S) % S, yu = (y + 1) % S, yd = (y - 1 + S) % S;
    const dx = (h[xr + y * S] - h[xl + y * S]) * 2, dy = (h[x + yu * S] - h[x + yd * S]) * 2;
    const l = Math.hypot(dx, dy, 1);
    const i = (x + y * S) * 4;
    nd[i] = (-dx / l * 0.5 + 0.5) * 255; nd[i + 1] = (-dy / l * 0.5 + 0.5) * 255; nd[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd[i + 3] = 255;
  }
  const normal = new THREE.DataTexture(nd, S, S, THREE.RGBAFormat);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.needsUpdate = true;
  const rc = document.createElement('canvas');
  rc.width = 128; rc.height = 128;
  const rg = rc.getContext('2d')!;
  for (let i = 0; i < 128 * 128 / 16; i++) {
    const v = 100 + Math.random() * 60;
    rg.fillStyle = `rgb(${v},${v},${v})`;
    rg.fillRect((i % 32) * 4, Math.floor(i / 32) * 4, 4, 4);
  }
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return { map, normal, rough };
}

export interface ShipParts {
  root: THREE.Group;
  gear: THREE.Group[];
  plumes: THREE.Mesh[];
  nozzles: THREE.Mesh[];
  navLights: THREE.Mesh[];
  strobe: THREE.Mesh;
  cockpit: THREE.Group;
  screens: THREE.CanvasTexture;
  screenCanvas: HTMLCanvasElement;
  heatShell: THREE.Mesh;
  hatch: THREE.Mesh;
  landingLight: THREE.SpotLight;
  rcs: THREE.Mesh[];
}

export class ShipModel {
  readonly parts: ShipParts;
  readonly mats: Record<string, THREE.MeshStandardMaterial>;
  /** local positions */
  static readonly EYE = new THREE.Vector3(0, 1.22, -3.05);
  static readonly HATCH = new THREE.Vector3(-2.4, -1.2, 0.4);
  static readonly FEET = [new THREE.Vector3(-1.55, -2.05, -2.4), new THREE.Vector3(1.55, -2.05, -2.4), new THREE.Vector3(-1.95, -2.05, 2.7), new THREE.Vector3(1.95, -2.05, 2.7)];
  static readonly HULL_PROBES = [
    new THREE.Vector3(0, 0, -6.2), new THREE.Vector3(0, 0, 5.2), new THREE.Vector3(-4.6, -0.2, 2.2), new THREE.Vector3(4.6, -0.2, 2.2),
    new THREE.Vector3(0, 1.5, -2.5), new THREE.Vector3(0, -1.0, 0), new THREE.Vector3(-1.9, 0.1, 4.6), new THREE.Vector3(1.9, 0.1, 4.6),
    new THREE.Vector3(0, -0.9, -4.2), new THREE.Vector3(0, 1.0, 2.5),
  ];

  constructor() {
    const tex = panelTextures();
    const hull = new THREE.MeshStandardMaterial({ color: 0xe9eaec, map: tex.map, normalMap: tex.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: tex.rough, roughness: 0.62, metalness: 0.15 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.5, metalness: 0.3, normalMap: tex.normal, normalScale: new THREE.Vector2(0.4, 0.4) });
    const accent = new THREE.MeshStandardMaterial({ color: 0xea7a2c, roughness: 0.5, metalness: 0.1 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b1016, roughness: 0.05, metalness: 0.95, envMapIntensity: 1.8 });
    const engine = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.35, metalness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.55, 0.85, 1.0), emissiveIntensity: 30 });
    const red = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 0.08, 0.05), emissiveIntensity: 60 });
    const green = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(0.1, 1, 0.3), emissiveIntensity: 60 });
    const white = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 120 });
    this.mats = { hull, dark, accent, glass, engine, glow, red, green, white };

    const root = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const rb = (w: number, h: number, d: number, r = 0.2) => new RoundedBoxGeometry(w, h, d, 3, r);

    // fuselage
    add(rb(3.1, 1.9, 7.4, 0.35), hull, 0, 0, 0.6);
    add(rb(2.5, 1.5, 2.8, 0.3), hull, 0, -0.05, -3.9);
    const nose = add(new THREE.CylinderGeometry(0.45, 1.25, 2.0, 4, 1), hull, 0, -0.1, -6.1);
    nose.rotation.set(-Math.PI / 2, Math.PI / 4, 0);
    nose.scale.set(1.25, 1, 0.75);
    // canopy
    const canopy = add(rb(1.9, 0.75, 2.5, 0.28), glass, 0, 1.0, -3.0);
    canopy.castShadow = false;
    add(rb(2.0, 0.12, 2.6, 0.05), dark, 0, 0.66, -3.0);
    // spine & cargo
    add(rb(1.2, 0.55, 5.2, 0.18), dark, 0, 1.1, 1.3);
    add(rb(2.3, 0.8, 3.2, 0.2), dark, 0, -1.25, 1.4);
    // accent stripes
    add(rb(3.14, 0.12, 2.2, 0.05), accent, 0, 0.35, -1.3);
    add(rb(0.12, 1.92, 0.4, 0.05), accent, -1.56, 0, 2.6);
    add(rb(0.12, 1.92, 0.4, 0.05), accent, 1.56, 0, 2.6);
    // wings
    for (const s of [-1, 1]) {
      const w = add(rb(3.6, 0.22, 2.6, 0.08), hull, s * 3.0, -0.25, 1.9);
      w.rotation.y = -s * 0.32;
      add(rb(0.5, 0.26, 1.2, 0.08), dark, s * 4.75, -0.25, 2.65);
      const light = add(new THREE.SphereGeometry(0.09, 10, 8), s < 0 ? red : green, s * 4.98, -0.2, 2.65);
      light.castShadow = false;
      // nacelle
      const nac = add(new THREE.CylinderGeometry(0.78, 0.7, 3.6, 20), dark, s * 1.95, 0.15, 3.4);
      nac.rotation.x = Math.PI / 2;
      const intake = add(new THREE.TorusGeometry(0.72, 0.1, 10, 24), hull, s * 1.95, 0.15, 1.6);
      intake.castShadow = false;
      const nz = add(new THREE.CylinderGeometry(0.62, 0.78, 0.6, 20, 1, true), engine, s * 1.95, 0.15, 5.45);
      nz.rotation.x = Math.PI / 2;
      // fins
      const fin = add(rb(0.12, 1.1, 1.4, 0.05), hull, s * 1.95, 1.05, 4.3);
      fin.rotation.z = s * 0.25;
    }
    // hatch
    const hatch = add(rb(0.08, 1.2, 1.1, 0.04), dark, -1.57, -0.3, 0.4);
    add(rb(0.06, 1.3, 0.06, 0.02), accent, -1.6, -0.3, -0.18);
    add(rb(0.06, 1.3, 0.06, 0.02), accent, -1.6, -0.3, 0.98);

    // engine glow + plumes
    const nozzles: THREE.Mesh[] = [];
    const plumes: THREE.Mesh[] = [];
    const plumeMat = new THREE.ShaderMaterial({
      uniforms: { uPower: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uPower; uniform float uTime; varying vec3 vP;
void main(){
#include <logdepthbuf_fragment>
  float t = clamp(vP.y / -4.0 + 0.5, 0.0, 1.0);
  float r = length(vP.xz);
  float core = exp(-r * 4.0) * (1.0 - t);
  float flick = 0.85 + 0.15 * sin(uTime * 60.0 + vP.y * 8.0);
  vec3 c = mix(vec3(0.7, 0.9, 1.0), vec3(0.3, 0.45, 1.0), t) * core * flick * uPower * 40.0;
  gl_FragColor = vec4(c, 1.0);
}`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const s of [-1, 1]) {
      const g = add(new THREE.CircleGeometry(0.58, 24), glow, s * 1.95, 0.15, 5.7);
      g.castShadow = false;
      nozzles.push(g);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.15, 4, 16, 1, true), plumeMat);
      p.position.set(s * 1.95, 0.15, 7.7);
      p.rotation.x = -Math.PI / 2;
      p.frustumCulled = false;
      root.add(p);
      plumes.push(p);
    }
    // RCS blocks
    const rcs: THREE.Mesh[] = [];
    for (const [x, y, z] of [[-1.5, 0.8, -4.5], [1.5, 0.8, -4.5], [-1.6, -0.8, 3.8], [1.6, -0.8, 3.8]]) {
      rcs.push(add(rb(0.3, 0.3, 0.3, 0.06), dark, x, y, z));
    }
    // landing gear
    const gear: THREE.Group[] = [];
    for (const f of ShipModel.FEET) {
      const pivot = new THREE.Group();
      pivot.position.set(f.x * 0.85, -0.85, f.z);
      root.add(pivot);
      add(rb(0.22, 1.2, 0.22, 0.05), dark, 0, -0.6, 0, pivot);
      add(rb(0.3, 0.4, 0.3, 0.06), engine, 0, -0.15, 0, pivot);
      const pad = add(new THREE.CylinderGeometry(0.42, 0.48, 0.14, 16), dark, f.x * 0.15, -1.15, 0, pivot);
      pad.castShadow = true;
      gear.push(pivot);
    }
    // strobe
    const strobe = add(new THREE.SphereGeometry(0.08, 8, 6), white, 0, 1.42, 3.6);
    strobe.castShadow = false;
    const navLights = [root.children.find((c) => (c as THREE.Mesh).material === red) as THREE.Mesh, root.children.find((c) => (c as THREE.Mesh).material === green) as THREE.Mesh];

    // landing light
    const landingLight = new THREE.SpotLight(0xfff2dd, 0, 140, 0.55, 0.5, 1.2);
    landingLight.position.set(0, -1.0, -4.6);
    landingLight.target.position.set(0, -12, -9);
    root.add(landingLight, landingLight.target);

    // re-entry plasma shell
    const heatMat = new THREE.ShaderMaterial({
      uniforms: { uHeat: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vP;
void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat; uniform float uTime; varying vec3 vN; varying vec3 vP;
void main(){
#include <logdepthbuf_fragment>
  float front = smoothstep(2.0, -7.0, vP.z);
  float rim = pow(1.0 - abs(vN.z), 2.0);
  float n = 0.7 + 0.3 * sin(vP.z * 3.0 + uTime * 40.0) * sin(vP.x * 5.0 - uTime * 31.0);
  vec3 c = mix(vec3(1.0, 0.35, 0.08), vec3(1.0, 0.85, 0.6), front) * front * n * (0.5 + rim) * uHeat * 18.0;
  gl_FragColor = vec4(c, 1.0);
}`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const heatShell = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), heatMat);
    heatShell.scale.set(3.4, 2.4, 7.5);
    heatShell.position.set(0, 0, -0.6);
    heatShell.visible = false;
    root.add(heatShell);

    // cockpit interior (visible from the pilot seat)
    const cockpit = new THREE.Group();
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 1024;
    screenCanvas.height = 256;
    const screens = new THREE.CanvasTexture(screenCanvas);
    screens.colorSpace = THREE.SRGBColorSpace;
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x050607, emissive: 0xffffff, emissiveMap: screens, emissiveIntensity: 3.5, roughness: 0.3 });
    const dash = add(rb(1.9, 0.32, 0.6, 0.06), dark, 0, 0.78, -3.7, cockpit);
    dash.rotation.x = -0.35;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), screenMat);
    scr.position.set(0, 0.95, -3.62);
    scr.rotation.x = -0.6;
    cockpit.add(scr);
    for (const s of [-1, 1]) {
      const strut = add(rb(0.06, 0.8, 0.06, 0.02), dark, s * 0.9, 1.05, -3.9, cockpit);
      strut.rotation.x = 0.55;
      strut.rotation.z = s * 0.2;
      add(rb(0.25, 0.5, 1.6, 0.05), dark, s * 1.0, 0.7, -2.9, cockpit);
    }
    // stick + seat
    add(rb(0.08, 0.35, 0.08, 0.02), engine, 0.35, 0.6, -3.15, cockpit);
    add(rb(0.75, 0.8, 0.2, 0.06), dark, 0, 0.85, -2.35, cockpit);
    root.add(cockpit);

    this.parts = { root, gear, plumes, nozzles, navLights, strobe, cockpit, screens, screenCanvas, heatShell, hatch, landingLight, rcs };
  }

  /** gearT 1 = deployed, 0 = retracted */
  update(t: number, throttle: number, gearT: number, heat: number, landingLightOn: boolean, damaged: boolean): void {
    const p = this.parts;
    for (const pl of p.plumes) {
      const m = pl.material as THREE.ShaderMaterial;
      m.uniforms.uPower.value = throttle;
      m.uniforms.uTime.value = t;
      pl.visible = throttle > 0.02;
      pl.scale.set(1, 0.4 + throttle * 1.2, 1);
    }
    this.mats.glow.emissiveIntensity = damaged ? 0.5 + Math.random() * 2 : 4 + throttle * 50;
    for (let i = 0; i < p.gear.length; i++) {
      const s = i % 2 === 0 ? -1 : 1;
      p.gear[i].rotation.z = s * (1 - gearT) * 1.45;
      p.gear[i].visible = gearT > 0.02;
    }
    this.mats.white.emissiveIntensity = (t % 1.6) < 0.08 ? 160 : 0.5;
    const hm = p.heatShell.material as THREE.ShaderMaterial;
    hm.uniforms.uHeat.value = heat;
    hm.uniforms.uTime.value = t;
    p.heatShell.visible = heat > 0.01;
    p.landingLight.intensity = landingLightOn ? 900 : 0;
  }

  setCockpitVisible(v: boolean): void {
    this.parts.cockpit.visible = v;
  }
}

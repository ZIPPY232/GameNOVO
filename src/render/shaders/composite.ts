import { ATMOSPHERE_GLSL } from './atmosphere';

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Composite pass for the focus planet: ocean surface (analytic sphere),
 * cloud layer, cloud shadows, underwater fog and atmospheric scattering, all
 * reconstructed from the HDR scene colour and logarithmic depth buffer.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform vec3 uCamFwd;
uniform float uLogFar;

uniform int uHasAtmo;
uniform int uHasOcean;
uniform int uHasClouds;
uniform vec3 uPlanetPos;     // planet centre relative to camera
uniform mat3 uPlanetRot;     // render -> planet local
uniform float uSeaR;
uniform vec3 uWaterDeep;
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;
uniform float uTime;
uniform float uCloudR;
uniform float uCloudCover;
uniform vec3 uCloudColor;
uniform float uCloudScale;
uniform vec3 uWind;
uniform vec3 uAmbient;
uniform int uSteps;
uniform int uLSteps;
uniform float uWetness;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform int uDebug;

${ATMOSPHERE_GLSL}

float cloudDensity(vec3 pLocal) {
  vec3 q = normalize(pLocal) * uCloudScale + uWind;
  float n = texture(tNoise, q).r * 0.6 + texture(tNoise, q * 2.7 + 0.31).r * 0.28 + texture(tNoise, q * 7.1 - 0.17).r * 0.12;
  float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.28, n);
  return c;
}

vec3 waveNormal(vec3 pLocal, vec3 n, float dist) {
  float amp = 0.55 * exp(-dist / 900.0);
  if (amp < 0.01) return n;
  vec3 q = pLocal * 0.045;
  vec3 tw = vec3(uTime * 0.021, uTime * 0.013, -uTime * 0.017);
  float e = 0.06;
  vec3 g = vec3(0.0);
  for (int o = 0; o < 2; o++) {
    float s = o == 0 ? 1.0 : 3.3;
    vec3 qq = q * s + tw * (o == 0 ? 1.0 : 1.7);
    float c = texture(tNoise, qq).r;
    g += vec3(texture(tNoise, qq + vec3(e, 0, 0)).r - c, texture(tNoise, qq + vec3(0, e, 0)).r - c, texture(tNoise, qq + vec3(0, 0, e)).r - c) / (e * s);
  }
  g -= n * dot(g, n);
  return normalize(n - g * amp * 0.9);
}

void main() {
  vec3 col = texture(tColor, vUv).rgb;
  float d = texture(tDepth, vUv).r;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 rdv = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(uCamRot * rdv);
  float viewZ = exp2(d * uLogFar) - 1.0;
  float tScene = d >= 0.999999 ? 1e12 : viewZ / max(dot(rd, uCamFwd), 1e-4);

  if (uDebug == 1) { fragColor = vec4(col, 1.0); return; }
  if (uDebug == 5) { fragColor = vec4(vec3(tScene * 1e-6), 1.0); return; }
  // planet-relative ray origin
  vec3 ro = -uPlanetPos;
  float camR = length(ro);
  bool underwater = uHasOcean == 1 && camR < uSeaR;

  // ---------------------------------------------------------------- cloud shadows on terrain
  if (uHasClouds == 1 && tScene < 4000.0 && !underwater) {
    vec3 p = ro + rd * tScene;
    vec2 cs = raySphere(p, uSunDir, uCloudR);
    if (cs.y > 0.0 && length(p) < uCloudR) {
      vec3 cp = p + uSunDir * cs.y;
      float sh = cloudDensity(uPlanetRot * cp);
      col *= 1.0 - sh * 0.55;
    }
  }

  // ---------------------------------------------------------------- ocean
  if (uHasOcean == 1) {
    vec2 st = raySphere(ro, rd, uSeaR);
    if (!underwater && st.x > 0.0 && st.x < tScene) {
      float t = st.x;
      vec3 hit = ro + rd * t;
      vec3 n0 = normalize(hit);
      vec3 hl = uPlanetRot * hit;
      vec3 nl = waveNormal(hl, uPlanetRot * n0, t);
      vec3 n = normalize(transpose(uPlanetRot) * nl);
      float thick = tScene - t;
      // refraction: absorb the seen scene through the water column
      vec3 trans = exp(-uWaterAbsorb * min(thick, 400.0));
      float sunUp = clamp(dot(n0, uSunDir) * 2.0 + 0.2, 0.0, 1.0);
      vec3 inscat = uWaterScatter * (uSunColor * 0.018 * sunUp + uAmbient * 0.6);
      vec3 under = (thick > 1e9 ? vec3(0.0) : col * trans) + inscat * (1.0 - trans) + uWaterDeep * sunUp * 0.0;
      // reflection
      vec3 rr = reflect(rd, n);
      rr = normalize(rr + n0 * max(0.0, -dot(rr, n0)) * 1.05);
      vec3 Tr;
      vec3 sky = uHasAtmo == 1 ? scatter(hit + n0 * 0.5, rr, 1e12, 6, 2, Tr) : vec3(0.0);
      float rough = 0.02 + clamp(t / 6000.0, 0.0, 0.25);
      float spec = pow(max(dot(rr, uSunDir), 0.0), 1.0 / (rough * rough * 0.08 + 0.0004));
      vec3 sunT;
      vec3 dummy = uHasAtmo == 1 ? scatter(hit + n0 * 0.5, uSunDir, 1e12, 4, 1, sunT) : vec3(0.0);
      if (uHasAtmo == 0) sunT = vec3(1.0);
      float lightV = smoothstep(-0.05, 0.05, dot(n0, uSunDir));
      vec3 specC = uSunColor * sunT * spec * (0.12 / (rough * 10.0 + 0.2)) * lightV;
      float cosI = clamp(dot(-rd, n), 0.0, 1.0);
      float fres = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
      vec3 waterC = mix(under, sky + uAmbient * 0.05, fres) + specC;
      // shoreline foam
      float foam = (1.0 - smoothstep(0.0, 1.4, thick)) * (0.55 + 0.45 * texture(tNoise, hl * 0.25 + uTime * 0.02).r) * (1.0 - smoothstep(300.0, 1500.0, t));
      vec3 foamC = (uSunColor * 0.012 * max(dot(n0, uSunDir), 0.0) + uAmbient * 0.7) * foam;
      col = waterC + foamC;
      tScene = t;
    } else if (underwater) {
      float tw = tScene;
      bool toSurface = st.y > 0.0 && st.y < tScene;
      if (toSurface) tw = st.y;
      vec3 trans = exp(-uWaterAbsorb * 1.6 * min(tw, 300.0));
      float depthBelow = uSeaR - camR;
      float light = exp(-depthBelow * 0.06);
      vec3 inscat = uWaterScatter * (uSunColor * 0.02 * light + uAmbient * 0.7);
      if (toSurface) {
        // looking up at the surface from below: bright Snell window
        vec3 nup = -normalize(ro + rd * st.y);
        float win = smoothstep(0.55, 0.75, dot(-rd, nup));
        col = mix(inscat * 2.0, uSunColor * 0.04 + uAmbient, win);
      }
      col = col * trans + inscat * (1.0 - trans);
      fragColor = vec4(col, 1.0);
      return;
    }
  }

  if (uDebug == 2) { fragColor = vec4(col, 1.0); return; }
  // ---------------------------------------------------------------- atmosphere + clouds
  if (uHasAtmo == 1) {
    vec3 T;
    vec3 S = scatter(ro, rd, tScene, uSteps, uLSteps, T);
    col = col * T + S;
    if (uDebug == 3) { fragColor = vec4(col, 1.0); return; }
    if (uDebug == 4) { fragColor = vec4(S, 1.0); return; }
    if (uDebug == 6) { fragColor = vec4(T, 1.0); return; }
    if (uHasClouds == 1) {
      vec2 cs = raySphere(ro, rd, uCloudR);
      float tc = camR < uCloudR ? cs.y : cs.x;
      vec2 gnd = raySphere(ro, rd, uRg - 2.0);
      bool blocked = gnd.x > 0.0 && gnd.x < tc;
      if (tc > 0.0 && tc < tScene && !blocked) {
        vec3 cp = ro + rd * tc;
        vec3 cpl = uPlanetRot * cp;
        float dens = cloudDensity(cpl);
        // fade clouds viewed edge-on from inside the shell to hide the 2D layer
        float grazing = abs(dot(rd, normalize(cp)));
        dens *= smoothstep(0.0, 0.12, grazing);
        if (dens > 0.003) {
          vec3 n = normalize(cp);
          float ndl = dot(n, uSunDir);
          // self shadowing: density toward the sun
          vec3 toward = normalize(uSunDir - n * ndl);
          float occ = cloudDensity(uPlanetRot * (cp + toward * uCloudR * 0.01));
          vec3 Tsun;
          vec3 ignored = scatter(cp, uSunDir, 1e12, 4, 1, Tsun);
          float lit = smoothstep(-0.12, 0.25, ndl);
          float forward = pow(max(dot(rd, uSunDir), 0.0), 8.0) * 1.5;
          vec3 cloudLit = uCloudColor * (uSunColor * Tsun * 0.075 * lit * (1.0 - occ * 0.55 + forward) + uAmbient * 0.9);
          vec3 Tc;
          vec3 Sc = scatter(ro, rd, tc, max(uSteps / 2, 4), 2, Tc);
          cloudLit = cloudLit * Tc + Sc;
          col = mix(col, cloudLit, clamp(dens * 1.15, 0.0, 0.97));
        }
      }
    }
  }

  // weather fog (rain, snow, sandstorm) near the ground
  if (uFogDensity > 0.0) {
    float f = 1.0 - exp(-uFogDensity * min(tScene, 3000.0));
    col = mix(col, uFogColor, f);
  }
  fragColor = vec4(col, 1.0);
}
`;

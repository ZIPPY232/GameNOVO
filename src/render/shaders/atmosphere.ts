/**
 * Shared GLSL for physically-inspired single scattering (Rayleigh + Mie),
 * evaluated along a view ray inside a spherical atmosphere shell. Used by the
 * full-screen composite pass and by distant body rim shaders.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform float uRg;          // ground (sea level) radius
uniform float uRa;          // atmosphere top radius
uniform vec3  uBetaR;       // rayleigh scattering at sea level
uniform float uBetaM;       // mie scattering at sea level
uniform float uHR;
uniform float uHM;
uniform float uMieG;
uniform vec3  uMieColor;
uniform vec3  uSunDir;      // normalised, render space
uniform vec3  uSunColor;    // radiance (HDR)

const float PI = 3.14159265;

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float lr = length(ro);
  float c = (lr - r) * (lr + r);
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0, -2.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

// optical depth from p toward the sun; returns -1 if the planet blocks the sun
vec2 lightDepth(vec3 p, int steps) {
  vec2 gs = raySphere(p, uSunDir, uRg * 0.998);
  if (gs.x > 0.0) return vec2(-1.0);
  vec2 as = raySphere(p, uSunDir, uRa);
  float len = max(as.y, 0.0);
  float ds = len / float(steps);
  vec2 od = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    vec3 q = p + uSunDir * (ds * (float(i) + 0.5));
    float h = max(length(q) - uRg, 0.0);
    od += vec2(exp(-h / uHR), exp(-h / uHM)) * ds;
  }
  return od;
}

// Returns in-scattered radiance along [0,tMax]; transmittance in T.
vec3 scatter(vec3 ro, vec3 rd, float tMax, int steps, int lsteps, out vec3 T) {
  T = vec3(1.0);
  vec2 at = raySphere(ro, rd, uRa);
  if (at.y < 0.0) return vec3(0.0);
  float t0 = max(at.x, 0.0);
  float t1 = min(at.y, tMax);
  if (t1 <= t0) return vec3(0.0);
  float ds = (t1 - t0) / float(steps);
  vec2 od = vec2(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  vec3 betaMe = vec3(uBetaM * 1.1);
  for (int i = 0; i < 24; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
    float h = max(length(p) - uRg, 0.0);
    vec2 d = vec2(exp(-h / uHR), exp(-h / uHM)) * ds;
    od += d;
    vec2 lod = lightDepth(p, lsteps);
    if (lod.x < 0.0) continue;
    vec3 tau = uBetaR * (od.x + lod.x) + betaMe * (od.y + lod.y);
    vec3 attn = exp(-tau);
    sumR += d.x * attn;
    sumM += d.y * attn;
  }
  T = exp(-(uBetaR * od.x + betaMe * od.y));
  float mu = dot(rd, uSunDir);
  vec3 s = uSunColor * (sumR * uBetaR * phaseR(mu) + sumM * uBetaM * phaseM(mu, uMieG) * uMieColor);
  // crude multiple-scattering ambient so twilight is not pitch black
  s += uSunColor * (sumR * uBetaR) * 0.02;
  return s;
}
`;

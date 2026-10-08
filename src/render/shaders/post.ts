/** Post-processing shaders: bloom chain, auto-exposure, tone mapping + grading, FXAA. */

export const BLOOM_PREFILTER = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc; uniform sampler2D tExposure; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; uniform float uManual;
vec3 karis(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b)) * 0.25); }
void main() {
  float ex = uManual > 0.0 ? uManual : texture(tExposure, vec2(0.5)).r;
  vec3 c = vec3(0.0);
  c += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25 * ex;
  c = min(c, vec3(200.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  fragColor = vec4(karis(c * contrib), 1.0);
}`;

export const BLOOM_DOWN = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc; uniform vec2 uTexel;
void main() {
  vec2 t = uTexel;
  vec3 a = texture(tSrc, vUv + t * vec2(-2, -2)).rgb, b = texture(tSrc, vUv + t * vec2(0, -2)).rgb, c = texture(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 d = texture(tSrc, vUv + t * vec2(-2, 0)).rgb, e = texture(tSrc, vUv).rgb, f = texture(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(tSrc, vUv + t * vec2(-2, 2)).rgb, h = texture(tSrc, vUv + t * vec2(0, 2)).rgb, i = texture(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 j = texture(tSrc, vUv + t * vec2(-1, -1)).rgb, k = texture(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 l = texture(tSrc, vUv + t * vec2(-1, 1)).rgb, m = texture(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  fragColor = vec4(o, 1.0);
}`;

export const BLOOM_UP = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 uTexel; uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(t.x, -t.y)).rgb
         + texture(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture(tSrc, vUv + vec2(t.x, t.y)).rgb;
  s += 2.0 * (texture(tSrc, vUv + vec2(0.0, -t.y)).rgb + texture(tSrc, vUv + vec2(0.0, t.y)).rgb
            + texture(tSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(tSrc, vUv + vec2(t.x, 0.0)).rgb);
  s += 4.0 * texture(tSrc, vUv).rgb;
  s /= 16.0;
  fragColor = vec4(texture(tBase, vUv).rgb + s, 1.0);
}`;

export const LUM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc;
void main() {
  // centre-weighted log luminance
  vec3 c = texture(tSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = 1.0 - smoothstep(0.2, 0.75, length(vUv - 0.5));
  fragColor = vec4(log2(max(l, 1e-5)) * (0.4 + w), 0.4 + w, 0.0, 1.0);
}`;

export const LUM_DOWN = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc; uniform vec2 uTexel;
void main() {
  vec2 acc = vec2(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    acc += texture(tSrc, vUv + uTexel * (vec2(float(x), float(y)) - 1.5)).rg;
  }
  fragColor = vec4(acc / 16.0, 0.0, 1.0);
}`;

export const ADAPT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tLum; uniform sampler2D tPrev; uniform float uDt; uniform float uKey; uniform float uMin; uniform float uMax; uniform float uInit;
void main() {
  vec2 l = texture(tLum, vec2(0.5)).rg;
  float avg = exp2(l.x / max(l.y, 1e-4));
  float target = clamp(uKey / max(avg, 1e-5), uMin, uMax);
  float prev = texture(tPrev, vec2(0.5)).r;
  if (uInit > 0.5 || prev <= 0.0 || prev != prev) prev = target;
  float speed = target > prev ? 1.6 : 2.6;
  float e = mix(prev, target, 1.0 - exp(-uDt * speed));
  fragColor = vec4(e, 0.0, 0.0, 1.0);
}`;

export const FINAL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform sampler2D tExposure;
uniform float uBloom;
uniform float uExposureBias;
uniform float uManualExposure;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uWarp;
uniform float uHeat;
uniform float uDamage;
uniform float uFade;
uniform float uChroma;
uniform vec2 uRes;

vec3 aces(vec3 x) {
  // Narkowicz ACES fit with a slightly lifted toe
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  // warp tunnel distortion
  if (uWarp > 0.0) {
    float r = length(cc);
    uv = 0.5 + cc * (1.0 - uWarp * 0.25 * (1.0 - r));
  }
  // heat shimmer during atmospheric entry
  if (uHeat > 0.0) {
    uv += vec2(sin(uv.y * 80.0 + uTime * 23.0), cos(uv.x * 60.0 + uTime * 19.0)) * 0.0025 * uHeat;
  }
  vec3 c;
  if (uChroma > 0.0) {
    vec2 off = cc * 0.012 * uChroma;
    c = vec3(texture(tHDR, uv + off).r, texture(tHDR, uv).g, texture(tHDR, uv - off).b);
  } else c = texture(tHDR, uv).rgb;
  float exposure = uManualExposure > 0.0 ? uManualExposure : texture(tExposure, vec2(0.5)).r;
  c *= exposure * uExposureBias;
  c += texture(tBloom, uv).rgb * uBloom;
  if (uWarp > 0.0) {
    float streak = pow(max(0.0, 1.0 - abs(length(cc) - mod(uTime * 0.9, 1.0)) * 3.0), 6.0);
    c += vec3(0.5, 0.75, 1.0) * streak * uWarp * 0.6;
  }
  c = aces(c);
  // grading
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;
  c = c * uGain + uLift * (1.0 - c);
  c = clamp(c, 0.0, 1.0);
  // vignette
  float v = smoothstep(0.85, 0.25, length(cc * vec2(1.0, 0.85)));
  c *= mix(1.0, v, uVignette);
  // damage / hypoxia edge pulse
  if (uDamage > 0.0) {
    float edge = smoothstep(0.3, 0.75, length(cc));
    c = mix(c, vec3(0.55, 0.02, 0.02), edge * uDamage);
  }
  c = toSRGB(c);
  c += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
  c *= 1.0 - uFade;
  fragColor = vec4(c, dot(c, vec3(0.299, 0.587, 0.114)));
}`;

export const FXAA_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc; uniform vec2 uTexel;
#define EDGE_MIN 0.0312
#define EDGE_MAX 0.125
#define SUBPIX 0.75
float L(vec2 o) { return texture(tSrc, vUv + o * uTexel).a; }
void main() {
  vec4 rgbM = texture(tSrc, vUv);
  float lM = rgbM.a;
  float lN = L(vec2(0, 1)), lS = L(vec2(0, -1)), lE = L(vec2(1, 0)), lW = L(vec2(-1, 0));
  float mx = max(lM, max(max(lN, lS), max(lE, lW)));
  float mn = min(lM, min(min(lN, lS), min(lE, lW)));
  float range = mx - mn;
  if (range < max(EDGE_MIN, mx * EDGE_MAX)) { fragColor = vec4(rgbM.rgb, 1.0); return; }
  float lNW = L(vec2(-1, 1)), lNE = L(vec2(1, 1)), lSW = L(vec2(-1, -1)), lSE = L(vec2(1, -1));
  float edgeH = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lW + lE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
  float edgeV = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lN + lS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
  bool horz = edgeH >= edgeV;
  float l1 = horz ? lS : lW, l2 = horz ? lN : lE;
  float g1 = abs(l1 - lM), g2 = abs(l2 - lM);
  float stepLen = horz ? uTexel.y : uTexel.x;
  float lLocal;
  if (g1 >= g2) { stepLen = -stepLen; lLocal = 0.5 * (l1 + lM); } else lLocal = 0.5 * (l2 + lM);
  float gScaled = 0.25 * max(g1, g2);
  vec2 uv = vUv;
  if (horz) uv.y += stepLen * 0.5; else uv.x += stepLen * 0.5;
  vec2 off = horz ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  vec2 u1 = uv - off, u2 = uv + off;
  float e1 = texture(tSrc, u1).a - lLocal, e2 = texture(tSrc, u2).a - lLocal;
  bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;
  for (int i = 0; i < 10; i++) {
    if (r1 && r2) break;
    float q = i < 4 ? 1.0 : 2.0;
    if (!r1) { u1 -= off * q; e1 = texture(tSrc, u1).a - lLocal; r1 = abs(e1) >= gScaled; }
    if (!r2) { u2 += off * q; e2 = texture(tSrc, u2).a - lLocal; r2 = abs(e2) >= gScaled; }
  }
  float d1 = horz ? vUv.x - u1.x : vUv.y - u1.y;
  float d2 = horz ? u2.x - vUv.x : u2.y - vUv.y;
  bool dir1 = d1 < d2;
  float dist = min(d1, d2);
  float edgeLen = d1 + d2;
  float pixOff = -dist / edgeLen + 0.5;
  bool lMSmaller = lM < lLocal;
  bool correct = ((dir1 ? e1 : e2) < 0.0) != lMSmaller;
  float finalOff = correct ? pixOff : 0.0;
  float lAvg = (1.0 / 12.0) * (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE);
  float sub1 = clamp(abs(lAvg - lM) / range, 0.0, 1.0);
  float sub2 = (-2.0 * sub1 + 3.0) * sub1 * sub1;
  float subOff = sub2 * sub2 * SUBPIX;
  finalOff = max(finalOff, subOff);
  vec2 fuv = vUv;
  if (horz) fuv.y += finalOff * stepLen; else fuv.x += finalOff * stepLen;
  fragColor = vec4(texture(tSrc, fuv).rgb, 1.0);
}`;

export const COPY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tSrc;
void main() { fragColor = vec4(texture(tSrc, vUv).rgb, 1.0); }`;

// fluid.ts — hero background: a real-time GPU fluid, styled after Pavel
// Dobryakov's WebGL-Fluid-Simulation (MIT) — soft smoky coloured dye with a
// bloom glow that the cursor splats and stirs. Algorithm (splat → curl →
// vorticity → divergence → pressure → gradient-subtract → advect) is the
// standard stable-fluids pipeline; shaders here are our own. WebGL2 + half-float
// FBO ping-pong. Deferred + capability-gated; static CSS poster is the fallback.
import { Renderer, RenderTarget, Program, Mesh, Triangle } from 'ogl';

function simCapable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { alpha: false }) as WebGL2RenderingContext | null;
    if (!gl) return false;
    if (!gl.getExtension('EXT_color_buffer_float')) return false;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  }
}

export function start(canvas: HTMLCanvasElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData) return;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return;
  if (!simCapable()) return;
  startSim(canvas);
}

const VERT = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

// shared "speech-like" oscilloscope signal (used by the waveform passes and the display trace)
const WSIG = `
float wcarrier(float x, float t){
  return 0.55 * sin(x * 50.0  - t * 1.4)
       + 0.30 * sin(x * 82.0  - t * 2.3 + 1.3)
       + 0.18 * sin(x * 125.0 - t * 3.4 + 0.6);
}
float wenv(float x, float t){               // syllable/word envelope → loud bursts + silences
  float s = x * 3.4 - t * 0.5;
  float a = 0.5 + 0.5 * sin(s * 6.2832);
  float b = 0.5 + 0.5 * sin(s * 2.1 + 1.0);
  return pow(clamp(a * b, 0.0, 1.0), 1.6);
}`;

const SPLAT = HEAD + `
uniform sampler2D uSource;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
uniform float uAspect;
void main(){
  vec2 d = vUv - uPoint; d.x *= uAspect;
  float g = exp(-dot(d, d) / uRadius);
  fragColor = vec4(texture(uSource, vUv).xyz + uColor * g, 1.0);
}`;

const ADVECT = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDissipation;
void main(){
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  fragColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}`;

const DIVERGENCE = HEAD + `
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  fragColor = vec4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}`;

const CURL = HEAD + `
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  fragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;

const VORTICITY = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uCurlAmt;
uniform float uDt;
void main(){
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlAmt * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`;

const CLEARP = HEAD + `
uniform sampler2D uTex;
uniform float uValue;
void main(){ fragColor = vec4(texture(uTex, vUv).x * uValue, 0.0, 0.0, 1.0); }`;

const PRESSURE = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + T + B - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADSUB = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

const PREFILTER = HEAD + `
uniform sampler2D uTexture;
uniform float uThreshold;
uniform float uKnee;
void main(){
  vec3 c = texture(uTexture, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  fragColor = vec4(c * contrib, 1.0);
}`;

const BLUR = HEAD + `
uniform sampler2D uTexture;
uniform vec2 uDir;   // texel * direction
void main(){
  vec3 c = texture(uTexture, vUv).rgb * 0.227;
  c += texture(uTexture, vUv + uDir * 1.385).rgb * 0.316;
  c += texture(uTexture, vUv - uDir * 1.385).rgb * 0.316;
  c += texture(uTexture, vUv + uDir * 3.231).rgb * 0.070;
  c += texture(uTexture, vUv - uDir * 3.231).rgb * 0.070;
  fragColor = vec4(c, 1.0);
}`;

const DISPLAY = HEAD + WSIG + `
uniform sampler2D uDye;
uniform sampler2D uBloom;
uniform vec2 uTexelDye;
uniform vec2 uResolution;
uniform float uReveal;
uniform float uTime;
uniform float uBloomAmt;
uniform float uWaveAmt, uWaveAmp, uWaveBand;
uniform vec3 uWaveCol;
void main(){
  vec3 c = texture(uDye, vUv).rgb;
  // subtle shading from the dye gradient for a smoky, three-dimensional read
  float l = length(texture(uDye, vUv - vec2(uTexelDye.x, 0.0)).rgb);
  float r = length(texture(uDye, vUv + vec2(uTexelDye.x, 0.0)).rgb);
  float t = length(texture(uDye, vUv + vec2(0.0, uTexelDye.y)).rgb);
  float b = length(texture(uDye, vUv - vec2(0.0, uTexelDye.y)).rgb);
  vec3 n = normalize(vec3(r - l, t - b, length(uTexelDye) * 12.0));
  c *= 0.78 + 0.22 * clamp(dot(n, normalize(vec3(-0.4, 0.5, 1.0))), 0.0, 1.0);
  c += texture(uBloom, vUv).rgb * uBloomAmt;
  // crisp oscilloscope trace of the audio signal, sitting in front of the smoke it sheds
  float wy = 0.5 + uWaveAmp * wenv(vUv.x, uTime) * wcarrier(vUv.x, uTime);
  c += uWaveCol * exp(-((vUv.y - wy) * (vUv.y - wy)) / uWaveBand) * uWaveAmt;
  vec2 p = vUv - 0.5; p.x *= uResolution.x / uResolution.y;
  c *= smoothstep(1.35, 0.25, length(p));               // gentle vignette
  vec2 td = (vUv - vec2(0.20, 0.5)) / vec2(0.34, 0.26);  // soft elliptical region over the text block
  c *= mix(0.5, 1.0, smoothstep(0.5, 1.3, length(td)));  // thin the smoke there (no box: black stays black)
  float gr = fract(sin(dot(vUv * uResolution + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += gr * 0.006;
  fragColor = vec4(c * uReveal, 1.0);
}`;

const HASH = `float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }`;
const NOISE = `
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0,0.0)), c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vn(p); p = p * 2.03 + vec2(11.3, 7.7); a *= 0.5; } return v; }`;

// even dye source across the whole screen, modulated by a large-scale slow cloud field
const DYESOURCE = HEAD + HASH + NOISE + `
uniform sampler2D uSource;
uniform float uTime, uAmt;
uniform vec3 uColor;
void main(){
  float big = fbm(vUv * 1.9 + vec2(uTime * 0.028, -uTime * 0.020));   // broad cloud cover
  float fine = fbm(vUv * 5.4 + vec2(-uTime * 0.045, uTime * 0.05));   // smoky fine structure
  float n = smoothstep(0.34, 0.92, big) * (0.45 + 0.55 * fine);
  fragColor = vec4(texture(uSource, vUv).xyz + uColor * n * uAmt, 1.0);
}`;

// big, relaxed, divergence-free flow over the whole field (おおらか — broad eddies, not thin jets)
const FORCE = HEAD + HASH + NOISE + `
uniform sampler2D uVelocity;
uniform float uTime, uAmt, uScale;
void main(){
  vec2 p = vUv * uScale + vec2(uTime * 0.013, uTime * 0.010);
  float e = 0.07;
  vec2 f = vec2(fbm(p + vec2(0.0, e)) - fbm(p - vec2(0.0, e)),
             -(fbm(p + vec2(e, 0.0)) - fbm(p - vec2(e, 0.0)))) / (2.0 * e);
  fragColor = vec4(texture(uVelocity, vUv).xy + f * uAmt, 0.0, 1.0);
}`;

// ---- motif shaders: the waveform passes + ripple rings (the WSIG signal is defined up top) ----
// waveform → dye: a soft gaussian band along the curve, brighter where it's "loud"
const WAVE_DYE = HEAD + WSIG + `
uniform sampler2D uSource;
uniform float uTime, uAmp, uBand, uWeight;
uniform vec3 uColor;
void main(){
  float e = wenv(vUv.x, uTime);
  float wy = 0.5 + uAmp * e * wcarrier(vUv.x, uTime);
  float band = exp(-((vUv.y - wy) * (vUv.y - wy)) / uBand);
  fragColor = vec4(texture(uSource, vUv).rgb + uColor * band * (0.18 + 0.82 * e) * uWeight, 1.0);
}`;

// waveform → velocity: vertical push = the line's own speed, so it drags fluid and sheds smoke
const WAVE_VEL = HEAD + WSIG + `
uniform sampler2D uVelocity;
uniform float uTime, uAmp, uBand, uForce, uWeight;
void main(){
  float e = wenv(vUv.x, uTime);
  float wy = 0.5 + uAmp * e * wcarrier(vUv.x, uTime);
  float band = exp(-((vUv.y - wy) * (vUv.y - wy)) / (uBand * 4.0));
  // push fluid outward from the centre line so the waveform sheds smoke above & below
  fragColor = vec4(texture(uVelocity, vUv).xy + vec2(0.0, (wy - 0.5) * uForce) * band * uWeight, 0.0, 1.0);
}`;

// ripples → velocity: expanding concentric rings of radial force from a few drifting centres
const RIPPLE_VEL = HEAD + `
uniform sampler2D uVelocity;
uniform float uTime, uWeight, uForce, uAspect;
uniform vec2 uC0, uC1, uC2;
vec2 ring(vec2 uv, vec2 c){
  vec2 d = uv - c; d.x *= uAspect;
  float r = length(d) + 1e-4;
  float fall = exp(-r * r * 6.0);
  float puls = 0.55 + 0.45 * sin(uTime * 1.2 + dot(c, vec2(9.0, 5.0)));
  return (d / r) * sin(r * 40.0 - uTime * 3.5) * fall * puls;
}
void main(){
  vec2 f = ring(vUv, uC0) + ring(vUv, uC1) + ring(vUv, uC2);
  fragColor = vec4(texture(uVelocity, vUv).xy + f * uForce * uWeight, 0.0, 1.0);
}`;

// ripples → dye: a faint glow on the wave crests
const RIPPLE_DYE = HEAD + `
uniform sampler2D uSource;
uniform float uTime, uWeight, uAspect;
uniform vec3 uColor;
uniform vec2 uC0, uC1, uC2;
float crest(vec2 uv, vec2 c){
  vec2 d = uv - c; d.x *= uAspect;
  float r = length(d) + 1e-4;
  float fall = exp(-r * r * 6.0);
  float puls = 0.55 + 0.45 * sin(uTime * 1.2 + dot(c, vec2(9.0, 5.0)));
  return max(sin(r * 40.0 - uTime * 3.5), 0.0) * fall * puls;
}
void main(){
  float s = crest(vUv, uC0) + crest(vUv, uC1) + crest(vUv, uC2);
  fragColor = vec4(texture(uSource, vUv).rgb + uColor * s * uWeight, 1.0);
}`;

// neural net → faint static edges (the graph structure); bright pulses are splatted on top from JS
const NEURAL_EDGE = HEAD + `
uniform sampler2D uSource;
uniform float uWeight, uAspect;
uniform vec3 uColor;
uniform vec2 uN0, uN1, uN2, uN3, uN4, uN5, uN6;
float seg(vec2 p, vec2 a, vec2 b){
  p.x *= uAspect; a.x *= uAspect; b.x *= uAspect;
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float edge(vec2 p, vec2 a, vec2 b){ float d = seg(p, a, b); return exp(-d * d * 5500.0); }
void main(){
  float g = edge(vUv, uN0, uN1) + edge(vUv, uN1, uN2) + edge(vUv, uN1, uN3) + edge(vUv, uN3, uN4)
          + edge(vUv, uN3, uN5) + edge(vUv, uN5, uN6) + edge(vUv, uN4, uN6) + edge(vUv, uN0, uN3) + edge(vUv, uN2, uN4);
  fragColor = vec4(texture(uSource, vUv).rgb + uColor * g * uWeight, 1.0);
}`;

function startSim(canvas: HTMLCanvasElement): void {
  const isCoarse = matchMedia('(pointer: coarse)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, isCoarse ? 1.25 : 1.5);

  let renderer: Renderer;
  try {
    renderer = new Renderer({ canvas, webgl: 2, alpha: false, antialias: false, depth: false, stencil: false, dpr, powerPreference: 'low-power' });
  } catch {
    return;
  }
  const gl = renderer.gl as WebGL2RenderingContext;
  if (!gl.getExtension('EXT_color_buffer_float')) return;
  gl.getExtension('OES_texture_float_linear');
  const L = gl.LINEAR; // RGBA16F is filterable in core WebGL2 → smooth, never pixelated

  const SIM = isCoarse ? 110 : 160;
  const DYE = isCoarse ? 640 : 1024;
  let simW = SIM, simH = SIM, dyeW = DYE, dyeH = DYE;
  const a0 = window.innerWidth / window.innerHeight;
  if (a0 >= 1) { simW = Math.round(SIM * a0); dyeW = Math.round(DYE * a0); } else { simH = Math.round(SIM / a0); dyeH = Math.round(DYE / a0); }
  const texelSim: [number, number] = [1 / simW, 1 / simH];
  const texelDye: [number, number] = [1 / dyeW, 1 / dyeH];
  const bloomW = Math.round(dyeW / 4), bloomH = Math.round(dyeH / 4);
  const texelBloom: [number, number] = [1 / bloomW, 1 / bloomH];

  function rt(w: number, h: number, ch: number, filter: number) {
    return new RenderTarget(gl, {
      width: w, height: h, depth: false,
      internalFormat: ch === 4 ? gl.RGBA16F : gl.RG16F, format: ch === 4 ? gl.RGBA : gl.RG, type: gl.HALF_FLOAT,
      minFilter: filter, magFilter: filter, wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
    });
  }
  function dbl(w: number, h: number, ch: number, filter: number) {
    let read = rt(w, h, ch, filter), write = rt(w, h, ch, filter);
    return { get read() { return read; }, get write() { return write; }, swap() { const t = read; read = write; write = t; } };
  }

  const velocity = dbl(simW, simH, 2, L);
  const dye = dbl(dyeW, dyeH, 4, L);
  const pressure = dbl(simW, simH, 2, gl.NEAREST);
  const divergence = rt(simW, simH, 2, gl.NEAREST);
  const curl = rt(simW, simH, 2, gl.NEAREST);
  const bloom = dbl(bloomW, bloomH, 4, L);

  const tri = new Triangle(gl);
  function prog(fragment: string, uniforms: Record<string, { value: unknown }>) {
    const program = new Program(gl, { vertex: VERT, fragment, uniforms, depthTest: false, depthWrite: false });
    return { mesh: new Mesh(gl, { geometry: tri, program }), u: program.uniforms as Record<string, { value: any }> };
  }

  const splat = prog(SPLAT, { uSource: { value: null }, uPoint: { value: [0, 0] }, uColor: { value: [0, 0, 0] }, uRadius: { value: 0.0002 }, uAspect: { value: 1 } });
  const advect = prog(ADVECT, { uVelocity: { value: null }, uSource: { value: null }, uTexel: { value: texelSim }, uDt: { value: 0.016 }, uDissipation: { value: 0.2 } });
  const diverg = prog(DIVERGENCE, { uVelocity: { value: null }, uTexel: { value: texelSim } });
  const curlP = prog(CURL, { uVelocity: { value: null }, uTexel: { value: texelSim } });
  const vortP = prog(VORTICITY, { uVelocity: { value: null }, uCurl: { value: null }, uTexel: { value: texelSim }, uCurlAmt: { value: 8 }, uDt: { value: 0.016 } });
  const clearP = prog(CLEARP, { uTex: { value: null }, uValue: { value: 0.8 } });
  const press = prog(PRESSURE, { uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: texelSim } });
  const gradP = prog(GRADSUB, { uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: texelSim } });
  const prefilter = prog(PREFILTER, { uTexture: { value: null }, uThreshold: { value: 0.20 }, uKnee: { value: 0.12 } });
  const blur = prog(BLUR, { uTexture: { value: null }, uDir: { value: [0, 0] } });
  const display = prog(DISPLAY, { uDye: { value: null }, uBloom: { value: null }, uTexelDye: { value: texelDye }, uResolution: { value: [1, 1] }, uReveal: { value: 0 }, uTime: { value: 0 }, uBloomAmt: { value: 1.0 }, uWaveAmt: { value: 0 }, uWaveAmp: { value: 0.14 }, uWaveBand: { value: 0.00004 }, uWaveCol: { value: [0.5, 0.72, 1.0] } });
  const forceP = prog(FORCE, { uVelocity: { value: null }, uTime: { value: 0 }, uAmt: { value: 2.5 }, uScale: { value: 1.4 } });

  function pass(p: { mesh: Mesh }, target: RenderTarget | null) {
    renderer.render({ scene: p.mesh, target: target ?? undefined });
  }
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    display.u.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  }

  // ---- colour: cool-leaning, dim → smoky, not neon ----
  // Ruri (lapis) blue only
  const LAPIS: [number, number, number] = [0.13, 0.26, 0.46];
  function lapis(j: number): [number, number, number] { return [LAPIS[0] * j, LAPIS[1] * j, LAPIS[2] * j]; }

  // ---- motif emission programs (waveform + ripples) ----
  const waveDye = prog(WAVE_DYE, { uSource: { value: null }, uTime: { value: 0 }, uAmp: { value: 0.14 }, uBand: { value: 0.0016 }, uWeight: { value: 0 }, uColor: { value: LAPIS } });
  const waveVel = prog(WAVE_VEL, { uVelocity: { value: null }, uTime: { value: 0 }, uAmp: { value: 0.14 }, uBand: { value: 0.002 }, uForce: { value: 120 }, uWeight: { value: 0 } });
  const ripVel = prog(RIPPLE_VEL, { uVelocity: { value: null }, uTime: { value: 0 }, uWeight: { value: 0 }, uForce: { value: 60 }, uAspect: { value: 1 }, uC0: { value: [0.3, 0.5] }, uC1: { value: [0.6, 0.4] }, uC2: { value: [0.5, 0.7] } });
  const ripDye = prog(RIPPLE_DYE, { uSource: { value: null }, uTime: { value: 0 }, uWeight: { value: 0 }, uAspect: { value: 1 }, uColor: { value: LAPIS }, uC0: { value: [0.3, 0.5] }, uC1: { value: [0.6, 0.4] }, uC2: { value: [0.5, 0.7] } });
  const neuralEdge = prog(NEURAL_EDGE, { uSource: { value: null }, uWeight: { value: 0 }, uAspect: { value: 1 }, uColor: { value: LAPIS }, uN0: { value: [0, 0] }, uN1: { value: [0, 0] }, uN2: { value: [0, 0] }, uN3: { value: [0, 0] }, uN4: { value: [0, 0] }, uN5: { value: [0, 0] }, uN6: { value: [0, 0] } });

  // several big soft sources spread across the screen (even broad smoke, no gradient wash)
  const NE = 6;
  const ebx = [0.20, 0.50, 0.80, 0.34, 0.68, 0.13];   // distributed across the whole screen
  const eby = [0.34, 0.64, 0.26, 0.78, 0.70, 0.54];
  const eph = [0.0, 1.1, 2.3, 3.5, 4.7, 5.9];
  const epx = ebx.slice(), epy = eby.slice();
  // the cursor adds one more local source when present
  let emitX = 0.5, emitY = 0.5, prevEmitX = 0.5, prevEmitY = 0.5;

  const input = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, down: false, tap: false, downX: 0, downY: 0, downT: 0, lastMove: -1e4 };
  const PT: [number, number] = [0, 0];

  function doSplat(x: number, y: number, dx: number, dy: number, color: [number, number, number], radius = 0.008) {
    const aspect = window.innerWidth / window.innerHeight;
    PT[0] = x; PT[1] = y;
    splat.u.uPoint.value = PT; splat.u.uAspect.value = aspect; splat.u.uRadius.value = radius;
    splat.u.uColor.value = [dx, dy, 0];
    splat.u.uSource.value = velocity.read.texture; pass(splat, velocity.write); velocity.swap();
    splat.u.uColor.value = color;
    splat.u.uSource.value = dye.read.texture; pass(splat, dye.write); dye.swap();
  }

  function toUV(clientX: number, clientY: number): [number, number] { return [clientX / window.innerWidth, 1 - clientY / window.innerHeight]; }
  window.addEventListener('pointermove', (e) => { if (!e.isPrimary) return; const [ux, uy] = toUV(e.clientX, e.clientY); input.x = ux; input.y = uy; input.moved = true; input.lastMove = performance.now(); }, { passive: true });
  window.addEventListener('pointerdown', (e) => { if (!e.isPrimary) return; const [ux, uy] = toUV(e.clientX, e.clientY); input.x = input.px = ux; input.y = input.py = uy; input.down = true; input.downX = e.clientX; input.downY = e.clientY; input.downT = performance.now(); input.lastMove = performance.now(); }, { passive: true });
  window.addEventListener('pointerup', (e) => { if (!e.isPrimary) return; if (input.down && Math.hypot(e.clientX - input.downX, e.clientY - input.downY) < 10 && performance.now() - input.downT < 250) input.tap = true; input.down = false; }, { passive: true });

  const SPLAT_FORCE = 3200;

  // ---- motifs: same solver, different emission; slow random rotation with a crossfade, waveform featured ----
  const MOTIFS = ['waveform', 'ripples', 'neural', 'diffusion', 'drift'];
  const PICKW = [3.2, 1.3, 1.2, 1.0, 1.4];
  const W: Record<string, number> = { waveform: 0, ripples: 0, neural: 0, diffusion: 0, drift: 0 };
  function pickMotif(prev: string | null): string {
    let tot = 0;
    for (let i = 0; i < MOTIFS.length; i++) if (MOTIFS[i] !== prev) tot += PICKW[i];
    let r = Math.random() * tot;
    for (let i = 0; i < MOTIFS.length; i++) { if (MOTIFS[i] === prev) continue; r -= PICKW[i]; if (r <= 0) return MOTIFS[i]; }
    return 'waveform';
  }
  let activeMotif = pickMotif(null);
  W[activeMotif] = 1;
  let nextSwitchT = 16 + Math.random() * 10;
  // dev/preview hook: pin a motif (e.g. window.__fluidMotif('waveform')); stops rotation
  (window as unknown as { __fluidMotif?: (m: string) => void }).__fluidMotif = (m: string) => {
    if (!MOTIFS.includes(m)) return; activeMotif = m; nextSwitchT = 1e9;
    for (let i = 0; i < MOTIFS.length; i++) W[MOTIFS[i]] = MOTIFS[i] === m ? 1 : 0;
  };

  // drift — the broad ambient "wind" sources
  function emitDrift(w: number, T: number, fr: number) {
    for (let i = 0; i < NE; i++) {
      const ex = ebx[i] + 0.24 * Math.cos(T * 0.024 + eph[i]) + 0.10 * Math.cos(T * 0.055 + eph[i] * 1.7);
      const ey = eby[i] + 0.21 * Math.sin(T * 0.028 + eph[i]) + 0.09 * Math.sin(T * 0.048 + eph[i] * 1.3);
      const dvx = ex - epx[i], dvy = ey - epy[i];
      epx[i] = ex; epy[i] = ey;
      doSplat(ex, ey, (dvx * 2200 - dvy * 14) * w, (dvy * 2200 + dvx * 14) * w, lapis(0.016 * fr * w), 0.026);
    }
  }

  // waveform (hero) — a speech-like oscilloscope line dissolving into smoke
  function emitWaveform(w: number, T: number, fr: number) {
    waveDye.u.uTime.value = T; waveDye.u.uWeight.value = w * 0.07 * fr; waveDye.u.uSource.value = dye.read.texture;
    pass(waveDye, dye.write); dye.swap();
    waveVel.u.uTime.value = T; waveVel.u.uWeight.value = w * fr; waveVel.u.uVelocity.value = velocity.read.texture;
    pass(waveVel, velocity.write); velocity.swap();
  }

  // ripples (さざなみ) — expanding rings of radial force + crest glow, from a few drifting centres
  function emitRipples(w: number, T: number, fr: number) {
    const asp = window.innerWidth / window.innerHeight;
    const c0: [number, number] = [0.30 + 0.10 * Math.cos(T * 0.12), 0.52 + 0.09 * Math.sin(T * 0.10)];
    const c1: [number, number] = [0.62 + 0.09 * Math.cos(T * 0.09 + 2.0), 0.40 + 0.10 * Math.sin(T * 0.13 + 1.0)];
    const c2: [number, number] = [0.48 + 0.11 * Math.cos(T * 0.07 + 4.0), 0.70 + 0.08 * Math.sin(T * 0.11 + 3.0)];
    ripVel.u.uTime.value = T; ripVel.u.uWeight.value = w * fr; ripVel.u.uAspect.value = asp;
    ripVel.u.uC0.value = c0; ripVel.u.uC1.value = c1; ripVel.u.uC2.value = c2;
    ripVel.u.uVelocity.value = velocity.read.texture; pass(ripVel, velocity.write); velocity.swap();
    ripDye.u.uTime.value = T; ripDye.u.uWeight.value = w * 0.045 * fr; ripDye.u.uAspect.value = asp;
    ripDye.u.uC0.value = c0; ripDye.u.uC1.value = c1; ripDye.u.uC2.value = c2;
    ripDye.u.uSource.value = dye.read.texture; pass(ripDye, dye.write); dye.swap();
  }

  // neural net — pulses travel node→node along edges (leaving trails); nodes flash on arrival
  const nbx = [0.20, 0.38, 0.30, 0.56, 0.72, 0.60, 0.84];
  const nby = [0.60, 0.38, 0.22, 0.68, 0.32, 0.54, 0.46];
  const nedges = [[0, 1], [1, 2], [1, 3], [3, 4], [3, 5], [5, 6], [4, 6], [0, 3], [2, 4]];
  const npulses: { a: number; b: number; t: number; sp: number }[] = [];
  let npTimer = 0;
  const nodeX = (i: number, T: number) => nbx[i] + 0.03 * Math.cos(T * 0.21 + i * 1.7);
  const nodeY = (i: number, T: number) => nby[i] + 0.03 * Math.sin(T * 0.18 + i * 2.3);
  function emitNeural(w: number, T: number, dt: number, fr: number) {
    // faint static graph (nodes + edges) so the network structure reads under the pulses
    neuralEdge.u.uWeight.value = w * 0.012 * fr; neuralEdge.u.uAspect.value = window.innerWidth / window.innerHeight;
    neuralEdge.u.uN0.value = [nodeX(0, T), nodeY(0, T)]; neuralEdge.u.uN1.value = [nodeX(1, T), nodeY(1, T)];
    neuralEdge.u.uN2.value = [nodeX(2, T), nodeY(2, T)]; neuralEdge.u.uN3.value = [nodeX(3, T), nodeY(3, T)];
    neuralEdge.u.uN4.value = [nodeX(4, T), nodeY(4, T)]; neuralEdge.u.uN5.value = [nodeX(5, T), nodeY(5, T)];
    neuralEdge.u.uN6.value = [nodeX(6, T), nodeY(6, T)];
    neuralEdge.u.uSource.value = dye.read.texture; pass(neuralEdge, dye.write); dye.swap();
    npTimer -= dt;
    if (npTimer <= 0 && npulses.length < 16) {
      const e = nedges[(Math.random() * nedges.length) | 0];
      npulses.push({ a: e[0], b: e[1], t: 0, sp: 0.6 + Math.random() * 0.7 });
      npTimer = 0.08 + Math.random() * 0.18;
    }
    for (let i = npulses.length - 1; i >= 0; i--) {
      const p = npulses[i]; p.t += dt * p.sp;
      const ax = nodeX(p.a, T), ay = nodeY(p.a, T), bx = nodeX(p.b, T), by = nodeY(p.b, T);
      const tt = Math.min(p.t, 1);
      doSplat(ax + (bx - ax) * tt, ay + (by - ay) * tt, (bx - ax) * 150, (by - ay) * 150, lapis(0.11 * w), 0.007);
      if (p.t >= 1) { doSplat(bx, by, 0, 0, lapis(0.2 * w), 0.012); npulses.splice(i, 1); }
    }
  }

  // diffusion — a few concentrated seeds left to spread and dissolve
  let diffTimer = 0;
  function emitDiffusion(w: number, dt: number) {
    diffTimer -= dt;
    if (diffTimer <= 0) {
      doSplat(0.14 + Math.random() * 0.72, 0.20 + Math.random() * 0.60, (Math.random() - 0.5) * 240, (Math.random() - 0.5) * 240, lapis(0.7 * w), 0.014);
      diffTimer = 0.6 + Math.random() * 1.3;
    }
  }

  let visible = !document.hidden, inView = true, raf = 0;
  const t0 = performance.now();
  let prev = t0;

  function step(now: number) {
    raf = requestAnimationFrame(step);
    let dt = (now - prev) / 1000; prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);
    const T = (now - t0) / 1000;

    const fr = Math.min(dt * 60, 2);
    // ---- motif rotation (smooth crossfade between emission regimes) ----
    if (T > nextSwitchT) { activeMotif = pickMotif(activeMotif); nextSwitchT = T + 16 + Math.random() * 10; }
    const wr = 1 - Math.exp(-dt / 3.0);
    for (let i = 0; i < MOTIFS.length; i++) { const k = MOTIFS[i]; W[k] += ((k === activeMotif ? 1 : 0) - W[k]) * wr; }
    // ---- broad ambient flow — eased back under structured motifs so their shape survives ----
    forceP.u.uVelocity.value = velocity.read.texture; forceP.u.uTime.value = T;
    forceP.u.uAmt.value = 2.5 * (1 - 0.82 * W.waveform - 0.55 * W.ripples - 0.72 * W.neural);
    pass(forceP, velocity.write); velocity.swap();
    // ---- per-motif emission ----
    if (W.drift > 0.01) emitDrift(W.drift, T, fr);
    if (W.waveform > 0.01) emitWaveform(W.waveform, T, fr);
    if (W.ripples > 0.01) emitRipples(W.ripples, T, fr);
    if (W.neural > 0.01) emitNeural(W.neural, T, dt, fr);
    if (W.diffusion > 0.01) emitDiffusion(W.diffusion, dt);
    // ---- cursor: a big soft local source on top, only when present ----
    if ((now - input.lastMove) < 650) {
      emitX += (input.x - emitX) * (1 - Math.exp(-16 * dt));
      emitY += (input.y - emitY) * (1 - Math.exp(-16 * dt));
      doSplat(emitX, emitY, (emitX - prevEmitX) * SPLAT_FORCE, (emitY - prevEmitY) * SPLAT_FORCE, lapis(0.07 * fr), 0.016);
    } else { emitX = input.x; emitY = input.y; }
    prevEmitX = emitX; prevEmitY = emitY;
    input.moved = false;

    // ---- fluid step ----
    curlP.u.uVelocity.value = velocity.read.texture; pass(curlP, curl);
    vortP.u.uVelocity.value = velocity.read.texture; vortP.u.uCurl.value = curl.texture; vortP.u.uDt.value = dt; pass(vortP, velocity.write); velocity.swap();
    diverg.u.uVelocity.value = velocity.read.texture; pass(diverg, divergence);
    clearP.u.uTex.value = pressure.read.texture; pass(clearP, pressure.write); pressure.swap();
    const N = isCoarse ? 12 : 22;
    press.u.uDivergence.value = divergence.texture;
    for (let i = 0; i < N; i++) { press.u.uPressure.value = pressure.read.texture; pass(press, pressure.write); pressure.swap(); }
    gradP.u.uPressure.value = pressure.read.texture; gradP.u.uVelocity.value = velocity.read.texture; pass(gradP, velocity.write); velocity.swap();
    advect.u.uTexel.value = texelSim; advect.u.uDt.value = dt;
    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = velocity.read.texture; advect.u.uDissipation.value = 0.45;
    pass(advect, velocity.write); velocity.swap();
    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = dye.read.texture; advect.u.uDissipation.value = 0.20;
    pass(advect, dye.write); dye.swap();

    // ---- bloom (prefilter → separable blur) ----
    prefilter.u.uTexture.value = dye.read.texture; pass(prefilter, bloom.write); bloom.swap();
    for (let i = 0; i < 2; i++) {
      blur.u.uTexture.value = bloom.read.texture; blur.u.uDir.value = [texelBloom[0], 0]; pass(blur, bloom.write); bloom.swap();
      blur.u.uTexture.value = bloom.read.texture; blur.u.uDir.value = [0, texelBloom[1]]; pass(blur, bloom.write); bloom.swap();
    }

    // ---- display ----
    display.u.uDye.value = dye.read.texture; display.u.uBloom.value = bloom.read.texture;
    display.u.uReveal.value = Math.min(1, display.u.uReveal.value + dt / 1.2);
    display.u.uTime.value = T;
    display.u.uWaveAmt.value = W.waveform * 0.85;
    pass(display, null);

    if (!canvas.classList.contains('is-live')) canvas.classList.add('is-live');
  }

  function gate() {
    if (visible && inView) { if (!raf) { prev = performance.now(); raf = requestAnimationFrame(step); } }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  // seed a few smoky splats so the field isn't empty on first paint
  for (let i = 0; i < 6; i++) { const ang = Math.random() * Math.PI * 2; doSplat(Math.random(), Math.random(), Math.cos(ang) * 800, Math.sin(ang) * 800, lapis(0.6)); }
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; gate(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { inView = e.isIntersecting; gate(); }, { threshold: 0 }).observe(canvas);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (raf) cancelAnimationFrame(raf); raf = 0; });
  gate();
}

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

const DISPLAY = HEAD + `
uniform sampler2D uDye;
uniform sampler2D uBloom;
uniform vec2 uTexelDye;
uniform vec2 uResolution;
uniform float uReveal;
uniform float uTime;
uniform float uBloomAmt;
uniform float uBlack;    // black-point lift: crush faint haze to the dark base (mobile)
uniform vec2 uTextC;     // text-block centre (UV) — responsive
uniform vec2 uTextR;     // text-block ellipse radii (UV) — responsive
uniform float uTextDim;  // how much to thin the smoke over the text
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
  // lift the black point so thin blue haze falls away to the dark base, dense smoke stays
  c = max(c - uBlack, 0.0) / max(1.0 - uBlack, 1e-3);
  vec2 p = vUv - 0.5; p.x *= uResolution.x / uResolution.y;
  c *= smoothstep(1.35, 0.25, length(p));               // gentle vignette
  vec2 td = (vUv - uTextC) / uTextR;                     // soft elliptical region over the text block
  c *= mix(uTextDim, 1.0, smoothstep(0.5, 1.3, length(td)));  // thin the smoke there (no box: black stays black)
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

// big, relaxed, divergence-free flow (おおらか — broad eddies) emanating from up to
// three discrete wind sources, each a soft localized curl-noise swirl. The set of
// sources (1/2/3 of them, at random positions) is chosen from 10 patterns and
// smoothly morphed over time on the JS side.
const FORCE = HEAD + HASH + NOISE + `
uniform sampler2D uVelocity;
uniform float uTime, uAmt, uScale, uAspect;
uniform vec2 uWindP[3];
uniform float uWindW[3];
void main(){
  vec2 f = vec2(0.0);
  for (int i = 0; i < 3; i++){
    float w = uWindW[i];
    if (w <= 0.001) continue;
    vec2 d = vUv - uWindP[i]; d.x *= uAspect;
    float fall = exp(-dot(d, d) * 1.8);                 // broad falloff around the source
    vec2 p = (vUv - uWindP[i]) * uScale + vec2(uTime * 0.013, uTime * 0.010);
    float e = 0.07;
    vec2 cn = vec2(fbm(p + vec2(0.0, e)) - fbm(p - vec2(0.0, e)),
               -(fbm(p + vec2(e, 0.0)) - fbm(p - vec2(e, 0.0)))) / (2.0 * e);
    f += cn * w * fall;
  }
  fragColor = vec4(texture(uVelocity, vUv).xy + f * uAmt, 0.0, 1.0);
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
  const display = prog(DISPLAY, { uDye: { value: null }, uBloom: { value: null }, uTexelDye: { value: texelDye }, uResolution: { value: [1, 1] }, uReveal: { value: 0 }, uTime: { value: 0 }, uBloomAmt: { value: 1.0 }, uBlack: { value: 0 }, uTextC: { value: [0.2, 0.5] }, uTextR: { value: [0.34, 0.26] }, uTextDim: { value: 0.5 } });
  const forceP = prog(FORCE, { uVelocity: { value: null }, uTime: { value: 0 }, uAmt: { value: 3.6 }, uScale: { value: 1.4 }, uAspect: { value: 1 }, uWindP: { value: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }, uWindW: { value: [1, 0, 0] } });

  function pass(p: { mesh: Mesh }, target: RenderTarget | null) {
    renderer.render({ scene: p.mesh, target: target ?? undefined });
  }
  // emission source-size factor: smaller on small / portrait screens
  let srcSize = 1;
  // ambient-smoke dye factor: dimmer on portrait so the dark base shows through (less "all blue")
  let dyeMul = 1;
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    display.u.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    forceP.u.uAspect.value = window.innerWidth / window.innerHeight;
    // keep the text legible: on narrow/portrait screens the hero text spans the full
    // width and stacks taller, so widen the thinned region, recentre it, and thin harder
    const portrait = window.innerWidth < 760 || window.innerHeight >= window.innerWidth;
    if (portrait) {
      display.u.uTextC.value = [0.5, 0.46];
      display.u.uTextR.value = [0.72, 0.34];
      display.u.uTextDim.value = 0.34;
      display.u.uBloomAmt.value = 0.62;   // less glow spreading blue across the narrow frame
      display.u.uBlack.value = 0.05;      // crush faint haze so the dark base reads
      srcSize = 0.58;
      dyeMul = 0.52;
    } else {
      display.u.uTextC.value = [0.2, 0.5];
      display.u.uTextR.value = [0.34, 0.26];
      display.u.uTextDim.value = 0.5;
      display.u.uBloomAmt.value = 1.0;
      display.u.uBlack.value = 0;
      srcSize = 1;
      dyeMul = 1;
    }
  }

  // ---- colour: cool-leaning, dim → smoky, not neon ----
  // Ruri (lapis) blue only
  const LAPIS: [number, number, number] = [0.13, 0.26, 0.46];
  function lapis(j: number): [number, number, number] { return [LAPIS[0] * j, LAPIS[1] * j, LAPIS[2] * j]; }
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  // several big soft sources spread across the screen (even broad smoke, no gradient wash).
  // base positions are randomised per visit so the layout differs every load.
  const NE = 6;
  const ebx: number[] = [], eby: number[] = [], eph: number[] = [];
  for (let i = 0; i < NE; i++) { ebx.push(rnd(0.12, 0.88)); eby.push(rnd(0.22, 0.80)); eph.push(Math.random() * Math.PI * 2); }
  const epx = ebx.slice(), epy = eby.slice();
  // the cursor adds one more local source when present
  let emitX = 0.5, emitY = 0.5, prevEmitX = 0.5, prevEmitY = 0.5, cursorActive = false;

  // ---- wind: 10 patterns (1 source ×5, 2 sources ×3, 3 sources ×2), each at random
  // positions, smoothly morphing to a new random pattern every 15s ----
  type WindPattern = { p: [number, number][]; w: number[] };
  const WIND_SPEEDS = [1.0, 0.66, 0.42];               // each source picks one: current speed is the max
  function buildWind(n: number): WindPattern {
    const base: [number, number] = [rnd(0.18, 0.82), rnd(0.24, 0.78)];
    const p: [number, number][] = [], w: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (i < n) { p.push([rnd(0.15, 0.85), rnd(0.20, 0.80)]); w.push(WIND_SPEEDS[(Math.random() * 3) | 0]); }
      else { p.push([base[0], base[1]]); w.push(0); }  // dormant slot parks on an active source so fade-ins don't sweep
    }
    return { p, w };
  }
  const WIND: WindPattern[] = [];
  for (let i = 0; i < 5; i++) WIND.push(buildWind(1));
  for (let i = 0; i < 3; i++) WIND.push(buildWind(2));
  for (let i = 0; i < 2; i++) WIND.push(buildWind(3));
  const WIND_HOLD = 10, WIND_MORPH = 4;                 // seconds: time between transitions, time to morph
  let windPrev = (Math.random() * WIND.length) | 0, windCur = windPrev, windT0 = 0;
  const windP = [0, 0, 0, 0, 0, 0];                     // flat vec2[3], mutated in place
  const windW = [0, 0, 0];
  forceP.u.uWindP.value = windP; forceP.u.uWindW.value = windW;

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
  let visible = !document.hidden, inView = true, raf = 0;
  const t0 = performance.now();
  let prev = t0;

  function step(now: number) {
    raf = requestAnimationFrame(step);
    let dt = (now - prev) / 1000; prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);
    const T = (now - t0) / 1000;

    const fr = Math.min(dt * 60, 2);
    // ---- wind: advance the 15s cycle and morph between the current/next pattern ----
    if (T - windT0 >= WIND_HOLD) {
      windT0 += WIND_HOLD;
      windPrev = windCur;
      let n = windCur; while (n === windCur) n = (Math.random() * WIND.length) | 0;
      windCur = n;
    }
    const k = Math.min(1, (T - windT0) / WIND_MORPH);
    const ease = k * k * (3 - 2 * k);
    const wa = WIND[windPrev], wb = WIND[windCur];
    for (let i = 0; i < 3; i++) {
      windP[i * 2] = wa.p[i][0] + (wb.p[i][0] - wa.p[i][0]) * ease;
      windP[i * 2 + 1] = wa.p[i][1] + (wb.p[i][1] - wa.p[i][1]) * ease;
      windW[i] = wa.w[i] + (wb.w[i] - wa.w[i]) * ease;
    }
    // ---- a gentle, relaxed broad flow (おおらか) from the active wind sources ----
    forceP.u.uVelocity.value = velocity.read.texture; forceP.u.uTime.value = T; pass(forceP, velocity.write); velocity.swap();
    // ---- several big soft sources drifting across the screen → even broad smoke, no gradient wash ----
    for (let i = 0; i < NE; i++) {
      const ex = ebx[i] + 0.24 * Math.cos(T * 0.024 + eph[i]) + 0.10 * Math.cos(T * 0.055 + eph[i] * 1.7);
      const ey = eby[i] + 0.21 * Math.sin(T * 0.028 + eph[i]) + 0.09 * Math.sin(T * 0.048 + eph[i] * 1.3);
      const dvx = ex - epx[i], dvy = ey - epy[i];
      epx[i] = ex; epy[i] = ey;
      doSplat(ex, ey, dvx * 2200 - dvy * 14, dvy * 2200 + dvx * 14, lapis(0.016 * fr * dyeMul), 0.021 * srcSize);  // soft source, broad wind
    }
    // ---- cursor: a big soft local source on top, only when present ----
    if ((now - input.lastMove) < 650) {
      // on re-appearance from idle, teleport the source to the cursor (zero velocity)
      // so it doesn't streak across the screen catching up from its last position
      if (!cursorActive) { emitX = prevEmitX = input.x; emitY = prevEmitY = input.y; }
      emitX += (input.x - emitX) * (1 - Math.exp(-16 * dt));
      emitY += (input.y - emitY) * (1 - Math.exp(-16 * dt));
      // bright dye on the cursor so it crosses the bloom threshold and reads as a luminous,
      // glowing trail — the main sense of interaction (mobile stays a touch gentler)
      doSplat(emitX, emitY, (emitX - prevEmitX) * SPLAT_FORCE, (emitY - prevEmitY) * SPLAT_FORCE, lapis((0.06 + 0.13 * srcSize) * fr), 0.0095 * srcSize);
      cursorActive = true;
    } else { emitX = input.x; emitY = input.y; cursorActive = false; }
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

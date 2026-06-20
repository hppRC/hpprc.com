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
  vec2 p = vUv - 0.5; p.x *= uResolution.x / uResolution.y;
  c *= smoothstep(1.35, 0.25, length(p));               // gentle vignette
  float gr = fract(sin(dot(vUv * uResolution + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += gr * 0.006;
  fragColor = vec4(c * uReveal, 1.0);
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
  const vortP = prog(VORTICITY, { uVelocity: { value: null }, uCurl: { value: null }, uTexel: { value: texelSim }, uCurlAmt: { value: 30 }, uDt: { value: 0.016 } });
  const clearP = prog(CLEARP, { uTex: { value: null }, uValue: { value: 0.8 } });
  const press = prog(PRESSURE, { uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: texelSim } });
  const gradP = prog(GRADSUB, { uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: texelSim } });
  const prefilter = prog(PREFILTER, { uTexture: { value: null }, uThreshold: { value: 0.20 }, uKnee: { value: 0.12 } });
  const blur = prog(BLUR, { uTexture: { value: null }, uDir: { value: [0, 0] } });
  const display = prog(DISPLAY, { uDye: { value: null }, uBloom: { value: null }, uTexelDye: { value: texelDye }, uResolution: { value: [1, 1] }, uReveal: { value: 0 }, uTime: { value: 0 }, uBloomAmt: { value: 0.85 } });

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
  function hsv(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return [m[0], m[1], m[2]];
  }
  function genColor(): [number, number, number] {
    const h = (0.5 + Math.random() * 0.42) % 1; // cyan → blue → violet → magenta
    const c = hsv(h, 0.7 + Math.random() * 0.25, 1);
    return [c[0] * 0.30, c[1] * 0.30, c[2] * 0.30];
  }
  let curColor = genColor();

  const input = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, down: false, tap: false, downX: 0, downY: 0, downT: 0, lastMove: -1e4 };
  const PT: [number, number] = [0, 0];

  function doSplat(x: number, y: number, dx: number, dy: number, color: [number, number, number]) {
    const aspect = window.innerWidth / window.innerHeight;
    PT[0] = x; PT[1] = y;
    splat.u.uPoint.value = PT; splat.u.uAspect.value = aspect; splat.u.uRadius.value = 0.0024;
    splat.u.uColor.value = [dx, dy, 0];
    splat.u.uSource.value = velocity.read.texture; pass(splat, velocity.write); velocity.swap();
    splat.u.uColor.value = color;
    splat.u.uSource.value = dye.read.texture; pass(splat, dye.write); dye.swap();
  }

  function toUV(clientX: number, clientY: number): [number, number] { return [clientX / window.innerWidth, 1 - clientY / window.innerHeight]; }
  window.addEventListener('pointermove', (e) => { if (!e.isPrimary) return; const [ux, uy] = toUV(e.clientX, e.clientY); input.x = ux; input.y = uy; input.moved = true; input.lastMove = performance.now(); }, { passive: true });
  window.addEventListener('pointerdown', (e) => { if (!e.isPrimary) return; const [ux, uy] = toUV(e.clientX, e.clientY); input.x = input.px = ux; input.y = input.py = uy; input.down = true; input.downX = e.clientX; input.downY = e.clientY; input.downT = performance.now(); input.lastMove = performance.now(); curColor = genColor(); }, { passive: true });
  window.addEventListener('pointerup', (e) => { if (!e.isPrimary) return; if (input.down && Math.hypot(e.clientX - input.downX, e.clientY - input.downY) < 10 && performance.now() - input.downT < 250) input.tap = true; input.down = false; }, { passive: true });

  const SPLAT_FORCE = 6400;
  let visible = !document.hidden, inView = true, raf = 0;
  const t0 = performance.now();
  let prev = t0, lastAuto = 0;

  function step(now: number) {
    raf = requestAnimationFrame(step);
    let dt = (now - prev) / 1000; prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);
    const T = (now - t0) / 1000;

    // ---- inputs ----
    if (input.moved) {
      const dx = (input.x - input.px) * SPLAT_FORCE, dy = (input.y - input.py) * SPLAT_FORCE;
      doSplat(input.x, input.y, dx, dy, curColor);
      input.px = input.x; input.py = input.y; input.moved = false;
    }
    if (input.tap) {
      const c = genColor();
      for (let i = 0; i < 6; i++) { const ang = (i / 6) * Math.PI * 2; doSplat(input.x, input.y, Math.cos(ang) * SPLAT_FORCE * 0.4, Math.sin(ang) * SPLAT_FORCE * 0.4, c); }
      input.tap = false;
    }
    // autonomous life: gentle moving splats keep ambient smoke alive at all times
    if (T - lastAuto > 0.38) {
      lastAuto = T;
      const x = Math.random(), y = Math.random();
      const ang = Math.random() * Math.PI * 2, mag = 650 + Math.random() * 1100;
      doSplat(x, y, Math.cos(ang) * mag, Math.sin(ang) * mag, genColor());
    }

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
    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = velocity.read.texture; advect.u.uDissipation.value = 0.18;
    pass(advect, velocity.write); velocity.swap();
    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = dye.read.texture; advect.u.uDissipation.value = 0.5;
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
  for (let i = 0; i < 8; i++) { const ang = Math.random() * Math.PI * 2; doSplat(Math.random(), Math.random(), Math.cos(ang) * 900, Math.sin(ang) * 900, genColor()); }
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; gate(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { inView = e.isIntersecting; gate(); }, { threshold: 0 }).observe(canvas);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (raf) cancelAnimationFrame(raf); raf = 0; });
  gate();
}

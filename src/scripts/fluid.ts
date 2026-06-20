// fluid.ts — hero background: a REAL GPU stable-fluids simulation (WebGL2, FBO
// ping-pong) that the cursor actually STIRS. The cursor injects velocity + dye
// into a persistent field; vorticity confinement keeps it chaotic; the field
// keeps swirling after the cursor leaves. Rendered dark near-black with a
// restrained lapis whisper — no rainbow, no bloom, no cursor glow. (Stage A:
// fluid core + autonomous life. Particles + motif regimes layer on next.)
// Deferred + gated; falls back to the static CSS poster when WebGL2 / float
// render targets are unavailable.
import { Renderer, RenderTarget, Program, Mesh, Triangle } from 'ogl';

// ---- capability probe on a throwaway canvas (so we never wedge the real one) ----
function simCapable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { alpha: false }) as WebGL2RenderingContext | null;
    if (!gl) return false;
    if (!gl.getExtension('EXT_color_buffer_float')) return false;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 4, 4, 0, gl.RG, gl.HALF_FLOAT, null);
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
  if (!simCapable()) return; // static poster remains the complete design
  startSim(canvas);
}

const VERT = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

const SPLAT = HEAD + `
uniform sampler2D uSource;
uniform vec2 uPoint;
uniform vec2 uColor;
uniform float uRadius;
uniform float uAspect;
void main(){
  vec2 d = vUv - uPoint; d.x *= uAspect;
  float g = exp(-dot(d, d) / uRadius);
  fragColor = vec4(texture(uSource, vUv).xy + uColor * g, 0.0, 1.0);
}`;

const ADVECT = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDecay;
void main(){
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uTexel;
  fragColor = vec4(texture(uSource, coord).xy * uDecay, 0.0, 1.0);
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
  vec2 vel = texture(uVelocity, vUv).xy;
  fragColor = vec4(vel + force * uDt, 0.0, 1.0);
}`;

const CLEARP = HEAD + `
uniform sampler2D uTex;
uniform float uValue;
void main(){ fragColor = vec4(texture(uTex, vUv).xy * uValue, 0.0, 1.0); }`;

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

const COMPOSITE = HEAD + `
uniform sampler2D uDye;
uniform sampler2D uCurl;
uniform vec2 uResolution;
uniform vec3 uLapis;
uniform float uReveal;
uniform float uTime;
void main(){
  float dye = texture(uDye, vUv).x;
  float curl = abs(texture(uCurl, vUv).x);
  vec3 base = vec3(0.031, 0.035, 0.047);
  vec3 graphite = vec3(0.060, 0.070, 0.085);
  float structure = clamp(dye * 0.85 + curl * 0.04, 0.0, 1.0);
  vec3 col = base;
  col += graphite * smoothstep(0.015, 0.5, structure);
  col += uLapis * pow(clamp(dye, 0.0, 1.0), 1.7) * 0.24;
  vec2 p = vUv - 0.5; p.x *= uResolution.x / uResolution.y;
  col *= smoothstep(1.28, 0.26, length(p));
  float gr = fract(sin(dot(vUv * uResolution + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += gr * 0.012;
  col = mix(base * smoothstep(1.28, 0.26, length(p)), col, uReveal);
  fragColor = vec4(col, 1.0);
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
  const linear = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;

  // ---- simulation resolution (NOT scaled by DPR — the key perf lever) ----
  const SIM = isCoarse ? 96 : 128;
  const DYE = isCoarse ? 384 : 512;
  let simW = SIM, simH = SIM, dyeW = DYE, dyeH = DYE;
  let texelSim: [number, number] = [1 / SIM, 1 / SIM];
  function computeRes() {
    const a = window.innerWidth / window.innerHeight;
    if (a >= 1) { simW = Math.round(SIM * a); simH = SIM; dyeW = Math.round(DYE * a); dyeH = DYE; }
    else { simW = SIM; simH = Math.round(SIM / a); dyeW = DYE; dyeH = Math.round(DYE / a); }
    texelSim = [1 / simW, 1 / simH];
  }
  computeRes();

  function rt(w: number, h: number, filter: number) {
    return new RenderTarget(gl, {
      width: w, height: h, depth: false,
      internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT,
      minFilter: filter, magFilter: filter, wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
    });
  }
  function dbl(w: number, h: number, filter: number) {
    let read = rt(w, h, filter), write = rt(w, h, filter);
    return { get read() { return read; }, get write() { return write; }, swap() { const t = read; read = write; write = t; } };
  }

  let velocity = dbl(simW, simH, linear);
  let dye = dbl(dyeW, dyeH, linear);
  let pressure = dbl(simW, simH, gl.NEAREST);
  let divergence = rt(simW, simH, gl.NEAREST);
  let curl = rt(simW, simH, gl.NEAREST);

  const tri = new Triangle(gl);
  function prog(fragment: string, uniforms: Record<string, { value: unknown }>) {
    const program = new Program(gl, { vertex: VERT, fragment, uniforms, depthTest: false, depthWrite: false });
    return { program, mesh: new Mesh(gl, { geometry: tri, program }), u: program.uniforms as Record<string, { value: any }> };
  }

  const splat = prog(SPLAT, { uSource: { value: null }, uPoint: { value: [0, 0] }, uColor: { value: [0, 0] }, uRadius: { value: 0.0002 }, uAspect: { value: 1 } });
  const advect = prog(ADVECT, { uVelocity: { value: null }, uSource: { value: null }, uTexel: { value: texelSim }, uDt: { value: 0.016 }, uDecay: { value: 0.98 } });
  const diverg = prog(DIVERGENCE, { uVelocity: { value: null }, uTexel: { value: texelSim } });
  const curlP = prog(CURL, { uVelocity: { value: null }, uTexel: { value: texelSim } });
  const vortP = prog(VORTICITY, { uVelocity: { value: null }, uCurl: { value: null }, uTexel: { value: texelSim }, uCurlAmt: { value: 22 }, uDt: { value: 0.016 } });
  const clearP = prog(CLEARP, { uTex: { value: null }, uValue: { value: 0.8 } });
  const press = prog(PRESSURE, { uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: texelSim } });
  const gradP = prog(GRADSUB, { uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: texelSim } });
  const comp = prog(COMPOSITE, { uDye: { value: null }, uCurl: { value: null }, uResolution: { value: [1, 1] }, uLapis: { value: [0.18, 0.36, 0.62] }, uReveal: { value: 0 }, uTime: { value: 0 } });

  function pass(p: { mesh: Mesh }, target: RenderTarget | null) {
    renderer.render({ scene: p.mesh, target: target ?? undefined });
  }

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    comp.u.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    const a = window.innerWidth / window.innerHeight;
    splat.u.uAspect.value = a;
  }

  // pre-allocated input (no per-frame / per-event allocation → no click jank)
  const input = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, down: false, tap: false, downX: 0, downY: 0, downT: 0, lastMove: -1e4 };
  const PT: [number, number] = [0, 0];
  const COL: [number, number] = [0, 0];

  function splatVel(x: number, y: number, fx: number, fy: number, radius: number) {
    PT[0] = x; PT[1] = y; COL[0] = fx; COL[1] = fy;
    splat.u.uSource.value = velocity.read.texture;
    splat.u.uPoint.value = PT; splat.u.uColor.value = COL; splat.u.uRadius.value = radius;
    pass(splat, velocity.write); velocity.swap();
  }
  function splatDye(x: number, y: number, amount: number, radius: number) {
    PT[0] = x; PT[1] = y; COL[0] = amount; COL[1] = 0;
    splat.u.uSource.value = dye.read.texture;
    splat.u.uPoint.value = PT; splat.u.uColor.value = COL; splat.u.uRadius.value = radius;
    pass(splat, dye.write); dye.swap();
  }

  const SPLAT_FORCE = 6200;
  function pointerToUV(clientX: number, clientY: number): [number, number] {
    return [clientX / window.innerWidth, 1 - clientY / window.innerHeight];
  }
  window.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    const [ux, uy] = pointerToUV(e.clientX, e.clientY);
    input.x = ux; input.y = uy; input.moved = true; input.lastMove = performance.now();
  }, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    const [ux, uy] = pointerToUV(e.clientX, e.clientY);
    input.x = input.px = ux; input.y = input.py = uy;
    input.down = true; input.downX = e.clientX; input.downY = e.clientY; input.downT = performance.now();
    input.lastMove = performance.now();
  }, { passive: true });
  window.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
    // a tap (not a stir) = a radial "drop" → real ripples emerge from the pressure solve
    if (input.down && Math.hypot(e.clientX - input.downX, e.clientY - input.downY) < 10 && performance.now() - input.downT < 250) {
      input.tap = true;
    }
    input.down = false;
  }, { passive: true });

  // ---- loop ----
  let visible = !document.hidden, inView = true, raf = 0;
  const t0 = performance.now();
  let prev = t0;
  let autoPhase = Math.random() * 1000;

  function step(now: number) {
    raf = requestAnimationFrame(step);
    let dt = (now - prev) / 1000; prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);
    const T = (now - t0) / 1000;

    // ---- inputs → splats ----
    // cursor stir: strong velocity + a little dye where it moves
    if (input.moved) {
      const dx = input.x - input.px, dy = input.y - input.py;
      const a = window.innerWidth / window.innerHeight;
      splatVel(input.x, input.y, dx * SPLAT_FORCE, dy * SPLAT_FORCE, 0.00018 * a);
      const speed = Math.min(Math.hypot(dx, dy) * 14, 1);
      splatDye(input.x, input.y, 0.06 + 0.20 * speed, 0.00014 * a);
      input.px = input.x; input.py = input.y; input.moved = false;
    }
    if (input.tap) {
      // radial outward velocity burst + dye drop
      const a = window.innerWidth / window.innerHeight;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        splatVel(input.x, input.y, Math.cos(ang) * SPLAT_FORCE * 0.5, Math.sin(ang) * SPLAT_FORCE * 0.5, 0.00022 * a);
      }
      splatDye(input.x, input.y, 0.5, 0.0003 * a);
      input.tap = false;
    }
    // autonomous life: two slow wandering stirrers keep the field alive when idle
    const a = window.innerWidth / window.innerHeight;
    const ax = 0.5 + 0.32 * Math.sin(T * 0.11 + autoPhase), ay = 0.5 + 0.26 * Math.cos(T * 0.08 + autoPhase);
    splatVel(ax, ay, Math.cos(T * 0.7) * 380, Math.sin(T * 0.9) * 380, 0.0006 * a);
    const bx = 0.5 + 0.36 * Math.cos(T * 0.07 - autoPhase), by = 0.5 + 0.30 * Math.sin(T * 0.1 - autoPhase);
    splatVel(bx, by, Math.sin(T * 0.6) * 340, Math.cos(T * 0.8) * 340, 0.0006 * a);
    if (Math.floor(T * 2) !== Math.floor((T - dt) * 2)) splatDye(ax, ay, 0.10, 0.0008 * a); // a soft puff ~2/s

    // ---- fluid step ----
    curlP.u.uVelocity.value = velocity.read.texture; curlP.u.uTexel.value = texelSim;
    pass(curlP, curl);

    vortP.u.uVelocity.value = velocity.read.texture; vortP.u.uCurl.value = curl.texture; vortP.u.uTexel.value = texelSim; vortP.u.uDt.value = dt;
    pass(vortP, velocity.write); velocity.swap();

    diverg.u.uVelocity.value = velocity.read.texture; diverg.u.uTexel.value = texelSim;
    pass(diverg, divergence);

    clearP.u.uTex.value = pressure.read.texture;
    pass(clearP, pressure.write); pressure.swap();

    const N = isCoarse ? 10 : 20;
    press.u.uDivergence.value = divergence.texture; press.u.uTexel.value = texelSim;
    for (let i = 0; i < N; i++) {
      press.u.uPressure.value = pressure.read.texture;
      pass(press, pressure.write); pressure.swap();
    }

    gradP.u.uPressure.value = pressure.read.texture; gradP.u.uVelocity.value = velocity.read.texture; gradP.u.uTexel.value = texelSim;
    pass(gradP, velocity.write); velocity.swap();

    advect.u.uTexel.value = texelSim; advect.u.uDt.value = dt;
    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = velocity.read.texture; advect.u.uDecay.value = 0.985;
    pass(advect, velocity.write); velocity.swap();

    advect.u.uVelocity.value = velocity.read.texture; advect.u.uSource.value = dye.read.texture; advect.u.uDecay.value = 0.972;
    pass(advect, dye.write); dye.swap();

    // ---- composite to screen ----
    comp.u.uDye.value = dye.read.texture; comp.u.uCurl.value = curl.texture;
    comp.u.uReveal.value = Math.min(1, comp.u.uReveal.value + dt / 1.2);
    comp.u.uTime.value = T;
    pass(comp, null);

    if (!canvas.classList.contains('is-live')) canvas.classList.add('is-live');
  }

  function gate() {
    if (visible && inView) { if (!raf) { prev = performance.now(); raf = requestAnimationFrame(step); } }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---- prewarm: seed some turbulence + run a couple of steps so first interaction never compiles ----
  resize();
  window.addEventListener('resize', () => { computeRes(); resize(); }, { passive: true });
  for (let i = 0; i < 14; i++) {
    const x = Math.random(), y = Math.random();
    splatVel(x, y, (Math.random() - 0.5) * 1600, (Math.random() - 0.5) * 1600, 0.0008);
    splatDye(x, y, 0.18, 0.001);
  }

  document.addEventListener('visibilitychange', () => { visible = !document.hidden; gate(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; gate(); }, { threshold: 0 }).observe(canvas);
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (raf) cancelAnimationFrame(raf); raf = 0; });
  gate();
}

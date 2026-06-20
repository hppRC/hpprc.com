// fluid.ts — hero background: a single-pass curl/domain-warped flow field.
// Original GLSL. Reacts to pointer (mouse) and touch as "stirring a calm
// medium" — a trailing wake follows motion, a tap drops one quiet ring, and
// everything friction-decays back to the autonomous drift. No second GPU pass,
// no dye/bloom; luminance-only, monochrome with a faint lapis whisper.
// Deferred + code-split (loaded only when boot.ts's gate allows it).
import { Renderer, Triangle, Program, Mesh } from 'ogl';

const vertex = /* glsl */ `
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2  uResolution;
  uniform float uTime;
  uniform float uReveal;     // 0->1 bloom-in
  uniform vec2  uPointer;    // eased pointer, aspect-corrected space
  uniform vec2  uPointerLag; // slower follower -> analytic wake
  uniform float uPointerOn;  // 0..1 presence (self-heals after last move)
  uniform float uPointerVel; // 0..~1.2 recent speed
  uniform vec3  uRippleA;    // xy = origin (aspect space), z = start time (<0 = empty)
  uniform vec3  uRippleB;
  uniform vec3  uRippleC;
  uniform float uWaveSpeed;
  uniform vec3  uLapis;

  float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.02 + vec2(11.3, 7.7); a *= 0.5; }
    return v;
  }

  // a single self-extinguishing ring; accumulates a radial displacement + a luminance lobe
  void addRipple(vec3 R, vec2 p, float time, inout vec2 disp, inout float lum){
    if (R.z < 0.0) return;
    float age = time - R.z;
    if (age < 0.0 || age > 1.4) return;
    float d = length(p - R.xy);
    float ring = sin((d - age * uWaveSpeed) * 10.0) * exp(-d * 3.0) * (1.0 - smoothstep(0.0, 1.2, age));
    vec2 dir = d > 1e-4 ? (p - R.xy) / d : vec2(0.0);
    disp += dir * ring * 0.02;
    lum += ring;
  }

  void main(){
    vec2 res = uResolution;
    vec2 p = vUv - 0.5;
    p.x *= res.x / res.y;            // aspect-correct

    float t = uTime * 0.035;

    // disturbance center trails the cursor (analytic wake), then settles
    vec2 pc = mix(uPointerLag, uPointer, 0.7);
    vec2 toP = p - pc;
    float pd = length(toP);
    float infl = uPointerOn * exp(-pd * pd * 5.5);
    vec2 swirl = vec2(-toP.y, toP.x) * infl * (0.25 + 1.2 * uPointerVel);
    vec2 pull  = -toP * infl * 0.35;

    // tap ripples (no extra GPU pass)
    vec2 rDisp = vec2(0.0);
    float rLum = 0.0;
    addRipple(uRippleA, p, uTime, rDisp, rLum);
    addRipple(uRippleB, p, uTime, rDisp, rLum);
    addRipple(uRippleC, p, uTime, rDisp, rLum);

    // domain-warped fbm, nudged by pointer field + ripples
    vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, -t * 0.8)));
    vec2 warp = p * 1.7 + 1.7 * q + swirl + pull * 0.5 + rDisp;
    vec2 r = vec2(fbm(warp + vec2(1.7, 9.2) + 0.12 * t), fbm(warp + vec2(8.3, 2.8) - 0.1 * t));
    float f = fbm(p * 2.0 + 2.2 * r + swirl * 1.5 + rDisp);

    float veil = smoothstep(0.28, 0.95, f);
    veil += infl * 0.22 * uPointerVel;

    vec3 base = vec3(0.031, 0.035, 0.043);
    vec3 graphite = vec3(0.060, 0.068, 0.082);
    vec3 col = mix(base, graphite, veil);

    float core = pow(veil, 3.2);
    col += uLapis * core * 0.10;
    col += uLapis * infl * (0.05 + 0.18 * uPointerVel);  // lapis whisper trails the cursor
    col += uLapis * max(rLum, 0.0) * 0.04;               // tap ring whisper (luminance only)

    // faint embedding-like points advected by the warp
    vec2 g = warp * 9.0;
    float dotMask = step(0.984, hash(floor(g)));
    float dd = length(fract(g) - 0.5);
    float point = dotMask * smoothstep(0.16, 0.0, dd) * (0.3 + 0.7 * veil);
    col += (uLapis * 0.6 + 0.4) * point * 0.05;

    float vig = smoothstep(1.2, 0.35, length(p));
    col *= vig;

    float grain = hash(vUv * res + fract(uTime) * 97.0) - 0.5;
    col += grain * 0.012;                                 // dither kills banding

    col = mix(base * vig, col, uReveal);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function start(canvas: HTMLCanvasElement): void {
  const reduceMM = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMM.matches) return;

  const isCoarse = matchMedia('(pointer: coarse)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, isCoarse ? 1.4 : 1.75);

  let renderer: Renderer;
  try {
    renderer = new Renderer({ canvas, alpha: false, antialias: false, depth: false, dpr, powerPreference: 'low-power' });
  } catch {
    return;
  }
  const gl = renderer.gl;
  gl.clearColor(0.031, 0.035, 0.043, 1);

  const empty = (): [number, number, number] => [0, 0, -1];
  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms: {
      uResolution: { value: [1, 1] },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uPointer: { value: [0, 0] },
      uPointerLag: { value: [0, 0] },
      uPointerOn: { value: 0 },
      uPointerVel: { value: 0 },
      uRippleA: { value: empty() },
      uRippleB: { value: empty() },
      uRippleC: { value: empty() },
      uWaveSpeed: { value: 0.8 },
      uLapis: { value: [0.18, 0.36, 0.62] },
    },
  });
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    program.uniforms.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // ---- unified pointer (mouse + touch + pen); canvas is pointer-events:none ----
  const t0 = performance.now();
  let tx = 0, ty = 0;     // raw target
  let cx = 0, cy = 0;     // eased pointer
  let lx = 0, ly = 0;     // lagged follower (wake)
  let vel = 0, velTarget = 0;
  let lastMove = -1e4, lpx = 0, lpy = 0;
  let downX = 0, downY = 0, downT = 0;
  const ripples: [number, number, number][] = [empty(), empty(), empty()];
  let ri = 0;

  function toXY(clientX: number, clientY: number): [number, number] {
    const asp = window.innerWidth / window.innerHeight;
    return [(clientX / window.innerWidth - 0.5) * asp, -(clientY / window.innerHeight - 0.5)];
  }

  window.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    const [nx, ny] = toXY(e.clientX, e.clientY);
    velTarget = Math.min(Math.hypot(nx - lpx, ny - lpy) * 6.0, 1.2);
    lpx = nx; lpy = ny; tx = nx; ty = ny;
    lastMove = performance.now();
  }, { passive: true });

  window.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    const [nx, ny] = toXY(e.clientX, e.clientY);
    lpx = nx; lpy = ny; tx = nx; ty = ny;       // seed so the first delta isn't a flash
    lastMove = downT = performance.now();
    downX = e.clientX; downY = e.clientY;
  }, { passive: true });

  window.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
    const now = performance.now();
    // tap (not a drag/scroll) → drop one spatial ring
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 10 && now - downT < 250) {
      const [nx, ny] = toXY(e.clientX, e.clientY);
      ripples[ri] = [nx, ny, (now - t0) / 1000];
      ri = (ri + 1) % ripples.length;
    }
  }, { passive: true });

  const calm = () => { velTarget = 0; };
  window.addEventListener('pointercancel', calm, { passive: true });
  window.addEventListener('blur', calm);

  // ---- loop, gated by visibility + in-view ----
  let visible = !document.hidden;
  let inView = true;
  let raf = 0;
  let prev = t0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    let dt = (now - prev) / 1000;
    prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);     // frame-rate independent, stutter-proof

    cx += (tx - cx) * (1 - Math.exp(-5.0 * dt));
    cy += (ty - cy) * (1 - Math.exp(-5.0 * dt));
    lx += (tx - lx) * (1 - Math.exp(-1.3 * dt));       // slower → trails, then settles
    ly += (ty - ly) * (1 - Math.exp(-1.3 * dt));
    vel += (velTarget - vel) * (1 - Math.exp(-7.7 * dt));
    velTarget *= Math.pow(0.94, dt * 60);

    const u = program.uniforms;
    u.uTime.value = (now - t0) / 1000;
    u.uPointer.value = [cx, cy];
    u.uPointerLag.value = [lx, ly];
    u.uPointerOn.value = Math.max(0, 1 - (now - lastMove) / 2600);
    u.uPointerVel.value = vel;
    u.uRippleA.value = ripples[0];
    u.uRippleB.value = ripples[1];
    u.uRippleC.value = ripples[2];
    u.uReveal.value = Math.min(1, u.uReveal.value + dt / 1.1);

    renderer.render({ scene: mesh });
    if (!canvas.classList.contains('is-live')) canvas.classList.add('is-live');
  }

  function gate() {
    if (visible && inView) {
      if (!raf) { prev = performance.now(); raf = requestAnimationFrame(frame); }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  document.addEventListener('visibilitychange', () => { visible = !document.hidden; gate(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; gate(); }, { threshold: 0 }).observe(canvas);
  }
  // honour an OS reduced-motion toggle flipped after load
  reduceMM.addEventListener?.('change', () => {
    if (reduceMM.matches && raf) { cancelAnimationFrame(raf); raf = 0; canvas.classList.remove('is-live'); }
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });
  canvas.addEventListener('webglcontextrestored', () => { resize(); gate(); });

  gate();
}

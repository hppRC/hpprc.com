// fluid.ts — hero background: ONE single-pass curl/domain-warped flow field that
// morphs between 5 MOTIFS (ripples / wind / voice waveform / neural net /
// diffusion), each a re-reading of the same warped-fbm medium. The base field
// never turns off; every motif is a weighted skin, so any half-morphed frame is
// valid. The CPU owns the morph (random current→next over time) and seeds a
// per-visit phase + domain offset so no two visits feel the same. Pointer/touch
// reactive: a trailing wake, a glowing cursor trail, and tap ripples — all
// luminance-only, monochrome near-black with a restrained lapis whisper.
// No FBO, no second pass. Deferred + code-split (loaded only when gated in).
import { Renderer, Triangle, Program, Mesh } from 'ogl';

// glowing cursor trail = N recent path samples as individual vec3 uniforms
// (OGL doesn't reliably upload a `vec3[]` array uniform, so we unroll them).
const TRAIL_N = 16;
const trailDecl = Array.from({ length: TRAIL_N }, (_, i) => `uniform vec3 uTr${i};`).join('\n  ');
const trailAccum = Array.from({ length: TRAIL_N }, (_, i) => `tp(uTr${i}, p, uTime, uTrailLife, trail);`).join('\n    ');

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
  uniform float uReveal;
  uniform vec2  uPointer;
  uniform vec2  uPointerLag;
  uniform float uPointerOn;
  uniform float uPointerVel;
  uniform vec3  uRippleA;
  uniform vec3  uRippleB;
  uniform vec3  uRippleC;
  uniform float uWaveSpeed;
  uniform vec3  uLapis;
  ${trailDecl}
  uniform float uTrailLife;
  uniform vec4  uMotif;            // x=ripple y=wind z=voice w=net  (weights 0..1)
  uniform float uMotifDiff;        // diffusion weight
  uniform vec2  uWindDir;
  uniform float uCalm;
  uniform float uStretch;
  uniform float uWaveK;
  uniform float uFlowSpeed;
  uniform float uSigma;
  uniform float uNetSparse;
  uniform float uBands;
  uniform float uIntensity;
  uniform vec2  uSeed;

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
  // one glowing trail sample
  void tp(vec3 s, vec2 p, float time, float life, inout float tr){
    if (s.z < 0.0) return;
    float age = time - s.z;
    if (age < 0.0 || age > life) return;
    float w = 1.0 - age / life;
    tr += exp(-dot(p - s.xy, p - s.xy) * 44.0) * w * w;
  }

  void main(){
    vec2 res = uResolution;
    vec2 p = vUv - 0.5;
    p.x *= res.x / res.y;
    float t = uTime * 0.06;
    vec2 seedOff = uSeed;

    float wR = uMotif.x, wW = uMotif.y, wV = uMotif.z, wN = uMotif.w, wD = uMotifDiff;
    float wBase = clamp(1.0 - (wR + wW + wV + wN + wD), 0.0, 1.0);

    // autonomous wandering centers
    vec2 autoC = vec2(sin(uTime * 0.13) * 0.55, cos(uTime * 0.10) * 0.34);
    vec2 toA = p - autoC; float aInfl = exp(-dot(toA, toA) * 2.2);
    vec2 autoSwirl = vec2(-toA.y, toA.x) * aInfl * 0.6;
    vec2 autoC2 = vec2(cos(uTime * 0.08) * -0.5, sin(uTime * 0.115) * 0.42);
    vec2 toB = p - autoC2; float bInfl = exp(-dot(toB, toB) * 2.6);
    autoSwirl += vec2(-toB.y, toB.x) * bInfl * 0.5;

    // pointer wake
    vec2 pc = mix(uPointerLag, uPointer, 0.7);
    vec2 toP = p - pc; float pd = length(toP);
    float infl = uPointerOn * exp(-pd * pd * 5.5);
    vec2 swirl = vec2(-toP.y, toP.x) * infl * (0.45 + 2.0 * uPointerVel);
    vec2 pull  = -toP * infl * 0.55;

    // tap ripples
    vec2 rDisp = vec2(0.0); float rLum = 0.0;
    addRipple(uRippleA, p, uTime, rDisp, rLum);
    addRipple(uRippleB, p, uTime, rDisp, rLum);
    addRipple(uRippleC, p, uTime, rDisp, rLum);

    // wind coordinate basis (collapses to isotropic when wW or uStretch->1)
    vec2 dir = uWindDir; vec2 perp = vec2(-dir.y, dir.x);
    float alongc = dot(p, dir), crossc = dot(p, perp);
    vec2 wcoord = vec2(alongc * uStretch, crossc);
    vec2 adv = dir * (uFlowSpeed * 0.14 * uTime * wW);
    adv += dir * (infl * uPointerVel * 0.6) * wW;
    vec2 pMot = mix(p, wcoord + adv, wW);

    // ripple swell (analytic; reuses the two autonomous centers + pointer)
    float K = uWaveK;
    float ws = uWaveSpeed * (1.0 + 0.4 * wR) * uFlowSpeed;
    float warpR = 0.12 * fbm(p * 2.4 + 0.3 * t);
    float crest = 0.0; vec2 swellDisp = vec2(0.0);
    {
      vec2 to = p - autoC; float d = length(to) + warpR; float ph = d * K - uTime * ws;
      float env = aInfl + 0.15 * wR;
      crest = max(crest, smoothstep(0.82, 1.0, 0.5 + 0.5 * sin(ph)) * env);
      swellDisp += (d > 1e-4 ? to / length(to) : vec2(0.0)) * cos(ph) * 0.020;
    }
    {
      vec2 to = p - autoC2; float d = length(to) + warpR; float ph = d * (K * 1.12) - uTime * ws;
      float env = bInfl + 0.15 * wR;
      crest = max(crest, smoothstep(0.82, 1.0, 0.5 + 0.5 * sin(ph)) * env);
      swellDisp += (d > 1e-4 ? to / length(to) : vec2(0.0)) * cos(ph) * 0.018;
    }
    {
      float kp = K + 6.0 * uPointerVel; float php = pd * kp - uTime * ws;
      crest = max(crest, smoothstep(0.80, 1.0, 0.5 + 0.5 * sin(php)) * infl);
      swellDisp += (pd > 1e-4 ? toP / pd : vec2(0.0)) * cos(php) * (0.015 + 0.03 * uPointerVel);
    }
    crest = max(crest, max(rLum, 0.0) * (wR + wV * 0.5));

    // churn damping + crest warp injection
    autoSwirl *= 1.0 - uCalm * max(wR, wD * 0.3);
    vec2 warpExtra = swellDisp * wR;

    // domain-warped fbm (motif-aware coords + per-visit seed)
    vec2 q = vec2(fbm(pMot * 1.9 + adv + seedOff + vec2(0.0, t)), fbm(pMot * 1.9 + adv + seedOff + vec2(5.2, -t * 0.9)));
    vec2 warp = pMot * 2.0 + 2.3 * q + swirl + pull * 0.5 + rDisp + autoSwirl + warpExtra;
    vec2 r = vec2(fbm(warp + vec2(1.7, 9.2) + 0.20 * t), fbm(warp + vec2(8.3, 2.8) - 0.16 * t));
    float f = fbm(pMot * 2.3 + 2.8 * r + swirl * 1.5 + rDisp + autoSwirl * 0.8 + seedOff);

    // baseline veil
    float veil = smoothstep(0.26, 0.86, f);
    veil += infl * 0.28 * uPointerVel + aInfl * 0.05;

    // 5a ripple veil
    veil = mix(veil, max(veil, crest), 0.6 * wR);

    // 5b wind veil
    float gust = vnoise(vec2(crossc * 1.3, alongc * 0.4 - uTime * uFlowSpeed * 0.28));
    float streak = pow(smoothstep(0.26, 0.86, f), 2.2);
    veil = mix(veil, streak * (0.7 + 0.55 * gust), wW);

    // 5c voice veil (horizontal mel-band ribbons; reuses r as per-row loudness)
    float tx = p.x * uWaveK - uTime * uWaveSpeed * 0.35 * uFlowSpeed;
    float yb = (p.y * 0.5 + 0.5) * uBands; float row = floor(yb); float fr = fract(yb);
    float energy = fbm(vec2(tx, row * 1.7) + 2.0 * r);
    energy = clamp(energy, 0.05, 0.95);
    energy *= 1.0 + uPointerOn * (0.6 + 2.0 * uPointerVel) * exp(-toP.y * toP.y * 8.0);
    energy += max(rLum, 0.0) * 0.6;
    energy = clamp(energy, 0.0, 1.4);
    float band = smoothstep(0.22, 0.0, abs(fr - 0.5) * 2.0 - energy);
    float bandVeil = band * energy;
    veil = mix(veil, bandVeil, wV);

    // 5d diffusion crisping (schedule)
    float sigma = clamp(uSigma * (1.0 - 0.8 * infl), 0.0, 1.0);
    float lo = mix(0.26, 0.20, (1.0 - sigma) * wD);
    float hi = mix(0.86, 0.92, (1.0 - sigma) * wD);
    veil = mix(veil, smoothstep(lo, hi, f), wD);

    // baseline color
    vec3 base = vec3(0.032, 0.037, 0.046), graphite = vec3(0.085, 0.097, 0.118);
    vec3 col = mix(base, graphite, veil);
    float core = pow(veil, 2.6);
    col += uLapis * core * 0.18;
    col += uLapis * (aInfl + bInfl) * 0.05 * wBase;
    col += uLapis * infl * (0.06 + 0.22 * uPointerVel);

    // motif lapis whispers (luminance only, weight-gated)
    col += uLapis * crest * wR * (0.05 + 0.22 * uPointerVel) * uIntensity;
    col += uLapis * gust * wW * 0.04 * uIntensity;
    col += uLapis * infl * wW * (0.06 + 0.22 * uPointerVel);
    col += uLapis * pow(bandVeil, 2.6) * wV * 0.16 * uIntensity;
    col += uLapis * max(rLum, 0.0) * 0.05;

    // diffusion score (cost-gated)
    vec2 diffScore = vec2(0.0); float diffJit = 0.0;
    if (wD > 0.01) {
      float e = 0.012;
      float fx = fbm(warp + vec2(e, 0.0)) - fbm(warp - vec2(e, 0.0));
      float fy = fbm(warp + vec2(0.0, e)) - fbm(warp - vec2(0.0, e));
      diffScore = vec2(fx, fy) / (2.0 * e);
      diffJit = (hash(floor(warp * 9.0)) - 0.5) * sigma * 0.12;
    }

    // embedding motes (baseline + diffusion condense share this)
    vec2 gAdv = warp + diffScore * (0.13 * (1.0 - sigma) * wD);
    vec2 g = gAdv * 9.0;
    float dotMask = step(mix(0.984, 0.972, (1.0 - sigma) * wD), hash(floor(g)));
    float dd = length(fract(g) - 0.5 + diffJit);
    float rad = mix(0.16, mix(0.16, 0.05, 1.0 - sigma), wD);
    float onRidge = mix(1.0, smoothstep(0.0, 0.5, f), wD);
    float mote = dotMask * smoothstep(rad, 0.0, dd) * (0.3 + 0.7 * veil) * onRidge;
    col += (uLapis * 0.6 + 0.4) * mote * 0.05 * (1.0 + wD * 0.5);

    // neural net skin (cost-gated): sparse nodes + bowed filaments in warped domain
    float netAccum = 0.0;
    if (wN > 0.01) {
      float NS = 6.0;
      vec2 nc = warp * NS;
      vec2 c0 = floor(nc);
      float emit0 = step(uNetSparse, hash(c0 + 11.0));
      vec2 nodeC = c0 + 0.5 + (vec2(hash(c0 + 1.3), hash(c0 + 2.7)) - 0.5) * 0.6;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 cell = c0 + vec2(float(i), float(j));
          float h = hash(cell + 11.0);
          if (h < uNetSparse) continue;
          vec2 node = cell + 0.5 + (vec2(hash(cell + 1.3), hash(cell + 2.7)) - 0.5) * 0.6;
          float nd = length(nc - node);
          netAccum += smoothstep(0.15, 0.0, nd) * (0.6 + 0.4 * sin(uTime * 0.9 + h * 30.0));
          if (emit0 > 0.5 && (i != 0 || j != 0)) {
            vec2 ab = node - nodeC; float L2 = dot(ab, ab);
            float u = clamp(dot(nc - nodeC, ab) / max(L2, 1e-4), 0.0, 1.0);
            vec2 onSeg = nodeC + ab * u + normalize(vec2(-ab.y, ab.x)) * sin(u * 3.14159) * 0.12 * (hash(cell + 5.1) - 0.5);
            float ld = length(nc - onSeg);
            netAccum += smoothstep(0.04, 0.0, ld) * (1.0 - smoothstep(0.0, 1.4, sqrt(L2))) * 0.5
              * (0.5 + 0.5 * sin(uTime * 0.9 - u * 4.0 + h * 10.0));
          }
        }
      }
      netAccum *= 0.4 + 0.6 * smoothstep(0.2, 0.7, veil);
    }
    col += uLapis * netAccum * wN * 0.13 * uIntensity;

    // vignette
    float vig = smoothstep(1.32, 0.28, length(p));
    col *= vig;

    // glowing pointer trail (additive lapis along the recent cursor path)
    float trail = 0.0;
    ${trailAccum}
    col += (uLapis * 1.25 + 0.04) * min(trail, 2.6) * 0.16;

    // grain (anneals out as diffusion settles)
    float grain = hash(vUv * res + fract(uTime) * 97.0) - 0.5;
    col += grain * mix(0.012, 0.03, sigma * wD);

    col = mix(base * vig, col, uReveal);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ----- motif presets (CPU side): w = [ripple, wind, voice, net, diffusion] -----
interface Preset { w: number[]; calm: number; stretch: number; waveK: number; flow: number; netSparse: number; bands: number; intensity: number; }
const PRESETS: Preset[] = [
  { w: [1, 0, 0, 0, 0], calm: 0.70, stretch: 1.0,  waveK: 13.0, flow: 1.15, netSparse: 0.86, bands: 8, intensity: 1.0 },
  { w: [0, 1, 0, 0, 0], calm: 0.10, stretch: 0.35, waveK: 8.0,  flow: 1.0,  netSparse: 0.86, bands: 8, intensity: 0.9 },
  { w: [0, 0, 1, 0, 0], calm: 0.40, stretch: 1.0,  waveK: 3.4,  flow: 0.85, netSparse: 0.86, bands: 8, intensity: 0.85 },
  { w: [0, 0, 0, 1, 0], calm: 0.20, stretch: 1.0,  waveK: 8.0,  flow: 0.6,  netSparse: 0.86, bands: 8, intensity: 0.8 },
  { w: [0, 0, 0, 0, 1], calm: 0.30, stretch: 1.0,  waveK: 8.0,  flow: 0.5,  netSparse: 0.86, bands: 8, intensity: 0.9 },
];
const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

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
  gl.clearColor(0.032, 0.037, 0.046, 1);

  const empty = (): [number, number, number] => [0, 0, -1];
  const rnd = Math.random;
  let from = Math.floor(rnd() * PRESETS.length);
  let to = (from + 1 + Math.floor(rnd() * (PRESETS.length - 1))) % PRESETS.length;
  const holdRand = () => 6 + rnd() * 8;
  const durRand = () => 3.5 + rnd() * 2.5;
  let morphStart = 0;
  let dur = durRand();
  let windAngle = rnd() * Math.PI * 2;
  const phaseOffset = rnd() * 120;

  const uniforms: Record<string, { value: unknown }> = {
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
    uTrailLife: { value: 0.7 },
    uMotif: { value: PRESETS[from].w.slice(0, 4) },
    uMotifDiff: { value: PRESETS[from].w[4] },
    uWindDir: { value: [Math.cos(windAngle), Math.sin(windAngle)] },
    uCalm: { value: PRESETS[from].calm },
    uStretch: { value: PRESETS[from].stretch },
    uWaveK: { value: PRESETS[from].waveK },
    uFlowSpeed: { value: PRESETS[from].flow },
    uSigma: { value: 0.4 },
    uNetSparse: { value: PRESETS[from].netSparse },
    uBands: { value: PRESETS[from].bands },
    uIntensity: { value: PRESETS[from].intensity },
    uSeed: { value: [rnd() * 100, rnd() * 100] },
  };
  const trVals: [number, number, number][] = [];
  for (let i = 0; i < TRAIL_N; i++) { trVals.push(empty()); uniforms['uTr' + i] = { value: trVals[i] }; }

  const program = new Program(gl, { vertex, fragment, uniforms });
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
  const u = program.uniforms as Record<string, { value: any }>;

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    u.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // ---- unified pointer (mouse + touch + pen); canvas is pointer-events:none ----
  const t0 = performance.now() - phaseOffset * 1000;
  let tx = 0, ty = 0, cx = 0, cy = 0, lx = 0, ly = 0;
  let vel = 0, velTarget = 0, lastMove = -1e4, lpx = 0, lpy = 0;
  let downX = 0, downY = 0, downT = 0;
  const ripples: [number, number, number][] = [empty(), empty(), empty()];
  let ri = 0, ti = 0, lastPX = 0, lastPY = 0;

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
    lpx = nx; lpy = ny; tx = nx; ty = ny;
    lastMove = downT = performance.now();
    downX = e.clientX; downY = e.clientY;
  }, { passive: true });
  window.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
    const now = performance.now();
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 10 && now - downT < 250) {
      const [nx, ny] = toXY(e.clientX, e.clientY);
      ripples[ri] = [nx, ny, (now - t0) / 1000];
      u['uRipple' + 'ABC'[ri]].value = ripples[ri];
      ri = (ri + 1) % ripples.length;
    }
  }, { passive: true });
  const calmReset = () => { velTarget = 0; };
  window.addEventListener('pointercancel', calmReset, { passive: true });
  window.addEventListener('blur', calmReset);

  // ---- loop ----
  let visible = !document.hidden, inView = true, raf = 0, prev = performance.now();

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    let dt = (now - prev) / 1000; prev = now;
    dt = Math.min(Math.max(dt, 1 / 120), 1 / 30);

    cx += (tx - cx) * (1 - Math.exp(-5.0 * dt));
    cy += (ty - cy) * (1 - Math.exp(-5.0 * dt));
    lx += (tx - lx) * (1 - Math.exp(-1.3 * dt));
    ly += (ty - ly) * (1 - Math.exp(-1.3 * dt));
    vel += (velTarget - vel) * (1 - Math.exp(-7.7 * dt));
    velTarget *= Math.pow(0.94, dt * 60);

    const T = (now - t0) / 1000;
    if (morphStart === 0) morphStart = now + holdRand() * 1000;

    // ---- motif morph ----
    let k = 0;
    if (now >= morphStart) {
      const phase = (now - morphStart) / (dur * 1000);
      if (phase >= 1) {
        from = to;
        to = (from + 1 + Math.floor(rnd() * (PRESETS.length - 1))) % PRESETS.length;
        morphStart = now + holdRand() * 1000;
        dur = durRand();
        k = 0;
      } else {
        k = smoother(phase);
      }
    }
    const A = PRESETS[from], B = PRESETS[to];
    const lerp = (a: number, b: number) => a + (b - a) * k;
    u.uCalm.value = lerp(A.calm, B.calm);
    u.uStretch.value = lerp(A.stretch, B.stretch);
    u.uWaveK.value = lerp(A.waveK, B.waveK);
    u.uFlowSpeed.value = lerp(A.flow, B.flow);
    u.uNetSparse.value = lerp(A.netSparse, B.netSparse);
    u.uBands.value = lerp(A.bands, B.bands);
    u.uIntensity.value = lerp(A.intensity, B.intensity);
    const w = A.w.map((x, i) => x + (B.w[i] - x) * k);
    u.uMotif.value = [w[0], w[1], w[2], w[3]];
    u.uMotifDiff.value = w[4];
    const sigmaBreath = 0.5 + 0.5 * Math.sin(T * 0.045);
    u.uSigma.value = 0.4 * (1 - w[4]) + sigmaBreath * w[4];
    windAngle += dt * (0.02 + 0.01 * Math.sin(phaseOffset + T * 0.05));
    u.uWindDir.value = [Math.cos(windAngle), Math.sin(windAngle)];

    u.uTime.value = T;
    u.uPointer.value = [cx, cy];
    u.uPointerLag.value = [lx, ly];
    const on = Math.max(0, 1 - (now - lastMove) / 2600);
    u.uPointerOn.value = on;
    u.uPointerVel.value = vel;
    u.uReveal.value = Math.min(1, u.uReveal.value + dt / 1.1);

    // sample the glowing trail along the actual path (new array ref so OGL re-uploads)
    if (on > 0.04) {
      const dpx = tx - lastPX, dpy = ty - lastPY;
      if (dpx * dpx + dpy * dpy > 0.00012) {
        trVals[ti] = [tx, ty, T];
        u['uTr' + ti].value = trVals[ti];
        ti = (ti + 1) % TRAIL_N;
        lastPX = tx; lastPY = ty;
      }
    }

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
  reduceMM.addEventListener?.('change', () => {
    if (reduceMM.matches && raf) { cancelAnimationFrame(raf); raf = 0; canvas.classList.remove('is-live'); }
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (raf) cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', () => { resize(); gate(); });

  gate();
}

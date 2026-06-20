// boot.ts — tiny, ships for everyone (no heavy deps). Runs reveals + UI,
// then gates and DEFERS the WebGL field as a separate code-split chunk.

const hero = document.querySelector<HTMLElement>('.hero');

// ---- run-once hero ceremony ----
requestAnimationFrame(() => hero?.classList.add('is-in'));

// ---- run-once scroll reveals ----
const reveals = document.querySelectorAll<HTMLElement>('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
  );
  reveals.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i, 6) * 0.05}s`;
    io.observe(el);
  });
} else {
  reveals.forEach((el) => el.classList.add('is-in'));
}

// ---- corner section index ----
const cindex = document.querySelector<HTMLElement>('.cindex');
const indexLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.cindex a'));
if (cindex && hero && 'IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => cindex.classList.toggle('is-shown', !e.isIntersecting), {
    threshold: 0,
  }).observe(hero);

  const sections = indexLinks
    .map((a) => document.getElementById(a.dataset.sec ?? ''))
    .filter((s): s is HTMLElement => s !== null);
  const secIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const id = (e.target as HTMLElement).id;
          indexLinks.forEach((a) => a.setAttribute('aria-current', String(a.dataset.sec === id)));
        }
      }
    },
    { threshold: 0.5 },
  );
  sections.forEach((s) => secIO.observe(s));
}

// ---- email reveal (light obfuscation) ----
const email = document.getElementById('email') as HTMLButtonElement | null;
email?.addEventListener(
  'click',
  () => {
    const addr = `${email.dataset.user}@${email.dataset.domain}`;
    const a = document.createElement('a');
    a.className = 'link link--mute';
    a.href = `mailto:${addr}`;
    a.textContent = addr;
    email.replaceWith(a);
    navigator.clipboard?.writeText(addr).catch(() => {});
  },
  { once: true },
);

// ---- gated, deferred WebGL field ----
function gateAllows(): boolean {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') || c.getContext('webgl'))) return false;
  } catch {
    return false;
  }
  return true;
}

function deferStart() {
  const canvas = document.getElementById('fluid') as HTMLCanvasElement | null;
  if (!canvas || !gateAllows()) return;
  const begin = () =>
    import('./fluid').then((m) => m.start(canvas)).catch(() => {});
  const onIdle = () => {
    if ('IntersectionObserver' in window && hero) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            begin();
          }
        },
        { rootMargin: '200px' },
      );
      io.observe(hero);
    } else {
      begin();
    }
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(onIdle, { timeout: 1500 });
  else setTimeout(onIdle, 200);
}

deferStart();

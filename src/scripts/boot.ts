// boot.ts — tiny, ships for everyone. Wires the email, then gates + DEFERS the
// WebGL field as a separate code-split chunk. (The first-view reveal runs from a
// tiny inline script in Base.astro, so it never depends on this bundle loading.)

// ---- email reveal (light obfuscation) ----
const email = document.getElementById('email') as HTMLButtonElement | null;
email?.addEventListener(
  'click',
  () => {
    const addr = `${email.dataset.user}@${email.dataset.domain}`;
    const a = document.createElement('a');
    a.className = 'link';
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
  const begin = () => import('./fluid').then((m) => m.start(canvas)).catch(() => {});
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(begin, { timeout: 1200 });
  else setTimeout(begin, 200);
}

deferStart();

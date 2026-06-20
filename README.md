# hpprc.com

Single-page personal site for **Hayato Tsukagoshi** — a dark, refined, minimal
research landing with a subtle pointer/touch-reactive WebGL flow-field background.

## Stack

- **[Astro 6](https://astro.build)** — static output, zero-JS shell (the canvas is a plain deferred script, no island/hydration).
- **[OGL](https://github.com/oframe/ogl)** + a hand-written GLSL **curl-noise / domain-warped flow field** (`src/scripts/fluid.ts`) — one full-viewport fragment shader, monochrome near-black with a faint lapis whisper, reactive to mouse + touch. Loaded as a deferred, gated, code-split chunk.
- **Geist Sans + Geist Mono** (self-hosted Latin variable woff2, `public/fonts/`).
- Hosted on **GitHub Pages** at the apex domain `hpprc.com`.

Design is English-only and intentionally light: first-paint critical path is
~33 KB (HTML + one font); the WebGL chunk loads after paint and is skipped under
`prefers-reduced-motion`, `save-data`, or when WebGL is unavailable. The static
CSS gradient poster is the always-on fallback, so the page is complete without JS.

## Develop

```bash
npm install
npm run dev       # local dev server
npm run build     # static build → dist/
npm run preview   # serve the built dist/
```

## Deploy (GitHub Pages, apex domain)

Pushing to `main` triggers `.github/workflows/deploy.yml` (build + deploy via
`withastro/action` → `actions/deploy-pages`).

1. **Repo → Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Custom domain:** `hpprc.com` (a `public/CNAME` file is already committed).
3. **DNS** at your provider:
   - Apex `A`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - Apex `AAAA`: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - Optional `www` `CNAME` → `hppRC.github.io`
4. **Enable “Enforce HTTPS”** once the certificate is issued.

`astro.config.mjs` sets `site: 'https://hpprc.com'` with **no `base`** (apex serves from `/`).

## Structure

```
src/
  layouts/Base.astro     # <head>, meta/OG, font preload, poster canvas, deferred boot
  pages/index.astro      # content (hero, statement, selected work, projects, links)
  scripts/boot.ts        # tiny: reveals, corner index, email reveal, gated fluid loader
  scripts/fluid.ts       # OGL curl-noise flow field (pointer/touch interaction)
  styles/global.css      # design tokens, type, motion, components
public/                  # CNAME, .nojekyll, fonts/, favicon, og.jpg
.agents/research/        # the research dossier this design was built from (00–08)
```

## Before launch — confirm (see `.agents/research/00-SYNTHESIS.md`)

- Public email address (currently a placeholder in `index.astro`).
- X handle (`@hayato_tkgs` vs `@hpp_ricecake`), PhD wording.
- Exact co-authors, order, and ACL Anthology URLs for the selected publications
  (marked `TODO` in `src/pages/index.astro`).

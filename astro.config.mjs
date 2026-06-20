import { defineConfig } from 'astro/config';

// hpprc.com is an apex custom domain on GitHub Pages → served from the root,
// so we set `site` but intentionally DO NOT set `base` (that is only for
// project pages served from username.github.io/repo/).
export default defineConfig({
  site: 'https://hpprc.com',
  output: 'static',
  build: {
    // Inline ALL page CSS → zero render-blocking stylesheet request (fastest first paint).
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
});

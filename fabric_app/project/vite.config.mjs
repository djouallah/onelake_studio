// The page's build (Export to Fabric's project, fabric_app/export/exportapp.js): index.html and src/, with
// the packages site/package.json names, into dist/, which rayfin.yml's staticHosting uploads (its
// buildCommand runs `npm run build` here). public/ is copied into it as it is: the Report, the model, what
// the page runs on, DuckDB's extensions. Fabricator and rayfin-local start the dev server here, in the
// folder staticHosting names; `npm run dev:frontend` does at the project's root. The local-dev plugin
// answers the page's rayfin.config.json with the local backend's, when there is one; otherwise the
// published app's, in public/, is served.
// OneLake Studio's own publish uploads this same build, made when the extension was packaged
// (scripts/site-bundle.mjs), with this project's public/.
import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // Every URL relative: the site is served from wherever the app's hosting puts it.
  base: './',
  plugins: [rayfinLocalDev()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome or Edge 121+ (OPFS shared access handles): nothing is written down for an older browser.
    target: 'esnext',
    // DuckDB's client and ECharts are each one large part, loaded when needed.
    chunkSizeWarningLimit: 4096,
  },
});

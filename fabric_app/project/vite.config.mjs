// The page's build (Export to Fabric's project, fabric_app/export/exportapp.js): index.html and src/, with
// the packages site/package.json names, into dist/, which rayfin.yml's staticHosting uploads (its
// buildCommand runs `npm run build` here). public/ is copied into it as it is: the Report, the model, what
// the page runs on, DuckDB's extensions. Fabricator and rayfin-local start the dev server here, in the
// folder staticHosting names; `npm run dev:frontend` does at the project's root. The local-dev plugin
// answers the page's rayfin.config.json with the local backend's, when there is one; otherwise the
// published app's, in public/, is served.
// OneLake Studio's own publish uploads this same build, made when the extension was packaged
// (scripts/site-bundle.mjs), with this project's public/.
import { readFile } from 'node:fs/promises';
import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import { defineConfig } from 'vite';

// DuckDB-WASM's worker script ends by naming a source map its package does not hold. The dev server reads the
// map of every script it serves, and logged a warning for this one each time an engine started, where
// Fabricator's agent reads the backend's recent errors. Served without that line, there is no map to look for.
// The build is not concerned: it copies the worker as it is.
const WORKER = /[\\/]@duckdb[\\/]duckdb-wasm[\\/]dist[\\/][\w.-]+\.worker\.js$/;
const workerWithoutMap = () => ({
  name: 'duckdb-worker-without-map',
  apply: 'serve',
  enforce: 'pre',
  async load(id) {
    // The script itself, as a worker asks for it: not its `?url` import, which answers where it is.
    if (id.includes('?') || !WORKER.test(id)) return null;
    return (await readFile(id, 'utf8')).replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
  },
});

export default defineConfig({
  // Every URL relative: the site is served from wherever the app's hosting puts it.
  base: './',
  plugins: [workerWithoutMap(), rayfinLocalDev()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome or Edge 121+ (OPFS shared access handles): nothing is written down for an older browser.
    target: 'esnext',
    // DuckDB's client and ECharts are each one large part, loaded when needed.
    chunkSizeWarningLimit: 4096,
  },
});

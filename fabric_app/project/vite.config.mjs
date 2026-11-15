// The page's dev server (Export to Fabric's project, fabric_app/export/exportapp.js): Vite serves
// site/public/ as it is, the page and its own packages (vendor/), with no build. Fabricator and
// rayfin-local start it here, in the folder rayfin.yml's staticHosting names; `npm run dev:frontend`
// does at the project's root. The local-dev plugin answers the page's rayfin.config.json with the
// local backend's, when there is one; otherwise the published app's, in site/public/, is served.
import { resolve } from 'node:path';
import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  // The .env.local `rayfin env --framework vite` writes, here beside this file.
  envDir: import.meta.dirname,
  // site/public/ is the site itself, not Vite's folder of files copied as they are.
  publicDir: false,
  plugins: [rayfinLocalDev()],
});

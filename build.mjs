// Static "build": publish the contents of site/ to dist/, which GitHub Pages serves.
// The app is plain HTML + DuckDB-WASM (loaded from CDN) that reads OneLake Iceberg tables
// directly in the browser — no bundler, so we just copy site/ -> dist/.
//
// The one thing that IS generated: dist/version.js gets the real commit and build time
// (site/version.js is a "dev" placeholder). The UI shows it, because "which build am I
// actually running?" must be answerable from the page itself when a browser serves a
// stale cache.
import { rm, cp, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const dist = new URL("./dist/", import.meta.url);
const site = new URL("./site/", import.meta.url);

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true });

// GITHUB_SHA in CI; git locally; "unknown" only if both are unavailable.
let commit = process.env.GITHUB_SHA || "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch (_) {}
}
const short = commit ? commit.slice(0, 7) : "unknown";
const builtAt = new Date().toISOString();
await writeFile(new URL("./version.js", dist),
  `window.ONELAKE_STUDIO_VERSION = { commit: ${JSON.stringify(short)}, builtAt: ${JSON.stringify(builtAt)} };\n`);

console.log(`Published site/ -> dist/  (version ${short}, built ${builtAt})`);

// vsce packages the extension directory and nothing above it, so site/ — which lives at
// the repo root and is shared with the web app — has to be copied in before packaging.
// Copied, not forked: extension/site/ is gitignored and rebuilt from the one source.
//
// version.js is stamped the same way build.mjs does it, so the build badge in the corner
// of the panel names a real commit rather than saying "dev".
import { rm, cp, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const here = new URL("./", import.meta.url);
const src = new URL("../site/", here);
const dst = new URL("./site/", here);

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });

let commit = process.env.GITHUB_SHA || "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch (_) {}
}
const short = commit ? commit.slice(0, 7) : "unknown";
await writeFile(new URL("./version.js", dst),
  `window.ONELAKE_STUDIO_VERSION = { commit: ${JSON.stringify(short)}, builtAt: ${JSON.stringify(new Date().toISOString())} };\n`);

console.log(`Copied site/ -> extension/site/  (version ${short})`);

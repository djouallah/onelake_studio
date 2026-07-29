// extension/app/ is the extension's own TRACKED fork of the web app — site/ at the repo
// root is the deployed website and is never touched by extension work, by the owner's
// explicit rule. This script turns app/ into the packaged site/ artifact: extension/site/
// is gitignored and rebuilt from app/ on every package.
//
// README.md goes in with it: the panel's landing page is a query result, and in the
// webview that query reads the README from inside the extension rather than from GitHub.
// A packaged copy is the one the installed version actually documents, and it works with
// no network at all.
//
// version.js is stamped the same way build.mjs does it, so the build badge in the corner
// of the panel names a real commit rather than saying "dev".
import { rm, cp, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const here = new URL("./", import.meta.url);
const src = new URL("./app/", here);
const dst = new URL("./site/", here);

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });

// vsce looks for the LICENSE beside package.json and will not climb out of the extension
// directory to find the repo's. Copied for the same reason site/ is: one source of truth.
await cp(new URL("../LICENSE", here), new URL("./LICENSE", here));

// Inside site/, not beside it: localResourceRoots is the site directory, and the webview
// cannot address a file outside it.
await cp(new URL("../README.md", here), new URL("./README.md", dst));

let commit = process.env.GITHUB_SHA || "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch (_) {}
}
const short = commit ? commit.slice(0, 7) : "unknown";
await writeFile(new URL("./version.js", dst),
  `window.ONELAKE_STUDIO_VERSION = { commit: ${JSON.stringify(short)}, builtAt: ${JSON.stringify(new Date().toISOString())} };\n`);

console.log(`Copied site/ -> extension/site/  (version ${short})`);

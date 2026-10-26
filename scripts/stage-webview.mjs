// Stages the panel's page for packaging: app/ (the tracked source) is copied to
// webview/ (gitignored, rebuilt on every package), with two things added:
//
//   README.md    the panel's landing page is a query result over the README packaged with
//                the extension — the one the installed version documents, read with no
//                network at all.
//   build.json   { commit, builtAt } — which build this is. extension.js reads it and the
//                panel's status bar shows it, because a Marketplace install, a sideloaded
//                vsix and an F5 checkout look identical from inside.
import { rm, cp, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const here = new URL("../", import.meta.url);   // the extension root
const dst = new URL("./webview/", here);

await rm(dst, { recursive: true, force: true });
await cp(new URL("./app/", here), dst, { recursive: true });
await cp(new URL("./README.md", here), new URL("./README.md", dst));

let commit = process.env.GITHUB_SHA || "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch (_) {}
}
let short = commit ? commit.slice(0, 7) : "unknown";

// A stamp that names a commit NOT containing the code being packaged is worse than none:
// packaging before committing stamps the parent commit onto the changes just made. Not an
// error — packaging a dirty tree is how a change gets tested — but labelled.
if (!process.env.GITHUB_SHA) {
  let dirty = "";
  try { dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim(); } catch (_) {}
  if (dirty) {
    short += "+dirty";
    console.warn(`WARNING: packaging with uncommitted changes — stamping ${short}.` +
                 ` Commit first if this build is meant to be identifiable.`);
  }
}

await writeFile(new URL("./build.json", dst),
  JSON.stringify({ commit: short, builtAt: new Date().toISOString() }) + "\n");

console.log(`Staged app/ -> webview/  (build ${short})`);

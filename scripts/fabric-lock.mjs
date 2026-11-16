// Makes fabric_app/project/package-lock.json, the lock file every export's project ships
// (fabric_app/export/exportapp.js, projectLock). Run it again whenever a package the project names
// changes: PROJECT_PACKAGES or PAGE_PACKAGES there, or fabric_app/rayfin/functions/package.json.
// It resolves only (npm install --package-lock-only): nothing is downloaded or built. The public
// registry, so every `resolved` URL works for anyone; npm swaps its host for a person's own registry.
//
//   node scripts/fabric-lock.mjs
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const { projectPackage } = require("../fabric_app/export/exportapp.js");

const dir = await mkdtemp(join(tmpdir(), "fabric-lock-"));
try {
  await writeFile(join(dir, "package.json"), projectPackage("fabric-app"));
  await mkdir(join(dir, "rayfin", "functions"), { recursive: true });
  await copyFile(join(root, "fabric_app", "rayfin", "functions", "package.json"), join(dir, "rayfin", "functions", "package.json"));
  execSync("npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/",
           { cwd: dir, stdio: "inherit" });
  const lock = await readFile(join(dir, "package-lock.json"), "utf8");
  // Every package from the public registry, but the workspace's own link to rayfin/functions.
  const others = Object.entries(JSON.parse(lock).packages)
    .filter(([, p]) => p.resolved && !p.link && !p.resolved.startsWith("https://registry.npmjs.org/")).map(([k, p]) => `${k}: ${p.resolved}`);
  if (others.length) throw new Error(`resolved off the public registry: ${others.slice(0, 3).join(", ")}`);
  await writeFile(join(root, "fabric_app", "project", "package-lock.json"), lock);
  console.log(`fabric_app/project/package-lock.json: ${Object.keys(JSON.parse(lock).packages).length - 1} packages`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

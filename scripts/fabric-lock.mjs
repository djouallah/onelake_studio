// Makes the lock files every export's project ships (fabric_app/export/exportapp.js, projectLock), one for
// each engine an app runs on, since each has its own packages: fabric_app/project/package-lock.json (client
// side, DuckDB-WASM) and package-lock.model.json (a semantic model). Run it again whenever a package the
// project names changes: PROJECT_PACKAGES, SITE_DEV_PACKAGES or sitePackages there (core/vendored.js WEBAPP),
// or fabric_app/rayfin/functions/package.json.
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
const { projectPackage, sitePackage, lockName, ENGINES } = require("../fabric_app/export/exportapp.js");

// Only versions published BEFORE ten days ago. A company's npm mirror holds a new version back for days (one
// served nothing younger than about a week: tar 7.5.23 and postcss 8.5.33 were 404 there on 2026-11-16), and
// npm ci then fails on every package the lock names that the mirror has not taken yet. Every pin the project
// names must be older than this too: npm says ETARGET for one that is not.
const before = new Date(Date.now() - 10 * 86_400_000).toISOString();
for (const engine of ENGINES) {
  const dir = await mkdtemp(join(tmpdir(), "fabric-lock-"));
  try {
    await writeFile(join(dir, "package.json"), projectPackage("fabric-app"));
    await mkdir(join(dir, "site"), { recursive: true });
    await writeFile(join(dir, "site", "package.json"), sitePackage("fabric-app", engine));
    await mkdir(join(dir, "rayfin", "functions"), { recursive: true });
    await copyFile(join(root, "fabric_app", "rayfin", "functions", "package.json"), join(dir, "rayfin", "functions", "package.json"));
    execSync(`npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --before=${before}`,
             { cwd: dir, stdio: "inherit" });
    const lock = await readFile(join(dir, "package-lock.json"), "utf8");
    // Every package from the public registry, but the workspaces' own links (site, rayfin/functions).
    const others = Object.entries(JSON.parse(lock).packages)
      .filter(([, p]) => p.resolved && !p.link && !p.resolved.startsWith("https://registry.npmjs.org/")).map(([k, p]) => `${k}: ${p.resolved}`);
    if (others.length) throw new Error(`resolved off the public registry: ${others.slice(0, 3).join(", ")}`);
    await writeFile(join(root, "fabric_app", "project", lockName(engine)), lock);
    console.log(`fabric_app/project/${lockName(engine)}: ${Object.keys(JSON.parse(lock).packages).length - 1} packages`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

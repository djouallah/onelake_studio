// Makes the lock file every export's project ships (fabric_app/export/exportapp.js, projectLock):
// fabric_app/project/package-lock.json. Run it again whenever a package the
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
const { projectPackage, sitePackage } = require("../fabric_app/export/exportapp.js");

// Only versions published BEFORE ten days ago. A company's npm mirror holds a new version back for days (one
// served nothing younger than about a week: tar 7.5.23 and postcss 8.5.33 were 404 there on 2026-11-16), and
// npm ci then fails on every package the lock names that the mirror has not taken yet. Every pin the project
// names must be older than this too: npm says ETARGET for one that is not.
// But the Rayfin release the project is on, when it is younger than that: the lock then takes what was published
// up to an hour after it (its packages are published within minutes of each other), and nothing newer.
const rayfin = JSON.parse(projectPackage("fabric-app")).devDependencies["@microsoft/rayfin-cli"].replace(/^[~^]/, "");
const published = (await (await fetch("https://registry.npmjs.org/@microsoft/rayfin-cli")).json()).time?.[rayfin];
if (!published) throw new Error(`@microsoft/rayfin-cli ${rayfin} is not on the public registry`);
const tenDays = Date.now() - 10 * 86_400_000;
const before = new Date(Math.max(tenDays, Date.parse(published) + 3_600_000)).toISOString();
console.log(`packages published before ${before} (Rayfin ${rayfin}: ${published})`);
{
  const dir = await mkdtemp(join(tmpdir(), "fabric-lock-"));
  try {
    await writeFile(join(dir, "package.json"), projectPackage("fabric-app"));
    await mkdir(join(dir, "site"), { recursive: true });
    await writeFile(join(dir, "site", "package.json"), sitePackage());
    await mkdir(join(dir, "rayfin", "functions"), { recursive: true });
    await copyFile(join(root, "fabric_app", "rayfin", "functions", "package.json"), join(dir, "rayfin", "functions", "package.json"));
    execSync(`npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --before=${before}`,
             { cwd: dir, stdio: "inherit" });
    const lock = await readFile(join(dir, "package-lock.json"), "utf8");
    // Every package from the public registry, but the workspaces' own links (site, rayfin/functions).
    const others = Object.entries(JSON.parse(lock).packages)
      .filter(([, p]) => p.resolved && !p.link && !p.resolved.startsWith("https://registry.npmjs.org/")).map(([k, p]) => `${k}: ${p.resolved}`);
    if (others.length) throw new Error(`resolved off the public registry: ${others.slice(0, 3).join(", ")}`);
    await writeFile(join(root, "fabric_app", "project", "package-lock.json"), lock);
    console.log(`fabric_app/project/package-lock.json: ${Object.keys(JSON.parse(lock).packages).length - 1} packages`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

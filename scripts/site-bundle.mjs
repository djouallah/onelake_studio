// =============================================================================
// site-bundle.mjs — Export to Fabric's page, as Vite builds it
// =============================================================================
// An exported app's page is a Vite project (fabric_app/export/exportapp.js, appFiles): Fabricator and
// `rayfin up` build it where the project is unpacked, with npm. OneLake Studio publishes too, on a
// machine with no npm: so the page is built here, when the extension is packaged, from the very files
// an export writes and the packages its lock file names:
//
//   fabric-site/            the app's page: index.html and assets/ (DuckDB-WASM among them)
//   fabric-site/pins.json   what it was built from, so an unchanged tree is not built again
//
// An export uploads it with the project's site/public/ (buildDist): what `npm run build` makes
// of the project, whose public/ Vite copies as it is. So public/ is left out of the build here.
//
// Run by vscode:prepublish after vendor.mjs and function-bundle.mjs (an export's project holds what
// they make), and once for a checkout before F5. Needs npm and the registry: CI and a developer's
// machine, never a user's.
import { mkdir, readFile, writeFile, rm, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { appFiles, SITE } = require("../fabric_app/export/exportapp.js");
const { PINS } = require("../core/vendored.js");

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
const OUT = join(here, "fabric-site");

// The project an export writes for an app: only its page matters here, so the app is no one's.
const NOBODY = "00000000-0000-0000-0000-000000000000";
const project = await appFiles({
  plan: { name: "fabric-app", title: "fabric-app", modelPath: "", workspace: NOBODY, lakehouse: NOBODY, catalogUrl: "", tables: [] },
  state: null, model: {}, fabricAppDir: join(here, "fabric_app"), appDir: join(here, "page"),
  daxSqlDir: join(here, "vendor", "npm", PINS.daxSql), agentFiles: join(here, "fabric-function", "agent-files.json"),
});
// The project whole, as Vite and Rayfin's local-dev plugin find one where it is unpacked, but public/, which an
// export uploads as it is, and what names the app: AGENTS.md.
const files = new Map([...project].filter(([p]) => !p.startsWith(SITE) && p !== "AGENTS.md"));
const hash = createHash("sha256");
for (const [p, bytes] of files) hash.update(p).update(bytes);
const pins = JSON.stringify({ source: hash.digest("hex").slice(0, 16) });
if (await readFile(join(OUT, "pins.json"), "utf8").catch(() => "") === pins && existsSync(join(OUT, "index.html"))) {
  console.log("fabric-site/ already holds these pins — nothing to build");
  process.exit(0);
}

const work = await mkdtemp(join(tmpdir(), "onelake-studio-site-"));
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
try {
  await rm(OUT, { recursive: true, force: true });
  for (const [p, bytes] of files) {
    const file = join(work, ...p.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  // The page's workspace alone: the function's packages build nothing here.
  sh("npm ci --no-audit --no-fund --workspace site --include-workspace-root", work);
  sh("npm run build", work);
  const dist = join(work, "site", "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("vite built no index.html");
  await cp(dist, OUT, { recursive: true });
  console.log("fabric-site/: built");
  await writeFile(join(OUT, "pins.json"), pins);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

// =============================================================================
// function-bundle.mjs — Export to Fabric's function, as the deploy package Fabric takes
// =============================================================================
// The app's one function (openCatalog, fabric_app/rayfin/functions, tracked here) is
// TypeScript with npm dependencies. Fabric takes it as a zip of one esbuild bundle plus its
// metadata (deploymetadata.json, generated from the source by the TypeScript compiler), the
// two sent as a multipart form (src/fabricapp.js). Nothing in either names an item, a
// workspace or a secret's value, so the package is built ONCE, here, at package time, and
// ships in the vsix: nobody who exports needs Node, npm or the Rayfin CLI.
//
// It is built by Rayfin's own packager (@microsoft/rayfin-cli's prepareFunctionsDeployPackage,
// called as a library at the version fabricapp.js speaks), so what ships is byte for byte
// what `rayfin up` would upload. Into fabric-function/ (gitignored):
//   source.zip           the zip: dist/function_app.js, host.json, package.json,
//                        deploymetadata.json, runtimemetadata.json
//   deploymetadata.json  the form's DeployMetaData
//   pins.json            what it was built from (a hash of the function's files, the
//                        packager's version): a rebuild only when that changes
//
// Run by vscode:prepublish, and once for a checkout before F5. Needs npm
// and the registry: CI and a developer's machine, never a user's.
import { mkdir, readFile, writeFile, rm, cp, mkdtemp, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { CLIENT_VERSION } = require("../src/fabricapp.js");

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
const OUT = join(here, "fabric-function");
const RAYFIN = join(here, "fabric_app", "rayfin");

// What the package is built from: the function's own files and the packager's version.
const FILES = ["rayfin.yml", "tsconfig.json", "data/schema.ts",
  "functions/package.json", "functions/package-lock.json", "functions/tsconfig.json", "functions/host.json",
  "functions/runtimemetadata.json", "functions/src/function_app.ts", "functions/src/secrets.generated.ts",
  "functions/src/types.ts"];
const hash = createHash("sha256");
for (const f of FILES) hash.update(f).update(await readFile(join(RAYFIN, ...f.split("/"))));
const pins = JSON.stringify({ source: hash.digest("hex").slice(0, 16), cli: CLIENT_VERSION });
if (await readFile(join(OUT, "pins.json"), "utf8").catch(() => "") === pins && existsSync(join(OUT, "source.zip"))) {
  console.log("fabric-function/ already holds these pins — nothing to build");
  process.exit(0);
}

const work = await mkdtemp(join(tmpdir(), "onelake-studio-function-"));
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
try {
  // The project as the packager finds it: rayfin/rayfin.yml and rayfin/functions/.
  const project = join(work, "app");
  await cp(RAYFIN, join(project, "rayfin"), { recursive: true });
  const functions = join(project, "rayfin", "functions");
  sh("npm ci --no-audit --no-fund", functions);
  // The packager, at the version whose wire format fabricapp.js speaks.
  const cli = join(work, "cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "package.json"), JSON.stringify({ private: true }));
  sh(`npm install --no-audit --no-fund @microsoft/rayfin-cli@${CLIENT_VERSION}`, cli);
  const up = join(cli, "node_modules", "@microsoft", "rayfin-cli", "dist", "commands", "up", "up-functions.js");
  const { prepareFunctionsDeployPackage } = await import(pathToFileURL(up).href);
  const prepared = await prepareFunctionsDeployPackage(functions, { isCompiledZip: true, logger: m => console.log(m) });
  if (!prepared.isBundled) throw new Error("the packager did not bundle the function (RAYFIN_FUNCTIONS_NO_BUNDLE set?)");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyFile(prepared.zip.zipPath, join(OUT, "source.zip"));
  await writeFile(join(OUT, "deploymetadata.json"), prepared.deployMetaData);
  await writeFile(join(OUT, "pins.json"), pins);
  const meta = JSON.parse(prepared.deployMetaData);
  console.log(`fabric-function/: ${meta.functionsMetadata.map(f => f.name).join(", ")} (${prepared.fileCount} files)`);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

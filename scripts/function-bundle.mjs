// =============================================================================
// function-bundle.mjs — Export to Fabric's function, as the deploy package Fabric takes
// =============================================================================
// The app's functions (openCatalog, and semanticModel for DirectQuery and Direct Lake: fabric_app/rayfin/
// functions, tracked here) are TypeScript with npm dependencies. Fabric takes them as a zip of one esbuild bundle plus its
// metadata (deploymetadata.json, generated from the source by the TypeScript compiler), the
// two sent as a multipart form (fabric_app/export/fabricapp.js). Nothing in either names an item, a
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
//   agent-files.json     the Rayfin agent files `rayfin init ai-files install` writes, at the same
//                        CLI version, { path in the project: text }: .agents/skills/, .mcp.json and
//                        rayfin/.lockfile.json. Every export's project holds them (exportapp.js
//                        appFiles), as a project the CLI made does; Fabricator's check flags a
//                        project without them. One file: the vsix need not carry dot-named folders
//
// Run by vscode:prepublish, and once for a checkout before F5. Needs npm
// and the registry: CI and a developer's machine, never a user's.
import { mkdir, readFile, writeFile, rm, cp, mkdtemp, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { CLIENT_VERSION } = require("../fabric_app/export/fabricapp.js");

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
if (await readFile(join(OUT, "pins.json"), "utf8").catch(() => "") === pins && existsSync(join(OUT, "source.zip")) &&
    existsSync(join(OUT, "agent-files.json"))) {
  console.log("fabric-function/ already holds these pins — nothing to build");
  process.exit(0);
}

// A folder's files, relative, with forward slashes; node_modules left out.
const files = async dir => (await readdir(dir, { recursive: true, withFileTypes: true }))
  .filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
  .filter(f => !f.split("/").includes("node_modules"));

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
  // The agent files, as the CLI writes them into a project of this layout. The project has an AGENTS.md
  // already (each export writes its own), so the CLI's one-time AGENTS.md is not written.
  await writeFile(join(project, "AGENTS.md"), "# an export writes its own\n");
  const before = new Set(await files(project));
  sh(`node ${JSON.stringify(join(cli, "node_modules", "@microsoft", "rayfin-cli", "scripts", "main"))} init ai-files install --non-interactive`, project);
  const written = (await files(project)).filter(f => !before.has(f));
  if (!written.includes(".agents/skills/rayfin/SKILL.md")) throw new Error(`rayfin init ai-files install wrote no .agents/skills/rayfin/SKILL.md: ${written.join(", ")}`);
  const agentFiles = {};
  for (const f of written.sort()) agentFiles[f] = await readFile(join(project, f), "utf8");
  await writeFile(join(OUT, "agent-files.json"), JSON.stringify(agentFiles, null, 2) + "\n");
  console.log(`fabric-function/agent-files.json: ${written.join(", ")}`);
  await writeFile(join(OUT, "pins.json"), pins);
  const meta = JSON.parse(prepared.deployMetaData);
  console.log(`fabric-function/: ${meta.functionsMetadata.map(f => f.name).join(", ")} (${prepared.fileCount} files)`);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

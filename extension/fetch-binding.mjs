// =============================================================================
// fetch-binding.mjs — put ONE platform's DuckDB binding into node_modules
// =============================================================================
// A platform-specific vsix has to contain the native library for the platform it claims,
// and npm will only ever install the one matching the machine doing the install: the
// bindings are optionalDependencies gated on os/cpu. So a Linux runner packaging
// `--target win32-x64` produces a vsix that is labelled Windows and contains a Linux .so.
// That failure is silent at package time and total at run time.
//
// npm's --os/--cpu overrides exist but do not cover musl, and they interact badly with a
// lockfile. Fetching the tarball straight from the registry is fewer moving parts and is
// exactly reproducible: the version is read from the installed @duckdb/node-bindings, so
// the binding can never drift from the API package that loads it.
//
//   node fetch-binding.mjs <vscode-target>
//
// Run per matrix leg in CI, before `vsce package --target <the same target>`.
import { mkdir, rm, appendFile, readFile, cp, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const MODULES = join(here, "node_modules", "@duckdb");

// VS Code's target names are not DuckDB's. The mapping is the whole point of this file.
// linux-armhf is deliberately absent: DuckDB publishes no 32-bit ARM binding, so that
// target cannot be served and must not be built — an extension that installs and then
// cannot start is worse than one that is not offered.
const TARGETS = {
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linux-x64-musl",
  "alpine-arm64": "linux-arm64-musl",
};

const target = process.argv[2];
const binding = TARGETS[target];
if (!binding) {
  console.error(`unknown or unsupported target: ${target}\n` +
                `supported: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

// The version the API package actually depends on, not one written down twice.
const version = JSON.parse(
  await readFile(join(MODULES, "node-bindings", "package.json"), "utf8")).version;

const pkg = `@duckdb/node-bindings-${binding}`;
const dest = join(MODULES, `node-bindings-${binding}`);
console.log(`fetching ${pkg}@${version} for VS Code target ${target} ...`);

// npm pack rather than a hand-rolled fetch: it honours the configured registry, any proxy
// and any auth already set up on the machine, which a bare https.get does not.
const work = join(tmpdir(), `onelake-binding-${binding}-${process.pid}`);
await mkdir(work, { recursive: true });
const tgz = execFileSync("npm", ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", work],
                         { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();

// cwd and a bare filename, never an absolute path: GNU tar reads `C:\...` as a REMOTE
// host spec — "Cannot connect to C: resolve failed" — and Git Bash puts GNU tar ahead of
// the bsdtar Windows ships. `--force-local` would fix that one tar and break the other, so
// the argument simply never contains a colon.
execFileSync("tar", ["-xzf", tgz], { cwd: work, stdio: "inherit" });

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(join(work, "package"), dest, { recursive: true });
await rm(work, { recursive: true, force: true });

// Proof, not hope: the package is worthless without the native library, and an empty or
// half-extracted directory would otherwise sail through packaging and fail on the user's
// machine. Fails loudly here instead.
const files = await readdir(dest);
const native = files.filter(f => /\.(node|dll|so|dylib)$/.test(f));
if (!native.length) {
  console.error(`${dest} contains no native library — got: ${files.join(", ")}`);
  process.exit(1);
}
console.log(`  ok — ${dest} (${native.join(", ")})`);

// Exactly ONE binding may exist in a packaged tree. A sibling left over from a previous
// target — or from the developer's own platform, which npm installed without being asked —
// adds 37MB of the wrong library to a vsix that says it serves this one. Pruning here makes
// "one binding" this file's invariant rather than a rule the workflow has to remember.
for (const dir of await readdir(MODULES)) {
  if (dir.startsWith("node-bindings-") && dir !== `node-bindings-${binding}`) {
    await rm(join(MODULES, dir), { recursive: true, force: true });
    console.log(`  pruned ${dir}`);
  }
}

// node_modules/.package-lock.json is npm's record of what NPM installed. Nothing above was
// installed by npm. Arborist does discard that record once the tree disagrees with it, but
// the failure mode if it ever did not — a dependency walk that silently omits the binding —
// is a vsix with no engine and no error. Deleting the file costs nothing and settles it.
await rm(join(here, "node_modules", ".package-lock.json"), { force: true });

// The walk vsce ACTUALLY runs (its src/npm.ts). Files under node_modules reach a vsix only
// through this list: .vscodeignore can un-ignore the binding, but it cannot add a path npm
// never printed. Checked here, with the reason, instead of discovering it on a user's
// machine as an extension host that cannot load an engine.
let listed = "";
try {
  listed = execFileSync(
    "npm", ["list", "--production", "--parseable", "--depth=99999", "--loglevel=error"],
    { cwd: here, encoding: "utf8", shell: process.platform === "win32" });
} catch (err) {
  console.error("npm's dependency walk failed — vsce runs this same command and will fail " +
                "too:\n" + (err.stdout || "") + (err.stderr || ""));
  process.exit(1);
}
if (!listed.split(/\r?\n/).some(p => p.trim() === dest)) {
  console.error(`npm's dependency walk does not list ${dest} — vsce would package a vsix ` +
                `with no engine.`);
  process.exit(1);
}

// The workflow asserts on the packaged vsix and needs the directory name chosen above.
// Reported rather than repeated: the target -> binding map stays the only copy.
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `binding=node-bindings-${binding}\n`);
}

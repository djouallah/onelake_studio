// =============================================================================
// bundle.mjs — the extension host as ONE file: dist/extension.js
// =============================================================================
// src/ plus @duckdb/node-api is ~250 JavaScript files that VS Code would otherwise read one
// require() at a time on activation; @duckdb/node-api alone is 377 files, .d.ts included.
// esbuild folds all of it into dist/extension.js, and .vscodeignore then leaves src/ and
// node-api out of the vsix.
//
// Two things stay outside the bundle, and have to:
//   vscode                  provided by the editor at run time; there is no such package
//   @duckdb/node-bindings   a Node-API addon that loads a platform library by path, which
//                           is why each vsix carries exactly one binding (see extension.yml)
//
// Not minified: a stack trace from a user's Read Log should still name the function.
// esbuild comes from npx with its version pinned, like vsce in the workflow — it needs
// a platform binary of its own, which the package job's `npm ci --omit=optional` would drop.
//
// Run by vscode:prepublish, and by F5 (.vscode/tasks.json).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
const out = join(here, "dist", "extension.js");

// One string, not an argv: npx is npx.cmd on Windows, which Node only spawns through a shell.
execSync("npx --yes esbuild@0.28.1 src/extension.js --bundle --platform=node --format=cjs" +
  " --target=node20 --external:vscode --external:@duckdb/node-bindings --log-level=warning" +
  " --outfile=dist/extension.js", { cwd: here, stdio: "inherit" });
// The shared engine's process (engine-server.js), started by a window, with no editor around it.
execSync("npx --yes esbuild@0.28.1 src/engine-server.js --bundle --platform=node --format=cjs" +
  " --target=node20 --external:@duckdb/node-bindings --log-level=warning" +
  " --outfile=dist/engine-server.js", { cwd: here, stdio: "inherit" });

// The bundle must hold node-api, not point at it — node-api is no longer in the vsix.
const code = readFileSync(out, "utf8");
if (/require\(["']@duckdb\/node-api["']\)/.test(code)) {
  console.error("refusing: dist/extension.js still requires @duckdb/node-api, which the vsix leaves out");
  process.exit(1);
}

// And it must load. `vscode` exists only inside the editor, so a stub stands in: anything
// read from it is another stub, callable and constructible. The engine is required lazily,
// so this loads every module the extension evaluates at activation and nothing native.
const stub = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
  apply: () => stub,
  construct: () => stub,
});
const require = createRequire(import.meta.url);
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? stub : load.call(this, request, ...rest);
};
const ext = require(out);
Module._load = load;
if (typeof ext.activate !== "function" || typeof ext.deactivate !== "function") {
  console.error("refusing: dist/extension.js does not export activate and deactivate");
  process.exit(1);
}
console.log(`bundled ${(code.length / 1024).toFixed(0)} KB into dist/extension.js — it loads and exports activate`);

// =============================================================================
// bundle-desktop.mjs — the desktop app's Node process: dist/desktop.js
// =============================================================================
// The extension itself, src/extension.js, with `vscode` pointing at desktop/node/vscode.js: the app
// is the same code. Run by CI's desktop job only, so a vsix never carries it.
//
// It must load, as bundle.mjs checks of the extension: DuckDB is required lazily, and opening the
// bundle doesn't load it.
// =============================================================================
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || join(here, "dist", "desktop.js");

execSync("npx --yes esbuild@0.28.1 desktop/node/main.js --bundle --platform=node --format=cjs" +
  " --target=node20 --alias:vscode=./desktop/node/vscode.js --external:@duckdb/node-bindings --log-level=warning" +
  ` --outfile="${out}"`, { cwd: here, stdio: "inherit" });

const code = readFileSync(out, "utf8");
if (/require\(["']vscode["']\)/.test(code)) {
  console.error("refusing: the desktop bundle still requires vscode");
  process.exit(1);
}
console.log(`bundled ${(code.length / 1024).toFixed(0)} KB into ${out}`);

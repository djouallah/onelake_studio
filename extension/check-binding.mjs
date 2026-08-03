// =============================================================================
// check-binding.mjs — refuse to package a vsix whose binding was chosen by accident
// =============================================================================
// npm only ever installs the binding for the machine doing the install, so a plain
// `vsce package` on a dev box produces a vsix with NO TargetPlatform in its manifest and
// this machine's native library inside — it installs anywhere and starts nowhere else.
// CI never has this problem because every leg runs fetch-binding.mjs first.
//
// The tell is npm's hidden install record: node_modules/.package-lock.json. Every
// npm install/ci writes it; fetch-binding.mjs deletes it as its final step (so vsce's
// dependency walk reads the real tree). If it exists, this tree was last shaped by npm,
// not by fetch-binding — and packaging it would ship the accident.
//
// Run by vscode:prepublish, which vsce runs before every package.
import { access, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const npmRecord = join(here, "node_modules", ".package-lock.json");
const shaped = await access(npmRecord).then(() => false, () => true);

const duckdb = join(here, "node_modules", "@duckdb");
const bindings = (await readdir(duckdb).catch(() => []))
  .filter(d => d.startsWith("node-bindings-"));

if (!shaped || bindings.length !== 1) {
  console.error(
    "refusing to package: the DuckDB binding in node_modules was not chosen for a target.\n" +
    (bindings.length === 1
      ? `  present: ${bindings[0]} (installed by npm for THIS machine, not for a --target)\n`
      : `  present: ${bindings.join(", ") || "(none)"}\n`) +
    "  a vsix must be platform-specific — run:\n" +
    "    node fetch-binding.mjs <target>\n" +
    "    npx @vscode/vsce@3 package --target <the same target>\n" +
    "  (CI does exactly this, one leg per platform.)");
  process.exit(1);
}
console.log(`binding ok — packaging with ${bindings[0]}`);

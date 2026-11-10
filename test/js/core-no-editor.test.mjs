// core.js is what a window builds that isn't about how it looks. So nothing it loads may need the editor,
// even lazily: this follows every relative require from it, and none may reach `vscode`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const named = f => relative(src, f).split("\\").join("/");
const REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

async function reach(file, seen = new Map()) {
  if (seen.has(file)) return seen;
  const text = await readFile(file, "utf8");
  const requires = [...text.matchAll(REQUIRE)].map(m => m[1]);
  seen.set(file, requires);
  for (const r of requires) {
    if (!r.startsWith(".")) continue;
    const next = join(dirname(file), r.endsWith(".js") ? r : `${r}.js`);
    assert.ok(existsSync(next), `${relative(src, file)} requires ${r}, and there is no such file`);
    await reach(next, seen);
  }
  return seen;
}

test("nothing core.js loads needs the editor", async () => {
  const seen = await reach(join(src, "core", "core.js"));
  const editor = [...seen].filter(([, requires]) => requires.includes("vscode")).map(([f]) => named(f));
  assert.deepEqual(editor, []);
});

test("this follows what it should: the engine's lazy requires are in it", async () => {
  const seen = [...(await reach(join(src, "core", "core.js"))).keys()].map(named);
  for (const f of ["core/engine/engines.js", "core/engine/engine-host.js", "core/engine/engine-client.js", "cli/agent.js"]) {
    assert.ok(seen.includes(f), `${f} isn't reached from core.js`);
  }
});

test("signin.js and settings.js, which the extension hands in, need no editor either", async () => {
  for (const f of ["core/signin.js", "core/settings.js", "core/readlog.js", "cli/skill.js", "core/diskuse.js", "core/onelake/connectivity.js", "cli/standalone.js"]) {
    const seen = await reach(join(src, f));
    const editor = [...seen].filter(([, requires]) => requires.includes("vscode")).map(([x]) => named(x));
    assert.deepEqual(editor, [], f);
  }
});

// core/ is what reads OneLake, and the other parts are built on it. Only core.js, which puts a window
// together, names them: the command line, Excel's endpoint and the export.
test("nothing in core/ but core.js requires another part", async () => {
  const { readdir } = await import("node:fs/promises");
  const core = join(src, "core");
  const wrong = [];
  for (const rel of await readdir(core, { recursive: true })) {
    if (!rel.endsWith(".js") || rel === "core.js") continue;
    const file = join(core, rel);
    for (const r of [...(await readFile(file, "utf8")).matchAll(REQUIRE)].map(m => m[1]).filter(r => r.startsWith("."))) {
      const to = named(join(dirname(file), r));
      if (!to.startsWith("core/") && !to.startsWith("node_modules/")) wrong.push(`${named(file)} requires ${to}`);
    }
  }
  assert.deepEqual(wrong, []);
});

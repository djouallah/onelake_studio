// The test script and the workflow name their test files by hand, so a file can be left out, or a
// typo can run nothing and stay green. Each name must be a file, and each file must be named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const named = text => [...text.matchAll(/test\/js\/([A-Za-z0-9_-]+\.test\.mjs)(\S*)/g)];

test("every test file runs somewhere, and every name is a file", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const workflow = await readFile(new URL("../../.github/workflows/extension.yml", import.meta.url), "utf8");
  const files = (await readdir(new URL("./", import.meta.url))).filter(f => f.endsWith(".test.mjs"));
  const uses = [...named(pkg.scripts.test), ...named(workflow)];
  for (const [whole, , rest] of uses) assert.equal(rest, "", `not one file: ${whole}`);
  const running = new Set(uses.map(m => m[1]));
  for (const f of files) assert.ok(running.has(f), `${f} runs nowhere`);
  for (const f of running) assert.ok(files.includes(f), `${f} is named, and there is no such file`);
});

// The scripts that drive a browser or an installed build are run by name too.
// By the Extension workflow, or by the lake's, which has the tokens one of them needs.
test("every run-*.mjs is run by a workflow", async () => {
  const workflow = (await Promise.all(["extension.yml", "lake-tables.yml"].map(f =>
    readFile(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8")))).join("\n");
  for (const dir of ["js", "e2e"]) {
    const scripts = (await readdir(new URL(`../${dir}/`, import.meta.url))).filter(f => /^run-.+\.mjs$/.test(f));
    for (const f of scripts) assert.ok(workflow.includes(`node test/${dir}/${f}`), `test/${dir}/${f} runs nowhere`);
  }
});

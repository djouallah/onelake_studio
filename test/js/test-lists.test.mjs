// The test script and the workflow name their test files by hand, so a file can be left out, or a
// typo can run nothing and stay green. Each name must be a file, and each file must be named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const named = text => [...text.matchAll(/test\/js\/([A-Za-z0-9_-]+\.test\.mjs)(\S*)/g)];
// A workflow's own lines: a comment that names a test file runs nothing.
const steps = yaml => yaml.split("\n").filter(l => !l.trim().startsWith("#")).join("\n");

test("every test file runs somewhere, and every name is a file", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const workflow = (await Promise.all(["extension.yml", "lake-tables.yml"].map(f =>
    readFile(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8")))).join("\n");
  const files = (await readdir(new URL("./", import.meta.url))).filter(f => f.endsWith(".test.mjs"));
  const uses = [...named(pkg.scripts.test), ...named(steps(workflow))];
  for (const [whole, , rest] of uses) assert.equal(rest, "", `not one file: ${whole}`);
  const running = new Set(uses.map(m => m[1]));
  for (const f of files) assert.ok(running.has(f), `${f} runs nowhere`);
  for (const f of running) assert.ok(files.includes(f), `${f} is named, and there is no such file`);
});

// A test of OneLake itself skips everywhere but in the lake's workflow, which has the token: named in npm test it
// "runs" and proves nothing, so it must be named there too.
test("every test that needs OneLake is run by the lake's workflow", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/lake-tables.yml", import.meta.url), "utf8");
  const there = new Set(named(steps(workflow)).map(m => m[1]));
  const files = (await readdir(new URL("./", import.meta.url))).filter(f => /^(onelake-|onelaketable\.|health\.).*test\.mjs$/.test(f));
  assert.ok(files.length >= 5, `the lake's tests are found: ${files.join(", ")}`);
  for (const f of files) assert.ok(there.has(f), `${f} needs OneLake, and the lake's workflow doesn't run it`);
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

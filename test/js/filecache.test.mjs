// filecache.js: a cache folder from before the lake is emptied once of its blocks and delta/, and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { settleFileCache, LAYOUT } = require("../../src/filecache.js");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "onelake-filecache-"));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  return { root, dir: join(root, "account") };
}
// What goes, goes behind the answer, not before it.
const settled = async (dir, left) => {
  for (let i = 0; i < 100; i++) {
    if ((await readdir(dir)).sort().join() === left.join()) return;
    await new Promise(r => setTimeout(r, 10));
  }
};

test("a folder from before the lake goes once: its blocks and delta/, not host/, models/ or lake/", async t => {
  const { dir } = await setup(t);
  for (const d of ["delta/abc", "host", "models", "lake/files"]) await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, "delta", "abc", "00000000000000000000.json"), "{}");
  await writeFile(join(dir, "host", "store.json"), "{}");
  await writeFile(join(dir, "0001d9b2"), "old block");
  await writeFile(join(dir, "0005f482"), "old block");

  assert.equal(await settleFileCache(dir), true, "what was kept is gone");
  await settled(dir, ["host", "lake", "models"]);
  assert.deepEqual((await readdir(dir)).sort(), ["host", "lake", "models"]);
  assert.equal(await readFile(join(dir, "host", "store.json"), "utf8"), "{}");
  assert.equal(await readFile(`${dir}.layout`, "utf8"), LAYOUT, "the note is beside the folder");

  assert.equal(await settleFileCache(dir), false, "settled once");
});

test("a folder that isn't there yet is made", async t => {
  const { dir } = await setup(t);
  assert.equal(await settleFileCache(dir), true);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await settleFileCache(dir), false);
});

test("a folder noted at a block size, from before the lake, goes again", async t => {
  const { dir } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}.layout`, "block 4194304");
  await writeFile(join(dir, "0001d9b2"), "old block");
  assert.equal(await settleFileCache(dir), true);
  await settled(dir, []);
  assert.deepEqual(await readdir(dir), []);
});

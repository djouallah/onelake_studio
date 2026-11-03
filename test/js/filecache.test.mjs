// filecache.js: a disk cache folder written at another block size is emptied once, and only of its blocks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { settleFileCache, FILE_CACHE_BLOCK } = require("../../src/filecache.js");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "onelake-filecache-"));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  return { root, dir: join(root, "account") };
}
// The old blocks go behind the answer, not before it.
const settled = async dir => {
  for (let i = 0; i < 100; i++) {
    if (!(await readdir(dir, { withFileTypes: true })).some(d => d.isFile())) return;
    await new Promise(r => setTimeout(r, 10));
  }
};

test("a folder from before goes once: its blocks, not delta/ or host/", async t => {
  const { dir } = await setup(t);
  await mkdir(join(dir, "delta", "abc"), { recursive: true });
  await mkdir(join(dir, "host"), { recursive: true });
  await writeFile(join(dir, "delta", "abc", "00000000000000000000.json"), "{}");
  await writeFile(join(dir, "host", "store.json"), "{}");
  await writeFile(join(dir, "0001d9b2"), "old block");
  await writeFile(join(dir, "0005f482"), "old block");

  assert.equal(await settleFileCache(dir), true, "what was kept whole is gone");
  await settled(dir);
  assert.deepEqual((await readdir(dir)).sort(), ["delta", "host"]);
  assert.equal(await readFile(join(dir, "delta", "abc", "00000000000000000000.json"), "utf8"), "{}");
  assert.equal(await readFile(`${dir}.layout`, "utf8"), `block ${FILE_CACHE_BLOCK}`, "the note is beside the folder");

  await writeFile(join(dir, "0009aa11"), "new block");
  assert.equal(await settleFileCache(dir), false, "settled once");
  assert.deepEqual((await readdir(dir)).sort(), ["0009aa11", "delta", "host"]);
});

test("a folder that isn't there yet is made, at this block size", async t => {
  const { dir } = await setup(t);
  assert.equal(await settleFileCache(dir), true);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await settleFileCache(dir), false);
});

test("a folder noted at another block size goes again", async t => {
  const { dir } = await setup(t);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}.layout`, "block 524288");
  await writeFile(join(dir, "0001d9b2"), "old block");
  assert.equal(await settleFileCache(dir), true);
  await settled(dir);
  assert.deepEqual(await readdir(dir), []);
});

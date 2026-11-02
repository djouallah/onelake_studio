// semviews.js: the semantic views this machine keeps — pointers, per account, read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createSemViews } = require("../../src/semviews.js");
const { createCatalogFile } = require("../../src/catalogfile.js");

// Each account's catalog file, as the extension has them.
const opened = [];
const catalogsIn = dir => {
  const files = new Map();
  return account => {
    if (!files.has(account)) {
      const f = createCatalogFile({ file: join(dir, "catalogs", `${account}.sqlite`) });
      files.set(account, f);
      opened.push(f);
    }
    return files.get(account);
  };
};
const done = async dir => {
  for (const f of opened.splice(0)) f.close();
  await rm(dir, { recursive: true, force: true });
};

test("one view by its name: read from where it is, a local copy or a lakehouse's Files/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-one-"));
  try {
    const local = join(dir, "Sales.bim");
    await writeFile(local, "the local model");
    const url = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/m/Ops.bim";
    const read = [];
    const views = createSemViews({ catalogFor: catalogsIn(dir), onelake: { readBytes: async (ws, path) => {
      read.push([ws, path]);
      if (path.includes("Gone")) throw new Error("not there");
      return Buffer.from("the OneLake model");
    } } });
    await views.put("Sales", local, "ws");
    await views.put("Ops", url, "ws");
    assert.equal((await views.text("sales", "WS")).text, "the local model", "by name, ignoring case");
    const ops = await views.text("Ops", "ws");
    assert.equal(ops.text, "the OneLake model");
    assert.equal(ops.path, url);
    assert.deepEqual(read.at(-1), ["ws", "lh.Lakehouse/Files/m/Ops.bim"]);
    assert.equal(await views.text("Ops", "elsewhere"), null, "its workspace is part of its name");
    assert.equal(await views.text("Nope", "ws"), null);
    await rm(local);
    assert.match((await views.text("Sales", "ws")).error, /ENOENT/);
  } finally { await done(dir); }
});

test("a local copy from before they were per account moves to the account that opened it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const root = join(dir, "semantic-models");
    const old = join(root, "sales", "nem.yaml");
    await mkdir(join(root, "sales"), { recursive: true });
    await writeFile(old, "from before\n");
    const v = createSemViews({ catalogFor: catalogsIn(dir), onelake: { readBytes: async () => Buffer.from("in OneLake\n") } });
    v.useAccount("a");
    await v.put("nem", old, "sales");
    const cloud = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/c.yaml";
    await v.put("cloud", cloud, "sales");

    const mine = join(root, "me@contoso.com");
    assert.equal(await v.adoptCopies(root, mine), 1);
    const moved = join(mine, "sales", "nem.yaml");
    assert.equal(await readFile(moved, "utf8"), "from before\n");
    assert.ok(!existsSync(old), "moved, not copied");
    assert.equal((await v.list()).find(x => x.name === "nem").path, moved);
    assert.equal((await v.list()).find(x => x.name === "cloud").path, cloud, "a OneLake file stays where it is");
    assert.equal(await v.adoptCopies(root, mine), 0, "once");

    // Another account with a pointer to the same old copy: what it needs has gone, and it isn't
    // handed this account's. It reads Fabric again when it next opens the model.
    const other = createSemViews({ catalogFor: catalogsIn(dir), onelake: {} });
    other.useAccount("b");
    await writeFile(old, "for the other account\n");
    await other.put("nem", old, "sales");
    await rm(old);
    assert.equal(await other.adoptCopies(root, join(root, "other@fabrikam.com")), 0);
    assert.ok(!existsSync(join(root, "other@fabrikam.com")));

    // A copy already in the account's folder is kept, and only the pointer moves.
    const third = createSemViews({ catalogFor: catalogsIn(dir), onelake: {} });
    third.useAccount("c");
    await writeFile(old, "older\n");
    await third.put("nem", old, "sales");
    const theirs = join(root, "c@contoso.com");
    await mkdir(join(theirs, "sales"), { recursive: true });
    await writeFile(join(theirs, "sales", "nem.yaml"), "newer\n");
    assert.equal(await third.adoptCopies(root, theirs), 1);
    assert.equal(await readFile(join(theirs, "sales", "nem.yaml"), "utf8"), "newer\n");
    assert.equal(await readFile(old, "utf8"), "older\n");
  } finally { await done(dir); }
});

test("a view is a pointer, kept per account, and its .bim is read where it is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const bim = join(dir, "sales.bim");
    await writeFile(bim, '{"model":{}}');
    const reads = [];
    const onelake = { readBytes: async (ws, path) => { reads.push([ws, path]); return Buffer.from('{"model":{"x":1}}'); } };
    const v = createSemViews({ catalogFor: catalogsIn(dir), onelake });
    v.useAccount("a");
    assert.deepEqual(await v.list(), []);

    const made = await v.put("sales", bim);
    assert.equal(made.text, '{"model":{}}');
    await v.put("Sales", bim);
    assert.equal((await v.list()).length, 1, "a name is kept once, whatever its case");

    // abfss:// is read through OneLake (cache-first there).
    await v.put("nem", "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/m/nem.bim");
    assert.deepEqual(reads, [["ws", "lh.Lakehouse/Files/m/nem.bim"]]);
    await assert.rejects(v.put("bad", join(dir, "model.json")), /\.bim file/);
    // An Apache Ossie model is a model file too; semantic.js reads its YAML.
    const ossie = join(dir, "ossie.yaml");
    await writeFile(ossie, "version: 0.2.0.dev0\ndatasets: []\n");
    assert.equal((await v.put("ossie", ossie)).text, "version: 0.2.0.dev0\ndatasets: []\n");

    const texts = await v.texts();
    assert.deepEqual(texts.map(t => t.name).sort(), ["Sales", "nem", "ossie"]);

    v.useAccount("b");
    assert.deepEqual(await v.list(), [], "another account has its own views");
  } finally { await done(dir); }
});

test("two workspaces' models of one name are two views", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const bim = join(dir, "aemo.bim");
    await writeFile(bim, '{"model":{}}');
    const v = createSemViews({ catalogFor: catalogsIn(dir), onelake: { readBytes: async () => Buffer.from("{}") } });
    v.useAccount("a");
    await v.put("aemo", bim, "prod");
    await v.put("aemo", bim, "Test WS");
    await v.put("AEMO", bim, "PROD");
    assert.deepEqual((await v.list()).map(x => x.schema).sort(), ["PROD", "Test WS"], "one per workspace, whatever the case");
  } finally { await done(dir); }
});

test("views kept at once are all kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const bim = join(dir, "m.bim");
    await writeFile(bim, '{"model":{}}');
    const v = createSemViews({ catalogFor: catalogsIn(dir), onelake: { readBytes: async () => Buffer.from("{}") } });
    v.useAccount("a");
    await Promise.all(["a", "b", "c", "d", "e"].map(n => v.put(n, bim, "ws")));
    assert.deepEqual((await v.list()).map(x => x.name).sort(), ["a", "b", "c", "d", "e"]);
  } finally { await done(dir); }
});

test("what an older version kept in a JSON file comes across once, and a view is in the catalog file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const jsonDir = join(dir, "old");
    await mkdir(jsonDir);
    const bim = join(dir, "m.bim");
    await writeFile(bim, '{"model":{}}');
    const kept = [{ name: "nem", schema: "aemo", path: bim, created: "2026-01-01T00:00:00.000Z" }];
    await writeFile(join(jsonDir, "a.json"), JSON.stringify(kept));
    await writeFile(join(jsonDir, "signed-out.json"), "not json");
    const catalogFor = catalogsIn(dir);
    const v = createSemViews({ catalogFor, dir: jsonDir, onelake: {} });
    v.useAccount("a");
    assert.deepEqual(await v.list(), kept);
    assert.equal((await v.texts())[0].text, '{"model":{}}');

    await v.put("nem", bim, "AEMO");
    await v.put("other", bim, "aemo");
    const again = createSemViews({ catalogFor, dir: jsonDir, onelake: {} });
    again.useAccount("a");
    assert.deepEqual((await again.list()).map(x => [x.name, x.schema]), [["nem", "AEMO"], ["other", "aemo"]], "once, so it stays replaced");
    assert.ok(!existsSync(join(jsonDir, "a.json")), "and the old file goes");

    // Clear Cached takes them, with the models' local copies they point at, and the JSON doesn't come back.
    await catalogFor("a").clear();
    assert.deepEqual(await again.list(), []);

    again.useAccount(null);
    assert.deepEqual(await again.list(), [], "a file that isn't JSON holds none");
  } finally { await done(dir); }
});

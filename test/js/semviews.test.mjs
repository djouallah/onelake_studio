// semviews.js: the semantic views this machine keeps — pointers, per account, read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createSemViews } = require("../../core/models/semviews.js");
const { createCatalogFile } = require("../../core/onelake/catalogfile.js");

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
    await writeFile(ossie, "version: 0.3.0.dev0\ndatasets: []\n");
    assert.equal((await v.put("ossie", ossie)).text, "version: 0.3.0.dev0\ndatasets: []\n");

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

test("a model file naming its tables schema.table keeps the lakehouse picked for it, by its path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-place-"));
  try {
    const yaml = join(dir, "dax_context.ossie.yaml");
    await writeFile(yaml, "version: 0.2.0.dev0\ndatasets: []\n");
    const tmdl = join(dir, "dax_context.tmdl");
    await writeFile(tmdl, "createOrReplace\n");
    const v = createSemViews({ catalogFor: catalogsIn(dir), onelake: {} });
    v.useAccount("a");
    assert.equal(await v.placement(yaml), null);
    const kept = await v.put("dax_context", yaml, "app", "ossie");
    assert.equal(kept.lakehouse, "ossie");
    assert.deepEqual(await v.placement(yaml.toUpperCase()), { workspace: "app", lakehouse: "ossie" }, "by its path, any case");
    assert.equal((await v.list())[0].lakehouse, "ossie");
    // Kept again without one: the pick stays. In another workspace: not that workspace's lakehouse.
    await v.put("dax_context", yaml, "app");
    assert.equal((await v.texts())[0].lakehouse, "ossie");
    await v.put("dax_context", yaml, "other");
    assert.equal((await v.list()).find(x => x.schema === "other").lakehouse, undefined);
    // Picked again: the new one.
    await v.place(yaml, "app", "ossie2");
    assert.equal((await v.list()).find(x => x.schema === "app").lakehouse, "ossie2");
    // A TMDL script is a model file too.
    assert.equal((await v.put("t", tmdl, "app")).text, "createOrReplace\n");
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

test("a view named <model>.ossie by an earlier version is <model>; its copy named after it is renamed, or goes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-ossie-"));
  try {
    const account = join(dir, "models", "a"), ws = join(account, "app");
    await mkdir(ws, { recursive: true });
    const own = join(dir, "mine", "oss_dax_dialect.ossie.yaml");
    await mkdir(join(dir, "mine"), { recursive: true });
    await writeFile(own, "the person's model");
    const stale = join(ws, "nyc_taxi.ossie.ossie.yaml"), kept = join(ws, "nyc_taxi.ossie.yaml");
    await writeFile(stale, "a stale copy");
    await writeFile(kept, "the copy");
    const alone = join(ws, "green.ossie.ossie.yaml");
    await writeFile(alone, "the only copy");
    const views = createSemViews({ catalogFor: catalogsIn(dir), onelake: {} });
    await views.put("oss_dax_dialect.ossie", own, "app");
    await views.put("nyc_taxi", kept, "app");
    await views.put("nyc_taxi.ossie", stale, "app");
    await views.put("green.ossie", alone, "app");
    assert.equal(await views.renameOssieViews(account), 3);
    const byName = Object.fromEntries((await views.list()).map(v => [v.name, v.path]));
    assert.deepEqual(Object.keys(byName).sort(), ["green", "nyc_taxi", "oss_dax_dialect"]);
    assert.equal(byName.oss_dax_dialect, own, "a file of the person's own stays where it is, as it is");
    assert.equal(await readFile(own, "utf8"), "the person's model");
    assert.equal(byName.nyc_taxi, kept, "the view of that name already kept is the one kept");
    assert.equal(existsSync(stale), false, "the stale copy goes with its view");
    assert.equal(byName.green, join(ws, "green.ossie.yaml"), "the only copy is renamed as the copies are named");
    assert.equal(await readFile(byName.green, "utf8"), "the only copy");
    assert.equal(await views.renameOssieViews(account), 0, "once");
  } finally { await done(dir); }
});

test("a view is forgotten by its name in its schema, and no other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-forget-"));
  try {
    const a = join(dir, "a.bim"), b = join(dir, "b.bim");
    await writeFile(a, "a");
    await writeFile(b, "b");
    const views = createSemViews({ catalogFor: catalogsIn(dir), onelake: {} });
    await views.put("sales", a, "ws");
    await views.put("sales", b, "other");
    await views.put("ops", b, "ws");
    await views.forget("SALES", "ws");
    assert.deepEqual((await views.list()).map(v => `${v.schema}.${v.name}`).sort(), ["other.sales", "ws.ops"]);
  } finally { await done(dir); }
});

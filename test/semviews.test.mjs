// semviews.js: the semantic views this machine keeps — pointers, per account, read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createSemViews } = require("../src/semviews.js");

test("a view is a pointer, kept per account, and its .bim is read where it is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "semviews-"));
  try {
    const bim = join(dir, "sales.bim");
    await writeFile(bim, '{"model":{}}');
    const reads = [];
    const onelake = { readBytes: async (ws, path) => { reads.push([ws, path]); return Buffer.from('{"model":{"x":1}}'); } };
    const v = createSemViews({ dir: join(dir, "store"), onelake });
    v.useAccount("a");
    assert.deepEqual(await v.list(), []);

    const made = await v.put("sales", bim);
    assert.equal(made.text, '{"model":{}}');
    await v.put("Sales", bim);
    assert.equal((await v.list()).length, 1, "a name is kept once, whatever its case");

    // Files/… is the lakehouse's; abfss:// is read through OneLake (cache-first there).
    const path = v.resolve("Files/m/nem.bim", { workspace: "ws", item: "lh.Lakehouse" });
    assert.equal(path, "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/m/nem.bim");
    await v.put("nem", path);
    assert.deepEqual(reads, [["ws", "lh.Lakehouse/Files/m/nem.bim"]]);
    assert.throws(() => v.resolve("Files/x.bim", null), /relative to a lakehouse/);
    await assert.rejects(v.put("bad", join(dir, "model.json")), /\.bim file/);
    // An Apache Ossie model is a model file too; semantic.js reads its YAML.
    const ossie = join(dir, "ossie.yaml");
    await writeFile(ossie, "version: 0.2.0.dev0\ndatasets: []\n");
    assert.equal((await v.put("ossie", ossie)).text, "version: 0.2.0.dev0\ndatasets: []\n");
    await v.remove("ossie");

    const texts = await v.texts();
    assert.deepEqual(texts.map(t => t.name).sort(), ["Sales", "nem"]);

    v.useAccount("b");
    assert.deepEqual(await v.list(), [], "another account has its own views");
    await v.seed([{ name: "seeded", path: bim }]);
    await v.seed([{ name: "again", path: bim }]);
    assert.deepEqual((await v.list()).map(x => x.name), ["seeded"], "seeding happens once");

    v.useAccount("a");
    await v.remove("SALES");
    assert.deepEqual((await v.list()).map(x => x.name), ["nem"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

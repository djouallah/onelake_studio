// models.js modelFile: a model file on this machine, and the workspace its tables are in. Its tables
// are OneLake's; the workspace comes from its Direct Lake expression, else the one it was opened in
// before, else the workspaces whose kept listing holds its lakehouses. The cache alone: no request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createModels } = require("../../core/models/models.js");
const semantic = await import("../../page/semantic.js");

const URL_ = "https://onelake.dfs.fabric.microsoft.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.3.0.dev0\nname: sales\ndatasets:\n  - name: fct_sales\n";
// A table named <lakehouse>.<schema>.<table>, as ossieToTmsl writes `source: lake.dbo.fct_sales`.
const named = { model: { tables: [{ name: "fct_sales", partitions: [{ source: { type: "entity", schemaName: "lake.dbo", entityName: "fct_sales" } }] }] } };
const byExpression = { model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${URL_}", [HierarchicalNavigation=true])`] }],
  tables: [{ name: "fct_sales", partitions: [{ source: { type: "entity", expressionSource: "DirectLake", schemaName: "dbo", entityName: "fct_sales" } }] }],
} };

const ITEMS = {
  aemo: [{ name: "lake.Lakehouse", kind: "Lakehouse" }],
  "sales-dev": [{ name: "lake.Lakehouse", kind: "Lakehouse" }, { name: "other.Warehouse", kind: "Warehouse" }],
  empty: [{ name: "nb.Notebook", kind: "Notebook" }],
};

async function setup({ bim = named, views = [], items = ITEMS, compiler = { parseYaml: () => ({ datasets: [] }), ossieToTmsl: () => bim }, fabric = {}, onelake = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "modelfile-"));
  const models = createModels({
    onelake: {
      cached: {
        workspaces: async () => ({ value: Object.keys(items), at: 0 }),
        items: async ws => (items[ws] ? { value: items[ws], at: 0 } : null),
      },
      itemNamed: async () => ({ workspace: "aemo", item: "lake.Lakehouse" }),
      ...onelake,
    },
    fabric, semviews: { list: async () => views, placement: async () => null },
    modules: async () => ({ semantic, compiler }),
    modelsFolder: () => dir, account: () => "a", oldModels: join(dir, "old"),
    nameTables: async () => [], notify() {}, onModelChanged() {}, log() {},
  });
  const file = async (name, text = OSSIE) => { const p = join(dir, name); await writeFile(p, text); return p; };
  return { models, file, done: () => rm(dir, { recursive: true, force: true }) };
}

test("tables named by lakehouse: no workspace yet, and the ones that hold that lakehouse to pick from", async () => {
  const { models, file, done } = await setup();
  const f = await models.modelFile(await file("sales.yaml"));
  assert.equal(f.workspace, null);
  assert.equal(f.model, "sales");
  assert.equal((await models.modelFile(await file("oss_dax_dialect.ossie.yaml"))).model, "oss_dax_dialect");
  assert.deepEqual(f.lakehouses, ["lake"]);
  assert.deepEqual(f.choices, ["aemo", "sales-dev"]);
  assert.deepEqual(f.all, ["aemo", "sales-dev", "empty"]);
  assert.match(f.text, /^version:/);
  await done();
});

test("opened before: the same workspace, while it still holds the lakehouse", async () => {
  const views = [];
  const { models, file, done } = await setup({ views });
  const path = await file("sales.yaml");
  views.push({ name: "Sales", schema: "sales-dev", path });
  const f = await models.modelFile(path);
  assert.equal(f.workspace, "sales-dev");
  assert.equal(f.model, "Sales", "its name as it was kept");
  views[0] = { name: "sales", schema: "empty", path };
  assert.equal((await models.modelFile(path)).workspace, null, "a workspace without it any more asks again");
  await done();
});

test("a Direct Lake expression says its workspace: nothing to ask", async () => {
  const { models, file, done } = await setup({ bim: byExpression });
  const f = await models.modelFile(await file("nem.bim", JSON.stringify(byExpression)));
  assert.equal(f.workspace, "aemo");
  assert.equal(f.model, "nem");
  await done();
});

test("a YAML file that is not Ossie is no model, said as such", async () => {
  const { models, file, done } = await setup();
  await assert.rejects(models.modelFile(await file("dbt_project.yml", "name: x\nmodels:\n")),
    e => e.notModel && /not an Apache Ossie model/.test(e.message));
  await done();
});

test("a model that reads no lakehouse is refused", async () => {
  const { models, file, done } = await setup({ bim: { model: { tables: [{ name: "t" }] } } });
  await assert.rejects(models.modelFile(await file("x.yaml")), /reads no lakehouse/);
  await done();
});

test("a semantic model's TMSL is Fabric's model.bim kept beside its Ossie copy, read with no request", async () => {
  const { models, done } = await setup();
  const n = { kind: "semanticModel", workspace: "aemo", model: "NEM Sales", modelId: "m1" };
  assert.match(models.modelBimPath(n), /[\/]aemo[\/]NEM Sales\.bim$/);
  assert.equal(models.modelBimPath(n), models.modelPath(n).replace(/\.ossie\.yaml$/, ".bim"), "beside the copy");
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(models.modelBimPath(n)), { recursive: true });
  await writeFile(models.modelBimPath(n), '{"model":{}}');
  assert.equal((await models.fetchModelBim(n)).toString("utf8"), '{"model":{}}', "the kept file, as it is: fabric is {} here");
  await done();
});

test("a local copy of an earlier Ossie spec is read as it is, never rewritten, with no request", async () => {
  // dax-sql's part, stood in for: it reads either spec and writes the one of now.
  let written = 0;
  const compiler = {
    parseYaml: text => ({ name: /^name: (.*)$/m.exec(text)[1], broken: /broken/.test(text) }),
    ossieToTmsl: doc => { if (doc.broken) throw new Error("not read"); return { name: doc.name, model: { tables: [] } }; },
    tmslToOssie: (bim, name) => ({ version: "0.3.0.dev0", name: bim.name ?? name }),
    stringifyYaml: doc => { written++; return `version: ${doc.version}\nname: ${doc.name}\n`; },
  };
  const { models, done } = await setup({ compiler });
  const { mkdir, readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const n = { kind: "semanticModel", workspace: "aemo", model: "NEM Sales", modelId: "m1" };
  const path = models.modelPath(n);
  await mkdir(dirname(path), { recursive: true });
  // fabric is {} here: a read of Fabric would throw.
  const before = "version: 0.2.0.dev0\nname: NEM Sales\ncustom_extensions: []\n";
  await writeFile(path, before);
  // Opened: the copy as it is, on disk too.
  assert.equal((await models.fetchModel(n)).text, before);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(written, 0);
  await done();
});

test("a semantic view's model, whose definition Fabric refuses to everyone, is said so, and asked of Fabric once", async () => {
  let asked = 0;
  const { models, done } = await setup({ fabric: { listItems: async () => [], getBim: async () => {
    asked++;
    throw new Error("Exporting the model definition failed — Dataset Workload failed to export the dataset with dataset id 2611abb8. " +
      "Cannot export artifact. Semantic model is configured by service apps and has denied access to read the model.");
  } } });
  const n = { kind: "semanticModel", workspace: "tmp", model: "lakeci", modelId: "2611abb8" };
  await assert.rejects(models.fetchModel(n), e => {
    assert.equal(e.unsupported, true);
    assert.match(e.message, /^lakeci is the model Fabric's Publish made of a semantic view, .*Context\/Semantic Views\/lakeci/);
    return true;
  });
  assert.equal(models.unsupportedModels.get(models.modelKey(n)), "a semantic view's model");
  assert.equal(asked, 1);
  await done();
});

test("a semantic view's model is read from the TMDL Fabric wrote of the view, the one whose metadata.json names it", async () => {
  const WS = "8c945c1a-f25e-4f19-a7ad-c3a7bfbd0fc9", LH = "8775fcab-f8f0-497a-b1d8-7a0cd3133d09";
  const tmdl = ["createOrReplace", "\tdatabase v", "\t\tmodel Model", "\t\t\ttable t",
    "\t\t\t\tcolumn a", "\t\t\t\t\tdataType: int64", "\t\t\t\t\tsourceColumn: a",
    "\t\t\t\tpartition t = entity", "\t\t\t\t\tmode: directLake", "\t\t\t\t\tsource",
    "\t\t\t\t\t\tentityName: t", "\t\t\t\t\t\tschemaName: dbo", "\t\t\t\t\t\texpressionSource: E",
    "\t\t\texpression E =", `\t\t\t\t\tAzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}")`, ""].join("\n");
  const stored = {
    "other.Lakehouse/SystemContext/Semantic Views/v/metadata.json": '{"modelObjectId":"another-model"}',
    "lake.Lakehouse/SystemContext/Semantic Views/v/metadata.json": `{"workspaceId":"${WS}","modelObjectId":"M1"}`,
    "lake.Lakehouse/SystemContext/Semantic Views/v/v.tmdl": tmdl,
  };
  const { models, done } = await setup({
    fabric: {
      getBim: async () => { throw new Error("Cannot export artifact. Semantic model is configured by service apps and has denied access to read the model."); },
      listItems: async () => [{ name: "bare", type: "Lakehouse" }, { name: "other", type: "Lakehouse" }, { name: "wh", type: "Warehouse" }, { name: "lake", type: "Lakehouse" }],
    },
    onelake: {
      readBytes: async (ws, p) => {
        if (!(p in stored)) throw Object.assign(new Error(`Reading ${p} failed (HTTP 404)`), { status: 404 });
        return Buffer.from(stored[p]);
      },
      files: async (lh, dir) => Object.keys(stored).filter(p => p.startsWith(`${lh.item}/${lh.area}/${dir}/`))
        .map(p => ({ name: p.split("/").pop(), path: p, isDir: false })),
    },
    compiler: { tmslToOssie: doc => ({ name: doc.name, tables: doc.model.tables.map(t => t.name) }), stringifyYaml: o => JSON.stringify(o) },
  });
  const n = { kind: "semanticModel", workspace: "tmp", model: "v", modelId: "m1" };
  const { text } = await models.fetchModel(n);
  assert.deepEqual(JSON.parse(text), { name: "v", tables: ["t"] });
  assert.equal(models.unsupportedModels.has(models.modelKey(n)), false);
  const { readFile } = await import("node:fs/promises");
  const kept = JSON.parse(await readFile(models.modelBimPath(n), "utf8"));
  assert.equal(kept.model.tables[0].partitions[0].source.expressionSource, "E", "its TMSL kept beside the copy, as a model.bim is");
  await done();
});

// A Fabric semantic view's YAML names its tables schema.table (`source: dbo.fct_sales`), in no lakehouse: Fabric reads
// them in the one the YAML is in. From disk: the one picked for the file before, else every cached lakehouse holding them all.
const bare = { model: { tables: [
  { name: "fct_sales", partitions: [{ source: { type: "entity", schemaName: "dbo", entityName: "fct_sales" } }] },
  { name: "dim_date", partitions: [{ source: { type: "entity", schemaName: "dbo", entityName: "dim_date" } }] },
] } };
const TABLES = {
  "aemo/lake.Lakehouse": [{ schema: "dbo", table: "fct_sales" }, { schema: "dbo", table: "dim_date" }],
  "sales-dev/lake.Lakehouse": [{ schema: "dbo", table: "fct_sales" }],
  "sales-dev/other.Warehouse": [{ schema: "dbo", table: "fct_sales" }, { schema: "dbo", table: "dim_date" }],
};
const cachedWith = tables => ({
  cached: {
    workspaces: async () => ({ value: Object.keys(ITEMS), at: 0 }),
    items: async ws => (ITEMS[ws] ? { value: ITEMS[ws], at: 0 } : null),
    models: async () => ({ value: [] }),
    allTables: async () => new Map(),
    tables: async lh => (tables[`${lh.workspace}/${lh.item}`] ? { value: tables[`${lh.workspace}/${lh.item}`] } : null),
  },
});

test("tables named schema.table: the lakehouses holding them all, and every lakehouse to pick from", async () => {
  const { models, file, done } = await setup({ bim: bare, onelake: cachedWith(TABLES) });
  const f = await models.modelFile(await file("dax_context.ossie.yaml"));
  assert.equal(f.model, "dax_context", ".ossie.yaml is one extension: the model is not dax_context.ossie");
  assert.equal(f.lakehouse, null);
  assert.deepEqual(f.bare.map(b => `${b.schema}.${b.entity}`), ["dbo.fct_sales", "dbo.dim_date"]);
  assert.deepEqual(f.candidates, [{ workspace: "aemo", lakehouse: "lake" }], "a warehouse holding them is no lakehouse; one holding some is not one");
  assert.deepEqual(f.lakehousesAll, [{ workspace: "aemo", lakehouse: "lake" }, { workspace: "sales-dev", lakehouse: "lake" }]);
  // Placed there, they are named in it: lake.dbo.fct_sales, in that workspace.
  const placed = semantic.placeIn(structuredClone(bare), "lake");
  assert.deepEqual(semantic.lakehousesOf(placed, "aemo"), [{ workspaceName: "aemo", itemName: "lake" }]);
  assert.deepEqual(semantic.bareTables(placed), []);
  await done();
});

test("tables named schema.table: the lakehouse picked for the file before, asked no more", async () => {
  const picked = { workspace: "sales-dev", lakehouse: "lake" };
  const again = await setup({ bim: bare, onelake: cachedWith(TABLES) });
  const p2 = await again.file("dax_context.ossie.yaml");
  // semviews keeps the pick by the file's path.
  const withPick = createModels({
    onelake: cachedWith(TABLES), fabric: {},
    semviews: { list: async () => [], placement: async p => (p === p2 ? picked : null) },
    modules: async () => ({ semantic, compiler: { parseYaml: () => ({ datasets: [] }), ossieToTmsl: () => bare } }),
    modelsFolder: () => "x", account: () => "a", oldModels: "x/old",
    nameTables: async () => [], notify() {}, onModelChanged() {}, log() {},
  });
  const f = await withPick.modelFile(p2);
  assert.equal(f.workspace, "sales-dev");
  assert.equal(f.lakehouse, "lake");
  assert.equal(f.kept, true);
  await again.done();
});

test("a .tmdl that is one file of a Power BI project's definition is no model; a TMDL script is", async () => {
  const { models, file, done } = await setup();
  const one = await file("Sales.tmdl", "table Sales\n\tcolumn Amount\n\t\tdataType: double\n");
  await assert.rejects(models.modelFile(one), e => e.notModel === true);
  assert.equal(semantic.isTmdlModel("/// x\ncreateOrReplace\n\n\tdatabase m\n\t\tmodel Model\n\t\t\ttable t\n"), true);
  assert.equal(semantic.isTmdlModel("database m\n\tcompatibilityLevel: 1604\n"), false, "database.tmdl alone has no tables");
  await done();
});

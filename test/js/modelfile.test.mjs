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
const OSSIE = "version: 0.2.0.dev0\nname: sales\ndatasets:\n  - name: fct_sales\n";
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

async function setup({ bim = named, views = [], items = ITEMS } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "modelfile-"));
  const models = createModels({
    onelake: {
      cached: {
        workspaces: async () => ({ value: Object.keys(items), at: 0 }),
        items: async ws => (items[ws] ? { value: items[ws], at: 0 } : null),
      },
      itemNamed: async () => ({ workspace: "aemo", item: "lake.Lakehouse" }),
    },
    fabric: {}, semviews: { list: async () => views },
    modules: async () => ({ semantic, compiler: { parseYaml: () => ({ datasets: [] }), ossieToTmsl: () => bim } }),
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

test("a workspace given is taken as it is", async () => {
  const { models, file, done } = await setup();
  assert.equal((await models.modelFile(await file("sales.yaml"), { workspace: "prod" })).workspace, "prod");
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

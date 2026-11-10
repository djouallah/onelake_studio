// exportapp.js: Export to Fabric — the plan (a OneLake file, one lakehouse, schema.table
// sources), the local copy, one zip of fabric_app/, Studio's Explore and the Report, the upload stamped
// with the build and the packages added, and the zip format itself. The app runs on the model as exported: client side
// the file holds it (model.yaml) and the site its JSON (model.json); on a semantic model the site holds its local copy. The compiler is faked (the suite runs without vendor/); semantic.js's
// lakehousesOf and isOssie are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { planExport, planOnModel, modelDoc, appFiles, engineOf, readApp, writeApp, unzip, vendorFiles, vendorSize, buildDist, zip, crc32, rayfinYml,
        appName, dfsUrl, MARKER, REPORT, fingerprint, localChanges } = require("../../fabric_app/export/exportapp.js");
const semantic = await import("../../app/semantic.js");
const { firstRows, counting, kept, MAX_ROWS } = await import("../../fabric_app/site/storage/modelrows.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const LH = "11111111-2222-3333-4444-555555555555";
const URL_ = `https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`;
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const WHERE = { workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/ossie.yaml" };
const doc = (over = {}) => ({
  version: "0.2.0.dev0", name: "Sales Model",
  datasets: [
    { name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }] },
    { name: "dim_region", source: "mart.dim_region", fields: [{ name: "Region" }] },
  ],
  ...over,
});
const bimOf = (url, tables = ["fct_sales", "dim_region"]) => ({ model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${url}", [HierarchicalNavigation=true])`] }],
  tables: tables.map(name => ({ name })),
} });
const mods = (bim, d = doc()) => ({ semantic, compiler: { parseYaml: () => d, ossieToTmsl: () => bim } });

test("the plan: its own -explore name, the lakehouse's catalog, where its model is", () => {
  const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
  assert.equal(plan.name, "sales-model-explore");
  assert.equal(plan.modelName, "sales");
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.equal(plan.modelUrl, undefined, "the app runs on its own copy: nothing reads the lakehouse's file");
  assert.equal(plan.modelPath, "power bi/nem.Lakehouse/Files/semantic_model/ossie.yaml");
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"], ["dim_region", "mart.dim_region"]]);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.doc, undefined, "the plan carries no model to write");
  assert.equal(appName("2024 Sales"), "m-2024-sales-explore");
  assert.equal(dfsUrl("ws", "/a b.Lakehouse/Files/m#1.yaml"), "https://onelake.dfs.fabric.microsoft.com/ws/a%20b.Lakehouse/Files/m%231.yaml");
});

test("the plan: tables named item.schema.table read their lakehouse by name, and the caller gives its GUIDs", () => {
  // As dax-sql reads back nem.mart.fct_sales: all of it but the table is the schema.
  const named = t => ({ name: t, partitions: [{ source: { type: "entity", entityName: t, schemaName: "nem.mart" } }] });
  const bim = { model: { tables: [named("fct_sales"), named("dim_region")] } };
  const d = doc({ datasets: [
    { name: "fct_sales", source: "nem.mart.fct_sales" },
    { name: "dim_region", source: "nem.mart.dim_region" },
  ] });
  assert.deepEqual(semantic.lakehousesOf(bim, "power bi"), [{ workspaceName: "power bi", itemName: "nem" }]);
  assert.throws(() => planExport(OSSIE, "sales.yaml", "sales", mods(bim, d), WHERE), /by name, and the app needs its GUIDs/);
  const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bim, d), WHERE, [{ workspace: WS, item: LH }]);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"], ["dim_region", "mart.dim_region"]]);
});

test("the plan: a table reading another expression isn't in the lakehouse, whatever it is called", () => {
  const bim = bimOf(URL_);
  bim.model.expressions.push({ name: "Other", kind: "m", expression: 'Sql.Database("x.datawarehouse.fabric.microsoft.com", "y")' });
  bim.model.tables[0].partitions = [{ source: { type: "entity", entityName: "fct_sales", schemaName: "mart", expressionSource: "Other" } }];
  assert.throws(() => planExport(JSON.stringify(bim), "sales.bim", "sales", mods(bim, bim), WHERE), /doesn't hold: fct_sales/);
});

test("a publish that never finished says so, rather than that nothing changed", () => {
  const files = new Map([["site/app.js", Buffer.from("x")]]);
  assert.equal(localChanges(files, { itemId: "item" }).length, 1);
  assert.deepEqual(localChanges(files, { itemId: "item", exportedAt: "2026-01-01T00:00:00Z" }), [], "a marker from before the record");
  assert.deepEqual(localChanges(files, {}), []);
});

test("the plan: a .bim's Direct Lake partitions are its tables, and a table with none is a warning", () => {
  const bim = bimOf(URL_);
  bim.model.tables = [
    { name: "fct_sales", partitions: [{ source: { type: "entity", entityName: "fct_sales", schemaName: "mart" } }] },
    { name: "Calendar", partitions: [{ source: { type: "calculated" } }] },
  ];
  const plan = planExport(JSON.stringify(bim), "sales.bim", "sales", mods(null), { workspace: "w", path: "lh.Lakehouse/Files/sales.bim" });
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"]]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Calendar/);
});

test("the plan: an Ossie model from Power BI reads as its .bim does, a bare source in dbo and a table with no entity a warning", () => {
  const partition = source => ({ custom_extensions: [{ vendor_name: "POWER_BI", data: JSON.stringify({ partitions: [{ name: "p", source }] }) }] });
  const ossie = doc({ datasets: [
    { name: "fct_sales", source: "fct_sales", ...partition({ type: "entity", entityName: "fct_sales" }) },
    { name: "dim_region", source: "mart.dim_region", ...partition({ type: "entity", entityName: "dim_region", schemaName: "mart" }) },
    { name: "Time Calc", source: "Time Calc", ...partition({ type: "calculationGroup" }) },
    { name: "Calendar", source: "Calendar", ...partition({ type: "calculated", expression: "CALENDARAUTO()" }) },
    { name: "hand_written", source: "hand_written" },
  ] });
  const plan = planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_, ossie.datasets.map(d => d.name)), ossie), WHERE);
  assert.deepEqual(plan.tables, [["fct_sales", "dbo.fct_sales"], ["dim_region", "mart.dim_region"], ["hand_written", "dbo.hand_written"]]);
  assert.equal(plan.warnings.length, 2);
  assert.match(plan.warnings[0], /Time Calc/);
  assert.match(plan.warnings[1], /Calendar/);
});

test("the page reads an Ossie dataset's table as the plan does", async () => {
  const copy = async file => {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const code = text.match(/function ossieSource[\s\S]*?\n}\r?\n/)[0].replace(/: any\b/g, "").replace(": string | null", "");
    return new Function(`${code}; return ossieSource;`)();
  };
  const partition = source => [{ vendor_name: "POWER_BI", data: JSON.stringify({ partitions: [{ source }] }) }];
  for (const read of [await copy("fabric_app/site/storage/data.js")]) {
    assert.equal(read({ source: "x", custom_extensions: partition({ entityName: "x" }) }), "dbo.x");
    assert.equal(read({ source: "mart.x", custom_extensions: partition({ entityName: "x", schemaName: "mart" }) }), "mart.x");
    assert.equal(read({ source: "Time Calc", custom_extensions: partition({ type: "calculationGroup" }) }), null);
    assert.equal(read({ source: "by_hand" }), "dbo.by_hand");
    assert.equal(read({ source: "nem.mart.x" }), "mart.x", "item.schema.table");
    assert.equal(read({ source: '"my.lake".dbo."my table"' }), "dbo.my table");
    assert.equal(read({}), null);
  }
});

test("the plan refuses: not a OneLake Files/ file, no lakehouse, two, a name the page cannot use, a source the function cannot open", () => {
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_)), null), /not a OneLake file/);
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_)), { workspace: "w", path: "lh.Lakehouse/Tables/x" }), /not in a lakehouse's Files/);
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf("https://example.com/x")), WHERE), /names no lakehouse/);
  const two = bimOf(URL_);
  two.model.expressions.push({ name: "Other", expression: `"https://onelake.dfs.fabric.microsoft.com/${WS}/${WS}"` });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(two), WHERE), /names 2 lakehouses/);
  const spaced = doc({ datasets: [{ name: "Internet Sales", source: "mart.sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), spaced), WHERE), /letters, digits and _ only: Internet Sales/);
  const deep = doc({ datasets: [{ name: "sales", source: "w.a.b.sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), deep), WHERE), /schema\.table sources only: sales \(w\.a\.b\.sales\)/);
  assert.throws(() => planExport("version: 2\nmodels: []\n", "schema.yml", "m", mods(bimOf(URL_)), WHERE), /not an Apache Ossie model/);
});

test("rayfin.yml: the app's id and name, its redirects first", async () => {
  const tpl = await readFile(new URL("../../fabric_app/rayfin/rayfin.yml", import.meta.url), "utf8");
  assert.match(tpl, /^    assetAccess: protected$/m, "the template's site is protected");
  assert.match(tpl, /- name: TABLES/);
  assert.doesNotMatch(tpl, /MODEL_URL/, "the function reads no model");
  assert.doesNotMatch(tpl, /fabricapps\.net/, "no deployment's own redirect");
  const y = rayfinYml(tpl, "sales-model-explore", ["https://x-eastus.webapp.fabricapps.net"]);
  assert.match(y, /^id: sales-model-explore$/m);
  assert.match(y, /^name: sales-model-explore$/m);
  assert.match(y, /allowedRedirectUris:\n      - https:\/\/x-eastus\.webapp\.fabricapps\.net\n      - http:\/\/localhost:5173\n/);
  assert.throws(() => rayfinYml("name: x\n", "y"), /has no id/);
  assert.equal(rayfinYml(y, "sales-model-explore", ["https://x-eastus.webapp.fabricapps.net", "http://localhost:5173"]), y,
    "a redirect already listed is not listed again");
  assert.doesNotMatch(y, /^connectors:/m, "client side: no connector");
  // On a semantic model: its connector, delegated, at the top level; written again, replaced.
  const m = rayfinYml(tpl, "sales-model-explore", [], { workspace: WS, id: "m1" });
  assert.match(m, /^connectors:\n  - name: model\n    type: fabric-semanticmodel\n    version: "1"\n    config:\n      workspaceId: 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n      itemId: m1\n    operations:\n      - name: executeQuery\n    auth:\n      type: delegated\n/m);
  const again = rayfinYml(m, "sales-model-explore", [], { workspace: WS, id: "m2" });
  assert.equal(again.match(/^connectors:/gm).length, 1);
  assert.match(again, /itemId: m2\n/);
  assert.doesNotMatch(rayfinYml(m, "sales-model-explore", []), /^connectors:|^ +type: fabric-semanticmodel$/m, "exported client side again: gone");
  assert.match(rayfinYml(m, "sales-model-explore", []), /^secrets:/m, "the rest stays");
});

async function fixture(root) {
  const files = {
    "fabric_app/site/index.html": '<link rel="stylesheet" href="./explore/explore.css">\n<script type="module">import { start } from "./app.js"; start();</script>\n<footer>build __BUILD__</footer>\n',
    "fabric_app/site/app.js": 'import { mountExplore } from "./explore/view.js";\nconst { createModelSource } = await import("./storage/modeldata.js");\n',
    "fabric_app/site/storage/data.js": 'import { renderModel } from "../explore/model.js";\n',
    "fabric_app/site/storage/catalog.js": "// catalog\n",
    "fabric_app/site/storage/auth.js": "// auth\n",
    "fabric_app/site/storage/modeldata.js": 'import { createAuth } from "./auth.js";\n',
    "fabric_app/site/storage/modelrows.js": "// modelrows\n",
    "fabric_app/rayfin/rayfin.yml": "id: explore\nname: explore\nservices:\n  auth:\n    allowedRedirectUris:\n      - http://localhost:5173\n",
    "fabric_app/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "import { tmslToModel } from './tmsl.js';\n",
    "app/explore/view.js": "import { renderModel } from './model.js';\nimport { escapeHtml } from '../paths.js';\n",
    "app/explore/explore.js": "// explore\n", "app/explore/model.js": "// model\n",
    "app/explore/explore.css": "/* css */\n", "app/paths.js": "// paths\n",
    "webapp/npm/@duckdb/duckdb-wasm@1.0.0/+esm.js": 'import{a}from"../../apache-arrow@17.0.0/+esm.js";\n',
    "webapp/npm/apache-arrow@17.0.0/+esm.js": "// arrow\n",
    "webapp/duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm": "x".repeat(2048),
    "webapp/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm.js": 'import{F}from"../../apache-arrow@21.2.0/+esm.js";\n',
    "webapp/npm/apache-arrow@21.2.0/+esm.js": "// the connector's arrow\n",
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { fabricAppDir: join(root, "fabric_app"), daxSqlDir: join(root, "daxsql"), appDir: join(root, "app"),
           webappDir: join(root, "webapp") };
}

// The zip's entries, read back through its central directory: path -> bytes.
// The DAX tree's nodes, as dax-sql's parser reads back what its sqlToDax writes.
const dcol = (table, name) => ({ k: "col", table, name });
const dstr = v => ({ k: "str", v });
const dcall = (fn, ...args) => ({ k: "call", fn, args });
const asc = { k: "name", name: "ASC" }, desc = { k: "name", name: "DESC" };

test("a semantic model's rows are cut there: TOPN in the query's order and then every column, a count is COUNTROWS", () => {
  const revenue = dcol(null, "Revenue");
  const groups = dcall("SUMMARIZECOLUMNS", dcol("dim_region", "Region"), dstr("Revenue"), dcall("MEASURE", revenue));
  const table = dcall("CALCULATETABLE", dcall("FILTER", groups, revenue), dcol("dim_region", "Region"));
  const q = { defines: [], evaluates: [{ e: table, order: [{ e: revenue, desc: true }], start: [] }] };
  assert.deepEqual(firstRows(q, 101), { defines: [], evaluates: [{
    e: dcall("TOPN", { k: "num", v: "101" }, table, revenue, desc, dcol("dim_region", "Region"), asc, revenue, asc),
    order: [{ e: revenue, desc: true }], start: [] }] }, "the ORDER BY stays, outside the cut");
  // SELECTCOLUMNS names the result's columns.
  const picked = dcall("SELECTCOLUMNS", groups, dstr("region"), dcol("dim_region", "Region"), dstr("rev"), revenue);
  assert.deepEqual(firstRows({ defines: [], evaluates: [{ e: picked, order: [], start: [] }] }, 5).evaluates[0].e,
    dcall("TOPN", { k: "num", v: "5" }, picked, dcol(null, "region"), asc, dcol(null, "rev"), asc));
  // Not a table it knows the columns of, or not one query: left as it is.
  assert.equal(firstRows({ defines: [], evaluates: [{ e: dcall("ROW", dstr("x"), revenue), order: [], start: [] }] }, 5), null);
  assert.equal(firstRows({ defines: [{ kind: "var" }], evaluates: [{ e: groups, order: [], start: [] }] }, 5), null);
  assert.equal(firstRows({ defines: [], evaluates: [{ e: dcall("SUMMARIZECOLUMNS", dcall("ROLLUPADDISSUBTOTAL")), order: [], start: [] }] }, 5), null);

  assert.deepEqual(counting(q), { defines: [], evaluates: [{ e: dcall("ROW", dstr("cnt"), dcall("COUNTROWS", table)), order: [], start: [] }] });
  assert.equal(counting({ defines: [], evaluates: [q.evaluates[0], q.evaluates[0]] }), null);
});

test("a semantic model's answer: what it keeps, and truncated only when the query has rows it left out", () => {
  const rows = n => Array.from({ length: n }, (_, i) => [i]);
  // A preview: 100 asked for, one more sent to tell whether rows were left.
  assert.deepEqual(kept(rows(101), 3, { n: 100, asked: 100, askedFor: 101 }), { rows: rows(100), truncated: false, limit: 100 });
  // Past the OFFSET.
  assert.deepEqual(kept(rows(6), 1, { from: 2, n: 3, asked: 3, askedFor: 6 }).rows, [[2], [3], [4]]);
  // All of them, and fewer than the cap: all there.
  assert.equal(kept(rows(5), 3, { n: MAX_ROWS, asked: Infinity, askedFor: MAX_ROWS + 1 }).truncated, false);
  // All of them, cut at executeQueries' 100,000 rows: said, with what was kept.
  const all = kept(rows(100_000), 3, { n: MAX_ROWS, asked: Infinity, askedFor: MAX_ROWS + 1 });
  assert.equal(all.truncated, true);
  assert.equal(all.limit, 100_000);
  // ... or at its 1,000,000 values: 20 columns is 50,000 rows.
  const wide = kept(rows(50_000), 20, { n: MAX_ROWS, asked: Infinity, askedFor: MAX_ROWS + 1 });
  assert.deepEqual([wide.truncated, wide.limit, wide.rows.length], [true, 50_000, 50_000]);
  // A LIMIT of exactly the cap has all it asked for.
  assert.equal(kept(rows(100_000), 3, { n: MAX_ROWS, asked: MAX_ROWS, askedFor: MAX_ROWS + 1 }).truncated, false);
  // Not cut on the model, and at the cap: rows may be missing.
  assert.equal(kept(rows(100_000), 3, { n: MAX_ROWS, asked: Infinity }).truncated, true);
});

test("the zip: every entry at the root, deflated, read back byte for byte", async () => {
  const files = new Map([["index.html", Buffer.from("<!doctype html>")], ["a/b.js", Buffer.from("x".repeat(5000))],
                         ["é.txt", Buffer.alloc(0)]]);
  const back = unzip(await zip(files));
  assert.deepEqual([...back.keys()], ["index.html", "a/b.js", "é.txt"]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("a semantic model as it is: the app says it runs on it, and holds no DuckDB, Arrow or browser data source", async () => {
  const engine = "semanticModel";
  const root = await mkdtemp(join(tmpdir(), "export-model-"));
  try {
    const dirs = await fixture(root);
    const plan = planOnModel(doc(), "sales", { workspace: "aemo", workspaceId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", id: "m1", name: "sales" });
    assert.deepEqual([plan.engine, plan.workspace, plan.lakehouse, plan.catalogUrl, plan.modelPath],
                     [engine, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", null, null, "aemo/sales"]);
    // The model's local copy goes with the site: the page writes its DAX from it.
    await assert.rejects(appFiles({ plan, state: null, ...dirs }), /needs the model it runs on/);
    const model = modelDoc(OSSIE, "sales.yaml", mods(bimOf(URL_))).doc;
    const files = await appFiles({ plan, state: null, model, ...dirs });
    const text = p => files.get(p).toString("utf8");
    assert.equal(engineOf(files, { engine }), engine);
    assert.equal(engineOf(files, {}), "semanticModel", "a marker that doesn't say: the site does");
    assert.deepEqual(JSON.parse(text("site/engine.json")), { engine: "semanticModel", name: "sales" });
    assert.deepEqual(JSON.parse(text("site/model.json")), doc());
    for (const p of ["site/storage/modeldata.js", "site/storage/modelrows.js", "site/storage/auth.js", "site/app.js", "site/explore/view.js"]) {
      assert.ok(files.has(p), p);
    }
    assert.ok(![...files.keys()].some(f => /^site\/storage\/(data|catalog)\.js$|vendor\//.test(f)), "no DuckDB data source, and no packages in the zip");
    // The packages added at publish: the connector and its own Arrow, and not DuckDB's.
    const vendor = await vendorFiles(dirs.webappDir, engine);
    assert.deepEqual([...vendor.keys()].sort(), ["vendor/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm.js", "vendor/npm/apache-arrow@21.2.0/+esm.js"]);
    assert.match(text("rayfin/rayfin.yml"), /^connectors:\n  - name: model\n[\s\S]*itemId: m1\n[\s\S]*type: delegated\n/m);
    const agents = text("AGENTS.md");
    assert.match(agents, /Semantic model: `sales`, as it is in Fabric: the export changed nothing in it/);
    assert.match(agents, /as the viewer/);
    assert.match(agents, /as it was when exported[\s\S]*`site\/model\.json`[\s\S]*when it is\s+exported again/);
    assert.match(agents, /The page turns it into DAX and runs it on the semantic model\./);
    assert.doesNotMatch(agents, /next load/, "the semantic model is the model as exported, not as it is now");

    // Client side: the site has its DuckDB data source and not the semantic model's, and DuckDB's packages.
    assert.ok(!files.has("model.ossie.yaml") && !files.has("model.bim"), "a semantic model's app names the model, and holds no copy");
    const duck = await appFiles({ plan: { ...planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE), engine: "duckdb" },
                                  state: null, model, modelText: OSSIE, modelFile: "sales.yaml", ...dirs });
    assert.ok(duck.has("site/storage/data.js"));
    // engine.json always: the hosting answers a file a site lacks with its index.html.
    assert.deepEqual(JSON.parse(duck.get("site/engine.json")), { engine: "duckdb" });
    assert.equal(engineOf(new Map(), {}), "duckdb", "an older client-side site, with no engine.json");
    for (const p of ["site/storage/modeldata.js", "site/storage/modelrows.js"]) assert.ok(!duck.has(p), p);
    // Client side the app runs on its own model: the file's model.yaml, and the site's model.json made from it.
    assert.equal(duck.get("model.ossie.yaml").toString(), OSSIE);
    assert.deepEqual(JSON.parse(duck.get("site/model.json")), model);
    assert.equal(engineOf(duck, {}), "duckdb");
    assert.doesNotMatch(duck.get("rayfin/rayfin.yml").toString(), /^connectors:/m);
    assert.match(duck.get("AGENTS.md").toString(), /app item's owner/);
    assert.match(duck.get("AGENTS.md").toString(), /`model\.ossie\.yaml` in this file[\s\S]*the app\s+runs on it/);
    assert.match(duck.get("AGENTS.md").toString(), /`TABLES` setting\), and never reads the model/);
    assert.equal((await vendorFiles(dirs.webappDir, "duckdb")).size, 5, "every package");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local copy is one zip: the whole app but its packages, written and read back; the upload is its site, stamped, with the packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    const state = { v: 2, rows: ["dim_region.Region"], cols: [], values: ["Revenue"], filters: [], mark: "bar" };
    const files = await appFiles({ plan, state, model: doc(), modelText: OSSIE, modelFile: "ossie.yaml",
                                   redirects: ["https://x.webapp.fabricapps.net"], ...dirs });
    for (const p of ["site/index.html", "site/app.js", "site/storage/data.js", "site/storage/catalog.js",
                     "site/explore/view.js", "site/explore/model.js", "site/explore/explore.css", "site/paths.js",
                     "site/semantic/src/dialects/duckdb.js", "site/semantic/formats/ossie.js", "site/report.json",
                     "rayfin/functions/src/function_app.ts", "AGENTS.md", "model.ossie.yaml", "site/model.json"]) {
      assert.ok(files.has(p), p);
    }
    assert.ok(![...files.keys()].filter(p => p !== "model.ossie.yaml").some(p => /vendor\/|node_modules|ossie\.(json|yaml)$|^model\/|^dist\/|\.gitignore/.test(p)),
      `no packages, no build, no model but model.ossie.yaml: ${[...files.keys()].join(", ")}`);
    assert.deepEqual(JSON.parse(files.get("site/explore.json")), state);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /^id: sales-model-explore$/m);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /- https:\/\/x\.webapp\.fabricapps\.net/);
    const agents = files.get("AGENTS.md").toString();
    assert.match(agents, /- `fct_sales` ← `mart\.fct_sales`/);
    assert.match(agents, /power bi\/nem\.Lakehouse\/Files\/semantic_model\/ossie\.yaml/);
    assert.match(agents, /## The Report: yours to grow[\s\S]*`site\/report\.json`[\s\S]*no tile holds SQL/);
    assert.match(agents, /```json\n([\s\S]*?)\n```/);
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(agents)[1]);
    assert.deepEqual(example.pages[0].tiles[1].pivot.rows, ["dim_region.Region"], "its example is JSON");
    assert.ok(example.pages.every(p => p.tiles.every(t => t.sql === undefined)), "a Visual tile, never SQL");
    assert.equal(example.pages[0].tiles[0].kind, "text", "with a text tile");

    // Written as one file and read back: the same entries, and the marker apart.
    const zipPath = join(root, "out", `${plan.name}.zip`);
    assert.equal(await readApp(zipPath), null, "no file yet");
    await writeApp(zipPath, files, { itemId: "item", model: plan.modelPath });
    assert.deepEqual(await readdir(join(root, "out")), [`${plan.name}.zip`], "one file, nothing beside it");
    const back = await readApp(zipPath);
    assert.deepEqual(back.marker, { itemId: "item", model: plan.modelPath });
    assert.deepEqual([...back.files.keys()].sort(), [...files.keys()].sort());
    for (const [p, b] of files) assert.ok(back.files.get(p).equals(b), p);
    assert.ok(unzip(await readFile(zipPath)).has(MARKER));

    // Re-zipped by hand: a folder zipped whole, backslashes in its names, still the app.
    const byHand = new Map([...back.files, [MARKER, Buffer.from("{}")]].map(([p, b]) => [`sales-model-explore\\${p.split("/").join("\\")}`, b]));
    await writeFile(zipPath, await zip([["sales-model-explore/", Buffer.alloc(0)], ...byHand]));
    assert.deepEqual([...(await readApp(zipPath)).files.keys()].sort(), [...files.keys()].sort());
    // A zip that isn't an app is never taken for one.
    const other = join(root, "other.zip");
    await writeFile(other, await zip([["x.txt", Buffer.from("x")]]));
    await assert.rejects(readApp(other), /was not written by Export to Fabric/);
    await writeFile(other, "not a zip");
    await assert.rejects(readApp(other), /is not a zip Export to Fabric can read/);

    // The upload: site/ at the root, stamped, the packages byte for byte, the backend's config.
    const vendor = await vendorFiles(dirs.webappDir, "duckdb");
    const size = vendorSize(vendor);
    assert.equal(size.total, [...vendor.values()].reduce((n, b) => n + b.length, 0));
    assert.equal(size.parts[0][0], "icu extension", "largest first");
    assert.ok(size.parts.some(([n]) => n === "@duckdb/duckdb-wasm@1.0.0"), "a scoped package is one part");
    const config = { apiUrl: "https://backend", publishableKey: "pk-1", workspaceId: WS, itemId: "item" };
    const up = buildDist(files, config, vendor, "20261028-120000");
    assert.deepEqual(JSON.parse(up.get("rayfin.config.json")), config);
    assert.ok(!up.has("AGENTS.md") && !up.has("rayfin/rayfin.yml") && !up.has("site/index.html"), "the site only, at the root");
    assert.match(up.get("index.html").toString(), /import \{ start \} from "\.\/app\.js\?v=20261028-120000"/);
    assert.match(up.get("index.html").toString(), /href="\.\/explore\/explore\.css\?v=20261028-120000"/);
    assert.match(up.get("index.html").toString(), /build 20261028-120000/);
    assert.match(up.get("app.js").toString(), /from "\.\/explore\/view\.js\?v=20261028-120000"/);
    // A module loaded only when it is needed is stamped too, or a redeploy leaves the old one in the browser.
    assert.match(up.get("app.js").toString(), /import\("\.\/storage\/modeldata\.js\?v=20261028-120000"\)/);
    assert.match(up.get("explore/view.js").toString(), /from '\.\.\/paths\.js\?v=20261028-120000'/);
    assert.match(up.get("storage/data.js").toString(), /from "\.\.\/explore\/model\.js\?v=20261028-120000"/);
    assert.equal(up.get("vendor/npm/@duckdb/duckdb-wasm@1.0.0/+esm.js").toString(), 'import{a}from"../../apache-arrow@17.0.0/+esm.js";\n',
      "packages ship byte for byte");
    assert.ok(up.has("report.json"));
    assert.ok(unzip(await zip(up)).get("app.js").equals(up.get("app.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("site/report.json: no tiles at first, kept by every export; never a local change", async () => {

  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    const first = await appFiles({ plan, state: null, model: doc(), modelText: OSSIE, modelFile: "ossie.yaml", ...dirs });
    assert.deepEqual(JSON.parse(first.get(REPORT).toString()), { pages: [{ name: "Page 1", tiles: [] }] });
    const mine = Buffer.from('{ "tiles": [{ "title": "mine", "kind": "kpi", "sql": "SELECT 1 FROM model" }] }');
    const again = await appFiles({ plan, state: null, model: doc(), modelText: OSSIE, modelFile: "ossie.yaml", kept: mine, ...dirs });
    assert.equal(again.get(REPORT), mine, "the zip's own report, as it is");

    // An edit to the report is never asked about; an edit to anything else is.
    const marker = { files: fingerprint(first) };
    assert.ok(!(REPORT in marker.files) && !(MARKER in marker.files));
    assert.deepEqual(localChanges(again, marker), []);
    const edited = new Map(first);
    edited.set("site/app.js", Buffer.from("// an agent's edit"));
    edited.set("site/chart.js", Buffer.from("new"));
    edited.delete("AGENTS.md");
    // The model the app runs on is one of its files: an edit to it is a local change, published As Is.
    edited.set("model.yaml", Buffer.from("version: 1\ndatasets: []\n"));
    assert.deepEqual(localChanges(edited, marker), ["AGENTS.md", "model.yaml", "site/app.js", "site/chart.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped page and its data source parse; the page reads its model from the site, and the function reads none", async () => {
  for (const p of ["app/explore/report.js", "fabric_app/site/app.js", "fabric_app/site/storage/data.js", "fabric_app/site/storage/catalog.js",
                   "fabric_app/site/storage/modeldata.js"]) {
    execFileSync(process.execPath, ["--check", new URL(`../../${p}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
  }
  // Every package the page runs is the site's own (vendor/, core/vendored.js WEBAPP), at the pins.
  const { WEBAPP, VENDOR } = require("../../core/vendored.js");
  for (const p of ["app.js", "storage/data.js", "storage/results.js", "storage/auth.js", "storage/blockcache.js", "index.html"]) {
    const s = await readFile(new URL(`../../fabric_app/site/${p}`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|extensions\.duckdb\.org|getJsDelivrBundles/, `${p} loads nothing remote`);
  }
  const site = async p => readFile(new URL(`../../fabric_app/site/${p}`, import.meta.url), "utf8");
  assert.ok((await site("storage/data.js")).includes(`../vendor/npm/${WEBAPP.duckdbWasm}/+esm.js`));
  assert.ok((await site("storage/data.js")).includes(`const DUCKDB = '${WEBAPP.duckdb}';`));
  assert.ok((await site("storage/data.js")).includes(`const EXTENSIONS = ${JSON.stringify(WEBAPP.extensions).replace(/"/g, "'").replace(/,/g, ", ")};`));
  assert.ok((await site("storage/results.js")).includes(`../vendor/npm/${WEBAPP.arrow}/+esm.js`));
  assert.ok((await site("storage/auth.js")).includes(`../vendor/npm/${WEBAPP.rayfinClient}/+esm.js`));
  assert.ok((await site("storage/auth.js")).includes(`../vendor/npm/${WEBAPP.rayfinFabric}/+esm.js`));
  assert.ok((await site("app.js")).includes(`./vendor/npm/${WEBAPP.echarts}/dist/echarts.min.js`));
  assert.ok(VENDOR.webapp.esm.includes(WEBAPP.duckdbWasm) && VENDOR.webapp.files.includes(`${WEBAPP.duckdbWasm}/dist/duckdb-base.wasm`));
  const data = await readFile(new URL("../../fabric_app/site/storage/data.js", import.meta.url), "utf8");
  assert.doesNotMatch(data, /ossie\.json/);
  assert.match(data, /catalog\.open\(\)/);
  assert.match(data, /"\.\.\/model\.json"/, "client side, the model is the site's own");
  assert.doesNotMatch(data, /timeZone|SET TimeZone/, "no session time zone the page never passes");
  // On a semantic model the page reads the model the semantic model was made from, not the function's.
  const modeldata = await site("storage/modeldata.js");
  assert.match(modeldata, /"\.\.\/model\.json"/);
  assert.doesNotMatch(modeldata, /functions\.semanticModel/);
  const fn = await readFile(new URL("../../fabric_app/rayfin/functions/src/function_app.ts", import.meta.url), "utf8");
  assert.match(fn, /ctx\.Secrets\.TABLES/);
  assert.doesNotMatch(fn, /MODEL_URL|parseYaml/, "the function reads no model");
  const html = await readFile(new URL("../../fabric_app/site/index.html", import.meta.url), "utf8");
  assert.match(html, /color-scheme: dark/);
  assert.doesNotMatch(html, /prefers-color-scheme: light|#fff\b|#ffffff|white/i, "black, always");
});

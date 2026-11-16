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
        appName, dfsUrl, MARKER, REPORT, fingerprint, localChanges, SITE, CONFIG, DEPLOYMENTS, FABRICATOR_RECORD, FORMAT,
        setPackages, setSecrets, setDeployment, workspaceKey, PROJECT_PACKAGES, PAGE_PACKAGES } = require("../../fabric_app/export/exportapp.js");
const semantic = await import("../../page/semantic.js");
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

test("a model file from disk plans as a OneLake file does, named by its workspace and file name", () => {
  const plan = planExport(OSSIE, "C:\\Users\\me\\Downloads\\sales.ossie.yaml", "sales", mods(bimOf(URL_)), { workspace: "power bi", onDisk: true });
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.modelPath, "power bi/sales.ossie.yaml");
  // Exported again from its .fabricator: the name its record kept, whatever the copy inside is called.
  const again = planExport(OSSIE, "model.ossie.yaml", "sales", mods(bimOf(URL_)), { workspace: "power bi", onDisk: true, path: "sales.ossie.yaml" });
  assert.equal(again.modelPath, plan.modelPath);
  assert.throws(() => planExport(OSSIE, "sales.ossie.yaml", "sales", mods(bimOf("https://example.com/x")), { workspace: "w", onDisk: true }), /names no lakehouse/);
  assert.throws(() => planExport(OSSIE, "sales.ossie.yaml", "sales", mods(bimOf(URL_)), { onDisk: true }), /not a OneLake file/);
  assert.throws(() => planExport(OSSIE, "sales.ossie.yaml", "sales", mods(bimOf(URL_)), { workspace: "w", path: "sales.bim" }), /not in a lakehouse's Files/);
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
    "fabric_app/site/app.js": 'import { mountExplore } from "./explore/view.js";\nconst source = await import("./storage/source.js");\n',
    "fabric_app/site/storage/data.js": 'import { renderModel } from "../explore/model.js";\n',
    "fabric_app/site/storage/catalog.js": "// catalog\n",
    "fabric_app/site/storage/auth.js": "// auth\n",
    "fabric_app/site/storage/modeldata.js": 'import { createAuth } from "./auth.js";\n',
    "fabric_app/site/storage/modelrows.js": "// modelrows\n",
    "fabric_app/rayfin/rayfin.yml": "id: explore\nname: explore\nservices:\n  auth:\n    allowedRedirectUris:\n      - http://localhost:5173\n",
    "fabric_app/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "fabric_app/project/gitignore": "node_modules\n",
    "fabric_app/project/vite.config.mjs": "export default {};\n",
    "fabric_app/project/package-lock.json": JSON.stringify({ name: "fabric-app", lockfileVersion: 3, packages: { "": { name: "fabric-app" } } }),
    "agent-files.json": JSON.stringify({ ".agents/skills/rayfin/SKILL.md": "# rayfin\n", ".mcp.json": "{}\n", "rayfin/.lockfile.json": "{}\n" }),
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "import { tmslToModel } from './tmsl.js';\n",
    "page/explore/view.js": "import { renderModel } from './model.js';\nimport { escapeHtml } from '../paths.js';\n",
    "page/explore/explore.js": "// explore\n", "page/explore/model.js": "// model\n",
    "page/explore/explore.css": "/* css */\n", "page/paths.js": "// paths\n",
    "webapp/npm/@duckdb/duckdb-wasm@1.0.0/+esm.js": 'import{a}from"../../apache-arrow@17.0.0/+esm.js";\n',
    "webapp/npm/apache-arrow@17.0.0/+esm.js": "// arrow\n",
    "webapp/duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm": "x".repeat(2048),
    "webapp/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.2/+esm.js": 'import{F}from"../../apache-arrow@21.2.0/+esm.js";\n',
    "webapp/npm/apache-arrow@21.2.0/+esm.js": "// the connector's arrow\n",
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { fabricAppDir: join(root, "fabric_app"), daxSqlDir: join(root, "daxsql"), appDir: join(root, "page"),
           webappDir: join(root, "webapp"), agentFiles: join(root, "agent-files.json") };
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
    assert.deepEqual(JSON.parse(text("site/public/engine.json")), { engine: "semanticModel", name: "sales" });
    assert.deepEqual(JSON.parse(text("site/public/model.json")), doc());
    assert.equal(text("site/public/storage/source.js"), 'export * from "./modeldata.js";\n', "the page's one data source: the semantic model's");
    for (const p of ["site/public/storage/modeldata.js", "site/public/storage/modelrows.js", "site/public/storage/auth.js", "site/public/app.js", "site/public/explore/view.js"]) {
      assert.ok(files.has(p), p);
    }
    assert.ok(![...files.keys()].some(f => /^site\/public\/storage\/(data|catalog)\.js$|vendor\//.test(f)), "no DuckDB data source, and no packages yet (setPackages)");
    // The packages added at publish: the connector and its own Arrow, and not DuckDB's.
    const vendor = await vendorFiles(dirs.webappDir, engine);
    assert.deepEqual([...vendor.keys()].sort(), ["vendor/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.2/+esm.js", "vendor/npm/apache-arrow@21.2.0/+esm.js"]);
    assert.match(text("rayfin/rayfin.yml"), /^connectors:\n  - name: model\n[\s\S]*itemId: m1\n[\s\S]*type: delegated\n/m);
    const agents = text("AGENTS.md");
    assert.match(agents, /Semantic model: `sales`, as it is in Fabric: the export changed nothing in it/);
    assert.match(agents, /as the viewer/);
    assert.match(agents, /as it was when exported[\s\S]*`site\/public\/model\.json`[\s\S]*when it is\s+exported again/);
    assert.match(agents, /The page turns it into DAX and runs it on the semantic model\./);
    assert.doesNotMatch(agents, /next load/, "the semantic model is the model as exported, not as it is now");

    // Client side: the site has its DuckDB data source and not the semantic model's, and DuckDB's packages.
    assert.ok(!files.has("model.ossie.yaml") && !files.has("model.bim"), "a semantic model's app names the model, and holds no copy");
    const duck = await appFiles({ plan: { ...planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE), engine: "duckdb" },
                                  state: null, model, modelText: OSSIE, modelFile: "sales.yaml", ...dirs });
    assert.ok(duck.has("site/public/storage/data.js"));
    // engine.json always: the hosting answers a file a site lacks with its index.html.
    assert.deepEqual(JSON.parse(duck.get("site/public/engine.json")), { engine: "duckdb" });
    assert.equal(engineOf(new Map(), {}), "duckdb", "an older client-side site, with no engine.json");
    for (const p of ["site/public/storage/modeldata.js", "site/public/storage/modelrows.js"]) assert.ok(!duck.has(p), p);
    // Client side the app runs on its own model: the file's model.yaml, and the site's model.json made from it.
    assert.equal(duck.get("model.ossie.yaml").toString(), OSSIE);
    assert.deepEqual(JSON.parse(duck.get("site/public/model.json")), model);
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
    for (const p of ["site/public/index.html", "site/public/app.js", "site/public/storage/data.js", "site/public/storage/catalog.js",
                     "site/public/explore/view.js", "site/public/explore/model.js", "site/public/explore/explore.css", "site/public/paths.js",
                     "site/public/semantic/src/dialects/duckdb.js", "site/public/semantic/formats/ossie.js", "site/public/report.json",
                     "rayfin/functions/src/function_app.ts", "AGENTS.md", "model.ossie.yaml", "site/public/model.json"]) {
      assert.ok(files.has(p), p);
    }
    assert.ok(![...files.keys()].filter(p => p !== "model.ossie.yaml").some(p => /vendor\/|node_modules|ossie\.(json|yaml)$|^model\/|dist\//.test(p)),
      `no packages yet, no build, no model but model.ossie.yaml: ${[...files.keys()].join(", ")}`);
    // The project around it, as the Rayfin CLI's template has one: Fabricator installs it and runs its Vite.
    const pkg = JSON.parse(files.get("package.json"));
    assert.equal(pkg.name, "sales-model-explore");
    assert.deepEqual(pkg.workspaces, ["rayfin/functions"]);
    assert.equal(pkg.scripts.dev, "rayfin dev");
    assert.deepEqual(pkg.devDependencies, PROJECT_PACKAGES);
    // The SDK the page runs, as its vendored copy is: Fabricator's check wants the Fabric sign-in package named.
    const { WEBAPP } = require("../../core/vendored.js");
    assert.deepEqual(pkg.dependencies, { "@microsoft/rayfin-client": WEBAPP.rayfinClient.split("@").pop(),
                                         "@microsoft/rayfin-auth-provider-fabric": WEBAPP.rayfinFabric.split("@").pop() });
    assert.deepEqual(pkg.dependencies, PAGE_PACKAGES);
    // Rayfin's agent files, as the CLI writes them: what Fabricator's ai-files check looks for.
    assert.equal(files.get(".agents/skills/rayfin/SKILL.md").toString(), "# rayfin\n");
    assert.ok(files.has(".mcp.json") && files.has("rayfin/.lockfile.json"));
    // The lock file, named for the app: npm installs what it names and resolves nothing.
    const lock = JSON.parse(files.get("package-lock.json"));
    assert.equal(lock.name, "sales-model-explore");
    assert.equal(lock.packages[""].name, "sales-model-explore");
    for (const [name, v] of Object.entries(PROJECT_PACKAGES)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is pinned`);
    assert.equal(PROJECT_PACKAGES["@microsoft/rayfin-core"], require("../../core/vendored.js").WEBAPP.rayfinClient.split("@").pop(),
      "the Rayfin the page's SDK is");
    assert.equal(files.get(".gitignore").toString(), "node_modules\n");
    assert.equal(files.get("site/vite.config.mjs").toString(), "export default {};\n");
    assert.deepEqual(JSON.parse(files.get("site/public/explore.json")), state);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /^id: sales-model-explore$/m);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /- https:\/\/x\.webapp\.fabricapps\.net/);
    const agents = files.get("AGENTS.md").toString();
    assert.match(agents, /- `fct_sales` ← `mart\.fct_sales`/);
    assert.match(agents, /power bi\/nem\.Lakehouse\/Files\/semantic_model\/ossie\.yaml/);
    assert.match(agents, /## The Report: yours to grow[\s\S]*`site\/public\/report\.json`[\s\S]*no tile holds SQL/);
    assert.match(agents, /Fabricator imports this file/);
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
    assert.deepEqual(back.marker, { itemId: "item", model: plan.modelPath, format: FORMAT });
    assert.deepEqual([...back.files.keys()].sort(), [...files.keys()].sort());
    for (const [p, b] of files) assert.ok(back.files.get(p).equals(b), p);
    const raw = unzip(await readFile(zipPath));
    assert.ok(raw.has(MARKER));
    assert.deepEqual(JSON.parse(raw.get(FABRICATOR_RECORD)), { format: 1, name: "", history: false, deployment: true },
      "what Fabricator's Import window reads");

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
    assert.ok(!up.has("AGENTS.md") && !up.has("rayfin/rayfin.yml") && !up.has("site/public/index.html"), "the site only, at the root");
    assert.match(up.get("index.html").toString(), /import \{ start \} from "\.\/app\.js\?v=20261028-120000"/);
    assert.match(up.get("index.html").toString(), /href="\.\/explore\/explore\.css\?v=20261028-120000"/);
    assert.match(up.get("index.html").toString(), /build 20261028-120000/);
    assert.match(up.get("app.js").toString(), /from "\.\/explore\/view\.js\?v=20261028-120000"/);
    // A module loaded only when it is needed is stamped too, or a redeploy leaves the old one in the browser.
    assert.match(up.get("app.js").toString(), /import\("\.\/storage\/source\.js\?v=20261028-120000"\)/);
    // Its one data source, which the export writes: the one its engine reads.
    assert.equal(files.get("site/public/storage/source.js").toString(), 'export * from "./data.js";\n');
    assert.match(up.get("storage/source.js").toString(), /from "\.\/data\.js\?v=20261028-120000"/);
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

test("site/public/report.json: no tiles at first, kept by every export; never a local change", async () => {

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
    edited.set("site/public/app.js", Buffer.from("// an agent's edit"));
    edited.set("site/public/chart.js", Buffer.from("new"));
    edited.delete("AGENTS.md");
    // The model the app runs on is one of its files: an edit to it is a local change, published As Is.
    edited.set("model.yaml", Buffer.from("version: 1\ndatasets: []\n"));
    assert.deepEqual(localChanges(edited, marker), ["AGENTS.md", "model.yaml", "site/public/app.js", "site/public/chart.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped page and its data source parse; the page reads its model from the site, and the function reads none", async () => {
  for (const p of ["page/explore/report.js", "fabric_app/site/app.js", "fabric_app/site/storage/data.js", "fabric_app/site/storage/catalog.js",
                   "fabric_app/site/storage/modeldata.js"]) {
    execFileSync(process.execPath, ["--check", new URL(`../../${p}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
  }
  // Every module the site's own files import is one an export uploads (appFiles): the site's, the
  // page's explore/ and paths.js, or dax-sql's src/ and formats/ under semantic/. A path no export
  // writes fails in the browser only, as "Failed to fetch dynamically imported module".
  const siteDir = new URL("../../fabric_app/site/", import.meta.url);
  const there = async u => readFile(u).then(() => true, () => false);
  for (const rel of await readdir(siteDir, { recursive: true })) {
    const p = rel.replace(/\\/g, "/");
    if (!p.endsWith(".js") || p.startsWith("vendor/")) continue;
    const s = await readFile(new URL(p, siteDir), "utf8");
    for (const [, spec] of s.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[\w./@+-]+\.js)["']/g)) {
      const to = new URL(spec, new URL(p, "http://site/")).pathname.slice(1);
      // storage/source.js is the export's own (appFiles): the engine's data source, one of the site's.
      const ok = to.startsWith("vendor/") || to === "storage/source.js" || /^semantic\/(src\/[\w./-]+|formats\/(tmsl|ossie|ossie-sql))\.js$/.test(to)
        || (to === "paths.js" || to.startsWith("explore/")
          ? await there(new URL(`../../page/${to}`, import.meta.url)) : await there(new URL(to, siteDir)));
      assert.ok(ok, `${p} imports ${spec}, which no export uploads`);
    }
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

test("an earlier export's .fabricapp reads laid out as a .fabricator: site/ is site/public/, its record moves, its hashes follow", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-legacy-"));
  try {
    const old = join(root, "sales.fabricapp");
    const marker = { itemId: "item", name: "sales-model-explore", files: { "site/app.js": "h1", "AGENTS.md": "h2" } };
    await writeFile(old, await zip([["AGENTS.md", Buffer.from("# a")], ["site/app.js", Buffer.from("// app")],
                                    ["site/report.json", Buffer.from("{}")], ["export.json", Buffer.from(JSON.stringify(marker))]]));
    const back = await readApp(old);
    assert.deepEqual([...back.files.keys()].sort(), ["AGENTS.md", `${SITE}app.js`, `${SITE}report.json`]);
    assert.deepEqual(back.marker.files, { [`${SITE}app.js`]: "h1", "AGENTS.md": "h2" });
    assert.equal(back.marker.itemId, "item");
    // Written again, it is a .fabricator: the record in its folder, Fabricator's beside it, nothing at the root.
    await writeApp(old, back.files, back.marker);
    const raw = unzip(await readFile(old));
    assert.ok(raw.has(MARKER) && raw.has(FABRICATOR_RECORD) && !raw.has("export.json") && !raw.has("site/app.js"));
    assert.equal(JSON.parse(raw.get(MARKER)).format, FORMAT);
    assert.deepEqual(JSON.parse(raw.get(FABRICATOR_RECORD)), { format: 1, name: "sales-model-explore", history: false, deployment: true });
    assert.deepEqual([...(await readApp(old)).files.keys()].sort(), [...back.files.keys()].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file a later OneLake Studio wrote is refused, never read as this one", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-format-"));
  try {
    const later = join(root, "sales.fabricator");
    await writeFile(later, await zip([[`${SITE}app.js`, Buffer.from("x")], [MARKER, Buffer.from(JSON.stringify({ format: FORMAT + 1 }))]]));
    await assert.rejects(readApp(later), /written by a later OneLake Studio \(its format is 2\): update OneLake Studio to open it/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the packages are in the file, the extension's own over the file's; the upload takes the extension's and this publish's backend", async () => {
  const files = new Map([[`${SITE}index.html`, Buffer.from("<footer><span id=\"build\">build __BUILD__ · </span></footer>")],
                         [`${SITE}vendor/npm/old@1.0.0/+esm.js`, Buffer.from("old")],
                         [CONFIG, Buffer.from('{"apiUrl":"https://before"}')]]);
  const vendor = new Map([["vendor/npm/new@2.0.0/+esm.js", Buffer.from("new")]]);
  setPackages(files, vendor);
  assert.ok(!files.has(`${SITE}vendor/npm/old@1.0.0/+esm.js`), "a package the extension no longer pins is gone");
  assert.equal(files.get(`${SITE}vendor/npm/new@2.0.0/+esm.js`).toString(), "new");
  const up = buildDist(files, { apiUrl: "https://now" }, vendor, "20261115-120000");
  assert.deepEqual([...up.keys()].sort(), ["index.html", "rayfin.config.json", "vendor/npm/new@2.0.0/+esm.js"]);
  assert.deepEqual(JSON.parse(up.get("rayfin.config.json")), { apiUrl: "https://now" }, "this publish's backend, not the file's");
  assert.match(up.get("index.html").toString(), /build 20261115-120000/);
  // Neither the packages nor the backend is a local change: every export writes them again.
  assert.deepEqual(Object.keys(fingerprint(files)), [`${SITE}index.html`]);
});

test("the function's settings: client side only, a URL and table names, where rayfin up and a local run read them", () => {
  const none = new Map();
  setSecrets(none, { catalogUrl: null, tables: null });
  assert.equal(none.size, 0, "on a semantic model there is no function");
  const files = new Map();
  setSecrets(files, { catalogUrl: `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`, tables: "mart.fct_sales,mart.dim_region" });
  assert.equal(files.get("rayfin/.env.secrets").toString(),
    `CATALOG_URL=https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}\nTABLES=mart.fct_sales,mart.dim_region\n`);
  assert.deepEqual(JSON.parse(files.get("rayfin/functions/local.settings.json")).Values,
    { FUNCTIONS_WORKER_RUNTIME: "node", CATALOG_URL: `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`, TABLES: "mart.fct_sales,mart.dim_region" });
  assert.deepEqual(Object.keys(fingerprint(files)), []);
});

test("once published, the app as rayfin up records it: its next publish, Fabricator's, updates this app", () => {
  const config = { apiUrl: "https://backend", publishableKey: "pk-1", workspaceId: WS, itemId: "item-1",
                   portalUrl: "https://app.fabric.microsoft.com/", tenantId: "t-1" };
  const files = new Map([[DEPLOYMENTS, Buffer.from(JSON.stringify({ active: "other", deployments: { other: { fabricItemId: "x" } } }))]]);
  setDeployment(files, { config, name: "sales-model-explore", workspace: "Power BI_Sales", hostingUrl: "https://x.fabricapps.net", deployedAt: "2026-11-15T00:00:00Z" });
  assert.equal(workspaceKey("Power BI_Sales"), "power-bi-sales", "as the Rayfin CLI keys a workspace");
  const reg = JSON.parse(files.get(DEPLOYMENTS));
  assert.equal(reg.active, "power-bi-sales");
  assert.deepEqual(reg.deployments.other, { fabricItemId: "x" }, "another workspace's deployment stays");
  assert.deepEqual(reg.deployments["power-bi-sales"], {
    fabricItemId: "item-1", itemName: "sales-model-explore", fabricApiUrl: "https://backend", fabricWorkspaceId: WS, fabricTenantId: "t-1",
    publishableKey: "pk-1", hostingUrl: "https://x.fabricapps.net",
    fabricDeepLink: `https://app.fabric.microsoft.com/groups/${WS}/appbackends/item-1?ctid=t-1`, deployedAt: "2026-11-15T00:00:00Z",
  });
  assert.deepEqual(JSON.parse(files.get(CONFIG)), config, "the site's backend, which rayfin up keeps and Vite serves");
});

// Vite's dev server (Fabricator's preview) rewrites `new URL(<a string>, import.meta.url)`, as its
// vite:asset-import-meta-url plugin matches it: a template became an import of every file in site/public/, and
// Rayfin's local-dev plugin answered rayfin.config.json's as JSON, so app.js never ran; a folder lost its
// trailing slash (DuckDB's worker at /vendornpm/…). The site's scripts hold their module's URL instead.
test("no script of the site is one Vite's dev server rewrites", async () => {
  const VITE = /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/;
  const scripts = [];
  for (const dir of ["fabric_app/site", "page/explore"]) {
    for (const f of await readdir(new URL(`../../${dir}/`, import.meta.url), { recursive: true })) {
      if (/\.(m?js|html)$/.test(f)) scripts.push(`${dir}/${f.split("\\").join("/")}`);
    }
  }
  scripts.push("page/paths.js");
  assert.ok(scripts.length > 20, `the site's scripts are found: ${scripts.length}`);
  for (const f of scripts) {
    const text = await readFile(new URL(`../../${f}`, import.meta.url), "utf8");
    const hit = text.split(/\r?\n/).findIndex(l => !l.trim().startsWith("//") && VITE.test(l));
    assert.equal(hit, -1, `${f}:${hit + 1} is a new URL(<string>, import.meta.url) Vite rewrites: use the module's URL held in a const`);
  }
});

test("the project's dev server and ignore list ship, and rayfin.yml serves site/public as it is", async () => {
  const vite = await readFile(new URL("../../fabric_app/project/vite.config.mjs", import.meta.url), "utf8");
  assert.match(vite, /root: resolve\(import\.meta\.dirname, 'public'\)/);
  assert.match(vite, /publicDir: false/);
  assert.match(vite, /rayfinLocalDev\(\)/);
  const ignore = await readFile(new URL("../../fabric_app/project/gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^node_modules$/m);
  const yml = await readFile(new URL("../../fabric_app/rayfin/rayfin.yml", import.meta.url), "utf8");
  assert.match(yml, /^  staticHosting:\n    enabled: true\n    path: site\n    folder: public\n/m);
  assert.doesNotMatch(yml.split("staticHosting:")[1].split("storage:")[0], /buildCommand/, "no build: the site is uploaded as it is");
});

// The lock file every project ships (scripts/fabric-lock.mjs makes it): what package.json and the function's
// ask for, from the public registry. CI's npm ci of a real export (run-fabricator-project.mjs) proves it installs.
test("the project's lock file is the project's packages, from the public registry", async () => {
  const lock = JSON.parse(await readFile(new URL("../../fabric_app/project/package-lock.json", import.meta.url), "utf8"));
  const fn = JSON.parse(await readFile(new URL("../../fabric_app/rayfin/functions/package.json", import.meta.url), "utf8"));
  const top = lock.packages[""];
  assert.deepEqual(top.dependencies, PAGE_PACKAGES, "the page's SDK, at its vendored version: run scripts/fabric-lock.mjs");
  assert.deepEqual(top.devDependencies, PROJECT_PACKAGES, "the project's packages: run scripts/fabric-lock.mjs");
  assert.deepEqual(top.workspaces, ["rayfin/functions"]);
  const ws = lock.packages["rayfin/functions"];
  assert.deepEqual(ws.dependencies, fn.dependencies, "the function's packages: run scripts/fabric-lock.mjs");
  assert.deepEqual(ws.devDependencies, fn.devDependencies, "the function's packages: run scripts/fabric-lock.mjs");
  const off = Object.entries(lock.packages).filter(([, p]) => p.resolved && !p.link && !p.resolved.startsWith("https://registry.npmjs.org/"));
  assert.deepEqual(off.map(([k]) => k), [], "every package from the public registry");
  // The one link: the workspace, the function.
  assert.deepEqual(Object.entries(lock.packages).filter(([, p]) => p.link).map(([, p]) => p.resolved), ["rayfin/functions"]);
});

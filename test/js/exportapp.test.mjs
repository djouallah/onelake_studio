// exportapp.js: Export to Fabric — the plan (a OneLake file, one lakehouse, schema.table
// sources), the local copy written from fabric_app/ and Studio's Explore, dist/ stamped with
// the build, and the zip that is uploaded. Client side the model is never copied: the app reads it
// in place (MODEL_URL); on a semantic model the site holds the model it was made from. The compiler is faked (the suite runs without vendor/); semantic.js's
// lakehousesOf and isOssie are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { planExport, modelDoc, writeExport, engineOf, buildDist, vendorSize, zip, crc32, rayfinYml, appName, dfsUrl, MARKER,
        readMarker, fingerprint, localChanges } = require("../../src/exportapp.js");
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

test("the plan: its own -explore name, the lakehouse's catalog, the model's URL in place", () => {
  const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
  assert.equal(plan.name, "sales-model-explore");
  assert.equal(plan.modelName, "sales");
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.equal(plan.modelUrl, "https://onelake.dfs.fabric.microsoft.com/power%20bi/nem.Lakehouse/Files/semantic_model/ossie.yaml");
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

test("a publish that never finished says so, rather than that nothing changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onelake-export-"));
  try {
    assert.equal((await localChanges(dir, { itemId: "item" })).length, 1);
    assert.deepEqual(await localChanges(dir, { itemId: "item", exportedAt: "2026-01-01T00:00:00Z" }), [], "a marker from before the record");
    assert.deepEqual(await localChanges(dir, {}), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("the page and the function read an Ossie dataset's table as the plan does", async () => {
  const copy = async file => {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const code = text.match(/function ossieSource[\s\S]*?\n}\r?\n/)[0].replace(/: any\b/g, "").replace(": string | null", "");
    return new Function(`${code}; return ossieSource;`)();
  };
  const partition = source => [{ vendor_name: "POWER_BI", data: JSON.stringify({ partitions: [{ source }] }) }];
  for (const read of [await copy("fabric_app/site/storage/data.js"), await copy("fabric_app/rayfin/functions/src/function_app.ts")]) {
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
  assert.match(tpl, /- name: MODEL_URL/);
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
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const size = buf.readUInt32LE(at + 20), raw = buf.readUInt32LE(at + 24), crc = buf.readUInt32LE(at + 16);
    const nameLen = buf.readUInt16LE(at + 28), local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + size));
    assert.equal(data.length, raw);
    assert.equal(crc32(data), crc, `${name}'s crc`);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

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

for (const engine of ["directLake", "directQuery"]) {
test(`${engine}: the site says it runs on the semantic model, and holds no DuckDB, Arrow or browser data source`, async () => {
  const root = await mkdtemp(join(tmpdir(), "export-model-"));
  try {
    const dirs = await fixture(root);
    const plan = { ...planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE),
                   engine, semanticModel: { workspace: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", id: "m1", name: "sales" } };
    const outDir = join(root, "out", plan.name);
    // The model the semantic model is made from goes with the site: the page writes its DAX from it.
    await assert.rejects(writeExport({ plan, state: null, outDir, ...dirs }), /needs the model it was made from/);
    const model = modelDoc(OSSIE, "sales.yaml", mods(bimOf(URL_))).doc;
    const marker = await writeExport({ plan, state: null, model, outDir, ...dirs });
    assert.equal(marker.engine, engine);
    assert.equal(await engineOf(outDir, marker), engine);
    const all = (await readdir(outDir, { recursive: true })).map(f => f.split("\\").join("/"));
    assert.deepEqual(JSON.parse(await readFile(join(outDir, "site/engine.json"), "utf8")), { engine: "semanticModel", name: "sales" });
    assert.deepEqual(JSON.parse(await readFile(join(outDir, "site/model.json"), "utf8")), doc());
    for (const p of ["site/storage/modeldata.js", "site/storage/modelrows.js", "site/storage/auth.js", "site/app.js", "site/explore/view.js"]) {
      assert.ok(all.includes(p), p);
    }
    for (const gone of [/^site\/storage\/(data|catalog)\.js$/, /^site\/vendor\/npm\/@duckdb/, /^site\/vendor\/npm\/apache-arrow@17\.0\.0/, /^site\/vendor\/duckdb-ext/]) {
      assert.ok(!all.some(f => gone.test(f)), `nothing matches ${gone}: ${all.filter(f => gone.test(f)).join(", ")}`);
    }
    // The connector and its own Arrow stay: the page queries the model through them.
    for (const p of ["site/vendor/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm.js", "site/vendor/npm/apache-arrow@21.2.0/+esm.js"]) {
      assert.ok(all.includes(p), p);
    }
    assert.match(await readFile(join(outDir, "rayfin/rayfin.yml"), "utf8"), /^connectors:\n  - name: model\n[\s\S]*itemId: m1\n[\s\S]*type: delegated\n/m);
    const agents = await readFile(join(outDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Semantic model: `sales`, (Direct Lake|DirectQuery)/);
    assert.match(agents, /as the viewer/);
    assert.match(agents, /as it was when exported[\s\S]*`site\/model\.json`[\s\S]*when it is\s+exported again/);
    assert.doesNotMatch(agents, /next load/, "the semantic model is the model as exported, not as it is now");
    // A marker from before the engine was kept: the site says.
    assert.equal(await engineOf(outDir, { ...marker, engine: undefined }), "semanticModel");

    // Client side: the site has its DuckDB data source and not the semantic model's.
    const duck = join(root, "out", "duck");
    const was = await writeExport({ plan: { ...plan, engine: "duckdb", semanticModel: undefined }, state: null, outDir: duck, ...dirs });
    assert.equal(was.engine, "duckdb");
    const files = (await readdir(duck, { recursive: true })).map(f => f.split("\\").join("/"));
    assert.ok(files.includes("site/storage/data.js") && !files.includes("site/engine.json"));
    for (const p of ["site/storage/modeldata.js", "site/storage/modelrows.js", "site/model.json"]) assert.ok(!files.includes(p), p);
    assert.equal(await engineOf(duck, { ...was, engine: undefined }), "duckdb");
    assert.doesNotMatch(await readFile(join(duck, "rayfin/rayfin.yml"), "utf8"), /^connectors:/m);
    assert.match(await readFile(join(duck, "AGENTS.md"), "utf8"), /app item's owner/);
    assert.match(await readFile(join(duck, "AGENTS.md"), "utf8"), /read \*\*in place\*\*[\s\S]*on its next load/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
}

test("the folder: fabric_app's site and function, Studio's Explore, no model; dist/ stamped; re-export allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    const outDir = join(root, "out", plan.name);
    const state = { v: 2, rows: ["dim_region.Region"], cols: [], values: ["Revenue"], filters: [], mark: "bar" };
    const marker = await writeExport({ plan, state, outDir, ...dirs });
    assert.equal(marker.workspaceId, WS);
    assert.equal(marker.model, plan.modelPath);
    const read = p => readFile(join(outDir, p), "utf8");
    for (const p of ["site/index.html", "site/app.js", "site/storage/data.js", "site/storage/catalog.js",
                     "site/explore/view.js", "site/explore/model.js", "site/explore/explore.css", "site/paths.js",
                     "site/semantic/src/dialects/duckdb.js", "site/semantic/formats/ossie.js",
                     "site/vendor/npm/apache-arrow@17.0.0/+esm.js",
                     "site/vendor/duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm",
                     "rayfin/functions/src/function_app.ts", ".gitignore", MARKER]) {
      await read(p);
    }
    const size = await vendorSize(outDir);
    assert.equal(size.total, 2048 + "// arrow\n".length + 'import{a}from"../../apache-arrow@17.0.0/+esm.js";\n'.length
      + 'import{F}from"../../apache-arrow@21.2.0/+esm.js";\n'.length + "// the connector's arrow\n".length);
    assert.equal(size.total, size.parts.reduce((n, [, b]) => n + b, 0));
    assert.deepEqual(size.parts.map(([n]) => n)[0], "icu extension", "largest first");
    assert.ok(size.parts.some(([n]) => n === "@duckdb/duckdb-wasm@1.0.0"), "a scoped package is one part");
    const all = (await readdir(outDir, { recursive: true })).map(f => f.split("\\").join("/"));
    assert.ok(!all.some(f => /ossie\.(json|yaml)$|^model\//.test(f)), `no copy of the model: ${all.join(", ")}`);
    assert.deepEqual(JSON.parse(await read("site/explore.json")), state);
    assert.match(await read("rayfin/rayfin.yml"), /^id: sales-model-explore$/m);
    const agents = await read("AGENTS.md");
    assert.match(agents, /- `fct_sales` ← `mart\.fct_sales`/);
    assert.match(agents, /power bi\/nem\.Lakehouse\/Files\/semantic_model\/ossie\.yaml/);

    const config = { apiUrl: "https://backend", publishableKey: "pk-1", workspaceId: WS, itemId: "item" };
    const files = await buildDist(outDir, config, "20261028-120000");
    assert.deepEqual(JSON.parse(files.get("rayfin.config.json")), config);
    assert.match(files.get("index.html").toString(), /import \{ start \} from "\.\/app\.js\?v=20261028-120000"/);
    assert.match(files.get("index.html").toString(), /href="\.\/explore\/explore\.css\?v=20261028-120000"/);
    assert.match(files.get("index.html").toString(), /build 20261028-120000/);
    assert.match(files.get("app.js").toString(), /from "\.\/explore\/view\.js\?v=20261028-120000"/);
    // A module loaded only when it is needed is stamped too, or a redeploy leaves the old one in the browser.
    assert.match(files.get("app.js").toString(), /import\("\.\/storage\/modeldata\.js\?v=20261028-120000"\)/);
    assert.match(files.get("explore/view.js").toString(), /from '\.\.\/paths\.js\?v=20261028-120000'/);
    assert.match(files.get("storage/data.js").toString(), /from "\.\.\/explore\/model\.js\?v=20261028-120000"/);
    assert.ok(!files.has("dist/index.html"), "the paths are the site's, at the zip root");
    assert.equal(files.get("vendor/npm/@duckdb/duckdb-wasm@1.0.0/+esm.js").toString(), 'import{a}from"../../apache-arrow@17.0.0/+esm.js";\n',
      "vendored packages ship byte for byte");
    assert.ok(!(await readdir(join(outDir, "dist"))).includes("vendor"), "the packages are kept once, in site/vendor/");
    assert.equal(await read("dist/rayfin.config.json"), files.get("rayfin.config.json").toString());
    assert.ok(unzip(await zip(files)).get("app.js").equals(files.get("app.js")));

    // Exported again: the same folder is rewritten, what is not the export's stays, and an
    // earlier export's model/ copy goes.
    await writeFile(join(outDir, "notes.md"), "mine");
    await mkdir(join(outDir, "model"));
    await writeFile(join(outDir, "model", "ossie.yaml"), OSSIE);
    await writeFile(join(outDir, MARKER), JSON.stringify({ ...marker, itemId: "item", redirects: ["https://x.webapp.fabricapps.net"] }));
    const again = await writeExport({ plan, state: null, outDir, ...dirs });
    assert.equal(again.itemId, "item");
    assert.equal(await read("notes.md"), "mine");
    assert.ok(!(await readdir(outDir)).includes("model"));
    assert.match(await read("rayfin/rayfin.yml"), /- https:\/\/x\.webapp\.fabricapps\.net/);
    assert.equal(await read("site/explore.json"), "null");

    // A folder that is someone else's is not touched.
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "x.txt"), "x");
    await assert.rejects(writeExport({ plan, state, outDir: other, ...dirs }), /not written by Export to Fabric/);
    assert.deepEqual(await readdir(other), ["x.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local changes: an edit, a new file, a removed one — never node_modules or dist/", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    const outDir = join(root, "out", plan.name);
    assert.equal(await readMarker(outDir), null, "a folder not there yet is new");
    await writeExport({ plan, state: null, outDir, ...dirs });
    const files = await fingerprint(outDir);
    assert.ok(files["site/app.js"] && files["rayfin/rayfin.yml"] && files["AGENTS.md"] && files[".gitignore"]);
    assert.ok(!Object.keys(files).some(p => p.includes("\\")), "paths use /");
    const marker = { ...(await readMarker(outDir)), files };

    assert.deepEqual(await localChanges(outDir, marker), [], "as published");
    assert.deepEqual(await localChanges(outDir, { ...marker, files: undefined }), [], "a marker from before the record");

    // Build output and what is outside the copy's own files are not edits.
    await mkdir(join(outDir, "rayfin", "functions", "node_modules", "x"), { recursive: true });
    await writeFile(join(outDir, "rayfin", "functions", "node_modules", "x", "i.js"), "1");
    await mkdir(join(outDir, "dist"), { recursive: true });
    await writeFile(join(outDir, "dist", "app.js"), "built");
    await writeFile(join(outDir, "notes.md"), "mine");
    assert.deepEqual(await localChanges(outDir, marker), []);

    await writeFile(join(outDir, "site", "app.js"), "// an agent's edit");
    await writeFile(join(outDir, "site", "chart.js"), "new");
    await rm(join(outDir, "AGENTS.md"));
    assert.deepEqual(await localChanges(outDir, marker), ["AGENTS.md", "site/app.js", "site/chart.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped page and its data source parse; client side reads the model from the function, on a semantic model from the site", async () => {
  for (const p of ["fabric_app/site/app.js", "fabric_app/site/storage/data.js", "fabric_app/site/storage/catalog.js",
                   "fabric_app/site/storage/modeldata.js"]) {
    execFileSync(process.execPath, ["--check", new URL(`../../${p}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
  }
  // Every package the page runs is the site's own (vendor/, src/vendored.js WEBAPP), at the pins.
  const { WEBAPP, VENDOR } = require("../../src/vendored.js");
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
  assert.doesNotMatch(data, /timeZone|SET TimeZone/, "no session time zone the page never passes");
  // On a semantic model the page reads the model the semantic model was made from, not the function's.
  const modeldata = await site("storage/modeldata.js");
  assert.match(modeldata, /"\.\.\/model\.json"/);
  assert.doesNotMatch(modeldata, /functions\.semanticModel/);
  const fn = await readFile(new URL("../../fabric_app/rayfin/functions/src/function_app.ts", import.meta.url), "utf8");
  assert.match(fn, /ctx\.Secrets\.MODEL_URL/);
  const html = await readFile(new URL("../../fabric_app/site/index.html", import.meta.url), "utf8");
  assert.match(html, /color-scheme: dark/);
  assert.doesNotMatch(html, /prefers-color-scheme: light|#fff\b|#ffffff|white/i, "black, always");
});

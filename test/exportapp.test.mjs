// exportapp.js: Export to Fabric — the plan (one lakehouse, schema.table sources), the local
// copy written from the template and Studio's Explore, dist/ stamped with the build, and the
// zip that is uploaded. The compiler is faked (the suite runs without vendor/); semantic.js's
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
const { planExport, writeExport, buildDist, zip, crc32, rayfinYml, MARKER } = require("../src/exportapp.js");
const semantic = await import("../app/semantic.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const LH = "11111111-2222-3333-4444-555555555555";
const URL_ = `https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`;
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
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

test("the plan: the model's one lakehouse is the catalog, its datasets the tables", () => {
  const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)));
  assert.equal(plan.name, "sales-model");
  assert.equal(plan.modelName, "sales");
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"], ["dim_region", "mart.dim_region"]]);
  assert.deepEqual(plan.warnings, []);
});

test("the plan: a .bim's Direct Lake partitions are its tables, and a table with none is a warning", () => {
  const bim = bimOf(URL_);
  bim.model.tables = [
    { name: "fct_sales", partitions: [{ source: { type: "entity", entityName: "fct_sales", schemaName: "mart" } }] },
    { name: "Calendar", partitions: [{ source: { type: "calculated" } }] },
  ];
  const plan = planExport(JSON.stringify(bim), "sales.bim", "sales", mods(null));
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"]]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Calendar/);
});

test("the plan refuses no lakehouse, two, a table the page cannot name, a source the function cannot open", () => {
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf("https://example.com/x"))), /names no lakehouse/);
  const two = bimOf(URL_);
  two.model.expressions.push({ name: "Other", expression: `"https://onelake.dfs.fabric.microsoft.com/${WS}/${WS}"` });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(two)), /names 2 lakehouses/);
  const spaced = doc({ datasets: [{ name: "Internet Sales", source: "mart.sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), spaced)), /letters, digits and _ only: Internet Sales/);
  const bare = doc({ datasets: [{ name: "sales", source: "sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), bare)), /schema\.table sources only: sales \(sales\)/);
  assert.throws(() => planExport("version: 2\nmodels: []\n", "schema.yml", "m", mods(bimOf(URL_))), /not an Apache Ossie model/);
});

const RAYFIN_YML = `id: iceberg
name: iceberg
version: 1.0.0
services:
  auth:
    allowedRedirectUris:
      - http://localhost:5173
      - https://sonic-bay-be8d87ef81-eastus.webapp.fabricapps.net
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: node ../common/build.mjs
    indexDocument: index.html
    assetAccess: public
secrets:
  - name: CATALOG_URL
`;

test("rayfin.yml: the app's id, protected, no build command, its own redirects only", () => {
  const y = rayfinYml(RAYFIN_YML, "sales-model", ["https://x-eastus.webapp.fabricapps.net"]);
  assert.match(y, /^id: sales-model$/m);
  assert.match(y, /^name: sales-model$/m);
  assert.match(y, /^    assetAccess: protected$/m);
  assert.doesNotMatch(y, /buildCommand/);
  assert.doesNotMatch(y, /sonic-bay/);
  assert.match(y, /allowedRedirectUris:\n      - https:\/\/x-eastus\.webapp\.fabricapps\.net\n      - http:\/\/localhost:5173\n/);
  assert.throws(() => rayfinYml("name: x\n", "y"), /has no id/);
});

async function fixture(root) {
  const files = {
    "template/front_end/fabric_app/iceberg/site/storage/data.js": 'import { engineQueue } from "./queue.js";\n',
    "template/front_end/fabric_app/iceberg/site/storage/catalog.js": "import { perf } from '../frontend/perflog.js';\n",
    "template/front_end/fabric_app/common/site/storage/auth.js": "// auth\n",
    "template/front_end/page/storage/queue.js": "// queue\n",
    "template/front_end/page/storage/results.js": "// results\n",
    "template/front_end/page/frontend/perflog.js": "// perflog\n",
    "template/front_end/fabric_app/iceberg/rayfin/rayfin.yml": RAYFIN_YML,
    "template/front_end/fabric_app/iceberg/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "import { tmslToModel } from './tmsl.js';\n",
    "app/explore/explore.js": "import { formatValue } from './draw.js';\nimport { escapeHtml } from '../paths.js';\n",
    "app/explore/query.js": "// query\n", "app/explore/draw.js": "// draw\n", "app/explore/model.js": "// model\n",
    "app/explore/theme.js": "// theme\n", "app/explore/explore.css": "/* css */\n", "app/paths.js": "// paths\n",
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { templateDir: join(root, "template"), daxSqlDir: join(root, "daxsql"), appDir: join(root, "app") };
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

test("the zip: every entry at the root, deflated, read back byte for byte", () => {
  const files = new Map([["index.html", Buffer.from("<!doctype html>")], ["a/b.js", Buffer.from("x".repeat(5000))],
                         ["é.txt", Buffer.alloc(0)]]);
  const back = unzip(zip(files));
  assert.deepEqual([...back.keys()], ["index.html", "a/b.js", "é.txt"]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("the folder: the template's data source, Studio's Explore, the page; dist/ stamped; re-export allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)));
    const outDir = join(root, "out", plan.name);
    const state = { v: 2, rows: ["dim_region.Region"], cols: [], values: ["Revenue"], filters: [], mark: "bar" };
    const marker = await writeExport({ plan, text: OSSIE, state, outDir, ...dirs });
    assert.equal(marker.workspaceId, WS);
    const read = p => readFile(join(outDir, p), "utf8");
    for (const p of ["site/storage/data.js", "site/storage/catalog.js", "site/storage/auth.js", "site/storage/queue.js",
                     "site/storage/results.js", "site/frontend/perflog.js", "site/explore/explore.js", "site/explore/theme.js",
                     "site/explore/explore.css", "site/paths.js", "site/semantic/dax-sql/dialects/duckdb.js",
                     "site/semantic/formats/ossie.js", "rayfin/functions/src/function_app.ts", ".gitignore", MARKER]) {
      await read(p);
    }
    assert.equal(await read("model/sales.yaml"), OSSIE);
    assert.deepEqual(JSON.parse(await read("site/semantic/ossie.json")).datasets.map(d => d.source), ["mart.fct_sales", "mart.dim_region"]);
    assert.match(await read("rayfin/rayfin.yml"), /assetAccess: protected/);
    const app = await read("site/app.js");
    assert.match(app, /const FIRST = \{"v":2,"rows":\["dim_region\.Region"\]/);
    assert.match(app, /tableSource: t => `v_\$\{t\.name\}`/);
    assert.match(await read("AGENTS.md"), /- `fct_sales` ← `mart\.fct_sales`/);
    execFileSync(process.execPath, ["--check", join(outDir, "site/app.js")]);

    const config = { apiUrl: "https://backend", publishableKey: "pk-1", workspaceId: WS, itemId: "item" };
    const files = await buildDist(outDir, config, "20261028-120000");
    assert.deepEqual(JSON.parse(files.get("rayfin.config.json")), config);
    assert.match(files.get("index.html").toString(), /import \{ start \} from "\.\/app\.js\?v=20261028-120000"/);
    assert.match(files.get("index.html").toString(), /href="\.\/explore\/explore\.css\?v=20261028-120000"/);
    assert.match(files.get("index.html").toString(), /build 20261028-120000/);
    assert.match(files.get("explore/explore.js").toString(), /from '\.\/draw\.js\?v=20261028-120000'/);
    assert.match(files.get("explore/explore.js").toString(), /from '\.\.\/paths\.js\?v=20261028-120000'/);
    assert.ok(!files.has("dist/index.html"), "the paths are the site's, at the zip root");
    assert.equal(await read("dist/rayfin.config.json"), files.get("rayfin.config.json").toString());
    const back = unzip(zip(files));
    assert.ok(back.get("app.js").equals(files.get("app.js")));

    // Exported again: the same folder is rewritten, what is not the export's stays.
    await writeFile(join(outDir, "notes.md"), "mine");
    await writeFile(join(outDir, MARKER), JSON.stringify({ ...marker, itemId: "item", redirects: ["https://x.webapp.fabricapps.net"] }));
    const again = await writeExport({ plan, text: OSSIE, state: null, outDir, ...dirs });
    assert.equal(again.itemId, "item");
    assert.equal(await read("notes.md"), "mine");
    assert.match(await read("rayfin/rayfin.yml"), /- https:\/\/x\.webapp\.fabricapps\.net/);
    assert.match(await read("site/app.js"), /const FIRST = null;/);

    // A folder that is someone else's is not touched.
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "x.txt"), "x");
    await assert.rejects(writeExport({ plan, text: OSSIE, state, outDir: other, ...dirs }), /not written by Export to Fabric/);
    assert.deepEqual(await readdir(other), ["x.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

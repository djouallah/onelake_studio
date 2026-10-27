// report.js: Generate Report — an Ossie model's lakehouse and chart, and the folder written
// from the template. The compiler is faked (the suite runs without vendor/); semantic.js's
// lakehousesOf, starterChart and isOssie are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { planReport, generateReport, chartQuery, rayfinYml } = require("../src/report.js");
const semantic = await import("../app/semantic.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const LH = "11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const doc = {
  version: "0.2.0.dev0", name: "Sales Model", description: "Sales over the sales lakehouse. More words.",
  datasets: [
    { name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }, { name: "region_id" }] },
    { name: "dim_region", source: "dim_region", fields: [{ name: "region_id" }, { name: "Region" }] },
  ],
  metrics: [{ name: "Revenue", description: "Sum of amount. Always." }],
};
const bimOf = url => ({ model: { expressions: [{ name: "DirectLake", kind: "m",
  expression: ["let", `    Source = AzureStorage.DataLake("${url}", [HierarchicalNavigation=true])`, "in", "    Source"] }] } });

// A dax-sql Model, as far as starterChart reads one.
function fakeModel() {
  const fct = { name: "fct_sales", hidden: false, columns: [{ name: "amount", type: "double" }] };
  const dim = { name: "dim_region", hidden: false, columns: [{ name: "region_id", type: "int" }, { name: "Region", type: "string" }] };
  return {
    measures: new Map([["revenue", { name: "Revenue", table: fct }]]),
    tables: new Map([["fct_sales", fct], ["dim_region", dim]]),
    state: () => ({}),
    reaches: (from, to) => from === dim && to === fct,
  };
}
const mods = (bim, model = fakeModel()) => ({
  semantic,
  compiler: { parseYaml: () => doc, ossieToTmsl: () => bim, tmslToModel: () => model, createCompiler: m => ({ model: m }) },
});

test("the plan: the model's lakehouse is its catalog, its first measure by a text column the chart", () => {
  const plan = planReport(OSSIE, "sales.yaml", mods(bimOf(`https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`)));
  assert.equal(plan.name, "sales-model");
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.deepEqual(plan.chart, { measure: "Revenue", column: { table: "dim_region", name: "Region" } });
  assert.deepEqual(chartQuery(plan.chart), {
    select: { Region: "dim_region.Region", Revenue: "Revenue" }, orderBy: [["Revenue", "desc"]], top: 20 });
  assert.equal(plan.warnings.length, 1, "dim_region's source has no schema");
  assert.match(plan.warnings[0], /dim_region/);
});

test("the plan refuses a model with no lakehouse, two, no metric, or that is not Ossie", () => {
  const url = `https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`;
  assert.throws(() => planReport(OSSIE, "m.yaml", mods(bimOf("https://onelake.dfs.fabric.microsoft.com/{WS_ID}/{LH_ID}"))),
    /names no lakehouse/);
  const two = bimOf(url);
  two.model.expressions.push({ name: "Other", expression: `AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${WS}")` });
  assert.throws(() => planReport(OSSIE, "m.yaml", mods(two)), /names 2 lakehouses/);
  const empty = { ...fakeModel(), measures: new Map() };
  assert.throws(() => planReport(OSSIE, "m.yaml", mods(bimOf(url), empty)), /no metric/);
  assert.throws(() => planReport("version: 2\nmodels: []\n", "schema.yml", mods(bimOf(url))), /not an Apache Ossie model/);
});

test("a measure alone is the chart when no column slices it", () => {
  const model = fakeModel();
  model.reaches = () => false;
  const plan = planReport(OSSIE, "m.yaml", mods(bimOf(`https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`), model));
  assert.equal(plan.chart.column, null);
  assert.deepEqual(chartQuery(plan.chart), { select: { Revenue: "Revenue" } });
});

const RAYFIN_YML = `id: iceberg
name: iceberg
version: 1.0.0
services:
  auth:
    allowedRedirectUris:
      - http://localhost:5173
      - https://sonic-bay-be8d87ef81-eastus.webapp.fabricapps.net
      - https://rocky-knoll-c08f726642-australiasoutheast.webapp.fabricapps.net
  staticHosting:
    buildCommand: node duckdb.mjs && node ../common/build.mjs
secrets:
  - name: CATALOG_URL
`;

test("rayfin.yml: the app's own id, the self-contained build, none of the template's deployments", () => {
  const y = rayfinYml(RAYFIN_YML, "sales-model");
  assert.match(y, /^id: sales-model$/m);
  assert.match(y, /^name: sales-model$/m);
  assert.match(y, /buildCommand: node duckdb\.mjs && node build\.mjs$/m);
  assert.doesNotMatch(y, /fabricapps\.net/);
  assert.match(y, /- http:\/\/localhost:5173\n/);
  assert.match(y, /- name: CATALOG_URL/);
  assert.throws(() => rayfinYml("name: x\n", "y"), /has no id/);
});

// The template's layout under vendor/gh/<PINS.reportTemplate>, one file a directory.
async function fixture(root) {
  const files = {
    "template/dashboard/fabric_app/iceberg/duckdb.mjs": "// duckdb\n",
    "template/dashboard/fabric_app/iceberg/rayfin/rayfin.yml": RAYFIN_YML,
    "template/dashboard/fabric_app/iceberg/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "template/dashboard/fabric_app/iceberg/site/storage/data.js": "// data\n",
    "template/dashboard/fabric_app/common/site/storage/auth.js": "// auth\n",
    "template/dashboard/page/storage/queue.js": "// queue\n",
    "template/dashboard/page/frontend/perflog.js": "// perflog\n",
    "template/dashboard/page/semantic/query.js": "// query\n",
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "// ossie\n",
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { templateDir: join(root, "template"), daxSqlDir: join(root, "daxsql") };
}

test("the folder: the template's app, the generated page, and its scripts parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-"));
  try {
    const dirs = await fixture(root);
    const plan = planReport(OSSIE, "sales.yaml", mods(bimOf(`https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`)));
    const outDir = join(root, "out", plan.name);
    const r = await generateReport({ plan, text: OSSIE, outDir, ...dirs });
    assert.equal(r.dir, outDir);
    assert.equal(r.chart, "Revenue by dim_region[Region]");
    const read = p => readFile(join(outDir, p), "utf8");
    for (const p of ["duckdb.mjs", "rayfin/functions/src/function_app.ts", "site/storage/data.js",
                     "site/storage/auth.js", "site/storage/queue.js", "site/frontend/perflog.js",
                     "site/semantic/query.js", "site/semantic/dax-sql/index.js",
                     "site/semantic/dax-sql/dialects/duckdb.js", "site/semantic/formats/ossie.js",
                     "site/semantic/formats/tmsl.js", ".gitignore"]) {
      await read(p);
    }
    assert.equal(await read("model/ossie.yaml"), OSSIE);
    assert.match(await read("rayfin/rayfin.yml"), /^id: sales-model$/m);
    const app = await read("site/app.js");
    assert.match(app, /"Region": "dim_region\.Region"/);
    assert.match(app, /"Revenue": "Revenue"/);
    assert.match(await read("site/index.html"), /<h2>Revenue by Region<\/h2>/);
    assert.match(await read("deploy.mjs"), new RegExp(`iceberg/${WS}/${LH}`));
    assert.match(await read("AGENTS.md"), /- `Revenue` — Sum of amount\./);
    const pkg = JSON.parse(await read("package.json"));
    assert.equal(pkg.name, "sales-model");
    assert.equal(pkg.scripts.build, "node duckdb.mjs && node build.mjs");
    // The generated scripts are JavaScript: their escapes survived the template literals.
    for (const p of ["build.mjs", "deploy.mjs", "site/app.js"]) execFileSync(process.execPath, ["--check", join(outDir, p)]);

    await assert.rejects(generateReport({ plan, text: OSSIE, outDir, ...dirs }), /already exists and is not empty/);
    assert.ok((await readdir(outDir)).includes("AGENTS.md"), "a refused second run leaves the first alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

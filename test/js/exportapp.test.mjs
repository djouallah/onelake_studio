// exportapp.js: Export to Fabric — the plan (a OneLake file, one lakehouse, schema.table
// sources), the local copy, one zip of fabric_app/, Studio's Explore and the Report (a Vite project), the upload
// (the page as Vite built it, with the project's site/public/), and the zip format itself. The app runs on the model as exported:
// the file holds it (model.yaml) and the site its JSON (model.json). The compiler is faked (the suite runs without vendor/); semantic.js's
// lakehousesOf and isOssie are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { planExport, modelDoc, appFiles, readApp, writeApp, unzip, staticFiles, siteBuild, sizeOf, buildDist, zip, crc32, rayfinYml,
        appName, dfsUrl, MARKER, REPORT, fingerprint, localChanges, SITE, CONFIG, DEPLOYMENTS, FABRICATOR_RECORD, FORMAT,
        setStatic, setPage, pageChanges, oldLayout, setSecrets, setDeployment, workspaceKey, PROJECT_PACKAGES, SITE_DEV_PACKAGES, sitePackage,
        sitePackages, projectPackages, RAYFIN_RANGE } = require("../../fabric_app/export/exportapp.js");
const semantic = await import("../../page/semantic.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const LH = "11111111-2222-3333-4444-555555555555";
const URL_ = `https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}`;
const OSSIE = "version: 0.3.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const WHERE = { workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/ossie.yaml" };
const doc = (over = {}) => ({
  version: "0.3.0.dev0", name: "Sales Model",
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

test("the plan: the model's name, the lakehouse's catalog, where its model is", () => {
  const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
  assert.equal(plan.name, "sales-model");
  assert.equal(plan.modelName, "sales");
  assert.equal(plan.workspace, WS);
  assert.equal(plan.lakehouse, LH);
  assert.equal(plan.catalogUrl, `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/${LH}`);
  assert.equal(plan.modelUrl, undefined, "the app runs on its own copy: nothing reads the lakehouse's file");
  assert.equal(plan.modelPath, "power bi/nem.Lakehouse/Files/semantic_model/ossie.yaml");
  assert.deepEqual(plan.tables, [["fct_sales", "mart.fct_sales"], ["dim_region", "mart.dim_region"]]);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.doc, undefined, "the plan carries no model to write");
  assert.equal(appName("2024 Sales"), "m-2024-sales");
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
  const partition = source => ({ nonportable_extensions: [{ vendor_name: "POWER_BI", data: { partitions: [{ name: "p", source }] } }] });
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
  const partition = source => [{ vendor_name: "POWER_BI", data: { partitions: [{ source }] } }];
  // A file of the Ossie spec before: custom_extensions, their data a JSON string.
  const before = source => [{ vendor_name: "POWER_BI", data: JSON.stringify({ partitions: [{ source }] }) }];
  for (const read of [await copy("fabric_app/site/src/storage/data.js"), await copy("fabric_app/export/exportapp.js")]) {
    assert.equal(read({ source: "x", nonportable_extensions: partition({ entityName: "x" }) }), "dbo.x");
    assert.equal(read({ source: "mart.x", nonportable_extensions: partition({ entityName: "x", schemaName: "mart" }) }), "mart.x");
    assert.equal(read({ source: "Time Calc", nonportable_extensions: partition({ type: "calculationGroup" }) }), null);
    assert.equal(read({ source: "mart.x", custom_extensions: before({ entityName: "x", schemaName: "mart" }) }), "mart.x");
    assert.equal(read({ source: "Time Calc", custom_extensions: before({ type: "calculationGroup" }) }), null);
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
  assert.doesNotMatch(y, /^connectors:/m, "no connector");
});

async function fixture(root) {
  const files = {
    "fabric_app/site/index.html": '<link rel="stylesheet" href="./src/explore/explore.css">\n<script type="module" src="./src/main.js"></script>\n<footer>build __BUILD__</footer>\n',
    "fabric_app/site/src/main.js": 'import { start } from "./app.js";\nstart();\n',
    "fabric_app/site/src/app.js": 'import { mountExplore } from "./explore/view.js";\nconst source = await import("./storage/data.js");\n',
    "fabric_app/site/src/storage/data.js": 'import { renderModel } from "../explore/model.js";\n',
    "fabric_app/site/src/storage/catalog.js": "// catalog\n",
    "fabric_app/site/src/storage/auth.js": "// auth\n",
    "fabric_app/rayfin/rayfin.yml": "id: explore\nname: explore\nservices:\n  auth:\n    allowedRedirectUris:\n      - http://localhost:5173\n",
    "fabric_app/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "fabric_app/rayfin/functions/runtimemetadata.json": '{ "functions": [] }\n',
    "fabric_app/project/validate-report.mjs": "// validate\n",
    "fabric_app/project/gitignore": "node_modules\n",
    "fabric_app/project/gitattributes": "* text=auto eol=lf\n",
    "fabric_app/project/vite.config.mjs": "export default {};\n",
    "fabric_app/project/package-lock.json": JSON.stringify({ name: "fabric-app", lockfileVersion: 3,
      packages: { "": { name: "fabric-app" }, site: { name: "fabric-app-site" }, "node_modules/fabric-app-site": { resolved: "site", link: true }, "node_modules/@duckdb/duckdb-wasm": {} } }),
    "agent-files.json": JSON.stringify({ ".agents/skills/rayfin/SKILL.md": "# rayfin\n", ".mcp.json": "{}\n", "rayfin/.lockfile.json": "{}\n" }),
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "import { tmslToModel } from './tmsl.js';\n",
    "page/explore/view.js": "import { renderModel } from './model.js';\nimport { escapeHtml } from '../paths.js';\n",
    "page/explore/explore.js": "// explore\n", "page/explore/model.js": "// model\n",
    "page/explore/explore.css": "/* css */\n", "page/paths.js": "// paths\n",
    // What npm has not (vendor/webapp), and the page as Vite built it (fabric-site/, with its pins.json).
    "webapp/world.json": "{}\n",
    "webapp/duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm": "x".repeat(2048),
    "fabric-site/index.html": '<script type="module" src="./assets/index-abc.js"></script>\n<footer>build __BUILD__</footer>\n',
    "fabric-site/assets/index-abc.js": "// the page, built\n",
    "fabric-site/assets/duckdb-base-def.wasm": "w".repeat(4096),
    "fabric-site/pins.json": '{"source":"abc"}',
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { fabricAppDir: join(root, "fabric_app"), daxSqlDir: join(root, "daxsql"), appDir: join(root, "page"),
           webappDir: join(root, "webapp"), siteDir: join(root, "fabric-site"), agentFiles: join(root, "agent-files.json") };
}

// The zip's entries, read back through its central directory: path -> bytes.
test("the zip: every entry at the root, deflated, read back byte for byte", async () => {
  const files = new Map([["index.html", Buffer.from("<!doctype html>")], ["a/b.js", Buffer.from("x".repeat(5000))],
                         ["é.txt", Buffer.alloc(0)]]);
  const back = unzip(await zip(files));
  assert.deepEqual([...back.keys()], ["index.html", "a/b.js", "é.txt"]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("the app's files: its DuckDB data source and packages, its own model, and what the page was built from", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-model-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    await assert.rejects(appFiles({ plan, state: null, ...dirs }), /needs the model it runs on/);
    const model = modelDoc(OSSIE, "sales.yaml", mods(bimOf(URL_))).doc;
    const { WEBAPP } = require("../../core/vendored.js");
    const duck = await appFiles({ plan, state: null, model, modelText: OSSIE, modelFile: "sales.yaml", ...dirs });
    for (const p of ["site/src/storage/data.js", "site/src/storage/catalog.js", "site/src/storage/auth.js", "site/src/app.js", "site/src/explore/view.js", "site/index.html"]) {
      assert.ok(duck.has(p), p);
    }
    assert.ok(![...duck.keys()].some(f => /duckdb-ext\//.test(f)), "no site files yet (setStatic)");
    // settings.json always: the hosting answers a file a site lacks with its index.html.
    assert.deepEqual(JSON.parse(duck.get("site/public/settings.json")), {});
    assert.deepEqual(JSON.parse((await appFiles({ plan, state: null, model, maxRows: 5000, ...dirs })).get("site/public/settings.json")), { maxRows: 5000 });
    assert.deepEqual(JSON.parse(duck.get("site/package.json")).dependencies, {
      "@duckdb/duckdb-wasm": WEBAPP.duckdbWasm.split("@").pop(), "@microsoft/rayfin-auth-provider-fabric": RAYFIN_RANGE,
      "@microsoft/rayfin-client": RAYFIN_RANGE, "apache-arrow": WEBAPP.arrow.split("@").pop(), echarts: WEBAPP.echarts.split("@").pop() });
    assert.ok(JSON.parse(duck.get("package-lock.json")).packages["node_modules/@duckdb/duckdb-wasm"], "the project's lock file");
    // The app runs on its own model: the file's model.yaml, and the site's model.json made from it.
    assert.equal(duck.get("model.ossie.yaml").toString(), OSSIE);
    assert.deepEqual(JSON.parse(duck.get("site/public/model.json")), model);
    assert.doesNotMatch(duck.get("rayfin/rayfin.yml").toString(), /^connectors:/m);
    assert.match(duck.get("AGENTS.md").toString(), /app item's owner/);
    assert.match(duck.get("AGENTS.md").toString(), /`model\.ossie\.yaml` in this file[\s\S]*the app\s+runs on it/);
    assert.match(duck.get("AGENTS.md").toString(), /OneLake Studio publishes its own build of the page/);
    assert.match(duck.get("AGENTS.md").toString(), /`TABLES` setting\), and never reads the model/);
    assert.doesNotMatch(duck.get("AGENTS.md").toString(), /onModel|undefined|semantic model/i);
    assert.deepEqual([...(await staticFiles(dirs.webappDir)).keys()].sort(), ["duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm", "world.json"]);
    assert.deepEqual([...(await siteBuild(dirs.siteDir)).keys()].sort(), ["assets/duckdb-base-def.wasm", "assets/index-abc.js", "index.html"], "the page, and not its pins");
    await assert.rejects(siteBuild(join(root, "nowhere")), /has no page for the app[\s\S]*site-bundle\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local copy is one zip: the whole project, written and read back; the upload is the page as Vite built it, stamped, with the site's own files", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-"));
  try {
    const dirs = await fixture(root);
    const plan = planExport(OSSIE, "sales.yaml", "sales", mods(bimOf(URL_)), WHERE);
    const state = { v: 2, rows: ["dim_region.Region"], cols: [], values: ["Revenue"], filters: [], mark: "bar" };
    const files = await appFiles({ plan, state, model: doc(), modelText: OSSIE, modelFile: "ossie.yaml",
                                   redirects: ["https://x.webapp.fabricapps.net"], ...dirs });
    for (const p of ["site/index.html", "site/src/main.js", "site/src/app.js", "site/src/storage/data.js", "site/src/storage/catalog.js",
                     "site/src/explore/view.js", "site/src/explore/model.js", "site/src/explore/explore.css", "site/src/paths.js",
                     "site/src/semantic/src/dialects/duckdb.js", "site/src/semantic/formats/ossie.js", "site/public/report.json",
                     "site/package.json", "site/vite.config.mjs",
                     "rayfin/functions/src/function_app.ts", "AGENTS.md", "model.ossie.yaml", "site/public/model.json"]) {
      assert.ok(files.has(p), p);
    }
    assert.ok(![...files.keys()].filter(p => p !== "model.ossie.yaml").some(p => /vendor\/|node_modules|ossie\.(json|yaml)$|^model\/|dist\//.test(p)),
      `no packages, no build, no model but model.ossie.yaml: ${[...files.keys()].join(", ")}`);
    // Only the app's own files are in site/public/, which Vite copies as it is: no script of the page.
    assert.deepEqual([...files.keys()].filter(p => p.startsWith(SITE)).sort(),
      ["site/public/explore.json", "site/public/model.json", "site/public/report.json", "site/public/settings.json"]);
    assert.ok(!oldLayout(files));
    // The project around it, as the Rayfin CLI's template has one: Fabricator installs it and runs its Vite.
    const pkg = JSON.parse(files.get("package.json"));
    assert.equal(pkg.name, "sales-model");
    assert.deepEqual(pkg.workspaces, ["site", "rayfin/functions"]);
    assert.equal(pkg.scripts.dev, "rayfin dev");
    assert.equal(pkg.scripts.build, "npm run build -w site");
    assert.deepEqual(pkg.devDependencies, PROJECT_PACKAGES);
    // The page's packages are the page's own (site/package.json), but Arrow, which the project names too: the one
    // copy DuckDB-WASM and the page share.
    assert.deepEqual(pkg.dependencies, { "apache-arrow": require("../../core/vendored.js").WEBAPP.arrow.split("@").pop() });
    assert.deepEqual(pkg.dependencies, projectPackages());
    // The page's packages, the ones it imports and Vite bundles: Fabricator's check wants the Fabric sign-in package named.
    const sitePkg = JSON.parse(files.get("site/package.json"));
    assert.equal(sitePkg.name, "fabric-app-site", "every app's the same: the lock file names it");
    assert.deepEqual(sitePkg.scripts, { dev: "vite", build: "vite build", "build:fabric": "vite build" });
    assert.deepEqual(sitePkg.dependencies, sitePackages());
    assert.deepEqual(sitePkg.devDependencies, SITE_DEV_PACKAGES);
    // Every Rayfin package on one ~X.Y.0 line, as the CLI's templates have them and Fabricator's checks ask.
    const { WEBAPP } = require("../../core/vendored.js");
    const [major, minor] = WEBAPP.rayfinClient.split("@").pop().split(".");
    assert.equal(RAYFIN_RANGE, `~${major}.${minor}.0`);
    for (const [name, v] of Object.entries({ ...sitePkg.dependencies, ...sitePkg.devDependencies, ...pkg.devDependencies })) {
      if (name.startsWith("@microsoft/rayfin-")) assert.equal(v, RAYFIN_RANGE, name);
      else assert.match(v, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `${name} is pinned`);
    }
    // The Report's checker, for an agent to run after an edit, and what AGENTS.md says of it.
    assert.equal(pkg.scripts.validate, "node scripts/validate-report.mjs");
    assert.equal(files.get("scripts/validate-report.mjs").toString(), "// validate\n");
    assert.match(files.get("AGENTS.md").toString(), /run `npm run validate`/);
    assert.match(files.get("AGENTS.md").toString(), /npm run validate -- --fields/);
    // The function's metadata as rayfin-local writes it, with no newline at its end: Fabricator sees no change.
    assert.equal(files.get("rayfin/functions/runtimemetadata.json").toString(), '{ "functions": [] }');
    // Rayfin's agent files, as the CLI writes them: what Fabricator's ai-files check looks for.
    assert.equal(files.get(".agents/skills/rayfin/SKILL.md").toString(), "# rayfin\n");
    assert.ok(files.has(".mcp.json") && files.has("rayfin/.lockfile.json"));
    // The lock file, named for the app: npm installs what it names and resolves nothing.
    const lock = JSON.parse(files.get("package-lock.json"));
    assert.equal(lock.name, "sales-model");
    assert.equal(lock.packages[""].name, "sales-model");
    // A workspace's package is in the lock by its name: the page's own package.json must say the same one.
    assert.equal(lock.packages.site.name, sitePkg.name);
    assert.deepEqual(lock.packages[`node_modules/${sitePkg.name}`], { resolved: "site", link: true });
    assert.equal(files.get(".gitignore").toString(), "node_modules\n");
    assert.equal(files.get(".gitattributes").toString(), "* text=auto eol=lf\n");
    assert.equal(files.get("site/vite.config.mjs").toString(), "export default {};\n");
    assert.deepEqual(JSON.parse(files.get("site/public/explore.json")), state);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /^id: sales-model$/m);
    assert.match(files.get("rayfin/rayfin.yml").toString(), /- https:\/\/x\.webapp\.fabricapps\.net/);
    const agents = files.get("AGENTS.md").toString();
    assert.match(agents, /- `fct_sales` ← `mart\.fct_sales`/);
    assert.match(agents, /power bi\/nem\.Lakehouse\/Files\/semantic_model\/ossie\.yaml/);
    assert.match(agents, /## The Report: yours to grow[\s\S]*`site\/public\/report\.json`[\s\S]*no tile holds SQL/);
    assert.match(agents, /the page is a Vite project in `site\/`/);
    assert.doesNotMatch(agents, /This file is a zip|site\/public\/(app\.js|storage|explore|semantic|vendor)/);
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

    // The upload: the page as Vite built it, its index.html stamped; site/public/ as it is; the backend's config.
    setStatic(files, await staticFiles(dirs.webappDir));
    assert.ok(files.has("site/public/world.json") && files.has("site/public/duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm"));
    const page = await siteBuild(dirs.siteDir);
    const size = sizeOf(page);
    assert.equal(size.total, [...page.values()].reduce((n, b) => n + b.length, 0));
    assert.deepEqual(size.parts.map(([n]) => n), ["assets/", "index.html"], "largest first");
    const config = { apiUrl: "https://backend", publishableKey: "pk-1", workspaceId: WS, itemId: "item" };
    const up = buildDist(files, config, page, "20261028-120000");
    assert.deepEqual([...up.keys()], ["assets/duckdb-base-def.wasm", "assets/index-abc.js", "duckdb-ext/v2.0.0/wasm_eh/icu.duckdb_extension.wasm",
      "explore.json", "index.html", "model.json", "rayfin.config.json", "report.json", "settings.json", "world.json"],
      "what `npm run build` makes of the project: the build, and site/public/ copied as it is");
    assert.deepEqual(JSON.parse(up.get("rayfin.config.json")), config);
    assert.match(up.get("index.html").toString(), /build 20261028-120000/);
    assert.match(up.get("index.html").toString(), /src="\.\/assets\/index-abc\.js"/, "the built page, never the project's index.html");
    assert.ok(up.get("assets/duckdb-base-def.wasm").equals(page.get("assets/duckdb-base-def.wasm")), "the build ships byte for byte");
    assert.ok(up.get("report.json").equals(files.get(REPORT)));
    assert.throws(() => buildDist(files, config, new Map()), /published with its page built/);
    assert.ok(unzip(await zip(up)).get("assets/index-abc.js").equals(up.get("assets/index-abc.js")));
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
    edited.set("site/src/app.js", Buffer.from("// an agent's edit"));
    edited.set("site/src/chart.js", Buffer.from("new"));
    edited.delete("AGENTS.md");
    // The model the app runs on is one of its files: an edit to it is a local change, published As Is.
    edited.set("model.yaml", Buffer.from("version: 1\ndatasets: []\n"));
    assert.deepEqual(localChanges(edited, marker), ["AGENTS.md", "model.yaml", "site/src/app.js", "site/src/chart.js"]);

    // The page's code is what OneLake Studio cannot build: a change to it is named, and nothing else is.
    assert.deepEqual(pageChanges(first, marker, first), []);
    assert.deepEqual(pageChanges(edited, marker, first), ["site/src/app.js", "site/src/chart.js"], "not the model, the Report or AGENTS.md");
    const gone = new Map(first);
    gone.delete("site/src/main.js");
    assert.deepEqual(pageChanges(gone, marker, first), ["site/src/main.js"], "a script taken out");
    assert.deepEqual(pageChanges(edited, {}, first), [], "a record with no hashes says nothing");
    // A file an earlier build wrote, untouched since: its page is that build's, not a person's change.
    const earlier = new Map(first);
    earlier.set("site/src/app.js", Buffer.from("// an earlier build's app.js"));
    earlier.set("package-lock.json", Buffer.from("{}"));
    assert.deepEqual(pageChanges(earlier, { files: fingerprint(earlier) }, first), []);
    // This build's page over it: every page entry this build's, and the app's own files kept.
    earlier.set(REPORT, mine);
    setPage(earlier, first);
    assert.ok(earlier.get("site/src/app.js").equals(first.get("site/src/app.js")) && earlier.get("package-lock.json").equals(first.get("package-lock.json")));
    assert.equal(earlier.get(REPORT), mine);

    // An earlier export's layout, its page in site/public/ with its packages: this build's page replaces it,
    // and what is uploaded never holds its scripts.
    const old = new Map([["site/public/index.html", Buffer.from("old")], ["site/public/app.js", Buffer.from("old")],
      ["site/public/storage/data.js", Buffer.from("old")], ["site/public/explore/view.js", Buffer.from("old")],
      ["site/public/semantic/src/index.js", Buffer.from("old")], ["site/public/paths.js", Buffer.from("old")],
      ["site/public/vendor/npm/x@1/+esm.js", Buffer.from("old")], ["site/vite.config.mjs", Buffer.from("old")],
      ["package.json", Buffer.from("{}")], [REPORT, mine], ["site/public/model.json", Buffer.from("{}")], ["AGENTS.md", Buffer.from("old")]]);
    assert.ok(oldLayout(old));
    const oldMarker = { files: fingerprint(old) };
    assert.ok(!("site/public/vendor/npm/x@1/+esm.js" in oldMarker.files), "its packages were never recorded");
    assert.deepEqual(pageChanges(old, oldMarker, first), [], "as the export wrote it");
    old.set("site/public/app.js", Buffer.from("// a person's edit"));
    assert.deepEqual(pageChanges(old, oldMarker, first), ["site/public/app.js"]);
    const up = buildDist(old, {}, new Map([["index.html", Buffer.from("built")]]), "b");
    assert.deepEqual([...up.keys()], ["index.html", "model.json", "rayfin.config.json", "report.json"]);
    assert.equal(up.get("index.html").toString(), "built");
    setPage(old, first);
    assert.ok(!oldLayout(old));
    assert.deepEqual([...old.keys()].filter(p => p.startsWith(SITE)).sort(), ["site/public/model.json", "site/public/report.json"]);
    assert.ok(old.get("site/index.html").equals(first.get("site/index.html")) && old.has("site/src/app.js") && old.has("site/package.json"));
    assert.equal(old.get("AGENTS.md").toString(), "old", "not the page: the export's own to write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped page and its data source parse; the page reads its model from the site, and the function reads none", async () => {
  // (blockcache.js is a worker's script, not a module: checked as one.)
  for (const p of ["page/explore/report.js", "fabric_app/site/src/storage/catalog.js", "fabric_app/site/src/storage/blockcache.js",
                   "fabric_app/site/src/site.js"]) {
    execFileSync(process.execPath, ["--check", new URL(`../../${p}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
  }
  // Every module the page's own files import is one an export writes (appFiles): the site's, the
  // page's explore/ and paths.js, or dax-sql's src/ and formats/ under semantic/; or a package the
  // project names (site/package.json), which Vite bundles. Anything else fails the build.
  const srcDir = new URL("../../fabric_app/site/src/", import.meta.url);
  const there = async u => readFile(u).then(() => true, () => false);
  const named = new Set(Object.keys(sitePackages()));
  const imported = new Set();
  for (const rel of await readdir(srcDir, { recursive: true })) {
    const p = rel.replace(/\\/g, "/");
    if (!p.endsWith(".js")) continue;
    const s = await readFile(new URL(p, srcDir), "utf8");
    // Code only: a comment's own words are not an import.
    const code = s.split(/\r?\n/).filter(l => !l.trim().startsWith("//")).join("\n");
    for (const [, asked] of code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'\s]+)["']/g)) {
      const spec = asked.replace(/\?url$/, "");
      if (!spec.startsWith(".")) {
        const pkg = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
        assert.ok(named.has(pkg), `${p} imports ${spec}, a package site/package.json does not name`);
        imported.add(pkg);
        continue;
      }
      const to = new URL(spec, new URL(p, "http://site/")).pathname.slice(1);
      const ok = /^semantic\/(src\/[\w./-]+|formats\/(tmsl|ossie|ossie-sql))\.js$/.test(to)
        || (to === "paths.js" || to.startsWith("explore/")
          ? await there(new URL(`../../page/${to}`, import.meta.url)) : await there(new URL(to, srcDir)));
      assert.ok(ok, `${p} imports ${spec}, which no export writes`);
    }
  }
  assert.deepEqual([...imported].sort(), [...named].sort(), "every package the project names is one the page imports");
  // Nothing the page runs is loaded from elsewhere: its packages are npm's, bundled, at the pins.
  const { WEBAPP, VENDOR } = require("../../core/vendored.js");
  const site = async p => readFile(new URL(`../../fabric_app/site/${p}`, import.meta.url), "utf8");
  for (const p of ["src/app.js", "src/storage/data.js", "src/storage/results.js", "src/storage/auth.js", "src/storage/blockcache.js", "index.html"]) {
    assert.doesNotMatch(await site(p), /cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|extensions\.duckdb\.org|getJsDelivrBundles|vendor\/npm/, `${p} loads nothing remote, and no vendored copy`);
  }
  assert.match(await site("index.html"), /<script type="module" src="\.\/src\/main\.js"><\/script>/);
  assert.match(await site("index.html"), /href="\.\/src\/explore\/explore\.css"/);
  const data = await site("src/storage/data.js");
  assert.match(data, /import \* as duckdb from "@duckdb\/duckdb-wasm";/);
  assert.match(data, /from "@duckdb\/duckdb-wasm\/dist\/duckdb-base\.wasm\?url";/);
  assert.match(data, /from "@duckdb\/duckdb-wasm\/dist\/duckdb-browser-base\.worker\.js\?url";/);
  assert.match(data, /from "\.\/blockcache\.js\?url";/, "the store's script, a file of its own a worker loads");
  assert.ok(data.includes(`const DUCKDB = '${WEBAPP.duckdb}';`));
  assert.ok(data.includes(`const EXTENSIONS = ${JSON.stringify(WEBAPP.extensions).replace(/"/g, "'").replace(/,/g, ", ")};`));
  assert.match(data, /const EXT_REPO = siteUrl\('duckdb-ext'\);/, "DuckDB's extensions, the site's own files");
  assert.match(await site("src/storage/results.js"), /from "apache-arrow";/);
  // The Fabric provider is imported as the page starts, never when sign-in is first asked for.
  const auth = await site("src/storage/auth.js");
  assert.match(auth, /^import \{[^}]*\} from "@microsoft\/rayfin-client";$/m);
  assert.match(auth, /^import \{[^}]*\} from "@microsoft\/rayfin-auth-provider-fabric";$/m);
  assert.doesNotMatch(auth, /\bimport\s*\(/, "no dynamic import of the SDK");
  assert.match(await site("src/app.js"), /import\("echarts"\)/);
  assert.match(await site("src/app.js"), /siteUrl\("world\.json"\)/);
  assert.deepEqual(VENDOR.webapp.files.map(f => f.to), ["world.json"]);
  assert.ok(VENDOR.webapp.extensions.names.includes("parquet"));
  assert.doesNotMatch(data, /ossie\.json/);
  assert.match(data, /catalog\.open\(\)/);
  assert.match(data, /siteUrl\('model\.json'\)/, "the model is the site's own");
  assert.doesNotMatch(data, /timeZone|SET TimeZone/, "no session time zone the page never passes");
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

test("the site's files npm has not are in the file, the extension's own over the file's; the upload takes this publish's backend", async () => {
  const files = new Map([["site/index.html", Buffer.from("the project's")],
                         [`${SITE}duckdb-ext/v1.0.0/wasm_eh/old.duckdb_extension.wasm`, Buffer.from("old")],
                         [`${SITE}world.json`, Buffer.from("old")],
                         [CONFIG, Buffer.from('{"apiUrl":"https://before"}')]]);
  setStatic(files, new Map([["duckdb-ext/v2.0.0/wasm_eh/new.duckdb_extension.wasm", Buffer.from("new")], ["world.json", Buffer.from("new")]]));
  assert.ok(!files.has(`${SITE}duckdb-ext/v1.0.0/wasm_eh/old.duckdb_extension.wasm`), "an extension the extension no longer pins is gone");
  assert.equal(files.get(`${SITE}duckdb-ext/v2.0.0/wasm_eh/new.duckdb_extension.wasm`).toString(), "new");
  assert.equal(files.get(`${SITE}world.json`).toString(), "new");
  const page = new Map([["index.html", Buffer.from("<footer><span id=\"build\">build __BUILD__ · </span></footer>")]]);
  const up = buildDist(files, { apiUrl: "https://now" }, page, "20261115-120000");
  assert.deepEqual([...up.keys()], ["duckdb-ext/v2.0.0/wasm_eh/new.duckdb_extension.wasm", "index.html", "rayfin.config.json", "world.json"]);
  assert.deepEqual(JSON.parse(up.get("rayfin.config.json")), { apiUrl: "https://now" }, "this publish's backend, not the file's");
  assert.match(up.get("index.html").toString(), /build 20261115-120000/);
  // Neither those files nor the backend is a local change: every export writes them again.
  assert.deepEqual(Object.keys(fingerprint(files)), ["site/index.html"]);
});

test("the function's settings: a URL and table names, where rayfin up and a local run read them", () => {
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

// Vite rewrites `new URL(<a string>, import.meta.url)` (its vite:asset-import-meta-url plugin): the file named is
// taken for an asset of the build. The site's own files (site/public/) are read by name from the site's root
// instead (src/site.js), and a file Vite must put beside the page is imported with ?url.
test("no script of the site names a file by its module's URL", async () => {
  const VITE = /\bnew\s+URL\s*\([^)]*,\s*import\.meta\.url\s*(?:,\s*)?\)/;
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
    assert.equal(hit, -1, `${f}:${hit + 1} is a new URL(…, import.meta.url): read the site's file with siteUrl, or import it with ?url`);
  }
});

test("the project's Vite config and ignore lists ship, and rayfin.yml uploads the build", async () => {
  const vite = await readFile(new URL("../../fabric_app/project/vite.config.mjs", import.meta.url), "utf8");
  assert.match(vite, /base: '\.\/'/, "every URL relative");
  assert.match(vite, /outDir: 'dist'/);
  assert.match(vite, /rayfinLocalDev\(\)/);
  assert.doesNotMatch(vite, /publicDir: false|root:/, "site/ is the project, and site/public/ Vite's folder of files copied as they are");
  const ignore = await readFile(new URL("../../fabric_app/project/gitignore", import.meta.url), "utf8");
  for (const p of ["node_modules", "dist", "rayfin/.deployments.json", "rayfin/functions/local.settings.json", "site/public/rayfin.config.json"]) {
    assert.ok(ignore.split(/\r?\n/).includes(p), `${p} is ignored`);
  }
  assert.match(await readFile(new URL("../../fabric_app/project/gitattributes", import.meta.url), "utf8"), /^\* text=auto eol=lf$/m);
  const yml = await readFile(new URL("../../fabric_app/rayfin/rayfin.yml", import.meta.url), "utf8");
  assert.match(yml, /^  staticHosting:\n    enabled: true\n    path: site\n    folder: dist\n    buildCommand: npm run build\n/m);
  // An earlier export's rayfin.yml, published as it is: its site is the build from then on, said once.
  const was = yml.replace("    folder: dist\n    buildCommand: npm run build\n", "    folder: public\n");
  assert.notEqual(was, yml);
  const now = rayfinYml(was, "explore");
  assert.match(now, /^    path: site\n    folder: dist\n    buildCommand: npm run build\n    indexDocument/m);
  assert.equal(rayfinYml(now, "explore"), now);
  // The validator reads the page's code where the project has it.
  assert.match(await readFile(new URL("../../fabric_app/project/validate-report.mjs", import.meta.url), "utf8"), /\.\.\/site\/src\/\$\{p\}/);
});

// The lock file every project ships (scripts/fabric-lock.mjs makes it): what package.json and the function's
// ask for, from the public registry. CI's npm ci of a real export (run-fabricator-project.mjs) proves it installs.
test("the lock file is the project's packages, from the public registry", async () => {
  const fn = JSON.parse(await readFile(new URL("../../fabric_app/rayfin/functions/package.json", import.meta.url), "utf8"));
  const name = "package-lock.json";
  const lock = JSON.parse(await readFile(new URL(`../../fabric_app/project/${name}`, import.meta.url), "utf8"));
  const top = lock.packages[""];
  assert.deepEqual(top.dependencies ?? null, projectPackages(), `${name}: the project's own packages: run scripts/fabric-lock.mjs`);
  assert.deepEqual(top.devDependencies, PROJECT_PACKAGES, `${name}: the project's packages: run scripts/fabric-lock.mjs`);
  assert.deepEqual(top.workspaces, ["site", "rayfin/functions"]);
  const page = lock.packages.site;
  // The page's package as an export names it, and its link: npm ci refuses a project whose workspace the lock does not name.
  assert.equal(page.name, JSON.parse(sitePackage()).name, `${name}: the page's package by its name`);
  assert.deepEqual(lock.packages[`node_modules/${page.name}`], { resolved: "site", link: true }, `${name}: the page's link`);
  assert.equal(lock.packages["rayfin/functions"].name, fn.name, `${name}: the function's package by its name`);
  assert.deepEqual(page.dependencies, sitePackages(), `${name}: the page's packages: run scripts/fabric-lock.mjs`);
  assert.deepEqual(page.devDependencies, SITE_DEV_PACKAGES, `${name}: the page's build: run scripts/fabric-lock.mjs`);
  const ws = lock.packages["rayfin/functions"];
  assert.deepEqual(ws.dependencies, fn.dependencies, `${name}: the function's packages: run scripts/fabric-lock.mjs`);
  assert.deepEqual(ws.devDependencies, fn.devDependencies, `${name}: the function's packages: run scripts/fabric-lock.mjs`);
  const off = Object.entries(lock.packages).filter(([, p]) => p.resolved && !p.link && !p.resolved.startsWith("https://registry.npmjs.org/"));
  assert.deepEqual(off.map(([k]) => k), [], `${name}: every package from the public registry`);
  // The links: the workspaces, the page and the function.
  assert.deepEqual(Object.entries(lock.packages).filter(([, p]) => p.link).map(([, p]) => p.resolved).sort(), ["rayfin/functions", "site"]);
  assert.ok(lock.packages["node_modules/@duckdb/duckdb-wasm"], `${name}: DuckDB-WASM`);
  // One copy of each package the page's scripts share with another package: DuckDB-WASM's Arrow is the page's
  // (a table it answers must be a Table to the page's Arrow), and the Rayfin packages share one rayfin-auth.
  const copies = name_ => Object.keys(lock.packages).filter(k => k.endsWith(`node_modules/${name_}`));
  const { WEBAPP } = require("../../core/vendored.js");
  const arrows = copies("apache-arrow").filter(k => lock.packages[k].version.split(".")[0] === WEBAPP.arrow.split("@").pop().split(".")[0]);
  assert.deepEqual(arrows, ["node_modules/apache-arrow"], `${name}: one copy of DuckDB-WASM's Arrow, the page's`);
  assert.equal(lock.packages["node_modules/apache-arrow"].version, WEBAPP.arrow.split("@").pop());
  for (const k of Object.keys(lock.packages).filter(k => /node_modules\/@microsoft\/rayfin-[\w-]+$/.test(k))) {
    const pkg = k.split("node_modules/").pop();
    assert.deepEqual(copies(pkg), [`node_modules/${pkg}`], `${name}: one copy of ${pkg}`);
  }
});

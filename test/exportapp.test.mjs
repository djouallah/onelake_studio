// exportapp.js: Export to Fabric — the plan (a OneLake file, one lakehouse, schema.table
// sources), the local copy written from fabric_app/ and Studio's Explore, dist/ stamped with
// the build, and the zip that is uploaded. The model is never copied: the app reads it in
// place (MODEL_URL). The compiler is faked (the suite runs without vendor/); semantic.js's
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
const { planExport, writeExport, buildDist, zip, crc32, rayfinYml, appName, dfsUrl, MARKER,
        readMarker, fingerprint, localChanges } = require("../src/exportapp.js");
const semantic = await import("../app/semantic.js");

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

test("the plan refuses: not a OneLake Files/ file, no lakehouse, two, a name the page cannot use, a source the function cannot open", () => {
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_)), null), /not a OneLake file/);
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_)), { workspace: "w", path: "lh.Lakehouse/Tables/x" }), /not in a lakehouse's Files/);
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf("https://example.com/x")), WHERE), /names no lakehouse/);
  const two = bimOf(URL_);
  two.model.expressions.push({ name: "Other", expression: `"https://onelake.dfs.fabric.microsoft.com/${WS}/${WS}"` });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(two), WHERE), /names 2 lakehouses/);
  const spaced = doc({ datasets: [{ name: "Internet Sales", source: "mart.sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), spaced), WHERE), /letters, digits and _ only: Internet Sales/);
  const bare = doc({ datasets: [{ name: "sales", source: "sales" }] });
  assert.throws(() => planExport(OSSIE, "m.yaml", "m", mods(bimOf(URL_), bare), WHERE), /schema\.table sources only: sales \(sales\)/);
  assert.throws(() => planExport("version: 2\nmodels: []\n", "schema.yml", "m", mods(bimOf(URL_)), WHERE), /not an Apache Ossie model/);
});

test("rayfin.yml: the app's id and name, its redirects first", async () => {
  const tpl = await readFile(new URL("../fabric_app/rayfin/rayfin.yml", import.meta.url), "utf8");
  assert.match(tpl, /^    assetAccess: protected$/m, "the template's site is protected");
  assert.match(tpl, /- name: MODEL_URL/);
  assert.doesNotMatch(tpl, /fabricapps\.net/, "no deployment's own redirect");
  const y = rayfinYml(tpl, "sales-model-explore", ["https://x-eastus.webapp.fabricapps.net"]);
  assert.match(y, /^id: sales-model-explore$/m);
  assert.match(y, /^name: sales-model-explore$/m);
  assert.match(y, /allowedRedirectUris:\n      - https:\/\/x-eastus\.webapp\.fabricapps\.net\n      - http:\/\/localhost:5173\n/);
  assert.throws(() => rayfinYml("name: x\n", "y"), /has no id/);
});

async function fixture(root) {
  const files = {
    "fabric_app/site/index.html": '<link rel="stylesheet" href="./explore/explore.css">\n<script type="module">import { start } from "./app.js"; start();</script>\n<footer>build __BUILD__</footer>\n',
    "fabric_app/site/app.js": 'import { mountExplore } from "./explore/view.js";\n',
    "fabric_app/site/storage/data.js": 'import { perf } from "../explore/perflog.js";\n',
    "fabric_app/site/storage/catalog.js": "// catalog\n",
    "fabric_app/rayfin/rayfin.yml": "id: explore\nname: explore\nservices:\n  auth:\n    allowedRedirectUris:\n      - http://localhost:5173\n",
    "fabric_app/rayfin/functions/src/function_app.ts": "// openCatalog\n",
    "daxsql/src/index.js": "// dax-sql\n",
    "daxsql/src/dialects/duckdb.js": "// dialect\n",
    "daxsql/formats/tmsl.js": "// tmsl\n",
    "daxsql/formats/ossie.js": "import { tmslToModel } from './tmsl.js';\n",
    "app/explore/view.js": "import { renderModel } from './model.js';\nimport { escapeHtml } from '../paths.js';\n",
    "app/explore/explore.js": "// explore\n", "app/explore/model.js": "// model\n", "app/explore/perflog.js": "// perflog\n",
    "app/explore/explore.css": "/* css */\n", "app/paths.js": "// paths\n",
  };
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  return { fabricAppDir: join(root, "fabric_app"), daxSqlDir: join(root, "daxsql"), appDir: join(root, "app") };
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
                     "site/explore/view.js", "site/explore/perflog.js", "site/explore/explore.css", "site/paths.js",
                     "site/semantic/dax-sql/dialects/duckdb.js", "site/semantic/formats/ossie.js",
                     "rayfin/functions/src/function_app.ts", ".gitignore", MARKER]) {
      await read(p);
    }
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
    assert.match(files.get("explore/view.js").toString(), /from '\.\.\/paths\.js\?v=20261028-120000'/);
    assert.match(files.get("storage/data.js").toString(), /from "\.\.\/explore\/perflog\.js\?v=20261028-120000"/);
    assert.ok(!files.has("dist/index.html"), "the paths are the site's, at the zip root");
    assert.equal(await read("dist/rayfin.config.json"), files.get("rayfin.config.json").toString());
    assert.ok(unzip(zip(files)).get("app.js").equals(files.get("app.js")));

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

test("the shipped page and its data source parse, and read the model from the function, not a file", async () => {
  for (const p of ["fabric_app/site/app.js", "fabric_app/site/storage/data.js", "fabric_app/site/storage/catalog.js"]) {
    execFileSync(process.execPath, ["--check", new URL(`../${p}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
  }
  const data = await readFile(new URL("../fabric_app/site/storage/data.js", import.meta.url), "utf8");
  assert.doesNotMatch(data, /ossie\.json/);
  assert.match(data, /catalog\.open\(\[\]\)/);
  const fn = await readFile(new URL("../fabric_app/rayfin/functions/src/function_app.ts", import.meta.url), "utf8");
  assert.match(fn, /ctx\.Secrets\.MODEL_URL/);
  const html = await readFile(new URL("../fabric_app/site/index.html", import.meta.url), "utf8");
  assert.match(html, /color-scheme: dark/);
  assert.doesNotMatch(html, /prefers-color-scheme: light|#fff\b|#ffffff|white/i, "black, always");
});

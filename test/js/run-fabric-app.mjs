// The Fabric app, for real, in real Chrome, but for its sign-in: the site as an export uploads it (exportapp.js's
// appFiles and buildDist, vendor/ and all), its data source (storage/data.js) reading a real lakehouse's table from
// OneLake: planned from the Iceberg catalog's answer, downloaded with a SAS, kept in the store (OPFS), read by the
// pool of DuckDB-WASM engines. Each query is compiled from a model by the site's own compiler, as a Report tile's is.
//
// The sign-in is the one part left out: nothing but a person, or the Fabric portal's frame, can sign in to a
// Fabric app. The page starts without a session when it holds the function's answer (catalog.js's fresh()), so
// the answer is made here, by the function's own code (rayfin/functions/src/function_app.ts, its types stripped),
// with the storage token of whoever runs this, and put where the page keeps it.
//
// The page is loaded twice: with ?split=0, each query whole on one engine, then as a viewer opens it, where a
// large table's scan is shared out between the engines (storage/split.js). The queries' answers must be the
// same, and the ones that add up must have been shared out. Both loads' times are printed.
//
// ONELAKE_TOKEN (storage) and FABRIC_TOKEN (the Fabric API, to find the ids), ONELAKE_CI_WORKSPACE and
// ONELAKE_CI_LAKEHOUSE by name; FABRIC_APP_TABLE (schema.table: a table of several files, over 32 MB, or nothing
// is shared out), FABRIC_APP_SUM (a numeric column of it) and FABRIC_APP_BY (a column of few values).
// Run: node scripts/vendor.mjs && node test/js/run-fabric-app.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const { PINS } = require("../../core/vendored.js");
const { appFiles, buildDist, vendorFiles } = require("../../fabric_app/export/exportapp.js");
const { createFabric } = require("../../core/models/fabric.js");

const { ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE,
        FABRIC_APP_TABLE: TABLE, FABRIC_APP_SUM: SUM, FABRIC_APP_BY: BY } = process.env;
for (const [k, v] of Object.entries({ ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE, FABRIC_APP_TABLE: TABLE }))
  if (!v) { console.log(`FAIL ${k} is not set`); process.exit(1); }
const ENGINES = Number(process.env.FABRIC_APP_ENGINES || 4);
const PORT = 5215;
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".json": "application/json", ".css": "text/css" };

// --- The function's answer, by its own code --------------------------------------------------------------------
// function_app.ts between its imports and the function it registers: the catalog, the delegation key, the SAS.
async function functionCode() {
  const source = await readFile(join(root, "fabric_app", "rayfin", "functions", "src", "function_app.ts"), "utf8");
  const from = source.indexOf("const ONELAKE ="), to = source.indexOf("udf.func(");
  if (from < 0 || to < from) throw new Error("function_app.ts is not laid out as this test reads it");
  const body = source.slice(from, source.lastIndexOf("/**", to)).replace(/^type StorageCtx.*$/m, "");
  const js = `import { createHmac } from 'node:crypto';\n${stripTypeScriptTypes(body)}\nexport { catalogPrefix, loadTables, sasWindow, getDelegationKey, tableFolder, signFolderSas, getJson, iso };`;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
// What openCatalog answers, and the table's columns ([{ name, type }], the catalog's own).
async function answerOf(ws, lh, table) {
  const fn = await functionCode();
  const endpoint = "https://onelake.table.fabric.microsoft.com/iceberg";
  const { start, expiry } = fn.sasWindow();
  const prefix = await fn.catalogPrefix(endpoint, ws, lh, ONELAKE_TOKEN);
  const [catalog, key] = await Promise.all([fn.loadTables(endpoint, prefix, [table], ONELAKE_TOKEN), fn.getDelegationKey(ONELAKE_TOKEN, start, expiry)]);
  if (catalog.missing.length) throw new Error(`the catalog has no ${table}`);
  const sas = {};
  for (const location of Object.values(catalog.metadata)) {
    const folder = fn.tableFolder(location);
    sas[folder] = fn.signFolderSas(`/${ws}/${lh}/Tables/${folder}`, "r", key, start, expiry);
  }
  const [ns, name] = table.split(".");
  const { body } = await fn.getJson(`${endpoint}/v1/${prefix}/namespaces/${ns}/tables/${name}`, ONELAKE_TOKEN);
  const m = body.metadata;
  const schema = (m.schemas ?? []).find(s => s["schema-id"] === m["current-schema-id"]) ?? m.schema;
  return { answer: { metadata: catalog.metadata, snapshots: catalog.snapshots, missing: [], sas, expiresOn: fn.iso(expiry) },
           columns: schema.fields.map(f => ({ name: f.name, type: typeof f.type === "string" ? f.type : f.type.type })) };
}

// --- The model: one Direct Lake table, a sum and a count ---------------------------------------------------------
const NUMERIC = /^(int|long|float|double|decimal)/;
const TMSL_TYPE = t => (/^(int|long)/.test(t) ? "int64" : /^(float|double)/.test(t) ? "double" : /^decimal/.test(t) ? "decimal"
  : /^(date|timestamp)/.test(t) ? "dateTime" : t === "boolean" ? "boolean" : "string");
function modelOf(ws, lh, table, columns) {
  const [schemaName, entityName] = table.split(".");
  const sum = SUM || columns.find(c => NUMERIC.test(c.type))?.name;
  const by = BY || columns.find(c => c.type === "string")?.name;
  if (!sum || !by) throw new Error(`${table}: set FABRIC_APP_SUM and FABRIC_APP_BY (its columns: ${columns.map(c => `${c.name} ${c.type}`).join(", ")})`);
  const flat = columns.filter(c => !["struct", "list", "map"].includes(c.type));
  const bim = {
    name: "fabricapp", compatibilityLevel: 1604,
    model: {
      culture: "en-US",
      expressions: [{ name: "DirectLake", kind: "m", expression: ["let",
        `    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${ws}/${lh}", [HierarchicalNavigation=true])`, "in", "    Source"] }],
      tables: [{
        name: "t",
        columns: flat.map(c => ({ name: c.name, dataType: TMSL_TYPE(c.type), sourceColumn: c.name })),
        measures: [{ name: "Total", expression: `SUM(t[${sum}])` }, { name: "Rows", expression: "COUNTROWS(t)" },
                   { name: "Distinct", expression: `DISTINCTCOUNT(t[${by}])` }],
        partitions: [{ name: "t", mode: "directLake", source: { type: "entity", entityName, schemaName, expressionSource: "DirectLake" } }],
      }],
    },
  };
  const col = c => `"t"."${c.replace(/"/g, '""')}"`;
  // As Explore writes a tile's query over the model (page/explore/explore.js). `splits`: whether split.js shares it out.
  const queries = [
    { name: "a card: the sum and the rows", splits: true, sql: `SELECT AGG("Total") AS "Total", AGG("Rows") AS "Rows" FROM model` },
    { name: `the sum and the rows by ${by}`, splits: true, sql: `SELECT ${col(by)} AS "by", AGG("Total") AS "Total", AGG("Rows") AS "Rows" FROM model GROUP BY ALL ORDER BY "by" FETCH FIRST 5000 ROWS WITH TIES` },
    { name: `the least and the most of ${sum} by ${by}`, splits: true, sql: `SELECT ${col(by)} AS "by", MIN(${col(sum)}) AS "least", MAX(${col(sum)}) AS "most" FROM model GROUP BY ALL ORDER BY "by" FETCH FIRST 5000 ROWS WITH TIES` },
    { name: `a distinct count of ${by}, which does not add up`, splits: false, sql: `SELECT AGG("Distinct") AS "Distinct", AGG("Total") AS "Total" FROM model` },
  ];
  return { bim, queries };
}

// --- The page ----------------------------------------------------------------------------------------------------
// Beside the site's own files: the answer put where catalog.js keeps it, then the site's data source and compiler.
const pageOf = (answer, queries) => `
const said = [];
try {
  await new Promise((resolve, reject) => {
    const open = indexedDB.open("iceberg-app", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", "readwrite");
      tx.objectStore("kv").put(${JSON.stringify(answer)}, "catalog");
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const [{ createDataSource }, { createCompiler }, { tmslToModel }, { EXPLORE_CASTS }] = await Promise.all([
    import("./storage/data.js"), import("./semantic/src/index.js"), import("./semantic/formats/tmsl.js"), import("./explore/query.js")]);
  const data = createDataSource({ onProgress: p => { if (p) window.__progress = p.detail; } });
  await data.init();
  const compiler = createCompiler(tmslToModel(data.model()), { tableSource: t => "v_" + t.name, castOutput: EXPLORE_CASTS });
  const text = t => JSON.stringify(t.schema.fields.map(f => f.name + " " + f.type)) + " " +
    JSON.stringify(t.toArray().map(r => r.toJSON()), (k, v) => (typeof v === "bigint" ? v + "n" : v));
  const out = [];
  for (const q of ${JSON.stringify(queries)}) {
    const r = { name: q.name };
    out.push(r);
    try {
      const sql = compiler.compileStatement(q.sql).sql;
      const started = performance.now();
      const table = await data.query(sql);
      r.ms = Math.round(performance.now() - started);
      // Again, what it reads now in the store and its footers read: the engines' own time.
      const again = performance.now();
      await data.query(sql);
      r.again = Math.round(performance.now() - again);
      r.rows = table.numRows;
      r.text = text(table);
    } catch (e) { r.failed = String(e?.message || e).split("\\n")[0]; }
  }
  window.__done = { out, shared: data.shared() };
} catch (e) { window.__done = { error: String(e?.stack || e) }; }
`;

// Two answers (the page's `text`: the columns' types, then the rows) the same, but for a DOUBLE's last digits:
// a sum of DOUBLEs depends on the order they are added in, which sharing the rows out changes.
function same(a, b) {
  const parts = s => { const at = s.indexOf("] ") + 1; return [s.slice(0, at), JSON.parse(s.slice(at + 1))]; };
  const [typesA, rowsA] = parts(a), [typesB, rowsB] = parts(b);
  const close = (x, y) => (typeof x === "number" && typeof y === "number"
    ? x === y || Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y)) : x === y);
  return typesA === typesB && rowsA.length === rowsB.length && rowsA.every((r, i) => {
    const keys = Object.keys(r);
    return keys.length === Object.keys(rowsB[i]).length && keys.every(k => close(r[k], rowsB[i][k]));
  });
}

let code = 1, browser, server;
try {
  const fabric = createFabric({ getFabricToken: async () => FABRIC_TOKEN });
  const ws = String(await fabric.workspaceId(WS)).toLowerCase();
  const lake = (await fabric.listItems(WS)).find(i => i.type === "Lakehouse" && i.name.toLowerCase() === LAKEHOUSE.toLowerCase());
  if (!lake) throw new Error(`${WS} has no lakehouse ${LAKEHOUSE}`);
  const lh = String(lake.id).toLowerCase();
  const { answer, columns } = await answerOf(ws, lh, TABLE);
  console.log(`${TABLE}: ${answer.snapshots[TABLE]?.bytes ?? "?"} bytes; ${columns.map(c => `${c.name} ${c.type}`).join(", ")}`);
  const { bim, queries } = modelOf(ws, lh, TABLE, columns);

  // The site, as an export uploads it.
  const plan = { warnings: [], title: "fabricapp", name: "fabricapp", modelName: "fabricapp", fileName: "fabricapp.bim",
                 workspace: ws, lakehouse: lh, catalogUrl: `https://onelake.table.fabric.microsoft.com/iceberg/${ws}/${lh}`,
                 modelPath: `${WS}/${LAKEHOUSE}.Lakehouse/Files/fabricapp.bim`, tables: [["t", TABLE]] };
  const files = await appFiles({ plan, state: null, model: bim, fabricAppDir: join(root, "fabric_app"), appDir: join(root, "page"),
                                 daxSqlDir: join(root, "vendor", "npm", PINS.daxSql) });
  const dist = buildDist(files, {}, await vendorFiles(join(root, "vendor", "webapp"), "duckdb"));
  const page = pageOf(answer, queries);
  server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1);
    if (path === "test.html") return res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><body><script type="module" src="./test.js"></script>');
    if (path === "test.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(page);
    const bytes = dist.get(path);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream" }).end(bytes);
  });
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // One context for both loads: the second reads what the first kept in the store.
  const context = await browser.newContext();
  // FABRIC_APP_AUTH=token: the workspace refuses a user-delegated SAS (its OneLake setting is off), so each
  // download goes with the storage token instead of the SAS the page signed it with. The rest is the same.
  if (process.env.FABRIC_APP_AUTH === "token") {
    await context.route("https://onelake.dfs.fabric.microsoft.com/**", route => {
      const url = new URL(route.request().url());
      url.search = "";
      return route.continue({ url: url.href, headers: { ...route.request().headers(), authorization: `Bearer ${ONELAKE_TOKEN}`, "x-ms-version": "2022-11-02" } });
    });
  }
  const load = async split => {
    const tab = await context.newPage();
    const logs = [];
    tab.on("pageerror", e => console.log("[pageerror]", e.message));
    tab.on("console", m => { const t = m.text(); if (t.startsWith("[split]") || t.startsWith("[store]")) logs.push(t.split("\n")[0]); });
    await tab.goto(`http://127.0.0.1:${PORT}/test.html?engines=${ENGINES}${split}`);
    let last = "";
    for (;;) {
      const done = await tab.evaluate(() => window.__done ?? null);
      if (done) { await tab.close(); if (done.error) throw new Error(done.error); return { ...done, logs }; }
      const progress = await tab.evaluate(() => window.__progress ?? "");
      if (progress && progress !== last) { last = progress; console.log(`  ${progress}`); }
      await new Promise(r => setTimeout(r, 5000));
    }
  };
  console.log(`whole: each query on one engine of ${ENGINES}`);
  const whole = await load("&split=0");
  for (const line of whole.logs) console.log(`  ${line}`);
  console.log(`as a viewer opens it: each query's scan shared out between ${ENGINES} engines`);
  const split = await load("");
  // Whole once more, the store read as it was for the load above: a visit's first run of each query, like for like.
  const again = await load("&split=0");

  const checks = [];
  const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  for (const [i, q] of queries.entries()) {
    const a = whole.out[i], b = split.out[i];
    if (a.failed || b.failed) { check(false, `${q.name}: ${a.failed ? `whole: ${a.failed}` : ""} ${b.failed ? `split: ${b.failed}` : ""}`); continue; }
    const ok = same(a.text, b.text);
    // Each load's first run of the query, the store read by the load before it.
    check(ok, `${q.name}: ${a.rows} rows, the same shared out as whole; whole ${again.out[i].ms} ms, shared out ${b.ms} ms` +
      (ok ? "" : `\n     whole ${a.text.slice(0, 400)}\n     split ${b.text.slice(0, 400)}`));
  }
  const wanted = queries.filter(q => q.splits).length;
  // Each once: its second run is answered from the results this browser kept.
  check(whole.shared === 0, `with ?split=0, ${whole.shared} queries were shared out`);
  check(split.shared === wanted, `with nothing in the address, ${split.shared} queries were shared out between the engines (${wanted} add up)`);
  code = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`FAIL ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  server?.close();
}
process.exit(code);

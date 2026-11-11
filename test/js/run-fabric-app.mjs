// The Fabric app's data source on a real, large table, in real Chrome: the site and the function as an export
// makes them, on a local Rayfin backend (fabric-local.mjs). The page signs in with its own sign-in, asks its own
// function where the table is (a read-only SAS with it), plans it from the Iceberg catalog's answer, downloads what
// its queries read into the store (OPFS), and reads it with the pool of DuckDB-WASM engines. Each query is
// compiled from a model by the site's own compiler, as a Report tile's is.
//
// Nothing of the product is stood in for: no answer put in the browser, no token in place of the SAS. What is
// not proven here is Fabric's own hosting, which rayfin-local stands in for.
//
// The page is loaded three times (storage/split.js): with ?split=0, each query whole on one engine; with ?split=1,
// the table's scan shared out between the engines whatever its size; and as a viewer opens it, where only a table of
// ten million rows or more is shared out. The answers must be the same each time, and the queries that add up shared
// out when they should be and not otherwise. The first two loads' times are printed.
//
// ONELAKE_TOKEN (storage) and FABRIC_TOKEN (the Fabric API, to find the ids), ONELAKE_CI_WORKSPACE and
// ONELAKE_CI_LAKEHOUSE by name; FABRIC_APP_TABLE (schema.table: a table of several files, over 32 MB, or nothing
// is shared out), FABRIC_APP_SUM (a numeric column of it) and FABRIC_APP_BY (a column of few values).
// The workspace must allow OneLake user-delegated SAS tokens, as an app's must.
// RAYFIN_LOCAL: the rayfin-local executable (default: rayfin-local on PATH).
// Run: node scripts/vendor.mjs && node test/js/run-fabric-app.mjs
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { serveApp, tableOf, CHROME } from "./fabric-local.mjs";

const require = createRequire(import.meta.url);
const { createFabric } = require("../../core/models/fabric.js");

const { ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE,
        FABRIC_APP_TABLE: TABLE, FABRIC_APP_SUM: SUM, FABRIC_APP_BY: BY } = process.env;
for (const [k, v] of Object.entries({ ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE, FABRIC_APP_TABLE: TABLE }))
  if (!v) { console.log(`FAIL ${k} is not set`); process.exit(1); }
const ENGINES = Number(process.env.FABRIC_APP_ENGINES || 4);

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
  // As Explore writes a tile's query over the model (page/explore/explore.js), by the name the app gives its model.
  // `splits`: whether split.js shares it out.
  const queries = [
    { name: "a card: the sum and the rows", splits: true, sql: `SELECT AGG("Total") AS "Total", AGG("Rows") AS "Rows" FROM fabricapp` },
    { name: `the sum and the rows by ${by}`, splits: true, sql: `SELECT ${col(by)} AS "by", AGG("Total") AS "Total", AGG("Rows") AS "Rows" FROM fabricapp GROUP BY ALL ORDER BY "by" FETCH FIRST 5000 ROWS WITH TIES` },
    { name: `the least and the most of ${sum} by ${by}`, splits: true, sql: `SELECT ${col(by)} AS "by", MIN(${col(sum)}) AS "least", MAX(${col(sum)}) AS "most" FROM fabricapp GROUP BY ALL ORDER BY "by" FETCH FIRST 5000 ROWS WITH TIES` },
    { name: `a distinct count of ${by}, which does not add up`, splits: false, sql: `SELECT AGG("Distinct") AS "Distinct", AGG("Total") AS "Total" FROM fabricapp` },
  ];
  return { bim, queries };
}

// --- The test's own page, beside the site's ---------------------------------------------------------------------
// The site's data source and compiler, as the app's page uses them (site/app.js), with the queries to run.
const pageOf = queries => `
try {
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
      const sql = compiler.compileStatement(q.sql, "fabricapp").sql;
      const started = performance.now();
      const table = await data.query(sql);
      r.ms = Math.round(performance.now() - started);
      // Again, what it reads now in the store and its footers read: the engines' own time.
      const again = performance.now();
      await data.query(sql);
      r.again = Math.round(performance.now() - again);
      r.rows = table.numRows;
      r.text = text(table);
    } catch (e) { r.failed = String(e?.message || e).split(/\\r?\\n/)[0]; }
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

let code = 1, browser, app;
try {
  const fabric = createFabric({ getFabricToken: async () => FABRIC_TOKEN });
  const ws = String(await fabric.workspaceId(WS)).toLowerCase();
  const lake = (await fabric.listItems(WS)).find(i => i.type === "Lakehouse" && i.name.toLowerCase() === LAKEHOUSE.toLowerCase());
  if (!lake) throw new Error(`${WS} has no lakehouse ${LAKEHOUSE}`);
  const lh = String(lake.id).toLowerCase();
  const { columns, rows, bytes } = await tableOf(ws, lh, TABLE, ONELAKE_TOKEN);
  if (!(rows >= 0)) throw new Error(`${TABLE}: its snapshot does not say how many rows it has`);
  console.log(`${TABLE}: ${rows} rows, ${bytes} bytes; ${columns.map(c => `${c.name} ${c.type}`).join(", ").slice(0, 300)}`);
  const { bim, queries } = modelOf(ws, lh, TABLE, columns);
  const catalogUrl = `https://onelake.table.fabric.microsoft.com/iceberg/${ws}/${lh}`;

  app = await serveApp("the app", {
    plan: { warnings: [], title: "fabricapp", name: "fabricapp", modelName: "fabricapp", fileName: "fabricapp.bim",
            workspace: ws, lakehouse: lh, catalogUrl, modelPath: `${WS}/${LAKEHOUSE}.Lakehouse/Files/fabricapp.bim`, tables: [["t", TABLE]] },
    model: bim, engine: "duckdb",
    // The function's secrets are the export's; its storage token, ours.
    env: { CATALOG_URL: catalogUrl, TABLES: TABLE, RAYFIN_LOCAL_TOKEN_STORAGE: ONELAKE_TOKEN },
    extra: { "test.html": '<!doctype html><meta charset="utf-8"><body><script type="module" src="./test.js"></script>', "test.js": pageOf(queries) },
  });

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // One context for the three loads: each reads what the one before kept in the store, and is signed in as it was.
  const context = await browser.newContext();
  const load = async split => {
    const tab = await context.newPage();
    const logs = [];
    tab.on("pageerror", e => console.log("[pageerror]", e.message));
    tab.on("console", m => { const t = m.text(); if (t.startsWith("[split]") || t.startsWith("[store]")) logs.push(t.split("\n")[0]); });
    await tab.goto(`${new URL("test.html", app.ready.appUrl)}?engines=${ENGINES}${split}`);
    let last = "";
    for (;;) {
      const done = await tab.evaluate(() => window.__done ?? null);
      if (done) { await tab.close(); if (done.error) throw new Error(done.error); return { ...done, logs }; }
      // With no session, the page's own sign-in asks: its button, as a viewer clicks it.
      const button = tab.getByRole("button", { name: "Sign in with Fabric" });
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
      const progress = await tab.evaluate(() => window.__progress ?? "");
      if (progress && progress !== last) { last = progress; console.log(`  ${progress}`); }
      await new Promise(r => setTimeout(r, 3000));
    }
  };
  console.log(`whole: each query on one engine of ${ENGINES}`);
  const whole = await load("&split=0");
  for (const line of whole.logs) console.log(`  ${line}`);
  console.log(`shared out: each query's scan between ${ENGINES} engines, whatever the table's size`);
  const split = await load("&split=1");
  for (const line of split.logs) console.log(`  ${line}`);
  const big = rows >= 10_000_000;
  console.log(`as a viewer opens it: a table of ${rows} rows is ${big ? "" : "not "}shared out`);
  const viewer = await load("");

  const checks = [];
  const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  for (const [i, q] of queries.entries()) {
    const a = whole.out[i], b = split.out[i], c = viewer.out[i];
    const failed = [["whole", a], ["shared out", b], ["as a viewer", c]].filter(([, r]) => r.failed).map(([k, r]) => `${k}: ${r.failed}`);
    if (failed.length) { check(false, `${q.name}: ${failed.join("; ")}`); continue; }
    const ok = same(a.text, b.text) && same(a.text, c.text);
    // Each one's second run: what it reads in the store, and its footers read.
    check(ok, `${q.name}: ${a.rows} rows, the same shared out as whole; whole ${a.again} ms, shared out ${b.again} ms` +
      (ok ? "" : `\n     whole ${a.text.slice(0, 400)}\n     shared out ${b.text.slice(0, 400)}\n     as a viewer ${c.text.slice(0, 400)}`));
  }
  const wanted = queries.filter(q => q.splits).length;
  check(whole.shared === 0, `with ?split=0, ${whole.shared} runs were shared out`);
  // Each query is run twice.
  check(split.shared === wanted * 2, `with ?split=1, ${split.shared} runs were shared out between the engines (${wanted} queries add up, each run twice)`);
  // Each once: its second run is answered from the results this browser kept.
  check(viewer.shared === (big ? wanted : 0), `with nothing in the address, ${viewer.shared} queries of a table of ${rows} rows were shared out`);
  code = checks.length === queries.length + 3 && checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`FAIL ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  await app?.stop(code === 0);
}
process.exit(code);

// The Fabric app's split (?split=1), in real Chrome: a query's scan of a large table shared out between
// DuckDB-WASM engines, each over its share of the files, and the rest run by one. The real split.js, DuckDB-WASM
// from vendor/, the engines opened and set as data.js does it (storage/session.js), and the steps data.js takes
// (splitRun): DESCRIBE the partial, COPY it to Parquet, the bytes out of one engine and into another, the final
// statement. Each query's answer split is compared, values and types, with the same engine's answer whole.
//
// The files are in each engine's memory: the store has a test of its own (run-store-heal.mjs).
// No sign-in, no OneLake. Run: node scripts/vendor.mjs && node test/js/run-split.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { WEBAPP } = require("../../core/vendored.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PORT = 5214;
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".json": "application/json" };

// The queries, as dax-sql compiles a tile: the fact read in a CTE of its own.
const QUERIES = {
  "a sum by a dimension's column, grouped below the join":
    `WITH f3 AS (SELECT j4."City" AS "g0", SUM(p6."a0") AS "a0" FROM (SELECT t2."CustomerKey" AS "c0", SUM(t2."Amount") AS "a0" FROM v_fact AS t2 GROUP BY t2."CustomerKey") AS p6 LEFT JOIN v_dim AS j4 ON j4."CustomerKey" = p6."c0" GROUP BY j4."City") SELECT f3.g0 AS "City", f3.a0 AS "Amount" FROM f3 ORDER BY 1`,
  "two sums, a filter on the dimension, joined first":
    `WITH f4 AS (SELECT j5."City" AS "g0", SUM(t2."Amount") AS "a0", SUM(t2."Qty") AS "a1" FROM v_fact AS t2 LEFT JOIN v_dim AS j5 ON j5."CustomerKey" = t2."CustomerKey" WHERE (((j5."Segment" COLLATE NOCASE) IN ('seg 1', 'Seg 3'))) GROUP BY j5."City") SELECT f4.g0 AS "City", f4.a0 AS "Amount", f4.a1 AS "Qty" FROM f4 ORDER BY 1`,
  "a card: a sum, the two counts, a minimum, a maximum":
    `WITH f2 AS (SELECT SUM(t1."Amount") AS "a0", NULLIF(COUNT(*), 0) AS "a1", COUNT(t1."Note") AS "a2", MIN(t1."OrderDate") AS "a3", MAX(t1."Note") AS "a4" FROM v_fact AS t1) SELECT * FROM f2`,
  "a card with no row left: every share answers NULL":
    `WITH f2 AS (SELECT SUM(t1."Amount") AS "a0", NULLIF(COUNT(*), 0) AS "a1", COUNT(t1."Qty") AS "a2" FROM v_fact AS t1 WHERE t1."Qty" > 100) SELECT * FROM f2`,
  "groups on the fact's own column, an aggregate's own filter":
    `WITH f3 AS (SELECT t2."OrderDate" AS "g0", SUM(t2."Qty") FILTER (WHERE t2."Qty" > 4) AS "a0", MIN(t2."Qty") AS "a1" FROM v_fact AS t2 GROUP BY t2."OrderDate") SELECT f3.g0 AS "d", f3.a0, f3.a1 FROM f3 ORDER BY 1`,
};

// The page: everything runs in it, and it leaves what happened in window.__done.
const PAGE = `
import * as duckdb from "/site/vendor/npm/${WEBAPP.duckdbWasm}/+esm.js";
import { OPEN, SETTINGS } from "/site/storage/session.js";
import { splitPlan, carried } from "/site/storage/split.js";

const DIST = location.origin + "/site/vendor/npm/${WEBAPP.duckdbWasm}/dist/";
const EXT_REPO = location.origin + "/site/vendor/duckdb-ext";
const QUERIES = ${JSON.stringify(QUERIES)};
const ENGINES = 3, FILES = 5;

async function engine(index) {
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(URL.createObjectURL(new Blob(
    ["importScripts(" + JSON.stringify(DIST + "duckdb-browser-base.worker.js") + ");"], { type: "text/javascript" }))));
  await db.instantiate(DIST + "duckdb-base.wasm", null);
  await db.open(OPEN);
  const conn = await db.connect();
  await conn.query("SET home_directory = '/tmp'; SET custom_extension_repository = '" + EXT_REPO + "'; INSTALL parquet; LOAD parquet;");
  for (const sql of SETTINGS) await conn.query(sql);
  return { index, db, conn };
}
// An answer as text: each column's Arrow type, then the rows.
const text = t => JSON.stringify(t.schema.fields.map(f => f.name + " " + f.type)) + " " +
  JSON.stringify(t.toArray().map(r => r.toJSON()), (k, v) => (typeof v === "bigint" ? v + "n" : v));

async function main() {
  const engines = await Promise.all(Array.from({ length: ENGINES }, (_, i) => engine(i)));
  // The tables, written by the first engine: a dimension, and a fact in FILES files of uneven sizes, with
  // keys the dimension lacks and NULLs.
  const gen = engines[0];
  await gen.conn.query(\`COPY (SELECT i AS "CustomerKey", 'City ' || (i % 7) AS "City", 'Seg ' || (i % 4) AS "Segment" FROM range(1, 501) t(i)) TO 'dim.parquet' (FORMAT parquet)\`);
  const files = { "dim.parquet": await gen.db.copyFileToBuffer("dim.parquet") };
  for (let f = 0; f < FILES; f++) {
    await gen.conn.query(\`COPY (SELECT (hash(i) % 520 + 1)::INT AS "CustomerKey", (DATE '2024-01-01' + (i % 90)::INT) AS "OrderDate",
        CASE WHEN i % 11 = 0 THEN NULL ELSE (i % 9 + 1)::INT END AS "Qty", ((hash(i + 1) % 100000) / 100.0)::DECIMAL(18,4) AS "Amount",
        CASE WHEN i % 5 = 0 THEN NULL ELSE 'note ' || (i % 1000) END AS "Note"
      FROM range(\${f * 100000}, \${f * 100000 + 20000 * (f + 1)}) t(i)) TO 'fact_\${f}.parquet' (FORMAT parquet)\`);
    files["fact_" + f + ".parquet"] = await gen.db.copyFileToBuffer("fact_" + f + ".parquet");
  }
  const facts = Array.from({ length: FILES }, (_, f) => "fact_" + f + ".parquet");
  const list = names => "[" + names.map(n => "'" + n + "'").join(", ") + "]";
  for (const e of engines) {
    for (const [name, bytes] of Object.entries(files)) await e.db.registerFileBuffer(name, bytes.slice());
    // As data.js binds them: a small table copied into memory, a large one a view over its files, and the
    // engine's share of them.
    await e.conn.query("CREATE OR REPLACE TABLE dim AS SELECT * FROM read_parquet('dim.parquet'); CREATE OR REPLACE VIEW v_dim AS SELECT * FROM dim");
    await e.conn.query("CREATE OR REPLACE VIEW v_fact AS SELECT * FROM read_parquet(" + list(facts) + ")");
    await e.conn.query("CREATE OR REPLACE VIEW p_fact AS SELECT * FROM read_parquet(" + list(facts.filter((_, f) => f % ENGINES === e.index)) + ")");
  }

  const out = [];
  let id = 0;
  for (const [name, sql] of Object.entries(QUERIES)) {
    const r = { name };
    out.push(r);
    try {
      r.whole = text(await engines[0].conn.query(sql));
      const plan = splitPlan(sql, t => t === "fact");
      if (!plan) { r.failed = "not split"; continue; }
      const run = ++id;
      const answers = await Promise.all(plan.parts.flatMap(part => engines.map(async e => {
        const file = "part_" + run + "_" + part.cte + "_" + e.index + ".parquet";
        const types = Object.fromEntries((await e.conn.query("DESCRIBE " + part.partialSql)).toArray().map(x => [x.column_name, x.column_type]));
        await e.conn.query("COPY (" + carried(part.partialSql, types) + ") TO '" + file + "' (FORMAT parquet)");
        const bytes = await e.db.copyFileToBuffer(file);
        await e.db.dropFile(file);
        return { cte: part.cte, file, bytes, types };
      })));
      r.parts = answers.length;
      r.bytes = answers.reduce((n, a) => n + a.bytes.byteLength, 0);
      // The rest, on the last engine: not the one that answered whole.
      const last = engines[ENGINES - 1];
      for (const a of answers) await last.db.registerFileBuffer(a.file, a.bytes);
      r.split = text(await last.conn.query(plan.finalSql(cte => answers.filter(a => a.cte === cte).map(a => a.file), cte => answers.find(a => a.cte === cte)?.types)));
      for (const a of answers) await last.db.dropFile(a.file);
    } catch (e) { r.failed = String(e?.message || e).split("\\n")[0]; }
  }
  return { out };
}
main().then(r => { window.__done = r; }, e => { window.__done = { error: String(e?.stack || e) }; });
`;

const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><script type="module" src="/test.js"></script>');
  if (path === "/test.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(PAGE);
  const file = path.startsWith("/site/vendor/") ? join(root, "vendor", "webapp", normalize(path.slice("/site/vendor/".length)))
    : path.startsWith("/site/storage/") ? join(root, "fabric_app", "site", "storage", normalize(path.slice("/site/storage/".length))) : null;
  if (!file || file.includes("..")) return res.writeHead(404).end();
  try { res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

let code = 1, browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  page.on("response", r => { if (r.status() === 404) console.log("[404]", r.url()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.__done, null, { timeout: 8 * 60_000 });
  const done = await page.evaluate(() => window.__done);
  if (done.error) throw new Error(done.error);

  const checks = [];
  for (const r of done.out) {
    const ok = !r.failed && r.split === r.whole;
    checks.push(ok);
    console.log(`${ok ? "ok  " : "FAIL"} ${r.name}: ${r.failed ? r.failed : ok ? `the same answer from ${r.parts} parts (${r.bytes} bytes)` : `whole ${r.whole.slice(0, 300)} | split ${r.split.slice(0, 300)}`}`);
  }
  code = checks.length === Object.keys(QUERIES).length && checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`FAIL ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
process.exit(code);

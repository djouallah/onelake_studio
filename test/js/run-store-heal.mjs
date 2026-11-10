// The Fabric app's store, in real Chrome: a query that reads bytes the store lacks fails, the page
// downloads them, and the SAME engine, asked again, answers right. The real blockcache.js (the store
// worker and DuckDB's worker), the real ranges.js, DuckDB-WASM from vendor/, and the engine opened and
// set as data.js does it (storage/session.js). The Parquet file is written by DuckDB-WASM itself: four
// columns, one of them wide, so that a query of one column leaves the others out of the store.
//
// A second engine, with DuckDB's own file cache left on, runs the same steps on a second file and is only
// reported: it is how the page was before, when the query run again read the same bad bytes.
//
// No sign-in, no OneLake. Run: node scripts/vendor.mjs && node test/js/run-store-heal.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { WEBAPP } = require("../../core/vendored.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PORT = 5213;
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".json": "application/json" };

// The page: everything runs in it, and it leaves what happened in window.__done.
const PAGE = `
import * as duckdb from "/site/vendor/npm/${WEBAPP.duckdbWasm}/+esm.js";
import { OPEN, SETTINGS } from "/site/storage/session.js";
import { columnRanges, piecesOf, tailOf } from "/site/storage/ranges.js";

const DIST = location.origin + "/site/vendor/npm/${WEBAPP.duckdbWasm}/dist/";
const EXT_REPO = location.origin + "/site/vendor/duckdb-ext";
const BLOCKCACHE = location.origin + "/site/storage/blockcache.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const said = [];
const log = line => { said.push(line); console.log(line); };

const worker = source => new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
async function engine(settings) {
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker(
    "self.DUCKDB_EXT_REPO = " + JSON.stringify(EXT_REPO) + ";\\nimportScripts(" + JSON.stringify(BLOCKCACHE) + ");\\nimportScripts(" + JSON.stringify(DIST + "duckdb-browser-base.worker.js") + ");"));
  await db.instantiate(DIST + "duckdb-base.wasm", null);
  await db.open(OPEN);
  const conn = await db.connect();
  await conn.query("SET home_directory = '/tmp'; SET custom_extension_repository = '" + EXT_REPO + "'; INSTALL parquet; LOAD parquet;");
  for (const sql of settings) await conn.query(sql);
  return { db, conn, rows: async sql => (await conn.query(sql)).toArray().map(r => r.toJSON()) };
}

// The store, as data.js speaks to it: this tab's store worker writes, and the channel says what it kept,
// what it holds and what a DuckDB worker missed.
const store = worker("self.BLOCKCACHE_ROLE = 'writer';\\nimportScripts(" + JSON.stringify(BLOCKCACHE) + ");");
const channel = new BroadcastChannel("blockcache");
const misses = [], waiting = new Map();
let writer = false;
channel.onmessage = e => {
  const d = e.data ?? {};
  if (d.writer) writer = true;
  if (d.miss) misses.push({ path: d.miss, from: d.from, to: d.to, seen: Date.now() });
  if (d.stored) { waiting.get(d.stored + "@" + (d.at ?? 0))?.(d); waiting.delete(d.stored + "@" + (d.at ?? 0)); }
  if (d.id != null && d.held) { waiting.get(d.id)?.(d); waiting.delete(d.id); }
};
const answered = (key, send) => new Promise((resolve, reject) => {
  waiting.set(key, resolve);
  send();
  setTimeout(() => reject(new Error("the store did not answer " + key)), 30000);
});

async function main() {
  for (let i = 0; !writer; i++) {
    if (i > 100) throw new Error("no store writer: OPFS with shared access handles is needed");
    channel.postMessage({ ping: true });
    await sleep(200);
  }

  // The file, and what its columns sum to, by an engine that reads it from its own memory.
  const gen = await engine([]);
  await gen.conn.query(\`COPY (SELECT i AS id, hash(i) % 1000003 AS a, md5(i::VARCHAR) || md5((i + 1)::VARCHAR) AS b,
      hash(i * 3 + 1) % 999983 AS c FROM range(800000) t(i))
    TO 'gen.parquet' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 200000)\`);
  const bytes = await gen.db.copyFileToBuffer("gen.parquet");
  const size = bytes.byteLength;
  const [expected] = await gen.rows("SELECT sum(a)::DOUBLE AS a, sum(c)::DOUBLE AS c FROM 'gen.parquet'");
  const chunks = (await gen.rows("SELECT path_in_schema, dictionary_page_offset, data_page_offset, total_compressed_size FROM parquet_metadata('gen.parquet')"))
    .map(r => {
      const data = Number(r.data_page_offset), dict = r.dictionary_page_offset == null ? null : Number(r.dictionary_page_offset);
      const from = dict != null && dict > 0 && dict < data ? dict : data;
      return { col: String(r.path_in_schema), from, to: from + Number(r.total_compressed_size) - 1 };
    });
  log("the file: " + size + " bytes, " + chunks.length + " column chunks; sum(a) " + expected.a + ", sum(c) " + expected.c);

  // One file's run: its footer and column a in the store, a query of a, then a query of c, which the
  // store lacks, each run again after what it missed is downloaded, on the one engine.
  async function scenario(file, settings) {
    const key = "https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables/t/" + file;
    const heldRuns = async () => {
      const id = file + "-" + Math.random();
      return (await answered(id, () => channel.postMessage({ held: [key], id }))).held?.[key]?.runs ?? [];
    };
    const download = async ranges => {
      for (const p of piecesOf(key, size, ranges, await heldRuns())) {
        const piece = bytes.slice(p.from, p.to + 1).buffer;
        const d = await answered(key + "@" + p.from, () => store.postMessage({ store: key, bytes: piece, at: p.from, size }, [piece]));
        if (d.error) throw new Error("the store could not keep a piece: " + d.error);
      }
    };
    const lacks = async col => piecesOf(key, size, columnRanges(chunks, new Set([col])), await heldRuns()).reduce((n, p) => n + p.to - p.from + 1, 0);

    const e = await engine(settings);
    await download([tailOf(size), ...columnRanges(chunks, new Set(["a"]))]);
    await e.db.registerFileURL("store/" + file, "https://store.local/ws/lh/Tables/t/" + file, duckdb.DuckDBDataProtocol.HTTP, false);
    // data.js's healing: what was missed, with every column it is of, then the query again.
    const healing = async sql => {
      const errors = [];
      for (let tries = 0; ; tries++) {
        const started = Date.now();
        try { return { row: (await e.rows(sql))[0], heals: tries, errors }; }
        catch (err) {
          errors.push(String(err?.message || err).split("\\n")[0]);
          await sleep(300);
          const seen = misses.filter(m => m.path === key && m.seen >= started);
          if (!seen.length || tries >= 8) return { failed: errors[errors.length - 1], heals: tries, errors, misses: seen.length };
          const cols = new Set(chunks.filter(c => seen.some(m => c.from <= m.to && c.to >= m.from)).map(c => c.col));
          await download([...seen.map(m => [m.from, m.to]), ...columnRanges(chunks, cols)]);
        }
      }
    };
    const out = { file };
    out.a = await healing("SELECT sum(a)::DOUBLE AS v FROM read_parquet('store/" + file + "')");
    out.lackedOfC = await lacks("c");
    out.c = await healing("SELECT sum(c)::DOUBLE AS v FROM read_parquet('store/" + file + "')");
    await e.db.terminate();
    return out;
  }

  const fixed = await scenario("fixed.parquet", SETTINGS);
  const before = await scenario("before.parquet", SETTINGS.filter(s => !/enable_external_file_cache/.test(s)));
  return { expected, fixed, before, said };
}
main().then(r => { window.__done = r; }, e => { window.__done = { error: String(e?.stack || e), said }; });
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
  page.on("console", m => console.log(`[page] ${m.text()}`));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.__done, null, { timeout: 8 * 60_000 });
  const done = await page.evaluate(() => window.__done);
  console.log(JSON.stringify({ ...done, said: undefined }, null, 2));
  if (done.error) throw new Error(done.error);

  const { expected, fixed, before } = done;
  const checks = [];
  const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  check(fixed.a.row?.v === expected.a, `column a, its chunks in the store: ${fixed.a.row?.v ?? fixed.a.failed} after ${fixed.a.heals} download(s) of what was missed`);
  check(fixed.lackedOfC > 0, `column c is not in the store before it is asked for (${fixed.lackedOfC} bytes lacking)`);
  check(fixed.c.heals > 0, `the query of c read bytes the store lacked (${fixed.c.errors[0] ?? "no error"})`);
  check(fixed.c.row?.v === expected.c, `the same engine, asked again: ${fixed.c.row?.v ?? fixed.c.failed} after ${fixed.c.heals} download(s)`);
  console.log(`with DuckDB's own file cache on, as before: column a ${before.a.row?.v ?? before.a.failed} (${before.a.heals}), ` +
    `column c ${before.c.row ? `${before.c.row.v} after ${before.c.heals} download(s)` : `failed after ${before.c.heals}: ${before.c.failed}`}`);
  code = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`FAIL ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
process.exit(code);

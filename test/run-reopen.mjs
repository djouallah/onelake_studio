// Opening a table, leaving it, and coming back — the thing that is supposed to be
// instant the second time and is not.
//
// Real duckdb-wasm, the real proxy, the real disk cache, a fake OneLake that logs every
// request it is asked for. The second pass registers the SAME OneLake object under a NEW
// name, because that is exactly what data.js does: every peek registers `peek_<n>.parquet`
// and every load registers `data_<n>.parquet`, so DuckDB's own in-session caches are cold
// on the way back and every byte has to come from somewhere. Either it comes from disk or
// it comes from the network, and this counts which.
//
// Run: node test/run-reopen.mjs
import http from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { startProxy } from "../extension/src/proxy.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = join(root, "test", "fixtures", "sample.parquet");
const TOKEN = "test-token-not-a-real-one";
const PAGE_PORT = 5201;

// The shape a Fabric Iceberg data file has: under Tables/, .parquet, no query string.
const OBJECT = "/ws/lh.Lakehouse/Tables/dbo/sales/data_0.parquet";

const parquet = await readFile(FIXTURE);

const reqs = [];
const upstream = http.createServer((req, res) => {
  reqs.push({ method: req.method, range: req.headers.range || null });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
  const head = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), parquet.length - 1) : parquet.length - 1;
    const slice = parquet.subarray(start, end + 1);
    res.writeHead(206, { ...head, "content-length": String(slice.length),
                         "content-range": `bytes ${start}-${end}/${parquet.length}` });
    res.end(req.method === "HEAD" ? undefined : slice);
    return;
  }
  res.writeHead(200, { ...head, "content-length": String(parquet.length) });
  res.end(req.method === "HEAD" ? undefined : parquet);
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${upstream.address().port}`;

const CACHE_DIR = await mkdtemp(join(tmpdir(), "onelake-reopen-"));
const proxy = await startProxy({
  getToken: async () => TOKEN,
  cacheDir: CACHE_DIR,
  dfsUpstream: upBase, tableUpstream: upBase,
  onLog: e => console.log(`      proxy: ${e.method} ${e.status} ${e.cache} ` +
                          `${e.ms}ms ${(e.bytes / 1024).toFixed(0)}KB ${e.range || "(whole file)"}`),
});

const URL_UNDER_TEST = `${proxy.dfsOrigin}${OBJECT}`;

const NONCE = "n0nce";
const PAGE = `<!doctype html><meta charset=utf-8><title>booting</title>
<meta http-equiv="Content-Security-Policy" content="${[
  `default-src 'none'`,
  `script-src http://127.0.0.1:${PAGE_PORT} 'nonce-${NONCE}' 'unsafe-eval' https://cdn.jsdelivr.net`,
  `worker-src blob:`,
  `connect-src http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net https://extensions.duckdb.org`,
].join("; ")}">
<body><script type="module" nonce="${NONCE}">
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";
const URL_UNDER_TEST = ${JSON.stringify(URL_UNDER_TEST)};
try {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([\`importScripts("\${bundle.mainWorker}");\`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  // The same two settings data.js applies.
  await conn.query("SET enable_http_metadata_cache = true");
  await conn.query("SET enable_object_cache = true");

  // Each pass is a fresh registration name, which is what makes the second one a real
  // re-read rather than DuckDB answering from its own memory.
  window.pass = async name => {
    await db.registerFileURL(name, URL_UNDER_TEST, duckdb.DuckDBDataProtocol.HTTP, false);
    const r = await conn.query(\`SELECT count(*) AS n FROM read_parquet('\${name}')\`);
    return Number(r.toArray()[0].n);
  };
  document.title = "READY";
} catch (e) { window.BOOT_ERROR = String(e && e.message || e); document.title = "ERROR"; }
</script>`;

const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise(r => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok " : "FAIL"} — ${name}`); cond ? pass++ : fail++; };

let browser;
try {
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage();
  page.on("console", m => { if (m.type() === "error") console.log("   [page]", m.text()); });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
  await page.waitForFunction(() => ["READY", "ERROR"].includes(document.title), { timeout: 120000 });
  if (await page.evaluate(() => window.BOOT_ERROR)) {
    throw new Error(await page.evaluate(() => window.BOOT_ERROR));
  }

  console.log("\n  first open:");
  const first = reqs.length;
  const n1 = await page.evaluate(() => window.pass("open_1.parquet"));
  const firstReqs = reqs.length - first;
  console.log(`  -> ${n1} rows, ${firstReqs} upstream request(s)`);
  ok(n1 > 0, "the first open reads the table");
  ok(firstReqs > 0, "…from the network, since nothing was cached yet");

  // The cache is written as the body streams past; give the rename its turn.
  await new Promise(r => setTimeout(r, 800));

  console.log("\n  coming back (new registration, same object):");
  const second = reqs.length;
  const n2 = await page.evaluate(() => window.pass("open_2.parquet"));
  const secondReqs = reqs.length - second;
  console.log(`  -> ${n2} rows, ${secondReqs} upstream request(s)`);
  ok(n2 === n1, "the second open reads the same table");
  ok(secondReqs === 0,
     `…without touching the network (${secondReqs} request(s) went upstream)`);

  if (secondReqs > 0) {
    console.log("\n  what it asked for the second time, and whether the first pass stored it:");
    for (const r of reqs.slice(second)) console.log(`    ${r.method} ${r.range || "(whole file)"}`);
    console.log("  first pass asked for:");
    for (const r of reqs.slice(first, second)) console.log(`    ${r.method} ${r.range || "(whole file)"}`);
  }
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  await browser?.close().catch(() => {});
  pageServer.close();
  await proxy.close();
  upstream.close();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

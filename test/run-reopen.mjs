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
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { startProxy } from "../extension/src/proxy.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TOKEN = "test-token-not-a-real-one";
const PAGE_PORT = 5201;

// The shape a Fabric Iceberg data file has: under Tables/, .parquet, no query string.
const OBJECT = "/ws/lh.Lakehouse/Tables/dbo/sales/data_0.parquet";

// Size matters to the question being asked. DuckDB is entitled to fetch a small file whole
// rather than range-read it — that is the cheaper answer — so measuring a 5MB fixture says
// nothing about a Fabric data file, which is routinely hundreds of megabytes.
//   REOPEN_FIXTURE_MB=200 node test/run-reopen.mjs
const WANT_MB = Number(process.env.REOPEN_FIXTURE_MB || 0);
const FIXTURE = WANT_MB
  ? join(root, "test", "fixtures", `sample-${WANT_MB}mb.parquet`)
  : join(root, "test", "fixtures", "sample.parquet");

if (WANT_MB) {
  try {
    await readFile(FIXTURE);
  } catch {
    // ~26 bytes/row after compression for this shape, measured; close enough to aim with.
    const rows = Math.round(WANT_MB * 1e6 / 13);
    console.log(`generating ${FIXTURE} (~${WANT_MB}MB, ${rows} rows) ...`);
    execFileSync("duckdb", ["-c",
      `COPY (SELECT i AS id, i * 2 AS d, 'row ' || i AS s FROM range(${rows}) t(i))` +
      ` TO '${FIXTURE.replace(/\\/g, "/")}' (FORMAT PARQUET)`], { stdio: "inherit" });
  }
}

const parquet = await readFile(FIXTURE);
console.log(`fixture: ${(parquet.length / 1e6).toFixed(1)} MB\n`);

const reqs = [];
const upstream = http.createServer((req, res) => {
  const entry = { method: req.method, range: req.headers.range || null, bytes: 0 };
  reqs.push(entry);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
  const head = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), parquet.length - 1) : parquet.length - 1;
    const slice = parquet.subarray(start, end + 1);
    if (req.method !== "HEAD") entry.bytes = slice.length;
    res.writeHead(206, { ...head, "content-length": String(slice.length),
                         "content-range": `bytes ${start}-${end}/${parquet.length}` });
    res.end(req.method === "HEAD" ? undefined : slice);
    return;
  }
  if (req.method !== "HEAD") entry.bytes = parquet.length;
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
  window.pass = async (name, directIO = false) => {
    await db.registerFileURL(name, URL_UNDER_TEST, duckdb.DuckDBDataProtocol.HTTP, directIO);
    const r = await conn.query(\`SELECT count(*) AS n FROM read_parquet('\${name}')\`);
    return Number(r.toArray()[0].n);
  };

  // What a peek actually is: a hundred rows off the front, not the whole file. The count(*)
  // above can be answered from parquet metadata alone, so it is the wrong shape to measure
  // a preview with.
  window.peek = async (name, directIO) => {
    await db.registerFileURL(name, URL_UNDER_TEST, duckdb.DuckDBDataProtocol.HTTP, directIO);
    const r = await conn.query(\`SELECT * FROM read_parquet('\${name}') LIMIT 100\`);
    return r.toArray().length;
  };

  // The other way to read an http parquet: hand the URL to httpfs inside the engine
  // instead of registering it with the JS runtime. Different code path entirely — httpfs
  // knows what a parquet footer is and can ask for the bytes it wants.
  window.peekDirect = async () => {
    const r = await conn.query(
      \`SELECT * FROM read_parquet('\${URL_UNDER_TEST}') LIMIT 100\`);
    return r.toArray().length;
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

  // ---------------------------------------------------------------------------
  // What a preview costs, with and without directIO
  // ---------------------------------------------------------------------------
  // peekTable exists so that "show me this table" reads ONE data file instead of all of
  // them. If duckdb-wasm answers that by downloading the file whole, a hundred rows costs
  // the whole file, and no amount of caching makes the first look cheap. `directIO` is the
  // flag that decides, and data.js has always passed false.
  console.log("\n  --- what a 100-row preview costs ---");
  const measure = async (label, directIO, name) => {
    await proxy.clearCache();          // each measurement starts cold, or it measures the cache
    const at = reqs.length;
    const t0 = Date.now();
    const rows = await page.evaluate(([n, d]) => window.peek(n, d), [name, directIO]);
    const took = Date.now() - t0;
    const mine = reqs.slice(at);
    const ranged = mine.filter(r => r.range).length;
    const bytes = mine.reduce((n, r) => n + (r.bytes || 0), 0);
    console.log(`  ${label.padEnd(18)} ${rows} rows · ${mine.length} request(s) ` +
                `(${ranged} ranged) · ${(bytes / 1e6).toFixed(2)}MB · ${took}ms`);
    return { rows, reqs: mine.length, ranged, bytes, took };
  };

  const off = await measure("directIO false", false, "peek_off.parquet");
  const on = await measure("directIO true", true, "peek_on.parquet");
  ok(off.rows === 100 && on.rows === 100, "both settings return the preview");

  // Same query, but the URL goes to httpfs rather than through registerFileURL.
  let direct = null;
  try {
    await proxy.clearCache();
    const at = reqs.length;
    const t0 = Date.now();
    const rows = await page.evaluate(() => window.peekDirect());
    const took = Date.now() - t0;
    const mine = reqs.slice(at);
    direct = {
      rows, reqs: mine.length,
      ranged: mine.filter(r => r.range).length,
      bytes: mine.reduce((n, r) => n + (r.bytes || 0), 0), took,
    };
    console.log(`  ${"httpfs, url direct".padEnd(18)} ${rows} rows · ${direct.reqs} request(s) ` +
                `(${direct.ranged} ranged) · ${(direct.bytes / 1e6).toFixed(2)}MB · ${took}ms`);
  } catch (e) {
    console.log(`  ${"httpfs, url direct".padEnd(18)} unavailable — ${e.message}`);
  }

  const best = [off, on, direct].filter(Boolean).sort((a, b) => a.bytes - b.bytes)[0];
  console.log(`\n  verdict: cheapest preview transfers ${(best.bytes / 1e6).toFixed(2)}MB ` +
              `of a ${(parquet.length / 1e6).toFixed(2)}MB file` +
              (best === direct ? " — httpfs over the URL, not registerFileURL"
               : best === on ? " — directIO true"
               : " — no change beats what data.js already does"));
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

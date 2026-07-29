// The native engine, and the bridge that carries it into the page.
//
// Two halves:
//   Part 1 — engine-host.js on its own, in Node. The eight calls data.js makes, plus the
//            registered-name substitution that replaces duckdb-wasm's virtual file
//            registry. That substitution is the one genuinely new idea in the port, so it
//            is tested for what it must NOT touch as much as for what it must.
//   Part 2 — the REAL extension/app page in real Chrome, with the panel's message bridge
//            wired to a real engine-host. data.js runs unchanged; only what is underneath
//            it changed, and this is what proves the seam holds.
//
// No editor, no credentials, no lakehouse.
//
// Run: node test/run-engine-host.mjs
import http from "node:http";
import { readFile, stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../extension/src/engine-host.js");
const { rewriteHtml } = require("../extension/src/html.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(root, "extension", "app");
const PORT = 5207;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("ok  —", msg); }
                            else { fail++; console.log("FAIL—", msg); } };
const eq = (got, want, msg) =>
  ok(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);

const EXT_DIR = join(tmpdir(), "onelake-duckdb-extensions");
const TMP = await mkdtemp(join(tmpdir(), "onelake-engine-test-"));

// =============================================================================
// Part 1 — the engine on its own
// =============================================================================
console.log("--- engine-host ---");
{
  let boot = null;
  const h = createEngineHost({ extensionDir: EXT_DIR, onLog: b => { boot = b; } });

  const caps = await h.call("capabilities");
  ok(caps.httpfs, "httpfs loaded — this is what reads the loopback proxy");
  ok(caps.avro, "avro loaded — read_avro is the Iceberg manifest reader");
  ok(caps.excel, "excel loaded — gates whether .xlsx is offered");
  ok(caps.zipfs, "zipfs loaded — gates whether .zip is offered");
  ok(caps.h3, "h3 loaded");
  ok(boot && boot.totalMs >= 0, "…and the boot reported its stages");
  console.log(`   engine ready in ${boot ? boot.totalMs : "?"}ms ` +
              `(${(boot ? boot.stages : []).map(s => `${s.stage} ${s.ms}ms`).join(", ")})`);

  const r = await h.call("query", ["SELECT 42 AS a, 'hi' AS b"]);
  eq(r.rows[0].a, 42, "a query returns rows");
  eq(r.fields[0].type, "INTEGER", "…carrying DuckDB's own type names, not Arrow's");

  // An int64 past 2^53 cannot cross as a Number and BigInt cannot cross at all — VS Code
  // serialises panel messages as JSON. paths.js normalizeValue defines the contract and
  // the host has to honour it at the boundary.
  const big = await h.call("query", ["SELECT 9223372036854775807::BIGINT AS n, 7::BIGINT AS small"]);
  eq(big.rows[0].n, "9223372036854775807", "a bigint past 2^53 crosses exact, as a string");
  eq(big.rows[0].small, 7, "…and a small one crosses as a number");
  eq(JSON.stringify(big.rows).length > 0, true, "…so the whole batch is JSON-serialisable");

  // data.js reads the schema off the FIRST batch and there is always exactly one, even
  // for an empty result. A missing schema there is a silent empty grid.
  const empty = await h.call("query", ["SELECT 1 AS x WHERE false"]);
  eq(empty.numRows, 0, "an empty result has no rows");
  eq(empty.fields.length, 1, "…but still carries its schema");

  // Bigger than one batch, which is where the streaming cursor lives.
  const many = await h.call("query", ["SELECT i FROM range(45000) t(i)"]);
  eq(many.numRows, 45000, "a result larger than one batch comes back whole");
  eq(many.rows[44999].i, 44999, "…in order, to the last row");

  let batches = 0, streamed = 0;
  await h.call("stream", ["SELECT i FROM range(45000) t(i)"], b => { batches++; streamed += b.numRows; });
  eq(streamed, 45000, "streaming yields every row");
  ok(batches > 1, `…in more than one batch (${batches}) so a big result paints as it arrives`);

  // ---- the registered-name substitution, which replaces the wasm virtual registry ----
  await writeFile(join(TMP, "real.csv"), "a,b\n1,2\n3,4\n");
  await h.call("registerFileURL", ["data_1.parquet", join(TMP, "real.csv").replace(/\\/g, "/")]);
  const viaName = await h.call("query", ["SELECT * FROM read_csv('data_1.parquet')"]);
  eq(viaName.numRows, 2, "a registered name resolves to what it was registered as");

  // The safety property. Registered names are synthetic and counter-generated, so they
  // cannot collide with a user's identifiers — but a literal that was never registered
  // must survive untouched, or every string in every query is a substitution hazard.
  const untouched = await h.call("query", ["SELECT 'data_99.parquet' AS s, 'data_1' AS t"]);
  eq(untouched.rows[0].s, "data_99.parquet", "an UNregistered literal is left alone");
  eq(untouched.rows[0].t, "data_1", "…and a partial match of a registered name is not a match");

  await h.call("registerFileBuffer", ["m.csv", Buffer.from("x\n9\n")]);
  const buf = await h.call("query", ["SELECT * FROM read_csv('m.csv')"]);
  eq(buf.rows[0].x, 9, "a registered BUFFER is readable (this is how avro manifests arrive)");

  eq((await h.call("globFiles", ["m.csv"])).length, 1, "globFiles sees a registered name");
  await h.call("dropFile", ["m.csv"]);
  eq((await h.call("globFiles", ["m.csv"])).length, 0, "…and stops seeing it once dropped");
  let gone = false;
  try { await h.call("query", ["SELECT * FROM read_csv('m.csv')"]); }
  catch (_) { gone = true; }
  ok(gone, "…and the name no longer resolves, so a dropped file really is gone");

  await h.close();
}

// =============================================================================
// Part 2 — the real read path: native DuckDB through the signed loopback proxy
// =============================================================================
// This is what the extension actually does with data, and it was previously covered only
// for the wasm engine (run-proxy.mjs Part 2). Native DuckDB reads parquet over http via
// httpfs and — unlike duckdb-wasm, which only ever made whole-file GETs — it RANGE-reads.
// The proxy's cache already slices stored objects into 206s, so that is an improvement,
// but it is a different code path through the proxy and it deserves its own proof:
// the reads must be signed, and the second read must come off disk.
console.log("\n--- native DuckDB reading through the signed proxy ---");
{
  const { startProxy } = require("../extension/src/proxy.js");
  const TOKEN = "test-token-not-a-real-one";
  const FIXTURE = join(root, "test", "fixtures", "sample.parquet");

  let parquet = null;
  try { parquet = await readFile(FIXTURE); } catch (_) {}
  if (!parquet) {
    console.log("   (skipped — test/fixtures/sample.parquet absent; run test/run-proxy.mjs once to generate it)");
  } else {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ range: req.headers.range || null, auth: req.headers.authorization || null });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end("upstream saw no bearer token"); return;
      }
      const head = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), parquet.length - 1) : parquet.length - 1;
        const slice = parquet.subarray(start, end + 1);
        res.writeHead(206, { ...head, "content-length": String(slice.length),
                             "content-range": `bytes ${start}-${end}/${parquet.length}` });
        res.end(req.method === "HEAD" ? undefined : slice); return;
      }
      res.writeHead(200, { ...head, "content-length": String(parquet.length) });
      res.end(req.method === "HEAD" ? undefined : parquet);
    });
    await new Promise(r => upstream.listen(0, "127.0.0.1", r));
    const upBase = `http://127.0.0.1:${upstream.address().port}`;

    const cacheDir = await mkdtemp(join(tmpdir(), "onelake-native-read-"));
    const events = [];
    const proxy = await startProxy({
      getToken: async () => TOKEN,
      cacheDir,
      dfsUpstream: upBase,
      tableUpstream: upBase,
      onLog: e => events.push(e),
    });

    const h2 = createEngineHost({ extensionDir: EXT_DIR });
    try {
      // A REAL OneLake data-file path. The shape matters: cache.js tierOf() treats only
      // `/Tables/…*.parquet` (and a table's metadata avro) as immutable, and only an
      // immutable object gets the background whole-file fill. A flat `/ws/data.parquet`
      // is classified 'ttl', never filled, and every read would pay the network — which
      // is what this test found when it used one.
      const url = `${proxy.dfsOrigin}/ws/MyLh.Lakehouse/Tables/dbo/trips/data_0.parquet`;
      // Registered exactly as data.js registers a data file, then read through the same
      // read_parquet() shape loadTable builds.
      await h2.call("registerFileURL", ["data_1.parquet", url]);
      const r = await h2.call("query", ["SELECT count(*) AS n FROM read_parquet('data_1.parquet')"]);
      eq(Number(r.rows[0].n), 400000, "native DuckDB read a parquet file through the proxy");
      ok(seen.length > 0 && seen.every(s => s.auth === `Bearer ${TOKEN}`),
         `…and every upstream read was signed (${seen.length} request(s), none unauthenticated)`);
      ok(seen.some(s => s.range), "…by RANGE, which duckdb-wasm never did");

      // A ranged miss is served as asked and the WHOLE object is fetched behind it —
      // "spend disk, not network", so that every later range is a local slice. Awaited,
      // never slept on: without this the second query races the background fill and goes
      // to the network, which is exactly what this check exists to catch.
      await proxy.cacheIdle();

      const before = seen.length;
      const again = await h2.call("query",
        ["SELECT count(*) AS n FROM read_parquet('data_1.parquet') WHERE id < 10"]);
      eq(Number(again.rows[0].n), 10, "a second read answers correctly");
      eq(seen.length, before, "…entirely from the disk cache — the network was not touched again");
      ok(events.some(e => e.cache === "hit"), "…and the proxy logged it as a hit");
    } finally {
      await h2.close().catch(() => {});
      await proxy.close();
      upstream.close();
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// =============================================================================
// Part 3 — the real page, over the real bridge
// =============================================================================
console.log("\n--- extension/app in real Chrome, driven by the native engine ---");

const engine = createEngineHost({ extensionDir: EXT_DIR });
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "enginehost";
const CSP = [
  `default-src 'none'`,
  `img-src ${ORIGIN} data: blob:`,
  `font-src ${ORIGIN}`,
  `style-src ${ORIGIN} 'unsafe-inline'`,
  `script-src ${ORIGIN} 'nonce-${NONCE}'`,
  `connect-src ${ORIGIN}`,
].join("; ");

const MIME = { ".js": "text/javascript", ".html": "text/html; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".md": "text/markdown" };

const INDEX = await readFile(join(APP, "index.html"), "utf8");
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    if (path === "/") {
      const html = rewriteHtml(INDEX, {
        assetUrl: name => `${ORIGIN}/${name}`,
        nonce: NONCE,
        config: {
          auth: "none", host: "vscode",
          dfsOrigin: ORIGIN, tableOrigin: ORIGIN,
          readmeUrl: `${ORIGIN}/README.md`,
        },
        cspContent: CSP,
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    const file = path === "/README.md" ? join(root, "README.md") : join(APP, path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const lines = [];
  page.on("console", m => lines.push(m.text()));
  page.on("pageerror", e => lines.push(`[pageerror] ${e.message}`));

  // The panel's bridge, exactly as panel.js wires it: engine-call in, engine-batch and
  // engine-result out. Nothing about the page knows this is not the editor.
  await page.exposeBinding("__hostCall", async ({ page: p }, msg) => {
    try {
      const value = await engine.call(msg.method, msg.args || [],
        batch => p.evaluate(m => window.postMessage(m, "*"),
                            { type: "engine-batch", id: msg.id, batch }).catch(() => {}));
      return { type: "engine-result", id: msg.id, value };
    } catch (e) {
      return { type: "engine-error", id: msg.id, message: e.message, cancelled: !!e.cancelled };
    }
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      postMessage(m) {
        if (m && m.type === "engine-call") {
          window.__hostCall(m).then(r => window.postMessage(r, "*"));
        }
      },
    });
  });

  const t0 = Date.now();
  await page.goto(`${ORIGIN}/`);
  const booted = await page.waitForFunction(
    () => !document.getElementById("runBtn").disabled, { timeout: 60000 })
    .then(() => true, () => false);
  const bootMs = Date.now() - t0;
  ok(booted, `the page booted on the native engine (${bootMs}ms to an enabled Run button)`);

  if (!booted) {
    console.log("  status:", await page.evaluate(() => document.getElementById("status").textContent).catch(() => "?"));
    for (const l of lines) console.log("   ", l);
  } else {
    ok(!lines.some(l => l.includes("Loading DuckDB-WASM")),
       "…without fetching or compiling any WebAssembly");
    const bootLine = lines.find(l => l.startsWith("[engine] DuckDB ready"));
    ok(bootLine && bootLine.includes("native"), `…and reports itself native — ${bootLine || "(no line)"}`);

    // A real query, through data.js's own runSql, through the bridge, into the grid.
    await page.fill("#sqlEditor", "SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2, 'y' ORDER BY a");
    await page.click("#runBtn");
    await page.waitForFunction(
      () => document.querySelectorAll("#resultsTable tbody tr").length >= 2, { timeout: 30000 })
      .then(() => ok(true, "a query ran end to end and rendered rows"),
            () => ok(false, "a query ran end to end and rendered rows"));

    const cells = await page.evaluate(() =>
      [...document.querySelectorAll("#resultsTable tbody tr")].map(
        tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim())));
    eq(JSON.stringify(cells.slice(0, 2)), JSON.stringify([["1", "x"], ["2", "y"]]),
       "…with the right values in the right order");

    // Types reach the UI as DuckDB's names. This is the path arrowTypeName() short-circuits.
    await page.fill("#sqlEditor", "SELECT 1::BIGINT AS n");
    await page.click("#runBtn");
    await page.waitForFunction(
      () => (document.getElementById("resultsTable").textContent || "").includes("1"), { timeout: 30000 })
      .catch(() => {});
    const head = await page.evaluate(() =>
      (document.querySelector("#resultsTable thead") || {}).textContent || "");
    ok(/BIGINT/i.test(head), `…and column types are DuckDB's own — header said ${JSON.stringify(head.trim())}`);
  }
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  await browser?.close().catch(() => {});
  server.close();
  await engine.close().catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

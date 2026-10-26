// The native engine, and the bridge that carries it into the page.
//
// Two halves:
//   Part 1 — engine-host.js on its own, in Node. The calls data.js makes, the buffer
//            temp-file round trip that replaced duckdb-wasm's virtual file registry, and
//            the guards on the bridge's dispatch. The registry itself is GONE — URLs and
//            paths are spliced into the SQL by the caller — so what is tested is that
//            nothing rewrites a literal any more, in either direction.
//   Part 2 — the REAL app page in real Chrome, with the panel's message bridge
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
import { panelHost, servePanel } from "./panel-host.mjs";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../src/engine-host.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(root, "app");
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
  // The lockdown refuses every local path it was not told about; this one is the test's.
  const h = createEngineHost({ extensionDir: EXT_DIR, onLog: b => { boot = b; },
                               allowedPaths: [join(TMP, "real.csv")] });

  const { capabilities: caps } = await h.call("info");
  ok(caps.httpfs, "httpfs loaded — the https the Iceberg catalog and public URLs need");
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

  // ---- the registry is gone: SQL says what it means, and nothing rewrites it ----
  //
  // The caller splices real paths and URLs into its SQL now. Two properties matter: a
  // spliced path actually reads (there is no registry to translate it), and a literal
  // that LOOKS like the old synthetic names comes back exactly as written — the editor
  // bug the substitution era shipped (`SELECT 'data_3.parquet'` answering a OneLake URL)
  // must stay dead.
  await writeFile(join(TMP, "real.csv"), "a,b\n1,2\n3,4\n");
  const direct = await h.call("query",
    [`SELECT * FROM read_csv('${join(TMP, "real.csv").replace(/\\/g, "/")}')`]);
  eq(direct.numRows, 2, "a path spliced into the SQL reads directly — no registry needed");

  const userSql = await h.call("query", ["SELECT 'data_1.parquet' AS s"]);
  eq(userSql.rows[0].s, "data_1.parquet",
     "a literal that looks like a registered name is a plain literal, nothing rewrites it");

  let streamed2 = 0;
  await h.call("stream", ["SELECT 1 AS n"], () => { streamed2++; });
  eq(streamed2, 1, "stream() delivers batches through call()'s appended emit");

  // The dispatch guards: method names arrive from the webview.
  let protoRejected = false;
  try { await h.call("constructor", []); } catch (_) { protoRejected = true; }
  ok(protoRejected, "an inherited property is not an engine method");
  let argsRejected = false;
  try { await h.call("query", "SELECT 1"); } catch (_) { argsRejected = true; }
  ok(argsRejected, "non-array args are refused, not spread");

  // openTable without a credential: the two failure shapes a harness can reach.
  let noSource = "";
  try { await h.openTable({ workspace: "w", item: "i", schema: "dbo", table: "t" }); }
  catch (e) { noSource = e.message; }
  ok(/token source/.test(noSource), `openTable without a token source says so — "${noSource}"`);

  await h.close();
}

{
  // An engine WITH a token source that answers null: the signed-out shape.
  const h = createEngineHost({ extensionDir: EXT_DIR, getToken: async () => null });
  let signedOut = "";
  try { await h.openTable({ workspace: "w", item: "i", schema: "dbo", table: "t" }); }
  catch (e) { signedOut = e.message; }
  ok(/Not signed in/.test(signedOut), `openTable while signed out says so — "${signedOut}"`);
  await h.close();
}

// =============================================================================
// Part 3 — the real page, over the real bridge
// =============================================================================
console.log("\n--- app in real Chrome, driven by the native engine ---");

const host = panelHost({ dfsOrigin: `http://127.0.0.1:${PORT}`, tableOrigin: `http://127.0.0.1:${PORT}`,
                         engineOptions: { extensionDir: EXT_DIR } });
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "enginehost";
// The page as panel.js renders it (panel-host.mjs).
const server = http.createServer(async (req, res) => {
  if (!await servePanel(req, res, ORIGIN, { nonce: NONCE })) res.writeHead(404).end();
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

  // The panel's bridge, answered exactly as panel.js answers it (host.js).
  await host.install(page);
  await page.addInitScript(() => {
    window.__state = undefined;
    window.acquireVsCodeApi = () => ({
      getState: () => window.__state,
      setState: v => { window.__state = v; },
      postMessage(m) {
        if (m && m.type === "call") {
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

    // Types reach the UI as DuckDB's own names.
    await page.fill("#sqlEditor", "SELECT 1::BIGINT AS n");
    await page.click("#runBtn");
    // The previous result also has a "1" in it, so wait for THIS result's header.
    await page.waitForFunction(
      () => /n/.test((document.querySelector("#resultsTable thead") || {}).textContent || ""),
      { timeout: 30000 }).catch(() => {});
    const head = await page.evaluate(() =>
      (document.querySelector("#resultsTable thead") || {}).textContent || "");
    ok(/BIGINT/i.test(head), `…and column types are DuckDB's own — header said ${JSON.stringify(head.trim())}`);
  }
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  await browser?.close().catch(() => {});
  server.close();
  await host.close().catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

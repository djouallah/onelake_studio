// run-table-stats.mjs — hand verifier for the Stats tab, against the REAL lakehouse.
// Not part of CI (needs a live storage token): drives the real UI headlessly with the
// SW blocked (its controller stubbed so selectTable's gate passes) and proxies both
// OneLake hosts through node with the token injected + CORS added — the app then runs
// exactly its production read path, ranged parquet reads included. Tables under test live
// in testing/dbt_delta.Lakehouse (landing.fct_price_today, mart.dim_calendar) and a CI
// rebuilds them, so the expected row/file counts are read from each table's own metadata
// at run time (expectedFor) rather than hardcoded — the assertion is that the UI agrees
// with the metadata, which is the card's whole claim.
// Keep tables SMALL: a single >100MB interception payload kills headless Chrome's CDP
// pipe (measured — "Too large read data is pending", devtools_pipe_handler capacity).
// Run:  OLS_TOKEN=$(az account get-access-token --resource https://storage.azure.com \
//         --tenant <tenant> --query accessToken -o tsv) node test/run-table-stats.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const TOKEN = process.env.OLS_TOKEN;
if (!TOKEN) { console.log("set OLS_TOKEN"); process.exit(2); }

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5199;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const file = join(root, "site", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// Real request, real response — only the token and CORS are added in the middle.
async function proxy(route) {
  const req = route.request();
  if (req.method() === "OPTIONS")
    return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      "access-control-allow-methods": "*" } });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const range = req.headers()["range"];
  if (range) headers.range = range;
  let resp;
  try {
    resp = await fetch(req.url(), { method: req.method(), headers });
  } catch (e) { return route.fulfill({ status: 502, body: String(e) }); }
  const body = Buffer.from(await resp.arrayBuffer());
  // accept-ranges is asserted, not forwarded: OneLake serves ranges but may not say so
  // on HEAD, and without the header DuckDB falls back to downloading the WHOLE file —
  // which also kills headless Chrome (a >100MB interception exceeds the CDP pipe cap).
  const h = { "access-control-allow-origin": "*", "access-control-expose-headers": "*",
              "accept-ranges": "bytes" };
  for (const k of ["content-type", "content-range", "etag"]) {
    const v = resp.headers.get(k); if (v) h[k] = v;
  }
  // A HEAD has no body for playwright to size — DuckDB reads the file size off this.
  if (req.method() === "HEAD" && resp.headers.get("content-length"))
    h["content-length"] = resp.headers.get("content-length");
  if (process.env.OLS_DEBUG)
    console.log("[proxy]", resp.status, req.method(), req.url().slice(0, 140));
  return route.fulfill({ status: resp.status, headers: h, body });
}

// The expected numbers are READ from the table's own metadata, never hardcoded: these are
// live tables that a CI rebuilds, and a harness that fails because the data grew is a
// harness people learn to ignore. The real assertion is that the UI agrees with the
// metadata — which is exactly what the Stats card claims to show.
async function expectedFor(item, schema, table) {
  const base = "https://onelake.dfs.fabric.microsoft.com/testing/" +
               `${item}/Tables/${schema}/${table}/metadata`;
  const h = { authorization: `Bearer ${TOKEN}` };
  const v = (await (await fetch(`${base}/version-hint.text`, { headers: h })).text()).trim();
  const meta = await (await fetch(`${base}/v${v}.metadata.json`, { headers: h })).json();
  const snap = (meta.snapshots || []).find(
    s => String(s["snapshot-id"]) === String(meta["current-snapshot-id"]));
  const su = (snap || {}).summary || {};
  return { rows: Number(su["total-records"]).toLocaleString("en"),
           files: Number(su["total-data-files"]) };
}

let code = 1;
const fails = [];
const check = (ok, name) => { console.log(`${ok ? "ok " : "FAIL"} — ${name}`); if (!ok) fails.push(name); };
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    // selectTable refuses without a controlling SW; there is none when the SW is blocked.
    const fake = { state: "activated", postMessage: () => {} };
    Object.defineProperty(ServiceWorkerContainer.prototype, "controller",
      { get: () => fake });
  });
  await ctx.route(u => u.pathname.endsWith("/config.js"),
    r => r.fulfill({ contentType: "text/javascript",
      body: "window.ONELAKE_STUDIO_CONFIG = { auth: 'none' };" }));
  await ctx.route(u => u.hostname === "onelake.dfs.fabric.microsoft.com", proxy);
  await ctx.route(u => u.hostname === "onelake.table.fabric.microsoft.com", proxy);

  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  page.on("crash", () => console.log("[page CRASHED]"));
  page.on("close", () => console.log("[page closed]"));
  browser.on("disconnected", () => console.log("[browser disconnected]"));
  process.on("unhandledRejection", e => console.log("[unhandled]", e?.message || e));
  if (process.env.OLS_DEBUG) page.on("console", m => console.log("[page]", m.text().slice(0, 400)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById("wsSelect").disabled, { timeout: 30000 });
  await page.fill("#wsSelect", "testing");
  await page.dispatchEvent("#wsSelect", "input");
  await page.waitForFunction(() => document.getElementById("itemSelect").options.length > 1,
    { timeout: 30000 });
  await page.selectOption("#itemSelect", "dbt_delta.Lakehouse");
  await page.waitForFunction(() => document.getElementById("tableList").innerText.includes("fct_price_today"),
    { timeout: 60000 });

  check(await page.locator("#viewBar").isHidden(), "no table selected yet — no Stats|Data bar");

  // --- Tier 1: selecting a table shows statistics, and reads no data to do it. ---
  const want = await expectedFor("dbt_delta.Lakehouse", "landing", "fct_price_today");
  console.log(`(metadata says ${want.rows} rows in ${want.files} file(s))`);
  await page.locator(".tableItem", { hasText: /^fct_price_today$/ }).first().click();
  await page.waitForFunction(() => !document.getElementById("statsView").hidden,
    { timeout: 60000 });
  check(true, "selection lands on the Stats view with no click");
  check(await page.locator("#resultsTable").isHidden(), "…and no grid of rows");
  const card = await page.locator("#statsView").innerText();
  check(card.includes(want.rows), `row count matches the metadata (saw: ${card.split("\n")[0]}…)`);
  check(new RegExp(`Data files\\s*${want.files}\\b`).test(card), "data file count matches");
  check(/\d+ KB/.test(card), "total size from the snapshot summary");
  check(card.includes("zstd"), "compression codec from the table properties");
  check(card.includes("Iceberg v2"), "format version");
  check(!/V-Order/.test(card), "no V-Order line — the metadata doesn't carry it (probed)");
  check(/SETTLEMENTDATE|RRP|DUID/i.test(card), "columns listed from the Iceberg schema");
  check(/no data files have been read yet/i.test(card), "the card says nothing was read");
  const status1 = await page.locator("#status").innerText();
  check(/statistics only, no data read/i.test(status1), `status says the same (${status1})`);

  check(await page.locator("#viewStats").evaluate(el => el.classList.contains("active")),
    "Stats is the active tab, and it comes first");

  // --- Tier 2: the Data tab reads ONE file, and says so. ---
  await page.click("#viewData");
  await page.waitForFunction(() => {
    const t = document.getElementById("resultsTable");
    return !t.hidden && t.innerText.trim().length > 0;
  }, { timeout: 120000 });
  check(await page.locator("#statsView").isHidden(), "Data tab replaces the card with rows");
  const status2 = await page.locator("#status").innerText();
  check(new RegExp(`of ${want.files} file\\(s\\)`).test(status2) && /not read/.test(status2),
    `status names what was NOT read (${status2})`);

  // Back and forth must not re-read anything: the peek is kept.
  await page.click("#viewStats");
  check(!(await page.locator("#statsView").isHidden()), "Stats comes back");
  await page.click("#viewData");
  check(!(await page.locator("#resultsTable").isHidden()), "…and Data restores the same rows");

  // --- SQL that does not name the table must not bind it. ---
  await page.fill("#sqlEditor", "SELECT 42 AS answer");
  await page.click("#runBtn");
  await page.waitForFunction(() => {
    const t = document.getElementById("resultsTable");
    return !t.hidden && t.innerText.includes("answer");
  }, { timeout: 30000 });
  check(await page.evaluate(() => document.getElementById("status").innerText)
    .then(s => !/file\(s\), read on demand/.test(s)),
    "a query that never mentions the table does not open it");

  // --- Tier 3: Preview binds the table for real. ---
  await page.click("#previewBtn");
  await page.waitForFunction(() => {
    const s = document.getElementById("status").innerText;
    return /read on demand/.test(s) || /Load failed/.test(s);
  }, { timeout: 180000 });
  const status3 = await page.locator("#status").innerText();
  check(new RegExp(`${want.files} file\\(s\\), read on demand`).test(status3),
    `Preview opened the table (${status3})`);
  check((await page.locator("#resultsTable").innerText()).length > 0, "…and rows are on screen");

  // The card is richer once bound, and still the same table's numbers.
  await page.click("#viewStats");
  const card2 = await page.locator("#statsView").innerText();
  check(card2.includes(want.rows) && /nothing was scanned/.test(card2),
    "the card updates to the opened table's own note");

  // --- Switching tables goes back to statistics-only for the new one. ---
  const want2 = await expectedFor("dbt_delta.Lakehouse", "mart", "dim_calendar");
  await page.locator(".tableItem", { hasText: /^dim_calendar$/ }).first().click();
  await page.waitForFunction(
    rows => {
      const v = document.getElementById("statsView");
      return !v.hidden && v.innerText.includes(rows);
    }, want2.rows, { timeout: 60000 });
  const card3 = await page.locator("#statsView").innerText();
  check(!card3.includes(want.rows), "second table shows its own stats, not the first table's");
  check(await page.locator("#resultsTable").isHidden(),
    "…and reads no rows just because the previous table was open");

  if (!fails.length) { console.log("RESULT: OK — stats tab verified against the real lakehouse"); code = 0; }
  else console.log(`RESULT: FAILED — ${fails.length}: ${fails.join("; ")}`);
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

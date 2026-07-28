// run-table-stats.mjs — hand verifier for the Stats tab, against the REAL lakehouse.
// Not part of CI (needs a live storage token): drives the real UI headlessly with the
// SW blocked (its controller stubbed so selectTable's gate passes) and proxies both
// OneLake hosts through node with the token injected + CORS added — the app then runs
// exactly its production read path, ranged parquet reads included. Expected numbers are
// from testing/dbt_delta.Lakehouse (landing.fct_price_today, mart.dim_calendar); if that
// data is rebuilt, re-probe the snapshot summaries and update the literals.
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

  check(await page.locator("#viewBar").isHidden(), "no table open yet — no Data|Stats bar");

  // Open landing.fct_price_today: 6,995 rows / 4 files / 564,322 B / zstd (probed).
  await page.locator(".tableItem", { hasText: /^fct_price_today$/ }).first().click();
  await page.waitForFunction(() => !document.getElementById("viewBar").hidden, { timeout: 120000 });
  check(true, "table opened and the Data|Stats bar appeared");
  check(await page.locator("#statsView").isHidden(), "stats stay hidden until asked");

  await page.click("#viewStats");
  const card = await page.locator("#statsView").innerText();
  check(!(await page.locator("#statsView").isHidden()), "Stats click shows the card");
  check(await page.locator("#resultsTable").isHidden(), "…and covers the grid");
  check(card.includes("6,995"), `rows on the card (saw: ${card.split("\n")[0]}…)`);
  check(/Data files\s*4\b/.test(card), "4 data files");
  check(/\d+ KB/.test(card), "total size from the snapshot summary");
  check(card.includes("zstd"), "compression codec from the table properties");
  check(card.includes("Iceberg v2"), "format version");
  check(!/V-Order/.test(card), "no V-Order line — the metadata doesn't carry it (probed)");
  check(/nothing was scanned/.test(card), "provenance note");

  await page.click("#viewData");
  check(await page.locator("#statsView").isHidden(), "Data click hides the card");
  check(!(await page.locator("#resultsTable").isHidden()), "…and the grid is back");

  // A new result must snap the view back to Data even if Stats was up.
  await page.click("#viewStats");
  await page.fill("#sqlEditor", "SELECT 1 AS one");
  await page.click("#runBtn");
  await page.waitForFunction(() => {
    const t = document.getElementById("resultsTable");
    return !t.hidden && t.innerText.includes("one");
  }, { timeout: 30000 });
  check(await page.locator("#statsView").isHidden(), "a new result snaps back to the Data view");
  check(!(await page.locator("#viewBar").isHidden()), "…but the bar stays while the table is open");

  // Stats after the snap-back still render (from the cached info), for the same table.
  await page.click("#viewStats");
  check((await page.locator("#statsView").innerText()).includes("6,995"),
    "stats re-render from cache after a query");

  // Switching tables: bar hides during the load, then shows the NEW table's numbers.
  await page.locator(".tableItem", { hasText: /^dim_calendar$/ }).first().click();
  await page.waitForFunction(() => !document.getElementById("viewBar").hidden, { timeout: 120000 });
  await page.click("#viewStats");
  const card2 = await page.locator("#statsView").innerText();
  check(card2.includes("3,197") && !card2.includes("6,995"),
    "second table shows its own stats, not the first table's");

  if (!fails.length) { console.log("RESULT: OK — stats tab verified against the real lakehouse"); code = 0; }
  else console.log(`RESULT: FAILED — ${fails.length}: ${fails.join("; ")}`);
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

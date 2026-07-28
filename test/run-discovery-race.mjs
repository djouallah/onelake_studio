// Discovery regression net, no credentials: drive the real signed-in UI (auth:'none' via a
// routed config.js, SW blocked so the route sees every request) against a faked OneLake.
//   1. Last click wins: item A's catalog answers slowly, B's instantly; click A then B —
//      the sidebar must show B's tables. Pre-catSeq, A's listing painted over B's.
//   2. Per-item ircOff: item C's catalog 400s (DFS walk fallback); item D picked next must
//      still be tried against the catalog. Pre-fix, one failure turned it off for the session.
// Not part of CI — a hand tool, like run-boot-smoke. Run: node test/run-discovery-race.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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

const WS = "ws1";
const ITEMS = ["A.Lakehouse", "B.Lakehouse", "C.Lakehouse", "D.Lakehouse"];
const tableFor = item => `${item[0].toLowerCase()}_table`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Cross-origin fetches still get CORS-checked against fulfilled responses.
const json = (route, body, status = 200) => route.fulfill({
  status, contentType: "application/json",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

// --- Fake DFS: workspace list, item list, and a real Tables/ walk for C only. ---
const dfs = new Map([
  ["", ITEMS.map(n => ({ name: n, isDirectory: "true" }))],
  ["C.Lakehouse/Tables", [{ name: "C.Lakehouse/Tables/c_table", isDirectory: "true" }]],
  ["C.Lakehouse/Tables/c_table",
    [{ name: "C.Lakehouse/Tables/c_table/metadata", isDirectory: "true" }]],
]);
async function dfsHandler(route) {
  const u = new URL(route.request().url());
  if (u.searchParams.get("resource") === "account")
    return json(route, { fileSystems: [{ name: WS }] });
  const dir = u.searchParams.get("directory") ?? "";
  return json(route, { paths: dfs.get(dir) || [] });
}

// --- Fake Iceberg REST catalog: A slow, C broken, B/D instant. ---
const ircLog = [];
// Resolves once A's LAST discovery response (its tables list) has been served — the moment
// a stale listing has everything it needs to (mis)paint the sidebar.
let aServed;
const aTablesServed = new Promise(r => { aServed = r; });
async function ircHandler(route) {
  const u = new URL(route.request().url());
  const path = decodeURIComponent(u.pathname);   // /iceberg/v1/...
  ircLog.push(path + u.search);
  const warehouse = u.searchParams.get("warehouse") ||
    (path.match(/\/v1\/ws1\/([^/]+)/) || [])[1] && `ws1/${(path.match(/\/v1\/ws1\/([^/]+)/))[1]}`;
  if (!warehouse) return json(route, {}, 400);
  const item = warehouse.split("/")[1];
  if (item === "C.Lakehouse") return json(route, { error: "no catalog for you" }, 400);
  if (item === "A.Lakehouse" && path.endsWith("/config")) await sleep(1500);
  if (path.endsWith("/config")) return json(route, {});
  if (path.endsWith("/namespaces")) return json(route, { namespaces: [["dbo"]] });
  if (path.endsWith("/tables")) {
    await json(route, { identifiers: [{ name: tableFor(item) }] });
    if (item === "A.Lakehouse") aServed();
    return;
  }
  return json(route, {}, 404);
}

let code = 1;
const fails = [];
const check = (ok, name) => { console.log(`${ok ? "ok " : "FAIL"} — ${name}`); if (!ok) fails.push(name); };
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.route(u => u.pathname.endsWith("/config.js"),
    r => r.fulfill({ contentType: "text/javascript",
      body: "window.ONELAKE_STUDIO_CONFIG = { auth: 'none' };" }));
  await ctx.route(u => u.hostname === "onelake.dfs.fabric.microsoft.com", dfsHandler);
  await ctx.route(u => u.hostname === "onelake.table.fabric.microsoft.com", ircHandler);

  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // Engine booted (connect awaits engineReady — get it out of the race's way) and the
  // no-auth session has listed the fake workspace.
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById("wsSelect").disabled, { timeout: 30000 });
  await page.fill("#wsSelect", WS);
  await page.dispatchEvent("#wsSelect", "input");
  await page.waitForFunction(() => document.getElementById("itemSelect").options.length > 1,
    { timeout: 15000 });

  // --- 1. Last click wins ---
  await page.selectOption("#itemSelect", "A.Lakehouse");
  await sleep(200);   // A's listing is in flight (its catalog stalls 1.5 s)
  await page.selectOption("#itemSelect", "B.Lakehouse");
  await page.waitForFunction(() => document.getElementById("tableList").innerText.includes("b_table"),
    { timeout: 15000 });
  // A's stale listing now has its full answer — give it every chance to resume and misbehave.
  await aTablesServed;
  await sleep(500);
  const list1 = await page.locator("#tableList").innerText();
  const status1 = await page.locator("#status").innerText();
  check(list1.includes("b_table") && !list1.includes("a_table"),
    `last click wins the sidebar (saw: ${list1.trim().replace(/\s+/g, " ")})`);
  check(status1.includes("B.Lakehouse"),
    `last click wins the status bar (saw: ${status1})`);

  // --- 2. ircOff is per item ---
  await page.selectOption("#itemSelect", "C.Lakehouse");
  await page.waitForFunction(() => document.getElementById("tableList").innerText.includes("c_table"),
    { timeout: 15000 });
  check(true, "catalog-less item C still lists via the DFS walk");
  const before = ircLog.length;
  await page.selectOption("#itemSelect", "D.Lakehouse");
  await page.waitForFunction(() => document.getElementById("tableList").innerText.includes("d_table"),
    { timeout: 15000 });
  const dCalls = ircLog.slice(before).filter(p => p.includes("D.Lakehouse"));
  check(dCalls.length > 0,
    `item D still uses the catalog after C's failure (${dCalls.length} catalog call(s))`);

  if (!fails.length) { console.log("RESULT: OK — discovery race + per-item ircOff hold"); code = 0; }
  else console.log(`RESULT: FAILED — ${fails.length} check(s): ${fails.join("; ")}`);
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

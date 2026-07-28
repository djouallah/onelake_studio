// Discovery regression net, no credentials: drive the real signed-in UI (auth:'none' via a
// routed config.js, SW blocked so the route sees every request) against a faked OneLake.
//   1. Last click wins: item A's catalog answers slowly, B's instantly; click A then B —
//      the sidebar must show B's tables. Pre-catSeq, A's listing painted over B's.
//   2. A catalog failure is loud and NOT remembered: item C's catalog 400s, so the sidebar
//      must say so in the catalog's own words rather than showing an empty list; item D
//      picked next is unaffected; and re-picking C tries again rather than staying dead.
//      (Until the DFS walk was deleted, C quietly fell back to listing Tables/ instead.)
//   3. Tables are the catalog's alone: no DFS listing under Tables/ may happen at all.
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

// --- Fake DFS: the workspace list and the item list, and nothing else. There are
// deliberately no Tables/ fixtures: a walk is exactly what must never happen now. ---
const dfs = new Map([
  ["", ITEMS.map(n => ({ name: n, isDirectory: "true" }))],
]);
const dfsDirs = [];   // every directory the app asked DFS to list — check 3 reads this
async function dfsHandler(route) {
  const u = new URL(route.request().url());
  if (u.searchParams.get("resource") === "account")
    return json(route, { fileSystems: [{ name: WS }] });
  const dir = u.searchParams.get("directory") ?? "";
  dfsDirs.push(dir);
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
  // The real service's error shape, verified against OneLake: {error:{message}}. A fake
  // that answers a different shape tests the app against a service that doesn't exist.
  if (item === "C.Lakehouse")
    return json(route, { error: { message: "no catalog for you" } }, 400);
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

  // --- 2. A catalog failure is visible, isolated, and not remembered ---
  const cBefore = ircLog.filter(p => p.includes("C.Lakehouse")).length;
  await page.selectOption("#itemSelect", "C.Lakehouse");
  await page.waitForFunction(
    () => document.getElementById("tableList").innerText.includes("Could not list tables"),
    { timeout: 15000 });
  const statusC = await page.locator("#status").innerText();
  check(/no catalog for you/.test(statusC),
    `C's failure surfaces the catalog's own words (saw: ${statusC})`);
  check(await page.locator("#status").evaluate(el => el.className.includes("error")),
    "…as an error, not a quiet empty list");

  const before = ircLog.length;
  await page.selectOption("#itemSelect", "D.Lakehouse");
  await page.waitForFunction(() => document.getElementById("tableList").innerText.includes("d_table"),
    { timeout: 15000 });
  const dCalls = ircLog.slice(before).filter(p => p.includes("D.Lakehouse"));
  check(dCalls.length > 0,
    `item D still uses the catalog after C's failure (${dCalls.length} catalog call(s))`);

  // Re-picking the failed item must try again — there is no session-wide off switch now
  // that there is no walk to fall back to.
  await page.selectOption("#itemSelect", "C.Lakehouse");
  await page.waitForFunction(
    () => document.getElementById("tableList").innerText.includes("Could not list tables"),
    { timeout: 15000 });
  check(ircLog.filter(p => p.includes("C.Lakehouse")).length > cBefore + 1,
    "re-picking a failed item retries the catalog rather than staying dead");

  // --- 3. Nothing walked Tables/ over DFS ---
  check(!dfsDirs.some(d => /(^|\/)Tables(\/|$)/.test(d)),
    `no DFS listing under Tables/ (saw: ${dfsDirs.join(", ") || "none"})`);

  if (!fails.length) { console.log("RESULT: OK — discovery race, loud recoverable catalog failure, no DFS walk"); code = 0; }
  else console.log(`RESULT: FAILED — ${fails.length} check(s): ${fails.join("; ")}`);
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

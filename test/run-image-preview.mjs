// Image preview, no credentials: drive the real signed-in UI (auth:'none' via a routed
// config.js, SW blocked so the route sees every request) against a faked OneLake whose
// Files/ holds a .png. Checks: the image row is clickable (not greyed), clicking renders
// the pixels in #docView over a blob URL, the query machinery stays off (docBar hidden,
// Preview/CSV disabled), and switching to a second image revokes the first blob URL.
// Not part of CI — a hand tool, like run-boot-smoke. Run: node test/run-image-preview.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5197;
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
const ITEM = "A.Lakehouse";
// 1×1 PNGs — red and blue — so <img>.naturalWidth === 1 proves the bytes decoded.
const PNG_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PNG_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/p+FnzAAAAABJRU5ErkJggg==",
  "base64");
const json = (route, body, status = 200) => route.fulfill({
  status, contentType: "application/json",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

// --- Fake DFS: workspace list, item list, Files/ with two images + a dead row, raw reads. ---
const dfs = new Map([
  ["", [{ name: ITEM, isDirectory: "true" }]],
  [`${ITEM}/Files`, [
    { name: `${ITEM}/Files/chart.png`, isDirectory: "false", contentLength: PNG_RED.length },
    { name: `${ITEM}/Files/logo.PNG`, isDirectory: "false", contentLength: PNG_BLUE.length },
    { name: `${ITEM}/Files/data.bin`, isDirectory: "false", contentLength: 5 },
  ]],
]);
const blobs = new Map([
  [`/${WS}/${ITEM}/Files/chart.png`, PNG_RED],
  [`/${WS}/${ITEM}/Files/logo.PNG`, PNG_BLUE],
]);
async function dfsHandler(route) {
  const u = new URL(route.request().url());
  if (u.searchParams.get("resource") === "account")
    return json(route, { fileSystems: [{ name: WS }] });
  if (u.searchParams.has("directory"))
    return json(route, { paths: dfs.get(u.searchParams.get("directory")) || [] });
  const body = blobs.get(decodeURIComponent(u.pathname));
  if (!body) return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } });
  return route.fulfill({ status: 200, contentType: "application/octet-stream",
    headers: { "access-control-allow-origin": "*" }, body });
}
// --- Fake Iceberg REST catalog: an item with zero tables. ---
async function ircHandler(route) {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  if (path.endsWith("/config")) return json(route, {});
  if (path.endsWith("/namespaces")) return json(route, { namespaces: [] });
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

  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById("wsSelect").disabled, { timeout: 30000 });
  await page.fill("#wsSelect", WS);
  await page.dispatchEvent("#wsSelect", "input");
  await page.waitForFunction(() => document.getElementById("itemSelect").options.length > 1,
    { timeout: 15000 });
  await page.selectOption("#itemSelect", ITEM);
  await page.waitForFunction(() => document.getElementById("status").innerText.includes("table(s)"),
    { timeout: 15000 });
  await page.click("#tabFiles");

  // --- Rows: images clickable, unknown binary stays a dead greyed row. ---
  const pngRow = page.locator(".fileItem", { hasText: "chart.png" });
  await pngRow.waitFor({ timeout: 15000 });
  check(!(await pngRow.getAttribute("class")).includes("plain"), "an image row is not greyed out");
  const binRow = page.locator(".fileItem", { hasText: "data.bin" });
  check((await binRow.getAttribute("class")).includes("plain"), "a .bin row stays a dead row");

  // --- Click: pixels render over a blob URL; the query machinery stays off. ---
  await pngRow.click();
  await page.waitForFunction(() => {
    const img = document.querySelector("#docView img");
    return img && img.complete && img.naturalWidth === 1;
  }, { timeout: 15000 });
  const src1 = await page.locator("#docView img").getAttribute("src");
  check(src1.startsWith("blob:"), "the image renders over a blob URL, decoded 1×1");
  check(await page.locator("#docBar").isHidden(), "Pretty|Raw bar stays hidden for pixels");
  check(await page.locator("#previewBtn").isDisabled(), "Preview stays disabled");
  check(await page.locator("#csvBtn").isDisabled(), "Download stays disabled");
  const status = await page.locator("#status").innerText();
  check(status.includes("chart.png"), `status names the file (saw: ${status})`);

  // --- Second image: uppercase .PNG works, and the first blob URL is revoked. ---
  await page.locator(".fileItem", { hasText: "logo.PNG" }).click();
  await page.waitForFunction(s => {
    const img = document.querySelector("#docView img");
    return img && img.complete && img.naturalWidth === 1 && img.src !== s;
  }, src1, { timeout: 15000 });
  check(true, "an uppercase .PNG renders too");
  const revoked = await page.evaluate(s => fetch(s).then(() => false, () => true), src1);
  check(revoked, "the previous image's blob URL is revoked");

  if (!fails.length) { console.log("RESULT: OK — image preview renders, dead rows stay dead"); code = 0; }
  else console.log(`RESULT: FAILED — ${fails.length} check(s): ${fails.join("; ")}`);
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

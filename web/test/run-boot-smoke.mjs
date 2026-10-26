// Quick no-credential smoke of the real app: boot app/index.html, let the README
// landing query run through app.js -> data.js -> real DuckDB, expect #docView content.
// Not part of CI — a hand tool, like sql-integration. Run: node test/run-boot-smoke.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5198;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
               ".mjs": "text/javascript; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const file = join(root, process.env.SITE_DIR || "app", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

let code = 1;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome"), headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  // A Content-Security-Policy refusal is logged, not thrown, and breaks the page quietly.
  const csp = [];
  page.on("console", m => { if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text()); });
  const engineLines = [];
  page.on("console", m => { if (/\[engine\]/.test(m.text())) engineLines.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(
    () => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForFunction(() => {
    const d = document.getElementById("docView");
    return d && !d.hidden && d.innerHTML.length > 200;
  }, { timeout: 120000 });
  const status = await page.locator("#status").innerText();
  console.log("status:", status);
  for (const l of engineLines) console.log(l);
  if (csp.length) throw new Error(`Content-Security-Policy refused something: ${csp.join(" | ")}`);

  // A query through the app's own SQL path; the status line says how it went.
  const run = async sql => {
    await page.fill("#sqlEditor", sql);
    await page.evaluate(() => { document.getElementById("status").textContent = "(running)"; });
    await page.click("#runBtn");
    await page.waitForFunction(() => /row\(s\) in|error/i.test(document.getElementById("status").innerText),
                               { timeout: 90000 });
    return { status: await page.locator("#status").innerText(),
             table: await page.locator("#resultsTable").innerText().catch(() => "") };
  };
  // avro IS the Iceberg manifest reader: without it no table opens, while the README and
  // plain SQL still work — exactly how a broken extension path once shipped unnoticed.
  const avro = await run("SELECT count(*) AS loaded FROM duckdb_extensions() WHERE loaded AND extension_name = 'avro'");
  if (!/^1 row/.test(avro.status) || !/\b1\b/.test(avro.table))
    throw new Error(`the avro extension is not loaded (${avro.status}): ${engineLines.join(" | ")}`);
  console.log("avro: loaded");
  // h3 is a COMMUNITY extension loaded on first use — the lazy path and the other repository.
  const h3 = await run("SELECT h3_latlng_to_cell(37.77, -122.41, 5) AS cell");
  if (!/^1 row/.test(h3.status)) throw new Error(`h3 did not load on first use: ${h3.status}`);
  console.log("h3: loaded on first use");
  const version = await page.evaluate(async () => {
    // The engine's own answer to which DuckDB this is, through the app's SQL path.
    return (window.ONELAKE_STUDIO_VERSION || {});
  });
  console.log("build:", JSON.stringify(version));
  console.log("RESULT: OK — engine booted, README query ran, doc rendered");
  code = 0;
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

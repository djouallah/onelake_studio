// Quick no-credential smoke of the real app: boot site/index.html, let the README
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
    const file = join(root, process.env.SITE_DIR || "site", path === "/" ? "index.html" : path.slice(1));
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

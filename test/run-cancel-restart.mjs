// =============================================================================
// run-cancel-restart.mjs — drive test/cancel-restart.html in real Chrome.
// =============================================================================
// Serves site/ at the origin root (so the page can `import "/data.js"`), routes
// /__canceltest to the test page, and — the point of the exercise — accepts
// /stall/* sockets WITHOUT EVER RESPONDING, which parks the DuckDB worker's
// synchronous footer XHR exactly the way a many-hundred-file table does.
//
// Lives in the project dir on purpose: playwright-core resolves from
// ./node_modules, so a copy elsewhere fails ERR_MODULE_NOT_FOUND.
// Run:  node test/run-cancel-restart.mjs
// Exits 0 only if the page reaches DONE with no FAIL lines.
// =============================================================================
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5199;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

// Sockets we deliberately leave hanging, destroyed at teardown so node can exit.
const stalled = new Set();

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (path.startsWith("/stall/")) {
    stalled.add(res.socket);          // never respond; the worker's sync XHR blocks here
    res.socket.on("close", () => stalled.delete(res.socket));
    return;
  }
  try {
    const file = path === "/__canceltest"
      ? join(root, "test", "cancel-restart.html")
      : join(root, "site", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
console.log(`serving on http://127.0.0.1:${PORT}`);

let code = 1;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  page.on("console", m => console.log("[page]", m.text()));
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__canceltest`);
  // Pre-fix, the page hangs behind the blocked worker and this times out — that
  // timeout IS the regression signal.
  await page.waitForFunction('document.title === "DONE"', { timeout: 180000 });
  const text = await page.locator("#log").innerText();
  code = /FAIL/.test(text) ? 1 : 0;
  console.log(code ? "RESULT: FAILED" : "RESULT: OK");
} catch (e) {
  console.log("RESULT: TIMED OUT / ERROR —", e.message);
} finally {
  await browser.close().catch(() => {});
  for (const s of stalled) s.destroy();
  server.close();
  process.exit(code);
}

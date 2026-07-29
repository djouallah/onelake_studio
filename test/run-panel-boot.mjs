// The PANEL's boot, reproduced: the real extension/app (the code the webview runs), the
// real proxy with the real vendor directory, the real CSP shape panel.js generates — and
// every console line captured, because a boot that stalls between two proxy requests is
// invisible to the read log and only the page knows why.
//
// Run: node test/run-panel-boot.mjs
import http from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

import { startProxy } from "../extension/src/proxy.js";
const require = createRequire(import.meta.url);
const { rewriteHtml } = require("../extension/src/html.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(root, "extension", "app");
const VENDOR = join(root, "extension", "vendor");
const PORT = 5204;

let vendored = true;
try { await stat(join(VENDOR, "cdn.jsdelivr.net")); } catch { vendored = false; }
if (!vendored) console.log("note: extension/vendor/ absent — boot will use cache+network instead");

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok " : "FAIL"} — ${name}`); cond ? pass++ : fail++; };

const events = [];
const CACHE_DIR = await mkdtemp(join(tmpdir(), "onelake-panel-boot-"));
const proxy = await startProxy({
  getToken: async () => "unused-token",
  cacheDir: CACHE_DIR,
  ...(vendored ? { vendorDir: VENDOR } : {}),
  onLog: e => events.push(e),
});

const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "pane1boot";
// panel.js csp(), with the page origin standing in for webview.cspSource.
const CSP = [
  `default-src 'none'`,
  `img-src ${ORIGIN} data: blob:`,
  `font-src ${ORIGIN}`,
  `style-src ${ORIGIN} 'unsafe-inline'`,
  `script-src ${ORIGIN} 'nonce-${NONCE}' 'unsafe-eval' http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net`,
  `worker-src blob:`,
  `connect-src ${ORIGIN} http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net https://extensions.duckdb.org https://community-extensions.duckdb.org`,
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
          dfsOrigin: proxy.dfsOrigin, tableOrigin: proxy.tableOrigin,
          cdnOrigin: proxy.cdnOrigin,
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
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", e => consoleLines.push(`[pageerror] ${e.message}`));
  page.on("crash", () => consoleLines.push("[CRASH] the page crashed"));

  // The webview bridge, so HOST_VSCODE code paths run for real.
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });

  await page.goto(`${ORIGIN}/`);
  const booted = await page.waitForFunction(
    () => !document.getElementById("runBtn").disabled, { timeout: 90000 })
    .then(() => true, () => false);

  ok(booted, "the panel's app booted to 'run SQL now'");
  if (!booted) {
    console.log("  status bar:", await page.evaluate(
      () => document.getElementById("status").textContent).catch(() => "(unreadable)"));
  }
  console.log("  --- page console ---");
  for (const l of consoleLines) console.log("   ", l);
  console.log("  --- proxy events:", events.length, "---");
  for (const e of events.slice(0, 30)) {
    console.log(`    ${e.method} ${e.status} ${e.cache}${e.vendor ? " packaged" : ""} ${e.path}`);
  }

  if (booted && vendored) {
    const cdn = events.filter(e => e.kind === "cdn");
    ok(cdn.length > 0 && cdn.every(e => e.vendor),
       `every boot byte came from the package (${cdn.length} request(s))`);
  }
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  await browser?.close().catch(() => {});
  server.close();
  await proxy.close();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

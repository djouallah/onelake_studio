// The packaged boot, end to end: real Chrome, the real extension/vendor/ directory, the
// real generated CSP shape — and the assertion that every engine byte came from the
// package, none from cache, none from network. This is the boot an installed extension
// performs, so it must work with the network conceptually unplugged.
//
// Needs extension/vendor/ populated (node extension/vendor.mjs). Skips loudly if not.
//
// Run: node test/run-vendor-boot.mjs
import http from "node:http";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { startProxy } from "../extension/src/proxy.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const VENDOR = join(root, "extension", "vendor");
const PAGE_PORT = 5203;

try { await stat(join(VENDOR, "cdn.jsdelivr.net")); }
catch {
  console.log("SKIP — extension/vendor/ is not populated; run `node extension/vendor.mjs` first");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok " : "FAIL"} — ${name}`); cond ? pass++ : fail++; };

const events = [];
const CACHE_DIR = await mkdtemp(join(tmpdir(), "onelake-vendor-boot-"));
const proxy = await startProxy({
  getToken: async () => "unused",
  cacheDir: CACHE_DIR,
  vendorDir: VENDOR,
  onLog: e => events.push(e),
});

const NONCE = "vend0r";
const PAGE_CSP = [
  `default-src 'none'`,
  `img-src http://127.0.0.1:${PAGE_PORT} data: blob:`,
  `style-src http://127.0.0.1:${PAGE_PORT} 'unsafe-inline'`,
  `script-src http://127.0.0.1:${PAGE_PORT} 'nonce-${NONCE}' 'unsafe-eval' http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net`,
  `worker-src blob:`,
  `connect-src http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net https://extensions.duckdb.org https://community-extensions.duckdb.org`,
].join("; ");

const PAGE = `<!doctype html><meta charset=utf-8><title>booting</title>
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<body><script type="module" nonce="${NONCE}">
const CDN = ${JSON.stringify(proxy.cdnOrigin)};
const withCdn = u => u.replace("https://", CDN + "/");
try {
  const duckdb = await import(withCdn("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm"));
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  for (const k of ["mainModule", "mainWorker", "pthreadWorker"])
    if (bundle[k]) bundle[k] = withCdn(bundle[k]);
  window.BUNDLE = { mainModule: bundle.mainModule, mainWorker: bundle.mainWorker };
  const workerUrl = URL.createObjectURL(
    new Blob([\`importScripts("\${bundle.mainWorker}");\`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  // The extension repositories, proxied — INSTALL must find the packaged binaries.
  const loaded = {};
  for (const [ext, repo] of [
    ["avro", CDN + "/extensions.duckdb.org"], ["excel", CDN + "/extensions.duckdb.org"],
    ["h3", CDN + "/community-extensions.duckdb.org"], ["zipfs", CDN + "/community-extensions.duckdb.org"],
  ]) {
    try { await conn.query(\`INSTALL \${ext} FROM '\${repo}'; LOAD \${ext};\`); loaded[ext] = true; }
    catch (e) { loaded[ext] = String(e.message || e).slice(0, 120); }
  }
  const r = await conn.query("SELECT 6 * 7 AS n");
  window.ANSWER = { n: Number(r.toArray()[0].n), loaded };
  document.title = "DONE";
} catch (e) { window.ANSWER = { error: String(e && e.message || e) }; document.title = "ERROR"; }
</script>`;

const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise(r => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

let browser;
try {
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage();
  page.on("console", m => { if (m.type() === "error") console.log("   [page]", m.text()); });
  page.on("pageerror", e => console.log("   [pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
  await page.waitForFunction(() => ["DONE", "ERROR"].includes(document.title), { timeout: 120000 });
  const answer = await page.evaluate(() => window.ANSWER);

  ok(!answer.error, `the engine booted from the package${answer.error ? ` — ${answer.error}` : ""}`);
  if (!answer.error) {
    ok(answer.n === 42, "…and answers SQL");
    for (const ext of ["avro", "excel", "h3", "zipfs"]) {
      ok(answer.loaded[ext] === true,
         `…extension '${ext}' loaded from the package${answer.loaded[ext] === true ? "" : ` — ${answer.loaded[ext]}`}`);
    }
  }
  const cdn = events.filter(e => e.kind === "cdn");
  const packaged = cdn.filter(e => e.vendor);
  console.log(`   cdn requests: ${cdn.length} total, ${packaged.length} packaged, ` +
              `${cdn.filter(e => !e.vendor).length} not`);
  for (const e of cdn.filter(e => !e.vendor)) console.log(`   NOT packaged: ${e.path}`);
  ok(cdn.length > 0 && packaged.length === cdn.length,
     "every engine byte came from inside the extension — zero cache, zero network");
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  await browser?.close().catch(() => {});
  pageServer.close();
  await proxy.close();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

// Does Chromium keep the COMPILED wasm between boots?
//
// This is the measurement that was missing while the extension was "slow as fuck" and the
// read log showed nothing but 1ms hits. The log times the proxy: request in, response out.
// Compiling 35MB of duckdb-eh.wasm happens after the last byte, inside the worker, and
// nothing was watching it.
//
// Chromium stores a compiled WebAssembly module beside the resource's HTTP cache entry.
// No cacheable response means no cache entry means no compiled module to reuse, and every
// panel open recompiles from scratch. The website never had this problem because jsDelivr
// sends `cache-control: immutable` + ETag.
//
// So: boot three times against a PERSISTENT Chrome profile and read the engine's own stage
// timings back out of the console.
//   boot 1  cold profile           — pays the full compile, always
//   boot 2  reload, same context   — in-memory cache
//   boot 3  new context, same disk — the one that matters; this is "open the panel again"
//
// If boot 3's instantiate is ~boot 1's, nothing is being cached and serving those bytes
// faster cannot help. If it collapses, the caching contract is reaching the engine.
//
// Run: node test/run-boot-timing.mjs
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
const PORT = 5206;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

let vendored = true;
try { await stat(join(VENDOR, "cdn.jsdelivr.net")); } catch { vendored = false; }
if (!vendored) console.log("note: extension/vendor/ absent — booting via cache+network instead");

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok " : "FAIL"} — ${name}`); cond ? pass++ : fail++; };

const events = [];
const CACHE_DIR = await mkdtemp(join(tmpdir(), "onelake-boot-timing-"));
const proxy = await startProxy({
  getToken: async () => "unused-token",
  cacheDir: CACHE_DIR,
  ...(vendored ? { vendorDir: VENDOR } : {}),
  onLog: e => events.push(e),
});

const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "boottiming";
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

// `[engine] boot 1234ms — selectBundle 5ms, worker 3ms, instantiate(wasm compile) 900ms, …`
function parseBoot(line) {
  const m = /^\[engine\] boot (\d+)ms — (.*)$/.exec(line);
  if (!m) return null;
  const stages = {};
  for (const part of m[2].split(", ")) {
    const s = /^(.*?) (\d+)ms$/.exec(part.trim());
    if (s) stages[s[1]] = Number(s[2]);
  }
  return { totalMs: Number(m[1]), stages };
}

const PROFILE = await mkdtemp(join(tmpdir(), "onelake-boot-profile-"));

// One boot in a fresh persistent context over the SAME on-disk profile. Returning the
// context to the caller would keep the cache in memory, which is the thing not being
// tested — so each call opens and closes its own browser.
async function boot(label, { reloadTwice = false } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const out = [];
  try {
    const page = await ctx.newPage();
    const lines = [];
    page.on("console", m => lines.push(m.text()));
    page.on("pageerror", e => lines.push(`[pageerror] ${e.message}`));

    const runs = reloadTwice ? 2 : 1;
    for (let i = 0; i < runs; i++) {
      lines.length = 0;
      if (i === 0) await page.goto(`${ORIGIN}/`);
      else await page.reload();
      await page.waitForFunction(
        () => !document.getElementById("runBtn").disabled, { timeout: 120000 });
      // The boot line is emitted right before the engine reports ready; give the console
      // relay a moment rather than racing it.
      await page.waitForFunction(
        () => true, { timeout: 1000 }).catch(() => {});
      let b = null;
      for (const l of lines) { const p = parseBoot(l); if (p) b = p; }
      out.push(b);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}

function show(label, b) {
  if (!b) { console.log(`  ${label}: (no boot line captured)`); return; }
  const inst = b.stages["instantiate(wasm compile)"];
  console.log(`  ${label}: total ${b.totalMs}ms   instantiate ${inst}ms   ` +
    Object.entries(b.stages).filter(([k]) => k !== "instantiate(wasm compile)")
      .map(([k, v]) => `${k} ${v}ms`).join(", "));
}

let cold = null, warmReload = null, warmRestart = null;
try {
  console.log("--- boot 1: cold profile (pays the full compile) ---");
  const first = await boot("cold", { reloadTwice: true });
  cold = first[0]; warmReload = first[1];
  show("cold        ", cold);
  show("reload      ", warmReload);

  console.log("--- boot 3: browser restarted, same on-disk profile ---");
  const second = await boot("restart");
  warmRestart = second[0];
  show("new context ", warmRestart);

  const inst = b => b && b.stages["instantiate(wasm compile)"];
  const extMs = b => b ? Object.entries(b.stages)
    .filter(([k]) => k.startsWith("ext:")).reduce((n, [, v]) => n + v, 0) : 0;
  ok(cold && inst(cold) != null, "the engine reported a per-stage boot breakdown");

  // What the bytes-side fix actually bought. Boot 1 fetches the engine through the proxy;
  // every later boot must not, because the /cdn responses are now `immutable` and
  // Chromium can keep them. `immutable` is also why there are no 304s — it means "do not
  // even revalidate", which is the point.
  const cdn = events.filter(e => e.kind === "cdn");
  console.log(`\n  proxy saw ${cdn.length} cdn request(s) across 3 boots ` +
              `(${cdn.filter(e => e.status === 304).length} were 304s)`);
  ok(cdn.length <= 12,
     "engine bytes are fetched once and then come from Chromium's cache, not the proxy");

  // MEASURED, and it is why the native port exists rather than more caching work.
  //
  // The compile does NOT get cached and cannot be made to: duckdb-wasm pipes the wasm
  // response through a TransformStream for progress reporting and hands
  // instantiateStreaming a SYNTHETIC Response built in JS. Chromium attaches a compiled
  // module to a real HTTP cache entry, and a synthetic Response has none — so no header
  // this proxy sends can help. Roughly 800ms, every boot, forever.
  //
  // And the extensions cost more than the engine does: four more wasm modules, INSTALLed
  // into the wasm VFS and compiled fresh every session. Nearly 6 seconds cold.
  //
  // Both numbers go to zero with native DuckDB, where an extension is a shared library
  // the process dlopens. These are printed, not asserted — this file's job is to keep
  // reporting them honestly, not to fail a build over a platform limit we do not control.
  if (inst(cold) != null) {
    console.log(`  wasm compile:      cold ${inst(cold)}ms, restarted ${inst(warmRestart)}ms ` +
      `(${Math.round(inst(warmRestart) / Math.max(inst(cold), 1) * 100)}% of cold — ` +
      `not code-cached; duckdb-wasm's TransformStream defeats it)`);
    console.log(`  extension loading: cold ${extMs(cold)}ms, restarted ${extMs(warmRestart)}ms` +
      ` — the dominant term, and the reason for the native engine`);
  }
} catch (e) {
  fail++; console.log("FAIL —", e.message);
} finally {
  server.close();
  await proxy.close();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

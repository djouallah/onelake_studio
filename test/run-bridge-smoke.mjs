// The website signing in with VS Code, end to end, with no VS Code and no Microsoft account:
// the REAL site in real Chrome, the REAL proxy and bridge listener from the extension, and
// a fake OneLake behind them that insists on the bearer token the bridge attaches.
//
//   1. opened with #vscode, the page probes the bridge, pairs (the "VS Code modal" answers
//      yes here), and shows "Signed in via VS Code" with no app registration at all;
//   2. workspaces are listed through the bridge, signed upstream — the page never held the
//      token;
//   3. DuckDB-WASM itself reads a file through the bridge's loopback origin (the
//      http://127.0.0.1 path duckdb-wasm#2118 once mangled);
//   4. a reload in the same tab reuses the pairing without asking again;
//   5. Disconnect forgets VS Code, and the next load does not probe it.
//
// Run: node test/run-bridge-smoke.mjs   (CHROME_PATH overrides where Chrome is)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { startProxy } = require("../extension/src/proxy.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5197;
const SITE = `http://127.0.0.1:${PORT}`;
const TOKEN = "fake-vscode-token";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
               ".mjs": "text/javascript; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// --- fake OneLake: the bearer or nothing -------------------------------------------------
const upstreamSaw = [];
const CSV = "a\n40\n2\n";
const upstream = http.createServer((req, res) => {
  upstreamSaw.push({ url: req.url, auth: req.headers.authorization || "" });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end("no bearer"); return; }
  if (req.url.startsWith("/?resource=account")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fileSystems: [{ name: "Sales" }, { name: "Finance" }] }));
    return;
  }
  if (req.url.startsWith("/Sales/lh.Lakehouse/Files/n.csv")) {
    const body = Buffer.from(CSV);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (m) {
      const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { "content-type": "text/csv", "accept-ranges": "bytes",
        "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": String(b - a + 1) });
      res.end(req.method === "HEAD" ? undefined : body.subarray(a, b + 1));
      return;
    }
    res.writeHead(200, { "content-type": "text/csv", "accept-ranges": "bytes",
                         "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  res.writeHead(404).end();
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${upstream.address().port}`;

// --- the extension's half ----------------------------------------------------------------
const pairs = [];
const proxy = await startProxy({ getToken: async () => TOKEN, dfsUpstream: upBase, tableUpstream: upBase });
const bridge = await proxy.startBridge({
  port: 0, origins: [SITE],
  onPair: async origin => { pairs.push(origin); return { allowed: true, account: "someone@example.com" }; },
});

// --- the site, with only the bridge port changed -----------------------------------------
const probes = [];
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/config.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    res.end(`window.ONELAKE_STUDIO_CONFIG = { auth: "msal", clientId: "", authority: "organizations", ` +
            `defaultLakehouse: "", bridgePort: ${bridge.port} };`);
    return;
  }
  try {
    const file = join(root, process.env.SITE_DIR || "site", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ||
    (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome"),
  headless: true,
});
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // A Content-Security-Policy refusal is logged, not thrown, and breaks the page quietly.
  page.on("console", m => { if (/Content.Security.Policy/i.test(m.text())) errors.push("CSP: " + m.text()); });
  page.on("request", r => { if (r.url().includes(`:${bridge.port}/pair`)) probes.push(r.url()); });

  // 1 — the extension's "Open the Website" link
  await page.goto(`${SITE}/#vscode`);
  await page.waitForFunction(() => /via VS Code/.test(document.getElementById("userBox").innerText),
                             { timeout: 60000 }).catch(() => {});
  check("signed in via VS Code, with no app registration",
    /Signed in via VS Code/.test(await page.locator("#userBox").innerText()));
  check("VS Code was asked once", pairs.length === 1, `asked ${pairs.length} time(s)`);
  check("the #vscode hint is gone from the address bar", !(await page.evaluate(() => location.hash)));

  // 2 — listing through the bridge
  await page.waitForFunction(() => /workspace\(s\)/.test(document.getElementById("status").innerText),
                             { timeout: 30000 }).catch(() => {});
  const status = await page.locator("#status").innerText();
  check("workspaces listed through the bridge", /^2 workspace\(s\)/.test(status), status);
  const listing = upstreamSaw.find(x => x.url.startsWith("/?resource=account"));
  check("…signed upstream with the VS Code token", !!listing && listing.auth === `Bearer ${TOKEN}`);
  check("the page never held the token", await page.evaluate(t =>
    !JSON.stringify({ ...localStorage }).includes(t) && !JSON.stringify({ ...sessionStorage }).includes(t), TOKEN));

  // 3 — DuckDB-WASM reading through loopback
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  const dfs = await page.evaluate(() => JSON.parse(sessionStorage.getItem("onelake-studio-bridge-pairing")).dfsOrigin);
  await page.fill("#sqlEditor", `SELECT sum(a) AS total FROM read_csv('${dfs}/Sales/lh.Lakehouse/Files/n.csv')`);
  // The landing README query left its own "1 row(s)" in the status line.
  await page.evaluate(() => { document.getElementById("status").textContent = "(running)"; });
  await page.click("#runBtn");
  await page.waitForFunction(() => /row\(s\) in|error/i.test(document.getElementById("status").innerText),
                             { timeout: 60000 }).catch(() => {});
  const qs = await page.locator("#status").innerText();
  check("DuckDB-WASM read a file through the bridge", /^1 row\(s\)/.test(qs), qs);
  check("…and got the right answer", /\b42\b/.test(await page.locator("#resultsTable").innerText()));
  check("…signed upstream",
    upstreamSaw.some(x => x.url.includes("/Files/n.csv") && x.auth === `Bearer ${TOKEN}`));

  // 4 — same tab, reloaded: the pairing still works, nobody is asked again
  await page.reload();
  await page.waitForFunction(() => /via VS Code/.test(document.getElementById("userBox").innerText),
                             { timeout: 60000 }).catch(() => {});
  check("a reload reconnects on its own (VS Code was here before)",
    /Signed in via VS Code/.test(await page.locator("#userBox").innerText()));
  check("…without asking VS Code again", pairs.length === 1, `asked ${pairs.length} time(s)`);

  // 5 — Disconnect
  await page.click("#userBox a.signout");
  await page.waitForFunction(() => !/via VS Code/.test(document.getElementById("userBox").innerText),
                             { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  const before = probes.length;
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForTimeout(1500);
  check("after Disconnect the page is signed out", !/Signed in/.test(await page.locator("#userBox").innerText()));
  check("…and does not probe VS Code on the next load", probes.length === before,
        `${probes.length - before} probe(s)`);

  check("no uncaught page errors throughout", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("harness ran to completion", false, e.stack || e.message);
} finally {
  const failed = checks.filter(c => !c.ok).length;
  console.log(`RESULT: ${failed ? "FAILED" : "OK"} — ${checks.length - failed}/${checks.length} checks passed`);
  await browser.close().catch(() => {});
  server.close();
  upstream.close();
  await proxy.close();
  process.exit(failed ? 1 : 0);
}

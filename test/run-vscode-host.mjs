// The webview build of the app, driven in a real browser with no VS Code and no
// credentials. What it can prove without an extension host: the injected `host: 'vscode'`
// flag reaches the page, the landing query reads the README the extension packages
// instead of GitHub, browser-only chrome is gone, and the palette resolves — every
// --vscode-* token the stylesheet names is faked here, so a colour left unmapped shows up
// as a var() that resolves to nothing rather than passing quietly.
//
// Run: node test/run-vscode-host.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5199;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

// README.md lives at the repo root; copy-site.mjs is what puts it inside site/ for the
// real extension, so serve it from where it actually is rather than requiring a build.
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/README.md" ? join(root, "README.md")
             : join(root, "site", path === "/" ? "index.html" : path.slice(1));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      // DuckDB's httpfs sizes a file from HEAD and then range-reads it.
      "accept-ranges": "bytes",
    });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const README_URL = `http://127.0.0.1:${PORT}/README.md`;

// A representative slice of what VS Code defines on :root, in the shape a dark theme
// gives it. Only the tokens index.html names are needed.
const FAKE_THEME = `
  :root {
    --vscode-editor-background: #1f1f1f;
    --vscode-sideBar-background: #181818;
    --vscode-editorGroupHeader-tabsBackground: #181818;
    --vscode-panel-border: #2b2b2b;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #026ec1;
    --vscode-textLink-foreground: #4daafc;
    --vscode-charts-green: #89d185;
    --vscode-charts-yellow: #cca700;
    --vscode-errorForeground: #f85149;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #04395e;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-focusBorder: #0078d4;
    --vscode-font-family: "Segoe WPC", "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: Consolas, monospace;
    --vscode-editor-font-size: 14px;
  }`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
};

let browser;
try {
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });

  // What extension/src/html.js injects in place of the config.js tag. The proxy origins
  // are left off so the fake OneLake below can be routed on its real hostnames, the way
  // every other harness here fakes it — which origin the reads go to is the proxy's
  // business and is covered by run-proxy.mjs.
  await ctx.route("**/config.js", r => r.fulfill({
    contentType: "text/javascript",
    body: `window.ONELAKE_STUDIO_CONFIG = ${JSON.stringify({
      auth: "none", host: "vscode", readmeUrl: README_URL,
    })};`,
  }));

  const ircCalls = [];
  await ctx.route(u => u.hostname === "onelake.table.fabric.microsoft.com", route => {
    const u = new URL(route.request().url());
    ircCalls.push(u.searchParams.get("warehouse") || decodeURIComponent(u.pathname));
    return route.fulfill({
      status: 404, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: { message: "no fixtures here" } }),
    });
  });

  const dfsCalls = [];
  await ctx.route(u => u.hostname === "onelake.dfs.fabric.microsoft.com", route => {
    const u = new URL(route.request().url());
    dfsCalls.push(u.searchParams.get("resource") === "account"
      ? "account" : `dir:${u.searchParams.get("directory") ?? ""}`);
    return route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(u.searchParams.get("resource") === "account"
        ? { fileSystems: [{ name: "ws1" }] }
        : { paths: [] }),
    });
  });

  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  // VS Code names the theme kind on <body> and defines the palette on :root before the
  // page's own scripts run.
  await page.addInitScript(({ css }) => {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.classList.add("vscode-dark");
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    });
    // The webview's own bridge to the extension host. Stubbed so what the page posts can
    // be read back.
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: m => window.__posted.push(m) });
  }, { css: FAKE_THEME });

  const readmeHits = [];
  page.on("request", r => {
    if (/README\.md/i.test(r.url())) readmeHits.push(r.url());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

  check("the host flag reaches the page",
    await page.evaluate(() => document.body.classList.contains("host-vscode")));

  // --- the landing query -----------------------------------------------------
  await page.waitForFunction(() => {
    const d = document.getElementById("docView");
    return d && !d.hidden && d.innerHTML.length > 200;
  }, { timeout: 120000 }).catch(() => {});

  const docRendered = await page.evaluate(() => {
    const d = document.getElementById("docView");
    return !!d && !d.hidden && d.innerHTML.length > 200;
  });
  check("the landing README rendered", docRendered);
  check("it was read from the packaged copy, not GitHub",
    readmeHits.length > 0 && readmeHits.every(u => u.startsWith(README_URL)),
    readmeHits.join(", ") || "no README request seen");

  const status = await page.evaluate(() => {
    const el = document.getElementById("status");
    return { text: el.textContent, cls: el.className };
  });
  check("the status bar is not left red", status.cls !== "error", status.text);

  // --- browser-only chrome ---------------------------------------------------
  for (const [label, sel] of [["the GitHub link", ".ghLink"], ["the account box", "#userBox"],
                              ["the auth gate", "#authGate"]]) {
    const shown = await page.evaluate(s => {
      const el = document.querySelector(s);
      return !!el && getComputedStyle(el).display !== "none";
    }, sel);
    check(`${label} is gone`, !shown);
  }

  // The build stamp is NOT browser-only chrome: a Marketplace install, a sideloaded vsix
  // and an F5 checkout look identical from inside the panel, and the stamp is the one
  // thing that says which of them is running. It cost an hour once.
  const stamp = await page.evaluate(() => {
    const el = document.getElementById("statusVer");
    return { shown: !!el && getComputedStyle(el).display !== "none", text: el ? el.textContent : "" };
  });
  check("the build stamp stays, and names a build", stamp.shown && /^build \S+/.test(stamp.text),
    stamp.text || "(empty)");

  // --- the palette resolved --------------------------------------------------
  const painted = await page.evaluate(() => {
    const css = getComputedStyle(document.body);
    const val = n => css.getPropertyValue(n).trim();
    return {
      vars: ["--bg", "--panel", "--panel2", "--border", "--text", "--muted", "--accent",
             "--accent2", "--ok", "--warn", "--err", "--hover", "--sel"]
        .filter(n => !val(n)),
      bg: css.backgroundColor,
      font: css.fontFamily,
      editorFont: getComputedStyle(document.getElementById("sqlEditor")).fontFamily,
      scheme: css.colorScheme,
    };
  });
  check("every palette variable resolved", painted.vars.length === 0, painted.vars.join(" "));
  check("the page took the editor background", painted.bg === "rgb(31, 31, 31)", painted.bg);
  check("the UI font is VS Code's", /Segoe WPC/.test(painted.font), painted.font);
  check("the SQL box uses the editor font", /Consolas/.test(painted.editorFont), painted.editorFont);
  check("color-scheme follows the theme kind", painted.scheme === "dark", painted.scheme);

  // --- the engine still works ------------------------------------------------
  await page.fill("#sqlEditor", "select 6*7 as answer");
  await page.click("#runBtn");
  await page.waitForFunction(
    () => /\b42\b/.test(document.getElementById("resultsTable").innerText || ""), { timeout: 60000 });
  check("SQL still runs", true);

  // --- browsing belongs to the editor's sidebar ------------------------------
  for (const [label, sel] of [["the header", "header"], ["the in-panel sidebar", "#sidebar"],
                              ["the sidebar toggle", "#sidebarToggle"]]) {
    const shown = await page.evaluate(s => {
      const el = document.querySelector(s);
      return !!el && getComputedStyle(el).display !== "none";
    }, sel);
    check(`${label} is gone`, !shown);
  }
  check("the panel does not list workspaces itself", !dfsCalls.includes("account"),
    dfsCalls.join(", ") || "no DFS calls at all");

  // --- the channel to the extension ------------------------------------------
  check("the page announced it is listening",
    await page.evaluate(() => window.__posted.some(m => m.type === "ready")));

  // A tree click arrives as one message. The fake OneLake has no Iceberg fixtures behind
  // it, so this proves the routing — the message reached selectTable with the right
  // identity and the right lakehouse — not the read, which run-table-stats.mjs covers
  // against a real one.
  await page.evaluate(() => window.postMessage(
    { type: "open-table", workspace: "ws1", item: "A.Lakehouse", schema: "dbo", table: "a_table" }, "*"));
  await page.waitForFunction(
    () => document.getElementById("activeTable").textContent === "dbo.a_table", { timeout: 15000 })
    .catch(() => {});
  check("a table from the tree opens in the panel",
    await page.evaluate(() => document.getElementById("activeTable").textContent === "dbo.a_table"),
    await page.evaluate(() => document.getElementById("activeTable").textContent));
  // The engine asks the Iceberg catalog for the warehouse it was pointed at, so this is
  // where a bridge that set the wrong lakehouse — or none — would show up.
  await page.waitForFunction(() => true);
  check("...against the lakehouse the tree named",
    ircCalls.includes("ws1/A.Lakehouse"), ircCalls.join(", ") || "the catalog was never asked");

  // --- where the bytes came from ---------------------------------------------
  // The extension counts the reads (the page cannot see DuckDB's) and sends the total.
  // Each of these is a state someone will actually be looking at when they wonder why
  // something took as long as it did.
  const indicator = async msg => {
    await page.evaluate(m => window.postMessage(m, "*"), { type: "reads", ...msg });
    await page.waitForFunction(() => !document.getElementById("readSrc").hidden, { timeout: 5000 })
      .catch(() => {});
    return page.evaluate(() => {
      const el = document.getElementById("readSrc");
      return { text: el.textContent, cls: el.className, title: el.title, hidden: el.hidden };
    });
  };

  const allLocal = await indicator({
    reads: 14, hits: 14, misses: 0, skips: 0, cacheBytes: 31e6, netBytes: 0, netMs: 0,
    cacheStored: 2.1e9, cacheMax: 20e9 });
  check("all-from-disk reads say so", allLocal.text === "▤ local" && allLocal.cls === "local",
    `${allLocal.text} / ${allLocal.cls}`);

  const mixed = await indicator({
    reads: 12, hits: 9, misses: 3, skips: 0, cacheBytes: 31e6, netBytes: 4.2e6, netMs: 1800,
    cacheStored: 2.1e9, cacheMax: 20e9 });
  check("a mixed read reports both sides", /▤ 9/.test(mixed.text) && /☁ 3/.test(mixed.text),
    mixed.text);
  check("...and the tooltip has the breakdown",
    /9 from this machine/.test(mixed.title) && /3 from OneLake/.test(mixed.title) &&
    /2\.1 GB of 20 GB/.test(mixed.title), mixed.title.replace(/\n/g, " | "));

  const remote = await indicator({
    reads: 4, hits: 0, misses: 4, skips: 0, cacheBytes: 0, netBytes: 210e6, netMs: 9000,
    cacheStored: 0, cacheMax: 20e9 });
  check("nothing cached reads as network", /☁ network/.test(remote.text) && /210 MB/.test(remote.text),
    remote.text);

  // A background fill is network spend the user did not wait for. The reads were local,
  // and saying only "local" while a download runs would be a lie by omission — the ⇣
  // discloses it, and the tooltip explains what it bought.
  const filling = await indicator({
    reads: 2, hits: 2, misses: 0, skips: 0, stores: 1, cacheBytes: 1e6, netBytes: 0,
    storeBytes: 150e6, netMs: 0, cacheStored: 2.1e9, cacheMax: 20e9 });
  check("a background fill is disclosed next to local reads",
    /▤ local/.test(filling.text) && /⇣ 150 MB/.test(filling.text), filling.text);
  check("...and the tooltip says what it bought",
    /background download/.test(filling.title) && /150 MB/.test(filling.title),
    filling.title.replace(/\n/g, " | "));

  // A skip is not a miss, and the difference is the whole diagnosis: those objects will
  // cost the network every time however long you wait.
  const skipped = await indicator({
    reads: 6, hits: 0, misses: 0, skips: 6, cacheBytes: 0, netBytes: 12e6, netMs: 900,
    cacheStored: 0, cacheMax: 20e9 });
  check("a skip is explained as never-cacheable",
    /can never be cached/.test(skipped.title), skipped.title.replace(/\n/g, " | "));

  const off = await indicator({
    reads: 3, hits: 0, misses: 0, skips: 3, cacheBytes: 0, netBytes: 1e6, netMs: 400,
    cacheOff: "EPERM: operation not permitted, mkdir", cacheStored: 0, cacheMax: 0 });
  check("a cache that could not start says so", off.text === "☁ no cache" && off.cls === "nocache",
    `${off.text} / ${off.cls}`);
  check("...and names the reason", /EPERM/.test(off.title), off.title.replace(/\n/g, " | "));

  await page.click("#readSrc");
  check("clicking it asks the extension for the log",
    await page.evaluate(() => window.__posted.some(m => m.type === "show-log")));
} catch (e) {
  check("the run completed", false, e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = checks.filter(c => !c.ok).length;
console.log(`\nRESULT: ${failed ? `FAILED — ${failed}/${checks.length}` : `OK — ${checks.length}/${checks.length}`}`);
process.exit(failed ? 1 : 0);

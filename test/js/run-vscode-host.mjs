// The panel's page, driven in a real browser with no VS Code and no credentials, answered
// by the real host methods and engine. What it proves: the landing query reads the README
// the extension packages, the page never reaches OneLake itself, a table and a SQLite file
// open from the tree's messages, and the palette resolves — every
// --vscode-* token the stylesheet names is faked here, so a colour left unmapped shows up
// as a var() that resolves to nothing rather than passing quietly.
//
// Run: node test/js/run-vscode-host.mjs
import http from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { panelHost, servePanel } from "./panel-host.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PORT = 5199;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The app comes from app/ — the code the panel really runs. The README the
// landing query reads is a file path, read by native DuckDB in the host, as packaged.
//
// The same server is the fake OneLake the HOST reads: /dfs for listings, /irc for the
// Iceberg catalog. The page itself never reaches OneLake — that is one of the checks.
const ircCalls = [];
const dfsCalls = [];

// A SQLite database under Files/, served by the fake OneLake: the host copies it into the
// engine's temp directory and DuckDB's sqlite extension attaches it read-only.
const SQLITE_PATH = "A.Lakehouse/Files/shop.sqlite";
const sqliteFile = join(await mkdtemp(join(tmpdir(), "onelake-sqlite-")), "shop.sqlite");
{
  const db = new DatabaseSync(sqliteFile);
  db.exec("CREATE TABLE orders (id INTEGER, amount REAL); INSERT INTO orders VALUES (1, 2.5), (2, 4.0);");
  db.close();
}
const SQLITE_BYTES = await readFile(sqliteFile);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const path = u.pathname;
  if (path.startsWith("/irc/")) {
    ircCalls.push(u.searchParams.get("warehouse") || decodeURIComponent(path));
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "no fixtures here" } }));
  }
  if (path === `/dfs/ws1/${SQLITE_PATH}`) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(SQLITE_BYTES);
  }
  if (path.startsWith("/dfs/")) {
    dfsCalls.push(u.searchParams.get("resource") === "account"
      ? "account" : `dir:${u.searchParams.get("directory") ?? ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(u.searchParams.get("resource") === "account"
      ? { fileSystems: [{ name: "ws1" }] } : { paths: [] }));
  }
  if (!await servePanel(req, res, ORIGIN)) res.writeHead(404).end();
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const host = panelHost({
  dfsOrigin: `http://127.0.0.1:${PORT}/dfs`, tableOrigin: `http://127.0.0.1:${PORT}/irc`,
});

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
    executablePath: process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome"), headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });

  // Anything the PAGE sends toward OneLake is a leak: the host does every read.
  const pageOneLake = [];

  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  page.on("request", r => { if (/onelake\.(dfs|table)\.fabric/.test(r.url())) pageOneLake.push(r.url()); });
  // VS Code names the theme kind on <body> and defines the palette on :root before the
  // page's own scripts run.
  await page.addInitScript(({ css }) => {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.classList.add("vscode-dark");
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    });
    // The webview's own bridge to the extension host. What the page posts is recorded so
    // the checks below can read it back — and `call` is answered by the REAL host
    // methods and engine (panel-host.mjs), because a page with nothing answering it never
    // finishes booting.
    window.__posted = [];
    window.__state = undefined;
    window.acquireVsCodeApi = () => ({
      getState: () => window.__state,
      setState: v => { window.__state = v; },
      postMessage: m => {
        window.__posted.push(m);
        if (m && m.type === "call") {
          window.__hostCall(m).then(r => window.postMessage(r, "*"));
        }
      },
    });
  }, { css: FAKE_THEME });

  await host.install(page);

  // Any attempt by the PAGE to reach GitHub for the README would still show up here —
  // that half of the check is unchanged, and is the half that matters for privacy.
  const githubHits = [];
  page.on("request", r => {
    if (/githubusercontent|github\.com/i.test(r.url())) githubHits.push(r.url());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

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
  check("it was read from the packaged copy, not GitHub", docRendered && githubHits.length === 0,
    `${githubHits.length} request(s) to github`);

  const status = await page.evaluate(() => {
    const el = document.getElementById("status");
    return { text: el.textContent, cls: el.className };
  });
  check("the status bar is not left red", status.cls !== "error", status.text);

  // A Marketplace install, a sideloaded vsix and an F5 checkout look identical from inside
  // the panel; the stamp is the one thing that says which of them is running.
  const stamp = await page.evaluate(() => {
    const el = document.getElementById("statusVer");
    return { shown: !!el && getComputedStyle(el).display !== "none", text: el ? el.textContent : "" };
  });
  check("the build stamp names a build", stamp.shown && /^build \S+/.test(stamp.text),
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
  check("the panel does not list workspaces itself", !dfsCalls.includes("account"),
    dfsCalls.join(", ") || "no DFS calls at all");
  check("the page itself never reaches OneLake", pageOneLake.length === 0, pageOneLake.join(", "));

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
  // The page reports how long the click took, end to end — the number the extension's
  // read log prints as an OPEN line above the per-request breakdown.
  const opened = await page.evaluate(() =>
    (window.__posted || []).find(m => m.type === "opened"));
  check("...and the click's total time was reported for the log",
    !!opened && opened.kind === "table" && Number.isFinite(opened.ms) && opened.ms >= 0 &&
    opened.label === "dbo.a_table",
    opened ? `${opened.kind} ${opened.label} ${opened.ms}ms` : "no 'opened' message posted");
  // A click during boot cancels the welcome query, and the welcome query's failure
  // handler used to stamp its boot message over the click's own status.
  check("...and the boot's welcome-page message never stomped the click",
    await page.evaluate(() =>
      !document.getElementById("status").textContent.includes("welcome page")),
    await page.evaluate(() => document.getElementById("status").textContent));

  // --- a SQLite file from Files/ -----------------------------------------------
  await page.evaluate(path => window.postMessage(
    { type: "open-file", workspace: "ws1", item: "A.Lakehouse", path, bytes: 1 }, "*"), SQLITE_PATH);
  await page.waitForFunction(
    () => /orders/.test(document.getElementById("activeTable").textContent || ""), { timeout: 60000 })
    .catch(() => {});
  await page.fill("#sqlEditor", "select sum(amount) as total from shop.main.orders");
  await page.click("#runBtn");
  const sqliteOk = await page.waitForFunction(
    () => /\b6\.5\b/.test(document.getElementById("resultsTable").innerText || ""), { timeout: 60000 })
    .then(() => true, () => false);
  check("a SQLite file opens, read by the host's DuckDB", sqliteOk,
    await page.evaluate(() => document.getElementById("status").textContent));

  // --- where the answers came from -------------------------------------------
  // The extension counts the host's OneLake answers (the page cannot see them) and sends
  // the total, from the cache or from OneLake.
  const indicator = async msg => {
    await page.evaluate(m => window.postMessage(m, "*"), { type: "reads", ...msg });
    await page.waitForFunction(() => !document.getElementById("readSrc").hidden, { timeout: 5000 })
      .catch(() => {});
    return page.evaluate(() => {
      const el = document.getElementById("readSrc");
      return { text: el.textContent, cls: el.className, title: el.title, hidden: el.hidden };
    });
  };

  const allLocal = await indicator({ reads: 14, hits: 14, misses: 0, netMs: 0 });
  check("all-from-cache answers say so", allLocal.text === "▤ cache" && allLocal.cls === "local",
    `${allLocal.text} / ${allLocal.cls}`);

  const mixed = await indicator({ reads: 12, hits: 9, misses: 3, netMs: 1800 });
  check("a mixed burst reports both sides", /▤ 9/.test(mixed.text) && /☁ 3/.test(mixed.text),
    mixed.text);
  check("...and the tooltip has the breakdown",
    /9 from this machine/.test(mixed.title) && /3 from OneLake \(1\.8s\)/.test(mixed.title),
    mixed.title.replace(/\n/g, " | "));

  const remote = await indicator({ reads: 4, hits: 0, misses: 4, netMs: 9000 });
  check("nothing cached reads as OneLake, with its time", /☁ OneLake/.test(remote.text) && /9\.0s/.test(remote.text),
    remote.text);

  await page.click("#readSrc");
  check("clicking it asks the extension for the log",
    await page.evaluate(() => window.__posted.some(m => m.type === "show-log")));
} catch (e) {
  check("the run completed", false, e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
  // Holds a native database handle and a temp directory; without this the run does not exit.
  await host.close().catch(() => {});
}

const failed = checks.filter(c => !c.ok).length;
console.log(`\nRESULT: ${failed ? `FAILED — ${failed}/${checks.length}` : `OK — ${checks.length}/${checks.length}`}`);
process.exit(failed ? 1 : 0);

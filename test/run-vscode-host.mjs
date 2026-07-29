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

  // Exactly what extension/src/html.js injects in place of the config.js tag.
  await ctx.route("**/config.js", r => r.fulfill({
    contentType: "text/javascript",
    body: `window.ONELAKE_STUDIO_CONFIG = ${JSON.stringify({
      auth: "none", host: "vscode",
      dfsOrigin: `http://127.0.0.1:${PORT}/dfs`,
      tableOrigin: `http://127.0.0.1:${PORT}/irc`,
      readmeUrl: README_URL,
    })};`,
  }));

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
                              ["the build stamp", "#statusVer"], ["the auth gate", "#authGate"]]) {
    const shown = await page.evaluate(s => {
      const el = document.querySelector(s);
      return !!el && getComputedStyle(el).display !== "none";
    }, sel);
    check(`${label} is gone`, !shown);
  }

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

  // --- and the engine still works --------------------------------------------
  await page.fill("#sqlEditor", "select 6*7 as answer");
  await page.click("#runBtn");
  await page.waitForFunction(
    () => /\b42\b/.test(document.getElementById("resultsTable").innerText || ""), { timeout: 60000 });
  check("SQL still runs", true);
} catch (e) {
  check("the run completed", false, e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = checks.filter(c => !c.ok).length;
console.log(`\nRESULT: ${failed ? `FAILED — ${failed}/${checks.length}` : `OK — ${checks.length}/${checks.length}`}`);
process.exit(failed ? 1 : 0);

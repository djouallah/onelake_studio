// The panel's page: vscode/app/index.html, the extension's own template, filled in by
// vscode/src/html.js. Tested against the real template, because the failure that
// matters is the quiet one — a placeholder that went missing is a page that comes up
// blank, or one whose CSP or config never arrived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderPage } = require("../src/html.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(root, "app");
const INDEX = await readFile(join(APP, "index.html"), "utf8");
const read = f => readFile(join(APP, f), "utf8");

const OPTS = {
  base: "https://webview.test/app/",
  nonce: "N0NCE",
  csp: "default-src 'none'; script-src 'nonce-N0NCE'",
  config: {
    vendorBase: "https://webview.test/vendor",
    pins: { echarts: "echarts@1", daxSql: "o/r@sha", marked: "marked@1", dompurify: "dompurify@1" },
    readmeUrl: "C:/ext/README.md",
    build: { version: "1.0.0", commit: "abc1234", dev: false },
  },
};

test("every placeholder is filled, and nothing is left over", () => {
  const out = renderPage(INDEX, OPTS);
  assert.ok(!/\{\{\w+\}\}/.test(out), "no placeholder survives");
  assert.ok(out.includes(`content="default-src 'none'; script-src 'nonce-N0NCE'"`), "the CSP is in the page's own meta");
  assert.ok(out.includes(`<script type="module" nonce="N0NCE" src="https://webview.test/app/app.js">`),
    "app.js loads from the page's base, with the nonce");
  assert.ok(out.includes(`href="https://webview.test/app/analyze/analyze.css"`), "and so does the stylesheet");
  assert.ok(out.includes(`window.ONELAKE_STUDIO_CONFIG = ${JSON.stringify(OPTS.config)}`), "the config is inlined");
});

test("a template that lost a placeholder is refused, naming it", () => {
  for (const p of ["base", "nonce", "csp", "config"]) {
    assert.throws(() => renderPage(INDEX.split(`{{${p}}}`).join(""), OPTS), new RegExp(`\\{\\{${p}\\}\\}`));
  }
});

test("no config value can close the script tag or be expanded by replace()", () => {
  const out = renderPage(INDEX, { ...OPTS, config: { readmeUrl: "C:/a/</script><script>alert(1)//$&$'.md" } });
  assert.ok(!out.includes("</script><script>alert(1)"), "the < is escaped inside the JSON");
  assert.ok(out.includes("$&$'"), "replacement patterns are taken literally");
});

test("the page loads nothing from the network and names no website", () => {
  assert.ok(!/https?:\/\//.test(INDEX.replace(/<!--[\s\S]*?-->/g, "")), "no absolute URL in the template");
  assert.ok(!/config\.js|sw-register|version\.js|authGate|userBox|ghLink|id="sidebar"/.test(INDEX),
    "none of the website's scripts or chrome");
});

test("the page has no website code paths left", async () => {
  const app = await read("app.js");
  for (const gone of ["HOST_VSCODE", "host-vscode", "serviceWorker", "auth.js", "localStorage",
                      "sessionStorage", "msal", "EMBEDDED", "connect(", "loadCatalog"]) {
    assert.ok(!app.includes(gone), `app.js has no ${gone}`);
  }
});

test("nothing in the page reaches a CDN: every library URL is built from vendorBase", async () => {
  for (const f of ["data.js", "docview.js", "cdn.js", "semantic.js", "analyze/view.js"]) {
    const src = await read(f);
    assert.ok(!/cdn\.jsdelivr\.net|cdnOrigin/.test(src), `${f} names no CDN`);
  }
  assert.match(await read("cdn.js"), /vendorBase/, "cdn.js builds URLs from the injected vendorBase");
});

// The .bim view's seams: these are what the semantic model view needs from the page.
test("a .bim opens as the semantic model view", async () => {
  const app = await read("app.js");
  assert.match(app, /from '\.\/semantic\.js'/, "app.js registers models");
  assert.match(app, /from '\.\/analyze\/view\.js'/, "and mounts the model view");
  assert.match(app, /fileExt\(file\.name\) === 'bim'\) return openModelView/, "a .bim is diverted to it");
  assert.match(app, /semantic\.rewrite\(sql\)/, "the main editor compiles model queries too");
  assert.ok(INDEX.includes('id="modelView"'), "index.html has the view's container");
  assert.match(await read("data.js"), /viewSchema/, "loadTable can put a model's tables in a schema of their own");
});

// One pin list (src/vendored.js): vendor.mjs downloads it, panel.js injects it, cdn.js
// builds URLs from it.
test("the page's libraries are exactly what vendor.mjs ships", async () => {
  const { PINS, VENDOR } = require("../src/vendored.js");
  globalThis.window = { ONELAKE_STUDIO_CONFIG: { vendorBase: "https://webview.test/vendor/", pins: PINS } };
  const cdn = await import("../app/cdn.js");
  delete globalThis.window;
  for (const key of ["echarts", "daxSql", "marked", "dompurify"]) assert.ok(PINS[key], `${key} is pinned`);
  assert.ok(VENDOR.esm.includes(PINS.marked) && VENDOR.esm.includes(PINS.dompurify), "the markdown renderer is vendored");
  assert.ok(VENDOR.files.includes(`${PINS.echarts}/dist/echarts.min.js`), "ECharts' build is vendored");
  const gh = VENDOR.gh.find(g => g.repo === PINS.daxSql);
  assert.ok(gh && gh.include.test("/src/index.js") && gh.include.test("/formats/tmsl.js"),
    "dax-sql is vendored at the page's commit, with the files semantic.js imports");
  assert.equal(cdn.npmEsm(PINS.marked), `https://webview.test/vendor/npm/${PINS.marked}/+esm.js`);
  assert.equal(cdn.ghFile(PINS.daxSql, "src/index.js"), `https://webview.test/vendor/gh/${PINS.daxSql}/src/index.js`);
});

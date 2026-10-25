// Tests for extension/src/html.js against the REAL extension/app/index.html — the
// extension's own tracked fork of the app, the one the panel actually serves.
//
// The point is the coupling: every rewrite below is a regex, and the dangerous failure
// is the quiet one — if the config.js tag stops matching, the panel comes up looking
// fine but running the app's default config, which points DuckDB straight at OneLake
// with no token and no proxy. That is a wall of 401s traced back to a tag rename later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rewriteHtml } = require("../extension/src/html.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const INDEX = await readFile(join(root, "extension", "app", "index.html"), "utf8");

const OPTS = {
  assetUrl: name => `https://webview.test/${name}`,
  nonce: "N0NCE",
  config: {
    auth: "none", host: "vscode",
    dfsOrigin: "http://127.0.0.1:1/s/dfs", tableOrigin: "http://127.0.0.1:1/s/irc",
    cdnOrigin: "http://127.0.0.1:1/s/cdn",
    readmeUrl: "https://webview.test/README.md",
  },
  cspContent: "default-src 'none'",
};

test("the real site/index.html still has everything the extension rewrites", () => {
  // If this throws, index.html changed shape — the message names which step lost its grip.
  assert.doesNotThrow(() => rewriteHtml(INDEX, OPTS));
});

test("the injected config replaces config.js, so the web app's defaults cannot win", () => {
  const out = rewriteHtml(INDEX, OPTS);
  assert.ok(out.includes(`window.ONELAKE_STUDIO_CONFIG = ${JSON.stringify(OPTS.config)}`),
    "the config object is inlined");
  assert.ok(!/<script[^>]*src="[^"]*config\.js"/.test(out),
    "and no config.js tag survives to overwrite it");
  assert.ok(out.includes(`nonce="N0NCE"`), "the inline script carries the CSP nonce");
});

test("local scripts become webview URLs and CDN ones are left alone", () => {
  const out = rewriteHtml(INDEX, OPTS);
  for (const name of ["app.js", "sw-register.js", "version.js"]) {
    assert.ok(out.includes(`src="https://webview.test/${name}"`), `${name} was rewritten`);
  }
  // A bare relative src reaching the webview would 404 against the vscode-webview: origin.
  assert.ok(!/<script[^>]*\ssrc="(?!https?:)/.test(out), "no relative script src is left");
  assert.ok(out.includes('type="module"'), "app.js keeps being a module");
});

test("the CSP lands inside head, and the external preconnects are dropped", () => {
  const out = rewriteHtml(INDEX, OPTS);
  assert.ok(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*<\/head>/.test(out),
    "the CSP meta is in head");
  assert.ok(!/preconnect[^>]*onelake\./.test(out),
    "the OneLake preconnects are gone — default-src 'none' would refuse them anyway");
  // jsDelivr's goes too: the panel's CSP no longer admits the CDN at all — its files ship
  // in the vendor directory and load through the proxy's /cdn route.
  assert.ok(!/preconnect[^>]*jsdelivr/.test(out), "the jsDelivr preconnect is gone");
});

// Both keys are load-bearing and neither fails loudly. Without `host` the page keeps its
// browser chrome, tries to browse OneLake itself, and never answers the tree. Without
// `readmeUrl` the landing query goes to raw.githubusercontent.com, which the panel's CSP
// refuses — the red error this whole thing started as.
test("the webview's own config keys survive the injection", () => {
  const out = rewriteHtml(INDEX, OPTS);
  assert.ok(/"host":"vscode"/.test(out), "the host flag reaches the page");
  assert.ok(out.includes("https://webview.test/README.md"), "and so does the packaged README");
});

test("app.js reads both of them, so the injection is not writing into a void", async () => {
  const app = await readFile(join(root, "extension", "app", "app.js"), "utf8");
  assert.match(app, /cfg\.host === 'vscode'/, "app.js branches on the host flag");
  assert.match(app, /cfg\.readmeUrl/, "app.js takes the README URL from the config");
});

test("the engine reads cdnOrigin — the disk-cached boot path is wired, not decorative", async () => {
  const data = await readFile(join(root, "extension", "app", "data.js"), "utf8");
  assert.match(data, /cdnOrigin/, "data.js consumes the injected cdnOrigin");
  const doc = await readFile(join(root, "extension", "app", "docview.js"), "utf8");
  assert.match(doc, /cdnOrigin/, "docview.js routes its lazy imports the same way");
});

// A relative <link href> resolves against the vscode-webview: document, not the site
// directory — the semantic model view would come up unstyled with nothing in the console
// but a 404.
test("local stylesheets become webview URLs too", () => {
  const out = rewriteHtml(INDEX, OPTS);
  assert.ok(out.includes(`href="https://webview.test/analyze/analyze.css"`), "analyze.css was rewritten");
  assert.ok(!/<link[^>]*rel="stylesheet"[^>]*\shref="(?!https?:)/.test(out), "no relative stylesheet is left");
});

// The panel's fork used to lag the website here: a .bim opened as the old diagram, with no
// SQL and no Explore. These are the seams the port has to keep.
test("a .bim opens as the semantic model view, as on the website", async () => {
  const app = await readFile(join(root, "extension", "app", "app.js"), "utf8");
  assert.match(app, /from '\.\/semantic\.js'/, "app.js registers models");
  assert.match(app, /from '\.\/analyze\/view\.js'/, "and mounts the model view");
  assert.match(app, /fileExt\(file\.name\) === 'bim'\) return openModelView/, "a .bim is diverted to it");
  assert.match(app, /semantic\.rewrite\(sql\)/, "the main editor compiles model queries too");
  assert.ok(INDEX.includes('id="modelView"'), "index.html has the view's container");
  const doc = await readFile(join(root, "extension", "app", "docview.js"), "utf8");
  assert.ok(!/bimview/.test(app + doc + INDEX), "the old diagram is gone");
  const data = await readFile(join(root, "extension", "app", "data.js"), "utf8");
  assert.match(data, /viewSchema/, "loadTable can put a model's tables in a schema of their own");
});

// cdn.js (the page) and vendored.js (vendor.mjs, the proxy, the CSP) pin the same packages
// separately. A mismatch is a refused script in the panel and nothing in the tests.
test("the page's pins and the vendored pins agree", async () => {
  const { PINS, ghFile, npmFile } = await import("../extension/app/cdn.js");
  const { VENDORED, VENDORED_GH } = require("../extension/src/vendored.js");
  const echarts = VENDORED.find(p => p.name === "echarts");
  assert.equal(PINS.echarts, `echarts@${echarts.version}`);
  assert.ok(VENDORED_GH.some(g => g.repo === PINS.daxSql), "dax-sql is vendored at the page's commit");
  assert.ok(VENDORED_GH.every(g => g.include.test("/src/index.js") && g.include.test("/formats/tmsl.js")),
    "and the files semantic.js imports are among those vendored");
  assert.match(ghFile(PINS.daxSql, "src/index.js"), /^https:\/\/cdn\.jsdelivr\.net\/gh\//);
  assert.match(npmFile(PINS.echarts, "dist/echarts.min.js"), /^https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@/);
});

test("a page missing the config.js tag is refused rather than half-built", () => {
  const broken = INDEX.replace(/<script src="config\.js"><\/script>/, "");
  assert.throws(() => rewriteHtml(broken, OPTS), /config\.js/,
    "the failure names the tag, because the alternative is unsigned reads");
});

test("a page with no </head> is refused", () => {
  assert.throws(() => rewriteHtml(INDEX.replace("</head>", ""), OPTS), /head/);
});

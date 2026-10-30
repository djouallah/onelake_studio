// The panel's semantic model view, end to end: the REAL app page in real Chrome,
// on a real native engine-host through the panel's message bridge, under a CSP of the
// panel's shape. A .bim is "opened from the tree" — an open-file message, as extension.js
// posts after an export — and its bytes are read by the real host methods from a fake
// OneLake this server stands in for (panel-host.mjs); then the same model as an Apache Ossie
// .yaml, which must draw and answer the same. The compiler and the chart library
// come from vendor/ (vendor.mjs), as the panel serves them — nothing from a CDN.
//
// No editor, no credentials, no lakehouse. Run: node test/js/run-panel-semantic.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

import { panelHost, servePanel } from "./panel-host.mjs";

const require = createRequire(import.meta.url);

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const APP = join(root, "app");
const VENDOR = join(root, "vendor");
const PORT = 5209;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "panelsemantic";
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");

const BIM = JSON.stringify({
  compatibilityLevel: 1604,
  model: {
    tables: [
      { name: "Sales",
        columns: [{ name: "ProductKey", dataType: "int64", sourceColumn: "ProductKey" },
                  { name: "Amount", dataType: "double", sourceColumn: "Amount" }],
        measures: [{ name: "Total", expression: "SUM ( Sales[Amount] )" }] },
      { name: "Product",
        columns: [{ name: "ProductKey", dataType: "int64", sourceColumn: "ProductKey", isKey: true },
                  { name: "Color", dataType: "string", sourceColumn: "Color" }] },
    ],
    relationships: [{ name: "r", fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey" }],
  },
});
const BIM_PATH = "/ws/shop.Lakehouse/Files/semantic_models/shop.bim";
// The same model as an Apache Ossie YAML, made by the vendored dax-sql and yaml themselves.
const { PINS } = require("../../src/vendored.js");
const { tmslToOssie } = await import(pathToFileURL(join(VENDOR, "npm", PINS.daxSql, "formats", "ossie.js")).href);
const { stringify } = await import(pathToFileURL(join(VENDOR, "npm", PINS.yaml, "+esm.js")).href);
const OSSIE = stringify(tmslToOssie(JSON.parse(BIM), "shop"));
const OSSIE_PATH = "/ws/shop.Lakehouse/Files/semantic_models/shop_ossie.yaml";
const TABLES = `WITH "Sales" AS (SELECT * FROM (VALUES (1, 10.0), (2, 5.0), (1, 2.5)) t("ProductKey", "Amount")),
"Product" AS (SELECT * FROM (VALUES (1, 'red'), (2, 'blue')) t("ProductKey", "Color"))
`;

// The page as panel.js renders it (panel-host.mjs), plus the .bim at the fake OneLake.
const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === BIM_PATH) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(BIM);
  }
  if (path === OSSIE_PATH) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(OSSIE);
  }
  if (!await servePanel(req, res, ORIGIN, { nonce: NONCE })) res.writeHead(404).end();
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const host = panelHost({
  dfsOrigin: ORIGIN, tableOrigin: ORIGIN,
  engineOptions: { extensionDir: join(tmpdir(), "onelake-duckdb-extensions") },
});
let code = 1;
let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const csp = [];
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  page.on("response", r => { if (r.status() === 404) console.log("[404]", r.url()); });
  page.on("console", m => {
    if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text());
    if (m.type() === "error") console.log("[console.error]", m.text());
  });

  // The panel's bridge, answered as panel.js answers it.
  await host.install(page);
  await page.addInitScript(() => {
    window.__state = undefined;
    window.acquireVsCodeApi = () => ({
      getState: () => window.__state,
      setState: v => { window.__state = v; },
      postMessage(m) {
        if (m && m.type === "call") window.__hostCall(m).then(r => window.postMessage(r, "*"));
      },
    });
  });

  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

  // What extension.js posts after an export.
  await page.evaluate(path => window.postMessage({
    type: "open-file", workspace: "ws", item: "shop.Lakehouse", path, bytes: 1,
  }, "*"), BIM_PATH.slice(1).replace(/^ws\//, ""));
  await page.waitForFunction(() => !document.getElementById("modelView").hidden, { timeout: 90000 })
    .catch(async () => { throw new Error(`the model view never opened — status: ${await page.locator("#status").innerText()}`); });

  const cards = await page.locator("#modelView .m-card").count();
  const rels = await page.locator("#modelView .m-rel").count();
  console.log(`model page: ${cards} cards, ${rels} relationship(s)`);
  if (cards !== 2 || rels !== 1) throw new Error(`model page drew ${cards} cards and ${rels} relationships`);
  if (!await page.locator("#sqlEditor").isHidden()) throw new Error("the editor is still on screen under the model view");
  const css = await page.evaluate(() => getComputedStyle(document.querySelector("#modelView .subtabs")).borderRadius);
  if (css !== "999px") throw new Error(`explore.css did not load (subtabs border-radius ${css})`);

  // A model query, compiled by dax-sql and run on the native engine, from the Pivot's Show SQL:
  // a measure on the shelves (so the box has a query to start from), then the box's own SQL.
  // The Pivot loads ECharts as a classic script from the vendored tree — the CSP must admit it.
  async function modelQuery(sql) {
    await page.click('#modelView .subtab[data-apage="pivot"]');
    await page.waitForFunction(() => !!window.echarts, { timeout: 60000 })
      .catch(() => { throw new Error("ECharts never loaded for the Pivot"); });
    // Fact tables start collapsed; a search opens the groups it matches.
    await page.locator("#modelView .ex-search").fill("Total");
    await page.locator("#modelView .ex-field", { hasText: /^.?Total$/ }).first().click();
    await page.locator("#modelView .explore-actions .btn-explore", { hasText: "Show SQL" }).click();
    const box = page.locator("#modelView .explore-sql-page");
    await box.locator("textarea").fill(sql);
    await box.locator(".btn-explore.primary", { hasText: "Run" }).click();
    await page.waitForFunction(() => /rows|Error/.test(document.querySelector("#modelView .explore-sql-page .explore-info").textContent), { timeout: 60000 });
    return {
      info: await box.locator(".explore-info").innerText(),
      rows: (await box.locator(".explore-table").innerText()).replace(/\s+/g, " "),
    };
  }
  const { info, rows } = await modelQuery(
    `${TABLES}SELECT * FROM (SELECT Product.Color, AGG(Total) AS total FROM shop GROUP BY ALL) ORDER BY Color`);
  console.log("model query:", info, "|", rows);
  if (!/^2 rows/.test(info) || !/blue 5(\.0)? red 12\.5/.test(rows)) throw new Error(`model query: ${info} ${rows}`);

  // A model the extension downloaded to this machine arrives as text (open-model), not as
  // a OneLake path — the click in the tree — named by its workspace and its own name.
  await page.evaluate(text => window.postMessage({
    type: "open-model", name: "Local Model.bim", path: "C:/models/ws/Local Model.bim", text,
    modelWorkspace: "ws", modelName: "Local Model",
  }, "*"), BIM);
  await page.waitForFunction(() => document.getElementById("activeTable").textContent === "Local Model.bim" &&
    !document.getElementById("modelView").hidden, { timeout: 60000 })
    .catch(async () => { throw new Error(`a downloaded model never opened — status: ${await page.locator("#status").innerText()}`); });
  const localCards = await page.locator("#modelView .m-card").count();
  if (localCards !== 2) throw new Error(`the downloaded model drew ${localCards} cards`);
  console.log("downloaded model: opened from text, 2 cards");

  // An Ossie .yaml in Files/ opens as the same model, and its view answers the same query.
  await page.evaluate(path => window.postMessage({
    type: "open-file", workspace: "ws", item: "shop.Lakehouse", path, bytes: 1,
  }, "*"), OSSIE_PATH.slice(1).replace(/^ws\//, ""));
  await page.waitForFunction(() => document.getElementById("activeTable").textContent === "shop_ossie.yaml" &&
    !document.getElementById("modelView").hidden, { timeout: 60000 })
    .catch(async () => { throw new Error(`the Ossie model never opened — status: ${await page.locator("#status").innerText()}`); });
  const ossieCards = await page.locator("#modelView .m-card").count();
  const ossieRels = await page.locator("#modelView .m-rel").count();
  if (ossieCards !== 2 || ossieRels !== 1) throw new Error(`the Ossie model drew ${ossieCards} cards and ${ossieRels} relationships`);
  const { info: ossieInfo, rows: ossieRows } = await modelQuery(
    `${TABLES}SELECT * FROM (SELECT Product.Color, AGG(Total) AS total FROM shop_ossie GROUP BY ALL) ORDER BY Color`);
  console.log("ossie model:", ossieInfo, "|", ossieRows);
  if (!/^2 rows/.test(ossieInfo) || !/blue 5(\.0)? red 12\.5/.test(ossieRows)) throw new Error(`Ossie model query: ${ossieInfo} ${ossieRows}`);

  if (csp.length) throw new Error(`Content-Security-Policy refused something: ${csp.join(" | ")}`);
  console.log("RESULT: OK — a .bim and an Ossie .yaml opened in the panel as their model, and model queries ran on the native engine");
  code = 0;
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser?.close().catch(() => {});
  server.close();
  await host.close().catch(() => {});
  process.exit(code);
}

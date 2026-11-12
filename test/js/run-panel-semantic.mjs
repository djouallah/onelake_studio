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
const APP = join(root, "page");
const VENDOR = join(root, "vendor");
const PORT = 5209;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONCE = "panelsemantic";
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");

// Direct Lake: a query reads its tables by their five-part names (ROWS below).
const partition = entityName => [{
  name: entityName, mode: "directLake",
  source: { type: "entity", entityName, schemaName: "dbo", expressionSource: "DatabaseQuery" },
}];
const BIM = JSON.stringify({
  compatibilityLevel: 1604,
  model: {
    expressions: [{
      name: "DatabaseQuery", kind: "m",
      expression: 'AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002")',
    }],
    tables: [
      { name: "Sales", partitions: partition("Sales"),
        columns: [{ name: "ProductKey", dataType: "int64", sourceColumn: "ProductKey" },
                  { name: "Amount", dataType: "double", sourceColumn: "Amount" }],
        measures: [{ name: "Total", expression: "SUM ( Sales[Amount] )" }] },
      { name: "Product", partitions: partition("Product"),
        columns: [{ name: "ProductKey", dataType: "int64", sourceColumn: "ProductKey", isKey: true },
                  { name: "Color", dataType: "string", sourceColumn: "Color" }] },
    ],
    relationships: [{ name: "r", fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey" }],
  },
});
const BIM_PATH = "/ws/shop.Lakehouse/Files/semantic_models/shop.bim";
// The same model as an Apache Ossie YAML, made by the vendored dax-sql and yaml themselves.
const { PINS } = require("../../core/vendored.js");
const { sqlName } = require("../../core/names.js");
const { tmslToOssie } = await import(pathToFileURL(join(VENDOR, "npm", PINS.daxSql, "formats", "ossie.js")).href);
const { stringify } = await import(pathToFileURL(join(VENDOR, "npm", PINS.yaml, "+esm.js")).href);
const OSSIE = stringify(tmslToOssie(JSON.parse(BIM), "shop"));
const OSSIE_PATH = "/ws/shop.Lakehouse/Files/semantic_models/shop_ossie.yaml";
const ROWS = {
  Sales: `SELECT * FROM (VALUES (1, 10.0), (2, 5.0), (1, 2.5)) t("ProductKey", "Amount")`,
  Product: `SELECT * FROM (VALUES (1, 'red'), (2, 'blue')) t("ProductKey", "Color")`,
};

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
  engineOptions: {
    extensionDir: join(tmpdir(), "onelake-duckdb-extensions"),
    resolveTable: async ref => ({ ...ref, emptySql: ROWS[ref.table] }),
  },
  nameTables: async list => list.map(t => sqlName({ kind: "lakehouse", workspace: "ws", item: "shop", schema: t.schema, table: t.table })),
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
  const bridge = async p => {
    await host.install(p);
    await p.addInitScript(() => {
      window.__state = undefined;
      window.acquireVsCodeApi = () => ({
        getState: () => window.__state,
        setState: v => { window.__state = v; },
        postMessage(m) {
          if (m && m.type === "call") window.__hostCall(m).then(r => window.postMessage(r, "*"));
        },
      });
    });
  };
  await bridge(page);

  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => /DuckDB ready/.test(document.getElementById("status").textContent), { timeout: 120000 });

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

  // A card dragged: it moves, its line with it, and it is not picked. Auto arrange puts it back.
  {
    const card = page.locator("#modelView .m-card").first();
    const edge = page.locator("#modelView .m-edge").first();
    const arrange = page.locator("#modelView .model-arrange");
    const [was, line] = [await card.getAttribute("transform"), await edge.getAttribute("d")];
    if (!await arrange.isHidden()) throw new Error("Auto arrange shows before any card was moved");
    const b = await card.boundingBox();
    await page.mouse.move(b.x + 20, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y + 70, { steps: 5 });
    await page.mouse.up();
    if (await card.getAttribute("transform") === was) throw new Error("a dragged card stayed where it was");
    if (await edge.getAttribute("d") === line) throw new Error("a dragged card's line did not follow it");
    if (await page.locator("#modelView .m-card.m-sel").count()) throw new Error("a drag picked the card");
    if (await arrange.isHidden()) throw new Error("no Auto arrange after a card was moved");
    await arrange.click();
    if (await card.getAttribute("transform") !== was || await edge.getAttribute("d") !== line) throw new Error("Auto arrange did not put the card back");
    if (!await arrange.isHidden()) throw new Error("Auto arrange still shows with every card in its place");
    await card.click();
    if (await page.locator("#modelView .m-card.m-sel").count() !== 1) throw new Error("a click on a card did not pick it");
    await page.locator("#modelView .model-diagram svg").click({ position: { x: 2, y: 2 } });
  }
  if (!await page.locator(".resultsWrap").isHidden()) throw new Error("the results are still on screen under the model view");
  const css = await page.evaluate(() => getComputedStyle(document.querySelector("#modelView .subtab-bar")).display);
  if (css !== "flex") throw new Error(`explore.css did not load (the bar's display is ${css})`);
  const subtabs = await page.locator("#modelView [data-apage]").allTextContents();
  if (subtabs.join() !== "Model,Visual,Report") throw new Error(`Explore's pages are ${subtabs.join(", ")}, not Model, Visual and Report`);

  // A model query, compiled by dax-sql and run on the native engine, from Visual's shelves: Total
  // by Product's Color, as a table. Visual has no SQL box: its query is its shelves'.
  // Visual loads ECharts as a classic script from the vendored tree — the CSP must admit it.
  async function modelQuery() {
    await page.click('#modelView .subtab[data-apage="pivot"]');
    await page.waitForFunction(() => !!window.echarts, { timeout: 60000 })
      .catch(() => { throw new Error("ECharts never loaded for the Visual"); });
    // Fact tables start collapsed; a search opens the groups it matches.
    for (const [term, name] of [["Total", /^.?Total$/], ["Color", /Color$/]]) {
      await page.locator("#modelView .ex-search").fill(term);
      await page.locator("#modelView .ex-field", { hasText: name }).first().click();
    }
    // The mark's button opens the list of marks, on <body>.
    await page.locator("#modelView .ex-mark-pick").click();
    await page.locator('.ex-mark-menu .ex-mark[data-mark="table"]').click();
    await page.waitForFunction(() => /blue|Error/.test(document.querySelector("#modelView .ex-table")?.textContent ?? ""), { timeout: 60000 });
    return {
      info: await page.locator("#modelView .ex-info").innerText(),
      rows: (await page.locator("#modelView .ex-table").innerText()).replace(/\s+/g, " "),
    };
  }
  const { info, rows } = await modelQuery();
  console.log("model query:", info, "|", rows);
  if (!/blue 5(\.0)? red 12\.5/.test(rows)) throw new Error(`model query: ${info} ${rows}`);

  // The Report's +: a second page, its name ready to be typed, and the Report still drawn.
  await page.click('#modelView .subtab[data-apage="report"]');
  await page.locator("#modelView .rp-page-add").click();
  await page.waitForFunction(() => document.querySelector("#modelView .rp-page-rename") || document.querySelector("#modelView .rp-report-page .ex-error, #modelView .ex-error"), { timeout: 30000 })
    .catch(() => { throw new Error("the Report's + added no page"); });
  const reportError = await page.locator("#modelView .ex-error").allTextContents();
  if (reportError.length) throw new Error(`the Report's +: ${reportError.join(" | ")}`);
  const pageNames = await page.locator("#modelView .rp-page").count();
  if (pageNames !== 2) throw new Error(`the Report has ${pageNames} pages after its +, not 2`);
  await page.keyboard.type("Second");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#modelView .rp-page-name")].some(n => n.textContent === "Second"), { timeout: 30000 })
    .catch(() => { throw new Error("the new page did not take the name typed"); });
  console.log("report: a page added and named");

  // A Report tile's statement is one a person can run: Logs shows it as it was written (enginelog.js sourceOf)
  // and its Open puts it in a SQL box. It said FROM model, a name no SQL box takes. Here, what the Report
  // really sends; that such a statement runs is the command line's test (cli-engine.test.mjs).
  // The model opened again first: the visual's own answer is kept by the view it ran in, and the tile asks the
  // same thing, so in the same view it would be answered from there and send nothing.
  await page.click('#modelView .subtab[data-apage="pivot"]');
  await page.locator("#modelView button", { hasText: "Add to report" }).click();
  await page.evaluate(path => window.postMessage({
    type: "open-file", workspace: "ws", item: "shop.Lakehouse", path, bytes: 1,
  }, "*"), BIM_PATH.slice(1).replace(/^ws\//, ""));
  await page.waitForFunction(() => !document.getElementById("modelView").hidden && document.querySelector('#modelView .subtab[data-apage="report"]'), { timeout: 90000 });
  const before = host.calls.length;
  await page.click('#modelView .subtab[data-apage="report"]');
  // The tile is on the page it was added to, the second one.
  await page.locator("#modelView .rp-page-name", { hasText: "Second" }).click();
  await page.waitForFunction(() => /blue/.test(document.querySelector("#modelView .rp-tile table")?.textContent ?? ""), { timeout: 60000 })
    .catch(async () => { throw new Error(`the Report's tile never drew: ${(await page.locator("#modelView").innerText()).replace(/\s+/g, " ").slice(-300)}`); });
  const { sourceOf } = require("../../core/engine/enginelog.js");
  const strings = v => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  const written = host.calls.slice(before).flatMap(c => strings(c.args)).map(s => sourceOf(s).source).filter(Boolean);
  const tile = written.find(s => /AGG\("Total"\)/.test(s));
  if (!tile) throw new Error(`the Report's tile sent no statement over the model: ${written.join(" | ").slice(0, 300)}`);
  if (/\bFROM model\b/.test(tile)) throw new Error(`a Report tile's statement says FROM model, which no SQL box runs: ${tile}`);
  console.log(`report: a tile's statement names the model (${tile.replace(/\s+/g, " ").slice(0, 110)})`);

  // A model the extension downloaded to this machine arrives as text (open-model), not as
  // a OneLake path — the click in the tree — named by its workspace and its own name.
  await page.evaluate(text => window.postMessage({
    type: "open-model", name: "Local Model.yaml", path: "C:/models/ws/Local Model.yaml", text,
    modelWorkspace: "ws", modelName: "Local Model",
  }, "*"), stringify(tmslToOssie(JSON.parse(BIM), "Local Model"), { lineWidth: 0 }));
  await page.waitForFunction(() => document.getElementById("activeTable").textContent === "Local Model.yaml" &&
    !document.getElementById("modelView").hidden, { timeout: 60000 })
    .catch(async () => { throw new Error(`a downloaded model never opened — status: ${await page.locator("#status").innerText()}`); });
  const localCards = await page.locator("#modelView .m-card").count();
  if (localCards !== 2) throw new Error(`the downloaded model drew ${localCards} cards`);
  const { info: localInfo, rows: localRows } = await modelQuery();
  console.log("downloaded model:", localInfo, "|", localRows);
  if (!/blue 5(\.0)? red 12\.5/.test(localRows)) throw new Error(`downloaded model query: ${localInfo} ${localRows}`);

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
  const { info: ossieInfo, rows: ossieRows } = await modelQuery();
  console.log("ossie model:", ossieInfo, "|", ossieRows);
  if (!/blue 5(\.0)? red 12\.5/.test(ossieRows)) throw new Error(`Ossie model query: ${ossieInfo} ${ossieRows}`);

  if (csp.length) throw new Error(`Content-Security-Policy refused something: ${csp.join(" | ")}`);
  console.log("RESULT: OK — a .bim and an Ossie .yaml opened in the panel as their model, and model queries ran on the native engine");
  code = 0;
} catch (e) {
  console.log("RESULT: FAILED —", e.message, String(e.stack).match(/run-panel-semantic\.mjs:\d+/)?.[0] ?? "");
} finally {
  await browser?.close().catch(() => {});
  server.close();
  await host.close().catch(() => {});
  process.exit(code);
}

// Semantic-model queries in the real app page, with no lakehouse: boot the page, register
// a small .bim through semantic.js — the same module instance app.js holds, so the real,
// pinned dax-sql compiler loads the way it does for a user — then run model queries
// through the editor and the Run button. The model's tables are not Direct Lake, so each
// is read by its own name, which the query's CTEs provide.
// CI runs it against dist/ (SITE_DIR=dist), where the compiler is the vendored copy and the
// Content-Security-Policy refuses anything else. Run: node test/run-semantic-smoke.mjs
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5197;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
               ".mjs": "text/javascript; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const file = join(root, process.env.SITE_DIR || "app", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

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
const TABLES = `WITH "Sales" AS (SELECT * FROM (VALUES (1, 10.0), (2, 5.0), (1, 2.5)) t("ProductKey", "Amount")),
"Product" AS (SELECT * FROM (VALUES (1, 'red'), (2, 'blue')) t("ProductKey", "Color"))
`;

let code = 1;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome"), headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning" || /echarts/i.test(m.text())) console.log(`[console.${m.type()}]`, m.text()); });
  const csp = [];
  page.on("console", m => { if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text()); });
  const thirdParty = [];
  page.on("request", r => { if (/cdn\.jsdelivr\.net\/gh\//.test(r.url())) thirdParty.push(r.url()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

  const m = await page.evaluate(async bim => {
    const s = await import(new URL("semantic.js", document.baseURI).href);
    const { name, sample, directLake } = await s.registerModel("shop.bim", bim);
    return { name, sample, directLake };
  }, BIM);
  console.log("registered:", JSON.stringify(m));
  if (m.name !== "shop") throw new Error(`model name ${m.name}`);
  if (!/AGG\(Total\)/.test(m.sample) || !/Product\.Color/.test(m.sample) || !/FROM shop/.test(m.sample))
    throw new Error(`unexpected sample query: ${m.sample}`);

  const run = async sql => {
    await page.fill("#sqlEditor", sql);
    await page.evaluate(() => { document.getElementById("status").textContent = "(running)"; });
    await page.click("#runBtn");
    await page.waitForFunction(() => /row\(s\) in|error/i.test(document.getElementById("status").innerText),
                               { timeout: 90000 });
    return { status: await page.locator("#status").innerText(),
             table: await page.locator("#resultsTable").innerText().catch(() => "") };
  };

  // A model query as a relation inside SQL of the user's own: compiled in place.
  const q = await run(`${TABLES}SELECT * FROM (SELECT Product.Color, AGG(Total) AS total FROM shop GROUP BY ALL) ORDER BY Color`);
  console.log("query:", q.status, "|", q.table.replace(/\s+/g, " "));
  if (!/^2 row/.test(q.status)) throw new Error(`model query: ${q.status}`);
  if (!/blue\s+5\b/.test(q.table) || !/red\s+12\.5\b/.test(q.table)) throw new Error(`wrong totals: ${q.table}`);

  const d = await run("DESCRIBE shop");
  console.log("describe:", d.status);
  if (!/^5 row/.test(d.status) || !/Total/.test(d.table) || !/Product\.Color/.test(d.table))
    throw new Error(`DESCRIBE shop: ${d.status} ${d.table}`);

  // Plain SQL is untouched by a registered model.
  const p = await run("SELECT 'shop_x' AS s");
  if (!/^1 row/.test(p.status)) throw new Error(`plain SQL: ${p.status}`);

  // The model view, as a .bim opens it: the real view, compiler and chart library, run on a
  // DuckDB of the test's own that holds the model's tables (the app's engine is read-only).
  await page.evaluate(async bim => {
    const at = p => new URL(p, document.baseURI).href;
    const cdn = await import(at("cdn.js"));
    const duckdb = await import(cdn.npmModule(cdn.PINS.duckdbWasm));
    const single = { mainModule: cdn.npmFile(cdn.PINS.duckdbWasm, cdn.PINS.duckdbBundle.wasm),
                     mainWorker: cdn.npmFile(cdn.PINS.duckdbWasm, cdn.PINS.duckdbBundle.worker) };
    const bundle = await duckdb.selectBundle({ eh: single, mvp: single, base: single });
    const worker = new Worker(URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    await conn.query(`CREATE TABLE "Sales" AS SELECT * FROM (VALUES (1, 10.0), (2, 5.0), (1, 2.5)) t("ProductKey", "Amount")`);
    await conn.query(`CREATE TABLE "Product" AS SELECT * FROM (VALUES (1, 'red'), (2, 'blue')) t("ProductKey", "Color")`);
    const plain = v => typeof v === "bigint" ? Number(v) : v;
    const run = async sql => {
      const t = await conn.query(sql);
      const fields = t.schema.fields.map(f => f.name);
      return { fields, rows: t.toArray().map(r => Object.fromEntries(fields.map(f => [f, plain(r[f])]))), truncated: false };
    };
    const semantic = await import(at("semantic.js"));
    const { mountAnalyze } = await import(at("analyze/view.js"));
    const { tmslOf } = await import(at("analyze/model.js"));
    const m = await semantic.registerModel("shop.bim", bim);
    const box = document.getElementById("modelView");
    box.closest("section").classList.add("modelOpen");
    box.hidden = false;
    mountAnalyze(box, { name: m.name, file: m.file, tmsl: tmslOf(m.bim), exploreCompiler: m.exploreCompiler,
      sample: m.sample, rewrite: semantic.rewrite, run, setStatus: () => {} });
  }, BIM);

  await mkdir("test-shots", { recursive: true });
  await page.screenshot({ path: "test-shots/model.png", fullPage: true });
  // Model: a card per table, a line per relationship.
  const cards = await page.locator("#modelView .m-card").count();
  const rels = await page.locator("#modelView .m-rel").count();
  console.log(`model page: ${cards} cards, ${rels} relationship(s)`);
  if (cards !== 2 || rels !== 1) throw new Error(`model page drew ${cards} cards and ${rels} relationships`);
  if (!await page.locator("#sqlEditor").isHidden()) throw new Error("the editor is still on screen under the model view");

  // SQL: the model's query, previewed.
  await page.click('#modelView .subtab[data-apage="sql"]');
  await page.fill("#modelView textarea", "SELECT Product.Color, AGG(Total) AS total FROM shop GROUP BY ALL ORDER BY Color");
  await page.click("#modelView .btn-analyze.primary");
  await page.waitForFunction(() => /rows|Error/.test(document.querySelector("#modelView .analyze-info").textContent), { timeout: 60000 });
  const sqlInfo = await page.locator("#modelView .analyze-info").innerText();
  const sqlRows = (await page.locator("#modelView .analyze-table").innerText()).replace(/\s+/g, " ");
  console.log("sql page:", sqlInfo, "|", sqlRows);
  if (!/^2 rows/.test(sqlInfo) || !/blue 5(\.0)? red 12\.5/.test(sqlRows)) throw new Error(`SQL preview: ${sqlInfo} ${sqlRows}`);

  // Explore: a column and a measure, one click each, drawn as a chart.
  await page.click('#modelView .subtab[data-apage="explore"]');
  await page.locator("#modelView .ex-field", { hasText: "Color" }).click({ timeout: 60000 });
  // A fact table's fields start folded; its measure is inside.
  await page.locator("#modelView .ex-table-group summary", { hasText: "Sales" }).click();
  await page.locator("#modelView .ex-field", { hasText: "Total" }).click();
  await page.waitForFunction(() => /rows?$|Error/.test(document.querySelector("#modelView .ex-info").textContent), { timeout: 60000 });
  const exInfo = await page.locator("#modelView .ex-info").innerText();
  const canvas = await page.locator("#modelView .ex-chart canvas").count();
  // A canvas is not a chart: count the pixels in the first series' colour (#3987e5), after
  // ECharts' entry animation, and say how big the canvas is.
  await page.waitForTimeout(1500);
  const drawn = await page.evaluate(() => {
    const c = document.querySelector("#modelView .ex-chart canvas");
    const box = document.querySelector("#modelView .ex-chart").getBoundingClientRect();
    if (!c) return { box: [box.width, box.height] };
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let bar = 0;
    for (let i = 0; i < d.length; i += 4)
      if (Math.abs(d[i] - 0x39) < 24 && Math.abs(d[i + 1] - 0x87) < 24 && Math.abs(d[i + 2] - 0xe5) < 24 && d[i + 3] > 128) bar++;
    return { box: [box.width, box.height], canvas: [c.width, c.height], bar };
  });
  await page.screenshot({ path: "test-shots/explore.png", fullPage: true });
  console.log(`explore page: ${exInfo}, ${canvas} canvas, ${JSON.stringify(drawn)}`);
  if (!/^2 rows$/.test(exInfo) || !canvas) throw new Error(`Explore: ${exInfo}, ${canvas} canvas`);
  if (!(drawn.bar > 200)) throw new Error(`Explore drew no bars: ${JSON.stringify(drawn)}`);

  if (csp.length) throw new Error(`Content-Security-Policy refused something: ${csp.join(" | ")}`);
  if (process.env.SITE_DIR === "dist" && thirdParty.length)
    throw new Error(`the built site loaded the compiler from jsDelivr: ${thirdParty[0]}`);
  console.log("RESULT: OK — model queries ran from the editor, and the model view drew its Model, SQL and Explore pages");
  code = 0;
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

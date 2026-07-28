// Verifies the .bim semantic-model diagram (bimview.js) inside the real app page —
// real stylesheet, real docview.js — without needing a lakehouse: boot the app, let
// the README landing render settle, then push a fixture .bim through renderDocument
// and mount() exactly the way showDoc does. Also checks the fallbacks: a broken .bim
// must still pretty-print as text/JSON, and non-.bim kinds must be untouched.
// Not part of CI — a hand tool, like boot-smoke. Run: node test/run-bim-view.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5199;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const file = join(root, "site", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// A small but representative TOM model: a DirectLake fact with enough rows to fold,
// a bothDirections relationship, an inactive one, hidden bits, and the auto date
// tables Power BI injects (which the diagram must hide along with their relationship).
const filler = Array.from({ length: 8 }, (_, i) => ({ name: `Filler${i + 1}`, dataType: "double" }));
const FIXTURE = JSON.stringify({
  compatibilityLevel: 1604,
  model: {
    culture: "en-US",
    tables: [
      { name: "Sales",
        columns: [
          { name: "SaleKey", dataType: "int64" },
          { name: "CustomerKey", dataType: "int64" },
          { name: "ProductKey", dataType: "int64" },
          { name: "DateKey", dataType: "dateTime" },
          { name: "Amount", dataType: "decimal" },
          { name: "RowHash", dataType: "string", isHidden: true },
          { name: "Margin", dataType: "double", type: "calculated" },
          ...filler,
        ],
        measures: [
          { name: "Total Sales", expression: ["", "SUM ( Sales[Amount] )"] },
          { name: "Avg Price", expression: "DIVIDE ( [Total Sales], SUM ( Sales[Qty] ) )" },
        ],
        partitions: [{ name: "p1", mode: "directLake",
          source: { type: "entity", entityName: "sales_fact", schemaName: "dbo" } }] },
      { name: "Customer", columns: [
          { name: "CustomerKey", dataType: "int64" }, { name: "Name", dataType: "string" },
          { name: "Country", dataType: "string" }] },
      { name: "Product", columns: [
          { name: "ProductKey", dataType: "int64" }, { name: "Category", dataType: "string" }] },
      { name: "Date", columns: [
          { name: "DateKey", dataType: "dateTime" }, { name: "Year", dataType: "int64" }] },
      { name: "Helper", isHidden: true, columns: [{ name: "X", dataType: "string" }] },
      { name: "LocalDateTable_aaa", columns: [{ name: "Date", dataType: "dateTime" }] },
      { name: "DateTableTemplate_bbb", columns: [{ name: "Date", dataType: "dateTime" }] },
    ],
    relationships: [
      { name: "r1", fromTable: "Sales", fromColumn: "CustomerKey", toTable: "Customer", toColumn: "CustomerKey" },
      { name: "r2", fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey",
        crossFilteringBehavior: "bothDirections" },
      { name: "r3", fromTable: "Sales", fromColumn: "DateKey", toTable: "Date", toColumn: "DateKey", isActive: false },
      { name: "r4", fromTable: "Sales", fromColumn: "DateKey", toTable: "LocalDateTable_aaa", toColumn: "Date" },
    ],
  },
});

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
};

let code = 1;
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // Let the boot sequence finish (README landing render) so nothing overwrites
  // the injected diagram afterwards. This also regression-checks the markdown path.
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  await page.waitForFunction(() => {
    const d = document.getElementById("docView");
    return d && !d.hidden && d.innerHTML.length > 200;
  }, { timeout: 120000 });
  check("boot: README landing rendered (markdown path intact)", true);

  const r = await page.evaluate(async fixture => {
    const { renderDocument } = await import("/docview.js");
    const out = {};
    // Non-.bim kinds must be byte-identical to before: plain JSON and plain text.
    out.jsonKind = (await renderDocument('{"a": 1}', "json")).kind;
    out.textKind = (await renderDocument("hello\nworld", "txt")).kind;
    // Broken .bim falls back (unparseable -> text; parseable-but-no-tables -> json).
    out.brokenKind = (await renderDocument('{"broken', "bim")).kind;
    out.noTablesKind = (await renderDocument('{"model": {"tables": []}}', "bim")).kind;
    // The real thing, mounted the way showDoc does it.
    const res = await renderDocument(fixture, "bim");
    out.bimKind = res.kind;
    out.hasMount = typeof res.mount === "function";
    const dv = document.getElementById("docView");
    document.getElementById("docBar").hidden = false;
    dv.innerHTML = res.html;
    dv.classList.remove("prose");
    dv.hidden = false;
    document.getElementById("resultsTable").hidden = true;
    if (res.mount) res.mount(dv);
    await new Promise(f => requestAnimationFrame(() => requestAnimationFrame(f)));
    out.cards = [...dv.querySelectorAll(".bimCard")].map(c => c.dataset.table);
    out.rels = dv.querySelectorAll("g.bimRel").length;
    out.edgesDrawn = [...dv.querySelectorAll("g.bimRel .edge")]
      .filter(p => (p.getAttribute("d") || "").length > 10).length;
    out.arrows = dv.querySelectorAll("g.bimRel .arrow").length;
    out.inactive = dv.querySelectorAll("g.bimRel.inactive").length;
    out.svgH = +dv.querySelector(".bimEdges").getAttribute("height");
    out.note = dv.querySelector(".bimNote")?.textContent || "";
    out.meta = dv.querySelector(".bimMeta")?.textContent || "";
    // Tiers: the fact (many side of every relationship) sinks below its
    // dimensions; the isolated Helper stays in the top tier.
    out.tiers = [...dv.querySelectorAll(".bimTier")].map(t =>
      [...t.querySelectorAll(".bimCard")].map(c => c.dataset.table));
    const top = n => dv.querySelector(`.bimCard[data-table="${n}"]`).getBoundingClientRect().top;
    out.factBelow = top("Sales") > top("Customer") && top("Sales") > top("Date") && top("Sales") > top("Helper");
    // Fold: Sales has 15 columns + 2 measures = 17 rows, cap is 12.
    const sales = dv.querySelector('.bimCard[data-table="Sales"]');
    const more = sales.querySelector(".bimMore");
    out.moreLabel = more?.textContent || "";
    out.foldedHidden = sales.querySelector(".moreRows") &&
      getComputedStyle(sales.querySelector(".moreRows")).display === "none";
    more.click();
    out.foldedShown = getComputedStyle(sales.querySelector(".moreRows")).display !== "none";
    // Hover: entering Customer highlights its one edge and dims unrelated cards.
    const cust = dv.querySelector('.bimCard[data-table="Customer"]');
    cust.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    out.hl = dv.querySelectorAll("g.bimRel.hl").length;
    out.dimmedCards = [...dv.querySelectorAll(".bimCard.dimmed")].map(c => c.dataset.table);
    dv.querySelector(".bimWrap").dispatchEvent(new MouseEvent("mouseleave"));
    out.hlAfter = dv.querySelectorAll("g.bimRel.hl").length;
    // Double-click: the card carries the partition's entity name, and the event
    // reaches app.js — no lakehouse here, so the "not in this item" status IS the
    // proof the whole chain (card → CustomEvent → openModelTable) is wired.
    out.entity = sales.dataset.entity + "|" + sales.dataset.schema;
    sales.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    out.dblStatus = document.getElementById("status").textContent;
    return out;
  }, FIXTURE);

  check("fallback kinds untouched", r.jsonKind === "json" && r.textKind === "text",
    `json=${r.jsonKind} text=${r.textKind}`);
  check("broken .bim falls back", r.brokenKind === "text" && r.noTablesKind === "json",
    `broken=${r.brokenKind} noTables=${r.noTablesKind}`);
  check("fixture renders as bim with mount", r.bimKind === "bim" && r.hasMount, r.bimKind);
  check("auto date tables filtered from cards",
    r.cards.length === 5 && !r.cards.some(n => /LocalDateTable|DateTableTemplate/.test(n)),
    r.cards.join(","));
  check("relationship to date table dropped, 3 drawn", r.rels === 3 && r.edgesDrawn === 3,
    `rels=${r.rels} drawn=${r.edgesDrawn}`);
  check("bothDirections doubles the arrow", r.arrows === 4, `arrows=${r.arrows}`);
  check("inactive relationship marked", r.inactive === 1, `inactive=${r.inactive}`);
  check("SVG sized to content", r.svgH > 50, `h=${r.svgH}`);
  check("hidden-date footnote", /2 auto-generated date tables hidden/.test(r.note), r.note);
  check("meta line", /5 tables · 3 relationships · 2 measures/.test(r.meta), r.meta);
  check("fact tier below dimensions",
    r.tiers.length === 2 && r.tiers[1].join(",") === "Sales" && r.factBelow,
    JSON.stringify(r.tiers));
  check("fold: collapsed then expands on click",
    /\+5 more/.test(r.moreLabel) && r.foldedHidden && r.foldedShown,
    `label=${r.moreLabel} hidden=${r.foldedHidden} shown=${r.foldedShown}`);
  check("hover highlights and clears",
    r.hl === 1 && r.hlAfter === 0 && r.dimmedCards.length === 3 && !r.dimmedCards.includes("Sales"),
    `hl=${r.hl} after=${r.hlAfter} dimmed=${r.dimmedCards.join(",")}`);
  check("card carries the Direct Lake entity name", r.entity === "sales_fact|dbo", r.entity);
  check("double-click reaches the app's table lookup",
    /No table named sales_fact/.test(r.dblStatus), r.dblStatus);
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

  const shot = process.env.BIM_SHOT;
  if (shot) { await page.screenshot({ path: shot, fullPage: false }); console.log("screenshot:", shot); }

  code = checks.every(Boolean) ? 0 : 1;
  console.log(code === 0 ? "RESULT: OK — bim diagram verified" : "RESULT: FAILED");
} catch (e) {
  console.log("RESULT: FAILED —", e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

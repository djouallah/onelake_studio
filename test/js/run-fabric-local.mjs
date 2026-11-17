// The Fabric app, whole, on a local Rayfin backend (fabric-local.mjs): the site and the function as an export makes
// them, the page signing in through its own sign-in (storage/auth.js) and drawing its Report: the page asks its own
// function for the tables (storage/catalog.js, rayfin/functions' openCatalog, run by the real
// @microsoft/fabric-user-data-functions with the storage token of whoever runs this) and reads them from OneLake
// with DuckDB-WASM.
//
// It starts where a viewer does: no session, a sign-in, a call to the backend. rayfin-local stands in for Fabric's
// backend and answers the SDK the same requests, so what is not proven here is Fabric's own hosting.
//
// Two ways in, as a viewer has: a tab of its own (the Sign in with Fabric button, and the popup it opens), and
// inside the Fabric frame (the backend's page that plays Fabric: initEmbeddedAuth).
//
// ONELAKE_TOKEN (storage) and FABRIC_TOKEN (the Fabric API, to find the ids); ONELAKE_CI_WORKSPACE
// and ONELAKE_CI_LAKEHOUSE by name: the lakehouse holds Tables/test/lakeci_plain (test/fixtures/lake/make_tables.py).
// RAYFIN_LOCAL: the rayfin-local executable (default: rayfin-local on PATH).
// Run: node scripts/vendor.mjs && node test/js/run-fabric-local.mjs
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { serveApp, CHROME } from "./fabric-local.mjs";

const require = createRequire(import.meta.url);
const { createFabric } = require("../../core/models/fabric.js");

const { ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE } = process.env;
for (const [k, v] of Object.entries({ ONELAKE_TOKEN, FABRIC_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE }))
  if (!v) { console.log(`FAIL ${k} is not set`); process.exit(1); }
const TABLE = "lakeci_plain", SOURCE = `test.${TABLE}`;
// The table, as make_tables.py writes it.
const ROWS = 5000, TOTAL = 238834;
// A user of the local backend's own, for its page that plays Fabric: in CI nobody is signed in to Azure as a person.
const USER = { name: "viewer@example.com", password: "local-only-" + Math.random().toString(36).slice(2) };

// The model: the lakehouse's lakeci_plain, a sum of it and a count.
const bimOf = (ws, lh) => ({
  name: "fabriclocal", compatibilityLevel: 1604,
  model: {
    culture: "en-US",
    expressions: [{ name: "DirectLake", kind: "m", expression: ["let",
      `    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${ws}/${lh}", [HierarchicalNavigation=true])`, "in", "    Source"] }],
    tables: [{
      name: TABLE,
      columns: [{ name: "id", dataType: "int64", sourceColumn: "id" }, { name: "region", dataType: "string", sourceColumn: "region" },
                { name: "amount", dataType: "double", sourceColumn: "amount" }],
      measures: [{ name: "Total amount", expression: `SUM(${TABLE}[amount])` }, { name: "Rows", expression: `COUNTROWS(${TABLE})` }],
      partitions: [{ name: TABLE, mode: "directLake", source: { type: "entity", entityName: TABLE, schemaName: "test", expressionSource: "DirectLake" } }],
    }],
  },
});
// The Report: the rows and the sum, and the sum by region, as tables.
const REPORT = { pages: [{ name: "Page 1", tiles: [
  { title: "All of it", kind: "pivot", pivot: { rows: [], values: ["Rows", "Total amount"], mark: "table" } },
  { title: "By region", kind: "pivot", pivot: { rows: [`${TABLE}.region`], values: ["Total amount"], mark: "table" } },
] }] };

const checks = [];
const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const digits = s => s.replace(/[,\s]/g, "");
let browser;

// The app, opened both ways. `seen(page or frame, how)` says what a viewer must see.
async function run(name, { seen, ...app }) {
  const before = checks.length;
  let served = null;
  try {
    // As Fabricator's preview serves it: the project's own Vite, with Rayfin's local-dev plugin.
    served = await serveApp(name, { ...app, user: USER, vite: true });
    const { ready } = served;
    const watch = page => {
      page.on("pageerror", e => console.log("[pageerror]", e.message));
      page.on("response", r => { if (r.status() >= 400) console.log(`[${r.status()}]`, r.url().slice(0, 200)); });
      page.on("console", m => { if (m.type() === "error") console.log("[console.error]", m.text().split(/\r?\n/)[0].slice(0, 300)); });
    };
    // A tab of its own: no session, so the gate's button, and the popup it opens.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      watch(page);
      await page.goto(ready.appUrl);
      const button = page.getByRole("button", { name: "Sign in with Fabric" });
      await button.waitFor({ timeout: 60_000 });
      check(true, `${name}, a tab of its own: with no session, the page asks to sign in`);
      await button.click();
      await seen(page, `${name}, a tab of its own, signed in with its button`);
      await context.close();
    }
    // Inside the Fabric frame: the backend's page plays Fabric, and the app signs in with what it hands over.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      watch(page);
      await page.goto(ready.embedUrl);
      // Fabric shows an app to someone signed in to Fabric: here, the local user.
      await page.getByLabel("Username or email").first().fill(USER.name);
      await page.getByLabel("Password").first().fill(USER.password);
      await page.getByLabel("Password").first().press("Enter");
      const frame = await (async () => {
        for (let i = 0; i < 120; i++) {
          const f = page.frames().find(x => x !== page.mainFrame() && x.url().startsWith(new URL(ready.appUrl).origin));
          if (f) return f;
          await new Promise(r => setTimeout(r, 500));
        }
        throw new Error(`the Fabric frame never showed the app: frames ${page.frames().map(x => x.url()).join(", ")}; the page says ` +
          (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400));
      })();
      await seen(frame, `${name}, inside the Fabric frame`);
      await context.close();
    }
  } catch (e) {
    check(false, `${name}: ${e?.stack || e}`);
  } finally {
    await served?.stop(checks.slice(before).every(Boolean));
  }
}

// What the page shows, for a wait that ran out.
const shown = async frame => (await frame.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 600);
const waited = async (frame, wait, what) => {
  try { await wait; } catch (e) { throw new Error(`${what}: ${String(e?.message || e).split(/\r?\n/)[0]}; the page says: ${await shown(frame)}`); }
};
// The Report's tiles, once both hold rows (or an error): each tile's text.
const tilesOf = async frame => {
  await waited(frame, frame.waitForFunction(() => {
    const tiles = [...document.querySelectorAll(".rp-tile")];
    return tiles.length >= 2 && tiles.every(t => t.querySelector("table td, .ex-error"));
  }, null, { timeout: 120_000 }), "the Report's tiles never drew");
  return frame.evaluate(() => [...document.querySelectorAll(".rp-tile")].map(t => t.innerText.replace(/\s+/g, " ").trim()));
};
const drawn = async (frame, how) => {
  const tiles = await tilesOf(frame);
  const all = tiles.find(t => t.startsWith("All of it")) ?? "", by = tiles.find(t => t.startsWith("By region")) ?? "";
  check(digits(all).includes(String(ROWS)) && digits(all).includes(String(TOTAL)),
    `${how}: the Report's first tile says the table's ${ROWS} rows and their sum, ${TOTAL} (${all.slice(0, 120)})`);
  check(/region/i.test(by) && /east/.test(by) && !/error/i.test(by), `${how}: its second tile lists the sum by region (${by.slice(0, 120)})`);
};

try {
  const fabric = createFabric({ getFabricToken: async () => FABRIC_TOKEN });
  const ws = String(await fabric.workspaceId(WS)).toLowerCase();
  const lake = (await fabric.listItems(WS)).find(i => i.type === "Lakehouse" && i.name.toLowerCase() === LAKEHOUSE.toLowerCase());
  if (!lake) throw new Error(`${WS} has no lakehouse ${LAKEHOUSE}`);
  const lh = String(lake.id).toLowerCase();
  const catalogUrl = `https://onelake.table.fabric.microsoft.com/iceberg/${ws}/${lh}`;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // The function's secrets are the export's; its storage token, ours.
  await run("the app", {
    plan: { warnings: [], title: "fabriclocal", name: "fabriclocal", modelName: "fabriclocal", fileName: "fabriclocal.bim",
            workspace: ws, lakehouse: lh, catalogUrl, modelPath: `${WS}/${LAKEHOUSE}.Lakehouse/Files/fabriclocal.bim`, tables: [[TABLE, SOURCE]] },
    model: bimOf(ws, lh), report: REPORT,
    env: { CATALOG_URL: catalogUrl, TABLES: SOURCE, RAYFIN_LOCAL_TOKEN_STORAGE: ONELAKE_TOKEN },
    seen: drawn,
  });
} catch (e) {
  check(false, String(e?.stack || e));
} finally {
  await browser?.close().catch(() => {});
}
// Asked to sign in, then what a viewer sees, both ways in.
const expected = 5;
if (checks.length !== expected) console.log(`FAIL ${checks.length} checks ran, not ${expected}`);
process.exit(checks.length === expected && checks.every(Boolean) ? 0 : 1);

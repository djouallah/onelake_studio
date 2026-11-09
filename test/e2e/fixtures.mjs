// What a machine holds after an account has used OneLake Studio: its listings and table metadata
// in the store, written by the real src/store.js and src/onelake.js, a saved query, and a semantic
// model's local copy. No rows: those are the engine's disk cache, and nothing here can read them.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createStore } = require("../../src/store.js");
const { createOneLake } = require("../../src/onelake.js");
const { PINS } = require("../../src/vendored.js");
const { writeApp } = require("../../src/exportapp.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = join(root, "vendor");

// A SQLite file under Files/, whose bytes the host keeps as it does any file it has read.
const DB_FILE = "data.Lakehouse/Files/shop.sqlite";
async function sqliteBytes() {
  const file = join(await mkdtemp(join(tmpdir(), "onelake-e2e-db-")), "shop.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
           CREATE TABLE orders (id INTEGER PRIMARY KEY, cust INT, amount REAL);
           CREATE VIEW big_orders AS SELECT * FROM orders WHERE amount > 3;
           INSERT INTO customers (name) VALUES ('a'), ('b');
           INSERT INTO orders (cust, amount) VALUES (1, 2.5), (2, 4), (2, 0);`);
  db.close();
  return readFile(file);
}

export const EXTENSION_ID = "djouallah.onelake-studio";
export const ACCOUNT = { key: "e2eaccount", queries: "e2e@contoso.com", tenant: "" };
export const WORKSPACE = "e2e";
export const TABLE = "lakehouse.e2e.data.dbo.orders";
export const NEVER_READ = "lakehouse.e2e.data.dbo.neverread";
export const MODEL = "semanticmodel.e2e.shop";
export const MODEL_QUERY = `SELECT Product.Color, AGG("Total") FROM ${MODEL} GROUP BY ALL`;
export const SAVED_QUERY = "kept";
// Where the extension keeps the zip a model's Report tab draws (src/exportflow.js reportKey).
export const REPORT_KEY = `exportReport:${WORKSPACE}/shop`;

const LAKEHOUSE = { workspace: WORKSPACE, item: "data.Lakehouse" };
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const ITEM_ID = "00000000-0000-0000-0000-000000000002";
const location = table => `abfss://${WORKSPACE}@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Tables/dbo/${table}/metadata/00001-x.metadata.json`;
const metadata = () => ({
  "format-version": 2,
  "current-snapshot-id": 1,
  "current-schema-id": 0,
  schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "id", type: "long", required: false }] }],
  snapshots: [{ "snapshot-id": 1, "timestamp-ms": 1, summary: { "total-records": "7", "total-data-files": "1" } }],
});

// Direct Lake, so a query of it reads its tables by their five-part names.
const partition = entityName => [{
  name: entityName, mode: "directLake",
  source: { type: "entity", entityName, schemaName: "dbo", expressionSource: "DatabaseQuery" },
}];
const BIM = {
  compatibilityLevel: 1604,
  model: {
    expressions: [{
      name: "DatabaseQuery", kind: "m",
      expression: `AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WORKSPACE_ID}/${ITEM_ID}")`,
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
};

export async function seedAccount({ dataDir, home }) {
  const dbBytes = await sqliteBytes();
  const store = createStore({
    dir: join(dataDir, "data", "User", "globalStorage", EXTENSION_ID, "onelake-store-v1", ACCOUNT.key),
  });
  const onelake = createOneLake({
    store,
    prefetchEnabled: () => false,
    catalog: {
      reset() {},
      listWorkspaces: async () => [WORKSPACE],
      listItems: async () => [{ name: LAKEHOUSE.item, kind: "Lakehouse" }],
      listTables: async () => ["orders", "neverread", "Sales", "Product"].map(table => ({ schema: "dbo", table })),
      listFiles: async (_, dir) => (dir ? [] : [{ name: "shop.sqlite", path: DB_FILE, isDir: false, bytes: dbBytes.length, version: "v1" }]),
      loadTable: async (_, t) => ({ metadata: metadata(), metadataLocation: location(t.table) }),
      readBytes: async (_, path) => (path === DB_FILE ? dbBytes : new Uint8Array()),
    },
    fabric: {
      listSemanticModels: async () => [{ id: "00000000-0000-0000-0000-000000000003", name: "shop", description: "" }],
      itemOf: async () => ({ workspace: WORKSPACE, item: LAKEHOUSE.item }),
    },
  });
  await onelake.workspaces({ fresh: true });
  await onelake.items(WORKSPACE, { fresh: true });
  await onelake.tables(LAKEHOUSE, { fresh: true });
  await onelake.files(LAKEHOUSE, "", { fresh: true });
  await onelake.readBytes(WORKSPACE, DB_FILE);
  for (const table of ["orders", "Sales", "Product"]) await onelake.table(LAKEHOUSE, { schema: "dbo", table }, { fresh: true });
  await onelake.itemNamed(WORKSPACE_ID, ITEM_ID, { fresh: true });
  await onelake.models(WORKSPACE, { fresh: true });

  const queries = join(home, "OneLakeStudio", "queries", ACCOUNT.queries);
  await mkdir(queries, { recursive: true });
  const saved = join(queries, `${SAVED_QUERY}.sql`);
  await writeFile(saved, "select 'from a saved query' as kept\n");

  const { tmslToOssie } = await import(pathToFileURL(join(VENDOR, "npm", PINS.daxSql, "formats", "ossie.js")).href);
  const { stringify } = await import(pathToFileURL(join(VENDOR, "npm", PINS.yaml, "+esm.js")).href);
  const model = join(home, "OneLakeStudio", "semantic-models", ACCOUNT.queries, WORKSPACE, "shop.yaml");
  await mkdir(dirname(model), { recursive: true });
  await writeFile(model, stringify(tmslToOssie(BIM, "shop")));

  // The model's Report, as an export's zip holds it: figures, a bar, a pivot and a slicer over the model, and a table that needs no rows
  // from OneLake, so it has a row to click. Its first column is a constant, so it names the model
  // column its clicks filter by (crossFilter).
  const report = join(home, "OneLakeStudio", "exports", "shop.zip");
  const tiles = [
    { title: "Totals", kind: "kpi", sql: 'SELECT AGG("Total") AS "Total" FROM model' },
    { title: "Total by Color", kind: "bar", sql: 'SELECT "Product"."Color" AS "Color", AGG("Total") AS "Total" FROM model GROUP BY ALL ORDER BY "Total" DESC' },
    { title: "Total by Color", kind: "pivot", pivot: { rows: ["Product.Color"], values: ["Total"], mark: "stacked" } },
    { title: "Color", kind: "pivot", pivot: { rows: ["Product.Color"], values: ["Total"], mark: "slicer", slicer: "list" } },
    { title: "Colors", kind: "table", sql: `SELECT 'Red' AS "Color", 3 AS "Total" FROM model`,
                                        crossFilter: '"Product"."Color"' }];
  await writeApp(report, new Map([["site/report.json", Buffer.from(JSON.stringify({ tiles }))]]), { e2e: true });

  return { saved, report, dbFile: { workspace: WORKSPACE, item: LAKEHOUSE.item, path: DB_FILE, bytes: dbBytes.length } };
}

// The extension's globalState, in the workbench's own storage in the browser, as a page reads or
// changes it. The key is found by what it holds, not by the database's name, which is VS Code's.
export const globalState = (page, patch = null) => page.evaluate(async ({ id, patch }) => {
  const asked = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const { name } of await indexedDB.databases()) {
    const db = await asked(indexedDB.open(name));
    try {
      if (!db.objectStoreNames.contains("ItemTable")) continue;
      const keys = await asked(db.transaction("ItemTable").objectStore("ItemTable").getAllKeys());
      const key = keys.find(k => String(k).toLowerCase() === id);
      if (!key) continue;
      const value = await asked(db.transaction("ItemTable").objectStore("ItemTable").get(key));
      const state = JSON.parse(value);
      if (!patch) return state;
      const next = { ...state, ...patch };
      const tx = db.transaction("ItemTable", "readwrite");
      tx.objectStore("ItemTable").put(JSON.stringify(next), key);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      return next;
    } finally {
      db.close();
    }
  }
  return null;
}, { id: EXTENSION_ID, patch });

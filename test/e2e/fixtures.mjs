// What a machine holds after an account has used OneLake Studio: its listings and table metadata
// in the store, written by the real src/store.js and src/onelake.js, a saved query, and a semantic
// model's local copy. No rows: those are the engine's disk cache, and nothing here can read them.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createStore } = require("../../src/store.js");
const { createOneLake } = require("../../src/onelake.js");
const { PINS } = require("../../src/vendored.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = join(root, "vendor");

export const EXTENSION_ID = "djouallah.onelake-studio";
export const ACCOUNT = { key: "e2eaccount", queries: "e2e@contoso.com", tenant: "" };
export const WORKSPACE = "e2e";
export const TABLE = "lakehouse.e2e.data.dbo.orders";
export const NEVER_READ = "lakehouse.e2e.data.dbo.neverread";
export const MODEL = "semanticmodel.e2e.shop";
export const MODEL_QUERY = `SELECT Product.Color, AGG("Total") FROM ${MODEL} GROUP BY ALL`;
export const SAVED_QUERY = "kept";

const LAKEHOUSE = { workspace: WORKSPACE, item: "data.Lakehouse" };
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
};

export async function seedAccount({ dataDir, home }) {
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
      listTables: async () => [{ schema: "dbo", table: "orders" }, { schema: "dbo", table: "neverread" }],
      listFiles: async () => [],
      loadTable: async (_, t) => ({ metadata: metadata(), metadataLocation: location(t.table) }),
      readBytes: async () => new Uint8Array(),
    },
    fabric: { listSemanticModels: async () => [{ id: "00000000-0000-0000-0000-000000000003", name: "shop", description: "" }] },
  });
  await onelake.workspaces({ fresh: true });
  await onelake.items(WORKSPACE, { fresh: true });
  await onelake.tables(LAKEHOUSE, { fresh: true });
  await onelake.table(LAKEHOUSE, { schema: "dbo", table: "orders" }, { fresh: true });
  await onelake.models(WORKSPACE, { fresh: true });

  const queries = join(home, "OneLakeStudio", "queries", ACCOUNT.queries);
  await mkdir(queries, { recursive: true });
  const saved = join(queries, `${SAVED_QUERY}.sql`);
  await writeFile(saved, "select 'from a saved query' as kept\n");

  const { tmslToOssie } = await import(pathToFileURL(join(VENDOR, "npm", PINS.daxSql, "formats", "ossie.js")).href);
  const { stringify } = await import(pathToFileURL(join(VENDOR, "npm", PINS.yaml, "+esm.js")).href);
  const model = join(home, "OneLakeStudio", "semantic-models", WORKSPACE, "shop.yaml");
  await mkdir(dirname(model), { recursive: true });
  await writeFile(model, stringify(tmslToOssie(BIM, "shop")));

  return { saved };
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

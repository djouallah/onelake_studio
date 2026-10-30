// What the command line's tests share: a OneLake cache to answer from, and stand-ins for the
// vendored modules, which CI's test job does not have (the engine job tests the real ones).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAgent } = require("../../src/agent.js");

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");

// A cache that knows "a ws" and "b ws" but has never listed "unseen"; anything that would
// go to OneLake or Fabric is counted.
export function fakeOneLake() {
  const at = Date.now() - 3 * 3600 * 1000;
  const calls = [];
  const remote = name => async (...a) => { calls.push([name, ...a.slice(0, -1)]); return name === "workspaces" ? ["x"] : []; };
  const known = {
    workspaces: ["b ws", "a ws", "unseen"],
    "items a ws": [{ name: "a.Lakehouse", kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }],
    "items b ws": [{ name: "b.Lakehouse", kind: "Lakehouse" }],
    "models a ws": [{ name: "Sales", description: "the sales model" }, { name: "Ops", description: "" }],
    "models b ws": [{ name: "Energy", description: "" }],
  };
  const hit = k => (k in known ? { value: known[k], at } : null);
  return {
    calls,
    workspaces: remote("workspaces"), items: remote("items"), models: remote("models"),
    tables: remote("tables"), table: remote("table"),
    cached: {
      workspaces: async () => hit("workspaces"),
      items: async ws => hit(`items ${ws}`),
      models: async ws => hit(`models ${ws}`),
      tables: async () => null,
      table: async () => null,
    },
  };
}

// The vendored modules an answer loads. YAML here is JSON, and the "Ossie" document carries the
// TMSL it stands for, so nothing here exercises model parsing: cli-engine.test.mjs does.
export async function stubVendor(dir) {
  for (const [p, body] of [
    ["npm/pin/src/index.js", "export const createCompiler = 0, createViews = 0;"],
    ["npm/pin/formats/tmsl.js", "export const tmslToModel = 0;"],
    ["npm/pin/formats/ossie.js", "export const ossieToTmsl = doc => doc.tmsl;"],
    ["npm/yaml/+esm.js", "export const parse = JSON.parse;"],
  ]) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), body);
  }
}

// One moment per run: two agents built from this cache answer byte for byte alike.
const RICH_AT = Date.now() - 10 * 60 * 1000;

// A fuller cache: one lakehouse with two tables (one with metadata), a Files/ folder, a
// warehouse, and one downloaded model on disk. `tables`: that many more, for --limit to cut;
// `reverse`: every listing in the opposite order.
export async function richAgent({ tables = 0, engine = null, exportApp = null, signedIn, reverse = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  await stubVendor(dir);
  const bim = join(dir, "Sales.yaml");
  await writeFile(bim, JSON.stringify({ datasets: [], tmsl: { model: { tables: [
    { name: "dim_customer", columns: [{ name: "customer_id" }, { name: "Region" }] },
    { name: "fct_sales", columns: [{ name: "amount" }], measures: [{ name: "Total Sales" }, { name: "Customer Count" }] },
  ] } } }));
  const at = RICH_AT;
  const lh ="ws\u0000data.Lakehouse";
  const order = list => (reverse ? [...list].reverse() : list);
  const known = {
    workspaces: ["ws"],
    "items ws": order([{ name: "data.Lakehouse", kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }]),
    "models ws": order([{ name: "Sales", description: "" }, { name: "Ops", description: "" }]),
    [`tables ${lh}`]: order([{ schema: "", table: "customers" }, { schema: "", table: "orders" },
                             ...Array.from({ length: tables }, (_, i) => ({ schema: "", table: `t${String(i).padStart(4, "0")}` }))]),
    [`table ${lh}\u0000\u0000customers`]: { totalRecords: 1200, schemaFields: [{ name: "customer_id", type: "long" }],
      stats: { totalFilesSize: 2_500_000, totalDataFiles: 3, snapshotTs: Date.UTC(2026, 9, 1, 8, 30),
               codec: "zstd", snapshotCount: 4, operation: "append", formatVersion: 2 } },
    [`files ${lh}\u0000raw`]: order([{ name: "2026", isDir: true }, { name: "a.parquet", isDir: false, bytes: 1_000_000 }]),
    [`files ${lh}\u0000empty`]: [],
  };
  const hit = k => (k in known ? { value: known[k], at } : null);
  const calls = [];
  const remote = name => async () => { calls.push(name); return []; };
  const onelake = {
    workspaces: remote("workspaces"), items: remote("items"), models: remote("models"),
    tables: remote("tables"), table: remote("table"), files: remote("files"),
    cached: {
      workspaces: async () => hit("workspaces"),
      items: async ws => hit(`items ${ws}`),
      models: async ws => hit(`models ${ws}`),
      tables: async l => hit(`tables ${l.workspace}\u0000${l.item}`),
      table: async (l, t) => hit(`table ${l.workspace}\u0000${l.item}\u0000${t.schema || ""}\u0000${t.table}`),
      files: async (l, d) => hit(`files ${l.workspace}\u0000${l.item}\u0000${d}`),
    },
  };
  const agent = createAgent({
    onelake, modelPath: (ws, m) => (m === "Sales" ? bim : join(dir, "none.yaml")),
    appDir: APP_DIR, vendorDir: dir, daxSqlPin: "pin", yamlPin: "yaml",
    semviews: { texts: async () => [] }, engine: engine && (async () => engine), exportApp, signedIn,
  });
  return { agent, calls, dir, onelake, close: () => rm(dir, { recursive: true, force: true }) };
}

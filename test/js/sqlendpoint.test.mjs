// Tests for src/sqlendpoint.js — a Direct Lake model over a SQL endpoint, pointed at the item
// behind it. No network: Fabric and OneLake are canned here, and fabric.test.mjs has the requests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lakehousesOf, directLakeTables } from "../../app/semantic.js";

const require = createRequire(import.meta.url);
const { readFromOneLake, sqlEndpointOf, guidOfLabel } = require("../../src/sqlendpoint.js");

// 11111111-2222-3333-4444-555555555555, as a Fabric SQL host writes it.
const WS_ID = "11111111-2222-3333-4444-555555555555";
const WS_LABEL = "ceircejceiztgrcekvkvkvkvku";
const HOME_ID = WS_ID;
const ENDPOINT = "aaaaaaaa-0000-0000-0000-000000000001";
const LAKE = "bbbbbbbb-0000-0000-0000-000000000002";
const HOST = `xpkymsttihxelp6vuo2w5ywt2u-${WS_LABEL}.datawarehouse.fabric.microsoft.com`;

const partition = (entityName, extra = {}) => [{ mode: "directLake", source:
  { type: "entity", entityName, expressionSource: "DatabaseQuery", ...extra } }];
const model = (over = {}) => ({ model: {
  expressions: [{ name: "DatabaseQuery", kind: "m", expression: [
    "let", `\tdatabase = Sql.Database("${HOST}", "${ENDPOINT.toUpperCase()}")`, "in", "\tdatabase",
  ] }],
  tables: [{ name: "duid", partitions: partition("duid") }, { name: "price", partitions: partition("price", { schemaName: "aemo" }) }],
  ...over,
} });

// The model's own workspace, `home`: what it lists and what Fabric calls it.
const deps = ({ endpoint = null, items = {}, home = HOME_ID, hidden = [] } = {}) => {
  const asked = [];
  return { asked, fabric: {
    itemOfSqlEndpoint: async (ws, id) => { asked.push([ws, id]); return endpoint; },
    workspaceId: async () => home,
    listItems: async () => Object.keys(items).filter(dir => !hidden.includes(dir)).map((dir, i) => {
      const [name, type] = dir.split(".");
      return { id: `cccccccc-0000-0000-0000-00000000000${i}`, name, type };
    }),
  }, onelake: {
    items: async () => Object.keys(items).map(name => ({ name, kind: name.split(".")[1] })),
    tables: async ({ item }) => {
      if (!items[item]) throw new Error("no listing");
      return items[item];
    },
  } };
};
const t = (schema, table) => ({ schema, table });

test("a host's label is the GUID's bytes in base32, the first three groups little-endian", () => {
  assert.equal(guidOfLabel(WS_LABEL), WS_ID);
  assert.equal(guidOfLabel(WS_LABEL.toUpperCase()), WS_ID);
});

test("a table named item.schema.table (an Ossie copy's source) is in that item of the model's workspace", () => {
  const bim = { model: { tables: [
    { name: "price", partitions: [{ source: { type: "entity", entityName: "price", schemaName: "nem.aemo" } }] },
    { name: "duid", partitions: [{ source: { type: "entity", entityName: '"DUID list"', schemaName: '"my lake".dbo' } }] },
    // Not so named: a schema.table, a longer name, one with its expression.
    { name: "plain", partitions: [{ source: { type: "entity", entityName: "x", schemaName: "dbo" } }] },
    { name: "long", partitions: [{ source: { type: "entity", entityName: "x", schemaName: "a.b.c" } }] },
    { name: "expr", partitions: [{ source: { type: "entity", entityName: "x", schemaName: "a.b", expressionSource: "DirectLake" } }] },
  ] } };
  const tables = directLakeTables(bim);
  assert.deepEqual(tables.get("price"), { item: "nem", t: { schema: "aemo", table: "price" } });
  assert.deepEqual(tables.get("duid"), { item: "my lake", t: { schema: "dbo", table: "DUID list" } });
  for (const t of ["plain", "long", "expr"]) assert.equal(tables.has(t), false, t);
  assert.deepEqual(lakehousesOf(bim, "home"), [{ workspaceName: "home", itemName: "nem" }, { workspaceName: "home", itemName: "my lake" }]);
});

test("sqlEndpointOf: the workspace and endpoint a Sql.Database names, and nothing else", () => {
  assert.deepEqual(sqlEndpointOf(model().model.expressions[0].expression), { workspace: WS_ID, endpoint: ENDPOINT });
  assert.equal(sqlEndpointOf(`Sql.Database("${HOST}", "my_database")`), null, "a database by name");
  assert.equal(sqlEndpointOf('Sql.Database("server.example.com", "' + ENDPOINT + '")'), null, "not a Fabric host");
  assert.equal(sqlEndpointOf('AzureStorage.DataLake("https://x")'), null);
  assert.equal(sqlEndpointOf(undefined), null);
});

test("an endpoint Fabric shows: its model reads the item behind it, as one over OneLake does", async () => {
  const bim = model();
  const d = deps({ endpoint: { workspace: WS_ID, item: LAKE } });
  assert.deepEqual(await readFromOneLake(bim, "home", d), { notes: [] });
  assert.deepEqual(d.asked, [[WS_ID, ENDPOINT]], "the endpoint is looked for in the host's workspace");
  assert.deepEqual(lakehousesOf(bim), [{ workspace: WS_ID, item: LAKE }]);
  const tables = directLakeTables(bim);
  assert.deepEqual(tables.get("duid").t, { schema: "dbo", table: "duid" });
  assert.deepEqual(tables.get("price").t, { schema: "aemo", table: "price" });
});

test("an endpoint Fabric doesn't show: the one item in the model's workspace holding every table, and it says so", async () => {
  const bim = model();
  const r = await readFromOneLake(bim, "home", deps({ items: {
    "other.Lakehouse": [t("dbo", "duid")],
    "storage.Lakehouse": [t(undefined, "DUID"), t("aemo", "price"), t("dbo", "more")],
    "report.Report": [],
  } }));
  assert.equal(r.refused, undefined);
  assert.match(r.notes[0], /cannot be found.*storage in home/);
  assert.deepEqual(lakehousesOf(bim), [{ workspace: HOME_ID, item: "cccccccc-0000-0000-0000-000000000001" }]);
});

test("no guessing: none, two, or a listing that can't be read is refused, and nothing moves", async () => {
  const cases = {
    "no item holds them": [{ "a.Lakehouse": [t("dbo", "duid")] }, /no item in home holds all its 2/],
    "two items hold them": [{
      "a.Lakehouse": [t("dbo", "duid"), t("aemo", "price")],
      "b.Warehouse": [t("dbo", "duid"), t("aemo", "price")],
    }, /a, b in home all hold/],
    "one could not be listed": [{
      "a.Lakehouse": [t("dbo", "duid"), t("aemo", "price")],
      "b.Lakehouse": null,
    }, /not every item in home could be listed/],
  };
  for (const [name, [items, why]] of Object.entries(cases)) {
    const bim = model();
    const r = await readFromOneLake(bim, "home", deps({ items }));
    assert.match(r.refused, /cannot be found/, name);
    assert.match(r.why, why, name);
    assert.deepEqual(lakehousesOf(bim), [], name);
  }
});

test("no guessing: an endpoint in another workspace isn't looked for here, whatever holds tables of those names", async () => {
  const bim = model();
  const items = { "storage.Lakehouse": [t("dbo", "duid"), t("aemo", "price")] };
  const r = await readFromOneLake(bim, "home", deps({ items, home: "22222222-2222-2222-2222-222222222222" }));
  assert.match(r.refused, /cannot be found/);
  assert.match(r.why, /isn't this model's/);
  assert.deepEqual(lakehousesOf(bim), []);
});

test("no guessing: a second holder Fabric doesn't list, as one renamed since the listing, still counts", async () => {
  const bim = model();
  const r = await readFromOneLake(bim, "home", deps({ hidden: ["old.Lakehouse"], items: {
    "new.Lakehouse": [t("dbo", "duid"), t("aemo", "price")],
    "old.Lakehouse": [t("dbo", "duid"), t("aemo", "price")],
  } }));
  assert.match(r.refused, /cannot be found/);
  assert.deepEqual(lakehousesOf(bim), []);
});

test("an Import or DirectQuery table reading a Sql.Database is left alone, and nobody is asked", async () => {
  for (const mode of ["import", "directQuery"]) {
    const bim = model({ tables: [{ name: "duid", partitions: [{ mode, source: { type: "entity", entityName: "duid", expressionSource: "DatabaseQuery" } }] }] });
    const before = JSON.stringify(bim);
    const d = deps();
    assert.deepEqual(await readFromOneLake(bim, "home", d), { notes: [] });
    assert.equal(JSON.stringify(bim), before);
    assert.deepEqual(d.asked, []);
  }
});

test("a partition with no mode takes the model's", async () => {
  const bim = model({ defaultMode: "directLake", tables: [{ name: "duid", partitions: [{ source: { type: "entity", entityName: "duid", expressionSource: "DatabaseQuery" } }] }] });
  await readFromOneLake(bim, "home", deps({ endpoint: { workspace: WS_ID, item: LAKE } }));
  assert.equal(lakehousesOf(bim).length, 1);
});

test("a model already over OneLake is not touched", async () => {
  const url = `https://onelake.dfs.fabric.microsoft.com/${WS_ID}/${LAKE}`;
  const bim = model({ expressions: [{ name: "DatabaseQuery", expression: `AzureStorage.DataLake("${url}")` }] });
  const d = deps();
  assert.deepEqual(await readFromOneLake(bim, "home", d), { notes: [] });
  assert.deepEqual(d.asked, []);
});

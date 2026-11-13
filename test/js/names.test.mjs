// names.js: what OneLake's names and metadata mean, as the host reads them. These rules
// are about Fabric's INTERNAL type names (the directory suffixes OneLake uses), not the
// portal's — guessing the portal's spelling is how a workspace once came up empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const n = createRequire(import.meta.url)("../../core/names.js");

test("the items that write Delta into OneLake hold tables; the rest do not", () => {
  for (const name of ["sales.Lakehouse", "dw.Warehouse", "app.SQLDbNative", "snow.MirroredDatabase"])
    assert.ok(n.holdsTables(name), name);
  for (const name of ["bricks.DatabricksCatalog", "nb.SynapseNotebook", "kql.KustoDatabase", "loose.txt", ""])
    assert.ok(!n.holdsTables(name), name);
});

test("a mirrored database is listed under the suffix OneLake gives it, and named as the portal does", () => {
  assert.ok(n.holdsTables("sales.MountedRelationalDatabase"));
  assert.ok(n.isMirrored("sales.MountedRelationalDatabase"));
  assert.ok(!n.isMirrored("sales.Lakehouse"));
  assert.equal(n.kindLabel("MountedRelationalDatabase"), "Mirrored database");
});

test("a table is Delta when its Iceberg metadata is XTable's conversion of a Delta log", () => {
  const xtable = from => JSON.stringify({ sourceTableFormat: from, sourceIdentifier: "12" });
  assert.deepEqual(n.sourceFormat({ properties: { XTABLE_METADATA: xtable("DELTA") } }),
    { format: "delta", deltaVersion: 12 });
  // Written as Iceberg: the Iceberg metadata is the original and carries no XTable stamp.
  assert.deepEqual(n.sourceFormat({ properties: {} }), { format: "iceberg", deltaVersion: null });
  assert.deepEqual(n.sourceFormat({}), { format: "iceberg", deltaVersion: null });
  // A stamp that cannot be parsed was still written by the conversion.
  assert.equal(n.sourceFormat({ properties: { XTABLE_METADATA: "{" } }).format, "delta");
});

test("an Iceberg table's history is its snapshots, newest first", () => {
  const h = n.icebergHistory({ snapshots: [
    { "snapshot-id": 1, "sequence-number": 1, "timestamp-ms": 10,
      summary: { operation: "append", "added-records": "5", "total-records": "5" } },
    { "snapshot-id": 2, "sequence-number": 2, "timestamp-ms": 20,
      summary: { operation: "delete", "deleted-records": "2", "total-records": "3" } },
  ] });
  assert.deepEqual(h.map(x => x.version), ["2", "1"]);
  assert.equal(h[0].operation, "delete");
  assert.equal(h[0].rowsRemoved, 2);
  assert.equal(h[1].rowsAdded, 5);
  assert.equal(h[1].totalRows, 5);
  assert.equal(h[0].columns, null);
});

test("a snapshot says how its columns differ from the table's now", () => {
  const h = n.icebergHistory({
    "current-schema-id": 1,
    schemas: [{ "schema-id": 0, fields: [{ name: "a" }, { name: "old" }] },
              { "schema-id": 1, fields: [{ name: "a" }, { name: "new" }] }],
    snapshots: [{ "snapshot-id": 1, "sequence-number": 1, "schema-id": 0, summary: {} },
                { "snapshot-id": 2, "sequence-number": 2, "schema-id": 1, summary: {} }],
  });
  assert.equal(h[0].columns, null);
  assert.deepEqual(h[1].columns, { added: ["new"], removed: ["old"] });
});

test("only a lakehouse has a Files/ area, and kinds read as the portal says them", () => {
  assert.ok(n.hasFilesArea("a.Lakehouse"));
  assert.ok(!n.hasFilesArea("a.Warehouse"));
  assert.equal(n.kindLabel("SQLDbNative"), "SQL database");
  assert.equal(n.kindLabel("Lakehouse"), "Lakehouse");
});

test("a table's columns and statistics come from its metadata, current snapshot only", () => {
  const meta = {
    "format-version": 2, "default-spec-id": 0,
    "partition-specs": [{ "spec-id": 0, fields: [{ name: "day", transform: "day" }, { name: "region", transform: "identity" }] }],
    properties: { "write.parquet.compression-codec": "zstd" },
    snapshots: [{ "snapshot-id": 1 }, { "snapshot-id": 2 }],
  };
  const snap = { "timestamp-ms": 5, summary: { "total-files-size": "2048", "total-data-files": "3", operation: "append" } };
  const s = n.snapshotStats(meta, snap);
  assert.deepEqual(s.partitionColumns, ["day (day)", "region"]);
  assert.equal(s.codec, "zstd");
  assert.equal(s.totalDataFiles, 3);
  assert.equal(s.snapshotCount, 2);
  assert.deepEqual(n.icebergFields({ fields: [{ name: "id", type: "long" },
    { name: "tags", type: { type: "list", element: "string" } }] }),
    [{ name: "id", type: "long" }, { name: "tags", type: "list<string>" }]);
});

test("a byte count reads as a size", () => {
  assert.equal(n.fmtBytes(2048), "2 KB");
  assert.equal(n.fmtBytes(0), "unknown size");
});

test("a table's SQL name is workspace.item_kind.schema.table, quoted only where it must be", () => {
  assert.equal(n.sqlNameOf({ workspace: "aemo", item: "data.Lakehouse" }, { schema: "dbo", table: "dim_duid" }),
    "aemo.data_lakehouse.dbo.dim_duid");
  // A lakehouse without schemas is dbo; Fabric's spelling of the kind, not the directory's.
  assert.equal(n.sqlNameOf({ workspace: "ws", item: "db.SQLDbNative" }, { schema: "", table: "t" }),
    "ws.db_sqldatabase.dbo.t");
  assert.equal(n.sqlNameOf({ workspace: "ws", item: "m.MountedRelationalDatabase" }, { schema: "dbo", table: "t" }),
    "ws.m_mirroreddatabase.dbo.t");
  assert.equal(n.sqlNameOf({ workspace: "ANZ Retail", item: "gold-1.Warehouse" }, { schema: "select", table: 'a"b' }),
    '"ANZ Retail"."gold-1_warehouse"."select"."a""b"');
  assert.throws(() => n.sqlNameOf({ workspace: "ws", item: "nb.SynapseNotebook" }, { table: "t" }));
  // The kind is always written, so an item whose name ends in one is still one item.
  assert.equal(n.sqlNameOf({ workspace: "ws", item: "x_lakehouse.Lakehouse" }, { schema: "dbo", table: "t" }),
    "ws.x_lakehouse_lakehouse.dbo.t");
  // Every table-holding item has a kind.
  for (const k of ["Lakehouse", "Warehouse", "SQLDbNative", "MountedRelationalDatabase", "MirroredDatabase"])
    assert.ok(n.SQL_KINDS.includes(n.sqlKind(k)), k);
});

test("an item's part is read back as its name and its kind, the last _<kind> in any case", () => {
  assert.deepEqual(n.splitItem("data_lakehouse"), { item: "data", kind: "lakehouse" });
  assert.deepEqual(n.splitItem("Gold-1_WAREHOUSE"), { item: "Gold-1", kind: "warehouse" });
  assert.deepEqual(n.splitItem("x_lakehouse_lakehouse"), { item: "x_lakehouse", kind: "lakehouse" });
  assert.deepEqual(n.splitItem("nem_semanticmodel", [n.MODEL_KIND]), { item: "nem", kind: "semanticmodel" });
  for (const no of ["data", "_lakehouse", "lakehouse", "data_notebook", "datalakehouse", "nem_semanticmodel"]) assert.equal(n.splitItem(no), null, no);
  assert.ok(n.isGuid("0F3C1A2B-1111-2222-3333-444455556666"));
  assert.ok(!n.isGuid("aemo") && !n.isGuid("0f3c1a2b-1111-2222-3333-44445555666"));
});

test("a file's SQL name is its lakehouse, as in a table's name, then its path under Files/", () => {
  assert.equal(n.fileSqlName({ workspace: "aemo", item: "data.Lakehouse" }, "a/x.parquet"), "aemo.data_lakehouse/Files/a/x.parquet");
  assert.equal(n.fileSqlName({ workspace: "aemo", item: "data.Lakehouse" }), "aemo.data_lakehouse/Files", "the folder itself");
  assert.equal(n.fileSqlName({ workspace: "ANZ Retail", item: "select.Lakehouse" }, "a b.csv"), '"ANZ Retail".select_lakehouse/Files/a b.csv');
  assert.throws(() => n.fileSqlName({ workspace: "ws", item: "dw.Warehouse" }, "x"), /only a lakehouse/);
});

test("what DuckDB ran says a file by its name: a lakehouse's Files/ only, and never by GUID", () => {
  const host = "onelake.dfs.fabric.microsoft.com";
  assert.equal(n.fileNamesIn(`SELECT * FROM 'abfss://ANZ Retail@${host}/data.Lakehouse/Files/a b.csv'`),
    `SELECT * FROM '"ANZ Retail".data_lakehouse/Files/a b.csv'`);
  assert.equal(n.fileNamesIn(`FROM 'zip://abfss://ws@${host}/lh.Lakehouse/Files/a.zip/b.csv'`), "FROM 'zip://ws.lh_lakehouse/Files/a.zip/b.csv'");
  for (const same of [`abfss://ws@${host}/lh.Lakehouse/Tables/dbo/t/metadata/1.metadata.json`, `abfss://ws@${host}/dw.Warehouse/Files/x`,
                      `abfss://11111111-0000@${host}/22222222-0000/Files/x`, `abfss://ws@${host}/lh.Lakehouse/Filesystem/x`])
    assert.equal(n.fileNamesIn(same), same);
});

test("the host and the panel quote a name the same way (core/names.js and page/paths.js sqlPart)", async () => {
  const p = await import("../../page/paths.js");
  assert.deepEqual([...n.RESERVED].sort(), [...p.RESERVED].sort());
  for (const s of [...p.RESERVED, "Order", "sales", "_x1", "1st", "a b", 'a"b', "café", "", 42])
    assert.equal(p.sqlPart(s), n.sqlPart(s), String(s));
  for (const [ws, item, rest] of [["aemo", "data", "a/x.parquet"], ["ANZ Retail", "gold_1", "a b.csv"], ["ws", "select", "x"], ["ws", "lh", ""]])
    assert.equal(p.fileSqlName(ws, `${item}.Lakehouse/Files${rest ? `/${rest}` : ""}`), n.fileSqlName({ workspace: ws, item: `${item}.Lakehouse` }, rest));
  // The model views are named alike on both sides, quoted where the name with its kind must be.
  const semantic = await import("../../page/semantic.js");
  for (const [ws, model] of [["ws", "order"], ["ANZ Retail", "Sales Model"], ["select", "x"]])
    assert.equal(semantic.modelSqlName(ws, model), n.modelSqlName(ws, model), model);
  assert.equal(n.modelSqlName("ws", "order"), "ws.order_semanticmodel");
  assert.equal(n.modelSqlName("ANZ Retail", "Sales Model"), '"ANZ Retail"."Sales Model_semanticmodel"');
});

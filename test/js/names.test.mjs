// names.js: what OneLake's names and metadata mean, as the host reads them. These rules
// are about Fabric's INTERNAL type names (the directory suffixes OneLake uses), not the
// portal's — guessing the portal's spelling is how a workspace once came up empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const n = createRequire(import.meta.url)("../../src/names.js");

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
  assert.equal(n.kindLabelPlural("MountedRelationalDatabase"), "Mirrored databases");
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

test("a table's SQL name is Kind.workspace.item.schema.table, quoted only where it must be", () => {
  assert.equal(n.sqlNameOf({ workspace: "aemo", item: "data.Lakehouse" }, { schema: "dbo", table: "dim_duid" }),
    "lakehouse.aemo.data.dbo.dim_duid");
  // A lakehouse without schemas is dbo; Fabric's spelling of the kind, not the directory's.
  assert.equal(n.sqlNameOf({ workspace: "ws", item: "db.SQLDbNative" }, { schema: "", table: "t" }),
    "sqldatabase.ws.db.dbo.t");
  assert.equal(n.sqlNameOf({ workspace: "ws", item: "m.MountedRelationalDatabase" }, { schema: "dbo", table: "t" }),
    "mirroreddatabase.ws.m.dbo.t");
  assert.equal(n.sqlNameOf({ workspace: "ANZ Retail", item: "gold-1.Warehouse" }, { schema: "select", table: 'a"b' }),
    'warehouse."ANZ Retail"."gold-1"."select"."a""b"');
  assert.throws(() => n.sqlNameOf({ workspace: "ws", item: "nb.SynapseNotebook" }, { table: "t" }));
  // One catalog per kind, and every table-holding item has one.
  for (const k of ["Lakehouse", "Warehouse", "SQLDbNative", "MountedRelationalDatabase", "MirroredDatabase"])
    assert.ok(n.SQL_KINDS.includes(n.sqlKind(k)), k);
});

test("the host and the panel quote a name the same way (src/names.js and app/paths.js sqlPart)", async () => {
  const p = await import("../../app/paths.js");
  assert.deepEqual([...n.RESERVED].sort(), [...p.RESERVED].sort());
  for (const s of [...p.RESERVED, "Order", "sales", "_x1", "1st", "a b", 'a"b', "café", "", 42])
    assert.equal(p.sqlPart(s), n.sqlPart(s), String(s));
  // The model views are named alike on both sides: a model called `order` is quoted.
  const semantic = await import("../../app/semantic.js");
  assert.equal(semantic.modelSqlName("ws", "order"), n.modelSqlName("ws", "order"));
  assert.equal(semantic.modelSqlName("ws", "order"), 'semanticmodel.ws."order"');
});

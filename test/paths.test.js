// Tests for site/paths.js — the pure helpers behind the engine.
//
// These cover the cases that used to return wrong data silently: cache keys that
// collided across folders and lakehouses, comment stripping that ate string literals,
// URI escaping applied to an already-escaped path, and metadata version selection that
// fell back to a one-second-resolution timestamp.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DFS_HOST, strip, basename, encPath, dfsUrl, toHttps, pathKey,
  parseLakehouse, fileExt, readerFor, PARQUET_EXTS,
  TEXT_EXTS, isTextExt,
  sqlStr, quoteIdent, stripComments, prepareReadOnlySql,
  metadataVersion, pickMetadata,
  tableKey, fileKey, sanitizeIdent,
  normalizeValue, fmtBytes,
} from "../site/paths.js";

// -----------------------------------------------------------------------------
test("strip and basename", () => {
  assert.equal(strip("/a/b/"), "a/b");
  assert.equal(strip("///"), "");
  assert.equal(basename("ws/item/Tables/t/f.parquet"), "f.parquet");
  assert.equal(basename("f.parquet"), "f.parquet");
});

// -----------------------------------------------------------------------------
// encPath vs toHttps — the double-encoding bug (C3/C7)
// -----------------------------------------------------------------------------
test("encPath escapes a RAW path from a DFS listing", () => {
  // A DFS list .name is literal: a space is a space and must become %20.
  assert.equal(encPath("item/Files/my data/x.csv"), "item/Files/my%20data/x.csv");
  // A literal percent in a file name must become %25.
  assert.equal(encPath("item/Files/100%/x.csv"), "item/Files/100%25/x.csv");
  // Slashes stay as separators.
  assert.equal(encPath("/a/b/c/"), "a/b/c");
});

test("dfsUrl encodes the workspace and the path", () => {
  assert.equal(
    dfsUrl("my ws", "item.Lakehouse/Files/a b.csv"),
    `https://${DFS_HOST}/my%20ws/item.Lakehouse/Files/a%20b.csv`);
});

test("toHttps carries an already-escaped URI path across untouched", () => {
  // This is the regression: the path came out of Iceberg metadata, so %20 is already an
  // escape. Encoding it again produced %2520 and a 404 from OneLake.
  const uri = "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/my%20part/f.parquet";
  assert.equal(
    toHttps("ignored", uri),
    `https://${DFS_HOST}/WS/ITEM/Tables/t/my%20part/f.parquet`);
  assert.ok(!toHttps("ignored", uri).includes("%2520"));
});

test("toHttps accepts both abfs:// and abfss://", () => {
  const one = "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet";
  const two = "abfss://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet";
  assert.equal(toHttps("ws", one), toHttps("ws", two));
});

test("toHttps passes an absolute https URL through, and resolves a relative one", () => {
  assert.equal(toHttps("ws", "https://example.test/a/b"), "https://example.test/a/b");
  assert.equal(toHttps("my ws", "item/Tables/t"), `https://${DFS_HOST}/my%20ws/item/Tables/t`);
});

test("pathKey collapses every spelling of the same data file", () => {
  const want = "WS/ITEM/Tables/t/f.parquet";
  assert.equal(pathKey("abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet"), want);
  assert.equal(pathKey("abfss://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet"), want);
  assert.equal(pathKey(`https://${DFS_HOST}/WS/ITEM/Tables/t/f.parquet`), want);
  assert.equal(pathKey("/WS/ITEM/Tables/t/f.parquet"), want);
});

test("pathKey makes abfs and abfss delete entries join", () => {
  // The anti-join that applies position deletes compares these two. Exact string
  // equality matched nothing and the deleted rows came back as live.
  const fromManifest = "abfss://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet";
  const fromDeleteFile = "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet";
  assert.equal(pathKey(fromManifest), pathKey(fromDeleteFile));
});

// -----------------------------------------------------------------------------
test("parseLakehouse accepts the shapes a user can paste", () => {
  assert.deepEqual(parseLakehouse("ws/lh.Lakehouse"), { workspace: "ws", item: "lh.Lakehouse" });
  assert.deepEqual(parseLakehouse("ws/lh"), { workspace: "ws", item: "lh.Lakehouse" });
  assert.deepEqual(parseLakehouse("  ws/lh.Lakehouse  "), { workspace: "ws", item: "lh.Lakehouse" });
  assert.deepEqual(parseLakehouse(`https://${DFS_HOST}/ws/lh.Lakehouse/Tables`),
                   { workspace: "ws", item: "lh.Lakehouse" });
  assert.throws(() => parseLakehouse(""), /Enter a lakehouse path/);
  assert.throws(() => parseLakehouse("justone"), /workspace\/lakehouse\.Lakehouse/);
});

test("parseLakehouse takes the workspace from an abfss authority", () => {
  // The workspace is the authority here, not a path segment. Stripping the scheme and
  // the authority together left "lh.Lakehouse" alone and the parse failed.
  assert.deepEqual(parseLakehouse("abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse"),
                   { workspace: "ws", item: "lh.Lakehouse" });
  assert.deepEqual(parseLakehouse("abfs://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/t"),
                   { workspace: "ws", item: "lh.Lakehouse" });
});

test("parseLakehouse unescapes segments that came from a URL", () => {
  assert.deepEqual(parseLakehouse(`https://${DFS_HOST}/my%20ws/my%20lh.Lakehouse`),
                   { workspace: "my ws", item: "my lh.Lakehouse" });
  assert.deepEqual(parseLakehouse("abfss://my%20ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse"),
                   { workspace: "my ws", item: "lh.Lakehouse" });
  // A typed path is literal — a % in a name is not an escape.
  assert.deepEqual(parseLakehouse("100% ws/lh.Lakehouse"),
                   { workspace: "100% ws", item: "lh.Lakehouse" });
});

// -----------------------------------------------------------------------------
test("fileExt keeps a compression codec attached to its base format", () => {
  assert.equal(fileExt("a.csv"), "csv");
  assert.equal(fileExt("a.CSV"), "csv");
  assert.equal(fileExt("a.csv.gz"), "csv.gz");
  assert.equal(fileExt("a.jsonl.zst"), "jsonl.zst");
  assert.equal(fileExt("dir/a.parquet"), "parquet");
  assert.equal(fileExt("noext"), "");
  // A .tar.gz is not a compressed CSV; it falls through and stays unreadable.
  assert.equal(fileExt("a.tar.gz"), "tar.gz");
  assert.equal(readerFor("tar.gz"), null);
});

test("readerFor covers the advertised formats and nothing else", () => {
  for (const ext of ["parquet", "csv", "tsv", "txt", "json", "jsonl", "ndjson", "avro", "xlsx",
                     "csv.gz", "json.zst"])
    assert.ok(readerFor(ext), `${ext} should be readable`);
  assert.equal(readerFor("docx"), null);
  assert.equal(readerFor(""), null);
  // Not inherited from Object.prototype.
  assert.equal(readerFor("constructor"), null);
  assert.equal(readerFor("toString"), null);
  assert.ok(PARQUET_EXTS.has("parquet"));
});

test("plain-text formats are readable, compressed or not", () => {
  for (const ext of TEXT_EXTS) {
    assert.ok(readerFor(ext), `${ext} should be readable`);
    assert.ok(readerFor(`${ext}.gz`), `${ext}.gz should be readable`);
    assert.ok(readerFor(`${ext}.zst`), `${ext}.zst should be readable`);
    assert.ok(isTextExt(ext), `${ext} should count as text`);
    assert.ok(isTextExt(`${ext}.gz`), `${ext}.gz should count as text`);
  }
  // Tabular formats are not text, so they keep their own status line.
  for (const ext of ["parquet", "csv", "csv.gz", "json", "avro", "xlsx"])
    assert.equal(isTextExt(ext), false, `${ext} should not count as text`);
});

// -----------------------------------------------------------------------------
test("sqlStr and quoteIdent escape their delimiters", () => {
  assert.equal(sqlStr("a'b"), "'a''b'");
  assert.equal(quoteIdent('a"b'), '"a""b"');
  // A schema name crafted to break out of the identifier stays inert.
  assert.equal(quoteIdent('x" AS SELECT 1 FROM y --'), '"x"" AS SELECT 1 FROM y --"');
});

// -----------------------------------------------------------------------------
// Comment stripping (C3) — the silent-wrong-results one
// -----------------------------------------------------------------------------
test("stripComments removes real comments", () => {
  assert.equal(stripComments("SELECT 1 -- trailing"), "SELECT 1");
  assert.equal(stripComments("SELECT /* mid */ 1"), "SELECT   1");
  assert.equal(stripComments("SELECT 1;"), "SELECT 1");
  assert.equal(stripComments("-- only a comment\nSELECT 1"), "SELECT 1");
});

test("stripComments leaves comment-looking text inside a string literal alone", () => {
  // The silent one: this used to become  note = 'x  z'  and return different rows.
  const q = "SELECT * FROM t WHERE note = 'x /* y */ z'";
  assert.equal(stripComments(q), q);
  // This one used to break the literal and raise a parser error.
  const d = "SELECT * FROM t WHERE s = 'a--b'";
  assert.equal(stripComments(d), d);
});

test("prepareReadOnlySql accepts a semicolon inside a literal", () => {
  assert.equal(prepareReadOnlySql("SELECT 'a;b'"), "SELECT 'a;b'");
  assert.equal(prepareReadOnlySql("SELECT * FROM t WHERE url LIKE '%;%'"),
               "SELECT * FROM t WHERE url LIKE '%;%'");
});

test("prepareReadOnlySql still blocks a second statement", () => {
  assert.throws(() => prepareReadOnlySql("SELECT 1; DROP TABLE t"), /one statement at a time/);
  assert.throws(() => prepareReadOnlySql("SELECT 1 /* x */; DELETE FROM t"), /one statement at a time/);
  // A comment cannot hide the leading keyword check either.
  assert.throws(() => prepareReadOnlySql("/* SELECT */ DROP TABLE t"), /Read-only/);
  assert.throws(() => prepareReadOnlySql("-- SELECT\nATTACH 'x'"), /Read-only/);
});

test("prepareReadOnlySql allows a trailing semicolon and rejects write statements", () => {
  assert.equal(prepareReadOnlySql("SELECT 1;  "), "SELECT 1");
  assert.equal(prepareReadOnlySql("  WITH a AS (SELECT 1) SELECT * FROM a  "),
               "WITH a AS (SELECT 1) SELECT * FROM a");
  for (const bad of ["DROP TABLE t", "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1",
                     "CREATE TABLE t (a INT)", "COPY t TO 'x.csv'", "ATTACH 'db'"])
    assert.throws(() => prepareReadOnlySql(bad), /Read-only/, bad);
  for (const empty of ["", "   ", "-- nothing", "/* nothing */", ";"])
    assert.throws(() => prepareReadOnlySql(empty), /Empty query/, JSON.stringify(empty));
});

test("prepareReadOnlySql handles dollar-quoted strings", () => {
  assert.equal(prepareReadOnlySql("SELECT $$a;b$$"), "SELECT $$a;b$$");
  assert.equal(prepareReadOnlySql("SELECT $tag$a--b$tag$"), "SELECT $tag$a--b$tag$");
});

test("prepareReadOnlySql handles a doubled quote inside a literal", () => {
  assert.equal(prepareReadOnlySql("SELECT 'it''s; fine'"), "SELECT 'it''s; fine'");
});

// -----------------------------------------------------------------------------
// Metadata version selection (C4)
// -----------------------------------------------------------------------------
test("metadataVersion parses the writer naming conventions", () => {
  assert.equal(metadataVersion("v9.metadata.json"), 9);
  assert.equal(metadataVersion("v10.metadata.json"), 10);
  assert.equal(metadataVersion("321.metadata.json"), 321);
  assert.equal(metadataVersion("00001-8bf3227-b5d2.metadata.json"), 1);
  assert.equal(metadataVersion("ws/t/metadata/v7.metadata.json"), 7);
  assert.equal(metadataVersion("weird.metadata.json"), null);
});

test("pickMetadata prefers the highest version, not the newest mtime", () => {
  // Both written in the same second: lastModified ties, and lexicographic order put v9
  // last, so the older snapshot won.
  const entries = [
    { name: "t/metadata/v9.metadata.json", mtime: 1000 },
    { name: "t/metadata/v10.metadata.json", mtime: 1000 },
  ];
  assert.equal(pickMetadata(entries).name, "t/metadata/v10.metadata.json");
  // Order of the listing must not matter.
  assert.equal(pickMetadata(entries.slice().reverse()).name, "t/metadata/v10.metadata.json");
});

test("pickMetadata honours version-hint.text", () => {
  const entries = [
    { name: "t/metadata/v1.metadata.json", mtime: 1 },
    { name: "t/metadata/v2.metadata.json", mtime: 2 },
    { name: "t/metadata/v3.metadata.json", mtime: 3 },
  ];
  assert.equal(pickMetadata(entries, "2").name, "t/metadata/v2.metadata.json");
  assert.equal(pickMetadata(entries, " 2\n").name, "t/metadata/v2.metadata.json");
  // A hint pointing at a file that is not there falls back to the newest version.
  assert.equal(pickMetadata(entries, "99").name, "t/metadata/v3.metadata.json");
});

test("pickMetadata ignores non-metadata entries and reports an empty directory", () => {
  assert.equal(pickMetadata([{ name: "t/metadata/version-hint.text", mtime: 5 }]), null);
  assert.equal(pickMetadata([]), null);
  assert.equal(pickMetadata(undefined), null);
  const mixed = [
    { name: "t/metadata/snap-123.avro", mtime: 9 },
    { name: "t/metadata/v2.metadata.json", mtime: 1 },
  ];
  assert.equal(pickMetadata(mixed).name, "t/metadata/v2.metadata.json");
});

test("pickMetadata falls back to mtime when no name carries a version", () => {
  const entries = [
    { name: "t/metadata/aaa.metadata.json", mtime: 100 },
    { name: "t/metadata/bbb.metadata.json", mtime: 200 },
  ];
  assert.equal(pickMetadata(entries).name, "t/metadata/bbb.metadata.json");
});

// -----------------------------------------------------------------------------
// Cache keys (C1) — the wrong-data-under-the-right-name one
// -----------------------------------------------------------------------------
test("fileKey distinguishes same-named files in different folders", () => {
  const lh = { workspace: "ws", item: "lh.Lakehouse" };
  const a = fileKey(lh, { name: "data.parquet", path: "lh.Lakehouse/Files/a/data.parquet" });
  const b = fileKey(lh, { name: "data.parquet", path: "lh.Lakehouse/Files/b/data.parquet" });
  assert.notEqual(a, b);
});

test("tableKey distinguishes same-named tables in different lakehouses", () => {
  const t = { schema: "dbo", table: "sales" };
  const one = tableKey({ workspace: "wsA", item: "lh1.Lakehouse" }, t);
  const two = tableKey({ workspace: "wsB", item: "lh2.Lakehouse" }, t);
  assert.notEqual(one, two);
  // Same lakehouse and table is stable, so the cache still hits.
  assert.equal(one, tableKey({ workspace: "wsA", item: "lh1.Lakehouse" }, t));
});

test("tableKey separates a schema-qualified table from a flat one", () => {
  const lh = { workspace: "ws", item: "lh.Lakehouse" };
  assert.notEqual(tableKey(lh, { schema: "dbo", table: "sales" }),
                  tableKey(lh, { schema: null, table: "sales" }));
});

test("a table key and a file key never collide", () => {
  const lh = { workspace: "ws", item: "lh.Lakehouse" };
  assert.notEqual(tableKey(lh, { schema: null, table: "sales.csv" }),
                  fileKey(lh, { path: "lh.Lakehouse/Files/sales.csv" }));
});

test("sanitizeIdent is documented as lossy, so callers must dedupe", () => {
  assert.equal(sanitizeIdent("a/data.parquet"), "a_data_parquet");
  assert.equal(sanitizeIdent("a-data.parquet"), "a_data_parquet");
  assert.equal(sanitizeIdent("a.data.parquet"), "a_data_parquet");
});

// -----------------------------------------------------------------------------
// Values (C2)
// -----------------------------------------------------------------------------
test("normalizeValue keeps an int64 past 2^53 exact", () => {
  assert.equal(normalizeValue(1234567890123456789n), "1234567890123456789");
  assert.equal(normalizeValue(-1234567890123456789n), "-1234567890123456789");
  assert.equal(normalizeValue(9007199254740993n), "9007199254740993");
  // Number(9007199254740993n) would be …92; make sure we did not take that path.
  assert.notEqual(normalizeValue(9007199254740993n), 9007199254740992);
});

test("normalizeValue converts small bigints to numbers", () => {
  assert.equal(normalizeValue(42n), 42);
  assert.equal(typeof normalizeValue(42n), "number");
  assert.equal(normalizeValue(0n), 0);
  assert.equal(normalizeValue(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test("normalizeValue leaves other values alone", () => {
  assert.equal(normalizeValue(null), null);
  assert.equal(normalizeValue(undefined), undefined);
  assert.equal(normalizeValue("x"), "x");
  assert.equal(normalizeValue(1.5), 1.5);
  assert.deepEqual(normalizeValue({ toJSON: () => ({ a: 1 }) }), { a: 1 });
});

// -----------------------------------------------------------------------------
test("fmtBytes", () => {
  assert.equal(fmtBytes(0), "unknown size");
  assert.equal(fmtBytes(undefined), "unknown size");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2 KB");
  assert.equal(fmtBytes(5e6), "5.0 MB");
  assert.equal(fmtBytes(2.5e9), "2.50 GB");
});

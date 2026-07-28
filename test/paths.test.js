// Tests for site/paths.js — the pure helpers behind the engine.
//
// These cover the cases that used to return wrong data silently: cache keys that
// collided across folders and lakehouses, comment stripping that ate string literals,
// and URI escaping applied to an already-escaped path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DFS_HOST, DFS_ORIGIN, strip, basename, encPath, dfsBase, dfsUrl, toHttps, pathKey,
  parseLakehouse, itemKind, holdsTables, hasFilesArea, kindLabel,
  fileExt, readerFor, PARQUET_EXTS,
  TEXT_EXTS, isTextExt, DB_EXTS, ZIP_EXTS, IMAGE_EXTS, isSqliteHeader,
  sqlStr, quoteIdent, stripComments, prepareReadOnlySql,
  snapshotStats, icebergFields, icebergTypeName, sqlNeedsTable,
  tableKey, fileKey, sanitizeIdent,
  normalizeValue, fmtBytes, isDocResult, textLinesDoc, docKind, escapeHtml,
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

// -----------------------------------------------------------------------------
// Origin override — the VS Code extension points these at a loopback proxy that signs
// DuckDB's range reads, because a webview has no service worker to do it with.
// -----------------------------------------------------------------------------
// An override carries a path prefix, which is the case a bare host substitution would miss.
const PROXY = "http://127.0.0.1:54321/s3cr3t/dfs";

test("the default origin leaves every URL byte-identical", () => {
  // This is the regression net for the WEB app: passing the default explicitly must produce
  // exactly what passing nothing produces, or the origin parameter changed live behaviour.
  assert.equal(DFS_ORIGIN, `https://${DFS_HOST}`);
  const cases = [
    "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/my%20part/f.parquet",
    "abfss://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet",
    `https://${DFS_HOST}/WS/ITEM/Tables/t/f.parquet`,
    "https://example.test/a/b",
    "item/Tables/t",
  ];
  for (const c of cases) assert.equal(toHttps("my ws", c, DFS_ORIGIN), toHttps("my ws", c));
  assert.equal(dfsBase("my ws", DFS_ORIGIN), dfsBase("my ws"));
  assert.equal(dfsUrl("my ws", "a b.csv", DFS_ORIGIN), dfsUrl("my ws", "a b.csv"));
});

test("an override origin redirects dfsBase and dfsUrl, encoding unchanged", () => {
  assert.equal(dfsBase("my ws", PROXY), `${PROXY}/my%20ws`);
  assert.equal(dfsUrl("my ws", "item/Files/a b.csv", PROXY), `${PROXY}/my%20ws/item/Files/a%20b.csv`);
});

test("an override origin redirects all three toHttps input shapes", () => {
  // abfs:// — the authority becomes the first path segment, as with the default.
  assert.equal(
    toHttps("ignored", "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/f.parquet", PROXY),
    `${PROXY}/WS/ITEM/Tables/t/f.parquet`);
  // Relative.
  assert.equal(toHttps("my ws", "item/Tables/t", PROXY), `${PROXY}/my%20ws/item/Tables/t`);
  // Absolute OneLake — this is the one that would silently bypass the proxy and 401.
  assert.equal(
    toHttps("ignored", `https://${DFS_HOST}/WS/ITEM/Tables/t/f.parquet`, PROXY),
    `${PROXY}/WS/ITEM/Tables/t/f.parquet`);
});

test("an override origin does not touch a URL on another host", () => {
  // Only OneLake's own host is ours to redirect; a shortcut or a signed URL elsewhere is not.
  assert.equal(toHttps("ws", "https://example.test/a/b", PROXY), "https://example.test/a/b");
  // A look-alike host must not match either — the dots in DFS_HOST are escaped for this.
  const lookalike = "https://onelakexdfsxfabricxmicrosoftxcom/WS/f.parquet";
  assert.equal(toHttps("ws", lookalike, PROXY), lookalike);
});

test("an override origin preserves already-escaped Iceberg paths", () => {
  // Same %2520 regression as the default path, but through the redirect.
  const uri = "abfs://WS@onelake.dfs.fabric.microsoft.com/ITEM/Tables/t/my%20part/f.parquet";
  assert.equal(toHttps("ignored", uri, PROXY), `${PROXY}/WS/ITEM/Tables/t/my%20part/f.parquet`);
  assert.ok(!toHttps("ignored", uri, PROXY).includes("%2520"));
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
// Workspace items — what the picker offers, and which pane it offers with it
// -----------------------------------------------------------------------------
test("itemKind reads the kind off a OneLake item directory", () => {
  assert.equal(itemKind("sales.Lakehouse"), "Lakehouse");
  assert.equal(itemKind("ws/aemo.Warehouse"), "Warehouse");
  assert.equal(itemKind("my.data.MirroredDatabase"), "MirroredDatabase");   // dots in the name
  assert.equal(itemKind("Notebook one"), "");
  assert.equal(itemKind(""), "");
});

test("holdsTables is the items that write Delta into OneLake", () => {
  // The suffixes are OneLake's internal type names, taken from a real tenant's listing —
  // a Fabric SQL database is .SQLDbNative, not .SQLDatabase.
  assert.ok(holdsTables("sales.Lakehouse"));
  assert.ok(holdsTables("aemo.Warehouse"));
  assert.ok(holdsTables("mkdb.SQLDbNative"));
  assert.ok(holdsTables("snowflake_sales.MirroredDatabase"));   // unverified, see paths.js
  // A mirrored Databricks catalog is shortcuts to Databricks' own storage: no Delta in
  // OneLake, so nothing is served as Iceberg and there is nothing here to read.
  assert.ok(!holdsTables("dbrickscat11.DatabricksCatalog"));
  // ...and the rest of a workspace, by its real suffixes.
  assert.ok(!holdsTables("Notebook 1.SynapseNotebook"));
  assert.ok(!holdsTables("MKEnviron.Environment"));
  assert.ok(!holdsTables("Monitoring Eventhouse.KustoEventHouse"));
  assert.ok(!holdsTables("Dataflow 1.DataflowFabric"));
  assert.ok(!holdsTables("some folder"));
});

test("hasFilesArea is the lakehouse alone", () => {
  // Files/ is the unmanaged half of a lakehouse. Listing it on anything else returned
  // the item's internal storage directories.
  assert.ok(hasFilesArea("sales.Lakehouse"));
  assert.ok(hasFilesArea("sales.lakehouse"));       // OneLake's casing is not a promise
  assert.ok(!hasFilesArea("aemo.Warehouse"));
  assert.ok(!hasFilesArea("mkdb.SQLDbNative"));
  assert.ok(!hasFilesArea("snowflake_sales.MirroredDatabase"));
  assert.ok(!hasFilesArea(""));
});

test("kindLabel says what Fabric shows, not the internal type", () => {
  assert.equal(kindLabel("SQLDbNative"), "SQL database");
  assert.equal(kindLabel("MirroredDatabase"), "Mirrored database");
  assert.equal(kindLabel("Lakehouse"), "Lakehouse");
  assert.equal(kindLabel("Warehouse"), "Warehouse");
  // An item type nobody has taught it yet still names itself rather than going blank.
  assert.equal(kindLabel("MirroredSomethingNew"), "MirroredSomethingNew");
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

test("database files are recognised but not reader-based", () => {
  assert.equal(fileExt("analytics.duckdb"), "duckdb");
  assert.equal(fileExt("a/b/warehouse.ddb"), "ddb");
  // ATTACH sniffs the content, so the extension does not decide the engine: a DuckDB
  // database stored as .db and a real SQLite file both attach.
  for (const ext of ["duckdb", "ddb", "db", "sqlite", "sqlite3"]) {
    assert.ok(DB_EXTS.has(ext), `${ext} should be attachable`);
    assert.equal(readerFor(ext), null, `${ext} is attached, not read through a reader`);
  }
  assert.equal(isTextExt("duckdb"), false);
});

test("zip archives are recognised but not reader-based", () => {
  assert.equal(fileExt("data.zip"), "zip");
  assert.equal(fileExt("a/b/Archive.ZIP"), "zip");
  assert.ok(ZIP_EXTS.has("zip"));
  // Opened by listing entries (zipfs), never through a single reader function.
  assert.equal(readerFor("zip"), null);
  assert.equal(isTextExt("zip"), false);
  // A zipped csv is a codec DuckDB doesn't stream — .csv.zip is not .csv.gz.
  assert.equal(fileExt("a.csv.zip"), "zip");
  assert.equal(readerFor("csv.zip"), null);
});

test("image extensions carry a mime and never go through DuckDB", () => {
  for (const [ext, mime] of IMAGE_EXTS) {
    assert.ok(mime.startsWith("image/"), `${ext} carries an image mime`);
    assert.equal(readerFor(ext), null, `${ext} has no DuckDB reader`);
    assert.equal(isTextExt(ext), false, `${ext} is not text`);
  }
  assert.equal(IMAGE_EXTS.get("jpg"), "image/jpeg");
  assert.ok(IMAGE_EXTS.has(fileExt("charts/Q3.PNG")));   // fileExt lowercases
  assert.ok(!IMAGE_EXTS.has(fileExt("a.png.gz")));       // no codec story for pixels
});

// The delimiter has to be a BYTE. Measured in the pinned DuckDB-WASM: delim='\x1F' is the
// four characters backslash-x-1-F (the CSV reader unescapes \t, \n and \r, but not \xNN),
// so reading any file that mentions that escape sequence as text — a regex, a separator
// constant — failed outright with "CSV Error on Line: N".
test("the text reader splits on a real byte and trims exactly one CR", () => {
  const sql = readerFor("sql")("'f.sql'");
  assert.ok(sql.includes("delim=chr(31)"), sql);
  assert.ok(!sql.includes("\\x1F"), "a literal \\x1F delimiter splits on text, not on a byte");
  // Exactly one trailing CR (the CRLF's), never a CR the line's own content ends with.
  assert.ok(sql.includes("ends_with(line, chr(13))"), sql);
  assert.ok(!sql.includes("rtrim("), sql);
  // .txt is a document, not a headerless CSV.
  assert.ok(readerFor("txt")("'f.txt'").includes("delim=chr(31)"));
  // ...but '\t' IS one of the escapes the CSV reader expands, so the tsv reader is right
  // as written. Verified, not assumed — it errors on real tabs, so it sees real tabs.
  assert.ok(readerFor("tsv")("'f.tsv'").includes("delim='\\t'"));
});

test("isSqliteHeader sniffs the engine from bytes, not the extension", () => {
  const enc = s => new Uint8Array([...s].map(c => c.charCodeAt(0)));
  assert.equal(isSqliteHeader(enc("SQLite format 3 ...page data...")), true);
  // DuckDB main files carry a DUCK magic at offset 8, not the SQLite banner.
  assert.equal(isSqliteHeader(enc("        DUCK   ")), false);
  assert.equal(isSqliteHeader(enc("SQLite forma")), false);   // truncated header
  assert.equal(isSqliteHeader(new Uint8Array(0)), false);
  assert.equal(isSqliteHeader(null), false);
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
// Binding a table registers every data file and reads their footers — metered egress.
// A false positive here spends the user's money; a false negative costs one click.
test("sqlNeedsTable only fires when the SQL really names the table", () => {
  assert.equal(sqlNeedsTable('SELECT * FROM "landing"."fct_price" LIMIT 100', "fct_price"), true);
  assert.equal(sqlNeedsTable("select count(*) from landing.fct_price", "fct_price"), true);
  assert.equal(sqlNeedsTable("SELECT 42", "fct_price"), false);
  assert.equal(sqlNeedsTable("SELECT * FROM read_parquet('x.parquet')", "fct_price"), false);
  // The near-miss that would otherwise open the wrong (and much bigger) table.
  assert.equal(sqlNeedsTable('SELECT * FROM "landing"."fct_price_today"', "fct_price"), false);
  assert.equal(sqlNeedsTable('SELECT * FROM "landing"."fct_price"', "fct_price_today"), false);
  // A name that appears only in a comment is not a reference.
  assert.equal(sqlNeedsTable("-- fct_price is big\nSELECT 1", "fct_price"), false);
  assert.equal(sqlNeedsTable("", "fct_price"), false);
  assert.equal(sqlNeedsTable("SELECT * FROM t", null), false);
});

// -----------------------------------------------------------------------------
test("icebergFields: the schema without touching a parquet footer", () => {
  const schema = { fields: [
    { id: 1, name: "DUID", required: true, type: "string" },
    { id: 2, name: "RRP", required: false, type: "decimal(18,8)" },
    { id: 3, name: "tags", type: { type: "list", element: "string" } },
    { id: 4, name: "props", type: { type: "map", key: "string", value: "long" } },
    { id: 5, name: "src", type: { type: "struct",
      fields: [{ name: "file" }, { name: "line" }] } },
  ] };
  assert.deepEqual(icebergFields(schema), [
    { name: "DUID", type: "string" },
    { name: "RRP", type: "decimal(18,8)" },
    { name: "tags", type: "list<string>" },
    { name: "props", type: "map<string, long>" },
    { name: "src", type: "struct<file, line>" },
  ]);
  assert.deepEqual(icebergFields(null), []);
  assert.deepEqual(icebergFields({}), []);
  assert.equal(icebergTypeName(undefined), "");
});

// -----------------------------------------------------------------------------
test("snapshotStats reads the summary and metadata fields", () => {
  const meta = {
    "format-version": 2,
    "default-spec-id": 1,
    "partition-specs": [
      { "spec-id": 0, fields: [] },
      { "spec-id": 1, fields: [{ name: "day", transform: "day" },
                               { name: "region", transform: "identity" }] },
    ],
    properties: { "delta.parquet.vorder.enabled": "TRUE ",
                  "write.parquet.compression-codec": "zstd" },
    snapshots: [{}, {}, {}],
  };
  const snap = {
    "timestamp-ms": 1753600000000,
    summary: { operation: "append", "total-records": "1000", "total-files-size": "52428800",
               "total-data-files": "19", "total-delete-files": "2" },
  };
  assert.deepEqual(snapshotStats(meta, snap), {
    codec: "zstd",
    totalFilesSize: 52428800, totalDataFiles: 19, totalDeleteFiles: 2,
    operation: "append", snapshotTs: 1753600000000, snapshotCount: 3, formatVersion: 2,
    partitionColumns: ["day (day)", "region"], vorderProp: true,
  });
});

test("snapshotStats: missing summary fields become nulls, never guesses", () => {
  const s = snapshotStats({}, {});
  assert.deepEqual(s, {
    codec: null,
    totalFilesSize: null, totalDataFiles: null, totalDeleteFiles: null, operation: null,
    snapshotTs: null, snapshotCount: 0, formatVersion: null,
    partitionColumns: [], vorderProp: null,
  });
  assert.deepEqual(snapshotStats(undefined, undefined), s);
});

test("snapshotStats: V-Order property false vs absent are different answers", () => {
  const at = p => snapshotStats({ properties: p }, {}).vorderProp;
  assert.equal(at({ "delta.parquet.vorder.enabled": "false" }), false);
  assert.equal(at({ "delta.parquet.vorder.enabled": "garbage" }), false);
  assert.equal(at({}), null);   // absent = unknown, the UI must not render a verdict
});

test("snapshotStats: spec-id 0 is a real spec-id, not a missing one", () => {
  const meta = {
    "default-spec-id": 0,
    "partition-specs": [
      { "spec-id": 0, fields: [{ name: "yr", transform: "identity" }] },
      { "spec-id": 1, fields: [{ name: "other", transform: "identity" }] },
    ],
  };
  assert.deepEqual(snapshotStats(meta, {}).partitionColumns, ["yr"]);
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
// isDocResult — the gate on the Pretty markdown view. Anything false here keeps
// the grid path byte-identical, so the false cases matter as much as the true.
// -----------------------------------------------------------------------------
test("isDocResult accepts a 1×1 multiline VARCHAR", () => {
  const readme = "# OneLake Studio\n\nRead-only SQL over your own OneLake.";
  assert.equal(isDocResult(
    { fields: ["content"], types: ["VARCHAR"], rows: [{ content: readme }] }), true);
  assert.equal(isDocResult(
    { fields: ["c"], types: ["VARCHAR"], rows: [{ c: "a\nb" }] }), true);
});

test("isDocResult rejects everything that is not that shape", () => {
  // SELECT 42 — wrong type.
  assert.equal(isDocResult(
    { fields: ["v"], types: ["INTEGER"], rows: [{ v: 42 }] }), false);
  // Single line — no document signal.
  assert.equal(isDocResult(
    { fields: ["c"], types: ["VARCHAR"], rows: [{ c: "hello" }] }), false);
  // Two columns.
  assert.equal(isDocResult(
    { fields: ["a", "b"], types: ["VARCHAR", "VARCHAR"],
      rows: [{ a: "x\ny", b: "x\ny" }] }), false);
  // Two rows.
  assert.equal(isDocResult(
    { fields: ["c"], types: ["VARCHAR"], rows: [{ c: "a\nb" }, { c: "c\nd" }] }), false);
  // Null value.
  assert.equal(isDocResult(
    { fields: ["c"], types: ["VARCHAR"], rows: [{ c: null }] }), false);
  // Empty result / missing pieces.
  assert.equal(isDocResult({ fields: [], types: [], rows: [] }), false);
  assert.equal(isDocResult({ fields: ["c"], rows: [{ c: "a\nb" }] }), false);
  assert.equal(isDocResult(null), false);
});

// -----------------------------------------------------------------------------
// textLinesDoc — the other shape a document arrives in. The Files tab reads plain text
// one row per line, so a whole file is N rows of `line`, which isDocResult cannot match.
// -----------------------------------------------------------------------------
test("textLinesDoc rejoins the line grid the Files tab produces", () => {
  const lines = rows => ({ fields: ["line"], types: ["VARCHAR"], rows: rows.map(line => ({ line })) });
  assert.equal(textLinesDoc(lines(["def model(dbt, session):", "    return None", ""])),
               "def model(dbt, session):\n    return None\n");
  assert.equal(textLinesDoc(lines(["one line"])), "one line");
  // A blank line read back as NULL is a blank line, not the text "null".
  assert.equal(textLinesDoc(lines([null, "b"])), "\nb");
  // Half a file rendered as the file is worse than no Pretty tab at all.
  assert.equal(textLinesDoc({ ...lines(["a"]), truncated: true }), null);
  // Anything that is not that exact shape.
  assert.equal(textLinesDoc({ fields: ["x"], types: ["VARCHAR"], rows: [{ x: "a" }] }), null);
  assert.equal(textLinesDoc({ fields: ["line"], types: ["INTEGER"], rows: [{ line: 1 }] }), null);
  assert.equal(textLinesDoc(lines([])), null);
  assert.equal(textLinesDoc(null), null);
});

// -----------------------------------------------------------------------------
// docKind — which renderer the Pretty view uses. Running everything through the
// markdown parser is what turned a dbt macro and a JSON blob into unreadable soup.
// -----------------------------------------------------------------------------
test("docKind: JSON documents are JSON", () => {
  assert.equal(docKind('{\n  "a": 1,\n  "b": [2, 3]\n}'), "json");
  assert.equal(docKind('  [ {"a": 1},\n {"b": 2} ]  '), "json");
  // Valid JSON, but nobody means a bare scalar as a document.
  assert.equal(docKind("12"), "text");
  assert.equal(docKind('"just a string"'), "text");
  // Looks like JSON, isn't — must not be handed to JSON.parse downstream.
  assert.equal(docKind('{ "a": 1,\n  oops }'), "text");
});

test("docKind: code and logs stay text", () => {
  // A dbt macro: braces, quotes, a `#` that is not a heading because it is mid-line.
  assert.equal(docKind("{% macro f(a) %}\n  select 1 # not a heading\n{% endmacro %}"), "text");
  assert.equal(docKind("2026-07-27 10:00:00 INFO started\n2026-07-27 10:00:01 INFO done\n"), "text");
  assert.equal(docKind("SELECT *\nFROM t\nWHERE a = 'b'\n"), "text");
});

// The case sniffing cannot win: a YAML sequence and a markdown bullet list are the same
// characters. Only the file the text came from can settle it.
test("docKind: a known extension beats the markers", () => {
  const yaml = "version: 2\nmodels:\n  - name: fct_price\n";
  assert.equal(docKind(yaml, "yml"), "text");
  assert.equal(docKind(yaml, ".YAML"), "text");
  assert.equal(docKind(yaml), "markdown");          // no source file: the markers are all there is
  // A .sql full of markdown-looking punctuation is still SQL.
  assert.equal(docKind("-- notes\n- a\n- b\nselect 1\n", "sql"), "text");
  // ...and a markdown file is markdown even when it holds no markers at all.
  assert.equal(docKind("just one plain line\nand another\n", "md"), "markdown");
  // A codec suffix is not the extension.
  assert.equal(docKind("# Title\n\nprose\n", "md.gz"), "markdown");
  assert.equal(docKind("plain\nlines\n", "log.zst"), "text");
  // JSON still wins: it parsed, so there is nothing to guess about.
  assert.equal(docKind('{"a": 1}', "log"), "json");
});

test("docKind: markdown markers win over plain text", () => {
  assert.equal(docKind("# Title\n\nsome prose\n"), "markdown");
  assert.equal(docKind("intro\n\n```sql\nselect 1\n```\n"), "markdown");
  assert.equal(docKind("things:\n\n- one\n- two\n"), "markdown");
  assert.equal(docKind("see [the docs](https://example.com) for more\n"), "markdown");
  assert.equal(docKind("| a | b |\n| - | - |\n| 1 | 2 |\n"), "markdown");
  assert.equal(docKind("this is **bold** text\n"), "markdown");
  // A YAML list is not a markdown list: the marker has to start the line.
  assert.equal(docKind("key: value\nother: 1\n"), "text");
});

// -----------------------------------------------------------------------------
test("escapeHtml", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml(42), "42");
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

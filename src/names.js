'use strict';
// =============================================================================
// names.js — what OneLake's names and metadata mean, for the extension host
// =============================================================================
// Which workspace items hold tables and what to call them, a table's columns and
// statistics out of its Iceberg metadata, and the path basics those need. The host owns
// all of it: the tree draws from it, the store keeps what it computes, and the panel only
// ever receives the answers.
// =============================================================================

const strip = s => String(s).replace(/^\/+|\/+$/g, "");
const basename = p => strip(p).split("/").pop();
// Text read as UTF-8 without the byte-order mark some editors write first (a .bim saved by
// Visual Studio has one), which JSON.parse refuses.
const stripBom = s => String(s).replace(/^\uFEFF/, "");

// Percent-encode a RAW path — one whose segments are literal names, not URI escapes.
// This is only correct for paths that came out of a DFS listing (`.name`), where a
// space is a space. Applying it to a path taken from Iceberg metadata would turn an
// existing %20 into %2520; see toHttps for that side.
const encPath = p => strip(p).split("/").map(encodeURIComponent).join("/");

// OneLake's DFS endpoint, and a file on it by the names the tree knows it by (the workspace,
// and the path from its item, "nem.Lakehouse/Files/x.parquet"): its https URL, which the host
// fetches, and its abfss:// URL, which DuckDB reads.
const DFS_HOST = "onelake.dfs.fabric.microsoft.com";
const DFS_ORIGIN = `https://${DFS_HOST}`;
const dfsFileUrl = (workspace, path, origin = DFS_ORIGIN) => `${origin}/${encodeURIComponent(workspace)}/${encPath(path)}`;
const abfssUrl = (workspace, path) => `abfss://${workspace}@${DFS_HOST}/${path}`;


// -----------------------------------------------------------------------------
// Workspace items — which ones hold OneLake tables, and what to call them
// -----------------------------------------------------------------------------
// A workspace root is mostly notebooks, pipelines, reports and environments. The ones
// worth listing are the items whose directory has a Tables/ under it, and a OneLake
// directory names its own kind: "sales.Lakehouse", "aemo.Warehouse".
const itemKind = name => {
  const m = /\.([^.]+)$/.exec(basename(name || ""));
  return m ? m[1] : "";
};

// These names came from listing 49 real workspaces over the DFS API, not from the portal
// or the Fabric REST API — OneLake names an item directory after Fabric's INTERNAL type,
// and the three disagree constantly. Guessing the REST spelling is why a workspace full
// of Databricks catalogs came up empty:
//
//   portal "SQL database"                       ->  <name>.SQLDbNative
//   portal "Mirrored Azure Databricks catalog"  ->  <name>.DatabricksCatalog
//   portal "KQL database" / "Eventhouse"        ->  .KustoDatabase / .KustoEventHouse
//   portal "Notebook"                           ->  <name>.SynapseNotebook
//
// What belongs here is narrower than "has a Tables/": it is the items that write Delta
// INTO OneLake, which is what OneLake then serves as Iceberg. Confirmed by finding
// _delta_log and metadata/ side by side under a table of each:
//
//   Lakehouse, Warehouse, SQLDbNative   -> Tables/<schema>/<t>/{_delta_log, metadata}
//   DatabricksCatalog                   -> Tables/<schema>/<t> is a SHORTCUT: no files in
//                                          OneLake, so nothing to convert. Listing through
//                                          it is refused outright ("Stored connections with
//                                          authentication type 'Key' are not supported for
//                                          shortcuts of type 'DatabricksCatalog'"), and the
//                                          Iceberg catalog names the tables but 400s on
//                                          every one. There is nothing here to read.
//   KustoDatabase                       -> Tables/ existed but was empty on every KQL
//                                          database probed; nothing to confirm.
//   MountedRelationalDatabase           -> a MIRRORED database (Azure SQL, Snowflake, Cosmos,
//                                          open mirroring…). None in those 49 workspaces:
//                                          the suffix is Fabric's internal type for the
//                                          item, the one its own definition names as the
//                                          mirroring target (mirroring.json, `"type":
//                                          "MountedRelationalDatabase"`) and the one
//                                          Microsoft's semantic-link-labs lists beside
//                                          SQLDbNative and DatabricksCatalog. Until it was
//                                          here, the /^Mirrored/ guess below was the only
//                                          rule, and a user's mirrored database was missing.
const TABLE_ITEM_KINDS = new Set(["Lakehouse", "Warehouse", "SQLDbNative", "MountedRelationalDatabase"]);

// The REST spelling, kept in case OneLake ever names a directory after it: harmless when
// it never matches.
const holdsTables = name => {
  const kind = itemKind(name);
  return TABLE_ITEM_KINDS.has(kind) || /^Mirrored/i.test(kind);
};

// A mirrored item is a copy kept in step with a database outside Fabric; the tree says so.
const isMirrored = name => /^(MountedRelationalDatabase|Mirrored)/i.test(itemKind(name));

// Files/ is the unmanaged half of a LAKEHOUSE. Everything else here stores its tables
// in OneLake and nothing else, so browsing Files/ on one listed the item's internal
// storage directories — GUIDs nobody asked to see.
const hasFilesArea = name => /^lakehouse$/i.test(itemKind(name));

// The kind as the picker should say it: what the person sees in Fabric, not the internal
// type. Anything unlisted names itself, which is still better than being invisible.
const KIND_LABELS = {
  sqldbnative: "SQL database",
  mountedrelationaldatabase: "Mirrored database",
  mirroreddatabase: "Mirrored database",
};
const kindLabel = kind => {
  const k = String(kind || "");
  return KIND_LABELS[k.toLowerCase()] || k;
};
// ...and as a heading over several of them: "Lakehouses", "SQL databases".
const kindLabelPlural = kind => {
  const l = kindLabel(kind) || "Other";
  return /s$/i.test(l) ? l : `${l}s`;
};

// -----------------------------------------------------------------------------
// A table's SQL name: kind.workspace.item.schema.table
// -----------------------------------------------------------------------------
// One name per table, everywhere SQL is written (the panel, Explore, the command line, a
// saved query), and unique by construction: it is the table's OneLake path
// (<workspace>/<item>.<Kind>/Tables/<schema>/<table>) with the kind moved to the front, where
// it names one of DuckDB's catalogs. The rest are nested schemas (engine-host.js), so
//
//   SELECT * FROM lakehouse.aemo.data.dbo.dim_duid
//
// reads the same table whatever the panel has open. A lakehouse without schemas is `dbo`,
// the one schema OneLake's catalog reports for it. The kind is the Fabric spelling, not the
// internal one a OneLake directory carries.
const SQL_KINDS = ["lakehouse", "warehouse", "sqldatabase", "mirroreddatabase"];
const SQL_KIND_OF = {
  lakehouse: "lakehouse", warehouse: "warehouse",
  sqldbnative: "sqldatabase", sqldatabase: "sqldatabase",
  mountedrelationaldatabase: "mirroreddatabase",
};
// The catalog an item's tables are under: from its directory's kind ("SQLDbNative"), or the
// kind itself when that is already the SQL one. null for an item that holds no tables.
const sqlKind = kind => {
  const k = String(kind || "");
  return SQL_KIND_OF[k.toLowerCase()] || (/^Mirrored/i.test(k) ? "mirroreddatabase" : null);
};
// An item's name as Fabric shows it: its directory's name without the kind.
const displayName = item => basename(item).replace(/\.[^.]+$/, "");

// What a dataflow makes for its own staging, judged by the name Fabric gives it: an item or a
// model with nothing in it to analyse.
const isStaging = name => /^(DataflowsStaging|Staging(Lakehouse|Warehouse)ForDataflows_)/i.test(String(name));

// DuckDB's reserved words (duckdb_keywords(), 'reserved' and 'type_function'): a part
// spelled like one must be quoted to be a name. The panel's twin is app/paths.js sqlPart;
// a test holds them equal.
const RESERVED = new Set(("all analyse analyze and anti any array as asc asof asymmetric at authorization binary " +
  "both by case cast check collate collation column columns concurrently constraint create cross default " +
  "deferrable desc describe distinct do else end except false fetch for foreign freeze from full generated " +
  "glob group having ilike in initially inner intersect into is isnull join lambda lateral leading left like " +
  "limit map natural not notnull null offset on only or order outer overlaps pivot pivot_longer pivot_wider " +
  "placing positional primary qualify references returning right select semi show similar some struct " +
  "summarize symmetric table tablesample then to trailing true try_cast tuple union unique unpack unpivot " +
  "using variadic verbose when where window with").split(" "));
// A part as SQL writes it: bare when it can be, quoted when it must.
const sqlPart = s => {
  const v = String(s);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !RESERVED.has(v.toLowerCase()) ? v : `"${v.replace(/"/g, '""')}"`;
};
// { kind, workspace, item (as Fabric shows it), schema, table } -> its SQL name.
const sqlName = r =>
  [r.kind, r.workspace, r.item, r.schema || "dbo", r.table].map(sqlPart).join(".");
// A semantic model's SQL name: semanticmodel.<workspace>.<model>, in a catalog of its own as a
// lakehouse's tables are in theirs (app/semantic.js names its views the same way).
const MODEL_CATALOG = "semanticmodel";
const modelSqlName = (workspace, model) => [MODEL_CATALOG, workspace, model].map(sqlPart).join(".");
// The same, for a table the tree knows by its item's directory name ("data.Lakehouse").
function sqlNameOf(lh, t) {
  const kind = sqlKind(itemKind(lh.item));
  if (!kind) throw new Error(`${lh.item} holds no tables SQL can name`);
  return sqlName({ kind, workspace: lh.workspace, item: displayName(lh.item), schema: t.schema, table: t.table });
}

function icebergTypeName(t) {
  if (t == null) return "";
  if (typeof t === "string") return t;
  const kind = t.type || "";
  if (kind === "list") return `list<${icebergTypeName(t.element)}>`;
  if (kind === "map") return `map<${icebergTypeName(t.key)}, ${icebergTypeName(t.value)}>`;
  if (kind === "struct") return `struct<${(t.fields || []).map(f => f.name).join(", ")}>`;
  return kind;
}


const icebergFields = schema =>
  ((schema || {}).fields || []).map(f => ({ name: f.name, type: icebergTypeName(f.type) }));

// Table-level statistics out of an Iceberg metadata document and its current snapshot —
// the fields the Fabric conversion fills from the source table's own statistics. Only
// the snapshot summary is trustworthy here: Fabric writes zeroed PER-FILE manifest
// statistics (measured — see readManifest's caller), so nothing below reads manifests.
function snapshotStats(meta, snap) {
  meta = meta || {}; snap = snap || {};
  const summary = snap.summary || {};
  const num = v => Number(v) || null;

  // Partition fields of the CURRENT spec. `default-spec-id` can legitimately be 0, so
  // only fall back to the first spec when the id is absent or unmatched.
  const specs = meta["partition-specs"] || [];
  const spec = specs.find(s => s["spec-id"] === meta["default-spec-id"]) || specs[0];
  const partitionColumns = ((spec || {}).fields || []).map(f =>
    f.transform && f.transform !== "identity" ? `${f.name} (${f.transform})` : f.name);

  // Probed 2026-07-28 on a real Lakehouse (DFS) and Warehouse (IRC): Fabric's conversion
  // (Apache XTable) does NOT mirror `delta.parquet.vorder.enabled` into the Iceberg
  // properties — so this stays null in practice and the UI must render nothing, not "no".
  // It is read anyway because it is free and lights up if the conversion ever starts
  // writing it. The compression codec, by contrast, IS there on both probed items.
  const props = meta.properties || {};
  const vorderRaw = props["delta.parquet.vorder.enabled"];
  const vorderProp = vorderRaw == null ? null
    : String(vorderRaw).trim().toLowerCase() === "true";

  return {
    codec: props["write.parquet.compression-codec"] || null,
    totalFilesSize: num(summary["total-files-size"]),
    totalDataFiles: num(summary["total-data-files"]),
    totalDeleteFiles: num(summary["total-delete-files"]),
    operation: summary.operation || null,
    snapshotTs: num(snap["timestamp-ms"]),
    snapshotCount: (meta.snapshots || []).length,
    formatVersion: meta["format-version"] != null ? Number(meta["format-version"]) : null,
    partitionColumns,
    vorderProp,
  };
}

// Which format the table is WRITTEN in. OneLake keeps both sets of metadata side by side
// and the engine always reads the Iceberg one, but only one of them is the original: the
// other is Fabric's conversion (Apache XTable), and the conversion signs its output.
// Probed 2026-10-29 on a lakehouse holding both kinds:
//
//   written as Delta    -> Iceberg properties carry XTABLE_METADATA, sourceTableFormat DELTA
//                          and sourceIdentifier = the Delta version it was converted from
//   written as Iceberg  -> no XTABLE_METADATA in the Iceberg metadata (it is the original);
//                          the _delta_log beside it is the converted one, and ITS commit
//                          carries the XTABLE_METADATA, sourceTableFormat ICEBERG
//
// So a table whose Iceberg metadata was not converted from Delta is an Iceberg table.
function sourceFormat(meta) {
  const raw = ((meta || {}).properties || {}).XTABLE_METADATA;
  if (raw == null) return { format: "iceberg", deltaVersion: null };
  let x = {};
  try { x = JSON.parse(raw) || {}; } catch (_) { /* unreadable: still converted by XTable */ }
  const from = String(x.sourceTableFormat || "DELTA").toUpperCase();
  if (from !== "DELTA") return { format: from.toLowerCase(), deltaVersion: null };
  const v = Number(x.sourceIdentifier);
  return { format: "delta", deltaVersion: Number.isFinite(v) ? v : null };
}

// An Iceberg table's history: its snapshots, newest first. Only for a table written as
// Iceberg — a converted one's snapshots are the conversion's, not the writer's. Each says how
// its columns differ from the table's now (`columns`: { added, removed } by name, null when
// they are the same), for the History tab's comparison with the current version.
const HISTORY_MAX = 100;
function icebergHistory(meta) {
  const num = v => (v == null || v === "" ? null : Number(v));
  const names = id => {
    const s = ((meta || {}).schemas || []).find(x => x["schema-id"] === id);
    return s ? (s.fields || []).map(f => f.name) : null;
  };
  const now = names((meta || {})["current-schema-id"]);
  const columns = id => {
    const then = names(id);
    if (!now || !then || id === meta["current-schema-id"]) return null;
    const added = now.filter(c => !then.includes(c)), removed = then.filter(c => !now.includes(c));
    return added.length || removed.length ? { added, removed } : null;
  };
  return [...((meta || {}).snapshots || [])]
    .sort((a, b) => (b["sequence-number"] ?? b["timestamp-ms"]) - (a["sequence-number"] ?? a["timestamp-ms"]))
    .slice(0, HISTORY_MAX)
    .map(s => {
      const m = s.summary || {};
      return {
        version: String(s["snapshot-id"]),
        timestamp: num(s["timestamp-ms"]),
        operation: m.operation || null,
        rowsAdded: num(m["added-records"]),
        rowsRemoved: num(m["deleted-records"]),
        filesAdded: num(m["added-data-files"]),
        filesRemoved: num(m["deleted-data-files"]),
        bytesAdded: num(m["added-files-size"]),
        totalRows: num(m["total-records"]),
        engine: m["engine-name"] ? `${m["engine-name"]} ${m["engine-version"] || ""}`.trim()
              : m["iceberg-version"] || null,
        columns: columns(s["schema-id"]),
      };
    });
}

function fmtBytes(n) {
  if (!(n > 0)) return "unknown size";
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

module.exports = {
  strip, basename, stripBom, encPath, DFS_HOST, DFS_ORIGIN, dfsFileUrl, abfssUrl,
  itemKind, holdsTables, isMirrored, hasFilesArea, kindLabel, kindLabelPlural,
  SQL_KINDS, sqlKind, displayName, isStaging, RESERVED, sqlPart, sqlName, sqlNameOf, MODEL_CATALOG, modelSqlName,
  icebergTypeName, icebergFields, snapshotStats, sourceFormat, icebergHistory,
  fmtBytes,
};

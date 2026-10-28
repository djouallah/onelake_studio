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

// Percent-encode a RAW path — one whose segments are literal names, not URI escapes.
// This is only correct for paths that came out of a DFS listing (`.name`), where a
// space is a space. Applying it to a path taken from Iceberg metadata would turn an
// existing %20 into %2520; see toHttps for that side.
const encPath = p => strip(p).split("/").map(encodeURIComponent).join("/");


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
// Iceberg — a converted one's snapshots are the conversion's, not the writer's.
const HISTORY_MAX = 100;
function icebergHistory(meta) {
  const num = v => (v == null || v === "" ? null : Number(v));
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
  strip, basename, encPath,
  itemKind, holdsTables, isMirrored, hasFilesArea, kindLabel, kindLabelPlural,
  icebergTypeName, icebergFields, snapshotStats, sourceFormat, icebergHistory,
  fmtBytes,
};

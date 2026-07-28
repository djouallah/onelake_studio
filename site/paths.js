// =============================================================================
// paths.js — the pure half of the engine: paths, URIs, SQL text, cache keys.
// =============================================================================
// Everything here is a plain function over strings and plain objects: no DOM, no
// network, no DuckDB. That is the point — this is where the bugs that silently
// return the WRONG DATA live (cache keys that collide, comment stripping that eats
// string literals, URI escaping applied twice), and none of them are reachable by
// clicking around. Keeping them here means test/paths.test.js can cover them under
// `node --test` with no browser and no lakehouse.
//
// Plain ESM with no imports, so the same file loads in the browser and in Node.
// =============================================================================

export const DFS_HOST = "onelake.dfs.fabric.microsoft.com";

// -----------------------------------------------------------------------------
// Path basics
// -----------------------------------------------------------------------------
export const strip = s => String(s).replace(/^\/+|\/+$/g, "");
export const basename = p => strip(p).split("/").pop();

// Percent-encode a RAW path — one whose segments are literal names, not URI escapes.
// This is only correct for paths that came out of a DFS listing (`.name`), where a
// space is a space. Applying it to a path taken from Iceberg metadata would turn an
// existing %20 into %2520; see toHttps for that side.
export const encPath = p => strip(p).split("/").map(encodeURIComponent).join("/");

export const dfsBase = (ws, host = DFS_HOST) => `https://${host}/${encodeURIComponent(ws)}`;

// A DFS "list" entry .name is already relative to the filesystem (workspace) root,
// and is raw, so it gets encoded.
export const dfsUrl = (ws, name, host = DFS_HOST) => `${dfsBase(ws, host)}/${encPath(name)}`;

// Normalize a path out of Iceberg metadata to an authed https URL.
//
// Fabric writes `abfs://<workspace-guid>@onelake.dfs.fabric.microsoft.com/<item-guid>/Tables/…`
// — note the single s, and GUIDs rather than the friendly names the user typed. The
// filesystem component becomes the first path segment.
//
// The input is a URI, so its path is ALREADY percent-encoded and is carried across
// untouched. Re-encoding it here is what produced %2520 for any table whose partition
// values or file names contain a space or a literal %.
export function toHttps(ws, u, host = DFS_HOST) {
  const s = String(u);
  const ab = /^abfss?:\/\/([^@/]+)@[^/]+\/(.*)$/i.exec(s);
  if (ab) return `https://${host}/${ab[1]}/${strip(ab[2])}`;
  if (/^https?:\/\//i.test(s)) return s;
  // A relative reference, still a URI reference — only the workspace we prepend is raw.
  return `${dfsBase(ws, host)}/${strip(s)}`;
}

// Reduce any of the forms a data-file path can take to one comparable key:
// the workspace-relative path, with an abfs authority folded in as the first segment.
//
//   abfs://WS@host/item/Tables/t/f.parquet  -> WS/item/Tables/t/f.parquet
//   abfss://WS@host/item/Tables/t/f.parquet -> WS/item/Tables/t/f.parquet
//   https://host/WS/item/Tables/t/f.parquet -> WS/item/Tables/t/f.parquet
//
// Iceberg does not promise that a delete file's `file_path` is byte-identical to the
// manifest's `data_file.file_path` — the abfs/abfss spelling alone differs between
// Fabric writers. An exact-string anti-join that silently matches nothing means deleted
// rows come back as live, so both sides go through this first.
export function pathKey(u) {
  const s = String(u);
  const ab = /^abfss?:\/\/([^@/]+)@[^/]+\/(.*)$/i.exec(s);
  if (ab) return `${ab[1]}/${strip(ab[2])}`;
  const https = /^https?:\/\/[^/]+\/(.*)$/i.exec(s);
  if (https) return strip(https[1]);
  return strip(s);
}

// The same reduction as pathKey(), as a DuckDB expression, so the delete table can be
// normalized in SQL. Kept next to pathKey so the two cannot drift apart unnoticed.
export const PATH_KEY_SQL = col =>
  `CASE WHEN regexp_matches(${col}, '^abfss?://[^@/]+@')
        THEN regexp_replace(${col}, '^abfss?://([^@/]+)@[^/]+/', '\\1/')
        ELSE regexp_replace(${col}, '^https?://[^/]+/', '')
   END`;

// "workspace/lakehouse.Lakehouse" (or a full https/abfss URL) -> { workspace, item }.
//
// In an abfs(s) URL the workspace is the AUTHORITY, not the first path segment
// (abfss://ws@host/lh.Lakehouse) — dropping it along with the scheme, as an earlier
// version did, left one segment and a "path must be workspace/lakehouse" error for a
// URL that named both.
export function parseLakehouse(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Enter a lakehouse path, e.g.  myworkspace/mylakehouse.Lakehouse");

  let workspace = null, rest = raw, fromUri = false;
  const ab = /^abfss?:\/\/([^@/]+)@[^/]+\/?(.*)$/i.exec(raw);
  if (ab) {
    workspace = ab[1];
    rest = ab[2];
    fromUri = true;
  } else {
    const https = /^https?:\/\/[^/]+\/?(.*)$/i.exec(raw);
    if (https) { rest = https[1]; fromUri = true; }
  }

  // Segments of a URL are escaped; segments the user typed are literal.
  const unesc = v => {
    if (!fromUri) return v;
    try { return decodeURIComponent(v); } catch (_) { return v; }
  };

  const parts = strip(rest).split("/").filter(Boolean).map(unesc);
  if (workspace == null) workspace = parts.shift();
  else workspace = unesc(workspace);
  const item = parts.shift();
  if (!workspace || !item)
    throw new Error(`Path must be  workspace/lakehouse.Lakehouse  (got "${input}")`);

  return { workspace, item: /\.lakehouse$/i.test(item) ? item : item + ".Lakehouse" };
}

// -----------------------------------------------------------------------------
// Workspace items — which ones hold OneLake tables, and what to call them
// -----------------------------------------------------------------------------
// A workspace root is mostly notebooks, pipelines, reports and environments. The ones
// worth listing are the items whose directory has a Tables/ under it, and a OneLake
// directory names its own kind: "sales.Lakehouse", "aemo.Warehouse".
export const itemKind = name => {
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
const TABLE_ITEM_KINDS = new Set(["Lakehouse", "Warehouse", "SQLDbNative"]);

// Fabric mirroring (Snowflake, Azure SQL, Cosmos) does land Delta in OneLake, so it
// belongs — but that tenant has no such item, so the internal suffix is UNVERIFIED and
// this prefix is the one guess left in the file. If it is wrong the item is absent from
// the picker, and the item names listItems logs are what identifies the real one.
export const holdsTables = name => {
  const kind = itemKind(name);
  return TABLE_ITEM_KINDS.has(kind) || /^Mirrored/i.test(kind);
};

// Files/ is the unmanaged half of a LAKEHOUSE. Everything else here stores its tables
// in OneLake and nothing else, so browsing Files/ on one listed the item's internal
// storage directories — GUIDs nobody asked to see.
export const hasFilesArea = name => /^lakehouse$/i.test(itemKind(name));

// The kind as the picker should say it: what the person sees in Fabric, not the internal
// type. Anything unlisted names itself, which is still better than being invisible.
const KIND_LABELS = {
  sqldbnative: "SQL database",
  mirroreddatabase: "Mirrored database",
};
export const kindLabel = kind => {
  const k = String(kind || "");
  return KIND_LABELS[k.toLowerCase()] || k;
};

// -----------------------------------------------------------------------------
// File formats
// -----------------------------------------------------------------------------
export const FILE_READERS = {
  parquet: n => `read_parquet([${n}])`,
  parq:    n => `read_parquet([${n}])`,
  pq:      n => `read_parquet([${n}])`,
  csv:     n => `read_csv_auto(${n})`,
  tsv:     n => `read_csv_auto(${n}, delim='\\t')`,
  json:    n => `read_json_auto(${n})`,
  jsonl:   n => `read_json_auto(${n}, format='newline_delimited')`,
  ndjson:  n => `read_json_auto(${n}, format='newline_delimited')`,
  avro:    n => `read_avro(${n})`,
  xlsx:    n => `read_xlsx(${n})`,
};

// Plain text that isn't tabular — a dbt model, a schema.yml, a log — is still worth
// opening, so read it one row per line instead of leaving it dead in the tree. The CSV
// reader does that with splitting disabled: no delimiter that occurs in text, no quote
// or escape character, so every byte of a line lands in the single declared column.
//
// chr(31), not '\x1F'. A DuckDB single-quoted string is literal apart from the handful of
// escapes the CSV reader unescapes itself (\t, \n, \r — which is why the .tsv reader above
// is right), and \xNN is NOT among them: the delimiter was the four characters
// backslash-x-1-F, so ANY file that mentions that escape sequence as text — a regex, a
// separator constant, this comment — split into two columns and failed to open with
// "CSV Error on Line: N". Measured against the pinned build, not reasoned about.
// (delim='' also works and can collide with nothing, but an empty delimiter is not
// documented behaviour to rely on; a raw 0x1F byte means the file was never text.)
//
// The CR trim is exact rather than rtrim(line, chr(13)), which strips EVERY trailing CR —
// a line whose own content ends in a carriage return lost it along with the CRLF's.
const textLines = n =>
  `(SELECT CASE WHEN ends_with(line, chr(13)) THEN left(line, length(line) - 1) ELSE line END AS line ` +
  `FROM read_csv(${n}, columns={'line': 'VARCHAR'}, delim=chr(31), quote='', escape='', ` +
  `header=false, auto_detect=false))`;

// .txt belongs here, not with the CSV formats: the most document-shaped extension there
// is was being auto-parsed into columns, which also kept it out of the compressed-text
// list below and out of the Pretty view.
// .bim and .tmdl are semantic-model definitions — a Tabular .bim IS JSON, and both sit in
// a lakehouse's semanticmodel/ folder, where they were greyed out as unknown formats.
export const TEXT_EXTS = ["sql", "yml", "yaml", "md", "txt", "toml", "ini", "cfg", "conf",
                          "properties", "log", "sh", "py", "html", "xml", "css", "js",
                          "bim", "tmdl"];
for (const ext of TEXT_EXTS) FILE_READERS[ext] = textLines;

export const isTextExt = ext => TEXT_EXTS.includes(String(ext).replace(/\.(gz|zst)$/, ""));

// Compressed text files need no reader of their own: DuckDB picks the codec off the file
// NAME, and files are registered under a name that keeps both halves of the extension
// (file_7.csv.gz), so the plain reader decompresses transparently.
for (const base of ["csv", "tsv", "json", "jsonl", "ndjson", ...TEXT_EXTS])
  for (const codec of ["gz", "zst"])
    FILE_READERS[`${base}.${codec}`] = FILE_READERS[base];

// The only formats with a footer and row groups, i.e. the only ones actually range-read.
export const PARQUET_EXTS = new Set(["parquet", "parq", "pq"]);

// Database files. Not in FILE_READERS because they aren't opened through a reader
// function — the engine ATTACHes them read-only and the file's own tables become
// queryable. Block/page-structured, so DuckDB range-reads them like parquet rather than
// pulling the whole file. The extension does NOT decide the engine: ATTACH sniffs the
// file content (SQLite announces itself in its header), so a DuckDB database stored as
// .db and a real SQLite file both work — which matters because .db is common for both.
export const DB_EXTS = new Set(["duckdb", "ddb", "db", "sqlite", "sqlite3"]);

// Zip archives. Not in FILE_READERS because an archive isn't one dataset — the engine
// (zipfs extension) lists the entries and opens each readable one as its own view over
// a zip:// path. Range-read: the central directory sits at the archive's tail and
// entries inflate only when queried, so a large archive costs what you read from it.
export const ZIP_EXTS = new Set(["zip"]);

// Image files. Not in FILE_READERS because DuckDB is never involved — the app fetches
// the bytes itself (readFileBytes) and shows them as an <img> over a blob URL. The
// value is the mime the Blob must carry: a typeless object URL renders nothing.
export const IMAGE_EXTS = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["svg", "image/svg+xml"],
  ["bmp", "image/bmp"], ["ico", "image/x-icon"],
]);

// A codec suffix is part of the extension — "csv.gz", not "gz" — because it selects both
// the reader and the decompression. Anything else (a .tar.gz) falls through to the
// one-segment form and simply won't be in FILE_READERS.
const COMPRESSED_EXT = /\.([A-Za-z0-9]+)\.(gz|zst)$/i;

export function fileExt(name) {
  const b = basename(name);
  const two = COMPRESSED_EXT.exec(b);
  if (two) return `${two[1].toLowerCase()}.${two[2].toLowerCase()}`;
  const m = /\.([A-Za-z0-9]+)$/.exec(b);
  return m ? m[1].toLowerCase() : "";
}

export const readerFor = ext =>
  Object.prototype.hasOwnProperty.call(FILE_READERS, ext) ? FILE_READERS[ext] : null;

// -----------------------------------------------------------------------------
// SQL text
// -----------------------------------------------------------------------------
export const sqlStr = v => "'" + String(v).replace(/'/g, "''") + "'";
export const quoteIdent = v => '"' + String(v).replace(/"/g, '""') + '"';

// Walk SQL once, keeping track of what is inside a string literal. Returns the text with
// comments replaced by a space, plus the offsets of every ';' that was NOT inside one.
//
// Doing this with two regexes (the previous approach) is wrong in both directions: it
// eats a /* */ that is part of a string value, which changes the result set with no
// error at all, and it rejects a perfectly legal SELECT 'a;b'.
function scan(sql) {
  const out = [];
  const seps = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out.push(" ");
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;                                   // past the closing */, or past the end
      out.push(" ");
      continue;
    }
    // '…' string literal or "…" quoted identifier; the quote doubles to escape itself.
    if (c === "'" || c === '"') {
      out.push(c);
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { out.push(c, c); i += 2; continue; }
          out.push(c); i++;
          break;
        }
        out.push(sql[i]); i++;
      }
      continue;
    }
    // $$…$$ / $tag$…$tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out.push(sql.slice(i, stop));
        i = stop;
        continue;
      }
    }

    if (c === ";") seps.push(out.length);
    out.push(c);
    i++;
  }
  return { text: out.join(""), seps };
}

export function stripComments(sql) {
  return scan(String(sql)).text.trim().replace(/;+\s*$/, "").trim();
}

export const READ_START =
  /^\s*(with|select|describe|show|explain|summarize|pragma|values|from|table|pivot|unpivot)\b/i;

// One statement, and it must start with a read keyword. Throws with the message the UI
// shows. The ';' rule is load-bearing — duckdb-wasm's query() will happily run several
// statements separated by one — but a ';' inside a literal is not a separator.
export function prepareReadOnlySql(raw) {
  const { text, seps } = scan(String(raw));
  if (!text.trim()) throw new Error("Empty query.");
  if (seps.some(i => text.slice(i + 1).trim() !== ""))
    throw new Error("Run one statement at a time (no ';').");
  const sql = text.trim().replace(/;+\s*$/, "").trim();
  if (!sql) throw new Error("Empty query.");
  if (!READ_START.test(sql))
    throw new Error("Read-only: only SELECT / WITH / DESCRIBE / SHOW / EXPLAIN / SUMMARIZE queries are allowed.");
  return sql;
}

// -----------------------------------------------------------------------------
// Iceberg metadata version selection
// -----------------------------------------------------------------------------
// Fabric names metadata files vN.metadata.json; other writers use N.metadata.json or
// 00001-<uuid>.metadata.json. All three carry the version as a leading integer, which is
// a total order — unlike lastModified, which has one-second resolution, so v9 and v10
// written in the same second tie and the older one can win.
export function metadataVersion(name) {
  const m = /^v?(\d+)(?=[-.])/i.exec(basename(name));
  return m ? Number(m[1]) : null;
}

function byVersionThenMtime(a, b) {
  const va = metadataVersion(a.name), vb = metadataVersion(b.name);
  if (va != null && vb != null && va !== vb) return va - vb;
  if (va != null && vb == null) return 1;         // a parsed version beats an unparsed one
  if (va == null && vb != null) return -1;
  return (a.mtime || 0) - (b.mtime || 0);
}

// Choose the current metadata.json from a listing of the table's metadata/ directory.
// `hintText` is the contents of version-hint.text when it exists. Returns null if the
// directory holds no metadata.json at all.
export function pickMetadata(entries, hintText) {
  const jsons = (entries || []).filter(e => /\.metadata\.json$/i.test(basename(e.name)));
  if (!jsons.length) return null;

  const v = hintText == null ? "" : String(hintText).trim();
  if (v) {
    const want = Number(v);
    const hit = jsons.find(j => {
      const b = basename(j.name);
      if (b === `v${v}.metadata.json` || b === `${v}.metadata.json`) return true;
      return Number.isFinite(want) && metadataVersion(b) === want;
    });
    if (hit) return hit;
  }
  return jsons.slice().sort(byVersionThenMtime).pop();
}

// Table-level statistics out of an Iceberg metadata document and its current snapshot —
// the fields the Fabric conversion fills from the source table's own statistics. Only
// the snapshot summary is trustworthy here: Fabric writes zeroed PER-FILE manifest
// statistics (measured — see readManifest's caller), so nothing below reads manifests.
export function snapshotStats(meta, snap) {
  meta = meta || {}; snap = snap || {};
  const summary = snap.summary || {};
  const num = v => Number(v) || null;

  // Partition fields of the CURRENT spec. `default-spec-id` can legitimately be 0, so
  // only fall back to the first spec when the id is absent or unmatched.
  const specs = meta["partition-specs"] || [];
  const spec = specs.find(s => s["spec-id"] === meta["default-spec-id"]) || specs[0];
  const partitionColumns = ((spec || {}).fields || []).map(f =>
    f.transform && f.transform !== "identity" ? `${f.name} (${f.transform})` : f.name);

  // Fabric may mirror the source table's V-Order property into the Iceberg properties.
  // Absent means UNKNOWN, not "no" — the caller must not render a verdict from null.
  const vorderRaw = (meta.properties || {})["delta.parquet.vorder.enabled"];
  const vorderProp = vorderRaw == null ? null
    : String(vorderRaw).trim().toLowerCase() === "true";

  return {
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

// -----------------------------------------------------------------------------
// Cache keys
// -----------------------------------------------------------------------------
// Scoped to the lakehouse, because the engine outlives the user's choice of one: two
// lakehouses both containing dbo.sales must not share an entry. Files are keyed on their
// full path, not their basename, so Files/a/data.parquet and Files/b/data.parquet differ.
export const tableKey = (lh, t) =>
  `${lh.workspace}/${lh.item}#table:${t.schema ? t.schema + "." : ""}${t.table}`;

export const fileKey = (lh, file) => `${lh.workspace}/${lh.item}#file:${strip(file.path)}`;

// A DuckDB-safe identifier stem. Collisions are still possible (a/b and a-b both become
// a_b), so callers must make the result unique before creating a view with it.
export const sanitizeIdent = s => String(s).replace(/[^A-Za-z0-9_]/g, "_");

// SQLite files open with the 16-byte header "SQLite format 3\0". This is how a database
// file's ENGINE is decided — never by extension, since people store DuckDB databases as
// .db too. SQLite is read by sql.js and copied into DuckDB tables; anything else
// attaches as a lazily range-read DuckDB database.
const SQLITE_MAGIC = "SQLite format 3";
export function isSqliteHeader(bytes) {
  if (!bytes || bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++)
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------
// An int64 past 2^53 cannot survive Number(): 1234567890123456789 becomes
// …800. Keep those as strings so what is displayed and what lands in the CSV are the
// digits the table actually holds.
export function normalizeValue(v) {
  if (typeof v === "bigint")
    return (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
      ? Number(v) : v.toString();
  if (v != null && typeof v === "object" && typeof v.toJSON === "function") return v.toJSON();
  return v;
}

// A 1×1 multiline VARCHAR result is presumed to be a document (read_text over a
// README, a NOTICE file) and gets offered as rendered markdown. rows.length, not
// numRows: a truncated result must never qualify. No length threshold — multiline
// is the whole signal; a threshold would make the feature feel flaky.
export function isDocResult(res) {
  if (!res || !Array.isArray(res.fields) || res.fields.length !== 1) return false;
  if (!Array.isArray(res.rows) || res.rows.length !== 1) return false;
  if (((res.types || [])[0] || "") !== "VARCHAR") return false;
  const v = res.rows[0][res.fields[0]];
  return typeof v === "string" && v.includes("\n");
}

// What IS this document? "Pretty" used to mean one thing — run it through a markdown
// parser — and a markdown parser is a lossy renderer for everything that isn't markdown:
// it eats indentation, joins lines into paragraphs, and drops anything that looks like a
// tag. A dbt macro or a JSON blob came out unreadable. So decide first, render second.
//
// JSON wins over markdown because a JSON document is unambiguous — it parsed — while the
// markdown markers are heuristics. Only objects and arrays count: bare `12` and `"x"` are
// valid JSON but nobody means them as a document.
const MARKDOWN_MARKERS = [
  /^ {0,3}#{1,6}\s+\S/m,             // ATX heading
  /^ {0,3}(```|~~~)/m,               // fenced code block
  /^ {0,3}([-*+]|\d+\.)\s+\S/m,      // list item
  /^ {0,3}>\s/m,                     // block quote
  /^ {0,3}\|.*\|/m,                  // table row
  /\[[^\]\n]+\]\([^)\s]+\)/,         // inline link
  /(\*\*|__)\S[^\n]*\1/,             // bold
];

// `ext` is the extension of the file the text CAME FROM, when there is one. It settles
// what sniffing cannot: `  - name: fct_price` is a YAML sequence and a markdown bullet,
// character for character, and only the .yml tells them apart. Hand-written SQL has no
// source file (read_text over a URL, a string literal), so that case still sniffs — and
// there, markdown is the likely intent.
export const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

export function docKind(text, ext = "") {
  const s = String(text);
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") return "json";
    } catch (_) { /* not JSON after all — fall through to the text/markdown question */ }
  }
  const e = String(ext).toLowerCase().replace(/^\./, "").replace(/\.(gz|zst)$/, "");
  if (e) return MARKDOWN_EXTS.has(e) ? "markdown" : "text";
  return MARKDOWN_MARKERS.some(re => re.test(s)) ? "markdown" : "text";
}

// Shared by every innerHTML this app builds — the grid, the file tree, and the two
// document views that are NOT markdown (those are escaped here rather than sanitized,
// because nothing in them was ever meant to be HTML).
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ...and the OTHER shape a document arrives in. read_text() gives one cell, but the Files
// tab reads plain text one row per line (see textLines), so a whole file comes back as N
// rows of a single VARCHAR column called `line` — which isDocResult was never going to
// match, so opening a .sql or a .bim from the tree only ever offered the line grid.
// Joining them back is exactly reversing the split. Returns the document, or null.
export function textLinesDoc(res) {
  if (!res || !Array.isArray(res.fields) || res.fields.length !== 1) return null;
  if (res.fields[0] !== "line" || ((res.types || [])[0] || "") !== "VARCHAR") return null;
  if (!Array.isArray(res.rows) || !res.rows.length) return null;
  // Same rule as isDocResult: half a file rendered as the file is worse than no Pretty tab.
  if (res.truncated) return null;
  return res.rows.map(r => (r.line == null ? "" : String(r.line))).join("\n");
}

export function fmtBytes(n) {
  if (!(n > 0)) return "unknown size";
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

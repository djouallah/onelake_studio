// =============================================================================
// paths.js — the panel's pure half: file kinds, SQL text, cache keys, value shapes.
// =============================================================================
// Plain functions over strings and plain objects: no DOM, no network, no DuckDB. This is
// where the bugs that silently return the WRONG DATA live (cache keys that collide,
// comment stripping that eats string literals), and none of them are reachable by
// clicking around. What OneLake's names and metadata MEAN is the host's (core/names.js).
// =============================================================================

export const DFS_HOST = "onelake.dfs.fabric.microsoft.com";

export const strip = s => String(s).replace(/^\/+|\/+$/g, "");
export const basename = p => strip(p).split("/").pop();

// How native DuckDB names a OneLake object: the workspace is the container, read with the
// host's azure secret. Workspace names with spaces and parentheses work as they are
// (checked against DuckDB 2.0); the result only ever goes into SQL through sqlStr().
export const abfssUrl = (ws, path) => `abfss://${ws}@${DFS_HOST}/${strip(path)}`;

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

// What DuckDB reads from a string by its extension alone, as checked against DuckDB 2.0. A SQL box
// says only the file's name for these, and its reader for the rest.
const READS_BARE = new Set(["parquet", "csv", "tsv", "json", "jsonl", "csv.gz"]);
export const fileSource = (ext, name) => {
  const reader = readerFor(ext);
  return READS_BARE.has(ext) || !reader ? sqlStr(name) : reader(sqlStr(name));
};

// -----------------------------------------------------------------------------
// SQL text
// -----------------------------------------------------------------------------
// Text without the byte-order mark some editors write first, which JSON.parse refuses.
export const stripBom = s => String(s).replace(/^\uFEFF/, "");

export const sqlStr = v => "'" + String(v).replace(/'/g, "''") + "'";
export const quoteIdent = v => '"' + String(v).replace(/"/g, '""') + '"';
// DuckDB's reserved words (duckdb_keywords(), 'reserved' and 'type_function'): a name spelled
// like one must be quoted. core/names.js keeps the host's twin; a test holds them equal.
export const RESERVED = new Set(("all analyse analyze and anti any array as asc asof asymmetric at authorization binary " +
  "both by case cast check collate collation column columns concurrently constraint create cross default " +
  "deferrable desc describe distinct do else end except false fetch for foreign freeze from full generated " +
  "glob group having ilike in initially inner intersect into is isnull join lambda lateral leading left like " +
  "limit map natural not notnull null offset on only or order outer overlaps pivot pivot_longer pivot_wider " +
  "placing positional primary qualify references returning right select semi show similar some struct " +
  "summarize symmetric table tablesample then to trailing true try_cast tuple union unique unpack unpivot " +
  "using variadic verbose when where window with").split(" "));
// A name as SQL writes it: bare when it can be, quoted when it must.
export const sqlPart = v => {
  const s = String(v);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !RESERVED.has(s.toLowerCase()) ? s : quoteIdent(s);
};
// A file's SQL name (core/names.js fileSqlName; a test holds them equal), from its workspace and its
// path from the item, "data.Lakehouse/Files/x.parquet". null for a path no lakehouse holds.
export const fileSqlName = (ws, path) => {
  const m = /^([^/]+)\.Lakehouse\/Files(?:\/(.*))?$/i.exec(strip(path));
  if (!m) return null;
  return `${[ws, `${m[1]}_lakehouse`].map(sqlPart).join(".")}/Files${m[2] ? `/${m[2]}` : ""}`;
};

// CSV: a cell is quoted when it holds a quote, a comma or a line break of either kind.
// `text` turns a value into its cell; lines end with `eol`.
export function toCsv(fields, rows, { text = v => (v == null ? '' : String(v)), eol = '\r\n' } = {}) {
  const cell = v => { const t = text(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [fields.map(cell).join(','), ...rows.map(r => fields.map(f => cell(r[f])).join(','))].join(eol);
}

// An Iceberg primitive type, in DuckDB's name for it. Anything nested or unknown is
// VARCHAR — this is only ever used to give a table with no rows its columns.
const ICEBERG_DUCK = { boolean: "BOOLEAN", int: "INTEGER", long: "BIGINT", float: "FLOAT",
  double: "DOUBLE", date: "DATE", time: "TIME", timestamp: "TIMESTAMP",
  timestamptz: "TIMESTAMPTZ", timestamp_ns: "TIMESTAMP_NS", timestamptz_ns: "TIMESTAMPTZ",
  string: "VARCHAR", uuid: "UUID", binary: "BLOB" };
export function icebergToDuckType(t) {
  const s = String(t || "").toLowerCase();
  const dec = /^decimal\((\d+),\s*(\d+)\)$/.exec(s);
  if (dec) return `DECIMAL(${dec[1]},${dec[2]})`;
  if (/^fixed\[\d+\]$/.test(s)) return "BLOB";
  return ICEBERG_DUCK[s] || "VARCHAR";
}

// A table the catalog lists but nothing has ever been written to: no snapshot, no data
// file, nothing to scan. Its columns are in the metadata, so its view is an empty SELECT
// of typed NULLs — no read at all.
export function emptyTableSql(fields) {
  const cols = (fields || []).map(f => `CAST(NULL AS ${icebergToDuckType(f.type)}) AS ${quoteIdent(f.name)}`);
  return `SELECT ${cols.length ? cols.join(", ") : "NULL AS empty"} WHERE false`;
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

// What an attached database file holds, from DuckDB's own catalog: no table's rows are read. A
// schema can sit inside a schema, and the catalog names only the innermost, so a schema's parent
// is asked for too. Ids are text, as an oid has no use as a number here. A table is found by its
// schema and name: a SQLite file's tables get a new oid each time the catalog is asked.
export const dbCatalogSql = alias => {
  const db = sqlStr(alias);
  const own = name => `schema_oid::VARCHAR || '/' || ${name}`;
  return {
    schemas: `SELECT oid::VARCHAR AS id, parent_schema_oid::VARCHAR AS parent, schema_name AS name
                FROM duckdb_schemas() WHERE database_name = ${db}`,
    objects: `SELECT schema_oid::VARCHAR AS schema_id, ${own('table_name')} AS id, table_name AS name, 'table' AS kind,
                     estimated_size AS estimate, comment, sql
                FROM duckdb_tables() WHERE database_name = ${db}
              UNION ALL
              SELECT schema_oid::VARCHAR, ${own('view_name')}, view_name, 'view', NULL, comment, sql
                FROM duckdb_views() WHERE database_name = ${db} AND NOT internal`,
    columns: `SELECT ${own('table_name')} AS owner, column_name AS name, data_type AS type, is_nullable AS nullable,
                     column_default AS dflt, comment
                FROM duckdb_columns() WHERE database_name = ${db} AND NOT internal
               ORDER BY schema_oid, table_name, column_index`,
    // NOT NULL is left out: each column says so itself.
    constraints: `SELECT ${own('table_name')} AS owner, constraint_type AS type, constraint_text AS text,
                         to_json(constraint_column_names)::VARCHAR AS cols, referenced_table AS ref
                    FROM duckdb_constraints() WHERE database_name = ${db} AND constraint_type <> 'NOT NULL'`,
    indexes: `SELECT ${own('table_name')} AS owner, index_name AS name, sql
                FROM duckdb_indexes() WHERE database_name = ${db}`,
  };
};

// The exact row count of each table. A SQLite file's catalog has no count worth showing, and
// these are read from its local copy.
export const dbCountSql = tables => tables
  .map(t => `SELECT ${sqlStr(t.id)} AS id, count(*) AS n FROM ${t.sqlName}`).join(" UNION ALL ");

// What dbCatalogSql's answers say, as schemas holding tables and views: { schemas, objects }. A
// schema with nothing in it is left out: every DuckDB file has a `main`, used or not.
export function dbCatalog({ alias, schemas, objects, columns, constraints = [], indexes = [], estimated = true }) {
  const schemaById = new Map(schemas.map(s => [s.id, s]));
  const pathOf = id => {
    const s = schemaById.get(id);
    return s ? [...(s.parent == null ? [] : pathOf(s.parent)), s.name] : [];
  };
  const byOwner = list => {
    const m = new Map();
    for (const x of list) { if (!m.has(x.owner)) m.set(x.owner, []); m.get(x.owner).push(x); }
    return m;
  };
  const colsOf = byOwner(columns), consOf = byOwner(constraints), idxOf = byOwner(indexes);
  const byName = (a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
  const groups = new Map();
  for (const o of objects) {
    const path = pathOf(o.schema_id);
    const schema = path.join(".");
    if (!groups.has(schema)) groups.set(schema, { name: schema, objects: [] });
    const keys = (consOf.get(o.id) || []).map(c => ({ ...c, cols: JSON.parse(c.cols || "[]") }));
    const inKey = (type, name) => keys.some(k => k.type === type && k.cols.includes(name));
    const fkOf = name => keys.find(k => k.type === "FOREIGN KEY" && k.cols.includes(name));
    groups.get(schema).objects.push({
      id: o.id, name: o.name, kind: o.kind, schema, comment: o.comment || null, sql: o.sql || null,
      sqlName: [alias, ...path, o.name].map(sqlPart).join("."),
      rows: estimated && o.kind === "table" && o.estimate != null ? Number(o.estimate) : null,
      rowsExact: false,
      columns: (colsOf.get(o.id) || []).map(c => ({
        name: c.name, type: c.type, nullable: c.nullable !== false, dflt: c.dflt ?? null, comment: c.comment || null,
        pk: inKey("PRIMARY KEY", c.name),
        fk: fkOf(c.name) ? fkOf(c.name).ref : null,
      })),
      constraints: keys.map(k => ({ type: k.type, text: k.text })),
      indexes: (idxOf.get(o.id) || []).map(i => ({ name: i.name, sql: i.sql })),
    });
  }
  const sorted = [...groups.values()].sort(byName);
  // Tables, then views: what most people came for comes first.
  for (const g of sorted) g.objects.sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === "table" ? -1 : 1));
  return { schemas: sorted, objects: sorted.flatMap(g => g.objects) };
}

// The tree of a database file, as the rows on screen: a schema, its tables and views, the columns
// of those opened. `filter` keeps what matches by its own name or a column's; a schema with a
// match is open whatever it was, and so is a table matched only by a column, so the match shows.
export function dbTreeRows(catalog, { closed = new Set(), open = new Set(), filter = "" } = {}) {
  const q = String(filter).trim().toLowerCase();
  const has = s => String(s).toLowerCase().includes(q);
  const rows = [];
  for (const s of catalog.schemas) {
    const objects = q ? s.objects.filter(o => has(o.name) || o.columns.some(c => has(c.name))) : s.objects;
    if (q && !objects.length) continue;
    const schemaOpen = q ? true : !closed.has(s.name);
    rows.push({ key: `schema:${s.name}`, level: 1, type: "schema", name: s.name, count: objects.length, expanded: schemaOpen });
    if (!schemaOpen) continue;
    for (const o of objects) {
      const expanded = open.has(o.id) || (!!q && !has(o.name));
      rows.push({ key: `object:${o.id}`, level: 2, type: o.kind, name: o.name, object: o, expanded });
      if (!expanded) continue;
      for (const c of o.columns) rows.push({ key: `column:${o.id}:${c.name}`, level: 3, type: "column", name: c.name, column: c, object: o });
    }
  }
  return rows;
}

// A table's row count as shown. An estimate says so: a DuckDB file's still counts deleted rows.
export const dbRowsText = o => o.rows == null ? "" : `${o.rowsExact ? "" : "≈ "}${Number(o.rows).toLocaleString("en")}`;

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

// How old an answer's tables are, when that is worth saying: "" within the hour. A table's metadata
// is trusted for a day by default, so a query can read yesterday's snapshot with no error.
export function ageNote(asOf, now = Date.now()) {
  if (!Number.isFinite(asOf)) return "";
  const hours = Math.floor((now - asOf) / 3_600_000);
  if (hours < 1) return "";
  const days = Math.floor(hours / 24);
  const [n, unit] = hours < 48 ? [hours, "hour"] : [days, "day"];
  return `tables as of ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export function normalizeRow(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = normalizeValue(obj[f]);
  return out;
}

// A statement's batches, as the result the grid renders. Rows are kept up to `maxRows`, and every
// batch still counts: numRows is the whole result, however many arrived as rows. The host stops
// sending rows at the same number and sends a count after that, so `truncated` compares the two
// rather than waiting for a row past the cap, which never comes.
export function rowCollector(maxRows) {
  let fields = null, types = null, numRows = 0;
  const rows = [];
  return {
    add(batch) {
      if (!fields) {
        fields = batch.fields.map(f => f.name);
        types = batch.fields.map(f => f.type);
      }
      numRows += batch.numRows;
      for (const r of batch.rows) {
        if (rows.length >= maxRows) break;
        rows.push(normalizeRow(r, fields));
      }
    },
    result: () => ({ fields: fields || [], types: types || [], rows, numRows, truncated: numRows > rows.length, limit: maxRows }),
  };
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

// =============================================================================
// paths.js — the panel's pure half: file kinds, SQL text, cache keys, value shapes.
// =============================================================================
// Plain functions over strings and plain objects: no DOM, no network, no DuckDB. This is
// where the bugs that silently return the WRONG DATA live (cache keys that collide,
// comment stripping that eats string literals), and none of them are reachable by
// clicking around. What OneLake's names and metadata MEAN is the host's (src/names.js).
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

// -----------------------------------------------------------------------------
// SQL text
// -----------------------------------------------------------------------------
// Text without the byte-order mark some editors write first, which JSON.parse refuses.
export const stripBom = s => String(s).replace(/^\uFEFF/, "");

export const sqlStr = v => "'" + String(v).replace(/'/g, "''") + "'";
export const quoteIdent = v => '"' + String(v).replace(/"/g, '""') + '"';
// DuckDB's reserved words (duckdb_keywords(), 'reserved' and 'type_function'): a name spelled
// like one must be quoted. src/names.js keeps the host's twin; a test holds them equal.
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

// CSV: a cell is quoted when it holds a quote, a comma or a line break of either kind.
// `text` turns a value into its cell; lines end with `eol`.
export function toCsv(fields, rows, { text = v => (v == null ? '' : String(v)), eol = '\r\n' } = {}) {
  const cell = v => { const t = text(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [fields.map(cell).join(','), ...rows.map(r => fields.map(f => cell(r[f])).join(','))].join(eol);
}

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
// shows. The ';' rule is load-bearing — DuckDB will happily run several statements
// separated by one — but a ';' inside a literal is not a separator.
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

// Does this SQL actually reference the named table? Binding a table means registering
// every one of its data files and reading their footers — real money on a metered lake —
// so it must not happen because someone ran `SELECT 42` while a table happened to be
// selected. Comments are stripped first: a table named in a comment is not a reference.
// Errs toward NOT binding; the cost of a miss is an "unknown table" the user fixes with
// the Preview button, and the cost of a false positive is a bill.
export function sqlNeedsTable(sql, table) {
  if (!sql || !table) return false;
  const esc = String(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bounded by anything that cannot be part of an identifier — quotes included, so both
  // `mart.sales` and `"mart"."sales"` match, but `sales_archive` does not.
  return new RegExp(`(^|[^\\w"])"?${esc}"?($|[^\\w"])`, "i").test(stripComments(String(sql)));
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

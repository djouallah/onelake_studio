'use strict';
// =============================================================================
// sql.js — SQL text helpers for the extension host
// =============================================================================
// The CJS twins of the two helpers in app/paths.js, which is ESM and loads in the
// webview. Both files must agree on what these do — they build the same statements from
// the two sides of the bridge — and each is one line for exactly that reason: the
// definition IS the contract, and anything more would give the copies room to diverge.

// A complete single-quoted SQL literal. Doubling the quote is the whole of DuckDB's
// escaping story for strings.
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

// A double-quoted identifier, for names that came from data rather than from this code.
const quoteIdent = s => `"${String(s).replace(/"/g, '""')}"`;

// -----------------------------------------------------------------------------
// Read only, enforced where the engine is
// -----------------------------------------------------------------------------
// The extension never writes to OneLake or Fabric. Every statement the page or the command line
// sends is checked here, before DuckDB runs it.
//
// What passes: one statement that reads. Nothing else: no COPY, INSERT, UPDATE, DELETE, EXPORT,
// INSTALL, LOAD, SET, CREATE, DROP, ATTACH or DETACH. What a tab sets up to read a file is a host
// method (engine-host.js fileView, attachFile), so no statement can reach another tab's.
//
// There are two walls. assertReads reads the text with this file's own scanner, which refuses at
// once. checkedRead then asks DuckDB's parser, in a DuckDB that holds nothing, what the statement is,
// so that being wrong about SQL's lexing isn't enough to write.

// Where a comment, a quoted text or a $$ string ends, as DuckDB's own scanner reads them. The
// guard is only as good as this agreement: where they differ, a ';' or a COPY that DuckDB runs is
// text this file never looks at. Each was seen getting past when it was wrong.
// DuckDB takes the Unicode spaces (U+00A0, U+2000 to U+200B, U+202F, U+205F, U+3000, U+FEFF) for spaces
// before it reads anything else, so they are never part of a word.
const LETTERS = '\\u00c0-\\u1fff\\u200c-\\u202e\\u2030-\\u205e\\u2060-\\u2fff\\u3001-\\ufefe\\uff00-\\uffff';
const HIGH = `\\u0080-\\u009f\\u00a1-\\u00bf${LETTERS}`;
const IDENT_CHAR = new RegExp(`[A-Za-z0-9_$${HIGH}]`);
const DOLLAR_TAG = new RegExp(`\\$(?:[A-Za-z_${HIGH}][A-Za-z0-9_${HIGH}]*)?\\$`, 'y');

// The end of the comment starting at `i`, or -1 when none does. A line comment stops at either
// line break, and block comments nest.
function commentEnd(sql, i) {
  const n = sql.length;
  if (sql[i] === '-' && sql[i + 1] === '-') {
    let j = i;
    while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
    return j;
  }
  if (sql[i] === '/' && sql[i + 1] === '*') {
    let depth = 1, j = i + 2;
    while (j < n && depth) {
      if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
      else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
      else j++;
    }
    return Math.min(j, n);
  }
  return -1;
}

// The end of the quoted text opening at `i`. Doubling the quote escapes it, and in an E'…' string
// a backslash does too. An E that ends a longer word is not one: typee'x'.
function quotedEnd(sql, i) {
  const n = sql.length;
  const q = sql[i];
  const backslash = q === "'" && /[eE]/.test(sql[i - 1] || '') && !IDENT_CHAR.test(sql[i - 2] || '');
  let j = i + 1;
  while (j < n) {
    if (backslash && sql[j] === '\\') { j += 2; continue; }
    if (sql[j] === q) {
      if (sql[j + 1] !== q) return j + 1;
      j += 2;
      continue;
    }
    j++;
  }
  return n;
}

// The end of the $$ string opening at `i`, or -1 when none does: a '$' inside a word is the word's,
// and a tag can hold more than ASCII.
function dollarEnd(sql, i) {
  if (i > 0 && IDENT_CHAR.test(sql[i - 1])) return -1;
  DOLLAR_TAG.lastIndex = i;
  const m = DOLLAR_TAG.exec(sql);
  if (!m) return -1;
  const end = sql.indexOf(m[0], i + m[0].length);
  return end === -1 ? sql.length : end + m[0].length;
}

// Comments become a space and the INSIDE of every literal, quoted identifier and $$ string
// is dropped (its quotes kept), so no keyword can hide in one and no name can pose as one.
// `seps` are the offsets of the ';' outside them. With `keep`, only the comments go. With NAMES, the
// inside of a quoted name stays too, and a string's goes: a function's name can be quoted.
const NAMES = 'names';
function scan(sql, keep = false) {
  const out = [];
  const seps = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const comment = commentEnd(sql, i);
    if (comment !== -1) {
      i = comment;
      out.push(' ');
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i = quotedEnd(sql, i);
      if (keep === true || (keep === NAMES && c === '"')) out.push(sql.slice(start, i));
      else out.push(c, c);
      continue;
    }
    if (c === '$') {
      const end = dollarEnd(sql, i);
      if (end !== -1) {
        const start = i;
        i = end;
        // Two pieces when it goes: `seps` counts them, as characters.
        if (keep === true) out.push(sql.slice(start, i));
        else out.push("'", "'");
        continue;
      }
    }
    if (c === ';') seps.push(out.length);
    out.push(c);
    i++;
  }
  return { text: out.join(''), seps };
}

const READS = new Set(['select', 'with', 'from', 'values', 'table', 'describe', 'desc', 'show',
                       'summarize', 'pivot', 'unpivot']);
// What a statement can start with once a WITH's CTEs are done: DuckDB takes
// `WITH … INSERT INTO`, so the WITH alone says nothing about what runs.
const STARTS = new Set([...READS, 'insert', 'update', 'delete', 'merge', 'copy']);

// The words of `text` outside any parentheses — a CTE's body, a column list.
function topLevelWords(text) {
  const words = [];
  let depth = 0;
  for (const m of text.matchAll(/[()]|[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) words.push(m[0].toLowerCase());
  }
  return words;
}

function isRead(text) {
  // (SELECT 1) UNION ALL (SELECT 2) starts with a parenthesis.
  const first = (/^[\s(]*([A-Za-z_]+)/.exec(text) || [, ''])[1].toLowerCase();
  if (first !== 'with') return READS.has(first);
  // The statement after the CTEs is the first top-level word that can start one, other than a
  // CTE's own name: `values` is a legal one, bare.
  const words = topLevelWords(text).slice(1);
  const main = words.find((w, i) => STARTS.has(w) && w !== 'with' && words[i + 1] !== 'as');
  return !!main && READS.has(main);
}

const refuse = why => {
  throw new Error(`Read only: OneLake Studio never writes, and ${why}.`);
};

const ONELAKE_HOST = /^(?:[a-z0-9-]+-)?onelake\.(?:dfs|blob)\.fabric\.microsoft\.com$/i;

// The statement's text with comments and the insides of quotes gone, or refused: more than one
// statement, an empty one, or Quack.
function oneStatement(sql) {
  const { text, seps } = scan(String(sql));
  if (seps.some(i => text.slice(i + 1).trim() !== '')) refuse('runs one statement at a time');
  // Quack is how the shared engine's windows reach it, and its functions start, stop and connect
  // servers. Read with the quotes' insides kept, since a function's name can be quoted.
  const kept = scan(String(sql), true).text;
  if (/\bquack_\w+|\bscan_data_from_quack_client\b/i.test(kept)) refuse('Quack is not for statements');
  // The disk cache's switches and the engine's log are the host's, on a server every tab shares.
  if (/\bcache_httpfs_\w+|\b(?:enable_logging|disable_logging|truncate_duckdb_logs)\b/i.test(kept)) refuse('the engine\'s own switches are not for statements');
  // Each of these writes from a SELECT. Named as a function, a string's insides being gone, so a value can mention one.
  const called = scan(String(sql), NAMES).text;
  if (/\b(?:write_blob|write_log)"?\s*\(/i.test(called)) refuse('this function writes');
  // query('…' || '…') runs SQL no name above can be found in, DuckDB having joined the text up first.
  if (/\bquery(?:_table)?"?\s*\(/i.test(called)) refuse('query() runs what no check here can read');
  // The OneLake secret goes with any abfss:// URL, whatever its host. A URL joined up from pieces gets past
  // this, and the disk cache refuses it there too.
  for (const [, authority] of kept.matchAll(/\b(?:abfss?|az|azure):\/\/([^/'"\r\n]*)/gi)) {
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (host.includes('.') && !ONELAKE_HOST.test(host)) refuse(`${host} is not OneLake`);
  }
  const s = text.trim().replace(/;+\s*$/, '').trim();
  if (!s) refuse('this statement is empty');
  return s;
}

// EXPLAIN [ANALYZE] q, or EXPLAIN (ANALYZE, FORMAT json|html) q — Explore's Show plan. The option
// list is EXPLAIN's own words only; what follows must still be a read.
const EXPLAIN = /^explain\s*(?:\(\s*((?:analy[sz]e|format\s+(?:json|html|text|graphviz))(?:\s*,\s*(?:analy[sz]e|format\s+(?:json|html|text|graphviz)))*)\s*\)\s*|analy[sz]e\s+)?([\s\S]*)$/i;

function readsOrExplains(s) {
  if (isRead(s)) return true;
  const explained = EXPLAIN.exec(s);
  if (!explained) return false;
  if (isRead(explained[2])) return true;
  refuse('EXPLAIN runs only over a query');
}

const notARead = s => refuse(`${(/^[A-Za-z_]+/.exec(s) || ['this'])[0].toUpperCase()} is not a read`);

/** Throws unless `sql` is, by this file's own reading of it, one statement that only reads. */
function assertReads(sql) {
  const s = oneStatement(sql);
  if (!readsOrExplains(s)) notARead(s);
}

// DuckDB's parser on a query, by its json_serialize_sql: it answers for SELECT and what is written
// as one (SHOW, DESCRIBE, SUMMARIZE, VALUES, FROM), and says so for anything else.
const NOT_A_SELECT = /Only SELECT statements/i;
const PIVOT = /\b(?:un)?pivot\b/i;
async function parsedRead(sql, serialize, strict) {
  const parsed = await serialize(sql);
  if (!parsed.error) {
    if (parsed.statements.length !== 1) refuse('runs one statement at a time');
    return sql;
  }
  if (!NOT_A_SELECT.test(parsed.error_message)) {
    // It doesn't parse, so nothing in it can run: DuckDB's own error, with where it is, says why.
    if (strict) throw new Error(parsed.error_message);
    return sql;
  }
  const text = scan(String(sql)).text;
  if (!PIVOT.test(text)) notARead(text.trim());
  // A PIVOT is a read this answer can't speak for: it can parse into more than one statement. As a
  // subquery it says the same, while what isn't a query there fails to parse, as a DELETE with a PIVOT
  // in it does. It runs with the comments gone, and no text this file took for a comment can be
  // anything else.
  const kept = withoutComments(sql);
  const nested = await serialize(`SELECT * FROM (${kept}\n)`);
  if (nested.error && !NOT_A_SELECT.test(nested.error_message)) notARead(text.trim());
  return kept;
}

/**
 * What to run for `sql`, once DuckDB's parser agrees it is one read. Throws otherwise.
 * @param {string} sql
 * @param {(sql: string) => Promise<object>} serialize  DuckDB's json_serialize_sql on it, parsed
 * @param {object} [o]
 * @param {boolean} [o.strict]  it goes inside a statement of ours, so one that doesn't parse stops here
 * @returns {Promise<string>}
 */
async function checkedRead(sql, serialize, { strict = false } = {}) {
  assertReads(sql);
  const kept = withoutComments(sql);
  const explained = EXPLAIN.exec(kept);
  if (!explained) return parsedRead(sql, serialize, strict);
  // Run as what was checked, under the words the pattern above allows.
  const body = explained[2];
  return kept.slice(0, kept.length - body.length) + await parsedRead(body, serialize, strict);
}

// -----------------------------------------------------------------------------
// The OneLake tables a statement names
// -----------------------------------------------------------------------------
// Every dotted name of five or more parts whose first part is one of `kinds` (names.js
// SQL_KINDS, matched as DuckDB matches names: ignoring case), as { kind, workspace, item,
// schema, table } — the kind spelled as `kinds` spells it, the rest as written, quotes
// undone. A sixth part on is a column of that table. Comments and string literals are
// skipped, so a name in either is not a table. Any statement: a SELECT, a DESCRIBE, an
// EXPLAIN, a CREATE VIEW over one.
const IDENT = new RegExp(`[A-Za-z_${LETTERS}][A-Za-z0-9_$${LETTERS}]*`, 'y');
// The spaces and comments between two parts of a name.
function pastSpace(s, j) {
  for (const n = s.length; j < n;) {
    const comment = commentEnd(s, j);
    if (comment !== -1) j = comment;
    else if (/[\s​]/.test(s[j])) j++;
    else break;
  }
  return j;
}
function tableRefs(sql, kinds) {
  const canon = new Map(kinds.map(k => [k.toLowerCase(), k]));
  const s = String(sql);
  const n = s.length;
  const out = [];
  let i = 0;
  const startsIdent = j => s[j] === '"' || (IDENT.lastIndex = j, IDENT.test(s));
  const ident = () => {
    if (s[i] === '"') {
      let v = '';
      i++;
      while (i < n) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += s[i++];
      }
      return v;
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(s);
    i = IDENT.lastIndex;
    return m[0];
  };
  const space = j => pastSpace(s, j);
  while (i < n) {
    const c = s[i];
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (c === "'") { i = quotedEnd(s, i); continue; }
    if (c === '$') {
      const end = dollarEnd(s, i);
      if (end !== -1) { i = end; continue; }
    }
    if (!startsIdent(i)) { i++; continue; }
    const parts = [ident()];
    for (;;) {
      const dot = space(i);
      if (s[dot] !== '.') break;
      const next = space(dot + 1);
      if (!startsIdent(next)) break;
      i = next;
      parts.push(ident());
    }
    const kind = canon.get(parts[0].toLowerCase());
    if (kind && parts.length >= 5) {
      out.push({ kind, workspace: parts[1], item: parts[2], schema: parts[3], table: parts[4] });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// The files a statement names
// -----------------------------------------------------------------------------
// A file is 'lakehouse.<workspace>.<item>/Files/<path>' (docs/NAMING.md). DuckDB can't read that, so
// the engine gives it the file's abfss:// URL. A string that looks like one is only a file where SQL
// reads a file: after FROM or JOIN (or a comma among them), after DESCRIBE, SUMMARIZE or PIVOT, or as
// the first argument of a table function, alone or in a list. Anywhere else it is a value.
//
// A name that is wrong throws rather than going to DuckDB, which would look for it on the local disk,
// and glob() would answer no rows with no error. A string that starts like a name and has no '/' is
// not one: 'lakehouse.parquet'.
const READS_FROM = new Set(['from', 'join', 'lateral', 'describe', 'desc', 'summarize', 'pivot', 'unpivot']);
const NOT_FROM = new Set(['select', 'where', 'group', 'having', 'qualify', 'order', 'limit', 'offset', 'window',
                          'union', 'intersect', 'except', 'values']);
const FILE_PART = new RegExp(`"((?:[^"]|"")*)"|([A-Za-z_${LETTERS}][A-Za-z0-9_$${LETTERS}]*)`, 'y');

function fileName(value, kinds) {
  const zip = /^zip:\/\//i.test(value) ? value.slice(0, 6) : '';
  const text = value.slice(zip.length);
  const first = /^[A-Za-z]+(?=\.)/.exec(text);
  const kind = first && kinds.get(first[0].toLowerCase());
  if (!kind) return null;
  const parts = [];
  let i = 0;
  for (;;) {
    FILE_PART.lastIndex = i;
    const m = FILE_PART.exec(text);
    if (!m) break;
    parts.push(m[1] != null ? m[1].replace(/""/g, '"') : m[2]);
    i = FILE_PART.lastIndex;
    if (text[i] !== '.') break;
    i++;
  }
  if (!text.includes('/')) return null;
  const wrong = why => new Error(`'${value}': ${why}`);
  const shape = "a file's name is lakehouse.<workspace>.<item>/Files/<path>, with a part that isn't a plain name in double quotes";
  if (text[i] !== '/' || parts.length !== 3) throw wrong(shape);
  if (kind !== 'lakehouse') throw wrong('only a lakehouse has Files/');
  const path = text.slice(i);
  if (/^\/Tables(\/|$)/.test(path)) throw wrong(`a table's name is lakehouse.${text.slice(text.indexOf('.') + 1, i)}.<schema>.<table>`);
  if (!/^\/Files(\/|$)/.test(path)) throw wrong(shape);
  if (path.split('/').some(s => s === '.' || s === '..')) throw wrong("a file's path can't hold . or ..");
  return { zip, workspace: parts[1], item: parts[2], path, written: `${text.slice(0, i)}/Files` };
}

/**
 * The file names `sql` reads, in order, each with where its string is. Throws on one that is wrong.
 * @returns {{start: number, end: number, quote: string, zip: string, workspace: string, item: string, path: string, written: string}[]}
 */
function fileRefs(sql, kinds) {
  const canon = new Map(kinds.map(k => [k.toLowerCase(), k]));
  const s = String(sql);
  const n = s.length;
  const refs = [];
  let frames = [{ from: false }];
  // The last token, whether it was a word, and what came before the name it ends (main.read_csv).
  let prev = '', word = false, beforeName = '';
  const top = () => frames[frames.length - 1];
  const inSlot = (f, before) => READS_FROM.has(before) || (before === ',' && f.from) || (before === '(' && f.slot);
  const readsFile = () => {
    const f = top();
    return inSlot(f, prev) || (f.fn && prev === '(') || (f.list && (prev === '[' || prev === ','));
  };
  // `a IS DISTINCT FROM b` and trim(x FROM y) read no file. A call's parentheses can hold a query, with
  // its own FROM: IN (SELECT …), or IN (FROM …).
  const valueFrom = () => prev === 'distinct' || (top().call && !top().query && prev !== '(');
  const named = w => {
    if (w === 'from' && prev !== '.' && valueFrom()) {
      beforeName = prev;
      prev = 'value from';
      word = true;
      return;
    }
    if (prev !== '.') {
      if (w === 'from' || w === 'join') top().from = true;
      else if (NOT_FROM.has(w)) top().from = false;
      if (w === 'select' || w === 'with') top().query = true;
      beforeName = prev;
    }
    prev = w;
    word = true;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      const end = quotedEnd(s, i);
      const text = s.slice(i + 1, end - 1);
      const ref = readsFile() ? fileName(text.split(c + c).join(c), canon) : null;
      if (ref) refs.push({ ...ref, start: i, end, quote: c });
      // A quoted name is a name, never a keyword.
      if (c === '"' && prev !== '.') beforeName = prev;
      prev = c;
      word = c === '"';
      i = end;
      continue;
    }
    if (c === '$') {
      const end = dollarEnd(s, i);
      if (end !== -1) { prev = c; word = false; i = end; continue; }
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(s);
    if (m) { named(m[0].toLowerCase()); i = IDENT.lastIndex; continue; }
    if (c === '(') {
      const fn = word && !READS_FROM.has(prev) && !NOT_FROM.has(prev) && inSlot(top(), beforeName);
      frames.push({ from: false, fn, slot: !fn && inSlot(top(), prev), call: word });
    } else if (c === '[') {
      frames.push({ from: false, list: !!top().fn && prev === '(' });
    } else if ((c === ')' || c === ']') && frames.length > 1) {
      frames.pop();
    } else if (c === ';') {
      frames = [{ from: false }];
    }
    prev = c;
    word = false;
    i++;
  }
  return refs;
}

// DuckDB's error on a statement with its files' URLs in it, as the statement was written. `written` is
// [{ url, name }]. Its caret moves with the text, since the page finds that line in what was written.
// The OneLake files a statement reads, as DuckDB is given them: an abfss:// URL after FROM, JOIN or
// ATTACH, or as a function's argument, and not one that is only a value, as a model's path can be. A
// zip's entry is its zip, and a wildcard names no one file.
function filesReadBy(sql) {
  const found = new Set();
  const at = /(?:\b(?:from|join|attach)\s+\(?\s*'|\b(?!values\b)\w+\s*\(\s*\[?\s*')(zip:\/\/)?(abfss:\/\/[^']+)'/gi;
  for (const [, zip, url] of String(sql).matchAll(at)) {
    if (/[*?[]/.test(url)) continue;
    found.add(zip ? url.replace(/(\.zip)\/.*$/i, '$1') : url);
  }
  return [...found];
}

function namedError(message, written) {
  let text = String(message);
  const line = /(LINE \d+: )([^\n]*)\n( *)\^/.exec(text);
  if (line) {
    let excerpt = line[2];
    let caret = line[3].length - line[1].length;
    for (const { url, name } of written) {
      for (let at = excerpt.indexOf(url); at !== -1; at = excerpt.indexOf(url, at + name.length)) {
        if (caret >= at + url.length) caret += name.length - url.length;
        else if (caret > at) caret = at;
        excerpt = excerpt.slice(0, at) + name + excerpt.slice(at + url.length);
      }
    }
    text = text.replace(line[0], () => `${line[1]}${excerpt}\n${' '.repeat(line[1].length + Math.max(caret, 0))}^`);
  }
  for (const { url, name } of written) text = text.split(url).join(name);
  return text;
}

// -----------------------------------------------------------------------------
// The catalog, listed with every schema's whole path
// -----------------------------------------------------------------------------
// A OneLake table's workspace, item and schema are nested schemas (names.js sqlName), and
// DuckDB's own SHOW ALL TABLES and SHOW SCHEMAS name only the innermost one: two
// workspaces' dbo.t came out as one row, its columns merged. These answer the same columns
// from DuckDB's own catalog functions, each schema named by its path from the catalog down,
// a part quoted where SQL must quote it — so `lakehouse` + `ws.lh.dbo` + `t` is the name a
// query reads. Every other statement runs as written.
const CATALOG_CTES = `WITH RECURSIVE
  kw AS (SELECT keyword_name AS w FROM duckdb_keywords() WHERE keyword_category IN ('reserved', 'type_function')),
  s AS (SELECT database_oid, database_name, oid, schema_name AS n, parent_schema_oid,
               CASE WHEN regexp_full_match(schema_name, '[A-Za-z_][A-Za-z0-9_]*') AND lower(schema_name) NOT IN (SELECT w FROM kw)
                    THEN schema_name ELSE '"' || replace(schema_name, '"', '""') || '"' END AS q
        FROM duckdb_schemas()),
  p AS (SELECT database_oid, database_name, oid, q AS path, [n] AS parts FROM s WHERE parent_schema_oid IS NULL
        UNION ALL
        SELECT s.database_oid, s.database_name, s.oid, p.path || '.' || s.q, list_append(p.parts, s.n)
        FROM s JOIN p ON s.database_oid = p.database_oid AND s.parent_schema_oid = p.oid),
  o AS (SELECT database_oid, schema_oid, table_oid AS oid, table_name AS name, temporary FROM duckdb_tables()
        UNION ALL
        SELECT database_oid, schema_oid, view_oid, view_name, temporary FROM duckdb_views() WHERE NOT internal)`;

const ALL_TABLES_FROM = `FROM o JOIN p ON p.database_oid = o.database_oid AND p.oid = o.schema_oid
JOIN duckdb_columns() c ON c.database_oid = o.database_oid AND c.table_oid = o.oid
GROUP BY ALL ORDER BY database, schema, name`;

// A table listed before its columns were read. A view has to have a column, so it has this one, which
// no listing shows: it lists with none.
const COLUMNS_NOT_READ = '(columns not read yet)';
const REAL_COLUMN = `FILTER (WHERE c.column_name <> ${sqlStr(COLUMNS_NOT_READ)})`;

const SHOW_ALL_TABLES = `${CATALOG_CTES}
SELECT p.database_name AS database, p.path AS schema, o.name,
       coalesce(list(c.column_name ORDER BY c.column_index) ${REAL_COLUMN}, []) AS column_names,
       coalesce(list(c.data_type ORDER BY c.column_index) ${REAL_COLUMN}, []) AS column_types,
       first(o.temporary) AS temporary
${ALL_TABLES_FROM}`;

// The same tables with how many columns each has, for an answer that can't afford the columns.
const ALL_TABLES_COUNTED = `${CATALOG_CTES}
SELECT p.database_name AS database, p.path AS schema, o.name, count(*) ${REAL_COLUMN} AS columns
${ALL_TABLES_FROM}`;

const SHOW_SCHEMAS = `${CATALOG_CTES}
SELECT database_name, path AS schema_name,
       database_name = current_database() AND path = current_schema() AS current
FROM p ORDER BY database_name, schema_name`;

// A dotted name as SQL wrote it -> its parts, quotes undone; null when it is not one.
const PART = new RegExp(`^\\s*(?:"((?:[^"]|"")*)"|([A-Za-z_${LETTERS}][A-Za-z0-9_$${LETTERS}]*))\\s*`);
function dottedParts(text) {
  const parts = [];
  let rest = text;
  for (;;) {
    const m = PART.exec(rest);
    if (!m) return null;
    parts.push(m[1] != null ? m[1].replace(/""/g, '"') : m[2]);
    rest = rest.slice(m[0].length);
    if (!rest) return parts;
    if (rest[0] !== '.') return null;
    rest = rest.slice(1);
  }
}

const withoutComments = sql => scan(String(sql), true).text.trim().replace(/;+\s*$/, '').trim();
const isShowAllTables = sql => /^show\s+all\s+tables$/i.test(withoutComments(sql));

/** The statement that lists the catalog with whole schema paths, or null to run `sql` as it is. */
function catalogStatement(sql) {
  const s = withoutComments(sql);
  if (isShowAllTables(s)) return SHOW_ALL_TABLES;
  if (/^show\s+schemas$/i.test(s)) return SHOW_SCHEMAS;
  // SHOW TABLES FROM catalog.schema…: DuckDB's parser takes two parts at most.
  const from = /^show\s+tables\s+(?:from|in)\s+([\s\S]+)$/i.exec(s);
  const parts = from && dottedParts(from[1]);
  if (!parts || parts.length < 2) return null;
  const [db, ...schema] = parts.map(x => x.toLowerCase());
  return `${CATALOG_CTES}
SELECT o.name FROM o JOIN p ON p.database_oid = o.database_oid AND p.oid = o.schema_oid
WHERE lower(p.database_name) = ${sqlStr(db)}
  AND list_transform(p.parts, lambda x: lower(x)) = [${schema.map(sqlStr).join(', ')}]
ORDER BY o.name`;
}

// A statement that reads the catalog itself, rather than a table: the one that needs every
// table the host has cached to be in it first (engine-host.js syncCatalog).
const CATALOG_READS = /\b(information_schema|pg_catalog|pg_tables|pg_views|pg_class|pg_namespace|duckdb_(tables|views|columns|schemas|databases|constraints|indexes)|show_tables|show_tables_expanded|show_databases)\b/i;
function readsCatalog(sql) {
  const s = scan(String(sql)).text;
  // A SHOW can be a subquery: SELECT * FROM (SHOW ALL TABLES).
  return /\bshow\b/i.test(s) || CATALOG_READS.test(s);
}

module.exports = { sqlStr, quoteIdent, assertReads, checkedRead, tableRefs, fileRefs, filesReadBy, namedError, catalogStatement, isShowAllTables, ALL_TABLES_COUNTED, COLUMNS_NOT_READ, readsCatalog };

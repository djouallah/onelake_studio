'use strict';
// =============================================================================
// sql.js — SQL text helpers for the extension host
// =============================================================================
// The CJS twins of the two helpers in page/paths.js, which is ESM and loads in the
// webview. Both files must agree on what these do — they build the same statements from
// the two sides of the bridge — and each is one line for exactly that reason: the
// definition IS the contract, and anything more would give the copies room to diverge.

// A complete single-quoted SQL literal. Doubling the quote is the whole of DuckDB's
// escaping story for strings.
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

// A double-quoted identifier, for names that came from data rather than from this code.
const quoteIdent = s => `"${String(s).replace(/"/g, '""')}"`;

const { SQL_KINDS, splitItem, isGuid, sqlName, sqlPart, itemPart, ENGINE_DB } = require('./names');
// The engine's own catalogs, other than its database: a name starting with one is DuckDB's, never a workspace's.
const OWN_CATALOGS = new Set(['temp', 'system', 'lake', 'system_internal']);
// A write's own catalog (engine-host.js runWrite): ice_ or delta_ and 16 hex digits, attached for one statement.
const WRITE_CATALOG = '(?:ice|delta)_[0-9a-f]{16}';
const isWriteCatalog = s => new RegExp(`^${WRITE_CATALOG}$`, 'i').test(String(s));
const isOwnCatalog = s => OWN_CATALOGS.has(String(s).toLowerCase()) || isWriteCatalog(s);

// -----------------------------------------------------------------------------
// Read only, enforced where the engine is
// -----------------------------------------------------------------------------
// Every statement the page or the command line sends is checked here, before DuckDB runs it.
//
// What passes as a read: one statement that reads. Nothing else: no COPY, INSERT, UPDATE, DELETE, EXPORT,
// INSTALL, LOAD, SET, CREATE, DROP, ATTACH or DETACH. What a tab sets up to read a file is a host
// method (engine-host.js fileView, attachFile), so no statement can reach another tab's. A statement that
// isn't a read can only be a write to a lakehouse, which has walls of its own (writeOf, checkPhysical), or one of a
// tab's own session (sessionStatementOf).
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
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i = quotedEnd(sql, i);
      if (keep === true || (keep === NAMES && c !== "'")) out.push(sql.slice(start, i));
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
  const first = (/^[\s(]*([A-Za-z_]+)/.exec(text) || [null, ''])[1].toLowerCase();
  if (first !== 'with') return READS.has(first);
  // The statement after the CTEs is the first top-level word that can start one, other than a
  // CTE's own name: `values` is a legal one, bare.
  const words = topLevelWords(text).slice(1);
  const main = words.find((w, i) => STARTS.has(w) && w !== 'with' && words[i + 1] !== 'as');
  return !!main && READS.has(main);
}

// Where the storage secret may go. DuckDB gives a secret to every URL that starts with one of its scopes, and a
// OneLake URL has its workspace before its host (abfss://<workspace>@<host>/), so "any workspace on OneLake" can't
// be said as one prefix. The scope is then a list: OneLake's host for the URLs written host first, which DuckDB's
// own listings answer in, and one prefix for each workspace a URL was handed over in, spelled as it was.
// A URL that starts with none of them gets no token: one on another host, and one put together from pieces.
const ONELAKE_SCOPES = ['abfss://onelake.dfs.fabric.microsoft.com/', 'abfs://onelake.dfs.fabric.microsoft.com/'];
/** The scope a OneLake URL is in, 'abfss://<workspace>@<host>/', or null for any other URL. */
function scopeOfUrl(url) {
  const m = /^(abfss?):\/\/([^/]*)\//i.exec(String(url));
  return m && ONELAKE_HOST.test(m[2].slice(m[2].lastIndexOf('@') + 1)) ? `${m[1]}://${m[2]}/` : null;
}
/** The scopes of the OneLake URLs a statement's text holds, a quote in a workspace's name doubled as SQL writes it. */
function oneLakeScopes(text) {
  const out = new Set();
  for (const [, scheme, authority] of String(text).matchAll(/\b(abfss?):\/\/((?:[^/'"\r\n]|'')*)\//gi)) {
    const scope = scopeOfUrl(`${scheme}://${authority.replace(/''/g, "'")}/`);
    if (scope) out.add(scope);
  }
  return [...out];
}

// What no statement may be is refused with why. A statement that writes goes on to writeOf, below.
const refuse = why => {
  throw new Error(`Not run: ${why}.`);
};

const ONELAKE_HOST = /^(?:[a-z0-9-]+-)?onelake\.(?:dfs|blob)\.fabric\.microsoft\.com$/i;

// The names a write's catalog is attached under (engine-host.js): a lakehouse's Iceberg catalog, or a Delta table.
const ICE_PREFIX = 'ice_';
const DELTA_PREFIX = 'delta_';
const WRITE_CATALOG_NAMED = new RegExp(`\\b${WRITE_CATALOG}\\b`, 'i');

// A path a table's own metadata names, or one about to be asked for with the OneLake token: a URL must be
// OneLake's. The token goes with any abfss:// URL whatever its host, so a log or a manifest that names another
// host would hand it over. A local path (a test's folder, a copy kept here) has no host, and passes.
function assertOneLakeUrl(url) {
  const m = /^([a-z][a-z0-9+.-]+):\/\/([^/?#]*)/i.exec(String(url));
  if (!m || m[1].toLowerCase() === 'file') return url;
  const host = m[2].slice(m[2].lastIndexOf('@') + 1);
  if (!ONELAKE_HOST.test(host)) throw new Error(`${String(url).slice(0, 200)} is not on OneLake, so it is not read`);
  return url;
}

// The statement's text with comments and the insides of quotes gone, or refused: more than one
// statement, an empty one, or Quack.
function oneStatement(sql) {
  const { text, seps } = scan(String(sql));
  if (seps.some(i => text.slice(i + 1).trim() !== '')) refuse('runs one statement at a time');
  refuseCalls(sql);
  const s = text.trim().replace(/;+\s*$/, '').trim();
  if (!s) refuse('this statement is empty');
  return s;
}

// What no SQL here may call or name, whatever kind of statement it is in: refused with why. A statement's own text
// is held to this, and so is the text of a view or a macro kept in a database file someone attached (storedFault).
function refuseCalls(sql) {
  // Quack is how the shared engine's windows reach it, and its functions start, stop and connect
  // servers. Read with the quotes' insides kept, since a function's name can be quoted.
  const kept = scan(String(sql), true).text;
  if (/\bquack_\w+|\bscan_data_from_quack_client\b/i.test(kept)) refuse('Quack is not for statements');
  // The disk cache's switches and the engine's log are the host's, on a server every tab shares.
  if (/\b(?:enable_logging|disable_logging|truncate_duckdb_logs)\b/i.test(kept)) refuse('the engine\'s own switches are not for statements');
  // Each of these writes from a SELECT. Named as a function, a string's insides being gone, so a value can mention one.
  const called = scan(String(sql), NAMES).text;
  // The lake's own functions write, and one deletes files from a SELECT: here those files are OneLake's. Its
  // metadata, system_internal, is read like any table. Called, not named: ducklake_mart can be a schema.
  if (/\bducklake_\w+"?\s*\(/i.test(called)) refuse('the lake is kept by the engine, not by statements');
  // The same functions by their other names: DuckLake has each as <catalog>.fn() too, and the catalog is `lake`.
  if (/(?:^|[^\w$."])"?(?:lake|system_internal)"?(?:\s*\.\s*"?[\w$]+"?)+\s*\(/i.test(called)) refuse('the lake is kept by the engine, not by statements');
  if (/\b(?:write_blob|write_log)"?\s*\(/i.test(called)) refuse('this function writes');
  // query('…' || '…') runs SQL no name above can be found in, DuckDB having joined the text up first.
  // json_execute_serialized_sql runs a statement handed to it as JSON, which is the same thing.
  if (/\b(?:query(?:_table)?|json_execute_serialized_sql)"?\s*\(/i.test(called)) refuse('query() runs what no check here can read');
  // A write's own catalog (engine-host.js runWrite) is attached for that one statement, under a name that is
  // never a statement's to use: it would go around every check on what a write may reach.
  if (WRITE_CATALOG_NAMED.test(called)) refuse('a write\'s catalog is the engine\'s own');
  // A URL on another host is refused here, where it can be said why. One joined up from pieces gets past this,
  // DuckDB joining the text after it, and reads nothing: the secret's scope names no such place (ONELAKE_SCOPES).
  for (const [, authority] of kept.matchAll(/\b(?:abfss?|az|azure):\/\/([^/'"\r\n]*)/gi)) {
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (host.includes('.') && !ONELAKE_HOST.test(host)) refuse(`${host} is not OneLake`);
  }
}

/**
 * Why a view or a macro kept in an attached database file can't be let in, or null. Its text is not in the statement
 * that names it, so no check on a statement reads it: a view that selects from one of the lake's own functions would
 * run it for whoever opens the view. So each one's text is held to what a statement may call.
 */
function storedFault(stored) {
  for (const { kind, schema, name, body } of stored) {
    try { refuseCalls(String(body || '')); }
    catch (e) {
      return `its ${kind} ${[schema, name].filter(Boolean).join('.')} is not one a statement could be: ${String(e.message).replace(/^Not run: /, '')}`;
    }
  }
  return null;
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

/** Whether `sql` is one statement that reads. Throws for what no statement may be at all (Quack, the lake's functions). */
function readsOnly(sql) {
  return readsOrExplains(oneStatement(sql));
}

// -----------------------------------------------------------------------------
// Writes: to a lakehouse
// -----------------------------------------------------------------------------
// A statement that doesn't read can write to a lakehouse, and to nothing else: its Tables, through
// DuckDB's own Iceberg writer (an Iceberg table, or a new one), and its Files/, through COPY … TO. The
// statements are DuckDB-Iceberg's own, less DROP, which is blocked for now.
//
// There are two walls here too. writeOf reads the text, to find what the statement writes and where,
// and refuses everything else at once. checkPhysical then holds DuckDB's own plan of the statement as it
// will run (EXPLAIN (FORMAT json), on the connection that runs it) to the same kind of write, with no
// other write anywhere in it.

// Every token of `sql` with where it is, comments gone: a word, a quoted name, a string, a punctuation
// mark, each at the depth of the parentheses it is in.
function tokens(sql) {
  const s = String(sql), n = s.length, out = [];
  let depth = 0, i = 0;
  while (i < n) {
    const c = s[i];
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const end = quotedEnd(s, i);
      out.push({ t: c === "'" ? 'str' : 'name', v: s.slice(i + 1, end - 1).split(c + c).join(c), start: i, end, depth });
      i = end;
      continue;
    }
    if (c === '$') {
      const end = dollarEnd(s, i);
      if (end !== -1) { out.push({ t: 'str', v: null, start: i, end, depth }); i = end; continue; }
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(s);
    if (m) { out.push({ t: 'word', v: m[0], w: m[0].toLowerCase(), start: i, end: IDENT.lastIndex, depth }); i = IDENT.lastIndex; continue; }
    if (c === ')') depth = Math.max(0, depth - 1);
    out.push({ t: c, start: i, end: i + 1, depth });
    if (c === '(') depth++;
    i++;
  }
  return out;
}

const notRun = refuse;
const TABLE_SHAPE = 'a write goes to a lakehouse table: <workspace>.<lakehouse>.<schema>.<table>';
const SCHEMA_SHAPE = 'a schema is made in a lakehouse: <workspace>.<lakehouse>.<schema>';
const FILE_SHAPE = "COPY writes to a lakehouse's Files/: TO '<workspace>.<lakehouse>/Files/<path>'";

/**
 * What one statement writes, and where, by its text: { what, plan, target: 'table' | 'schema' | 'file', ref, start,
 * end }. `ref` is { workspace, item, schema, table } for a table, without `table` for a schema, and for a file
 * { workspace, item, path, written }; start and end are where the target is written, to be named again there.
 * Throws for anything that is neither a read nor one of these writes.
 * @param {string} sql
 */
function writeOf(sql) {
  oneStatement(sql);
  const tk = tokens(sql).filter(t => t.t !== ';');
  const w = k => (tk[k] && tk[k].t === 'word' ? tk[k].w : '');
  // The statement after a WITH's CTEs: the first top-level word that can start one, other than a CTE's name.
  let k = 0;
  if (w(0) === 'with') {
    k = tk.findIndex((t, j) => j > 0 && t.depth === 0 && t.t === 'word' && STARTS.has(t.w) && t.w !== 'with' && w(j + 1) !== 'as');
    if (k < 0) notRun('this statement reads as neither a read nor a write');
  }
  const verb = w(k);
  const VERB = (tk[k] && tk[k].v ? tk[k].v : 'this').toUpperCase();
  // DROP TABLE is a write (engine-host.js lets it run only when Allow Drop Table is on); no other DROP is.
  if (verb === 'drop' && w(k + 1) !== 'table') notRun('DROP is blocked: only DROP TABLE drops anything, and no schema is dropped');
  if (verb === 'truncate') notRun("TRUNCATE isn't one of DuckDB's Iceberg writes");
  if (!['insert', 'update', 'delete', 'merge', 'create', 'alter', 'copy', 'drop'].includes(verb)) {
    notRun(`${VERB} is not a read, nor one of the writes to a lakehouse`);
  }
  const topWord = word => tk.some((t, j) => j > k && t.depth === 0 && t.t === 'word' && t.w === word);
  // A dotted name from token `at`: its parts, quotes undone, and where it is written.
  const nameAt = at => {
    const parts = [];
    let j = at;
    for (;;) {
      const t = tk[j];
      if (!t || (t.t !== 'word' && t.t !== 'name')) break;
      parts.push(t.v);
      if (!tk[j + 1] || tk[j + 1].t !== '.') { j++; break; }
      j += 2;
    }
    if (!parts.length) return null;
    return { parts, start: tk[at].start, end: tk[j - 1].end };
  };
  const ifWords = (at, words) => words.every((x, i) => w(at + i) === x) ? at + words.length : at;
  const table = at => {
    const n = nameAt(at);
    if (!n) notRun(TABLE_SHAPE);
    const p = n.parts;
    const old = oldName(p);
    if (old) notRun(old);
    if (isOwnCatalog(p[0]) || p[0].toLowerCase() === ENGINE_DB) notRun(`${p[0]} is the engine's own, not a lakehouse: ${TABLE_SHAPE}`);
    if (p.length !== 4) notRun(TABLE_SHAPE);
    if (splitItem(p[1])) notRun(`a write goes to a lakehouse only, and ${p[1]} is read only here`);
    return { target: 'table', ref: { workspace: p[0], item: p[1], schema: p[2], table: p[3] }, start: n.start, end: n.end };
  };
  const schema = at => {
    const n = nameAt(at);
    const p = n ? n.parts : [];
    const kind = p.length === 4 && SQL_KINDS.find(x => x === p[0].toLowerCase());
    if (kind) notRun(`${p.map(sqlPart).join('.')} is the old way to name a schema: it is ${[p[1], kind === 'lakehouse' ? p[2] : `${p[2]}_${kind}`, p[3]].map(sqlPart).join('.')} now`);
    if (p.length !== 3 || isOwnCatalog(p[0]) || p[0].toLowerCase() === ENGINE_DB) notRun(SCHEMA_SHAPE);
    if (splitItem(p[1])) notRun(`a schema is made in a lakehouse only, and ${p[1]} is read only here`);
    return { target: 'schema', ref: { workspace: p[0], item: p[1], schema: p[2] }, start: n.start, end: n.end };
  };
  const as = (what, found) => ({ what, ...found });

  if (verb === 'insert') {
    if (w(k + 1) === 'or') notRun(`INSERT OR ${(tk[k + 2] && tk[k + 2].v || '').toUpperCase()} isn't one of DuckDB's Iceberg writes`);
    if (w(k + 1) !== 'into') notRun('INSERT is written INSERT INTO <table>');
    if (topWord('conflict')) notRun("ON CONFLICT isn't one of DuckDB's Iceberg writes");
    return as('insert', table(k + 2));
  }
  if (verb === 'update') return as('update', table(k + 1));
  if (verb === 'delete') {
    if (w(k + 1) !== 'from') notRun('DELETE is written DELETE FROM <table>');
    return as('delete', table(k + 2));
  }
  if (verb === 'merge') {
    if (w(k + 1) !== 'into') notRun('MERGE is written MERGE INTO <table>');
    return as('merge', table(k + 2));
  }
  if (verb === 'alter') {
    if (w(k + 1) !== 'table') notRun(`ALTER ${(tk[k + 1] && tk[k + 1].v || '').toUpperCase()} isn't a write to a lakehouse: only ALTER TABLE is`);
    return as('alter', table(ifWords(k + 2, ['if', 'exists'])));
  }
  if (verb === 'drop') return as('drop table', table(ifWords(k + 2, ['if', 'exists'])));
  if (verb === 'create') {
    if (w(k + 1) === 'or') notRun("CREATE OR REPLACE isn't one of DuckDB's Iceberg writes");
    if (['temp', 'temporary'].includes(w(k + 1))) notRun('a temporary table is not in a lakehouse');
    if (w(k + 1) === 'table') return as('create table', table(ifWords(k + 2, ['if', 'not', 'exists'])));
    if (w(k + 1) === 'schema') return as('create schema', schema(ifWords(k + 2, ['if', 'not', 'exists'])));
    notRun(`CREATE ${(tk[k + 1] && tk[k + 1].v || '').toUpperCase()} isn't a write to a lakehouse: only CREATE TABLE and CREATE SCHEMA are`);
  }
  // COPY (query) TO 'file', or COPY table TO 'file'. COPY … FROM loads a table, which DuckDB-Iceberg doesn't.
  let j = k + 1;
  if (tk[j] && tk[j].t === '(') {
    const depth = tk[j].depth;
    j = tk.findIndex((t, x) => x > j && t.t === ')' && t.depth === depth) + 1;
    if (j <= 0) notRun(FILE_SHAPE);
  } else {
    const n = nameAt(j);
    if (!n) notRun(FILE_SHAPE);
    while (tk[j] && tk[j].end <= n.end) j++;
    // A table's column list, COPY t (a, b) TO.
    if (tk[j] && tk[j].t === '(') {
      const depth = tk[j].depth;
      j = tk.findIndex((t, x) => x > j && t.t === ')' && t.depth === depth) + 1;
    }
  }
  if (w(j) === 'from') notRun("COPY … FROM loads a table, which isn't one of DuckDB's Iceberg writes");
  if (w(j) !== 'to' || !tk[j + 1] || tk[j + 1].t !== 'str' || tk[j + 1].v == null) notRun(FILE_SHAPE);
  const to = tk[j + 1];
  let file;
  try { file = fileName(to.v); }
  catch (e) { notRun(e.message); }
  if (!file || file.zip) notRun(FILE_SHAPE);
  return as('copy', { target: 'file', ref: file, start: to.start, end: to.end });
}

// A lakehouse table's Parquet, as Direct Lake reads it fastest: a row group closes at 4M rows or 1 GiB uncompressed,
// whichever comes first (DuckDB's own cap is 128 MB, about 800K rows of a 17-column table), a file at the first row
// group past 1 GiB (never under the row group's budget, or row groups shrink to it), and 1 MB pages, not one page a
// column chunk. Iceberg table properties, read when the table's files are written: so given at CREATE, a CTAS's rows
// included. https://djouallah.github.io/direct-lake-parquet-layout/writers.html#duckdb
const TABLE_PROPERTIES = Object.freeze({
  'write.parquet.row-group-size': '4000000',
  'write.parquet.row-group-size-bytes': '1073741824',
  'write.target-file-size-bytes': '1073741824',
  'write.parquet.page-size-bytes': '1048576',
});

/**
 * A CREATE TABLE's text with TABLE_PROPERTIES in its WITH (…): one after its name and its column list, or in the
 * WITH it has, each it doesn't set itself. Every other statement as it is.
 * @param {string} sql
 */
function withTableProperties(sql, props = TABLE_PROPERTIES) {
  const w = writeOf(sql);
  if (w.what !== 'create table') return sql;
  const tk = tokens(sql);
  const closing = at => tk.findIndex((t, x) => x > at && t.t === ')' && t.depth === tk[at].depth);
  let j = tk.findIndex(t => t.start >= w.end);
  if (j < 0) j = tk.length;
  // Its column list, CREATE TABLE t (i INTEGER, …).
  if (tk[j] && tk[j].t === '(') {
    const close = closing(j);
    if (close < 0) return sql;
    j = close + 1;
  }
  const entry = ([k, v]) => `${sqlStr(k)} = ${sqlStr(v)}`;
  if (tk[j] && tk[j].t === 'word' && tk[j].w === 'with' && tk[j + 1] && tk[j + 1].t === '(') {
    const close = closing(j + 1);
    if (close < 0) return sql;
    // What it sets itself: each key, a string or a name before its '='.
    const set = new Set();
    for (let x = j + 2; x < close; x++) {
      if (tk[x].depth === tk[j + 1].depth + 1 && tk[x + 1] && tk[x + 1].t === '=' && tk[x].v != null) set.add(String(tk[x].v).toLowerCase());
    }
    const add = Object.entries(props).filter(([k]) => !set.has(k));
    if (!add.length) return sql;
    const at = tk[close].start;
    return sql.slice(0, at) + (close === j + 2 ? '' : ', ') + add.map(entry).join(', ') + sql.slice(at);
  }
  const at = j < tk.length ? tk[j].start : sql.length;
  const clause = `WITH (${Object.entries(props).map(entry).join(', ')})`;
  return `${sql.slice(0, at).replace(/\s+$/, '')} ${clause}${j < tk.length ? ' ' : ''}${sql.slice(at)}`;
}

// What each write is in DuckDB's physical plan of it (EXPLAIN (FORMAT json)), which plans it as it will run and
// runs nothing: the operator at its root, and the lake's own writes it may hold. DuckDB-Iceberg adds a table's rows
// with ICEBERG_INSERT (a CTAS's over the copy that makes the table, IcebergCatalog::PlanCreateTableAs) and marks them
// deleted with ICEBERG_UPDATE or ICEBERG_DELETE; the delta extension adds them with DELTA_INSERT. A schema, a table
// with no rows, an ALTER and a DROP are DuckDB's own operators, whatever the catalog, and a COPY is its COPY_TO_FILE.
// None of them says which catalog or file: the text does. No statement may name a write's catalog (oneStatement), so
// the only one it can bind is the one engine-host.js named in it, and a COPY's file is the URL engine-host.js put in.
const COPIES = ['COPY_TO_FILE', 'BATCH_COPY_TO_FILE'];
const SHAPES = {
  iceberg: {
    'create schema': { roots: ['CREATE_SCHEMA'] },
    'create table': { roots: ['CREATE_TABLE', 'ICEBERG_INSERT'], lake: true },
    alter: { roots: ['ALTER'] },
    'drop table': { roots: ['DROP'] },
    insert: { roots: ['ICEBERG_INSERT'], lake: true },
    // An UPDATE writes its rows anew (ICEBERG_INSERT, over the ICEBERG_UPDATE that marks the old ones deleted), or
    // marks them alone; a DELETE marks them; a MERGE does any of those under its MERGE_INTO.
    update: { roots: ['ICEBERG_INSERT', 'ICEBERG_UPDATE'], lake: true, has: 'ICEBERG_UPDATE' },
    delete: { roots: ['ICEBERG_DELETE'], lake: true },
    merge: { roots: ['MERGE_INTO'], lake: true },
    copy: { roots: COPIES },
  },
  delta: { insert: { roots: ['DELTA_INSERT'], lake: true } },
};
const LAKE_WRITES = { iceberg: new Set(['ICEBERG_INSERT', 'ICEBERG_UPDATE', 'ICEBERG_DELETE']), delta: new Set(['DELTA_INSERT']) };
// Every operator that writes: DuckDB's own, to a table, a schema, a file or another database, and every extension's.
// DuckDB-Iceberg's copy under a CTAS is `CREATE TABLE & COPY TO FILE`.
const WRITES = /^(?:BATCH_)?(?:INSERT|UPDATE|DELETE|MERGE_INTO|COPY_TO_FILE|CREATE_TABLE_AS)$|^(?:CREATE|DROP|ALTER|ATTACH|DETACH|EXPORT|VACUUM|CHECKPOINT)(?:_|$)|^(?:ICEBERG|DELTA|DUCKLAKE)_(?!SCAN)|COPY TO FILE/;
// A lake write writes its rows' files with a copy of its own, under it.
const LAKE_COPIES = new Set([...COPIES, 'CREATE TABLE & COPY TO FILE']);

/**
 * Holds DuckDB's physical plan of a write (EXPLAIN (FORMAT json), parsed) to what writeOf read in its text, `what`.
 * `delta`: the write goes to a Delta table, through the delta extension. Throws, saying why, for anything else.
 */
function checkPhysical(tree, what, { delta = false } = {}) {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (roots.length !== 1 || !roots[0]) notRun('DuckDB plans this as more than one statement');
  const shape = SHAPES[delta ? 'delta' : 'iceberg'][what];
  if (!shape) notRun(`DuckDB can't ${what === 'drop table' ? 'drop' : String(what).toUpperCase()} a Delta table`);
  const root = String(roots[0].name || '');
  if (!shape.roots.includes(root)) notRun(`DuckDB plans this as ${root}, not ${shape.roots.join(' or ')}`);
  const lake = shape.lake ? LAKE_WRITES[delta ? 'delta' : 'iceberg'] : new Set();
  const writes = [];
  const walk = (n, under) => {
    const name = String(n.name || '');
    if (lake.has(name)) writes.push(name);
    else if (WRITES.test(name) && n !== roots[0] && !(under && LAKE_COPIES.has(name))) {
      notRun(`DuckDB plans a ${name} in this, which isn't the write it names`);
    }
    for (const c of n.children || []) walk(c, under || lake.has(name));
  };
  walk(roots[0], false);
  if (shape.lake && root !== 'CREATE_TABLE' && !writes.length) notRun(`DuckDB's plan of this writes no ${delta ? 'Delta' : 'Iceberg'} table`);
  if (shape.has && !writes.includes(shape.has)) notRun(`DuckDB's plan of this has no ${shape.has}`);
}

// -----------------------------------------------------------------------------
// A tab's own session: its variables, and its temporary tables and views
// -----------------------------------------------------------------------------
// A tab runs its statements on one DuckDB session of its own (engine-host.js tabSession), so what DuckDB keeps on a
// connection is the tab's, as in any DuckDB session: SET VARIABLE (read with getvariable() or $name), and TEMP tables
// and views. None of it is OneLake's or a file: a temporary object is in the session's own `temp` catalog. What such
// a statement reads is held to every check a read is: its text here (oneStatement), its query by DuckDB's parser
// (checkedRead, in engine-host.js), and DuckDB's physical plan of it to the one write it is (checkTempPhysical).

// A name as a session statement gives one: bare, or in the temp catalog (temp.x, temp.main.x). Its parts and where
// it ends, or null.
function tempNameAt(tk, at) {
  const parts = [];
  let j = at;
  for (;;) {
    const t = tk[j];
    if (!t || (t.t !== 'word' && t.t !== 'name')) break;
    parts.push(t.v);
    if (!tk[j + 1] || tk[j + 1].t !== '.') { j++; break; }
    j += 2;
  }
  if (!parts.length) return null;
  const qualified = parts.length > 1;
  const temp = qualified && String(parts[0]).toLowerCase() === 'temp' && (parts.length === 2 || (parts.length === 3 && String(parts[1]).toLowerCase() === 'main'));
  if (qualified && !temp) return null;
  return { name: parts[parts.length - 1], qualified, next: j };
}

/**
 * What one statement does to a tab's own session, or null for any other statement:
 *   { kind: 'set variable', name, value }        `value`: the expression, as written, comments gone
 *   { kind: 'reset variable', name }
 *   { kind: 'temp', what, name, query }           what: create table, create view, insert, update, delete, drop
 * `query`: where the read a CREATE TEMP … AS or an INSERT … SELECT takes is, { start, end } in `sql`, or null.
 * `isTemp(name)`: whether the session holds a temporary table or view of that name, which is what an INSERT, an
 * UPDATE, a DELETE or a DROP of a bare name must name: anything else is a lakehouse's (writeOf).
 */
function sessionStatementOf(sql, isTemp = () => false) {
  oneStatement(sql);
  const tk = tokens(sql).filter(t => t.t !== ';');
  const w = k => (tk[k] && tk[k].t === 'word' ? tk[k].w : '');
  const rest = k => (tk[k] ? { start: tk[k].start, end: sql.replace(/[\s;]+$/, '').length } : null);
  const named = k => (tk[k] && (tk[k].t === 'word' || tk[k].t === 'name') ? tk[k].v : null);

  if ((w(0) === 'set' || w(0) === 'reset') && w(1) === 'variable') {
    const name = named(2);
    if (name == null) refuse(`${w(0).toUpperCase()} VARIABLE names a variable`);
    if (w(0) === 'reset') {
      if (tk.length !== 3) refuse('RESET VARIABLE names one variable');
      return { kind: 'reset variable', name };
    }
    if (!tk[3] || !(tk[3].t === '=' || w(3) === 'to') || !tk[4]) refuse('SET VARIABLE is written SET VARIABLE <name> = <value>');
    const r = rest(4);
    const value = withoutComments(sql.slice(r.start, r.end)).trim();
    return { kind: 'set variable', name, value };
  }

  const temp = (what, n, query = null) => ({ kind: 'temp', what, name: n.name, query });
  if (w(0) === 'create') {
    let k = 1;
    if (w(k) === 'or' && w(k + 1) === 'replace') k += 2;
    if (w(k) !== 'temp' && w(k) !== 'temporary') return null;
    k++;
    const kind = w(k);
    if (kind !== 'table' && kind !== 'view') refuse(`CREATE TEMP ${String(named(k) || '').toUpperCase()} isn't one of a tab's own: only a TEMP TABLE or a TEMP VIEW is`);
    k++;
    if (w(k) === 'if' && w(k + 1) === 'not' && w(k + 2) === 'exists') k += 3;
    const n = tempNameAt(tk, k);
    if (!n) refuse('a temporary table or view is named by its name alone, or temp.<name>');
    k = n.next;
    // A column list: a table's columns, or a view's names for them.
    if (tk[k] && tk[k].t === '(') {
      const depth = tk[k].depth;
      k = tk.findIndex((t, x) => x > k && t.t === ')' && t.depth === depth) + 1;
      if (k <= 0) refuse('a column list ends with )');
    }
    if (w(k) === 'as') return temp(`create ${kind}`, n, rest(k + 1));
    if (kind === 'view' || tk[k]) refuse(`CREATE TEMP ${kind.toUpperCase()} is written … AS <query>${kind === 'table' ? ', or with its columns' : ''}`);
    return temp('create table', n);
  }

  // A write to one of the session's own: by a temp. name, or a bare one the session holds.
  const own = k => {
    const n = tempNameAt(tk, k);
    return n && (n.qualified || isTemp(n.name)) ? n : null;
  };
  if (w(0) === 'insert' && w(1) === 'into') {
    const n = own(2);
    if (!n) return null;
    let k = n.next;
    if (tk[k] && tk[k].t === '(') {
      const depth = tk[k].depth;
      k = tk.findIndex((t, x) => x > k && t.t === ')' && t.depth === depth) + 1;
      if (k <= 0) refuse('a column list ends with )');
    }
    if (w(k) === 'by' && (w(k + 1) === 'name' || w(k + 1) === 'position')) k += 2;
    if (w(k) === 'default' && w(k + 1) === 'values') return temp('insert', n);
    return temp('insert', n, rest(k));
  }
  if (w(0) === 'update') {
    const n = own(1);
    return n ? temp('update', n) : null;
  }
  if (w(0) === 'delete' && w(1) === 'from') {
    const n = own(2);
    return n ? temp('delete', n) : null;
  }
  if (w(0) === 'drop' && (w(1) === 'table' || w(1) === 'view')) {
    const k = w(2) === 'if' && w(3) === 'exists' ? 4 : 2;
    const n = own(k);
    return n ? temp('drop', n) : null;
  }
  return null;
}

// DuckDB's own operators for a write to the session's temp catalog, and no write anywhere else in it.
const TEMP_ROOTS = {
  'set variable': ['SET_VARIABLE'],
  'create table': ['CREATE_TABLE', 'CREATE_TABLE_AS', 'BATCH_CREATE_TABLE_AS'],
  'create view': ['CREATE_VIEW'],
  insert: ['INSERT', 'BATCH_INSERT'],
  update: ['UPDATE'],
  delete: ['DELETE'],
  drop: ['DROP'],
};
/** Holds DuckDB's physical plan of a session's write (EXPLAIN (FORMAT json), parsed) to the one write it is. */
function checkTempPhysical(tree, what) {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (roots.length !== 1 || !roots[0]) notRun('DuckDB plans this as more than one statement');
  const root = String(roots[0].name || '');
  if (!(TEMP_ROOTS[what] || []).includes(root)) notRun(`DuckDB plans this as ${root}, not ${(TEMP_ROOTS[what] || ['a write to this tab']).join(' or ')}`);
  const below = n => (n.children || []).forEach(c => {
    const name = String(c.name || '');
    if (WRITES.test(name)) notRun(`DuckDB plans a ${name} in this, which isn't the write it names`);
    below(c);
  });
  below(roots[0]);
}

/** The statements of `sql`, as their text, in order: split where DuckDB would split them, empty ones left out. */
// Each piece is still one statement to every check after this, which says so if it isn't.
function statementsOf(sql) {
  const s = String(sql);
  const out = [];
  let from = 0;
  for (let i = 0, n = s.length; i < n;) {
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') { i = quotedEnd(s, i); continue; }
    if (s[i] === '$') { const end = dollarEnd(s, i); if (end !== -1) { i = end; continue; } }
    if (s[i] === ';') { out.push(s.slice(from, i)); from = i + 1; }
    i++;
  }
  out.push(s.slice(from));
  return out.filter(x => scan(x).text.trim() !== '').map(x => x.trim());
}

// -----------------------------------------------------------------------------
// The OneLake tables a statement names
// -----------------------------------------------------------------------------
// Every dotted name of four or more parts, workspace.item.schema.table, as { kind, workspace, item,
// schema, table }, the rest as written, quotes undone:
//   - an item ending in _<kind> (gold_warehouse; names.js SUFFIXED_KINDS, any case) is that kind, and
//     `asLakehouse` is the part whole, for a lakehouse that happens to be named so;
//   - any other item is a lakehouse, and `bare` says the name may not be OneLake's at all (a struct's
//     field, s.a.b.c): the engine reads it as a table only in a workspace it knows;
//   - first two parts that are GUIDs, the workspace's and the item's: { byGuid: true, kind: null, … }.
// A fifth part on is a column of that table, and `onelake.` in front is the engine's database, which the
// name is in. A name starting with another of the engine's catalogs is DuckDB's. Comments and string
// literals are skipped, so a name in either is not a table. Any statement: a SELECT, a DESCRIBE, an
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
// Every dotted name in `sql`, each as its parts with quotes undone.
function dottedNames(sql) {
  const s = String(sql);
  const n = s.length;
  const out = [];
  let i = 0;
  // DuckDB quotes a name in double quotes, or in backticks as Spark does.
  const startsIdent = j => s[j] === '"' || s[j] === '`' || (IDENT.lastIndex = j, IDENT.test(s));
  const ident = () => {
    if (s[i] === '"' || s[i] === '`') {
      const q = s[i];
      let v = '';
      i++;
      while (i < n) {
        if (s[i] === q) {
          if (s[i + 1] === q) { v += q; i += 2; continue; }
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
    out.push(parts);
  }
  return out;
}
function tableRefs(sql) {
  const out = [];
  for (const all of dottedNames(sql)) {
    const parts = all.length >= 5 && all[0].toLowerCase() === ENGINE_DB ? all.slice(1) : all;
    if (parts.length < 4 || isOwnCatalog(parts[0]) || oldName(all)) continue;
    const [workspace, item, schema, table] = parts;
    if (isGuid(workspace) && isGuid(item)) { out.push({ byGuid: true, kind: null, workspace, item, schema, table }); continue; }
    const it = splitItem(item);
    out.push(it ? { kind: it.kind, workspace, item: it.item, schema, table, asLakehouse: item }
                : { kind: 'lakehouse', workspace, item, schema, table, bare: true });
  }
  return out;
}
// A table named as it was before, kind.workspace.item.schema.table: why it is not one now, with how it is
// written, or null.
function oldName(parts) {
  const kind = parts.length >= 5 && SQL_KINDS.find(k => k === String(parts[0]).toLowerCase());
  if (!kind || splitItem(parts[1])) return null;
  return `${parts.slice(0, 5).map(sqlPart).join('.')} is the old way to name a table: it is ` +
    `${sqlName({ kind, workspace: parts[1], item: parts[2], schema: parts[3], table: parts[4] })} now`;
}
// The first table `sql` names the old way, as oldName says it, or null.
function oldTableName(sql) {
  for (const parts of dottedNames(sql)) {
    const why = oldName(parts);
    if (why) return why;
  }
  return null;
}

// -----------------------------------------------------------------------------
// The files a statement names
// -----------------------------------------------------------------------------
// A file is '<workspace>.<lakehouse>/Files/<path>' (docs/NAMING.md). DuckDB can't read that, so
// the engine gives it the file's abfss:// URL. A string that looks like one is only a file where SQL
// reads a file: after FROM or JOIN (or a comma among them), after DESCRIBE, SUMMARIZE or PIVOT, or as
// the first argument of a table function, alone or in a list. Anywhere else it is a value.
//
// A name that is wrong throws rather than going to DuckDB, which would look for it on the local disk,
// and glob() would answer no rows with no error. A string with no dotted name before its first '/'
// is not one: 'data/x.parquet', 'x.parquet'.
const READS_FROM = new Set(['from', 'join', 'lateral', 'describe', 'desc', 'summarize', 'pivot', 'unpivot']);
const NOT_FROM = new Set(['select', 'where', 'group', 'having', 'qualify', 'order', 'limit', 'offset', 'window',
                          'union', 'intersect', 'except', 'values']);
const FILE_PART = new RegExp(`"((?:[^"]|"")*)"|\`((?:[^\`]|\`\`)*)\`|([A-Za-z_${LETTERS}][A-Za-z0-9_$${LETTERS}]*)`, 'y');

function fileName(value, kinds = SQL_KINDS) {
  const zip = /^zip:\/\//i.test(value) ? value.slice(0, 6) : '';
  const text = value.slice(zip.length);
  const parts = [];
  let i = 0;
  for (;;) {
    FILE_PART.lastIndex = i;
    const m = FILE_PART.exec(text);
    if (!m) break;
    parts.push(m[1] != null ? m[1].replace(/""/g, '"') : m[2] != null ? m[2].replace(/``/g, '`') : m[3]);
    i = FILE_PART.lastIndex;
    if (text[i] !== '.') break;
    i++;
  }
  // Meant as a OneLake file: a name with a dot in it, then /Files or /Tables, however wrong the name is;
  // or two parts, ws.lh, then any path. Any other string is DuckDB's to read.
  const rest = text.slice(i);
  const meant = (parts.length && /^[^/]*\/(?:Files|Tables)(?:\/|$)/i.test(rest) && (parts.length >= 2 || `${text.slice(0, i)}${rest.split('/')[0]}`.includes('.')))
    || (parts.length === 2 && text[i] === '/' && !isOwnCatalog(parts[0]));
  if (!meant) return null;
  const wrong = why => new Error(`'${value}': ${why}`);
  const shape = "a file's name is <workspace>.<lakehouse>/Files/<path>, with a part that isn't a plain name in double quotes";
  const oldKind = parts.length === 3 && text[i] === '/' && kinds.find(k => k.toLowerCase() === parts[0].toLowerCase());
  if (oldKind && oldKind !== 'lakehouse') throw wrong('only a lakehouse has Files/');
  if (oldKind) throw wrong(`this is the old way to name a file: it is '${[parts[1], parts[2]].map(sqlPart).join('.')}${rest}' now`);
  if (parts.length !== 2 || text[i] !== '/') throw wrong(shape);
  if (splitItem(parts[1])) throw wrong('only a lakehouse has Files/');
  const path = rest;
  if (/^\/Tables(\/|$)/.test(path)) throw wrong(`a table's name is ${text.slice(0, i)}.<schema>.<table>`);
  if (!/^\/Files(\/|$)/.test(path)) throw wrong(shape);
  if (path.split('/').some(s => s === '.' || s === '..')) throw wrong("a file's path can't hold . or ..");
  return { zip, workspace: parts[0], item: parts[1], path, written: `${text.slice(0, i)}/Files` };
}

/**
 * The file names `sql` reads, in order, each with where its string is. Throws on one that is wrong.
 * @returns {{start: number, end: number, quote: string, zip: string, workspace: string, item: string, path: string, written: string}[]}
 */
function fileRefs(sql, kinds = SQL_KINDS) {
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
    if (c === "'" || c === '"' || c === '`') {
      const end = quotedEnd(s, i);
      const text = s.slice(i + 1, end - 1);
      const ref = readsFile() ? fileName(text.split(c + c).join(c), kinds) : null;
      if (ref) refs.push({ ...ref, start: i, end, quote: c });
      // A quoted name is a name, never a keyword.
      if (c !== "'" && prev !== '.') beforeName = prev;
      prev = c;
      word = c !== "'";
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

// DuckDB's error on a statement with its files' URLs in it, as the statement was written. `written` is
// [{ url, name }]. Its caret moves with the text, since the page finds that line in what was written.
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
// a part quoted where SQL must quote it — so `onelake` + `ws.lh.dbo` + `t` is the name
// a query reads, with or without its catalog. Every other statement runs as written.
const CATALOG_CTES = `WITH RECURSIVE
  kw AS (SELECT keyword_name AS w FROM duckdb_keywords() WHERE keyword_category IN ('reserved', 'type_function')),
  s AS (SELECT database_oid, database_name, oid, schema_name AS n, parent_schema_oid,
               CASE WHEN regexp_full_match(schema_name, '[A-Za-z_][A-Za-z0-9_]*') AND lower(schema_name) NOT IN (SELECT w FROM kw)
                    THEN schema_name ELSE '"' || replace(schema_name, '"', '""') || '"' END AS q
        FROM duckdb_schemas()
        -- The lake (engine-host.js): the engine's own copy of each OneLake table, by a hash of its folder. What a
        -- query names is the table's own name; these are how it is read. Its metadata, system_internal, is listed.
        -- Nor a write's own catalog, there for that one statement (engine-host.js runWrite), nor DuckDB's own
        -- system and temp: what is listed is OneLake's, the lake's metadata, and a database file a tab opened.
        WHERE database_name NOT IN ('lake', 'system', 'temp') AND NOT regexp_full_match(database_name, '${WRITE_CATALOG}')),
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

// The databases a user names: OneLake's, the lake's metadata, and a database file a tab opened; not the lake,
// DuckDB's own, or a write's catalog.
const SHOW_DATABASES = `SELECT database_name FROM duckdb_databases()
WHERE NOT internal AND database_name NOT IN ('lake', 'system', 'temp') AND NOT regexp_full_match(database_name, '${WRITE_CATALOG}')
ORDER BY database_name = '${ENGINE_DB}' DESC, database_name`;

// A dotted name as SQL wrote it -> its parts, quotes undone; null when it is not one.
const PART = new RegExp(`^\\s*(?:"((?:[^"]|"")*)"|\`((?:[^\`]|\`\`)*)\`|([A-Za-z_${LETTERS}][A-Za-z0-9_$${LETTERS}]*))\\s*`);
function dottedParts(text) {
  const parts = [];
  let rest = text;
  for (;;) {
    const m = PART.exec(rest);
    if (!m) return null;
    parts.push(m[1] != null ? m[1].replace(/""/g, '"') : m[2] != null ? m[2].replace(/``/g, '`') : m[3]);
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
  if (/^show\s+databases$/i.test(s)) return SHOW_DATABASES;
  // SHOW TABLES FROM [catalog.]schema…: DuckDB's parser takes two parts at most. An item's schema,
  // ws.lh.dbo, is in the engine's own catalog, and is written without it.
  const from = /^show\s+tables\s+(?:from|in)\s+([\s\S]+)$/i.exec(s);
  const parts = from && dottedParts(from[1]);
  if (!parts || parts.length < 2) return null;
  const all = parts.map(x => x.toLowerCase());
  const [db, ...schema] = all;
  const list = xs => `[${xs.map(sqlStr).join(', ')}]`;
  return `${CATALOG_CTES}
SELECT o.name FROM o JOIN p ON p.database_oid = o.database_oid AND p.oid = o.schema_oid
WHERE (lower(p.database_name) = ${sqlStr(db)} AND list_transform(p.parts, lambda x: lower(x)) = ${list(schema)})
   OR (p.database_name = current_database() AND list_transform(p.parts, lambda x: lower(x)) = ${list(all)})
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

// -----------------------------------------------------------------------------
// USE: the schema a tab's bare table names are in
// -----------------------------------------------------------------------------
// `USE aemo.data.dbo`, then `SELECT * FROM dim_duid`, as Fabric's Spark takes it. DuckDB 2.0 can't: a nested
// schema can't be in its search path ("nested schemas cannot be used in the search path"), and each statement
// here has a connection of its own anyway. So the engine keeps the schema for the tab, and gives each bare name
// its whole name before the statement runs: DuckDB's own parser says where they are (json_serialize_sql).
const USE_SHAPE = "USE takes a lakehouse's or a warehouse's schema: USE <workspace>.<lakehouse>.<schema>, or " +
  'USE <workspace>.<lakehouse> for its dbo';
// The schemas DuckDB keeps in every catalog: never a workspace's name a statement can reach (engine-host.js).
const DUCKDB_SCHEMAS = new Set(['main', 'pg_catalog', 'information_schema']);

/**
 * What a USE asks: null for any other statement; { clear: true } for USE onelake or USE main, which go back to
 * the engine's own; else the schema, { workspace, item, kind, schema }, as written. Throws for any other USE.
 * @param {string} sql
 */
function useOf(sql) {
  const tk = tokens(String(sql)).filter(t => t.t !== ';');
  if (!tk.length || tk[0].t !== 'word' || tk[0].w !== 'use') return null;
  oneStatement(sql);
  const parts = [];
  for (let j = 1; ; j += 2) {
    const t = tk[j];
    if (!t || (t.t !== 'word' && t.t !== 'name')) refuse(USE_SHAPE);
    parts.push(t.v);
    if (!tk[j + 1]) break;
    if (tk[j + 1].t !== '.') refuse(USE_SHAPE);
  }
  const p = parts.length > 1 && parts[0].toLowerCase() === ENGINE_DB ? parts.slice(1) : parts;
  if ((parts.length === 1 && parts[0].toLowerCase() === ENGINE_DB) || (p.length === 1 && p[0].toLowerCase() === 'main')) return { clear: true };
  if (p.length < 2 || p.length > 3 || isOwnCatalog(p[0]) || DUCKDB_SCHEMAS.has(p[0].toLowerCase())) refuse(USE_SHAPE);
  if (isGuid(p[0]) && isGuid(p[1])) refuse(`${USE_SHAPE}, by their names, not their GUIDs`);
  const it = splitItem(p[1]);
  return { workspace: p[0], item: it ? it.item : p[1], kind: it ? it.kind : 'lakehouse', schema: p.length === 3 ? p[2] : 'dbo' };
}

// A USE's schema as SQL writes it: aemo.data.dbo.
const namespaceName = ns => [ns.workspace, itemPart(ns.item, ns.kind), ns.schema].map(sqlPart).join('.');

// The character a UTF-8 byte offset is at, as DuckDB's parser gives a name's place; -1 past the end.
function charAtByte(s, bytes) {
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    if (b === bytes) return i;
    const c = s.codePointAt(i);
    b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c > 0xffff) i++;
  }
  return b === bytes ? s.length : -1;
}

/**
 * Every bare table name `sql` reads: one with no database in front, `t` or `s.t`, as [{ start, end, parts }],
 * where it is written. By DuckDB's parse of it (`serialize`), so a column, an alias or a function is never one,
 * and a CTE's name is left out. A statement it can't parse has none: it fails as written.
 * @param {string} sql
 * @param {(sql: string) => Promise<object>} serialize  DuckDB's json_serialize_sql on it, parsed
 */
async function bareNames(sql, serialize) {
  const text = String(sql);
  const out = [];
  const tk = tokens(text);
  const nameFrom = at => {
    const parts = [];
    let j = at, end = tk[at] ? tk[at].start : 0;
    for (;;) {
      const t = tk[j];
      if (!t || (t.t !== 'word' && t.t !== 'name')) break;
      parts.push(t.v);
      end = t.end;
      if (!tk[j + 1] || tk[j + 1].t !== '.') { j++; break; }
      j += 2;
    }
    return { parts, end, next: j };
  };
  // DESCRIBE t and SUMMARIZE t: the parser says no place for the table, so it is found as written.
  if (tk[0] && tk[0].t === 'word' && ['describe', 'desc', 'summarize', 'show'].includes(tk[0].w) && tk[1] && tk[1].t !== '(' &&
      !(tk[1].t === 'word' && READS.has(tk[1].w)) && !(tk[1].t === 'word' && ['tables', 'all', 'databases', 'schemas', 'semantic'].includes(tk[1].w))) {
    const n = nameFrom(1);
    const rest = tk.slice(n.next).filter(t => t.t !== ';');
    if (n.parts.length && n.parts.length <= 2 && !rest.length) out.push({ start: tk[1].start, end: n.end, parts: n.parts });
    return out;
  }
  // EXPLAIN …: the query after it.
  const lead = /^\s*/.exec(text)[0].length;
  const explained = EXPLAIN.exec(text.slice(lead));
  const from = explained ? text.length - explained[2].length : 0;
  const body = text.slice(from);
  let parsed = await serialize(body), shift = 0;
  if (parsed.error && NOT_A_SELECT.test(parsed.error_message) && PIVOT.test(scan(body).text)) {
    parsed = await serialize(`SELECT * FROM (${body}\n)`);
    shift = Buffer.byteLength('SELECT * FROM (');
  }
  if (!parsed || parsed.error) return out;
  const ctes = new Set(), found = [];
  const walk = o => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (!o || typeof o !== 'object') return;
    if (o.type === 'BASE_TABLE' && !o.catalog_name && Number.isSafeInteger(o.query_location)) found.push(o);
    if (o.cte_map && Array.isArray(o.cte_map.map)) for (const e of o.cte_map.map) ctes.add(String(e.key).toLowerCase());
    for (const v of Object.values(o)) walk(v);
  };
  walk(parsed.statements);
  for (const b of found) {
    if (!b.schema_name && ctes.has(String(b.table_name).toLowerCase())) continue;
    const at = charAtByte(body, b.query_location - shift);
    if (at < 0) continue;
    const k = tk.findIndex(t => t.start === from + at);
    if (k < 0) continue;
    const n = nameFrom(k);
    const want = b.schema_name ? 2 : 1;
    if (n.parts.length !== want || n.parts[want - 1].toLowerCase() !== String(b.table_name).toLowerCase()) continue;
    out.push({ start: tk[k].start, end: n.end, parts: n.parts });
  }
  return out;
}

/**
 * `sql` with each bare name a table of the USE's schema `ns`: `t` is <ns>.t, `s.t` is the same lakehouse's s.t.
 * `duck` says what the engine has: { databases, schemas, objects }, lower-cased sets of its databases, its
 * top-level schemas, and the tables and views a bare name finds in it (a Files/ view, DuckDB's own). A name
 * that is the engine's stays as written; one the schema has too (`listed`, by its whole name) is refused, as a
 * name meaning two tables. SHOW TABLES lists the schema.
 */
function withNamespace(sql, names, ns, duck, listed = () => false) {
  const text = String(sql);
  const nsName = namespaceName(ns);
  if (/^\s*show\s+tables\s*;?\s*$/i.test(scan(text).text)) return `SHOW TABLES FROM ${nsName}`;
  let out = text;
  for (const n of [...names].sort((a, b) => b.start - a.start)) {
    const [a, b] = n.parts;
    let whole;
    if (n.parts.length === 1) {
      whole = `${nsName}.${sqlPart(a)}`;
      if (duck.objects.has(a.toLowerCase())) {
        if (listed(whole)) {
          refuse(`${a} is both ${whole} and a table or view of this engine's own, such as a file's view: write the whole ` +
            'name of the one you mean');
        }
        continue;
      }
    } else {
      if (duck.databases.has(a.toLowerCase()) || duck.schemas.has(a.toLowerCase())) continue;
      whole = [ns.workspace, itemPart(ns.item, ns.kind), a, b].map(sqlPart).join('.');
    }
    out = out.slice(0, n.start) + whole + out.slice(n.end);
  }
  return out;
}

// The engine's own names a bare name can reach, for withNamespace: run as a query, its rows are { k, n }.
const DUCK_NAMES = `SELECT 'db' AS k, lower(database_name) AS n FROM duckdb_databases()
UNION ALL SELECT 'schema', lower(schema_name) FROM duckdb_schemas() WHERE parent_schema_oid IS NULL AND database_name = current_database()
UNION ALL SELECT 'object', lower(o.name) FROM (
  SELECT database_oid, schema_oid, table_name AS name FROM duckdb_tables()
  UNION ALL SELECT database_oid, schema_oid, view_name FROM duckdb_views()) o
JOIN duckdb_schemas() s ON s.database_oid = o.database_oid AND s.oid = o.schema_oid
WHERE s.parent_schema_oid IS NULL AND (s.database_name IN ('temp', 'system') OR (s.database_name = current_database() AND s.schema_name IN ('main', 'pg_catalog')))`;
const duckNamesOf = rows => {
  const duck = { databases: new Set(), schemas: new Set(), objects: new Set() };
  for (const r of rows) (r.k === 'db' ? duck.databases : r.k === 'schema' ? duck.schemas : duck.objects).add(String(r.n));
  return duck;
};

/**
 * A write with a USE's schema `ns`: its target, when it is a bare name, as the schema's table (or, for CREATE
 * SCHEMA, the lakehouse's schema), and the query of an INSERT, a CREATE TABLE … AS or a COPY (…) TO through
 * withNamespace. Anything else as written.
 */
async function writeWithNamespace(sql, ns, serialize, duck, listed) {
  const text = String(sql);
  const tk = tokens(text).filter(t => t.t !== ';');
  const w = k => (tk[k] && tk[k].t === 'word' ? tk[k].w : '');
  if (w(0) === 'with') return text;   // a write with CTEs: as written
  const verb = w(0);
  const nameAt = at => {
    const parts = [];
    let j = at;
    while (tk[j] && (tk[j].t === 'word' || tk[j].t === 'name')) {
      parts.push(tk[j].v);
      if (!tk[j + 1] || tk[j + 1].t !== '.') { j++; break; }
      j += 2;
    }
    return parts.length ? { parts, start: tk[at].start, end: tk[j - 1].end, next: j } : null;
  };
  const skip = (at, words) => (words.every((x, i) => w(at + i) === x) ? at + words.length : at);
  let at = -1, schema = false;
  if (verb === 'insert' && w(1) === 'into') at = 2;
  else if (verb === 'update') at = 1;
  else if ((verb === 'delete' && w(1) === 'from') || (verb === 'merge' && w(1) === 'into')) at = 2;
  else if (verb === 'alter' && w(1) === 'table') at = skip(2, ['if', 'exists']);
  else if (verb === 'create' && w(1) === 'table') at = skip(2, ['if', 'not', 'exists']);
  else if (verb === 'create' && w(1) === 'schema') { at = skip(2, ['if', 'not', 'exists']); schema = true; }
  let out = text, target = null;
  const n = at >= 0 ? nameAt(at) : null;
  if (n && (schema ? n.parts.length === 1 : n.parts.length <= 2) && !isOwnCatalog(n.parts[0]) && !duck.databases.has(n.parts[0].toLowerCase())) {
    const lh = [ns.workspace, itemPart(ns.item, ns.kind)];
    const whole = schema ? [...lh, n.parts[0]] : n.parts.length === 1 ? [...lh, ns.schema, n.parts[0]] : [...lh, ...n.parts];
    target = { start: n.start, end: n.end, text: whole.map(sqlPart).join('.') };
  }
  // The query in it: after INSERT INTO t's columns, after CREATE TABLE t AS, or COPY's (…).
  let q = null;
  if (verb === 'insert' && n) {
    const j = tk.findIndex((t, x) => x >= n.next && t.depth === 0 && t.t === 'word' && READS.has(t.w));
    if (j >= 0) q = { start: tk[j].start, end: text.length };
  } else if (verb === 'create' && !schema && n) {
    const j = tk.findIndex((t, x) => x >= n.next && t.depth === 0 && t.t === 'word' && t.w === 'as');
    if (j >= 0 && tk[j + 1]) q = { start: tk[j + 1].start, end: text.length };
  } else if (verb === 'copy' && tk[1] && tk[1].t === '(') {
    const close = tk.findIndex((t, x) => x > 1 && t.t === ')' && t.depth === tk[1].depth);
    if (close > 2) q = { start: tk[2].start, end: tk[close].start };
  }
  if (q) {
    const inner = text.slice(q.start, q.end);
    const names = await bareNames(inner, serialize);
    out = out.slice(0, q.start) + withNamespace(inner, names, ns, duck, listed) + out.slice(q.end);
  }
  if (target) out = out.slice(0, target.start) + target.text + out.slice(target.end);
  return out;
}

module.exports = { sqlStr, quoteIdent, storedFault, assertOneLakeUrl, ONELAKE_SCOPES, scopeOfUrl, oneLakeScopes, assertReads, checkedRead, readsOnly,
                   writeOf, withTableProperties, TABLE_PROPERTIES, checkPhysical, sessionStatementOf, checkTempPhysical, statementsOf, ICE_PREFIX, DELTA_PREFIX, isWriteCatalog, tableRefs, oldTableName, fileRefs, filesReadBy, namedError, catalogStatement, isShowAllTables, withoutComments, ALL_TABLES_COUNTED, COLUMNS_NOT_READ, readsCatalog,
                   useOf, namespaceName, bareNames, withNamespace, writeWithNamespace, DUCK_NAMES, duckNamesOf };

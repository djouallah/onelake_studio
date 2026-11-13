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

// -----------------------------------------------------------------------------
// Read only, enforced where the engine is
// -----------------------------------------------------------------------------
// Every statement the page or the command line sends is checked here, before DuckDB runs it.
//
// What passes as a read: one statement that reads. Nothing else: no COPY, INSERT, UPDATE, DELETE, EXPORT,
// INSTALL, LOAD, SET, CREATE, DROP, ATTACH or DETACH. What a tab sets up to read a file is a host
// method (engine-host.js fileView, attachFile), so no statement can reach another tab's. A statement that
// isn't a read can only be a write to a lakehouse, which has walls of its own (writeOf, checkPlan).
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

// The name a write's Iceberg catalog is attached under: ice_ and 16 hex digits (engine-host.js).
const ICE_PREFIX = 'ice_';
const ICE_CATALOG = /\bice_[0-9a-f]{16}\b/i;

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
  if (/\b(?:write_blob|write_log)"?\s*\(/i.test(called)) refuse('this function writes');
  // query('…' || '…') runs SQL no name above can be found in, DuckDB having joined the text up first.
  if (/\bquery(?:_table)?"?\s*\(/i.test(called)) refuse('query() runs what no check here can read');
  // A write's own Iceberg catalog (engine-host.js runWrite) is attached for that one statement, under a name
  // that is never a statement's to use: it would go around every check on what a write may reach.
  if (ICE_CATALOG.test(called)) refuse('a write\'s catalog is the engine\'s own');
  // A URL on another host is refused here, where it can be said why. One joined up from pieces gets past this,
  // DuckDB joining the text after it, and reads nothing: the secret's scope names no such place (ONELAKE_SCOPES).
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
// and refuses everything else at once. checkPlan then holds DuckDB's own plan of the statement as it
// will run (json_serialize_plan, bound on the engine that runs it) to the same: the kind of statement,
// and the catalog or the file it writes. So being wrong about the text writes nowhere else.

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
    if (c === '"' || c === "'") {
      const end = quotedEnd(s, i);
      out.push({ t: c === '"' ? 'name' : 'str', v: s.slice(i + 1, end - 1).split(c + c).join(c), start: i, end, depth });
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
// The engine's own catalogs, which a three-part name can't be a workspace's write to.
const ENGINE_CATALOGS = new Set(['memory', 'temp', 'system', 'main', 'lake', 'system_internal', 'semanticmodel',
                                 'lakehouse', 'warehouse', 'sqldatabase', 'mirroreddatabase']);
const TABLE_SHAPE = 'a write goes to a lakehouse table: lakehouse.<workspace>.<lakehouse>.<schema>.<table>, or <workspace>.<lakehouse>.<table> for dbo';
const SCHEMA_SHAPE = 'a schema is made in a lakehouse: lakehouse.<workspace>.<lakehouse>.<schema>, or <workspace>.<lakehouse>.<schema>';
const FILE_SHAPE = "COPY writes to a lakehouse's Files/: TO 'lakehouse.<workspace>.<lakehouse>/Files/<path>'";
// What DuckDB's plan of each is (checkPlan).
const PLANS = { insert: 'LOGICAL_INSERT', update: 'LOGICAL_UPDATE', delete: 'LOGICAL_DELETE', merge: 'LOGICAL_MERGE_INTO',
                'create table': 'LOGICAL_CREATE_TABLE', 'create schema': 'LOGICAL_CREATE_SCHEMA', alter: 'LOGICAL_ALTER',
                copy: 'LOGICAL_COPY_TO_FILE' };

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
  if (verb === 'drop') notRun('DROP is blocked: no table or schema is dropped');
  if (verb === 'truncate') notRun("TRUNCATE isn't one of DuckDB's Iceberg writes");
  if (!['insert', 'update', 'delete', 'merge', 'create', 'alter', 'copy'].includes(verb)) {
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
    let ref;
    if (p.length === 5) {
      if (p[0].toLowerCase() !== 'lakehouse') {
        notRun(['warehouse', 'sqldatabase', 'mirroreddatabase'].includes(p[0].toLowerCase())
          ? `a write goes to a lakehouse only, and ${p[0]} is read only here` : TABLE_SHAPE);
      }
      ref = { workspace: p[1], item: p[2], schema: p[3], table: p[4] };
    } else if (p.length === 3) {
      if (ENGINE_CATALOGS.has(p[0].toLowerCase())) notRun(`${p[0]} is the engine's own, not a lakehouse: ${TABLE_SHAPE}`);
      ref = { workspace: p[0], item: p[1], schema: 'dbo', table: p[2] };
    } else notRun(TABLE_SHAPE);
    return { target: 'table', ref, start: n.start, end: n.end };
  };
  const schema = at => {
    const n = nameAt(at);
    const p = n ? n.parts : [];
    let ref;
    if (p.length === 4 && p[0].toLowerCase() === 'lakehouse') ref = { workspace: p[1], item: p[2], schema: p[3] };
    else if (p.length === 3 && !ENGINE_CATALOGS.has(p[0].toLowerCase())) ref = { workspace: p[0], item: p[1], schema: p[2] };
    else notRun(SCHEMA_SHAPE);
    return { target: 'schema', ref, start: n.start, end: n.end };
  };
  const as = (what, found) => ({ what, plan: PLANS[what], ...found });

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
  try { file = fileName(to.v, new Map([['lakehouse', 'lakehouse']])); }
  catch (e) { notRun(e.message); }
  if (!file || file.zip) notRun(FILE_SHAPE);
  return as('copy', { target: 'file', ref: file, start: to.start, end: to.end });
}

/**
 * Holds DuckDB's plan of a write (json_serialize_plan, parsed) to what writeOf read in its text: the kind of
 * statement, and the catalog it writes (`catalog`) or the file (`file`). DuckDB's own error on it, a table that
 * isn't there for one, is said as DuckDB says it.
 */
function checkPlan(parsed, { plan, catalog = null, file = null }) {
  if (!parsed || parsed.error) {
    const message = parsed ? String(parsed.error_message || 'DuckDB could not plan it') : 'DuckDB could not plan it';
    if (UNSERIALIZED.test(message)) notRun(`DuckDB could not show its plan of this write, so it isn't run: ${message}`);
    if (/^(?:binder|catalog|parser|conversion|invalid input|not implemented)$/i.test(String(parsed && parsed.error_type))) throw new Error(message);
    notRun(`DuckDB could not show its plan of this write, so it isn't run: ${message}`);
  }
  const plans = parsed.plans || [];
  if (plans.length !== 1) notRun('DuckDB reads this as more than one statement');
  const p = plans[0];
  if (p.type !== plan) notRun(`DuckDB plans this as ${String(p.type).replace(/^LOGICAL_/, '')}, not ${plan.replace(/^LOGICAL_/, '')}`);
  if (file != null) {
    if (p.file_path !== file) notRun(`DuckDB would write ${p.file_path}, not the file this statement names`);
    return;
  }
  const info = p.table_info || p.info || {};
  const path = info.qualified_name && Array.isArray(info.qualified_name.path) ? info.qualified_name.path : null;
  const where = (path && path[0]) || info.catalog || '';
  if (String(where).toLowerCase() !== String(catalog).toLowerCase()) {
    notRun(`DuckDB would write to ${where || 'a catalog it doesn\'t name'}, not the lakehouse this statement names`);
  }
}

// DuckDB can't write the bound plan of an UPDATE, a DELETE or a MERGE on an Iceberg table as JSON: the scan of the
// table it changes has no serialization. Their physical plan says it as well, by DuckDB-Iceberg's own operators: a
// write to an Iceberg table is ICEBERG_INSERT, ICEBERG_UPDATE or ICEBERG_DELETE, and to nothing else. Which Iceberg
// table it is, the statement's text alone can say: no statement may name a write's catalog (oneStatement), so the
// only one it binds is the one engine-host.js named in it.
const UNSERIALIZED = /serialization not implemented/i;
const ICEBERG_WRITES = new Set(['ICEBERG_INSERT', 'ICEBERG_UPDATE', 'ICEBERG_DELETE']);
// A write that is not an Iceberg one: to a DuckDB table, a file, another database.
const OTHER_WRITES = /^(?:BATCH_)?(?:INSERT|UPDATE|DELETE|COPY_TO_FILE|CREATE_TABLE_AS|CREATE_TABLE|CREATE_INDEX|DROP|ALTER|ATTACH|DETACH|EXPORT|MERGE_INTO)$/;

/**
 * Holds DuckDB's physical plan of an UPDATE, a DELETE or a MERGE (EXPLAIN (FORMAT json), parsed) to what writeOf
 * read in its text, when its bound plan can't be had (checkPlan's `unserialized`).
 */
function checkPhysical(tree, what) {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (roots.length !== 1 || !roots[0]) notRun('DuckDB plans this as more than one statement');
  const writes = [];
  const walk = (n, under) => {
    const name = String(n.name || '');
    if (ICEBERG_WRITES.has(name)) writes.push(name);
    // An Iceberg write writes its files with a COPY of its own, under it.
    else if (OTHER_WRITES.test(name) && !(under && name === 'COPY_TO_FILE') && !(name === 'MERGE_INTO' && n === roots[0] && what === 'merge')) {
      notRun(`DuckDB plans a ${name} in this, which isn't a write to the lakehouse it names`);
    }
    for (const c of n.children || []) walk(c, under || ICEBERG_WRITES.has(name));
  };
  walk(roots[0], false);
  const root = String(roots[0].name || '');
  // An UPDATE writes its rows anew (ICEBERG_INSERT, over the ICEBERG_UPDATE that marks the old ones deleted), or
  // marks them alone; a DELETE marks them; a MERGE does any of those under its MERGE_INTO.
  const shape = { update: { roots: ['ICEBERG_INSERT', 'ICEBERG_UPDATE'], has: 'ICEBERG_UPDATE' },
                  delete: { roots: ['ICEBERG_DELETE'], has: 'ICEBERG_DELETE' },
                  merge: { roots: ['MERGE_INTO'], has: null } }[what];
  if (!shape) notRun(`DuckDB's plan of ${what} is checked by its bound plan only`);
  if (!shape.roots.includes(root)) notRun(`DuckDB plans this as ${root}, not ${shape.has || shape.roots[0]}`);
  if (!writes.length) notRun("DuckDB's plan of this writes no Iceberg table");
  if (shape.has && !writes.includes(shape.has)) notRun(`DuckDB's plan of this has no ${shape.has}`);
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
    if (s[i] === "'" || s[i] === '"') { i = quotedEnd(s, i); continue; }
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
// a part quoted where SQL must quote it — so `lakehouse` + `ws.lh.dbo` + `t` is the name a
// query reads. Every other statement runs as written.
const CATALOG_CTES = `WITH RECURSIVE
  kw AS (SELECT keyword_name AS w FROM duckdb_keywords() WHERE keyword_category IN ('reserved', 'type_function')),
  s AS (SELECT database_oid, database_name, oid, schema_name AS n, parent_schema_oid,
               CASE WHEN regexp_full_match(schema_name, '[A-Za-z_][A-Za-z0-9_]*') AND lower(schema_name) NOT IN (SELECT w FROM kw)
                    THEN schema_name ELSE '"' || replace(schema_name, '"', '""') || '"' END AS q
        FROM duckdb_schemas()
        -- The lake (engine-host.js): the engine's own copy of each OneLake table, by a hash of its folder. What a
        -- query names is the table's own name; these are how it is read. Its metadata, system_internal, is listed.
        -- Nor a write's own Iceberg catalog, there for that one statement (engine-host.js runWrite).
        WHERE database_name <> 'lake' AND NOT starts_with(database_name, '${ICE_PREFIX}')),
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

module.exports = { sqlStr, quoteIdent, assertOneLakeUrl, ONELAKE_SCOPES, scopeOfUrl, oneLakeScopes, assertReads, checkedRead, readsOnly,
                   writeOf, checkPlan, checkPhysical, isUnserialized: e => UNSERIALIZED.test(String(e && e.message)), statementsOf, ICE_PREFIX, tableRefs, fileRefs, filesReadBy, namedError, catalogStatement, isShowAllTables, withoutComments, ALL_TABLES_COUNTED, COLUMNS_NOT_READ, readsCatalog };

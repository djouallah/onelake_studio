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
// The extension never writes to OneLake or Fabric, and that is not left to the page's own
// guard (paths.js prepareReadOnlySql), which checks only the first keyword — so
// `EXPLAIN ANALYZE COPY (…) TO 'abfss://…'`, which RUNS the copy, went through it. Every
// statement the page sends is checked here, before DuckDB sees it.
//
// What passes: one statement that reads, and the few the page itself issues to set up what
// it reads — views and schemas in the in-memory catalog, their drops, and ATTACH/DETACH of a
// database file, READ_ONLY. Nothing else: no COPY, INSERT, UPDATE, DELETE, EXPORT, INSTALL,
// LOAD, SET.

// Comments become a space and the INSIDE of every literal, quoted identifier and $$ string
// is dropped (its quotes kept), so no keyword can hide in one and no name can pose as one.
// `seps` are the offsets of the ';' outside them.
function scan(sql) {
  const out = [];
  const seps = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out.push(' ');
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out.push(c, c);
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
        out.push("''");
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
                       'summarize', 'pivot', 'unpivot', 'pragma']);
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
  const first = (/^\s*([A-Za-z_]+)/.exec(text) || [, ''])[1].toLowerCase();
  if (first !== 'with') return READS.has(first);
  // The statement after the CTEs is the first top-level word that can start one (a CTE
  // named like a keyword has to be quoted, and quoted names are gone by now).
  const main = topLevelWords(text).slice(1).find(w => STARTS.has(w) && w !== 'with');
  return !!main && READS.has(main);
}

const refuse = why => {
  throw new Error(`Read only: OneLake Studio never writes, and ${why}.`);
};

/** Throws unless `sql` is one statement the read-only contract allows. */
function assertReadOnly(sql) {
  const { text, seps } = scan(String(sql));
  if (seps.some(i => text.slice(i + 1).trim() !== '')) refuse('runs one statement at a time');
  const s = text.trim().replace(/;+\s*$/, '').trim();
  if (!s) refuse('this statement is empty');
  if (isRead(s)) return;
  // EXPLAIN [ANALYZE] q, or EXPLAIN (ANALYZE, FORMAT json|html) q — Explore's Show plan. The
  // option list is EXPLAIN's own words only; what follows must still be a read.
  const explained = /^explain\s*(?:\(\s*((?:analy[sz]e|format\s+(?:json|html|text|graphviz))(?:\s*,\s*(?:analy[sz]e|format\s+(?:json|html|text|graphviz)))*)\s*\)\s*|analy[sz]e\s+)?([\s\S]*)$/i.exec(s);
  if (explained) {
    if (isRead(explained[2])) return;
    refuse('EXPLAIN runs only over a query');
  }
  if (/^create\s+(or\s+replace\s+)?((temp|temporary)\s+)?view\s/i.test(s)) {
    const body = /\sas\s([\s\S]*)$/i.exec(s);
    if (body && isRead(body[1])) return;
    refuse('a view is only ever a query');
  }
  if (/^create\s+schema\s/i.test(s) && !/\sas\s/i.test(s)) return;
  if (/^drop\s+(view|table|schema)\s/i.test(s)) return;
  if (/^detach\s/i.test(s)) return;
  if (/^attach\s/i.test(s)) {
    // READ_ONLY in the option list — outside any quotes, which scan() has emptied, so an
    // alias spelled "READ_ONLY" does not count — and not switched off.
    const opts = /\(([^()]*)\)\s*$/.exec(s);
    if (opts && /\bread_only\b(?!\s*=?\s*(false|0)\b)/i.test(opts[1])) return;
    refuse('a database is attached READ_ONLY');
  }
  refuse(`${(/^[A-Za-z_]+/.exec(s) || ['this'])[0].toUpperCase()} is not a read`);
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
const IDENT = /[A-Za-z_À-￿][A-Za-z0-9_$À-￿]*/y;
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
  const space = j => { while (j < n && /\s/.test(s[j])) j++; return j; };
  while (i < n) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) { if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 66));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
        continue;
      }
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

module.exports = { sqlStr, quoteIdent, assertReadOnly, tableRefs };

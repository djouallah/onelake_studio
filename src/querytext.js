'use strict';
// =============================================================================
// querytext.js — what the query editor needs to know about the text in it
// =============================================================================
// Pure, no vscode: the statements of a .sql document and which one the cursor is in, where
// in a statement DuckDB says an error is, and the dotted name being typed before the cursor.
// queryeditor.js turns these into Run, CodeLens, diagnostics and completion.
// =============================================================================

// The statements of `text`, as [start, end) offsets, each without its ';', the comments and
// whitespace before it, or the whitespace after it. Quotes ('…', "…", $tag$…$tag$) and
// comments (--, /* */) are skipped, so a ';' in one does not split. A statement that is only
// comments is left out.
function statements(text) {
  const s = String(text);
  const n = s.length;
  const out = [];
  let start = -1;   // where the statement's first code (not a comment) is, -1 before it
  const mark = at => { if (start < 0) start = at; };
  const close = end => {
    if (start >= 0) {
      let b = end;
      while (b > start && /\s/.test(s[b - 1])) b--;
      out.push({ start, end: b });
    }
    start = -1;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      mark(i);
      i++;
      while (i < n) {
        if (s[i] === c) { if (s[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        mark(i);
        const e = s.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
        continue;
      }
    }
    if (c === ';') { close(i); i++; continue; }
    if (!/\s/.test(c)) mark(i);
    i++;
  }
  close(n);
  return out;
}

// The statement the cursor is in: the one whose span holds it, else the last one that ends
// before it on the text (a cursor after `SELECT 1;` runs SELECT 1), else the first after it.
function statementAt(list, offset) {
  let before = null;
  for (const st of list) {
    if (offset >= st.start && offset <= st.end) return st;
    if (st.end <= offset) before = st;
  }
  return before || list.find(st => st.start >= offset) || null;
}

// Where in `sql` (the statement as written) DuckDB's error points, as an offset; null when it
// does not say. DuckDB writes
//   LINE 1: SELECT x FORM t
//                    ^
// with the line cut to a window around the error ("..." at either end). The page runs the
// statement with its comments removed and trimmed, so the line number is not the editor's:
// the excerpt is found in the statement instead, and the caret's place in it is the offset.
function errorOffset(message, sql) {
  const m = /LINE (\d+): ([^\n]*)\n( *)\^/.exec(String(message || ''));
  if (!m) return null;
  let excerpt = m[2];
  let caret = m[3].length - `LINE ${m[1]}: `.length;
  if (excerpt.startsWith('...')) { excerpt = excerpt.slice(3); caret -= 3; }
  if (excerpt.endsWith('...')) excerpt = excerpt.slice(0, -3);
  if (!excerpt.trim() || caret < 0) return null;
  const at = String(sql).indexOf(excerpt);
  if (at < 0) return null;
  return at + Math.min(caret, excerpt.length);
}

// The error's first line, as a diagnostic says it ("Binder Error: … not found").
const errorSummary = message => String(message || '').split('\n').find(l => l.trim()) || 'Query failed';

// The dotted name being typed at the end of `prefix` (the line up to the cursor):
// `FROM lakehouse.aemo.da` -> { parts: ['lakehouse', 'aemo'], partial: 'da' }. A part may be
// "quoted" ("" inside it is a quote). null when the cursor is in no name.
function dottedName(prefix) {
  const m = /((?:(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s*\.\s*)*)("(?:[^"]|"")*|[A-Za-z_][\w$]*)?$/.exec(String(prefix));
  if (!m) return null;
  const parts = [...m[1].matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][\w$]*)/g)].map(p => (p[1] != null ? p[1].replace(/""/g, '"') : p[2]));
  const raw = m[2] || '';
  const partial = raw.startsWith('"') ? raw.slice(1).replace(/""/g, '"') : raw;
  return { parts, partial, quoted: raw.startsWith('"'), start: String(prefix).length - raw.length };
}

// Every dotted name in `sql` outside quotes and comments, as its parts (unquoted).
function namesIn(sql) {
  const s = String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ');
  const out = [];
  for (const m of s.matchAll(/(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*))+/g)) {
    out.push([...m[0].matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][\w$]*)/g)].map(p => (p[1] != null ? p[1].replace(/""/g, '"') : p[2])));
  }
  return out;
}

module.exports = { statements, statementAt, errorOffset, errorSummary, dottedName, namesIn };

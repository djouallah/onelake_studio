// =============================================================================
// querytext.js — what the SQL box needs to know about the text in it
// =============================================================================
// Pure: the statements in the box and which one the cursor is in, where in a statement DuckDB
// says an error is, and the query variables. app.js turns these into Run and Plan.
// =============================================================================

// Where a comment, a quoted text or a $$ string ends, as DuckDB reads them (src/sql.js has the same for
// the guard). A line comment stops at either line break, block comments nest, a backslash escapes in an
// E'...' string, and a '$' in a word opens nothing.
const WORD = /[A-Za-z0-9_$\u0080-\uffff]/;
function commentEnd(s, i) {
  if (s[i] === '-' && s[i + 1] === '-') {
    let j = i;
    while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++;
    return j;
  }
  if (s[i] === '/' && s[i + 1] === '*') {
    let depth = 1, j = i + 2;
    while (j < s.length && depth) {
      if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; }
      else if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; }
      else j++;
    }
    return Math.min(j, s.length);
  }
  return -1;
}
function quotedEnd(s, i) {
  const q = s[i];
  const backslash = q === "'" && /[eE]/.test(s[i - 1] || '') && !WORD.test(s[i - 2] || '');
  let j = i + 1;
  while (j < s.length) {
    if (backslash && s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) {
      if (s[j + 1] !== q) return j + 1;
      j += 2;
      continue;
    }
    j++;
  }
  return s.length;
}
function dollarEnd(s, i) {
  if (i > 0 && WORD.test(s[i - 1])) return -1;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
  if (!m) return -1;
  const e = s.indexOf(m[0], i + m[0].length);
  return e < 0 ? s.length : e + m[0].length;
}

// The statements of `text`, as [start, end) offsets, each without its ';', the comments and
// whitespace before it, or the whitespace after it. Quotes ('…', "…", $tag$…$tag$) and
// comments (--, /* */) are skipped, so a ';' in one does not split. A statement that is only
// comments is left out.
export function statements(text) {
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
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (c === "'" || c === '"') {
      mark(i);
      i = quotedEnd(s, i);
      continue;
    }
    if (c === '$') {
      const end = dollarEnd(s, i);
      if (end !== -1) {
        mark(i);
        i = end;
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
export function statementAt(list, offset) {
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
export function errorOffset(message, sql) {
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

// Query variables, kept by the page for the session: `SET VARIABLE name = expr` sets one
// (never sent to the engine, whose guard refuses SET), and getvariable('name') in a query is
// replaced by its value before the query runs.
const SET_VARIABLE = /^\s*set\s+variable\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)\s*(?:=|to)\s*([\s\S]+?)\s*;?\s*$/i;
const GET_VARIABLE = /getvariable\s*\(\s*'((?:[^']|'')*)'\s*\)/gi;
// Only when `sql` is one statement (a selection of a SET and a SELECT is not a SET), and the
// value as SQL with its comments gone: `2024 -- the year` is 2024.
export function setVariable(sql) {
  const text = String(sql);
  const list = statements(text);
  if (list.length !== 1) return null;
  const m = SET_VARIABLE.exec(text.slice(list[0].start, list[0].end));
  if (!m) return null;
  const name = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
  const value = withoutComments(m[2]).trim();
  return value ? { name, value } : null;
}
// `sql` with its -- and /* */ comments removed, quotes kept as they are.
function withoutComments(sql) {
  const s = String(sql);
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    const comment = commentEnd(s, i);
    if (comment !== -1) { if (s[i] === '/') out += ' '; i = comment; continue; }
    const end = c === "'" || c === '"' ? quotedEnd(s, i) : c === '$' ? dollarEnd(s, i) : -1;
    if (end !== -1) { out += s.slice(i, end); i = end; continue; }
    out += c; i++;
  }
  return out;
}
// The variable names a statement reads, once each, as written.
export function variablesIn(sql) {
  const seen = new Map();
  for (const m of withoutComments(sql).matchAll(GET_VARIABLE)) {
    const name = m[1].replace(/''/g, "'");
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}
// Each getvariable('name') replaced by (its value); `values` by lower-cased name. One in a comment
// isn't read, so a statement with none stays as it was written.
export const bindVariables = (sql, values) => (!variablesIn(sql).length ? String(sql) : withoutComments(sql).replace(GET_VARIABLE, (all, name) => {
  const v = values.get(name.replace(/''/g, "'").toLowerCase());
  return v == null ? all : `(${v})`;
}));
// A value typed at the prompt, as SQL: a number as it is, a quoted literal as it is, anything
// else quoted.
export function literal(text) {
  const t = String(text).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) || /^'(?:[^']|'')*'$/.test(t) || /^null$/i.test(t)) return t;
  return `'${t.replace(/'/g, "''")}'`;
}

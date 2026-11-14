// =============================================================================
// querytext.js — what the SQL box needs to know about the text in it
// =============================================================================
// Pure: the statements in the box and which one the cursor is in, where in a statement DuckDB
// says an error is, and the query variables. app.js turns these into Run and Plan.
// =============================================================================

// Where a comment, a quoted text or a $$ string ends, as DuckDB reads them (core/sql.js has the same for
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

// Query variables. DuckDB keeps them: a tab's statements run on one DuckDB session of its own, so SET VARIABLE goes
// to the engine as written, and getvariable('name') or $name in a later statement reads it there. The page only
// keeps which names this tab has set, so one never set is asked for the first time a statement reads it.
const SET_VARIABLE = /^\s*(set|reset)\s+variable\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)/i;
const GET_VARIABLE = /getvariable\s*\(\s*'((?:[^']|'')*)'\s*\)/gi;
/** The variable a statement sets or resets, { name, reset }, or null for any other (one statement only). */
export function setVariable(sql) {
  const text = String(sql);
  const list = statements(text);
  if (list.length !== 1) return null;
  const m = SET_VARIABLE.exec(withoutComments(text.slice(list[0].start, list[0].end)));
  if (!m) return null;
  return { name: m[2].startsWith('"') ? m[2].slice(1, -1).replace(/""/g, '"') : m[2], reset: m[1].toLowerCase() === 'reset' };
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
// The $names of `sql`, outside comments, quotes and $tag$ strings: $num_rows, not $1 (a parameter) or col$a.
function dollarNames(sql) {
  const s = String(sql), out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const comment = commentEnd(s, i);
    if (comment !== -1) { i = comment; continue; }
    if (c === "'" || c === '"') { i = quotedEnd(s, i); continue; }
    if (c === '$') {
      const end = dollarEnd(s, i);
      if (end !== -1) { i = end; continue; }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 256));
      if (m && !(i > 0 && WORD.test(s[i - 1]))) { out.push(m[1]); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}
/** The variable names a statement reads, by getvariable('name') or $name, once each, as written. */
export function variablesIn(sql) {
  const seen = new Map();
  const add = name => { if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name); };
  for (const m of withoutComments(sql).matchAll(GET_VARIABLE)) add(m[1].replace(/''/g, "'"));
  for (const name of dollarNames(sql)) add(name);
  return [...seen.values()];
}
// A value typed at the prompt, as SQL: a number as it is, a quoted literal as it is, anything
// else quoted.
export function literal(text) {
  const t = String(text).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) || /^'(?:[^']|'')*'$/.test(t) || /^null$/i.test(t)) return t;
  return `'${t.replace(/'/g, "''")}'`;
}

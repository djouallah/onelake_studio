// =============================================================================
// split.js — a query's scan of a large table, shared out between the engines
// =============================================================================
// DuckDB-WASM runs one thread an engine, so a query over a large table uses one core while the
// other engines wait. The compiler (dax-sql) reads a fact table inside a CTE of its own, a plain
// GROUP BY whose columns are the keys ("g0", ...) and one aggregate each ("a0", ...), and the
// rest of the statement reads only the CTEs. Such a CTE can run on every engine at once, each
// over its own share of the table's files (data.js binds p_<table> to it), and the answers be
// added up by one engine, which runs the rest:
//   partial   the CTE's body, v_<table> written p_<table>
//   final     the statement, the body now a GROUP BY over the partial answers
// Rows never cross engines, only groups: a tile's scan has no filter of its own to push (the
// filters are on the dimensions), so the rows would not fit in one engine's memory.
// Only what adds up is split: SUM, MIN, MAX and the counts. Anything else (a distinct count, an
// average, a median, a measure the compiler left as a subquery) leaves the statement as it is.
// Read from the SQL's text, as ranges.js reads its columns: the compiler's own structure
// (dax-sql's Fusion) is not something it gives out.
// =============================================================================

// The index after the quoted string ('...' or "...", a doubled quote inside) that starts at i.
function afterQuote(s, i) {
  const q = s[i];
  for (i++; i < s.length; i++) {
    if (s[i] !== q) continue;
    if (s[i + 1] === q) i++; else return i + 1;
  }
  return s.length;
}
// The index of the ) that closes the ( at i, or -1.
function closeOf(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i = afterQuote(s, i); continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
    i++;
  }
  return -1;
}
// `s` with what is quoted, and (with `nested`) what is inside parentheses, turned to spaces: the
// same length, so an index in one is an index in the other.
function flat(s, nested = true) {
  let out = '', depth = 0;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = afterQuote(s, i); out += ' '.repeat(j - i); i = j; continue; }
    if (c === ')') depth--;
    out += nested && depth > 0 ? ' ' : c;
    if (c === '(') depth++;
    i++;
  }
  return out;
}

// What a body may not hold anywhere: each makes the answer over a share of the rows something
// other than a share of the answer.
const NEVER = /\b(?:DISTINCT|EXISTS|QUALIFY|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|COLLATE\s+\w+\s+AS)\b|\bIN\s*\(\s*SELECT\b|\bOVER\s*\(|\b(?:RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b|\b(?:AVG|MEDIAN|MODE|PRODUCT|LIST|STRING_AGG|ARRAY_AGG|STDDEV\w*|VAR_\w+|VARIANCE|QUANTILE\w*|ANY_VALUE|ARG_M\w+|FIRST|LAST)\s*\(/i;

// A SELECT's items, [{ expr, alias }], and where its FROM starts; null when it is not one.
function selectOf(text) {
  const top = flat(text);
  const s = /^\s*SELECT\s/i.exec(top), f = /\sFROM\s/i.exec(top);
  if (!s || !f) return null;
  const items = [];
  let from = s[0].length;
  for (let i = from; i <= f.index; i++) {
    if (i < f.index && top[i] !== ',') continue;
    const m = /^([\s\S]*?)\s+AS\s+"([^"]+)"$/i.exec(text.slice(from, i).trim());
    if (!m) return null;
    items.push({ expr: m[1].trim(), alias: m[2] });
    from = i + 1;
  }
  return { items, from: f.index };
}
// How partial answers of an aggregate add up, or null: `expr` is one call, nothing around it.
//   SUM, MIN, MAX        themselves
//   NULLIF(COUNT(..), 0) SUM (no row is NULL in every share)
//   COUNT(..)            SUM, 0 for none
function mergeOf(expr) {
  const whole = open => {
    const close = closeOf(expr, open);
    if (close < 0) return false;
    if (close === expr.length - 1) return true;
    // An aggregate's own filter: AGG(..) FILTER (WHERE ..).
    const f = /^\s*FILTER\s*\(/i.exec(expr.slice(close + 1));
    return !!f && closeOf(expr, close + f[0].length) === expr.length - 1;
  };
  const call = /^(SUM|MIN|MAX|COUNT)\s*\(/i.exec(expr);
  if (call && whole(call[0].length - 1)) {
    const fn = call[1].toUpperCase();
    return fn === 'COUNT' ? a => `COALESCE(SUM(${a}), 0)` : a => `${fn}(${a})`;
  }
  const count = /^NULLIF\s*\(\s*COUNT\s*\(/i.exec(expr);
  if (count) {
    const close = closeOf(expr, count[0].length - 1);
    if (close > 0 && /^\s*,\s*0\s*\)$/.test(expr.slice(close + 1))) return a => `SUM(${a})`;
  }
  return null;
}
const sumLike = expr => /^(?:SUM|COUNT)\s*\(/i.test(expr) || /^NULLIF\s*\(\s*COUNT\s*\(/i.test(expr);

// A CTE's body as its partial and its merge, or null. `large(name)`: a table worth splitting.
function splitBody(body, large) {
  // "a IS NOT DISTINCT FROM b" is a comparison: neither a DISTINCT nor a FROM.
  const plain = flat(body, false).replace(/\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi, m => ' '.repeat(m.length));
  if (NEVER.test(plain)) return null;
  const named = [...plain.matchAll(/\bv_(\w+)\b/g)].filter(m => large(m[1]));
  if (named.length !== 1) return null;
  const at = named[0].index, table = named[0][1];
  // The table is what the body's rows come from: in its FROM, or in the FROM of the one
  // subquery its FROM reads (the compiler's grouping below the joins). Never a join's other side.
  const fromBefore = i => /\bFROM\s*$/i.test(plain.slice(0, i));
  if (!fromBefore(at)) return null;
  const opens = [];
  for (let i = 0; i < at; i++) { if (plain[i] === '(') opens.push(i); else if (plain[i] === ')') opens.pop(); }
  if (opens.length > 1 || (opens.length && !fromBefore(opens[0]))) return null;
  const outer = selectOf(body);
  if (!outer) return null;
  let inner = null;
  if (opens.length) {
    // Sums of sums and of counts add up over shares; a minimum of sums does not.
    inner = selectOf(body.slice(opens[0] + 1, closeOf(body, opens[0])));
    if (!inner || /\b(?:MIN|MAX)\s*\(/i.test(plain)) return null;
    for (const x of inner.items) {
      if (/^c\d+$/.test(x.alias)) continue;
      if (!/^a\d+$/.test(x.alias) || !sumLike(x.expr) || !mergeOf(x.expr)) return null;
    }
  }
  // Each column as the body gave it, its type too (`types`: alias -> type): adding up changes
  // it (a count's sum is a HUGEINT), and Parquet does not always keep it (carried()).
  const keys = [], aggs = [];
  const typed = (types, alias, expr) => `${types[alias] ? `CAST(${expr} AS ${types[alias]})` : expr} AS "${alias}"`;
  for (const x of outer.items) {
    if (/^g\d+$/.test(x.alias)) { keys.push(types => typed(types, x.alias, `"${x.alias}"`)); continue; }
    const merge = /^a\d+$/.test(x.alias) && mergeOf(x.expr);
    if (!merge || (inner && !/^SUM\s*\(/i.test(x.expr))) return null;
    aggs.push(types => typed(types, x.alias, merge(`"${x.alias}"`)));
  }
  if (!aggs.length) return null;
  return {
    table,
    partialSql: `${body.slice(0, at)}p_${table}${body.slice(at + 2 + table.length)}`,
    merged: (source, types) => `SELECT ${[...keys, ...aggs].map(c => c(types)).join(', ')} FROM ${source}${keys.length ? ' GROUP BY ALL' : ''}`,
  };
}

const lit = s => `'${String(s).replace(/'/g, "''")}'`;

// A partial as it is copied to Parquet, which has no HUGEINT (it would write a DOUBLE): those
// columns go as DECIMAL(38, 0), and the final statement casts them back. `types`: column -> type,
// as DESCRIBE says of the partial.
export function carried(partialSql, types) {
  const huge = Object.keys(types).filter(c => /^U?HUGEINT$/i.test(types[c]));
  if (!huge.length) return partialSql;
  return `SELECT * REPLACE (${huge.map(c => `CAST("${c}" AS DECIMAL(38, 0)) AS "${c}"`).join(', ')}) FROM (${partialSql})`;
}

// The statement split, or null when nothing of it can be:
//   parts      [{ cte, table, partialSql }], each to run on every engine over its share of `table`
//   finalSql   (filesOf: cte -> the Parquet files its partial answers are in,
//               typesOf: cte -> its columns' types, when known) -> the statement that reads
//              them, for one engine
export function splitPlan(sql, large) {
  // The source the compiler writes in front, as a comment.
  const head = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*/.exec(sql)[0].length;
  const w = /^WITH\s+/i.exec(sql.slice(head));
  if (!w) return null;
  const ctes = [];
  let i = head + w[0].length;
  for (;;) {
    const m = /^([A-Za-z_]\w*)\s+AS\s+(?:MATERIALIZED\s+)?\(/i.exec(sql.slice(i));
    if (!m) return null;
    const open = i + m[0].length - 1, close = closeOf(sql, open);
    if (close < 0) return null;
    ctes.push({ cte: m[1], from: open + 1, to: close });
    const next = /^\s*,\s*/.exec(sql.slice(close + 1));
    if (!next) break;
    i = close + 1 + next[0].length;
  }
  let parts = ctes.map(c => ({ ...c, ...splitBody(sql.slice(c.from, c.to), large) })).filter(c => c.table);
  // A table the statement reads anywhere else too is read whole there: none of its CTEs is split.
  const text = flat(sql.slice(head), false);
  parts = parts.filter(p => [...text.matchAll(new RegExp(`\\bv_${p.table}\\b`, 'g'))].length === parts.filter(o => o.table === p.table).length);
  if (!parts.length) return null;
  return {
    parts: parts.map(({ cte, table, partialSql }) => ({ cte, table, partialSql })),
    finalSql: (filesOf, typesOf = () => ({})) => parts.reduceRight((s, p) =>
      s.slice(0, p.from) + p.merged(`read_parquet([${filesOf(p.cte).map(lit).join(', ')}])`, typesOf(p.cte) ?? {}) + s.slice(p.to), sql),
  };
}

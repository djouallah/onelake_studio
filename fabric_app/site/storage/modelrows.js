// =============================================================================
// modelrows.js — how much of a semantic model's answer storage/modeldata.js asks for
// =============================================================================
// A query's rows are cut on the semantic model, not in this browser: a preview of 100 rows asks
// for 100, not for the whole answer. A count is counted there. And an answer cut short, by the
// page's own cap or by the one executeQueries puts on an answer, says so (`truncated`), as the
// DuckDB app's does. All of it over the DAX query's syntax tree (dax-sql's parser.js), with
// nothing imported, so it is tested without the site.
//
//   firstRows(q, n)        the query, its table cut to its first n rows (TOPN)
//   counting(q)            the query, counting its table's rows (COUNTROWS)
//   kept(rows, columns, o) what an answer keeps, and whether rows were left out of it
// =============================================================================

export const MAX_ROWS = 100_000;   // the most rows one answer keeps
// executeQueries' cap on one answer, which the connector runs on: 100,000 rows or 1,000,000
// values, whichever comes first. An answer that reaches it may have been cut.
const CAP_ROWS = 100_000, CAP_VALUES = 1_000_000;
const capOf = columns => Math.min(CAP_ROWS, Math.floor(CAP_VALUES / Math.max(1, columns)));

// The DAX tree's nodes (parser.js).
const call = (fn, ...args) => ({ k: "call", fn, args });
const ref = name => ({ k: "col", table: null, name });

// The columns of a table dax-sql's sqlToDax writes, as a row of it names them: SUMMARIZECOLUMNS'
// groups and the names it gives, SELECTCOLUMNS' names, through the FILTER, CALCULATETABLE and TOPN
// around them. null for any other table (ROW is one row, and needs no cut).
function columnsOf(e) {
  if (e?.k !== "call") return null;
  const fn = String(e.fn).toUpperCase();
  if (fn === "FILTER" || fn === "CALCULATETABLE") return columnsOf(e.args[0]);
  if (fn === "TOPN") return columnsOf(e.args[1]);
  if (fn === "SELECTCOLUMNS") {
    const names = e.args.slice(1).filter((_, i) => i % 2 === 0);
    return names.length && names.every(n => n.k === "str") ? names.map(n => ref(n.v)) : null;
  }
  if (fn === "SUMMARIZECOLUMNS") {
    const out = [];
    for (let i = 0; i < e.args.length; i++) {
      const a = e.args[i];
      if (a.k === "col") out.push(a);
      else if (a.k === "str") { out.push(ref(a.v)); i++; }
      else return null;   // a ROLLUPADDISSUBTOTAL, which dax-sql puts under SELECTCOLUMNS
    }
    return out.length ? out : null;
  }
  return null;
}

// One EVALUATE and nothing defined: what sqlToDax writes. Its table, or null.
const onlyTable = q => (q && q.evaluates.length === 1 && !q.defines.length ? q.evaluates[0] : null);

// The query with its table cut to its first `n` rows: TOPN, in the query's ORDER BY and then every
// column, so the rows TOPN keeps tied with the n-th are only rows equal in every column. null when
// its table isn't one this knows the columns of.
export function firstRows(q, n) {
  const ev = onlyTable(q);
  const cols = ev && columnsOf(ev.e);
  if (!cols) return null;
  const order = [...ev.order, ...cols.map(e => ({ e, desc: false }))];
  const e = call("TOPN", { k: "num", v: String(n) }, ev.e, ...order.flatMap(o => [o.e, { k: "name", name: o.desc ? "DESC" : "ASC" }]));
  return { defines: [], evaluates: [{ ...ev, e }] };
}

// The query counting its table's rows, on the semantic model: one row, "cnt". null when it is not
// one query.
export function counting(q) {
  const ev = onlyTable(q);
  if (!ev) return null;
  return { defines: [], evaluates: [{ e: call("ROW", { k: "str", v: "cnt" }, call("COUNTROWS", ev.e)), order: [], start: [] }] };
}

// What an answer keeps: `n` rows past `from`, where `n` is the rows the query asks for (`asked`,
// Infinity for all of them), MAX_ROWS at most. `askedFor`: the rows its DAX was cut to (null: not
// cut). `truncated` when the query has rows the answer leaves out, past MAX_ROWS or past
// executeQueries' cap; `limit`, then, the most it could keep.
export function kept(rows, columns, { from = 0, n, asked, askedFor = null }) {
  const cap = capOf(columns);
  // executeQueries stopped first: rows past it were never sent.
  const capped = rows.length >= cap && (askedFor == null || rows.length < askedFor);
  const out = rows.slice(from, from + n);
  const truncated = out.length < asked && (rows.length > from + n || capped);
  return { rows: out, truncated, limit: capped ? Math.max(0, Math.min(n, cap - from)) : n };
}

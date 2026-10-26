// =============================================================================
// analyze/query.js — Explore's queries as DAX over the semantic model, and the DAX as SQL
// =============================================================================
// Ported from analytics-as-code's dashboard (semantic/query.js), made a factory: one per
// .bim, over the compiler semantic.js builds for it. Two steps, as in Power BI:
//   toDax(query)   Explore's query (an object of the model's fields: select, where, having,
//                  totals, orderBy, top) as DAX, each column and measure checked against
//                  the model. A column is "Table.Column", a measure its name.
//   toSQL(dax)     the DAX as one SELECT over the model's tables, by dax-sql: DAX's filter
//                  context, context transition, relationships and blanks. What comes back
//                  is cast as the browser wants it: a date as text, a whole number as
//                  INTEGER, a number as DOUBLE (the compiler semantic.js builds for Explore).
// Names are quoted as DAX quotes them, so a table called 'Internet Sales' or a measure with
// a ] in it is a name like any other.
// =============================================================================

const TYPES = { string: 'string', int64: 'int', double: 'double', decimal: 'double', dateTime: 'date', boolean: 'bool',
  binary: 'string', variant: 'string' };

// A column's summaries, by the word a query uses for each. COUNTA counts a column of any type.
const AGG_DAX = { sum: 'SUM', avg: 'AVERAGE', median: 'MEDIAN', min: 'MIN', max: 'MAX', count: 'COUNTA', distinct: 'DISTINCTCOUNT' };

const tableRef = t => `'${String(t).replace(/'/g, "''")}'`;
const bracket = n => `[${String(n).replace(/]/g, ']]')}]`;
const text = s => `"${String(s).replace(/"/g, '""')}"`;

// `model`: the TMSL model (model.js's tmslOf); `compiler`: dax-sql's, over the same model.
export function createModelQuery(model, compiler) {
  const TABLES = new Map(model.tables.map(t => [t.name, new Map(t.columns.map(c => [c.name,
    { name: c.name, type: TYPES[c.dataType] ?? 'string' }]))]));
  const MEASURES = new Set(model.tables.flatMap(t => t.measures.map(m => m.name)));
  const RELS = model.relationships.map(r => ({ to: r.toTable, toColumn: r.toColumn }));
  // Longest table name first: "Sales.Region.Name" is Sales.Region's Name if there is one.
  const BY_LENGTH = [...TABLES.keys()].sort((a, b) => b.length - a.length);

  function field(f) {
    if (typeof f === 'string') {
      for (const t of BY_LENGTH) {
        if (!f.startsWith(`${t}.`)) continue;
        const c = TABLES.get(t).get(f.slice(t.length + 1));
        if (c) return { table: t, name: c.name, type: c.type, dax: `${tableRef(t)}${bracket(c.name)}` };
      }
    }
    throw new Error(`query: ${JSON.stringify(f)} is not a column of the model`);
  }
  const isCol = f => { try { field(f); return true; } catch { return false; } };

  function daxValue(v, col) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
    if (typeof v !== 'string') throw new Error(`query: ${JSON.stringify(v)} is not a value`);
    if (col.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `dt"${v}"`;
    return text(v);
  }
  // A condition as the filter arguments of a CALCULATETABLE (a range is two of them).
  function daxFilters(c) {
    if (!Array.isArray(c)) {
      if (!Array.isArray(c?.any) || !c.any.length) throw new Error(`query: ${JSON.stringify(c)} is not a condition`);
      return [`(${c.any.map(x => daxFilters(x).join(' && ')).join(' || ')})`];
    }
    const [f, op, ...v] = c, col = field(f), val = x => daxValue(x, col), d = col.dax;
    switch (op) {
      case '=': case '<>': case '<': case '<=': case '>': case '>=': return [`${d} ${op} ${val(v[0])}`];
      case 'between': return [`${d} >= ${val(v[0])}`, `${d} <= ${val(v[1])}`];
      case 'in':
        if (!Array.isArray(v[0]) || !v[0].length) throw new Error(`query: ${f} in needs a list of values`);
        return [`${d} IN {${v[0].map(val).join(', ')}}`];
      case 'notIn':
        if (!Array.isArray(v[0]) || !v[0].length) throw new Error(`query: ${f} notIn needs a list of values`);
        return [`NOT (${d} IN {${v[0].map(val).join(', ')}})`];
      case 'blank': return [`ISBLANK(${d})`];
      case 'notBlank': return [`NOT ISBLANK(${d})`];
    }
    throw new Error(`query: ${op} is not a condition`);
  }

  function toDax(q) {
    const entries = Object.entries(q.select ?? {});
    if (!entries.length) throw new Error('query: select names nothing');
    const known = new Set(['select', 'where', 'having', 'totals', 'orderBy', 'top']);
    for (const k of Object.keys(q)) if (!known.has(k)) throw new Error(`query: ${k} is not a word of a query`);
    const value = f => {
      if (typeof f === 'string') {
        if (!MEASURES.has(f)) throw new Error(`query: the model has no measure ${f}`);
        return bracket(f);
      }
      // A column summarised, as Power BI does a column dropped on Values: { sum: 'T.c' }.
      const [fn, c] = Object.entries(f ?? {})[0] ?? [];
      if (!AGG_DAX[fn] || Object.keys(f).length !== 1) throw new Error(`query: ${JSON.stringify(f)} is not a field`);
      return `${AGG_DAX[fn]}(${field(c).dax})`;
    };
    const cols = entries.filter(([, f]) => isCol(f)).map(([n, f]) => [n, field(f)]);
    const values = entries.filter(([, f]) => !isCol(f));
    const totals = Object.entries(q.totals ?? {}).map(([n, cs]) => [n, cs.map(field)]);
    const rolled = new Set(totals.flatMap(([, cs]) => cs.map(c => c.dax)));
    for (const c of rolled) if (!cols.some(([, f]) => f.dax === c)) throw new Error(`query: a total over ${c}, which is not selected`);
    const pairs = values.map(([n, f]) => `${text(n)}, ${value(f)}`);
    let t;
    if (cols.length) {
      const keys = [...cols.map(([, f]) => f.dax).filter(d => !rolled.has(d)),
        ...totals.map(([n, cs]) => `ROLLUPADDISSUBTOTAL(${cs.length > 1 ? `ROLLUPGROUP(${cs.map(c => c.dax).join(', ')})` : cs[0].dax}, ${text(n)})`)];
      t = `SUMMARIZECOLUMNS(${[...keys, ...pairs].join(', ')})`;
    } else {
      if (totals.length) throw new Error('query: totals need a column to group by');
      t = `ROW(${pairs.join(', ')})`;
    }
    // A dimension's columns alone: not its blank row.
    const blankRows = values.length ? [] : [...new Set(cols.map(([, f]) => f.table))]
      .map(table => RELS.find(r => r.to === table)).filter(Boolean).map(r => `NOT ISBLANK(${tableRef(r.to)}${bracket(r.toColumn)})`);
    const where = [...new Set([...(q.where ?? []).flatMap(daxFilters), ...blankRows])];
    if (where.length) t = `CALCULATETABLE(${t}, ${where.join(', ')})`;
    // A column comes out under its own name: SELECTCOLUMNS gives it the select's.
    if (new Set(cols.map(([, f]) => f.name)).size < cols.length) throw new Error('query: two columns of the same name');
    if (cols.some(([n, f]) => n !== f.name))
      t = `SELECTCOLUMNS(${t}, ${[...entries.map(([n, f]) => `${text(n)}, ${bracket(isCol(f) ? field(f).name : n)}`),
        ...totals.map(([n]) => `${text(n)}, ${bracket(n)}`)].join(', ')})`;
    const names = new Set([...entries.map(([n]) => n), ...totals.map(([n]) => n)]);
    const name = n => { if (!names.has(n)) throw new Error(`query: ${n} is not a name of the select`); return bracket(n); };
    const having = (q.having ?? []).map(([n, op, v]) => {
      if (op === 'notBlank') return `NOT ISBLANK(${name(n)})`;
      if (!['=', '<>', '<', '<=', '>', '>='].includes(op) || typeof v !== 'number') throw new Error(`query: having ${n} ${op} ${v}`);
      return `${name(n)} ${op} ${v}`;
    });
    if (having.length) t = `FILTER(${t}, ${having.join(' && ')})`;
    const order = (q.orderBy ?? []).map(o => Array.isArray(o) ? o : [o]).map(([n, dir]) => {
      if (dir != null && dir !== 'desc') throw new Error(`query: order ${dir}`);
      return `${name(n)}${dir ? ' DESC' : ''}`;
    });
    if (q.top != null) {
      if (!Number.isInteger(q.top) || !order.length) throw new Error('query: top needs a whole number and an orderBy');
      t = `TOPN(${q.top}, ${t}, ${order[0].replace(/ DESC$/, '')}, ${order[0].endsWith(' DESC') ? 'DESC' : 'ASC'})`;
    }
    return `EVALUATE ${t}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}`;
  }

  // A DAX query as SQL. The same text is translated once.
  const translated = new Map();
  function toSQL(dax) {
    let sql = translated.get(dax);
    if (sql) return sql;
    sql = compiler.compile(dax).sql;
    if (translated.size >= 500) translated.clear();
    translated.set(dax, sql);
    return sql;
  }

  return { toDax, toSQL };
}

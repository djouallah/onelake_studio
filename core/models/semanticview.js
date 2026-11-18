'use strict';
// =============================================================================
// semanticview.js — a semantic model as a Fabric semantic view, written as Fabric reads one
// =============================================================================
// Fabric's lakehouse semantic views are YAML in <lakehouse>/Context/Semantic Views/<view>/, which Fabric's
// Publish compiles into TMDL (SystemContext/) and a read-only Direct Lake model named after the folder.
// Its format, exactly, is https://learn.microsoft.com/en-us/fabric/fundamentals/semantic-views-yaml-reference:
// version 0.2.0.dev0; datasets name a table of that lakehouse, schema.table, and no columns (Fabric reads
// them from the table); relationships are one column each and all active; metrics are DAX, and Fabric puts
// them in a table of its own, Metrics. Nothing else is written: Fabric refuses what it does not read.
//
// Fabric has no way yet to make a view from a model, so this does it: a Direct Lake model's TMSL (Fabric's
// model.bim, its tables placed in OneLake by GUIDs) -> the view's one file, and what had no place in it.
// A model that is not Direct Lake on one lakehouse is refused, with why.
// =============================================================================

const VERSION = '0.2.0.dev0';
const lc = s => String(s ?? '').toLowerCase();
const textOf = e => (Array.isArray(e) ? e.join('\n') : String(e ?? ''));

// Every reference a DAX expression makes, with where it is: 'T'[c] or T[c] { table, column }, [x] { name },
// and a quoted 'T' alone { table }. Strings and comments are skipped, so nothing in them is taken for one.
function daxRefs(dax) {
  const s = String(dax), out = [];
  let i = 0;
  const bracket = at => {   // [ … ] with ]] for ], from `at` (on the '['): { name, end }
    let j = at + 1, name = '';
    for (; j < s.length; j++) {
      if (s[j] === ']') { if (s[j + 1] === ']') { name += ']'; j++; continue; } break; }
      name += s[j];
    }
    return { name, end: j + 1 };
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && !(s[i] === '"' && s[i + 1] !== '"')) i += s[i] === '"' ? 2 : 1; i++; continue; }
    if ((c === '/' && s[i + 1] === '/') || (c === '-' && s[i + 1] === '-')) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "'") {
      let j = i + 1, name = '';
      for (; j < s.length; j++) {
        if (s[j] === "'") { if (s[j + 1] === "'") { name += "'"; j++; continue; } break; }
        name += s[j];
      }
      const end = j + 1;
      if (s[end] === '[') { const b = bracket(end); out.push({ table: name, column: b.name, start: i, end: b.end }); i = b.end; }
      else { out.push({ table: name, start: i, end }); i = end; }
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[\w.]/.test(s[i - 1] || '')) {
      let j = i;
      while (j < s.length && /[\w]/.test(s[j])) j++;
      if (s[j] === '[') { const b = bracket(j); out.push({ table: s.slice(i, j), column: b.name, start: i, end: b.end }); i = b.end; continue; }
      let k = j;
      while (/\s/.test(s[k] || '')) k++;
      // A word before '(' is a function's name, never a table's.
      out.push({ word: s.slice(i, j), call: s[k] === '(', start: i, end: j });
      i = j;
      continue;
    }
    if (c === '[') { const b = bracket(i); out.push({ name: b.name, start: i, end: b.end }); i = b.end; continue; }
    i++;
  }
  return out;
}

// A table and a column as DAX writes them.
const daxTable = t => `'${String(t).replace(/'/g, "''")}'`;
const daxColumn = c => `[${String(c).replace(/]/g, ']]')}]`;

/**
 * The view of a model: { lake: { workspace, item } (GUIDs), doc, dropped: [string] }, or { refused } saying why
 * there can be none. `bim`: the model's TMSL, its expressions OneLake URLs (sqlendpoint.js readFromOneLake);
 * `name`: the view's, which Publish gives the model it makes; `semantic`: page/semantic.js.
 */
function viewOf(bim, name, semantic) {
  const tables = bim?.model?.tables ?? [];
  const mode = semantic.storageMode(bim);
  if (!/^Direct Lake on 1 lakehouses$/.test(mode)) {
    return { refused: /^Direct Lake on \d+ lakehouses$/.test(mode)
      ? `${name} reads ${mode.replace(/^Direct Lake on /, '')}: a semantic view reads one lakehouse, the one it is in`
      : `${name} is ${/^an? /.test(mode) ? mode : `on ${mode}`}: a semantic view is Direct Lake on its own lakehouse's tables` };
  }
  const placed = semantic.directLakeTables(bim);
  const dropped = [];
  const drop = what => { if (!dropped.includes(what)) dropped.push(what); };
  const count = new Map();
  const tally = what => count.set(what, (count.get(what) || 0) + 1);
  let lake = null;

  // The tables a view can hold, each with its columns as the lake names them: name -> source column.
  const kept = new Map();       // lc(table) -> { table, columns: Map(lc(column) -> sourceColumn) }
  const gone = new Map();       // lc(table) -> why, for a table that has no place
  const calculated = new Set(); // lc(column), of the calculated columns that have no place
  const datasets = [];
  for (const t of tables) {
    const at = placed.get(lc(t.name));
    // A table of measures alone (Fabric's own Metrics is one) holds nothing a view loses: its measures are metrics.
    if (!at && !(t.partitions ?? []).length && !(t.columns ?? []).some(c => c.type !== 'rowNumber')) continue;
    if (!at || !at.lh) { gone.set(lc(t.name), `table ${t.name}`); drop(`table ${t.name} (${t.partitions?.[0]?.source?.type === 'calculated' ? 'a calculated table' : 'not a table of the lakehouse'})`); continue; }
    lake = lake || at.lh;
    const columns = new Map();
    for (const c of t.columns ?? []) {
      if (c.type === 'calculated' || c.type === 'calculatedTableColumn' || c.expression != null) {
        drop(`calculated column ${t.name}[${c.name}]`);
        calculated.add(lc(c.name));
        continue;
      }
      if (c.type === 'rowNumber') continue;
      columns.set(lc(c.name), c.sourceColumn || c.name);
      if (c.isHidden) tally('hidden columns');
      if (c.formatString) tally('column format strings');
      if (c.sortByColumn) tally('sort-by columns');
      if (c.dataCategory) tally('data categories');
      if (c.displayFolder) tally('display folders');
      if (c.description) tally('column descriptions');
    }
    kept.set(lc(t.name), { table: t.name, columns });
    const d = { name: t.name, source: `${at.t.schema || 'dbo'}.${at.t.table}` };
    if (t.description) d.description = String(t.description);
    datasets.push(d);
    if (t.isHidden) tally('hidden tables');
    (t.hierarchies ?? []).forEach(() => tally('hierarchies'));
    if (t.calculationGroup) drop(`calculation group ${t.name}`);
  }
  if (!datasets.length) return { refused: `${name} has no table of a lakehouse` };
  if (kept.has('metrics')) {
    return { refused: `${name} has a table named Metrics, the name Fabric gives the table of a view's metrics` };
  }

  // A reference to a column the view has, as the lake names it; null for one it has not.
  const columnOf = (table, column) => {
    const k = kept.get(lc(table));
    if (!k) return null;
    const source = k.columns.get(lc(column));
    return source == null ? null : { table: k.table, column: source };
  };

  const relationships = [];
  for (const r of bim?.model?.relationships ?? []) {
    const label = `${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}]`;
    if (r.isActive === false) { drop(`inactive relationship ${label}`); continue; }
    const from = columnOf(r.fromTable, r.fromColumn), to = columnOf(r.toTable, r.toColumn);
    if (!from || !to) { drop(`relationship ${label} (one of its columns is not in the view)`); continue; }
    if (r.crossFilteringBehavior === 'bothDirections') tally('both-directions filtering');
    if (r.fromCardinality === 'many' && r.toCardinality === 'many') tally('many-to-many cardinality');
    relationships.push({ name: r.name || `${from.table}_to_${to.table}`, from: from.table, to: to.table,
                         from_columns: [from.column], to_columns: [to.column] });
  }

  // Every measure, wherever the model kept it: a view's metrics are the model's, in Fabric's Metrics table.
  const measures = tables.flatMap(t => (t.measures ?? []).map(m => ({ ...m, home: t.name })));
  const names = new Set(measures.map(m => lc(m.name)));
  if (names.size !== measures.length) {
    const seen = new Set();
    const twice = measures.find(m => (seen.has(lc(m.name)) ? true : (seen.add(lc(m.name)), false)));
    return { refused: `${name} has two measures named ${twice.name} (in different tables): a view's metrics share one table` };
  }
  // A measure that names something the view has not, or a measure it can't keep, can't be kept either.
  const why = new Map();
  const rewritten = new Map();
  for (const m of measures) {
    const dax = textOf(m.expression);
    let out = '', at = 0, bad = null;
    for (const ref of daxRefs(dax)) {
      if (ref.column != null) {
        const col = columnOf(ref.table, ref.column);
        if (!col) { bad = bad || `${ref.table}[${ref.column}]`; continue; }
        out += dax.slice(at, ref.start) + daxTable(col.table) + daxColumn(col.column);
        at = ref.end;
      } else if (ref.table != null) {
        if (!kept.has(lc(ref.table))) bad = bad || `'${ref.table}'`;
      } else if (ref.word != null) {
        if (!ref.call && gone.has(lc(ref.word)) && !kept.has(lc(ref.word))) bad = bad || ref.word;
      } else if (ref.name != null && !names.has(lc(ref.name))) {
        // [x] alone, not a measure: a column of the row in context, as the lake names it.
        const source = [...kept.values()].map(k => k.columns.get(lc(ref.name))).find(v => v != null);
        if (source != null) { out += dax.slice(at, ref.start) + daxColumn(source); at = ref.end; }
        else if (calculated.has(lc(ref.name))) bad = bad || `[${ref.name}]`;
      }
    }
    out += dax.slice(at);
    if (bad) why.set(lc(m.name), `it names ${bad}, which is not in the view`);
    rewritten.set(lc(m.name), out);
    if (m.formatString || m.formatStringDefinition) tally('measure format strings');
    if (m.displayFolder) tally('display folders');
    if (m.isHidden) tally('hidden measures');
    if (m.kpi) tally('KPIs');
  }
  // A measure that names one that was not kept goes too, until nothing more goes.
  for (let changed = true; changed;) {
    changed = false;
    for (const m of measures) {
      if (why.has(lc(m.name))) continue;
      const on = daxRefs(rewritten.get(lc(m.name))).find(r => r.name != null && why.has(lc(r.name)));
      if (on) { why.set(lc(m.name), `it uses [${on.name}], which is not in the view`); changed = true; }
    }
  }
  const metrics = [];
  for (const m of measures) {
    if (why.has(lc(m.name))) { drop(`measure [${m.name}]: ${why.get(lc(m.name))}`); continue; }
    const x = { name: m.name };
    if (m.description) x.description = String(m.description);
    x.expression = { dialects: [{ dialect: 'DAX', expression: rewritten.get(lc(m.name)) }] };
    metrics.push(x);
  }

  for (const r of bim?.model?.roles ?? []) drop(`role ${r.name}`);
  for (const p of bim?.model?.perspectives ?? []) drop(`perspective ${p.name}`);
  if ((bim?.model?.cultures ?? []).some(c => c.translations)) drop('translations');
  for (const [what, n] of count) dropped.push(`${n} ${n === 1 ? what.replace(/s$/, '').replace(/ie$/, 'y') : what}`);

  const doc = { version: VERSION, name };
  if (bim?.model?.description) doc.description = String(bim.model.description);
  doc.datasets = datasets;
  if (relationships.length) doc.relationships = relationships;
  if (metrics.length) doc.metrics = metrics;
  return { lake, doc, dropped };
}

// The view's folder, and its one file, as Fabric's New semantic view names them.
const viewDir = name => `Semantic Views/${name}`;
const viewFile = name => `${viewDir(name)}/${name}_semantic_view.yaml`;

// The first of name, name (2), name (3)… that is not one of `taken` (names in Context/Semantic Views/).
function freeName(name, taken) {
  const has = new Set([...taken].map(lc));
  if (!has.has(lc(name))) return name;
  for (let n = 2; ; n++) if (!has.has(lc(`${name} (${n})`))) return `${name} (${n})`;
}

module.exports = { VERSION, viewOf, viewDir, viewFile, freeName, daxRefs };

// =============================================================================
// tmdl.js — a semantic model written as TMDL, read as the TMSL the rest of OneLake Studio takes
// =============================================================================
// TMDL (https://learn.microsoft.com/en-us/analysis-services/tmdl/tmdl-overview) is the model of a TMSL file
// written as indented text: an object per line (`table sales`, `measure 'Total' = SUM(…)`), its properties
// one level deeper (`dataType: int64`), a `///` line the description of the object after it, and an
// expression on the object's line or on the lines below, one level past its properties. Fabric writes one
// when it publishes a semantic view: SystemContext/Semantic Views/<view>/<view>.tmdl, the whole model in one
// file, inside a script (`createOrReplace`, then `database <name>`, then `model Model`).
//
// Read here, by hand and with nothing loaded: the objects a model's pages use (tables, their columns, measures,
// partitions and hierarchies; relationships; expressions) become TMSL's, with their properties as written.
// What the pages have no use for (annotations, roles, perspectives, cultures, lineage tags) is left out.
// =============================================================================

// Properties that only tie an object to where it came from: no page reads them.
const LINEAGE = new Set(['lineageTag', 'sourceLineageTag', 'changedProperty']);
// Properties TMSL holds as numbers.
const NUMBERS = new Set(['compatibilityLevel', 'ordinal']);

// A line's depth, by its leading tabs (four spaces count as one, should a file use spaces).
function depthOf(line) {
  const lead = /^[\t ]*/.exec(line)[0];
  let tabs = 0, spaces = 0;
  for (const c of lead) { if (c === '\t') tabs++; else spaces++; }
  return tabs + Math.floor(spaces / 4);
}

// A property's value as TMSL has it: a quoted string unquoted, true and false as booleans.
function valueOf(v) {
  const s = String(v).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  const q = /^"((?:[^"]|"")*)"$/.exec(s);
  if (q) return q[1].replace(/""/g, '"');
  const sq = /^'((?:[^']|'')*)'$/.exec(s);
  if (sq) return sq[1].replace(/''/g, "'");
  return s;
}

// A name at the start of `s`: 'quoted' (with '' for ') or bare, up to a space or `=`. { name, rest }.
function nameAt(s) {
  if (s.startsWith("'")) {
    let i = 1, name = '';
    for (; i < s.length; i++) {
      if (s[i] === "'") { if (s[i + 1] === "'") { name += "'"; i++; continue; } break; }
      name += s[i];
    }
    return { name, rest: s.slice(i + 1).trim() };
  }
  const m = /^[^\s=]+/.exec(s);
  return { name: m ? m[0] : '', rest: s.slice(m ? m[0].length : 0).trim() };
}

/**
 * The lines of an expression that goes on below line `i`: those at `min` depth or deeper (blank lines between
 * them kept), or, after a ``` line, up to the closing ```. Their common indentation is taken off, what is past it
 * kept. { text, next }: `next` is the line after the expression.
 */
function expressionBelow(lines, i, min, fenced) {
  const body = [];
  let j = i + 1;
  if (fenced) {
    for (; j < lines.length && lines[j].trim() !== '```'; j++) body.push(lines[j]);
    j++;
  } else {
    // Up to the last line at `min` depth or deeper: blank lines after it belong to what follows.
    let last = i;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (depthOf(lines[j]) < min) break;
      last = j;
    }
    body.push(...lines.slice(i + 1, last + 1));
    j = last + 1;
  }
  const lead = Math.min(...body.filter(l => l.trim()).map(l => /^\t*/.exec(l)[0].length));
  const text = body.map(l => (l.trim() ? l.slice(Number.isFinite(lead) ? lead : 0) : '')).join('\n');
  return { text, next: j };
}

// The file as a tree of objects: { type, name, value, description, props, kids }, the root's type '(root)'.
function parseTree(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const root = { type: '(root)', props: {}, kids: [] };
  const stack = [{ node: root, depth: -1 }];
  let description = [];
  const nextDepth = i => {
    for (let k = i + 1; k < lines.length; k++) if (lines[k].trim()) return depthOf(lines[k]);
    return -1;
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const s = line.trim();
    if (!s) { i++; continue; }
    const d = depthOf(line);
    if (s.startsWith('///')) { description.push(s.slice(3).replace(/^ /, '')); i++; continue; }
    if (s.startsWith('//')) { i++; continue; }
    while (stack[stack.length - 1].depth >= d) stack.pop();
    const parent = stack[stack.length - 1].node;
    // A value on its line, or written below it (an expression, on the lines at `deeper` depth or past it). A
    // property's is unquoted; an object's is its expression, kept as written ("x" is a DAX string).
    const below = (deeper, v, asProperty = true) => {
      const fenced = v === '```';
      if (v && !fenced) return { value: asProperty ? valueOf(v) : v, next: i + 1 };
      const e = expressionBelow(lines, i, deeper, fenced);
      return { value: e.text, next: e.next };
    };
    // key: value — a property of the object it is under.
    const prop = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(s);
    if (prop) {
      const { value, next } = below(d + 1, prop[2].trim());
      parent.props[prop[1]] = NUMBERS.has(prop[1]) && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
      i = next;
      continue;
    }
    const word = /^([A-Za-z_]\w*)\s*/.exec(s);
    if (!word) { i++; continue; }
    const rest = s.slice(word[0].length);
    // key = expression — a property written as an expression (a partition's `source = …`).
    if (rest.startsWith('=')) {
      const { value, next } = below(d + 1, rest.slice(1).trim());
      parent.props[word[1]] = value;
      i = next;
      continue;
    }
    // A word alone: an object when lines go on below it (`source`, `createOrReplace`), else a flag that is set.
    if (!rest) {
      if (nextDepth(i) > d) {
        const node = { type: word[1], name: null, value: null, description: description.join('\n') || null, props: {}, kids: [] };
        parent.kids.push(node);
        stack.push({ node, depth: d });
      } else parent.props[word[1]] = true;
      description = [];
      i++;
      continue;
    }
    // type name [= value]: an object, its value (its expression, a partition's kind) on its line or below it.
    const { name, rest: after } = nameAt(rest);
    let value = null, next = i + 1;
    if (after.startsWith('=')) ({ value, next } = below(d + 2, after.slice(1).trim(), false));
    const node = { type: word[1], name, value, description: description.join('\n') || null, props: {}, kids: [] };
    description = [];
    parent.kids.push(node);
    stack.push({ node, depth: d });
    i = next;
  }
  return root;
}

const kidsOf = (n, type) => n.kids.filter(k => k.type === type);
function findNode(n, type) {
  for (const k of n.kids) {
    if (k.type === type) return k;
    const found = findNode(k, type);
    if (found) return found;
  }
  return null;
}
// An object's own properties as TMSL's, lineage left out, and its description.
function propsOf(n, skip = []) {
  const out = {};
  for (const [k, v] of Object.entries(n.props)) if (!LINEAGE.has(k) && !skip.includes(k)) out[k] = v;
  if (n.description) out.description = n.description;
  return out;
}
const some = list => (list.length ? list : undefined);

// 'Table name'.'column' or table.column: { table, column }.
function columnRef(ref) {
  const s = String(ref).trim();
  // A bare table name ends at the dot; a quoted one may hold dots.
  const { name: table, rest } = s.startsWith("'") ? nameAt(s) : { name: s.split('.')[0], rest: s.slice(s.split('.')[0].length) };
  return { table, column: rest.startsWith('.') ? nameAt(rest.slice(1)).name : '' };
}

function column(n) {
  return { name: n.name, ...(n.value != null ? { type: 'calculated', expression: n.value } : {}), ...propsOf(n) };
}
function measure(n) {
  return { name: n.name, expression: n.value ?? '', ...propsOf(n) };
}
function partition(n) {
  const kind = n.value || 'm';
  const holder = kidsOf(n, 'source')[0];
  const source = holder ? { type: kind, ...propsOf(holder) }
    : { type: kind, ...(n.props.source != null ? { expression: n.props.source } : {}) };
  return { name: n.name, ...propsOf(n, ['source']), source };
}
function hierarchy(n) {
  return { name: n.name, ...propsOf(n), levels: kidsOf(n, 'level').map(l => ({ name: l.name, ...propsOf(l) })) };
}
function table(n) {
  return {
    name: n.name, ...propsOf(n),
    columns: kidsOf(n, 'column').map(column),
    measures: some(kidsOf(n, 'measure').map(measure)),
    hierarchies: some(kidsOf(n, 'hierarchy').map(hierarchy)),
    partitions: some(kidsOf(n, 'partition').map(partition)),
  };
}
function relationship(n) {
  const from = columnRef(n.props.fromColumn ?? ''), to = columnRef(n.props.toColumn ?? '');
  return { name: n.name, ...propsOf(n, ['fromColumn', 'toColumn']),
           fromTable: from.table, fromColumn: from.column, toTable: to.table, toColumn: to.column };
}
function expression(n) {
  return { name: n.name, kind: 'm', ...propsOf(n), expression: n.value ?? '' };
}
const defined = o => JSON.parse(JSON.stringify(o));   // undefined fields gone, as a TMSL file has none

/**
 * A TMDL model as TMSL: { name, compatibilityLevel?, model }. The model may be inside a script and a database
 * (as Fabric writes a semantic view's), or at the file's root. A text with no model in it throws.
 */
export function tmdlToTmsl(text) {
  const root = parseTree(text);
  const db = findNode(root, 'database');
  const model = findNode(root, 'model');
  if (!model) throw new Error('this TMDL has no model in it');
  return defined({
    name: (db && db.name) || model.name || 'Model',
    compatibilityLevel: db ? db.props.compatibilityLevel : undefined,
    model: {
      ...propsOf(model),
      tables: kidsOf(model, 'table').map(table),
      relationships: some(kidsOf(model, 'relationship').map(relationship)),
      expressions: some(kidsOf(model, 'expression').map(expression)),
    },
  });
}

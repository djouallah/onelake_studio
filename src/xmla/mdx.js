'use strict';
// =============================================================================
// mdx.js — the MDX Excel's PivotTable writes, as what it asks for
// =============================================================================
// Not an MDX engine. A PivotTable writes a narrow, regular subset (captured from Excel 16 and
// held in test/js/xmla.test.mjs), and what any of it asks for fits a small shape: each axis is
// a list of patterns, and each pattern says, per hierarchy, which depth it reads and which
// members it keeps. So Hierarchize(AddCalculatedMembers({DrilldownLevel({[t].[c].[All]})})) is
// two patterns: the All member, and the first level. One pattern per axis is one grain, which
// one model SELECT answers, and dax-sql computes each measure at that grain.
//
// What does not fit is refused by name, never guessed at: a wrong number looks like a right one.
// =============================================================================
const { resolve } = require('./cube.js');

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') {
      // A whole dotted name: [a].[b].&[c].&[d]
      let j = i;
      for (;;) {
        if (s[j] === '&') j++;
        if (s[j] !== '[') throw new Error(`MDX: a name is cut short at ${s.slice(i, i + 60)}`);
        j++;
        for (;;) {
          if (j >= s.length) throw new Error(`MDX: a name is not closed at ${s.slice(i, i + 60)}`);
          if (s[j] === ']') { if (s[j + 1] === ']') { j += 2; continue; } break; }
          j++;
        }
        j++;
        if (s[j] === '.' && (s[j + 1] === '[' || s[j + 1] === '&')) { j++; continue; }
        if (s[j] === '&' && s[j + 1] === '[') continue;
        break;
      }
      out.push({ t: 'name', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push({ t: 'word', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: 'num', v: s.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ t: 'sym', v: c });
    i++;
  }
  return out;
}

function parser(text) {
  const toks = tokenize(text);
  let p = 0;
  const up = k => toks[p + k]?.v?.toUpperCase();
  const isWord = (w, k = 0) => toks[p + k]?.t === 'word' && up(k) === w;
  const isSym = (w, k = 0) => toks[p + k]?.t === 'sym' && toks[p + k].v === w;
  const eatWord = w => { if (!isWord(w)) throw new Error(`MDX: expected ${w} at "${toks[p]?.v ?? 'the end'}"`); p++; };
  const eatSym = w => { if (!isSym(w)) throw new Error(`MDX: expected ${w} at "${toks[p]?.v ?? 'the end'}"`); p++; };

  function expr() {
    let node = primary();
    while (isSym('.')) {
      p++;
      const t = toks[p++];
      if (t?.t !== 'word') throw new Error(`MDX: a name is expected after . at "${t?.v ?? 'the end'}"`);
      node = { kind: 'suffix', of: node, name: t.v.toUpperCase() };
    }
    return node;
  }
  function list(close) {
    const items = [];
    while (!isSym(close)) {
      if (p >= toks.length) throw new Error(`MDX: ${close} is missing`);
      if (isSym(',')) { p++; items.push(null); continue; }
      items.push(expr());
      if (isSym(',')) p++;
    }
    p++;
    return items;
  }
  function primary() {
    const t = toks[p];
    if (!t) throw new Error('MDX: the statement stops short');
    if (t.t === 'sym' && t.v === '{') { p++; return { kind: 'set', items: list('}') }; }
    if (t.t === 'sym' && t.v === '(') { p++; return { kind: 'tuple', items: list(')') }; }
    if (t.t === 'name') { p++; return { kind: 'name', raw: t.v }; }
    if (t.t === 'num') { p++; return { kind: 'number', name: t.v }; }   // an argument of what's refused by name
    if (t.t === 'word') {
      p++;
      if (isSym('(')) { p++; return { kind: 'call', name: t.v.toUpperCase(), args: list(')') }; }
      return { kind: 'word', name: t.v.toUpperCase() };
    }
    throw new Error(`MDX: "${t.v}" is not something OneLake Studio reads here`);
  }
  // DIMENSION PROPERTIES a, b or CELL PROPERTIES a, b: their names, up to the word that ends them.
  function nameList(stop) {
    const names = [];
    while (p < toks.length && !stop()) {
      const t = toks[p++];
      if (t.t === 'word' || t.t === 'name') names.push(t.v.replace(/^.*\[|\]$/g, '').toUpperCase());
    }
    return names;
  }
  function select() {
    eatWord('SELECT');
    const axes = [];
    while (!isWord('FROM')) {
      if (p >= toks.length) throw new Error('MDX: FROM is missing');
      const nonEmpty = isWord('NON') && isWord('EMPTY', 1);
      if (nonEmpty) p += 2;
      const set = expr();
      let properties = [];
      if (isWord('DIMENSION') || isWord('PROPERTIES')) {
        if (isWord('DIMENSION')) p++;
        eatWord('PROPERTIES');
        properties = nameList(() => isWord('ON'));
      }
      eatWord('ON');
      axes.push({ nonEmpty, set, properties, number: axisNumber() });
      if (isSym(',')) p++;
    }
    p++;
    const from = isSym('(') ? (p++, sub()) : { cube: toks[p++]?.v };
    let where = null;
    if (isWord('WHERE')) { p++; where = expr(); }
    let cellProperties = ['VALUE'];
    if (isWord('CELL')) {
      p++;
      eatWord('PROPERTIES');
      cellProperties = nameList(() => isSym(')'));
    }
    return { axes, from, where, cellProperties };
  }
  function sub() {
    const inner = select();
    eatSym(')');
    return { sub: inner };
  }
  const AXES = { COLUMNS: 0, ROWS: 1, PAGES: 2, CHAPTERS: 3, SECTIONS: 4 };
  function axisNumber() {
    const t = toks[p++];
    if (t?.t === 'num') return Number(t.v);
    if (t?.t === 'word' && t.v.toUpperCase() === 'AXIS') { eatSym('('); const n = Number(toks[p++]?.v); eatSym(')'); return n; }
    const n = t?.t === 'word' ? AXES[t.v.toUpperCase()] : undefined;
    if (n === undefined) throw new Error(`MDX: "${t?.v}" does not name an axis`);
    return n;
  }
  const done = () => p >= toks.length;
  return { select, expr, isWord, done, rest: () => toks[p]?.v };
}

/** A SELECT's parts. Throws on anything but a SELECT. */
function parseSelect(text) {
  const ps = parser(text);
  if (ps.isWord('WITH')) throw new Error('Calculated members and sets written in Excel are not supported by OneLake Studio.');
  if (ps.isWord('DRILLTHROUGH')) throw new Error('Show Details is not supported by OneLake Studio.');
  if (!ps.isWord('SELECT')) throw new Error(`OneLake Studio reads SELECT statements only, not "${ps.rest()}".`);
  const q = ps.select();
  if (!ps.done()) throw new Error(`MDX: "${ps.rest()}" is not something OneLake Studio reads here`);
  return q;
}
const parseSet = text => parser(text).expr();

// -----------------------------------------------------------------------------
// A set as patterns. An entry is { measures: [...] } or { h, depth, paths }: paths null keeps
// every member at that depth, else the members under any of those key paths.
// -----------------------------------------------------------------------------
const entryKey = e => (e.measures ? `m|${e.measures.map(m => m.unique).join('\0')}` : `h|${e.h.unique}|${e.depth}|${e.paths ? JSON.stringify(e.paths) : ''}`);
const patternKey = pat => pat.map(entryKey).join('\u0001');

// {a, b, c} of one hierarchy is one pattern that keeps three members, so one grain, not three.
function normalize(patterns) {
  const out = [];
  const single = new Map();
  const seen = new Set();
  for (const pat of patterns) {
    if (pat.length === 1) {
      const e = pat[0];
      const slot = e.measures ? 'm' : `h|${e.h.unique}|${e.depth}`;
      const had = single.get(slot);
      if (had) {
        if (e.measures) {
          for (const m of e.measures) if (!had.measures.includes(m)) had.measures.push(m);
        } else if (had.paths && e.paths) {
          const known = new Set(had.paths.map(x => JSON.stringify(x)));
          for (const x of e.paths) if (!known.has(JSON.stringify(x))) had.paths.push(x);
        } else had.paths = null;
        continue;
      }
      const own = e.measures ? { measures: [...e.measures] } : { ...e, paths: e.paths ? [...e.paths] : null };
      single.set(slot, own);
      out.push([own]);
      continue;
    }
    const k = patternKey(pat);
    if (!seen.has(k)) { seen.add(k); out.push(pat); }
  }
  return out;
}

const REFUSED = {
  EXCEPT: 'Excluding items this way is not supported by OneLake Studio.',
  TOPCOUNT: 'Top 10 filters are not supported by OneLake Studio.',
  BOTTOMCOUNT: 'Top 10 filters are not supported by OneLake Studio.',
  FILTER: 'Value filters are not supported by OneLake Studio.',
};

function evalSet(node, cube) {
  switch (node?.kind) {
    case 'name': return [memberPattern(node.raw, cube)];
    case 'set': return normalize(node.items.filter(Boolean).flatMap(n => evalSet(n, cube)));
    case 'tuple': return cross(node.items.filter(Boolean).map(n => evalSet(n, cube)));
    case 'suffix': return suffix(node, cube);
    case 'call': return call(node, cube);
    default: throw new Error(`MDX: "${node?.name ?? 'an empty set'}" is not something OneLake Studio reads here`);
  }
}
const cross = sets => {
  const hs = new Set();
  for (const s of sets) for (const e of s[0] ?? []) {
    const name = e.measures ? '[Measures]' : e.h.unique;
    if (hs.has(name)) throw new Error(`MDX: ${name} is crossed with itself`);
    hs.add(name);
  }
  return sets.reduce((a, b) => a.flatMap(x => b.map(y => [...x, ...y])));
};

function known(raw, cube) {
  const hit = resolve(cube, raw);
  if (!hit) throw new Error(`${raw} is not in this model: it may have changed since this PivotTable was made.`);
  return hit;
}
function memberPattern(raw, cube) {
  const hit = known(raw, cube);
  if (hit.measure) return [{ measures: [hit.measure] }];
  if (hit.path) return [{ h: hit.hierarchy, depth: hit.path.length, paths: hit.path.length ? [hit.path] : null }];
  if (hit.depth != null) return [{ h: hit.hierarchy, depth: hit.depth, paths: null }];
  return [{ h: hit.hierarchy, depth: 0, paths: null }];   // a hierarchy alone: its default member, All
}
function suffix(node, cube) {
  const raw = node.of.raw;
  if (node.of.kind !== 'name') throw new Error(`MDX: .${node.name} is read on a name here`);
  if (raw.toLowerCase() === '[measures]' && /^(ALL)?MEMBERS$/.test(node.name)) return [[{ measures: [...cube.measures] }]];
  const hit = known(raw, cube);
  if (/^(ALL)?MEMBERS$/.test(node.name)) {
    if (hit.depth != null) return [[{ h: hit.hierarchy, depth: hit.depth, paths: null }]];
    if (hit.hierarchy) return [{ number: 0 }, ...hit.hierarchy.levels].map(l => [{ h: hit.hierarchy, depth: l.number, paths: null }]);
  }
  if (node.name === 'CHILDREN' && hit.path) {
    if (hit.path.length >= hit.hierarchy.levels.length) return [];
    return [[{ h: hit.hierarchy, depth: hit.path.length + 1, paths: hit.path.length ? [hit.path] : null }]];
  }
  throw new Error(`MDX: ${raw}.${node.name} is not something OneLake Studio reads here`);
}
function call(node, cube) {
  const a = node.args;
  switch (node.name) {
    case 'HIERARCHIZE': case 'ADDCALCULATEDMEMBERS': return evalSet(a[0], cube);
    case 'CROSSJOIN': return cross(a.filter(Boolean).map(n => evalSet(n, cube)));
    case 'DRILLDOWNLEVEL': return drillLevel(evalSet(a[0], cube), a[1]?.kind === 'name' ? a[1].raw : null, cube);
    case 'DRILLDOWNMEMBER': return drillMember(evalSet(a[0], cube), evalSet(a[1], cube));
    default:
      throw new Error(REFUSED[node.name] ?? `MDX: ${node.name} is not supported by OneLake Studio.`);
  }
}

// One level further down: a named level, or else the deepest the set's first hierarchy reaches.
function drillLevel(set, levelName, cube) {
  if (!set.length) return set;
  let name, target;
  if (levelName) {
    const hit = known(levelName, cube);
    if (hit.depth == null) throw new Error(`MDX: ${levelName} is not a level`);
    name = hit.hierarchy.unique;
    target = hit.depth;
  } else {
    const first = set[0][0];
    if (first.measures) return set;
    name = first.h.unique;
    target = Math.max(...set.map(pat => pat.find(e => e.h?.unique === name)?.depth ?? -1));
  }
  const out = [];
  for (const pat of set) {
    out.push(pat);
    const i = pat.findIndex(e => e.h?.unique === name);
    if (i < 0 || pat[i].depth !== target || target >= pat[i].h.levels.length) continue;
    out.push(pat.map((e, j) => (j === i ? { ...e, depth: e.depth + 1 } : e)));
  }
  return normalizeLater(out);
}
// Under a named member: its children join the set, at their own depth.
function drillMember(set, members) {
  const out = [...set];
  for (const [m] of members) {
    if (m.measures) continue;
    for (const path of m.paths ?? [[]]) {
      if (path.length >= m.h.levels.length) continue;
      for (const pat of set) {
        const i = pat.findIndex(e => e.h?.unique === m.h.unique);
        if (i < 0 || pat[i].depth !== path.length) continue;
        out.push(pat.map((e, j) => (j === i ? { ...e, depth: path.length + 1, paths: path.length ? [path] : null } : e)));
      }
    }
  }
  return normalizeLater(out);
}
const normalizeLater = patterns => (patterns.every(p => p.length === 1) ? normalize(patterns) : dedupe(patterns));
const dedupe = patterns => { const s = new Set(); return patterns.filter(p => { const k = patternKey(p); if (s.has(k)) return false; s.add(k); return true; }); };

// -----------------------------------------------------------------------------
// A filter (a subselect's axes, or WHERE): per hierarchy, the key paths it keeps.
// -----------------------------------------------------------------------------
function readFilter(patterns, into) {
  if (patterns.length > 1 && patterns.some(p => p.length > 1)) {
    throw new Error('A filter across several fields at once is not supported by OneLake Studio.');
  }
  const each = new Map();
  for (const pat of patterns) {
    for (const e of pat) {
      if (e.measures) {
        into.measures.push(...e.measures);
        continue;
      }
      const name = e.h.unique;
      if (!each.has(name)) each.set(name, { h: e.h, paths: [], open: false });
      const f = each.get(name);
      if (e.depth === 0 || !e.paths) f.open = true;
      else f.paths.push(...e.paths);
    }
  }
  for (const f of each.values()) {
    if (f.open) continue;    // All, or a whole level: keeps everything
    into.filters.push({ h: f.h, paths: f.paths });
    if (f.paths.length === 1) into.chosen.set(f.h.unique, f.paths[0]);
  }
}

/** The whole query, in cube terms: { axes, filters, chosen, slicerMeasure, cellProperties }. */
function readQuery(q, cube) {
  const into = { filters: [], chosen: new Map(), measures: [] };
  // A subselect's axes filter what's outside it, and they nest.
  for (let from = q.from; from.sub; from = from.sub.from) {
    for (const axis of from.sub.axes) readFilter(evalSet(axis.set, cube), into);
    if (from.sub.where) readFilter(evalSet(from.sub.where, cube), into);
  }
  if (q.where) readFilter(evalSet(q.where, cube), into);
  if (into.measures.length > 1) throw new Error('Several measures as one filter are not supported by OneLake Studio.');
  const axes = [...q.axes].sort((a, b) => a.number - b.number).map((axis, i) => {
    if (axis.number !== i) throw new Error(`MDX: axis ${i} is missing`);
    const patterns = evalSet(axis.set, cube);
    const names = pat => pat.map(e => (e.measures ? '[Measures]' : e.h.unique)).join();
    if (patterns.some(p => names(p) !== names(patterns[0]))) {
      throw new Error('An axis whose rows mix different fields is not supported by OneLake Studio.');
    }
    return { nonEmpty: axis.nonEmpty, patterns, properties: axis.properties };
  });
  return { axes, filters: into.filters, chosen: into.chosen, slicerMeasure: into.measures[0] || null, cellProperties: q.cellProperties };
}

// -----------------------------------------------------------------------------
// The two statements a slicer sends, fixed templates of Excel's: how many members a level has,
// and which of them have data under the pivot's other fields.
// -----------------------------------------------------------------------------
function slicerTemplate(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!/^with\b/i.test(flat)) return null;
  const count = /^with member (\[Measures\]\.\w+) as (.+?)\.members\.count\b/i.exec(flat);
  if (count) return { kind: 'count', measure: count[1], level: count[2] };
  if (!/__XLTargetSet/i.test(flat)) return null;
  const level = /__XLExistingMembers as (?:NonEmpty\( ?)?(.+?)\.members\b/i.exec(flat);
  const related = /member (\[Measures\]\.\w+) as Intersect\(/i.exec(flat);
  const target = /__XLTargetSet as SubSet\(Union\(.*?\), ?(\d+), ?(\d+) ?\)/i.exec(flat);
  if (!level || !related || !target) return null;
  const slices = [...flat.matchAll(/set __XLSlice\d+ as (\{.*?\})(?= set __XL)/gi)].map(m => m[1]);
  return { kind: 'items', level: level[1], measure: related[1], offset: Number(target[1]), size: Number(target[2]), slices };
}

module.exports = { parseSelect, parseSet, evalSet, readQuery, readFilter, slicerTemplate, known };

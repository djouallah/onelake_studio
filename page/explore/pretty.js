// =============================================================================
// explore/pretty.js — a model's file as Model's YAML (or BIM) shows it: its text, coloured
// =============================================================================
// A .bim is JSON, re-indented as docview.js does a document; an Ossie model is YAML, kept as
// it is. Either way the text is escaped and only spans are added around keys, strings,
// numbers, literals and comments (tk-*, explore.css), so nothing in a file is ever HTML. By
// hand, with nothing loaded: it works offline and costs the panel nothing until it is shown.
// What isn't plain Ossie SQL is set apart, each of its lines in a tk-ext span (amber): an Ossie model's
// nonportable_extensions blocks (what Ossie has no field for, Power BI's; custom_extensions in a file of the
// spec before), and an expression in a dialect other than OSSIE_SQL_2026 (DAX, say): its whole `- dialect:` item.
// A Fabric semantic view's YAML (`publish`) also has what Fabric's Publish refuses set apart, in a tk-bad span
// (red) that says why on hover: Publish reads Microsoft's format, 0.2.0.dev0, and a view may be written in 0.3.
// =============================================================================

import { escapeHtml } from '../paths.js';

// Past this, colouring is a lot of spans for one <pre>: the text is shown as it is.
export const PRETTY_MAX = 2 * 1024 * 1024;

const span = (cls, s) => `<span class="tk-${cls}">${escapeHtml(s)}</span>`;

// A string, with the `:` that makes it a key; a number; true, false or null.
const JSON_TOKEN = /("(?:[^"\\]|\\[\s\S])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function prettyJson(text) {
  let out = '', at = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    out += escapeHtml(text.slice(at, m.index));
    if (m[1] != null) out += m[2] != null ? span('key', m[1]) + escapeHtml(m[2]) : span('str', m[1]);
    else if (m[3] != null) out += span('num', m[3]);
    else out += span('lit', m[4]);
    at = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(at));
}

// A YAML value, after its key or its `- `: quoted, a number, a literal, a block's start, or a
// plain string, then a comment.
const QUOTED = /^("(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*')/;
const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|\.nan)$/i;
const LITERAL = /^(?:true|false|null|~|yes|no|on|off)$/i;
const BLOCK = /^[|>][-+0-9]*$/;
function yamlValue(text) {
  const lead = /^\s*/.exec(text)[0], v = text.slice(lead.length);
  if (!v) return escapeHtml(text);
  if (v.startsWith('#')) return escapeHtml(lead) + span('com', v);
  const q = QUOTED.exec(v);
  let body = q ? q[1] : v, rest = q ? v.slice(q[1].length) : '';
  if (!q) {
    const c = /\s#/.exec(v);
    if (c) { body = v.slice(0, c.index); rest = v.slice(c.index); }
  }
  const word = body.trimEnd(), tail = body.slice(word.length);
  const cls = q ? 'str' : NUMBER.test(word) ? 'num' : LITERAL.test(word) || BLOCK.test(word) ? 'lit' : 'str';
  const c = /^(\s*)(#.*)$/.exec(rest);
  return escapeHtml(lead) + span(cls, word) + escapeHtml(tail) + (c ? escapeHtml(c[1]) + span('com', c[2]) : escapeHtml(rest));
}

const KEY = /^("(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*'|[^\s#'"\-?:,[\]{}&*!|>%@`][^#]*?|-[^\s#][^#]*?)(\s*:)(?=\s|$)/;
const EXT_KEY = /^(\s*(?:-\s+)*)(?:nonportable|custom)_extensions\s*:/;
function prettyYaml(text, publish = false) {
  const colour = lineColour();
  const raws = text.split('\n');
  const lines = raws.map(r => (r.endsWith('\r') ? r.slice(0, -1) : r));
  const foreign = foreignDialectLines(lines);
  const refused = publish ? publishRefusals(lines) : new Map();
  let ext = -1;   // an extensions key's column, while its lines go on
  return raws.map((raw, i) => {
    const html = colour(raw);
    const line = lines[i];
    const indent = indentOf(line);
    // Its lines are those indented past the key, and its own `- ` items at the key's column.
    if (ext >= 0 && line.trim() && !(indent > ext || (indent === ext && /^-(\s|$)/.test(line.slice(indent))))) ext = -1;
    const k = ext < 0 && EXT_KEY.exec(line);
    if (k) ext = k[1].length;
    if (refused.has(i)) return `<span class="tk-bad" title="${escapeHtml(refused.get(i))}">${html}</span>`;
    return ext >= 0 || foreign.has(i) ? `<span class="tk-ext">${html}</span>` : html;
  }).join('\n');
}

// The lines of each `dialects:` item whose dialect isn't OSSIE_SQL_2026, by index: from its `- ` to its
// last line indented past that dash, a | block included. Its `dialect:` is read wherever it is in the item.
const DIALECTS_KEY = /^(\s*(?:-\s+)*)dialects\s*:\s*(?:#.*)?$/;
const DIALECT = /^dialect\s*:\s*['"]?([^'"\s#]+)/;
const STANDARD = 'OSSIE_SQL_2026';
const indentOf = l => /^\s*/.exec(l)[0].length;
function foreignDialectLines(lines) {
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    const key = DIALECTS_KEY.exec(lines[i]);
    if (!key) continue;
    let dash = -1;   // the items' column, once the first is seen
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim()) { j++; continue; }
      const indent = indentOf(line);
      const item = /^-(\s|$)/.test(line.slice(indent));
      if (dash < 0 && item && indent >= key[1].length) dash = indent;
      if (!item || indent !== dash) break;
      // One item: its first line, then the lines indented past its dash.
      const content = indent + /^-\s*/.exec(line.slice(indent))[0].length;
      let end = j, dialect = DIALECT.exec(line.slice(content));
      for (let k = j + 1; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        const ind = indentOf(lines[k]);
        if (ind <= indent) break;
        end = k;
        if (!dialect && ind === content) dialect = DIALECT.exec(lines[k].slice(content));
      }
      if (dialect && dialect[1].toUpperCase() !== STANDARD) for (let k = j; k <= end; k++) out.add(k);
      j = end + 1;
    }
    i = j - 1;
  }
  return out;
}

// What Fabric's Publish refuses in a semantic view's YAML, as far as its lines show it: line index -> why
// (https://learn.microsoft.com/en-us/fabric/fundamentals/semantic-views-yaml-reference, what "fails"). A view's
// files may be one text, each after a `# <file>` line: a name given twice is refused across them too. What
// Publish only leaves out with a warning (fields, ai_context, custom_extensions, a dialect other than DAX) is not.
export const PUBLISH_VERSION = '0.2.0.dev0';
const NONPORTABLE = /^(\s*(?:-\s+)*)nonportable_extensions\s*:/;
// The dialect names Publish reads: DAX is published, the rest left out with a warning. Any other name fails the whole
// Publish, even beside a DAX entry (OSSIE_SQL_2026 tried on 2026-11-19: OSSIE_MODEL_DESERIALIZATION_FAILED).
const PUBLISH_DIALECTS = ['DAX', 'ANSI_SQL', 'SNOWFLAKE', 'MDX', 'TABLEAU', 'DATABRICKS', 'MAQL', 'BIGQUERY'];
const WHY = {
  dialect: name => `Fabric's Publish knows no dialect ${name}, and refuses the view: write it as ANSI_SQL, which Publish leaves out, or as DAX`,
  nonportable: "nonportable_extensions is Ossie 0.3's: Fabric's Publish reads 0.2.0.dev0, whose key is custom_extensions",
  columns: "Fabric's Publish takes one column a side: a relationship on more columns is refused",
  dialects: "Fabric's Publish refuses an empty dialects list",
  datasets: "Fabric's Publish refuses an empty datasets list",
  source: "A dataset's source is schema.table, such as dbo.sales: Fabric's Publish reads no query",
  description: "Fabric's Publish refuses a relationship's description",
};
function publishRefusals(lines) {
  const out = new Map();
  const bad = (i, why) => { if (!out.has(i)) out.set(i, why); };
  const valueOf = v => String(v).replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  const names = { datasets: [], metrics: [], relationships: [] };   // [lower-cased name, name, line]
  let top = null;            // the top-level key these lines are under
  let dash = -1, col = -1;   // its items' `- ` column, and their own keys' column
  let ext = -1;              // a nonportable_extensions key's column, while its lines go on
  let cols = null;           // a from_columns/to_columns written as a block: { at, col, items, lines }
  const endCols = () => {
    if (cols && cols.items > 1) for (const k of [cols.at, ...cols.lines]) bad(k, WHY.columns);
    cols = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    const item = /^-(\s|$)/.test(line.slice(indent));
    if (ext >= 0 && !(indent > ext || (indent === ext && item))) ext = -1;
    if (ext >= 0) { bad(i, WHY.nonportable); continue; }
    const np = NONPORTABLE.exec(line);
    if (np) { ext = np[1].length; bad(i, WHY.nonportable); continue; }
    if (cols && !(indent > cols.col || (indent === cols.col && item))) endCols();
    if (cols) { cols.lines.push(i); if (item) cols.items++; continue; }
    if (/dialects\s*:\s*\[\s*\]/.test(line)) bad(i, WHY.dialects);
    const dialect = /^\s*(?:-\s+)?dialect\s*:\s*(.*)$/.exec(line);
    if (dialect && !PUBLISH_DIALECTS.includes(valueOf(dialect[1]).toUpperCase())) bad(i, WHY.dialect(valueOf(dialect[1])));
    if (indent === 0 && !item) {
      const k = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      top = k ? k[1] : null;
      dash = col = -1;
      if (top === 'version' && valueOf(k[2]) !== PUBLISH_VERSION) bad(i, `Fabric's Publish reads version ${PUBLISH_VERSION} only`);
      if (top === 'datasets' && /^\[\s*\]$/.test(valueOf(k[2]))) bad(i, WHY.datasets);
      continue;
    }
    if (!Object.hasOwn(names, top)) continue;
    let rest = line.slice(indent), at = indent;
    if (item && (dash < 0 || indent === dash)) {
      dash = indent;
      const d = /^-\s*/.exec(rest)[0];
      at = col = indent + d.length;
      rest = rest.slice(d.length);
    }
    if (at !== col) continue;   // deeper in the item: not one of its own keys
    const k = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
    if (!k) continue;
    const key = k[1], value = valueOf(k[2]);
    if (key === 'name' && value) names[top].push([value.toLowerCase(), value, i]);
    if (top === 'datasets' && key === 'source' && !/^[^.\s]+\.[^.\s]+$/.test(value)) bad(i, WHY.source);
    if (top === 'relationships' && key === 'description') bad(i, WHY.description);
    if (top === 'relationships' && (key === 'from_columns' || key === 'to_columns')) {
      const flow = /^\[(.*)\]$/.exec(value);
      if (flow) { if (flow[1].split(',').filter(c => c.trim()).length > 1) bad(i, WHY.columns); }
      else if (!value) cols = { at: i, col: at, items: 0, lines: [] };
    }
  }
  endCols();
  // A name given twice, whatever its case and in whichever file; a metric with a dataset's name.
  const what = { datasets: 'dataset', metrics: 'metric', relationships: 'relationship' };
  for (const [kind, list] of Object.entries(names)) {
    const seen = new Set();
    for (const [lc, name, i] of list) {
      if (seen.has(lc)) bad(i, `A ${what[kind]} named ${name} is in this view already, whatever its case: Fabric's Publish refuses a name given twice`);
      seen.add(lc);
    }
  }
  const tables = new Set(names.datasets.map(([lc]) => lc));
  for (const [lc, name, i] of names.metrics) if (tables.has(lc)) bad(i, `The metric ${name} has a dataset's name: Fabric's Publish refuses it`);
  return out;
}

// A YAML line's HTML, one line after another: what a | or > block keeps is kept between them.
function lineColour() {
  let block = -1;   // a | or > block's key's indentation, while its lines go on
  return raw => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const indent = /^\s*/.exec(line)[0].length;
    if (block >= 0) {
      if (!line.trim() || indent > block) return (line.trim() ? escapeHtml(line.slice(0, indent)) + span('str', line.slice(indent)) : escapeHtml(line)) + cr;
      block = -1;
    }
    const com = /^(\s*)(#.*)$/.exec(line);
    if (com) return escapeHtml(com[1]) + span('com', com[2]) + cr;
    let out = escapeHtml(line.slice(0, indent)), rest = line.slice(indent);
    const dash = /^(?:-(?:\s+|$))+/.exec(rest);
    if (dash) { out += escapeHtml(dash[0]); rest = rest.slice(dash[0].length); }
    const key = KEY.exec(rest);
    if (key) {
      out += span('key', key[1]) + escapeHtml(key[2]);
      rest = rest.slice(key[0].length);
    }
    if (BLOCK.test(rest.replace(/\s+#.*$/, '').trim())) block = indent;
    return out + yamlValue(rest) + cr;
  };
}

// The vendors whose extensions an Ossie model's file holds (nonportable_extensions' vendor_name),
// each once, as written: what Model's YAML says its amber lines are.
export function extensionVendors(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/^[\s-]*vendor_name:\s*['"]?([^'"\s#]+)/gm)) out.add(m[1]);
  return [...out];
}

/**
 * The HTML to put in a <pre>, or null when the file is too large to colour and is shown as
 * stored. `ext` is the file's extension: a .bim is JSON, anything else YAML. `asIs`: a .bim's
 * text as written, not re-indented — under a box it is being written in, the two must match.
 * `publish`: a Fabric semantic view's YAML, with what Fabric's Publish refuses in red.
 */
export function prettyModelText(text, ext = '', { asIs = false, max = PRETTY_MAX, publish = false } = {}) {
  const s = String(text);
  if (s.length > max) return null;
  const json = /^\.?bim$/i.test(ext) || /^\s*[{[]/.test(s);
  if (!json) return prettyYaml(s, publish);
  if (asIs) return prettyJson(s);
  // Parsed, an integer past 2^53 would come back as another number: such text is coloured as it is.
  let indented = s;
  if (!/\d{16}/.test(s)) {
    try { indented = JSON.stringify(JSON.parse(s.trim()), null, 2); } catch (_) { /* coloured as it is */ }
  }
  return prettyJson(indented);
}

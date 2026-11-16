// Checks site/public/report.json, the app's Report, with the page's own code, without a browser: what an agent
// (Fabricator's, or anyone's) runs after editing it, as `npm run validate`. Export to Fabric writes it into
// every project (fabric_app/export/exportapp.js), as scripts/validate-report.mjs.
//
// It reads the Report as the page does (explore/report.js), the model as the page does (model.json, its fields:
// explore/explore.js modelFields), and for each pivot tile makes the query the page makes (pivotQuery) and, on a
// model the page reads with DuckDB, compiles it to SQL over the tables as the page does (dax-sql). So a field the
// model has not, a shelf that is not a list, a mark or a slicer style the page does not draw, a filter it cannot
// apply, a filter-bar field, a layout off the grid: each is named, with its page and tile, and the exit code is 1.
// It reads no data: a tile that is valid here can still show no rows.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const site = fileURLToPath(new URL("../site/public/", import.meta.url));
const load = p => import(new URL(`../site/public/${p}`, import.meta.url).href);
const [{ modelFields, pivotQuery, aggOf, MARKS, SLICER_STYLES }, { reportPages, tileOf, COLUMNS }, { tmslOf },
  { compileModelSql, EXPLORE_CASTS }, { createCompiler }, { tmslToModel }, { ossieToTmsl }] = await Promise.all([
  load("explore/explore.js"), load("explore/report.js"), load("explore/model.js"), load("explore/query.js"),
  load("semantic/src/index.js"), load("semantic/formats/tmsl.js"), load("semantic/formats/ossie.js"),
]);

const problems = [];
const say = (where, what) => problems.push(`${where}: ${what}`);
const json = async name => {
  const text = await readFile(join(site, name), "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error(`site/public/${name} is not JSON: ${e.message}`); }
};

const doc = await json("model.json");
const engine = (await json("engine.json").catch(() => ({}))).engine || "duckdb";
const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
const fields = modelFields(tmslOf(bim));
// What SQL calls the model, as app.js names it.
const name = /^[A-Za-z_]\w*$/.test(String(doc.name ?? "")) ? doc.name : "model";
// On a model the page reads with DuckDB, it compiles each tile's query to SQL over the tables (app.js).
const compiler = engine === "duckdb" ? createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS }) : null;
// --fields: every field a tile can name, as a tile names it, by table, and nothing checked.
if (process.argv.includes("--fields")) {
  for (const t of fields.tables) {
    console.log(`${t.name}${t.kind ? ` (${t.kind})` : ""}`);
    for (const c of t.columns) console.log(`  ${c.id}  ${c.type}${c.description ? `  ${String(c.description).replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
    for (const m of t.measures) console.log(`  ${m.id}  measure${m.description ? `  ${String(m.description).replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
  }
  console.log('A column on Values is summarised as "\\u0000sum\\u0000table.column" (sum, avg, min, max, count, distinct).');
  process.exit(0);
}
const marks = new Set(MARKS.map(([k]) => k));
const slicers = new Set(SLICER_STYLES.map(([k]) => k));
const OPS = new Set(["in", "notIn", "range", "last", "blank", "notBlank"]);
const columns = [...fields.byId.values()].filter(f => f.kind === "column").map(f => f.id);
const measures = [...fields.byId.values()].filter(f => f.kind === "measure").map(f => f.id);
// A field as a shelf names it: a column (table.column), a measure (its name), or a column summarised.
const known = id => fields.byId.has(aggOf(id)?.col ?? id);
// How many letters apart two names are (Levenshtein), for "near" names.
const apart = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};
const unknown = (where, id) => {
  const want = String(aggOf(id)?.col ?? id).toLowerCase();
  const near = [...fields.byId.keys()].map(k => [k, apart(k.toLowerCase(), want)]).filter(([k, d]) => d <= Math.max(2, want.length / 4) || k.toLowerCase().includes(want))
    .sort((a, b) => a[1] - b[1]).slice(0, 5).map(([k]) => k);
  say(where, `no field ${JSON.stringify(id)} in the model${near.length ? ` (near: ${near.join(", ")})` : ""}`);
};

const spec = await json("report.json");
if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("site/public/report.json is not { pages: [...] }");
if (spec.pages !== undefined && !Array.isArray(spec.pages)) say("report", "pages is not a list");
const pages = reportPages(spec);
// The filter bar, beside the pages: columns of the model.
const bar = Array.isArray(spec.filters) ? spec.filters : [];
if (spec.filters !== undefined && !Array.isArray(spec.filters)) say("report", "filters (the filter bar) is not a list");
for (const f of bar) {
  if (!f || typeof f.field !== "string") say("filter bar", `a filter is { "field": "table.column", "style": ... }: ${JSON.stringify(f)}`);
  else if (!fields.byId.has(f.field) || fields.byId.get(f.field).kind !== "column") unknown("filter bar", f.field);
  if (f && f.style !== undefined && !["dropdown", "list", "dates"].includes(f.style)) say("filter bar", `${f.field}: style is dropdown, list or dates, not ${JSON.stringify(f.style)}`);
}
const barFields = new Set(bar.map(f => f?.field));

let tiles = 0;
for (const page of pages) {
  if (!Array.isArray(page.tiles)) { say(`page "${page.name}"`, "tiles is not a list"); continue; }
  page.tiles.forEach((raw, i) => {
    tiles++;
    const t = tileOf(raw);
    const where = `page "${page.name}", tile ${i + 1}${t?.title ? ` "${t.title}"` : ""}`;
    if (!t || typeof t !== "object") return say(where, "a tile is an object");
    if (t.layout !== undefined) {
      const { x, y, w, h } = t.layout || {};
      if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > COLUMNS) {
        say(where, `layout is whole numbers on ${COLUMNS} columns, x + w at most ${COLUMNS}: ${JSON.stringify(t.layout)}`);
      }
    }
    for (const id of t.ignore ?? []) if (!barFields.has(id)) say(where, `ignore names ${JSON.stringify(id)}, which is not in the filter bar`);
    if (t.kind === "text") {
      if (typeof t.text !== "string") say(where, "a text tile's text is a string of Markdown");
      return;
    }
    if (t.kind !== "pivot") return say(where, `kind is pivot or text, not ${JSON.stringify(t.kind)}`);
    const p = t.pivot;
    let q;
    try { q = pivotQuery(p, fields, name); } catch (e) { return say(where, e.message); }
    for (const k of ["rows", "cols", "values"]) for (const id of p[k] ?? []) if (!known(id)) unknown(`${where}, ${k}`, id);
    for (const f of p.filters ?? []) {
      if (!f || typeof f.field !== "string") { say(`${where}, filters`, `a filter is { "field", "op", ... }: ${JSON.stringify(f)}`); continue; }
      if (!known(f.field)) unknown(`${where}, filters`, f.field);
      if (!OPS.has(f.op)) say(`${where}, filters`, `${f.field}: op is ${[...OPS].join(", ")}, not ${JSON.stringify(f.op)}`);
      if ((f.op === "in" || f.op === "notIn") && !Array.isArray(f.values)) say(`${where}, filters`, `${f.field}: ${f.op} takes "values": [...]`);
      if (f.op === "last" && !(Number.isInteger(f.n) && f.n > 0)) say(`${where}, filters`, `${f.field}: last takes "n", a whole number of days`);
    }
    if (p.mark !== undefined && !marks.has(p.mark)) say(where, `mark is one of ${[...marks].join(", ")}, not ${JSON.stringify(p.mark)}`);
    if (p.mark === "slicer" && p.slicer !== undefined && !slicers.has(p.slicer)) say(where, `slicer is one of ${[...slicers].join(", ")}, not ${JSON.stringify(p.slicer)}`);
    for (const m of Object.keys(p.format?.measures ?? {})) if (!(p.values ?? []).some(v => v === m)) say(`${where}, format.measures`, `${JSON.stringify(m)} is not on its Values`);
    if (compiler) {
      try { compileModelSql(compiler, q.sql, name); }
      catch (e) { say(where, `its query does not compile: ${String(e.message).split("\n")[0]}`); }
    }
  });
}

if (problems.length) {
  console.log(`site/public/report.json: ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`The model's columns: ${columns.join(", ")}`);
  console.log(`Its measures: ${measures.join(", ")}`);
  process.exit(1);
}
console.log(`site/public/report.json: ${pages.length} page${pages.length > 1 ? "s" : ""}, ${tiles} tile${tiles === 1 ? "" : "s"}, every field in the model${compiler ? ", every query compiles" : ""}`);

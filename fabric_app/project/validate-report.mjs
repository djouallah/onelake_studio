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

// The Report and the model are the site's own files (site/public/); the page's code is site/src/.
const site = fileURLToPath(new URL("../site/public/", import.meta.url));
const load = p => import(new URL(`../site/src/${p}`, import.meta.url).href);
const [{ modelFields }, { checkReport, fieldList }, { tmslOf }, { compileModelSql, EXPLORE_CASTS }, { createCompiler },
  { tmslToModel }, { ossieToTmsl }] = await Promise.all([
  load("explore/explore.js"), load("explore/reportcheck.js"), load("explore/model.js"), load("explore/query.js"),
  load("semantic/src/index.js"), load("semantic/formats/tmsl.js"), load("semantic/formats/ossie.js"),
]);

const json = async name => {
  const text = await readFile(join(site, name), "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error(`site/public/${name} is not JSON: ${e.message}`); }
};

const doc = await json("model.json");
const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
const fields = modelFields(tmslOf(bim));
// What SQL calls the model, as app.js names it.
const name = /^[A-Za-z_]\w*$/.test(String(doc.name ?? "")) ? doc.name : "model";
// The page compiles each tile's query to SQL over the tables (app.js).
const compiler = createCompiler(tmslToModel(bim), { tableSource: t => `v_${t.name}`, castOutput: EXPLORE_CASTS });
// --fields: every field a tile can name, as a tile names it, by table, and nothing checked.
if (process.argv.includes("--fields")) {
  for (const t of fieldList(fields)) {
    console.log(`${t.table}${t.kind ? ` (${t.kind})` : ""}`);
    for (const f of t.fields) console.log(`  ${f.id}  ${f.type}${f.description ? `  ${String(f.description).replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
  }
  console.log('A column on Values is summarised as "\\u0000sum\\u0000table.column" (sum, avg, min, max, count, distinct).');
  process.exit(0);
}
const columns = [...fields.byId.values()].filter(f => f.kind === "column").map(f => f.id);
const measures = [...fields.byId.values()].filter(f => f.kind === "measure").map(f => f.id);

const spec = await json("report.json");
if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("site/public/report.json is not { pages: [...] }");
const { problems, pages, tiles, queries } = checkReport(spec, fields, { name });
for (const { where, sql } of queries) {
  try { compileModelSql(compiler, sql, name); }
  catch (e) { problems.push(`${where}: its query does not compile: ${String(e.message).split("\n")[0]}`); }
}

if (problems.length) {
  console.log(`site/public/report.json: ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`The model's columns: ${columns.join(", ")}`);
  console.log(`Its measures: ${measures.join(", ")}`);
  process.exit(1);
}
console.log(`site/public/report.json: ${pages} page${pages > 1 ? "s" : ""}, ${tiles} tile${tiles === 1 ? "" : "s"}, every field in the model, every query compiles`);

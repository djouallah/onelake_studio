// grid.js: what the grid's copies write, the inspector's text, and the order a sort gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRows, inspectText, sortedRows, cellText } from "../../app/grid.js";

const fields = ["a", "b"];
const rows = [{ a: 1, b: "x|y" }, { a: 2, b: "line\nbreak" }, { a: null, b: { k: [1] } }];

test("a selection copies as TSV, with headers, CSV, Markdown or JSON", () => {
  assert.equal(formatRows(fields, rows, "tsv"), '1\tx|y\r\n2\tline break\r\n\t{"k":[1]}');
  assert.equal(formatRows(fields, rows.slice(0, 1), "tsv-headers"), "a\tb\r\n1\tx|y");
  assert.equal(formatRows(fields, rows.slice(0, 2), "csv"), 'a,b\r\n1,x|y\r\n2,"line\nbreak"');
  assert.equal(formatRows(fields, rows.slice(0, 2), "markdown"), "| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| 2 | line break |");
  assert.deepEqual(JSON.parse(formatRows(fields, rows, "json")), [{ a: 1, b: "x|y" }, { a: 2, b: "line\nbreak" }, { a: null, b: { k: [1] } }]);
  assert.throws(() => formatRows(fields, rows, "xml"));
  assert.equal(cellText(null), "");
});

test("the inspector indents JSON, a struct's or a text's, and leaves other text as it is", () => {
  assert.equal(inspectText({ k: [1, 2] }), '{\n  "k": [\n    1,\n    2\n  ]\n}');
  assert.equal(inspectText('[{"a":1}]'), '[\n  {\n    "a": 1\n  }\n]');
  assert.equal(inspectText("{not json"), "{not json");
  assert.equal(inspectText("plain"), "plain");
});

test("a sort orders numbers as numbers and puts empty cells last", () => {
  const res = { fields: ["n", "t"], types: ["BIGINT", "VARCHAR"] };
  const rs = [{ n: "10", t: "b2" }, { n: "9", t: "b10" }, { n: null, t: "" }];
  assert.deepEqual(sortedRows(rs, res, { col: 0, desc: false }).map(r => r.n), ["9", "10", null]);
  assert.deepEqual(sortedRows(rs, res, { col: 0, desc: true }).map(r => r.n), ["10", "9", null]);
  assert.deepEqual(sortedRows(rs, res, { col: 1, desc: false }).map(r => r.t), ["b2", "b10", ""]);
});

test("a chart's first guess: a label across, a number up", async () => {
  const { numericColumns, guessAxes } = await import("../../app/chart.js");
  const res = { fields: ["region", "sales", "year"], types: ["VARCHAR", "DOUBLE", "VARCHAR"],
                rows: [{ region: "a", sales: 1.5, year: "2024" }, { region: "b", sales: 2, year: "2025" }] };
  assert.deepEqual(numericColumns(res), ["sales", "year"]);
  assert.deepEqual(guessAxes(res), { x: "region", y: "sales" });
  assert.deepEqual(guessAxes({ fields: ["n"], types: ["BIGINT"], rows: [{ n: 1 }] }), { x: "n", y: null });
});

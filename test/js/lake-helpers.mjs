// What the lake's tests share: an engine with the lake attached, and the same-rows check against DuckDB's own
// readers. Not a test of its own.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { DuckDBInstance } = require("@duckdb/node-api");
const { attachLake } = require("../../src/onelaketable.js");

const BUNDLED = new URL("../../duckdb-extensions/", import.meta.url);
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const qi = s => `"${String(s).replace(/"/g, '""')}"`;

export async function load(c, name) {
  const bundled = new URL(`${name}.duckdb_extension`, BUNDLED);
  if (existsSync(bundled)) await c.run(`LOAD ${q(bundled.pathname.replace(/^\/([A-Za-z]:)/, "$1"))}`);
  else await c.run(`INSTALL ${name}; LOAD ${name};`);
}

/** A DuckDB with the lake attached at a new metadata file, and the folder it may write deletion vectors in. */
export async function openLake({ extensions = ["delta", "ducklake"], dir = mkdtempSync(join(tmpdir(), "lake-")) } = {}) {
  const db = await DuckDBInstance.create(":memory:", { allow_persistent_secrets: "false" });
  const c = await db.connect();
  for (const e of extensions) await load(c, e);
  await attachLake(c, join(dir, "meta.ducklake").replace(/\\/g, "/"));
  return { db, c, dir, dvDir: join(dir, "dv").replace(/\\/g, "/"), close: () => { c.closeSync(); db.closeSync(); } };
}

export const rowsOf = async (c, sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();

/** The same rows both ways: each row as JSON, its columns in the table's own order, so maps and structs compare. */
export async function sameRows(c, a, b, names) {
  const cols = names.map(qi).join(", ");
  const j = src => `SELECT to_json(x)::VARCHAR AS j FROM (SELECT ${cols} FROM ${src}) x`;
  const [r] = await rowsOf(c, `SELECT (SELECT count(*) FROM (${j(a)} EXCEPT ALL ${j(b)}))::BIGINT AS ab,
    (SELECT count(*) FROM (${j(b)} EXCEPT ALL ${j(a)}))::BIGINT AS ba, (SELECT count(*) FROM ${b})::BIGINT AS n`);
  return { rows: Number(r.n), onlyInFirst: Number(r.ab), onlyInSecond: Number(r.ba) };
}

export { q, qi };

// queries.js: saved queries in a real temp folder. One folder per account, none with no account,
// and a query already there is never overwritten by the loose ones moving in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createQueries, queryStem } = require("../../core/queries.js");

async function setup(account = "a@contoso.com") {
  const root = await mkdtemp(join(tmpdir(), "queries-"));
  const events = { changed: 0, lines: [] };
  const queries = createQueries({
    root: () => root, account: () => account,
    log: line => events.lines.push(line),
    onChange: () => { events.changed++; },
  });
  return { root, queries, events, done: () => rm(root, { recursive: true, force: true }) };
}

test("a query's name as a file name", () => {
  assert.equal(queryStem("  sales.sql "), "sales");
  assert.equal(queryStem('a/b:c*d?"e<f>g|h'), "a_b_c_d_e_f_g_h");
  assert.equal(queryStem("   "), "");
});

test("each account has its own folder, and with none known there are no queries", async () => {
  const { root, queries, done } = await setup();
  assert.equal(queries.queriesFolder(), join(root, "a@contoso.com"));
  const none = (await setup(null));
  assert.equal(none.queries.queriesFolder(), null);
  assert.deepEqual(await none.queries.listQueries(), []);
  await none.done();
  await done();
});

test("a save with no name is the next free Query N", async () => {
  const { queries, events, done } = await setup();
  assert.equal((await queries.saveQuery({ sql: "SELECT 1" })).name, "Query 1");
  assert.equal((await queries.saveQuery({ sql: "SELECT 2" })).name, "Query 2");
  await rm(queries.queryPath("Query 1"));
  assert.equal((await queries.saveQuery({ sql: "SELECT 3" })).name, "Query 1");
  assert.equal(events.changed, 3);
  await done();
});

test("a save with a name writes that query, and listing sorts ignoring case", async () => {
  const { queries, done } = await setup();
  const saved = await queries.saveQuery({ name: "beta", sql: "SELECT 2" });
  assert.equal(await readFile(saved.path, "utf8"), "SELECT 2");
  await queries.saveQuery({ name: "Alpha", sql: "SELECT 1" });
  assert.deepEqual((await queries.listQueries()).map(q => q.name), ["Alpha", "beta"]);
  await done();
});

test("with no account known a save is refused", async () => {
  const { queries, done } = await setup(null);
  await assert.rejects(queries.saveQuery({ sql: "SELECT 1" }), /sign in to save queries/);
  await done();
});

test("loose queries move to the account's folder, never over one already there", async () => {
  const { root, queries, events, done } = await setup();
  await mkdir(join(root, "a@contoso.com"), { recursive: true });
  await writeFile(join(root, "a@contoso.com", "kept.sql"), "mine");
  await writeFile(join(root, "kept.sql"), "loose");
  await writeFile(join(root, "new.sql"), "moved");
  await writeFile(join(root, "notes.txt"), "not a query");
  await queries.adoptLooseQueries();
  assert.equal(await readFile(join(root, "a@contoso.com", "kept.sql"), "utf8"), "mine");
  assert.equal(await readFile(join(root, "a@contoso.com", "new.sql"), "utf8"), "moved");
  assert.deepEqual((await readdir(root)).sort(), ["a@contoso.com", "kept.sql", "notes.txt"]);
  assert.match(events.lines[0], /moved into/);
  await done();
});

test("a .sql file opened from disk is saved back where it is, and no file that wasn't opened is written", async () => {
  const { root, queries, done } = await setup();
  const file = join(root, "monthly.sql");
  await writeFile(file, "SELECT 1", "utf8");
  assert.equal(await queries.openSqlFile(file), "SELECT 1");
  const saved = await queries.saveQuery({ name: "monthly", sql: "SELECT 2", file });
  assert.equal(saved.file, file);
  assert.equal(await readFile(file, "utf8"), "SELECT 2");
  const other = join(root, "other.sql");
  await assert.rejects(queries.saveQuery({ name: "other", sql: "SELECT 3", file: other }), /wasn't opened here/);
  assert.deepEqual((await readdir(root)).sort(), ["monthly.sql"]);
  await done();
});

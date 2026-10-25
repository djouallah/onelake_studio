// The native engine on its own: real @duckdb/node-api, no editor, no page, no OneLake.
// Needs extension/node_modules (cd extension && npm ci) and network for DuckDB's first
// INSTALL of iceberg/azure/httpfs — so CI runs it in its own job, not in `npm test`.
//
// Run: node --test test/engine-host.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../extension/src/engine-host.js");

test("native engine host", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const warnings = [];
  const engine = createEngineHost({ extensionDir: extDir, onWarn: w => warnings.push(w) });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  const collect = async sql => {
    const batches = [];
    const res = await engine.call("stream", [sql], b => batches.push(b));
    return { res, batches };
  };

  await t.test("boots on DuckDB 2.0 with the required extensions", async () => {
    const r = await engine.call("query", ["SELECT version() AS v"]);
    assert.match(r.rows[0].v, /^v2\./, `running ${r.rows[0].v}`);
    const caps = await engine.call("capabilities");
    for (const ext of ["iceberg", "azure", "httpfs"]) assert.ok(caps[ext], `${ext} loaded`);
  });

  await t.test("a statement needs no Microsoft account", async () => {
    const r = await engine.call("query", ["SELECT 42 AS answer"]);
    assert.equal(r.rows[0].answer, 42);
    assert.equal(r.fields[0].name, "answer");
  });

  await t.test("an empty result still carries its schema", async () => {
    const { batches } = await collect("SELECT 1 AS a, 'x' AS b WHERE false");
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].fields.map(f => f.name), ["a", "b"]);
    assert.equal(batches[0].numRows, 0);
  });

  await t.test("rows come back in insertion order", async () => {
    const r = await engine.call("query", ["SELECT * FROM (VALUES (3), (1), (2)) t(x)"]);
    assert.deepEqual(r.rows.map(x => x.x), [3, 1, 2]);
  });

  await t.test("past the row cap the host counts, it does not convert", async () => {
    const { res, batches } = await collect("SELECT range AS i FROM range(250000)");
    const kept = batches.reduce((n, b) => n + b.rows.length, 0);
    const counted = batches.reduce((n, b) => n + b.numRows, 0);
    assert.equal(res.numRows, 250000, "the stream reports the true total");
    assert.equal(counted, 250000, "…and so do the batches' numRows");
    assert.equal(kept, 200000, "but only the cap's worth of rows crossed");
    assert.equal(batches[0].rows[0].i, 0, "BIGINT that fits a double arrives as a number");
  });

  await t.test("a cancelled query stops, and the engine stays usable", async () => {
    const slow = collect("SELECT count(*) FROM range(10000000000) a");
    await new Promise(r => setTimeout(r, 300));
    await engine.call("cancel");
    await assert.rejects(slow, /interrupt/i);
    const r = await engine.call("query", ["SELECT 1 AS ok"]);
    assert.equal(r.rows[0].ok, 1);
  });

  await t.test("a bearer token never comes back in an error message", async () => {
    const fake = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzb21lb25lIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
    await assert.rejects(engine.call("query", [`SELECT '${fake}'::INTEGER`]), e => {
      assert.ok(!e.message.includes(fake), e.message);
      assert.match(e.message, /<token>/);
      return true;
    });
  });

  await t.test("a closed engine stays closed", async () => {
    const other = createEngineHost({ extensionDir: extDir });
    await other.call("query", ["SELECT 1"]);
    await other.close();
    await assert.rejects(other.call("query", ["SELECT 1"]), /closed/);
  });
});

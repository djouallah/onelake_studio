// The native engine on its own: real @duckdb/node-api, no editor, no page, no OneLake.
// Needs extension/node_modules (cd extension && npm ci) and network for DuckDB's first
// INSTALL of iceberg/azure/httpfs — so CI runs it in its own job, not in `npm test`.
//
// Run: node --test test/engine-host.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost, isOneLakeMetadata } = require("../extension/src/engine-host.js");

// What fetch-extensions.mjs put next to the extension, when CI ran it for this platform.
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "extension", "duckdb-extensions");

test("native engine host", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const outside = await mkdtemp(join(tmpdir(), "onelake-outside-"));
  await writeFile(join(outside, "secret.csv"), "a\n1\n");
  const warnings = [];
  const engine = createEngineHost({ extensionDir: extDir, onWarn: w => warnings.push(w),
                                    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
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

  await t.test("bundled extensions load from the package, not the network", async () => {
    if (!existsSync(BUNDLED)) return t.skip("no bundled extensions (run fetch-extensions.mjs)");
    const fromRepo = warnings.filter(w => /bundled '.*' would not load/.test(w));
    assert.deepEqual(fromRepo, [], fromRepo.join(" | "));
    const r = await engine.call("query", [
      "SELECT extension_name AS n, install_path AS p FROM duckdb_extensions() WHERE loaded AND extension_name IN ('iceberg','azure','httpfs','avro')"]);
    assert.equal(r.rows.length, 4, JSON.stringify(r.rows));
  });

  await t.test("the lockdown: no local file outside the engine's own directories", async () => {
    const p = join(outside, "secret.csv").replace(/\\/g, "/");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('${p}')`]), /Permission|disabled by configuration/i,
      "reading a file the page has no business with is refused");
    await assert.rejects(engine.call("query", [`COPY (SELECT 1) TO '${join(outside, "out.csv").replace(/\\/g, "/")}'`]),
      /Permission|disabled by configuration/i, "and so is writing one");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('${join(outside, "..", "x.csv").replace(/\\/g, "/")}')`]),
      /Permission|disabled by configuration|No files found/i, "dot-dot does not climb out");
  });

  await t.test("zip:// reaches remote archives only, never a local one", async () => {
    const zip = join(outside, "local.zip").replace(/\\/g, "/");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('zip://${zip}/x.csv')`]),
      /Permission|disabled by configuration/i);
  });

  await t.test("the lockdown cannot be turned off from SQL", async () => {
    await assert.rejects(engine.call("query", ["SET enable_external_access = true"]), /lock/i);
    await assert.rejects(engine.call("query", ["SET allowed_directories = ['/']"]), /lock/i);
  });

  await t.test("what the page legitimately reads still reads", async () => {
    const path = await engine.call("registerFileBuffer", ["n.csv", Array.from(Buffer.from("a\n40\n2\n"))]);
    const r = await engine.call("query", [`SELECT sum(a) AS s FROM read_csv('${path}')`]);
    assert.equal(r.rows[0].s, 42, "a buffer the page handed over (the engine's temp directory)");
    // ...in the shape the panel actually sends (duckdb-native.js).
    const p64 = await engine.call("registerFileBuffer",
      ["m.csv", { base64: Buffer.from("a\n1\n2\n").toString("base64") }]);
    const r64 = await engine.call("query", [`SELECT sum(a) AS s FROM read_csv('${p64}')`]);
    assert.equal(r64.rows[0].s, 3, "base64 bytes arrive intact");
  });

  await t.test("a closed engine stays closed", async () => {
    const other = createEngineHost({ extensionDir: extDir });
    await other.call("query", ["SELECT 1"]);
    await other.close();
    await assert.rejects(other.call("query", ["SELECT 1"]), /closed/);
  });
});

// The metadata location arrives from the page and is spliced into iceberg_scan(...), so
// only the shape the catalog returns may pass; everything else takes the ATTACH path.
test("only a OneLake metadata.json is read with iceberg_scan", () => {
  assert.ok(isOneLakeMetadata(
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/00001-ab.metadata.json"));
  for (const bad of [
    null, "", 42,
    "file:///etc/passwd.metadata.json",
    "https://onelake.dfs.fabric.microsoft.com/ws/lh.Lakehouse/Tables/t/metadata/v1.metadata.json",
    "abfss://ws@evil.example.com/x/v1.metadata.json",
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t/metadata/v1.metadata.json') ; DROP TABLE x; --",
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t/data/part.parquet",
  ]) assert.equal(isOneLakeMetadata(bad), false, String(bad));
});

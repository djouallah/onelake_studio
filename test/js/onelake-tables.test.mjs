// The lake on OneLake itself: the cases of onelaketable.test.mjs, uploaded by the workflow to
// ONELAKE_TABLES/lakeci_<case> on fabriccat, read with ONELAKE_TOKEN (the CI identity's storage token).
// Each is registered from its log on OneLake and gives delta_scan's rows. Then the table service, for real: a
// statement reads the table, the files it opened come down over HTTPS from DuckDB's own log of them, and the
// table reads the same with the token gone. Skipped without those variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { LAKE_FIXTURES: FIXTURES, ONELAKE_TABLES: TABLES, ONELAKE_TOKEN: TOKEN } = process.env;
const skip = !(FIXTURES && TABLES && TOKEN) && "LAKE_FIXTURES, ONELAKE_TABLES and ONELAKE_TOKEN are set only by the lake's workflow";
const require = createRequire(import.meta.url);
const H = skip ? null : await import("./lake-helpers.mjs");
const { readDelta, syncTable, META } = require("../../core/lake/onelaketable.js");
const { createTableService, httpsDownload, openedSince, httpsOf } = require("../../core/lake/tableservice.js");
const HERE = p => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cases = skip ? {} : JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"));

async function openOnLake(token = TOKEN) {
  const lake = await H.openLake({ extensions: ["azure", "delta", "ducklake"] });
  const p = await lake.c.prepare("CREATE OR REPLACE SECRET onelake (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ?)");
  p.bindVarchar(1, token);
  await p.run();
  lake.setToken = async t => { const s = await lake.c.prepare("CREATE OR REPLACE SECRET onelake (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ?)"); s.bindVarchar(1, t); await s.run(); };
  return lake;
}
// A table's rows in one value: their count, and the sum of each row's hash.
const fingerprint = async (c, src, names) => JSON.stringify(await H.rowsOf(c,
  `SELECT count(*)::BIGINT AS n, sum(hash(to_json(x)::VARCHAR))::HUGEINT::VARCHAR AS h FROM (SELECT ${names.map(H.qi).join(", ")} FROM ${src}) x`));

for (const [name, info] of Object.entries(cases)) {
  test(`${name} on OneLake: the same rows as delta_scan`, { skip: skip || (!info.made && `not written: ${info.why}`) }, async () => {
    const lake = await openOnLake();
    try {
      const root = `${TABLES}/lakeci_${name}`;
      const t0 = Date.now();
      const state = await readDelta(lake.c, root);
      const read = Date.now() - t0;
      const r = await syncTable(lake.c, name, state, { dvDir: lake.dvDir });
      const names = state.fields.map(f => f.name);
      const same = await H.sameRows(lake.c, `lake.${H.qi(name)}`, `delta_scan(${H.q(root)})`, names);
      console.log(`${name}: log read in ${read}ms, ${r.added} files registered in ${r.ms}ms, ${same.rows} rows`);
      assert.deepEqual([same.onlyInFirst, same.onlyInSecond], [0, 0], `${name}: ${JSON.stringify(same)}`);
    } finally { lake.close(); }
  });
}

test("on OneLake: what a statement reads comes down, and then reads with no token", { skip }, async () => {
  const lake = await openOnLake();
  try {
    const name = "part_multi", root = `${TABLES}/lakeci_${name}`;
    const state = await readDelta(lake.c, root);
    const names = state.fields.map(f => f.name);
    let queue = Promise.resolve();
    const withConn = fn => (queue = queue.then(() => fn(lake.c), () => fn(lake.c)));
    const service = createTableService({
      withConn, filesDir: join(lake.dir, "files").replace(/\\/g, "/"), graceMs: 0, parallel: 4,
      download: httpsDownload({ getToken: async () => TOKEN }),
    });
    await syncTable(lake.c, name, state, { dvDir: lake.dvDir, held: await service.held() });
    // Read from OneLake before the log starts, so only what follows is counted.
    const before = await fingerprint(lake.c, `lake.${name}`, names);
    await lake.c.run("CALL enable_logging('FileSystem', storage = 'memory')");
    // One year: the files it opens come down, and no other.
    await H.rowsOf(lake.c, `SELECT count(*), sum(v) FROM lake.${name} WHERE year = 2021`);
    let { paths, lastUs } = await openedSince(lake.c, 0);
    const t0 = Date.now();
    await service.noteOpened(paths);
    await service.idle();
    let s = await service.stats();
    console.log(`one year read: ${s.swapped} files down, ${s.heldBytes} bytes, in ${Date.now() - t0}ms`);
    const yearFiles = state.files.filter(f => f.partitionValues[0] === "2021").length;
    assert.equal(s.swapped, yearFiles, JSON.stringify(s));
    // The whole table, then: every file here.
    await H.rowsOf(lake.c, `SELECT count(*), sum(v) FROM lake.${name}`);
    ({ paths, lastUs } = await openedSince(lake.c, lastUs));
    await service.noteOpened(paths);
    await service.idle();
    s = await service.stats();
    assert.equal(s.held, state.files.length, JSON.stringify(s));
    const [remote] = await H.rowsOf(lake.c, `SELECT count(*)::INTEGER AS n FROM ${META}.ducklake_data_file WHERE end_snapshot IS NULL AND path_is_relative`);
    assert.equal(remote.n, 0);
    // No token: the same rows, from here.
    await lake.setToken("not-a-token");
    assert.equal(await fingerprint(lake.c, `lake.${name}`, names), before);
  } finally { lake.close(); }
});

test("on OneLake: a table followed as it changes, the old rows read until it is synced on from where it got to", { skip }, async () => {
  const lake = await openOnLake();
  // A connection of its own for each read, as the engine gives readDelta: the commits are read at the same time.
  const withConn = async fn => { const c = await lake.db.connect(); try { return await fn(c); } finally { c.closeSync(); } };
  try {
    // A folder of its own: onelaketable.test.mjs follows the local churn at the same time.
    const own = join(FIXTURES, "remote"), local = join(own, "churn").replace(/\\/g, "/"), root = `${TABLES}/lakeci_churn`;
    let before = null;
    for (let step = 0; step < 5; step++) {
      const out = JSON.parse(execFileSync("python", [HERE("../fixtures/lake/make_tables.py"), own, "churn", String(step)], { encoding: "utf8" }));
      execFileSync("python", [HERE("../fixtures/lake/upload.py"), local, httpsOf(root)], { env: { ...process.env, ONELAKE_TOKEN: TOKEN } });
      // The commit has landed, and the lake reads what it was last synced to.
      if (before) assert.equal(await fingerprint(lake.c, "lake.churn", before.names), before.rows, `before its sync, ${out.steps[step]} isn't seen`);
      const t0 = Date.now();
      const state = await readDelta(lake.c, root, { ...(before ? { from: before.state.version, base: before.state.log } : {}), withConn });
      console.log(`churn after ${out.steps[step]}: ${state.commitsRead} commit(s) read in ${Date.now() - t0}ms${state.whole ? ", whole" : ""}`);
      assert.equal(state.whole, !before);
      await syncTable(lake.c, "churn", state, { dvDir: lake.dvDir });
      const names = state.fields.map(f => f.name);
      const same = await H.sameRows(lake.c, "lake.churn", `delta_scan(${H.q(root)})`, names);
      assert.deepEqual([same.onlyInFirst, same.onlyInSecond], [0, 0], `after ${out.steps[step]}: ${JSON.stringify(same)}`);
      before = { state, names, rows: await fingerprint(lake.c, "lake.churn", names) };
    }
  } finally { lake.close(); }
});

test("on OneLake: the token is the CI identity's own", { skip }, () => {
  const claims = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString());
  assert.equal(claims.appid || claims.azp, process.env.ONELAKE_CI_CLIENT_ID);
});

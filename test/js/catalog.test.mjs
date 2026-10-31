// Tests for src/catalog.js — the listing the sidebar tree draws from.
//
// A listing that goes wrong shows up as a tree that quietly disagrees with OneLake about
// what a workspace contains. The parts that have actually cost bugs are covered here —
// pagination that stops early, the 404 that means "empty" versus the one that means "this
// listing is now a lie", and the Iceberg prefix, whose slashes are separators and must not
// be encoded on their way into the next URL.
//
// No network: `fetch` is replaced per test with a table of canned answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCatalog } = require("../../src/catalog.js");


// A fetch stub. `answers` maps a matcher to a response; every request is recorded so a
// test can assert on the URLs that went out, which is half of what is being tested.
function fakeFetch(answers) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    for (const [match, make] of answers) {
      if (typeof match === "string" ? url.includes(match) : match.test(url)) return make(url);
    }
    return res(404, {});
  };
  return { fetch, calls };
}

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function catalogWith(answers, { getToken = async () => "tok" } = {}) {
  const f = fakeFetch(answers);
  const saved = globalThis.fetch;
  globalThis.fetch = f.fetch;
  const catalog = createCatalog({ getToken });
  return { catalog, calls: f.calls, restore: () => { globalThis.fetch = saved; } };
}

test("workspaces page through x-ms-continuation until it stops", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/continuation=tok2/, () => res(200, { fileSystems: [{ name: "beta" }] })],
    [/resource=account/, () => res(200, { fileSystems: [{ name: "gamma" }] },
      { "x-ms-continuation": "tok2" })],
  ]);
  try {
    // Sorted, case-insensitively — the tree renders this order directly.
    assert.deepEqual(await catalog.listWorkspaces(), ["beta", "gamma"]);
    assert.equal(calls.length, 2, "the second page was actually fetched");
  } finally { restore(); }
});

test("a 404 on the first page is an empty directory, not a failure", async () => {
  const { catalog, restore } = catalogWith([[/resource=filesystem/, () => res(404, {})]]);
  try {
    assert.deepEqual(await catalog.listItems("ws"), []);
  } finally { restore(); }
});

test("a 404 part way through pagination is refused, not silently truncated", async () => {
  let n = 0;
  const { catalog, restore } = catalogWith([
    [/resource=filesystem/, () => (n++ === 0
      ? res(200, { paths: [{ name: "a.Lakehouse", isDirectory: "true" }] },
        { "x-ms-continuation": "more" })
      : res(404, {}))],
  ]);
  try {
    // Returning page one on its own would report a partial listing as a complete one.
    await assert.rejects(() => catalog.listItems("ws"), /interrupted|changed/);
  } finally { restore(); }
});

test("only the item kinds that hold tables are listed, using names.js's rules", async () => {
  const { catalog, restore } = catalogWith([
    [/resource=filesystem/, () => res(200, {
      paths: [
        { name: "sales.Lakehouse", isDirectory: "true" },
        { name: "dw.Warehouse", isDirectory: "true" },
        { name: "app.SQLDbNative", isDirectory: "true" },
        { name: "mirror.MirroredDatabase", isDirectory: "true" },
        // Excluded on purpose: a shortcut with no bytes in OneLake, whose catalog 400s.
        { name: "bricks.DatabricksCatalog", isDirectory: "true" },
        { name: "nb.SynapseNotebook", isDirectory: "true" },
        { name: "loose.txt" },
      ],
    })],
  ]);
  try {
    const names = (await catalog.listItems("ws")).map(i => i.name);
    assert.deepEqual(names, ["app.SQLDbNative", "dw.Warehouse", "mirror.MirroredDatabase", "sales.Lakehouse"]);
  } finally { restore(); }
});

test("isDirectory arrives as the string \"true\", and a file is not a directory", async () => {
  const { catalog, restore } = catalogWith([
    [/resource=filesystem/, () => res(200, {
      paths: [
        { name: "lh.Lakehouse/Files/sub", isDirectory: "true" },
        { name: "lh.Lakehouse/Files/data.parquet", contentLength: "2048" },
      ],
    })],
  ]);
  try {
    const files = await catalog.listFiles({ workspace: "ws", item: "lh.Lakehouse" });
    // Directories sort ahead of files, which is the order the tree draws.
    assert.deepEqual(files.map(f => [f.name, f.isDir, f.bytes]),
      [["sub", true, 0], ["data.parquet", false, 2048]]);
    assert.equal(files[1].path, "lh.Lakehouse/Files/data.parquet",
      "the path stays workspace-relative — the form the panel is handed");
  } finally { restore(); }
});

test("the Iceberg prefix is spliced in as a path, and namespaces are encoded", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, { overrides: { prefix: "guid-a/guid-b" } })],
    [/\/namespaces$/, () => res(200, { namespaces: [["my schema"]] })],
    [/\/tables$/, () => res(200, { identifiers: [{ name: "fact" }] })],
  ]);
  try {
    assert.deepEqual(await catalog.listTables({ workspace: "ws", item: "lh.Lakehouse" }),
      [{ schema: "my schema", table: "fact" }]);
    // The prefix's slash is a separator; encoding it would address a nonexistent single
    // segment named "guid-a/guid-b". The namespace's space is data and must be encoded.
    assert.ok(calls.some(u => u.includes("/v1/guid-a/guid-b/namespaces")), calls.join("\n"));
    assert.ok(calls.some(u => u.includes("/namespaces/my%20schema/tables")), calls.join("\n"));
  } finally { restore(); }
});

test("the warehouse is one query parameter, so its slash IS encoded", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, {})],
    [/\/namespaces$/, () => res(200, { namespaces: [] })],
  ]);
  try {
    await catalog.listTables({ workspace: "my ws", item: "lh.Lakehouse" });
    assert.ok(calls.some(u => u.includes("warehouse=my%20ws%2Flh.Lakehouse")), calls.join("\n"));
  } finally { restore(); }
});

// Answers are cached by the store (onelake.js), not here: a memo in the catalog meant the
// store's refresh after its TTL got the session's first listing back, for ever. What the
// catalog does keep is each item's prefix — its config call is seconds of work per item.
test("a table listing goes to the catalog each time; the item's prefix is asked once", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, {})],
    [/\/namespaces$/, () => res(200, { namespaces: [["dbo"], ["sales"]] })],
    [/\/tables$/, () => res(200, { identifiers: [{ name: "t" }] })],
  ]);
  const configs = () => calls.filter(u => u.includes("/v1/config")).length;
  try {
    const lh = { workspace: "ws", item: "lh.Lakehouse" };
    await catalog.listTables(lh);
    const first = calls.length;
    await catalog.listTables(lh);
    assert.ok(calls.length > first, "a second listing is a real listing — the store decides when");
    assert.equal(configs(), 1, "but the prefix was asked for once");
    catalog.reset();
    await catalog.listTables(lh);
    assert.equal(configs(), 2, "and a refresh asks for it again");
  } finally { restore(); }
});

test("refreshing one item forgets that item's prefix only", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, {})],
    [/\/namespaces$/, () => res(200, { namespaces: [["dbo"]] })],
    [/\/tables$/, () => res(200, { identifiers: [{ name: "t" }] })],
  ]);
  const configsFor = item => calls.filter(u => u.includes("/v1/config") && u.includes(item)).length;
  try {
    const a = { workspace: "ws", item: "a.Lakehouse" }, b = { workspace: "ws", item: "b.Lakehouse" };
    const other = { workspace: "ws2", item: "c.Lakehouse" };
    for (const lh of [a, b, other]) await catalog.listTables(lh);
    catalog.reset(a);
    for (const lh of [a, b, other]) await catalog.listTables(lh);
    assert.equal(configsFor("a.Lakehouse"), 2, "the refreshed item asked again");
    assert.equal(configsFor("b.Lakehouse"), 1, "the other item's prefix was kept");
    // A workspace-level refresh reaches every item under it, and only those.
    catalog.reset({ workspace: "ws" });
    for (const lh of [a, b, other]) await catalog.listTables(lh);
    assert.equal(configsFor("b.Lakehouse"), 2, "items under the refreshed workspace asked again");
    assert.equal(configsFor("c.Lakehouse"), 1, "another workspace's prefix was kept");
  } finally { restore(); }
});

test("a failed listing is not remembered as an answer", async () => {
  let fail = true;
  const { catalog, restore } = catalogWith([
    [/\/v1\/config/, () => (fail ? res(400, { error: { message: "not supported" } }) : res(200, {}))],
    [/\/namespaces$/, () => res(200, { namespaces: [] })],
  ]);
  try {
    const lh = { workspace: "ws", item: "lh.Lakehouse" };
    // OneLake's own sentence is what says why; a bare status code sends people looking in
    // the wrong place.
    await assert.rejects(() => catalog.listTables(lh), /not supported/);
    fail = false;
    assert.deepEqual(await catalog.listTables(lh), [], "retrying works, rather than staying dead");
  } finally { restore(); }
});

test("no token is a 401 that says so, not a request sent unsigned", async () => {
  const { catalog, calls, restore } = catalogWith([], { getToken: async () => null });
  try {
    await assert.rejects(() => catalog.listWorkspaces(), /signed in/i);
    assert.equal(calls.length, 0, "nothing went out");
  } finally { restore(); }
});

// The config call is seconds of work and its answer lasts as long as the item, so it is kept
// on disk (onelake.js passes the account's store): a restart does not ask for it again.
test("the Iceberg prefix kept on disk is used across restarts, not asked again", async () => {
  const disk = new Map();
  const prefixes = { get: w => disk.get(w), set: (w, p) => { disk.set(w, p); } };
  const lh = { workspace: "ws", item: "lh.Lakehouse" };
  const answers = [
    [/\/v1\/config/, () => res(200, { overrides: { prefix: "guid-a/guid-b" } })],
    [/\/namespaces$/, () => res(200, { namespaces: [] })],
  ];
  const first = catalogWith(answers);
  try {
    first.catalog.usePrefixStore(prefixes);
    await first.catalog.listTables(lh);
    assert.equal(disk.get("ws/lh.Lakehouse"), "guid-a/guid-b");
  } finally { first.restore(); }
  const second = catalogWith(answers);
  try {
    second.catalog.usePrefixStore(prefixes);
    await second.catalog.listTables(lh);
    assert.ok(!second.calls.some(u => u.includes("/v1/config")), second.calls.join("\n"));
    assert.ok(second.calls.some(u => u.includes("/v1/guid-a/guid-b/namespaces")), second.calls.join("\n"));
  } finally { second.restore(); }
});

// An item deleted and made again under its name has new GUIDs: the kept prefix 404s, and
// that is asked of the config at once — not waited out as an Iceberg conversion.
test("a kept prefix that 404s is replaced from the config, and the call made again", async () => {
  const disk = new Map([["ws/lh.Lakehouse", "old-a/old-b"]]);
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, { overrides: { prefix: "new-a/new-b" } })],
    [/\/v1\/old-a\//, () => res(404, {})],
    [/new-b\/namespaces\/dbo\/tables\/t$/, () => res(200, { "metadata-location": "abfss://x/m.json", metadata: { "format-version": 2 } })],
  ]);
  try {
    catalog.usePrefixStore({ get: w => disk.get(w), set: (w, p) => { disk.set(w, p); } });
    const r = await catalog.loadTable({ workspace: "ws", item: "lh.Lakehouse" }, { schema: "dbo", table: "t" });
    assert.equal(r.metadataLocation, "abfss://x/m.json");
    assert.equal(disk.get("ws/lh.Lakehouse"), "new-a/new-b");
    assert.equal(calls.filter(u => u.includes("/v1/config")).length, 1, calls.join("\n"));
  } finally { restore(); }
});

// A table with no Iceberg metadata says why in Fabric's own words, out of the conversion
// log the conversion leaves beside it — not a guess about tenant settings.
test("a table that never converts is reported with its conversion log's error", async () => {
  const log = "Status:             Failed\nTimestamp (UTC):    2026-10-01T00:00:00Z\n" +
    "Error Category:     USER\nError Details:      The table has more than 5000 commits\n";
  const { fetch } = fakeFetch([
    [/\/v1\/config/, () => res(200, { overrides: { prefix: "a/b" } })],
    [/\/tables\/t$/, () => res(404, {})],
    [/resource=filesystem/, () => res(200, { paths: [] })],
    [/Tables\/dbo\/t\/metadata\/latest_conversion_log\.txt$/, () => ({ ...res(200, {}),
      arrayBuffer: async () => new TextEncoder().encode(log).buffer })],
  ]);
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const catalog = createCatalog({ getToken: async () => "tok", backoffMs: [] });
    await assert.rejects(() => catalog.loadTable({ workspace: "ws", item: "lh.Lakehouse" }, { schema: "dbo", table: "t" }),
      /could not convert this table.*more than 5000 commits.*table itself has to change/);
  } finally { globalThis.fetch = saved; }
});

test("no conversion log means the conversion never ran, and the error says so", async () => {
  const { fetch } = fakeFetch([
    [/\/v1\/config/, () => res(200, { overrides: { prefix: "a/b" } })],
    [/\/tables\/t$/, () => res(404, {})],
    [/resource=filesystem/, () => res(200, { paths: [] })],
  ]);
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const catalog = createCatalog({ getToken: async () => "tok", backoffMs: [] });
    await assert.rejects(() => catalog.loadTable({ workspace: "ws", item: "lh.Lakehouse" }, { schema: "dbo", table: "t" }),
      /no conversion log/);
  } finally { globalThis.fetch = saved; }
});

// loadTable with `answers`, and a backoff long enough that a test waiting on it would time out
// unless `backoffMs` says otherwise.
async function loading(answers, { backoffMs = [3_600_000], t = { schema: "mart", table: "t" }, onWait } = {}) {
  const { fetch, calls } = fakeFetch([[/\/v1\/config/, () => res(200, { overrides: { prefix: "a/b" } })], ...answers]);
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const catalog = createCatalog({ getToken: async () => "tok", backoffMs });
    const out = await catalog.loadTable({ workspace: "ws", item: "lh.Lakehouse" }, t, { onWait }).catch(e => e);
    return { out, calls };
  } finally { globalThis.fetch = saved; }
}
const CONVERTED = () => res(200, { "metadata-location": "abfss://x/m.json", metadata: { "format-version": 2 } });

test("a table with no folder fails at once: nothing to wait for, and nothing about converting it", async () => {
  const { out, calls } = await loading([]);
  assert.equal(out.noTable, true);
  assert.equal(out.message, "no table mart.t in ws/lh");
  assert.equal(calls.filter(u => /\/tables\/t$/.test(u)).length, 1, calls.join("\n"));
});

test("a table with its folder is waited on, and the folder is asked about once", async () => {
  let asked = 0;
  const said = [];
  const { out, calls } = await loading([
    [/\/tables\/t$/, () => (++asked < 3 ? res(404, {}) : CONVERTED())],
    [/resource=filesystem/, () => res(200, { paths: [] })],
  ], { backoffMs: [1, 1, 1], onWait: m => said.push(m) });
  assert.equal(out.metadataLocation, "abfss://x/m.json");
  assert.match(said.join("\n"), /Waiting for Fabric to generate Iceberg metadata for mart\.t/);
  assert.equal(calls.filter(u => /resource=filesystem/.test(u)).length, 1, calls.join("\n"));
});

test("a table directly under Tables/ counts as having its folder", async () => {
  let asked = 0;
  const { out } = await loading([
    [/\/tables\/t$/, () => (++asked < 2 ? res(404, {}) : CONVERTED())],
    [/directory=lh\.Lakehouse%2FTables%2Ft(&|$)/, () => res(200, { paths: [] })],
  ], { backoffMs: [1] });
  assert.equal(out.metadataLocation, "abfss://x/m.json");
});

test("a folder check that can't tell leaves the table waited on", async () => {
  let asked = 0;
  const { out } = await loading([
    [/\/tables\/t$/, () => (++asked < 2 ? res(404, {}) : CONVERTED())],
    [/resource=filesystem/, () => res(403, {})],
  ], { backoffMs: [1] });
  assert.equal(out.metadataLocation, "abfss://x/m.json");
});

// OneLake Studio is an app external to Fabric; a tenant can turn those off wholesale, and
// a 403 is all that comes back.
test("a 403 names the tenant setting that turns off access from outside Fabric", async () => {
  const { catalog, restore } = catalogWith([[/resource=account/, () => res(403, { error: { message: "Forbidden" } })]]);
  try {
    await assert.rejects(() => catalog.listWorkspaces(),
      /HTTP 403.*Users can access data stored in OneLake with apps external to Fabric/);
  } finally { restore(); }
});

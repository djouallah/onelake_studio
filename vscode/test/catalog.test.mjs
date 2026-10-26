// Tests for vscode/src/catalog.js — the listing the sidebar tree draws from.
//
// It is a second implementation of what the website's web/app/data.js does, which is the risk: the two can
// drift, and the way that shows up is a tree that quietly disagrees with the panel about
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
const { createCatalog } = require("../src/catalog.js");


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

test("a table listing is fetched once per item, however many schemas the tree draws", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, {})],
    [/\/namespaces$/, () => res(200, { namespaces: [["dbo"], ["sales"]] })],
    [/\/tables$/, () => res(200, { identifiers: [{ name: "t" }] })],
  ]);
  try {
    const lh = { workspace: "ws", item: "lh.Lakehouse" };
    await catalog.listTables(lh);
    const first = calls.length;
    await catalog.listTables(lh);
    await catalog.listTables(lh);
    assert.equal(calls.length, first, "the repeat calls cost nothing");
    catalog.reset();
    await catalog.listTables(lh);
    assert.ok(calls.length > first, "and a refresh really does go back out");
  } finally { restore(); }
});

test("refreshing one item re-fetches that item only; the others stay cached", async () => {
  const { catalog, calls, restore } = catalogWith([
    [/\/v1\/config/, () => res(200, {})],
    [/\/namespaces$/, () => res(200, { namespaces: [["dbo"]] })],
    [/\/tables$/, () => res(200, { identifiers: [{ name: "t" }] })],
  ]);
  try {
    const a = { workspace: "ws", item: "a.Lakehouse" }, b = { workspace: "ws", item: "b.Lakehouse" };
    await catalog.listTables(a);
    await catalog.listTables(b);
    catalog.reset(a);
    const before = calls.length;
    await catalog.listTables(b);
    assert.equal(calls.length, before, "the other item's listing was kept");
    await catalog.listTables(a);
    assert.ok(calls.length > before, "the refreshed item went back out");
    // A workspace-level refresh reaches every item under it, and only those.
    const other = { workspace: "ws2", item: "c.Lakehouse" };
    await catalog.listTables(other);
    catalog.reset({ workspace: "ws" });
    const mid = calls.length;
    await catalog.listTables(other);
    assert.equal(calls.length, mid, "another workspace's listing was kept");
    await catalog.listTables(b);
    assert.ok(calls.length > mid, "items under the refreshed workspace went back out");
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

// host.js: the page's whole reach. What is under test is the boundary — which methods a
// page can name, and that the one input able to steer DuckDB at a file (a table's
// metadata location) comes from the host's own store, never from the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHostMethods, answer } = require("../../src/host.js");

const LOC = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/v1.metadata.json";

function fixture() {
  const calls = [];
  const onelake = {
    table: async (lh, t) => { calls.push(["table", lh, t]); return { metadataLocation: LOC }; },
    peek: async () => ({ rows: [] }), files: async () => [],
    readBytes: async (ws, path, o) => { calls.push(["readBytes", ws, path, o]); return new Uint8Array([1, 2, 3]); },
  };
  const engine = {
    call: async (method, args, emit) => {
      calls.push(["engine", method, args]);
      if (method === "stream") { emit({ fields: [], rows: [], numRows: 0 }); return { numRows: 0 }; }
      return { method };
    },
    copyToTemp: async (key, bytes) => { if (typeof bytes === "function") bytes = await bytes(); calls.push(["copy", key, bytes.length]); return "/tmp/copy"; },
  };
  const methods = createHostMethods({ onelake, engine });
  const ask = async (method, args) => {
    const out = [];
    await answer({ methods, engine }, { id: 7, method, args }, m => out.push(m));
    return out;
  };
  return { calls, ask };
}

test("a table's metadata carries its SQL name", async () => {
  const { ask } = fixture();
  const [msg] = await ask("onelake.table", [{ workspace: "ws", item: "lh.Lakehouse", schema: "dbo", table: "t" }]);
  assert.equal(msg.value.sqlName, "lakehouse.ws.lh.dbo.t");
});

test("the engine is reachable through query, stream, cancel and info only", async () => {
  const { ask } = fixture();
  for (const m of ["query", "cancel", "info"]) {
    const [r] = await ask(m, ["select 1"]);
    assert.equal(r.type, "result", m);
  }
  const streamed = await ask("stream", ["select 1"]);
  assert.deepEqual(streamed.map(m => m.type), ["batch", "result"], "a stream posts its batches, then the result");
  for (const m of ["openTable", "copyToTemp", "registerFileBuffer", "constructor", "toString", undefined]) {
    const [r] = await ask(m, []);
    assert.equal(r.type, "error", String(m));
    assert.match(r.message, /unknown method/);
  }
});

test("bytes cross as base64; a range is passed on only in its one valid shape", async () => {
  const { ask, calls } = fixture();
  const rangeOf = async range => {
    const [r] = await ask("onelake.readBytes", [{ workspace: "ws", path: "lh/Files/a", range }]);
    assert.equal(r.value.base64, Buffer.from([1, 2, 3]).toString("base64"));
    return calls.findLast(c => c[0] === "readBytes")[3].range;
  };
  assert.equal(await rangeOf("bytes=0-15"), "bytes=0-15");
  assert.equal(await rangeOf("bytes=16-"), "bytes=16-");
  for (const bad of ["bytes=0-15, 20-30", "bytes=-5", "0-15", "bytes=0-15\r\nx: y", 15, null]) {
    assert.equal(await rangeOf(bad), undefined, String(bad));
  }
});

test("a local copy is the host's: the page gets a path, the bytes never cross", async () => {
  const { calls, ask } = fixture();
  const [r] = await ask("onelake.localCopy", [{ workspace: "ws", path: "lh/Files/db.sqlite" }]);
  assert.equal(r.value, "/tmp/copy");
  assert.deepEqual(calls.find(c => c[0] === "copy"), ["copy", "ws/lh/Files/db.sqlite", 3]);
});

test("a failure is posted, never dropped, and a Stop says so", async () => {
  const { ask } = fixture();
  const [r] = await ask("onelake.table", [null]);
  assert.equal(r.type, "error");
  assert.ok(r.message);
  assert.equal(r.cancelled, false, "a failure is not a Stop");

  const engine = { call: async () => { throw Object.assign(new Error("Interrupted!"), { cancelled: true }); } };
  const posted = [];
  await answer({ methods: {}, engine }, { id: 8, method: "query", args: ["select 1"] }, m => posted.push(m));
  assert.deepEqual(posted, [{ type: "error", id: 8, message: "Interrupted!", cancelled: true }]);
});

test("saving goes through the host's save function: text as given, a OneLake file read by the host", async () => {
  const saved = [];
  const onelake = { readBytes: async (ws, path) => Buffer.from(`bytes of ${ws}/${path}`) };
  const methods = createHostMethods({ onelake, engine: {},
    saveFile: async (name, bytes) => { if (typeof bytes === "function") bytes = await bytes(); saved.push([name, Buffer.from(bytes).toString()]); return `/out/${name}`; } });
  const ask = async args => { const out = []; await answer({ methods, engine: {} }, { id: 1, method: "host.saveFile", args }, m => out.push(m)); return out[0]; };
  assert.equal((await ask([{ name: "q.csv", text: "a,b\r\n1,2" }])).value, "/out/q.csv");
  assert.equal((await ask([{ name: "../../etc/x:y.parquet", workspace: "ws", path: "lh/Files/x.parquet" }])).value,
    "/out/.._.._etc_x_y.parquet", "a name cannot steer the dialog's folder");
  assert.deepEqual(saved, [["q.csv", "a,b\r\n1,2"], [".._.._etc_x_y.parquet", "bytes of ws/lh/Files/x.parquet"]]);
  const none = createHostMethods({ onelake, engine: {} });
  const out = [];
  await answer({ methods: none, engine: {} }, { id: 2, method: "host.saveFile", args: [{ name: "a", text: "" }] }, m => out.push(m));
  assert.equal(out[0].type, "error", "no save function, no save");
});

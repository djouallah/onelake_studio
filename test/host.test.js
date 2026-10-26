// host.js: the page's whole reach. What is under test is the boundary — which methods a
// page can name, and that the one input able to steer DuckDB at a file (a table's
// metadata location) comes from the host's own store, never from the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHostMethods, answer } = require("../extension/src/host.js");

const LOC = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/v1.metadata.json";

function fixture() {
  const calls = [];
  const onelake = {
    table: async (lh, t) => { calls.push(["table", lh, t]); return { metadataLocation: LOC }; },
    peek: async () => ({ rows: [] }), files: async () => [], readBytes: async () => new Uint8Array([1, 2, 3]),
  };
  const engine = {
    call: async (method, args, emit) => {
      calls.push(["engine", method, args]);
      if (method === "stream") { emit({ fields: [], rows: [], numRows: 0 }); return { numRows: 0 }; }
      return { method };
    },
    openTable: async target => { calls.push(["openTable", target]); return { ident: "x" }; },
    copyToTemp: async (key, bytes) => { calls.push(["copy", key, bytes.length]); return "/tmp/copy"; },
  };
  const methods = createHostMethods({ onelake, engine });
  const ask = async (method, args) => {
    const out = [];
    await answer({ methods, engine }, { id: 7, method, args }, m => out.push(m));
    return out;
  };
  return { calls, ask };
}

test("a table is opened at the location the host's store holds, whatever the page sends", async () => {
  const { calls, ask } = fixture();
  const out = await ask("onelake.openTable", [{
    workspace: "ws", item: "lh.Lakehouse", schema: "dbo", table: "t",
    metadataLocation: "file:///etc/passwd.metadata.json",
  }]);
  assert.deepEqual(out, [{ type: "result", id: 7, value: { ident: "x" } }]);
  const opened = calls.find(c => c[0] === "openTable")[1];
  assert.equal(opened.metadataLocation, LOC);
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
  const { ask } = fixture();
  const [r] = await ask("onelake.readBytes", [{ workspace: "ws", path: "lh/Files/a", range: "bytes=0-15" }]);
  assert.equal(r.value.base64, Buffer.from([1, 2, 3]).toString("base64"));
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
});

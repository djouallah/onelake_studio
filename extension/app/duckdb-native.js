// =============================================================================
// duckdb-native.js — the wasm engine's surface, backed by real DuckDB in the host
// =============================================================================
// data.js talks to DuckDB through exactly eight calls. This presents those eight over
// postMessage so the other 1900 lines of it — the Iceberg manifest walk, position
// deletes, the Warehouse name-mapping, the three read tiers — keep running unchanged
// while the engine underneath them becomes native DuckDB in the extension host.
//
// Not a port, a substitution. See extension/src/engine-host.js for the other end and for
// why the measurements made this worth doing.
//
// The result objects here mimic Arrow's shape only as far as data.js actually reads it:
// `.toArray()` giving rows that answer `.toJSON()`, `.numRows`, and a `.schema.fields`
// carrying a type per column. Nothing else of Arrow's API is used, so nothing else is
// built — and the types are BETTER than the wasm path's, because the host sends DuckDB's
// own type names instead of Arrow metadata that arrowTypeName() has to reconstruct them
// from.
// =============================================================================

import { vscodeApi } from "./vscode-api.js";

// Rows arrive as plain JSON objects. data.js calls `.toJSON()` on each one, so they get a
// shared prototype that answers it rather than a per-row closure — one hidden-class
// transition for the batch instead of an allocation per row, which matters at the 200k-row
// cap the engine allows.
const ROW_PROTO = { toJSON() { return this; } };

function adopt(rows) {
  for (const r of rows) Object.setPrototypeOf(r, ROW_PROTO);
  return rows;
}

// The host sends DuckDB's own type name. arrowTypeName() in data.js checks for this and
// returns it verbatim — for a native result there is nothing to infer.
const fieldsOf = fields =>
  (fields || []).map(f => ({ name: f.name, type: { duckdbName: f.type } }));

function tableOf(batch) {
  const rows = adopt(batch.rows || []);
  return {
    numRows: batch.numRows != null ? batch.numRows : rows.length,
    schema: { fields: fieldsOf(batch.fields) },
    toArray: () => rows,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

let seq = 0;

export function connectNative() {
  const vs = vscodeApi();
  const pending = new Map();   // id -> { resolve, reject, onBatch }

  window.addEventListener("message", ev => {
    const m = ev && ev.data;
    if (!m || typeof m.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "engine-batch") { p.onBatch(tableOf(m.batch)); return; }
    if (m.type === "engine-result") { pending.delete(m.id); p.resolve(m.value); return; }
    if (m.type === "engine-error") {
      pending.delete(m.id);
      const e = new Error(m.message || "engine call failed");
      // Carried across so data.js's own classification still works: a cancelled load
      // must read as stopped, not as a failure.
      if (m.cancelled) e.cancelled = true;
      p.reject(e);
    }
  });

  function call(method, args = [], onBatch = () => {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onBatch });
      vs.postMessage({ type: "engine-call", id, method, args });
    });
  }

  const db = {
    // ATTACH the item as an Iceberg REST catalog in the host and hand back the identifier
    // its table is reachable under. This is the call that replaced the manifest walk.
    openTable: target => call("openTable", [target]),
    // Bytes with no URL land in a host temp file, and the PATH comes back — data.js
    // splices it into its SQL directly, the same way it now splices URLs. Bytes cross as
    // a plain array: a Uint8Array does not survive VS Code's JSON message serialisation.
    registerFileBuffer: (name, bytes) => call("registerFileBuffer", [name, Array.from(bytes)]),
    dropFile: name => call("dropFile", [name]),
    getVersion: () => call("getVersion"),
    capabilities: () => call("capabilities"),
  };

  const conn = {
    query: async sql => tableOf(await call("query", [sql])),

    // The cancellable path. data.js drives this as an async iterable of batches, which is
    // what conn.send() gave it; each batch carries its own schema because the wasm
    // reader's did not (checked: reader.schema was undefined there).
    send: async sql => {
      const queue = [];
      let notify = null;
      let done = false, failed = null;
      call("stream", [sql], b => {
        queue.push(b);
        if (notify) { const n = notify; notify = null; n(); }
      }).then(() => { done = true; }, e => { failed = e; done = true; })
        .finally(() => { if (notify) { const n = notify; notify = null; n(); } });

      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) { yield queue.shift(); continue; }
            if (failed) throw failed;
            if (done) return;
            await new Promise(r => { notify = r; });
          }
        },
      };
    },

    // Real interruption, not a worker terminate. Returns true because native DuckDB's
    // interrupt() always reaches the running statement — the wasm build could return
    // false, and everything downstream of that in data.js treats true as "it was heard".
    cancelSent: async () => { await call("cancel"); return true; },
  };

  return { db, conn };
}
